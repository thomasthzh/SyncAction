import { randomUUID } from "node:crypto";
import {
  BrowserActuator,
  BrowserCircuitBreaker,
  BrowserObserver,
  BrowserStateSchema,
  EffectLedger,
  roomGroupTitle,
  type BrowserGroup,
  type BrowserPort,
  type BrowserState,
  type BrowserTab,
} from "@syncaction/browser-sync";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import { applyCommittedOperation, createEmptyRoomState, type RoomState } from "@syncaction/domain";
import { AccountService, createAccessTokenCodec } from "@syncaction/identity";
import {
  CommittedOperationSchema,
  OperationAckSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  type ClientOperationEnvelope,
  type CommittedOperation,
  type OperationAck,
  type RoomSyncRequest,
} from "@syncaction/protocol";
import {
  DurableReplica,
  MemoryReplicaPersistence,
  ReplicaCoordinator,
  ReplicaRepository,
  encodeRoomState,
  type ReplicaPersistence,
  type ReplicaTransport,
  type ReplicaTransportHandlers,
} from "@syncaction/replica";
import { RoomService } from "@syncaction/rooms";
import { buildPublicApp } from "@syncaction/server/app";
import { RoomSequencer } from "@syncaction/sync";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RoomBrowserController } from "../src/room-browser-controller.js";
import { SocketReplicaTransport } from "../src/socket-transport.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const deviceIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789ab2",
  "018f8f8e-4b5c-7d6e-8f90-123456789ab3",
  "018f8f8e-4b5c-7d6e-8f90-123456789ab4",
];
const sessionIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
  "018f8f8e-4b5c-7d6e-8f90-123456789ab6",
  "018f8f8e-4b5c-7d6e-8f90-123456789ab7",
];

class InMemoryRoomHub {
  public state: RoomState = createEmptyRoomState(
    roomId as Parameters<typeof createEmptyRoomState>[0],
    0,
  );
  public readonly operations: CommittedOperation[] = [];
  readonly #clients = new Set<HubTransport>();

  public createTransport(): HubTransport {
    return new HubTransport(this);
  }

  public connect(client: HubTransport): void {
    this.#clients.add(client);
  }

  public disconnect(client: HubTransport): void {
    this.#clients.delete(client);
  }

  public synchronize(request: RoomSyncRequest) {
    if (!request.hasConfirmedSnapshot) {
      return RoomSnapshotMessageSchema.parse({
        type: "room.snapshot",
        protocolVersion: 1,
        state: encodeRoomState(this.state),
      });
    }
    const operations = this.operations.filter(
      (operation) => operation.serverSeq > request.lastServerSeq,
    );
    return RoomDeltaMessageSchema.parse({
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: this.state.roomEpoch,
      fromServerSeq: request.lastServerSeq,
      toServerSeq: this.state.serverSeq,
      operations,
    });
  }

  public submit(envelope: ClientOperationEnvelope): OperationAck {
    const duplicate = this.operations.find(
      (operation) =>
        operation.deviceId === envelope.deviceId && operation.clientOpId === envelope.clientOpId,
    );
    if (duplicate !== undefined) {
      return ackFrom(duplicate);
    }
    const committed = CommittedOperationSchema.parse({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId: envelope.clientOpId,
      roomId,
      roomEpoch: this.state.roomEpoch,
      deviceId: envelope.deviceId,
      serverSeq: this.state.serverSeq + 1,
      operation: envelope.operation,
    });
    this.state = applyCommittedOperation(this.state, committed);
    this.operations.push(committed);
    for (const client of this.#clients) {
      client.emitCommitted(committed);
    }
    return ackFrom(committed);
  }
}

class HubTransport implements ReplicaTransport {
  #handlers: ReplicaTransportHandlers | undefined;

  public constructor(private readonly hub: InMemoryRoomHub) {}

  public async connect(handlers: ReplicaTransportHandlers): Promise<void> {
    this.#handlers = handlers;
    this.hub.connect(this);
  }

  public async synchronize(request: RoomSyncRequest) {
    return this.hub.synchronize(request);
  }

