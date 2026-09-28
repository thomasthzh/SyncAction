import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AccountService, createAccessTokenCodec } from "@syncaction/identity";
import {
  RoomSnapshotMessageSchema,
  type ClientOperationEnvelope,
  type PointerAck,
  type PointerFrame,
  type PointerLeaseAck,
  type PointerLeaseUpdate,
  type PointerRecord,
  type PointerUpdate,
} from "@syncaction/protocol";
import { ReplicaRecordSchema, type ReplicaRecord } from "@syncaction/replica";
import { RoomService } from "@syncaction/rooms";
import { buildPublicApp } from "@syncaction/server/app";
import { RoomPointerService, RoomPresenceService, RoomSequencer } from "@syncaction/sync";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActiveTabPresenceController, type PresenceScheduler } from "../src/active-tab-presence.js";
import {
  PointerController,
  type PointerIdentity,
  type PointerPageContext,
  type PointerPagePort,
} from "../src/pointer-controller.js";
import {
  SocketReplicaTransport,
  type PointerMessage,
  type PointerMessageHandler,
  type PointerTransport,
} from "../src/socket-transport.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

let nowMs = Date.parse("2026-07-27T00:00:00.000Z");
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let rooms: RoomService;
let sequencer: RoomSequencer;
let app: Awaited<ReturnType<typeof buildPublicApp>>;
let baseUrl: string;
const liveTransports = new Set<SocketReplicaTransport>();
const livePresences = new Set<ActiveTabPresenceController>();
const livePointers = new Set<PointerController>();

class PassiveScheduler implements PresenceScheduler {
  public setInterval(): unknown {
    return 1;
  }

  public clearInterval(): void {}
}

class FilteringPointerTransport implements PointerTransport {
  public dropClear = false;
  readonly #inner: SocketReplicaTransport;

  public constructor(inner: SocketReplicaTransport) {
    this.#inner = inner;
  }

  public setPointerHandler(handler: PointerMessageHandler | undefined): void {
    this.#inner.setPointerHandler(
      handler === undefined
        ? undefined
        : (message) => {
            if (!(
              this.dropClear &&
              (message.type === "pointer.clear" || message.type === "pointer.lease.clear")
            )) {
              handler(message);
            }
          },
    );
  }

  public publishPointer(update: PointerUpdate): Promise<PointerAck> {
    return this.#inner.publishPointer(update);
  }

  public publishPointerLease(update: PointerLeaseUpdate): Promise<PointerLeaseAck> {
    return this.#inner.publishPointerLease(update);
  }

  public publishPointerFrame(frame: PointerFrame): void {
    this.#inner.publishPointerFrame(frame);
  }
}

class ExactFakePagePort implements PointerPagePort {
  public allowInjection = true;
  public readonly displayed = new Map<string, PointerRecord>();
  public readonly renders: PointerRecord[] = [];
  public readonly contexts = new Map<number, PointerPageContext>();

  public async ensureInjected(): Promise<boolean> {
    return this.allowInjection;
  }

  public async verifyInjected(): Promise<boolean> {
    return this.allowInjection;
  }

  public async setContext(tabId: number, context: PointerPageContext): Promise<void> {
    this.contexts.set(tabId, structuredClone(context));
  }

  public async render(_tabId: number, pointer: PointerRecord): Promise<void> {
    this.displayed.set(pointerKey(pointer), structuredClone(pointer));
    this.renders.push(structuredClone(pointer));
  }

  public async clear(_tabId: number, identity?: PointerIdentity): Promise<void> {
    if (identity === undefined) {
      this.displayed.clear();
    } else {
      this.displayed.delete(pointerKey(identity));
    }
  }

  public async dispose(tabId: number): Promise<void> {
    this.contexts.delete(tabId);
    this.displayed.clear();
  }