  public async submit(envelope: ClientOperationEnvelope): Promise<OperationAck> {
    return this.hub.submit(envelope);
  }

  public async disconnect(): Promise<void> {
    this.hub.disconnect(this);
    this.#handlers = undefined;
  }

  public emitCommitted(operation: CommittedOperation): void {
    this.#handlers?.onCommitted(operation);
  }
}

class CountingReplicaTransport implements ReplicaTransport {
  public connectCount = 0;
  public synchronizeCount = 0;
  public submitCount = 0;
  public disconnectCount = 0;
  public reconnectEventCount = 0;
  public disconnectEventCount = 0;
  #handlers: ReplicaTransportHandlers | undefined;

  public constructor(private readonly inner: ReplicaTransport) {}

  public async connect(handlers: ReplicaTransportHandlers): Promise<void> {
    this.connectCount += 1;
    this.#handlers = handlers;
    await this.inner.connect({
      onCommitted: handlers.onCommitted,
      onDisconnect: () => {
        this.disconnectEventCount += 1;
        handlers.onDisconnect();
      },
      onReconnect: () => {
        this.reconnectEventCount += 1;
        handlers.onReconnect();
      },
    });
  }

  public synchronize(request: RoomSyncRequest) {
    this.synchronizeCount += 1;
    return this.inner.synchronize(request);
  }

  public submit(envelope: ClientOperationEnvelope): Promise<OperationAck> {
    this.submitCount += 1;
    return this.inner.submit(envelope);
  }

  public async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.#handlers = undefined;
    await this.inner.disconnect();
  }

  public simulateSocketDisconnect(): void {
    this.disconnectEventCount += 1;
    this.#handlers?.onDisconnect();
  }
}

class SimulatedBrowser implements BrowserPort {
  public state: BrowserState;
  public failNextCreate = false;
  public createCount = 0;
  public groupCount = 0;
  public ungroupCount = 0;
  public navigateCount = 0;
  public moveCount = 0;
  public closeCount = 0;
  #nextTabId = 100;
  #nextGroupId = 7;

  public constructor(
    browserSessionId: string,
    private readonly collaborationRoomId = roomId,
  ) {
    this.state = BrowserStateSchema.parse({
      browserSessionId,
      windows: [{ windowId: 1, type: "normal", incognito: false }],
      groups: [],
      tabs: [
        localTab(50, null, 0, "https://personal.example/keep"),
        localTab(51, null, 1, "https://seed.example/shared"),
      ],
    });
  }

  public async readState(): Promise<BrowserState> {
    return BrowserStateSchema.parse(structuredClone(this.state));
  }

  public async createTab(input: {
    url: string;
    index: number;
    windowId: number | null;
  }): Promise<BrowserTab> {
    this.createCount += 1;
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("injected create failure");
    }
    const tab = localTab(
      this.#nextTabId++,
      null,
      Math.min(input.index, this.state.tabs.length),
      input.url,
    );
    this.#insertAt(tab, tab.index);
    return this.#tab(tab.tabId);
  }

  public async groupTab(input: {
    tabId: number;
    groupId: number | null;
    title: string;
  }): Promise<{ tab: BrowserTab; group: BrowserGroup }> {
    this.groupCount += 1;
    let group = this.state.groups.find((candidate) => candidate.groupId === input.groupId);
    if (group === undefined) {
      group = {
        groupId: this.#nextGroupId++,
        windowId: 1,
        title: input.title,
        color: "blue",
        collapsed: false,
      };
      this.state.groups.push(group);
    } else {
      group.title = input.title;
    }
    this.#tab(input.tabId).groupId = group.groupId;
    this.#parse();
    return {
      tab: this.#tab(input.tabId),
      group,
    };
  }

  public async ungroupTab(tabId: number): Promise<BrowserTab> {
    this.ungroupCount += 1;
    const tab = this.#tab(tabId);
    tab.groupId = null;
    this.#parse();
    return this.#tab(tabId);
  }

  public async navigateTab(input: { tabId: number; url: string }): Promise<BrowserTab> {
    this.navigateCount += 1;
    const tab = this.#tab(input.tabId);
    tab.url = input.url;
    tab.title = input.url;
    this.#parse();
    return this.#tab(input.tabId);
  }

  public async moveTab(input: {
    tabId: number;
    windowId: number;
    index: number;
  }): Promise<BrowserTab> {
    this.moveCount += 1;
    const ordered = this.state.tabs.toSorted((left, right) => left.index - right.index);
    const current = ordered.findIndex((tab) => tab.tabId === input.tabId);
    const [tab] = ordered.splice(current, 1);
    ordered.splice(Math.min(input.index, ordered.length), 0, tab!);
    ordered.forEach((candidate, index) => {
      candidate.index = index;
    });
    this.state.tabs = ordered;
    this.#parse();
    return this.#tab(input.tabId);
  }

  public async closeTab(tabId: number): Promise<void> {
    this.closeCount += 1;
    this.state.tabs = this.state.tabs.filter((tab) => tab.tabId !== tabId);
    this.#normalizeIndexes();
  }

  public addUserTabToRoom(url: string): BrowserTab {
    const group = this.roomGroup();
    const tab = localTab(this.#nextTabId++, group.groupId, this.state.tabs.length, url);
    this.state.tabs.push(tab);
    this.#parse();
    return this.#tab(tab.tabId);
  }

  public userNavigate(tabId: number, url: string): void {
    const tab = this.#tab(tabId);
    tab.url = url;
    tab.title = url;
    this.#parse();
  }

  public userMoveRoomTab(tabId: number, roomIndex: number): BrowserTab {
    const group = this.roomGroup();
    const personal = this.state.tabs
      .filter((tab) => tab.groupId !== group.groupId)
      .toSorted((left, right) => left.index - right.index);
    const roomTabs = this.roomTabs();
    const current = roomTabs.findIndex((tab) => tab.tabId === tabId);
    const [tab] = roomTabs.splice(current, 1);
    roomTabs.splice(roomIndex, 0, tab!);
    this.state.tabs = [...personal, ...roomTabs];
    this.state.tabs.forEach((candidate, index) => {
      candidate.index = index;
    });
    this.#parse();
    return this.#tab(tabId);
  }

  public userClose(tabId: number): void {
    this.state.tabs = this.state.tabs.filter((tab) => tab.tabId !== tabId);
    this.#normalizeIndexes();
  }

  public roomGroup(): BrowserGroup {
    const group = this.state.groups.find(
      (candidate) => candidate.title === roomGroupTitle(this.collaborationRoomId),
    );
    if (group === undefined) {
      throw new Error("room group is missing");
    }
    return group;
  }

  public roomTabs(): BrowserTab[] {
    const groupId = this.roomGroup().groupId;
    return this.state.tabs
      .filter((tab) => tab.groupId === groupId)
      .toSorted((left, right) => left.index - right.index);
  }

  public personalFixture(): BrowserTab {
    return structuredClone(this.#tab(50));
  }

  public duplicateRoomGroup(): void {
    this.state.groups.push({
      ...this.roomGroup(),
      groupId: this.#nextGroupId++,
    });
    this.#parse();
  }

  public deleteRoomGroups(): number {
    const title = roomGroupTitle(this.collaborationRoomId);
    const groupIds = new Set(
      this.state.groups.filter((group) => group.title === title).map((group) => group.groupId),
    );
    const sharedTab = this.state.tabs.find(
      (tab) => tab.groupId !== null && groupIds.has(tab.groupId),
    );
    this.state.groups = this.state.groups.filter((group) => !groupIds.has(group.groupId));
    for (const tab of this.state.tabs) {
      if (tab.groupId !== null && groupIds.has(tab.groupId)) {
        tab.groupId = null;
      }
    }
    this.#parse();
    if (sharedTab === undefined) {
      throw new Error("shared tab is missing");
    }
    return sharedTab.tabId;
  }

  public restoreRoomInNewSession(browserSessionId: string): SimulatedBrowser {
    const restored = new SimulatedBrowser(browserSessionId, this.collaborationRoomId);
    const originalPersonal = restored.#tab(50);
    const tabs = this.roomTabs().map((tab, index) => localTab(200 + index, 9, index + 2, tab.url!));
    restored.state = BrowserStateSchema.parse({
      browserSessionId,
      windows: [{ windowId: 1, type: "normal", incognito: false }],
      groups: [
        {
          groupId: 9,
          windowId: 1,
          title: roomGroupTitle(this.collaborationRoomId),
          color: "blue",
          collapsed: false,
        },
      ],
      tabs: [originalPersonal, localTab(51, null, 1, "https://seed.example/shared"), ...tabs],
    });
    return restored;
  }

  #insertAt(tab: BrowserTab, index: number): void {
    const ordered = this.state.tabs.toSorted((left, right) => left.index - right.index);
    ordered.splice(index, 0, tab);
    ordered.forEach((candidate, candidateIndex) => {
      candidate.index = candidateIndex;
    });
    this.state.tabs = ordered;
    this.#parse();
  }

  #normalizeIndexes(): void {
    this.state.tabs
      .toSorted((left, right) => left.index - right.index)
      .forEach((tab, index) => {
        tab.index = index;
      });
    this.#parse();
  }

  #tab(tabId: number): BrowserTab {
    const tab = this.state.tabs.find((candidate) => candidate.tabId === tabId);
    if (tab === undefined) {
      throw new Error(`missing tab ${tabId}`);
    }
    return tab;
  }

  #parse(): void {
    this.state = BrowserStateSchema.parse(this.state);
  }
}