  public expire(observedAt: number): void {
    for (const [key, pointer] of this.displayed) {
      if (pointer.expiresAt <= observedAt) {
        this.displayed.delete(key);
      }
    }
  }
}

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  const now = () => new Date(nowMs);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(47),
      now,
    }),
    now,
  });
  rooms = new RoomService({ db, now });
  sequencer = new RoomSequencer({ db, now });
  const presence = new RoomPresenceService({ db, now });
  app = await buildPublicApp({
    db,
    accounts,
    rooms,
    sequencer,
    annotationHmacKey: new Uint8Array(32).fill(23),
    presence,
    pointers: new RoomPointerService({
      authorization: presence,
      now: () => new Date(nowMs),
    }),
    operationRateLimitMax: 100,
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
  await cleanupClients();
  await app.close();
  await db.destroy();
});

beforeEach(async () => {
  await cleanupClients();
  nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

async function cleanupClients(): Promise<void> {
  await Promise.all(
    [...livePointers].map(async (pointer) => {
      try {
        await pointer.dispose();
      } catch {
        // Continue integration cleanup after a failed assertion.
      }
    }),
  );
  livePointers.clear();
  await Promise.all(
    [...livePresences].map(async (presence) => {
      try {
        await presence.dispose();
      } catch {
        // Continue integration cleanup after a failed assertion.
      }
    }),
  );
  livePresences.clear();
  await Promise.all([...liveTransports].map((transport) => transport.disconnect()));
  liveTransports.clear();
}

async function activeSession(username: string) {
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
    account,
    deviceId,
    accessToken: session.accessToken,
    principal: await accounts.authenticateAccessToken(session.accessToken),
  };
}

async function connectedTransport(
  accessToken: string,
  roomId: string,
): Promise<SocketReplicaTransport> {
  const transport = new SocketReplicaTransport({
    serverUrl: baseUrl,
    accessToken,
    clientVersion: "0.9.0",
    ackTimeoutMs: 3_000,
  });
  liveTransports.add(transport);
  await connectAndSynchronize(transport, roomId);
  return transport;
}

async function connectAndSynchronize(
  transport: SocketReplicaTransport,
  roomId: string,
): Promise<void> {
  await transport.connect({
    onCommitted: () => undefined,
    onDisconnect: () => undefined,
    onReconnect: () => undefined,
  });
  await transport.synchronize({
    protocolVersion: 1,
    roomId: roomId as ClientOperationEnvelope["roomId"],
    roomEpoch: 0,
    lastServerSeq: 0,
    hasConfirmedSnapshot: false,
  });
}

function replicaRecord(
  snapshot: ReturnType<typeof RoomSnapshotMessageSchema.parse>["state"],
  browserSessionId: string,
  tabId: number,
): ReplicaRecord {
  const logicalTabId = snapshot.order[0]!;
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId: snapshot.roomId,
    mode: "SYNCED",
    confirmedSnapshot: snapshot,
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: [
      {
        logicalTabId,
        tabId,
        windowId: 1,
        groupId: 2,
        browserSessionId,
        validatedAtServerSeq: snapshot.serverSeq,
      },
    ],
    quarantineReason: null,
    updatedAtMs: nowMs,
  });
}