interface TestClient {
  persistence: ReplicaPersistence;
  browser: SimulatedBrowser;
  replica: DurableReplica;
  coordinator: ReplicaCoordinator;
  controller: RoomBrowserController;
  transport: ReplicaTransport;
}

const activeClients = new Set<TestClient>();

afterEach(async () => {
  await Promise.all(
    [...activeClients].map(async (client) => {
      try {
        await client.coordinator.stop();
      } catch {
        // Failure-injection clients may already be disconnected.
      }
    }),
  );
  activeClients.clear();
});

async function createClient(options: {
  hub?: InMemoryRoomHub;
  transport?: ReplicaTransport;
  index: number;
  roomId?: string;
  deviceId?: string;
  persistence?: ReplicaPersistence;
  browser?: SimulatedBrowser;
}): Promise<TestClient> {
  const clientRoomId = options.roomId ?? roomId;
  const persistence = options.persistence ?? new MemoryReplicaPersistence();
  const browser = options.browser ?? new SimulatedBrowser(sessionIds[options.index]!, clientRoomId);
  const repository = new ReplicaRepository({ persistence });
  const replica = new DurableReplica({
    repository,
    roomId: clientRoomId,
    deviceId: options.deviceId ?? deviceIds[options.index],
    createClientOpId: randomUUID,
  });
  const transport = options.transport ?? options.hub?.createTransport();
  if (transport === undefined) {
    throw new Error("a transport or in-memory hub is required");
  }
  const coordinator = new ReplicaCoordinator({
    replica,
    transport,
    roomId: clientRoomId,
    onTransition: () => {
      void controller.handleReplicaTransition();
    },
  });
  const ledger = new EffectLedger();
  const controller = new RoomBrowserController({
    observer: new BrowserObserver({
      roomId: clientRoomId,
      replica,
      browser,
      ledger,
      writer: coordinator,
      isActuatable: () => coordinator.isActuatable(),
      createLogicalTabId: randomUUID,
    }),
    actuator: new BrowserActuator({
      roomId: clientRoomId,
      replica,
      browser,
      ledger,
      breaker: new BrowserCircuitBreaker(),
      isActuatable: () => coordinator.isActuatable(),
      createEffectId: randomUUID,
      wait: async () => undefined,
    }),
  });
  const client = { persistence, browser, replica, coordinator, controller, transport };
  activeClients.add(client);
  await coordinator.start();
  await settle([client]);
  return client;
}

async function settle(clients: readonly TestClient[]): Promise<void> {
  for (let iteration = 0; iteration < 6; iteration += 1) {
    await Promise.all(clients.map((client) => client.coordinator.whenIdle()));
    await Promise.all(clients.map((client) => client.controller.whenIdle()));
  }
}

function ackFrom(operation: CommittedOperation): OperationAck {
  return OperationAckSchema.parse({
    type: "op.ack",
    protocolVersion: 1,
    clientOpId: operation.clientOpId,
    roomId: operation.roomId,
    roomEpoch: operation.roomEpoch,
    serverSeq: operation.serverSeq,
  });
}

function localTab(tabId: number, groupId: number | null, index: number, url: string): BrowserTab {
  return {
    tabId,
    windowId: 1,
    groupId,
    index,
    url,
    title: url,
    status: "complete",
    pinned: false,
  };
}

describe("two-client browser synchronization", () => {
  it("syncs create, duplicate URL, navigation, move, close, and all-offline wake", async () => {
    const hub = new InMemoryRoomHub();
    const first = await createClient({ hub, index: 0 });
    const second = await createClient({ hub, index: 1 });
    const firstPersonal = first.browser.personalFixture();
    const secondPersonal = second.browser.personalFixture();

    await first.controller.shareBrowserTab(51);
    await settle([first, second]);
    expect(hub.state.order).toHaveLength(1);
    expect(first.browser.roomTabs()).toHaveLength(1);
    expect(second.browser.roomTabs()).toHaveLength(1);

    const duplicate = first.browser.addUserTabToRoom("https://seed.example/shared");
    await first.controller.handleBrowserEvent({
      type: "TAB_UPDATED",
      tabId: duplicate.tabId,
    });
    await settle([first, second]);
    expect(hub.state.order).toHaveLength(2);
    expect(second.browser.roomTabs().map((tab) => tab.url)).toEqual([
      "https://seed.example/shared",
      "https://seed.example/shared",
    ]);

    const secondLogicalId = hub.state.order[1]!;
    const firstSecondBinding = (await first.replica.getRecord()).bindings.find(
      (binding) => binding.logicalTabId === secondLogicalId,
    )!;
    first.browser.userNavigate(firstSecondBinding.tabId, "https://example.com/collaborative");
    await first.controller.handleBrowserEvent({
      type: "TAB_UPDATED",
      tabId: firstSecondBinding.tabId,
    });
    await settle([first, second]);
    const secondSecondBinding = (await second.replica.getRecord()).bindings.find(
      (binding) => binding.logicalTabId === secondLogicalId,
    )!;
    expect(
      second.browser.state.tabs.find((tab) => tab.tabId === secondSecondBinding.tabId)?.url,
    ).toBe("https://example.com/collaborative");

    expect(hub.state.order).toEqual([
      hub.operations[0]!.operation.type === "tab.create"
        ? hub.operations[0]!.operation.logicalTabId
        : "",
      secondLogicalId,
    ]);
    const beforeMoveBindings = new Map(
      (await first.replica.getRecord()).bindings.map((binding) => [
        binding.tabId,
        binding.logicalTabId,
      ]),
    );
    expect(first.browser.roomTabs().map((tab) => beforeMoveBindings.get(tab.tabId))).toEqual(
      hub.state.order,
    );
    const moved = first.browser.userMoveRoomTab(firstSecondBinding.tabId, 0);
    expect(first.browser.roomTabs().map((tab) => beforeMoveBindings.get(tab.tabId))).toEqual([
      secondLogicalId,
      hub.state.order[0],
    ]);
    const moveResult = await first.controller.handleBrowserEvent({
      type: "TAB_MOVED",
      tabId: moved.tabId,
      windowId: moved.windowId,
      index: moved.index,
    });
    expect(`${moveResult.kind}:${"reason" in moveResult ? moveResult.reason : ""}`).toBe(
      "INTENT_RECORDED:",
    );
    expect(moveResult).toMatchObject({
      kind: "INTENT_RECORDED",
      operation: { type: "tab.move", logicalTabId: secondLogicalId },
    });
    await settle([first, second]);
    expect(hub.state.order[0]).toBe(secondLogicalId);
    expect(second.browser.roomTabs()[0]?.tabId).toBe(secondSecondBinding.tabId);

    const firstLogicalId = hub.state.order[1]!;
    const firstCloseBinding = (await first.replica.getRecord()).bindings.find(
      (binding) => binding.logicalTabId === firstLogicalId,
    )!;
    const secondCloseBinding = (await second.replica.getRecord()).bindings.find(
      (binding) => binding.logicalTabId === firstLogicalId,
    )!;
    first.browser.userClose(firstCloseBinding.tabId);
    await first.controller.handleBrowserEvent({
      type: "TAB_REMOVED",
      tabId: firstCloseBinding.tabId,
      windowId: 1,
      isWindowClosing: false,
    });
    await settle([first, second]);
    expect(hub.state.order).toEqual([secondLogicalId]);
    expect(second.browser.state.tabs.some((tab) => tab.tabId === secondCloseBinding.tabId)).toBe(
      false,
    );

    expect(first.browser.personalFixture()).toEqual(firstPersonal);
    expect(second.browser.personalFixture()).toEqual(secondPersonal);

    await first.coordinator.stop();
    await second.coordinator.stop();
    activeClients.delete(first);
    activeClients.delete(second);
    const restoredBrowser = second.browser.restoreRoomInNewSession(sessionIds[2]!);
    const restoredPersonal = restoredBrowser.personalFixture();
    const restarted = await createClient({
      hub,
      index: 1,
      persistence: second.persistence,
      browser: restoredBrowser,
    });

    expect((await restarted.replica.getRecord()).bindings).toMatchObject([
      {
        logicalTabId: secondLogicalId,
        tabId: 200,
        browserSessionId: sessionIds[2],
      },
    ]);
    expect(restarted.browser.roomTabs()).toHaveLength(1);
    expect(restarted.browser.personalFixture()).toEqual(restoredPersonal);
  });

  it("fails closed on duplicate groups, API rejection, and replacement without touching personal tabs", async () => {
    const hub = new InMemoryRoomHub();
    const owner = await createClient({ hub, index: 0 });
    await owner.controller.shareBrowserTab(51);
    await settle([owner]);
    const ownerPersonal = owner.browser.personalFixture();

    owner.browser.duplicateRoomGroup();
    await owner.controller.handleReplicaTransition();
    expect(owner.controller.getStatus()).toMatchObject({
      state: "BLOCKED",
      reason: "AMBIGUOUS_ROOM_GROUP",
    });
    expect(owner.browser.personalFixture()).toEqual(ownerPersonal);

    const ungroupedTabId = owner.browser.deleteRoomGroups();
    await owner.controller.handleBrowserEvent({
      type: "TAB_GROUP_CHANGED",
      tabId: ungroupedTabId,
      groupId: null,
    });
    expect(owner.controller.getStatus()).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: "BOUND_TAB_OUTSIDE_ROOM_GROUP",
    });
    expect(owner.browser.personalFixture()).toEqual(ownerPersonal);

    const failingBrowser = new SimulatedBrowser(sessionIds[1]!);
    failingBrowser.failNextCreate = true;
    const failingPersonal = failingBrowser.personalFixture();
    const failing = await createClient({
      hub,
      index: 1,
      browser: failingBrowser,
    });
    expect(failing.controller.getStatus()).toMatchObject({
      state: "BLOCKED",
      reason: "BROWSER_API_FAILURE",
    });
    expect(failing.browser.personalFixture()).toEqual(failingPersonal);

    await owner.controller.handleBrowserEvent({
      type: "TAB_REPLACED",
      addedTabId: 300,
      removedTabId: ungroupedTabId,
    });
    expect(owner.controller.getStatus()).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: "TAB_REPLACED",
    });
    expect(owner.browser.personalFixture()).toEqual(ownerPersonal);
  });
});