describe("two-client same-page pointers", () => {
  it("routes by committed document revision, expires locally, and never persists pointers", async () => {
    const owner = await activeSession("pointer-e2e-owner");
    const member = await activeSession("pointer-e2e-member");
    const room = await rooms.createRoom({
      actorUserId: owner.account.id,
      name: "Pointer E2E",
    });
    const invitation = await rooms.inviteByUsername({
      actorUserId: owner.account.id,
      roomId: room.id,
      username: member.account.username,
    });
    await rooms.acceptInvitation({
      actorUserId: member.account.id,
      invitationId: invitation.id,
    });
    const logicalTabId = randomUUID();
    await sequencer.commitOperation({
      principal: owner.principal,
      envelope: {
        protocolVersion: 1,
        clientOpId: randomUUID(),
        roomId: room.id,
        roomEpoch: 0,
        deviceId: owner.deviceId,
        baseServerSeq: 0,
        operation: {
          type: "tab.create",
          logicalTabId,
          url: "https://example.com/pointer-e2e",
          after: null,
        },
      },
    });
    let snapshot = await currentSnapshot(owner.principal, room.id);
    let ownerRecord = replicaRecord(snapshot, "018f8f8e-4b5c-7d6e-8f90-123456789f01", 101);
    let memberRecord = replicaRecord(snapshot, "018f8f8e-4b5c-7d6e-8f90-123456789f02", 201);
    const ownerTransport = await connectedTransport(owner.accessToken, room.id);
    const memberTransport = await connectedTransport(member.accessToken, room.id);
    const memberPointerTransport = new FilteringPointerTransport(memberTransport);
    const ownerPresence = presenceClient(
      room.id,
      ownerRecord.bindings[0]!.browserSessionId,
      owner.account.id,
      owner.deviceId,
      101,
      () => ownerRecord,
      ownerTransport,
    );
    const memberPresence = presenceClient(
      room.id,
      memberRecord.bindings[0]!.browserSessionId,
      member.account.id,
      member.deviceId,
      201,
      () => memberRecord,
      memberTransport,
    );
    await ownerPresence.handleActiveTabChanged(101);
    await memberPresence.handleActiveTabChanged(201);
    await ownerPresence.setSynchronized(true);
    await memberPresence.setSynchronized(true);

    const ownerPage = new ExactFakePagePort();
    const memberPage = new ExactFakePagePort();
    const ownerPointers = pointerClient({
      roomId: room.id,
      browserSessionId: ownerRecord.bindings[0]!.browserSessionId,
      deviceId: owner.deviceId,
      tabId: 101,
      record: () => ownerRecord,
      transport: ownerTransport,
      page: ownerPage,
    });
    const memberPointers = pointerClient({
      roomId: room.id,
      browserSessionId: memberRecord.bindings[0]!.browserSessionId,
      deviceId: member.deviceId,
      tabId: 201,
      record: () => memberRecord,
      transport: memberPointerTransport,
      page: memberPage,
    });
    await memberPointers.setSynchronized(true);
    await ownerPointers.setSynchronized(true);
    const durableBeforePointer = await roomDurableState(room.id);

    const sentAt = Date.now();
    await ownerPointers.handleLocalSample(101, sample(snapshot.roomEpoch, 1, 0.2));
    await waitFor(() => memberPage.displayed.has(`${owner.account.id}:${owner.deviceId}`));
    expect(Date.now() - sentAt).toBeLessThan(1_000);
    expect(memberPage.renders.at(-1)).toMatchObject({
      userId: owner.account.id,
      deviceId: owner.deviceId,
      logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      color: expect.stringMatching(/^#[0-9a-f]{6}$/u),
    });
    await expect(roomDurableState(room.id)).resolves.toEqual(durableBeforePointer);

    nowMs += 100;
    await sequencer.commitOperation({
      principal: owner.principal,
      envelope: {
        protocolVersion: 1,
        clientOpId: randomUUID(),
        roomId: room.id,
        roomEpoch: 0,
        deviceId: owner.deviceId,
        baseServerSeq: 1,
        operation: {
          type: "tab.navigate",
          logicalTabId,
          url: "https://example.com/pointer-e2e-v2",
        },
      },
    });
    snapshot = await currentSnapshot(owner.principal, room.id);
    ownerRecord = replicaRecord(snapshot, ownerRecord.bindings[0]!.browserSessionId, 101);
    memberRecord = replicaRecord(snapshot, memberRecord.bindings[0]!.browserSessionId, 201);
    await ownerPointers.handleBindingsChanged();
    await memberPointers.handleBindingsChanged();
    expect(memberPage.displayed).toHaveLength(0);
    const durableAfterNavigationOperation = await roomDurableState(room.id);

    nowMs += 100;
    await ownerPointers.handleLocalSample(101, sample(snapshot.roomEpoch, 2, 0.8));
    await waitFor(() => memberPage.displayed.has(`${owner.account.id}:${owner.deviceId}`));
    expect(memberPage.renders.at(-1)?.documentRevision).toEqual({
      roomEpoch: 0,
      tabUpdatedAtSeq: 2,
    });

    memberPage.allowInjection = false;
    await memberPointers.handleActiveTabChanged(201);
    expect(memberPage.displayed).toHaveLength(0);
    expect(memberPointers.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "POINTER_PERMISSION_REQUIRED",
    });

    memberPage.allowInjection = true;
    await memberPointers.handlePageReady(201);
    nowMs += 100;
    await ownerPointers.handleLocalSample(101, sample(snapshot.roomEpoch, 2, 0.9));
    await waitFor(() => memberPage.displayed.has(`${owner.account.id}:${owner.deviceId}`));

    memberPointerTransport.dropClear = true;
    await ownerTransport.disconnect();
    expect(memberPage.displayed).toHaveLength(1);
    nowMs += 3_001;
    memberPage.expire(nowMs);
    expect(memberPage.displayed).toHaveLength(0);

    await ownerPointers.setSynchronized(false);
    await ownerPresence.dispose();
    livePointers.delete(ownerPointers);
    livePresences.delete(ownerPresence);
    const reconnectMessages: PointerMessage[] = [];
    ownerTransport.setPointerHandler((message) => reconnectMessages.push(message));
    await connectAndSynchronize(ownerTransport, room.id);
    await waitFor(() =>
      reconnectMessages.some((message) => message.type === "pointer.lease.snapshot"),
    );
    expect(
      reconnectMessages.find((message) => message.type === "pointer.lease.snapshot"),
    ).toMatchObject({
      type: "pointer.lease.snapshot",
      leases: [],
    });

    const durableAfterNavigation = await roomDurableState(room.id);
    expect(durableAfterNavigation).toEqual(durableAfterNavigationOperation);
    expect(durableAfterNavigation).toMatchObject({
      serverSeq: 2,
      operationCount: 2,
    });
  });
});