describe("two-client browser capacity safety through the live sequencer", () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const liveNow = new Date("2026-07-27T00:00:00.000Z");
  let db: ReturnType<typeof createDatabase>;
  let accounts: AccountService;
  let rooms: RoomService;
  let sequencer: RoomSequencer;
  let app: Awaited<ReturnType<typeof buildPublicApp>>;
  let baseUrl: string;

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error("TEST_DATABASE_URL is required for integration tests");
    }
    db = createDatabase(connectionString);
    await migrateToLatest(db);
    accounts = new AccountService({
      db,
      accessTokens: createAccessTokenCodec({
        issuer: "syncaction",
        audience: "syncaction-extension",
        secret: new Uint8Array(32).fill(67),
        now: () => liveNow,
      }),
      now: () => liveNow,
    });
    rooms = new RoomService({ db, now: () => liveNow });
    sequencer = new RoomSequencer({ db, now: () => liveNow });
    app = await buildPublicApp({
      db,
      accounts,
      rooms,
      sequencer,
      annotationHmacKey: new Uint8Array(32).fill(23),
      operationRateLimitMax: 1_000,
      logger: false,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an ephemeral TCP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom("auditEvents").execute();
    await db.deleteFrom("passwordResetGrants").execute();
    await db.deleteFrom("adminSessions").execute();
    await db.deleteFrom("administrators").execute();
    await db.deleteFrom("rooms").execute();
    await db.deleteFrom("users").execute();
  });

  it("keeps the twenty-first local tab open and stable after permanent rejection", async () => {
    const owner = await createLiveSession("browser-capacity-owner");
    const member = await createLiveSession("browser-capacity-member");
    const room = await rooms.createRoom({
      actorUserId: owner.userId,
      name: "Browser capacity safety",
    });
    const invitation = await rooms.inviteByUsername({
      actorUserId: owner.userId,
      roomId: room.id,
      username: member.username,
    });
    await rooms.acceptInvitation({
      actorUserId: member.userId,
      invitationId: invitation.id,
    });

    let predecessor: string | null = null;
    for (let index = 0; index < 20; index += 1) {
      const logicalTabId = randomUUID();
      await sequencer.commitOperation({
        principal: owner.principal,
        envelope: {
          protocolVersion: 1,
          clientOpId: randomUUID(),
          roomId: room.id,
          roomEpoch: 0,
          deviceId: owner.deviceId,
          baseServerSeq: index,
          operation: {
            type: "tab.create",
            logicalTabId,
            url: `https://example.com/capacity-${index}`,
            after: predecessor,
          },
        },
      });
      predecessor = logicalTabId;
    }

    const ownerTransport = new CountingReplicaTransport(
      new SocketReplicaTransport({
        serverUrl: baseUrl,
        accessToken: owner.accessToken,
        clientVersion: "0.9.0",
        ackTimeoutMs: 3_000,
      }),
    );
    const memberTransport = new CountingReplicaTransport(
      new SocketReplicaTransport({
        serverUrl: baseUrl,
        accessToken: member.accessToken,
        clientVersion: "0.9.0",
        ackTimeoutMs: 3_000,
      }),
    );
    const ownerBrowser = new SimulatedBrowser(randomUUID(), room.id);
    const memberBrowser = new SimulatedBrowser(randomUUID(), room.id);
    const ownerClient = await createClient({
      index: 0,
      roomId: room.id,
      deviceId: owner.deviceId,
      browser: ownerBrowser,
      transport: ownerTransport,
    });
    const memberClient = await createClient({
      index: 1,
      roomId: room.id,
      deviceId: member.deviceId,
      browser: memberBrowser,
      transport: memberTransport,
    });
    expect(ownerClient.controller.getStatus()).toMatchObject({
      state: "CONFIRMATION_REQUIRED",
      missingTabCount: 20,
    });
    expect(memberClient.controller.getStatus()).toMatchObject({
      state: "CONFIRMATION_REQUIRED",
      missingTabCount: 20,
    });
    await Promise.all([
      ownerClient.controller.confirmRecovery(),
      memberClient.controller.confirmRecovery(),
    ]);
    await settle([ownerClient, memberClient]);

    expect(ownerBrowser.roomTabs()).toHaveLength(20);
    expect(memberBrowser.roomTabs()).toHaveLength(20);
    const personalBefore = structuredClone(ownerBrowser.state.tabs.find((tab) => tab.tabId === 51));
    const operationCountersBefore = browserOperationCounters(ownerBrowser);
    const memberOperationCountersBefore = browserOperationCounters(memberBrowser);

    await expect(ownerClient.controller.shareBrowserTab(51)).resolves.toEqual({
      kind: "BLOCKED",
      reason: "ROOM_TAB_LIMIT_REACHED",
    });
    await settle([ownerClient, memberClient]);

    expect(ownerClient.coordinator.state).toBe("SYNCED");
    expect(ownerClient.controller.getStatus()).toEqual({
      state: "BLOCKED",
      reason: "ROOM_TAB_LIMIT_REACHED",
      missingTabCount: 0,
      effectsApplied: 0,
    });
    expect(ownerBrowser.state.tabs.find((tab) => tab.tabId === 51)).toEqual(personalBefore);
    expect(ownerBrowser.state.tabs.find((tab) => tab.tabId === 51)).toMatchObject({
      tabId: 51,
      groupId: null,
      url: "https://seed.example/shared",
      status: "complete",
    });
    const ownerRecord = await ownerClient.replica.getRecord();
    expect(ownerRecord.mode).toBe("SYNCED");
    expect(ownerRecord.confirmedSnapshot?.order).toHaveLength(20);
    expect(ownerRecord.outbox).toEqual([]);
    expect(ownerRecord.bindings).not.toContainEqual(expect.objectContaining({ tabId: 51 }));
    expect(memberOperationCountersBefore).toEqual(browserOperationCounters(memberBrowser));
    await expect(liveRoomCounts(room.id)).resolves.toEqual({
      openTabs: 20,
      operations: 20,
      clientOperations: 20,
    });
    expect(ownerTransport).toMatchObject({
      connectCount: 1,
      submitCount: 1,
      reconnectEventCount: 0,
      disconnectEventCount: 0,
    });

    await ownerClient.controller.handleBrowserEvent({
      type: "TAB_UPDATED",
      tabId: 51,
    });
    await ownerClient.controller.handleBrowserEvent({
      type: "TAB_GROUP_CHANGED",
      tabId: 51,
      groupId: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await settle([ownerClient, memberClient]);

    expect(browserOperationCounters(ownerBrowser)).toEqual(operationCountersBefore);
    expect(browserOperationCounters(memberBrowser)).toEqual(memberOperationCountersBefore);
    expect(ownerTransport).toMatchObject({
      connectCount: 1,
      submitCount: 1,
      reconnectEventCount: 0,
      disconnectEventCount: 0,
    });
    expect(ownerClient.coordinator.state).toBe("SYNCED");
    expect((await ownerClient.replica.getRecord()).outbox).toEqual([]);

    ownerTransport.simulateSocketDisconnect();

    expect(ownerClient.coordinator.state).toBe("DISCONNECTED");
    expect(ownerTransport.connectCount).toBe(1);
    expect(browserOperationCounters(ownerBrowser)).toEqual(operationCountersBefore);
  });

  async function createLiveSession(username: string) {
    const account = await accounts.register({
      username,
      displayName: username,
      password: "correct horse battery",
    });
    await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", account.id).execute();
    const deviceId = randomUUID();
    const session = await accounts.login({
      username,
      password: "correct horse battery",
      deviceId,
    });
    return {
      userId: account.id,
      username: account.username,
      deviceId,
      accessToken: session.accessToken,
      principal: await accounts.authenticateAccessToken(session.accessToken),
    };
  }

  async function liveRoomCounts(liveRoomId: string) {
    const [openTabs, operations, clientOperations] = await Promise.all([
      db
        .selectFrom("roomTabs")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", liveRoomId)
        .where("closedAtSeq", "is", null)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("roomOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", liveRoomId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("clientOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", liveRoomId)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      openTabs: Number(openTabs.count),
      operations: Number(operations.count),
      clientOperations: Number(clientOperations.count),
    };
  }
});

function browserOperationCounters(browser: SimulatedBrowser) {
  return {
    create: browser.createCount,
    group: browser.groupCount,
    ungroup: browser.ungroupCount,
    navigate: browser.navigateCount,
    move: browser.moveCount,
    close: browser.closeCount,
  };
}