function presenceClient(
  roomId: string,
  browserSessionId: string,
  userId: string,
  deviceId: string,
  tabId: number,
  record: () => ReplicaRecord,
  transport: SocketReplicaTransport,
): ActiveTabPresenceController {
  const controller = new ActiveTabPresenceController({
    roomId,
    browserSessionId,
    userId,
    deviceId,
    replica: { getRecord: async () => record() },
    transport,
    scheduler: new PassiveScheduler(),
    now: () => nowMs,
  });
  livePresences.add(controller);
  return controller;
}

function pointerClient(input: {
  roomId: string;
  browserSessionId: string;
  deviceId: string;
  tabId: number;
  record: () => ReplicaRecord;
  transport: PointerTransport;
  page: PointerPagePort;
}): PointerController {
  const controller = new PointerController({
    roomId: input.roomId,
    browserSessionId: input.browserSessionId,
    deviceId: input.deviceId,
    replica: { getRecord: async () => input.record() },
    transport: input.transport,
    page: input.page,
    compatibility: {
      canRenderRemotePointer: () => true,
      hasCompatibleRemotePointerObserver: () => true,
    },
    now: () => nowMs,
  });
  livePointers.add(controller);
  void controller.handleActiveTabChanged(input.tabId);
  return controller;
}

async function currentSnapshot(
  principal: Awaited<ReturnType<AccountService["authenticateAccessToken"]>>,
  roomId: string,
) {
  return RoomSnapshotMessageSchema.parse(
    await sequencer.synchronize({
      principal,
      request: {
        protocolVersion: 1,
        roomId: roomId as ClientOperationEnvelope["roomId"],
        roomEpoch: 0,
        lastServerSeq: 0,
        hasConfirmedSnapshot: false,
      },
    }),
  ).state;
}

function sample(roomEpoch: number, tabUpdatedAtSeq: number, viewportX: number) {
  return {
    type: "pointer.sample",
    documentRevision: { roomEpoch, tabUpdatedAtSeq },
    anchor: {
      path: [
        { tagName: "html", nthOfType: 1 },
        { tagName: "body", nthOfType: 1 },
      ],
      x: 0.5,
      y: 0.5,
    },
    viewport: { x: viewportX, y: 0.5 },
  };
}

async function roomDurableState(roomId: string): Promise<{
  serverSeq: number;
  operationCount: number;
  snapshotCount: number;
}> {
  const [room, operations, snapshots] = await Promise.all([
    db.selectFrom("rooms").select("serverSeq").where("id", "=", roomId).executeTakeFirstOrThrow(),
    db
      .selectFrom("roomOperations")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("roomSnapshots")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    serverSeq: room.serverSeq,
    operationCount: Number(operations.count),
    snapshotCount: Number(snapshots.count),
  };
}

function pointerKey(identity: PointerIdentity): string {
  return `${identity.userId}:${identity.deviceId}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("pointer condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
