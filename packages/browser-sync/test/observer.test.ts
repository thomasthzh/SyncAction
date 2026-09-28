import {
  DurableReplica,
  LocalTabBindingSchema,
  MemoryReplicaPersistence,
  ReplicaPermanentOperationError,
  ReplicaRepository,
  type AfterLocalOperationPersisted,
} from "@syncaction/replica";
import { RoomSnapshotStateSchema, type DurableOperation } from "@syncaction/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { BrowserPort } from "../src/actuator.js";
import { EffectLedger } from "../src/effect-ledger.js";
import { BrowserStateSchema, roomGroupTitle, type BrowserState } from "../src/model.js";
import { BrowserObserver, type LocalOperationWriter } from "../src/observer.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const secondId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const thirdId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const sessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
const clientOpIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789ac0",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac2",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac3",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac4",
];
const effectIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789ad0",
  "018f8f8e-4b5c-7d6e-8f90-123456789ad1",
  "018f8f8e-4b5c-7d6e-8f90-123456789ad2",
  "018f8f8e-4b5c-7d6e-8f90-123456789ad3",
  "018f8f8e-4b5c-7d6e-8f90-123456789ad4",
];
const confirmedSnapshot = RoomSnapshotStateSchema.parse({
  roomId,
  roomEpoch: 0,
  serverSeq: 2,
  order: [firstId, secondId],
  tabs: [
    {
      id: firstId,
      url: "https://example.com/first",
      favIconUrl: null,
      createdAtSeq: 1,
      updatedAtSeq: 1,
      closedAtSeq: null,
    },
    {
      id: secondId,
      url: "https://example.com/second",
      favIconUrl: null,
      createdAtSeq: 2,
      updatedAtSeq: 2,
      closedAtSeq: null,
    },
  ],
});

class MutableBrowser implements Pick<BrowserPort, "readState" | "ungroupTab"> {
  public readCount = 0;
  public ungroupCount = 0;
  public ungroupRace: "NONE" | "CLOSE_THEN_THROW" | "UNGROUP_THEN_THROW" | "THROW" = "NONE";
  public readonly ungroupFailure = new Error("simulated ungroup failure");
  public state: BrowserState = BrowserStateSchema.parse({
    browserSessionId: sessionId,
    windows: [{ windowId: 1, type: "normal", incognito: false }],
    groups: [
      {
        groupId: 7,
        windowId: 1,
        title: roomGroupTitle(roomId),
        color: "blue",
        collapsed: false,
      },
    ],
    tabs: [
      tab(50, null, 0, "https://personal.example/"),
      tab(10, 7, 1, "https://example.com/first"),
      tab(11, 7, 2, "https://example.com/second"),
    ],
  });

  public async readState(): Promise<BrowserState> {
    this.readCount += 1;
    return BrowserStateSchema.parse(structuredClone(this.state));
  }

  public async ungroupTab(tabId: number) {
    this.ungroupCount += 1;
    const browserTab = this.state.tabs.find((candidate) => candidate.tabId === tabId);
    if (browserTab === undefined) {
      throw new Error("missing tab");
    }
    if (this.ungroupRace === "CLOSE_THEN_THROW") {
      this.setTabs(this.state.tabs.filter((candidate) => candidate.tabId !== tabId));
      throw this.ungroupFailure;
    }
    if (this.ungroupRace === "UNGROUP_THEN_THROW") {
      browserTab.groupId = null;
      this.state = BrowserStateSchema.parse(this.state);
      throw this.ungroupFailure;
    }
    if (this.ungroupRace === "THROW") {
      throw this.ungroupFailure;
    }
    browserTab.groupId = null;
    this.state = BrowserStateSchema.parse(this.state);
    return structuredClone(browserTab);
  }

  public setTabs(tabs: BrowserState["tabs"]): void {
    this.state = BrowserStateSchema.parse({
      ...this.state,
      tabs,
    });
  }
}

class RecordingWriter implements LocalOperationWriter {
  public readonly operations: DurableOperation[] = [];

  public constructor(private readonly replica: DurableReplica) {}

  public async enqueueLocalOperation(
    operation: unknown,
    afterPersist?: AfterLocalOperationPersisted,
  ): Promise<void> {
    const item = await this.replica.enqueueLocalOperation(operation);
    this.operations.push(item.envelope.operation);
    await afterPersist?.(item);
  }
}

class CapacityRejectingWriter implements LocalOperationWriter {
  public constructor(
    private readonly replica: DurableReplica,
    private readonly afterBinding: (() => void) | undefined = undefined,
  ) {}

  public async enqueueLocalOperation(
    operation: unknown,
    afterPersist?: AfterLocalOperationPersisted,
  ): Promise<void> {
    const item = await this.replica.enqueueLocalOperation(operation);
    await afterPersist?.(item);
    this.afterBinding?.();
    await this.replica.reject(item.envelope.clientOpId);
    throw new ReplicaPermanentOperationError("ROOM_TAB_LIMIT_REACHED");
  }
}

class FailingWriter implements LocalOperationWriter {
  public constructor(
    private readonly replica: DurableReplica,
    private readonly failure: unknown,
  ) {}

  public async enqueueLocalOperation(
    operation: unknown,
    afterPersist?: AfterLocalOperationPersisted,
  ): Promise<void> {
    const item = await this.replica.enqueueLocalOperation(operation);
    await afterPersist?.(item);
    throw this.failure;
  }
}

let repository: ReplicaRepository;
let persistence: MemoryReplicaPersistence;
let replica: DurableReplica;
let browser: MutableBrowser;
let ledger: EffectLedger;
let writer: RecordingWriter;
let observer: BrowserObserver;
let nextClientOpIndex: number;

beforeEach(async () => {
  persistence = new MemoryReplicaPersistence();
  repository = new ReplicaRepository({
    persistence,
    now: () => 1_000,
  });
  nextClientOpIndex = 0;
  replica = new DurableReplica({
    repository,
    roomId,
    deviceId,
    now: () => 1_000,
    createClientOpId: () => clientOpIds[nextClientOpIndex++]!,
  });
  await repository.update(roomId, (record) => ({
    ...record,
    mode: "SYNCED",
    confirmedSnapshot,
    bindings: [binding(firstId, 10), binding(secondId, 11)],
  }));
  browser = new MutableBrowser();
  ledger = new EffectLedger();
  writer = new RecordingWriter(replica);
  observer = createObserver();
});

function createObserver(
  isActuatable = () => true,
  operationWriter: LocalOperationWriter = writer,
): BrowserObserver {
  return new BrowserObserver({
    roomId,
    replica,
    browser,
    ledger,
    writer: operationWriter,
    isActuatable,
    now: () => 1_100,
    createLogicalTabId: () => thirdId,
  });
}

function tab(
  tabId: number,
  groupId: number | null,
  index: number,
  url: string,
  status: "loading" | "complete" = "complete",
) {
  return {
    tabId,
    windowId: 1,
    groupId,
    index,
    url,
    title: url,
    status,
    pinned: false,
  } as const;
}

function binding(logicalTabId: string, tabId: number) {
  return LocalTabBindingSchema.parse({
    logicalTabId,
    tabId,
    windowId: 1,
    groupId: 7,
    browserSessionId: sessionId,
    validatedAtServerSeq: 2,
  });
}

function beginEffect(
  index: number,
  logicalTabId: string,
  expectation:
    | { type: "TAB_CREATED"; tabId: number | null; url: string }
    | { type: "TAB_GROUPED"; tabId: number; groupId: number | null }
    | { type: "TAB_NAVIGATED"; tabId: number; url: string }
    | { type: "TAB_MOVED"; tabId: number; windowId: number; index: number }
    | { type: "TAB_CLOSED"; tabId: number },
): void {
  ledger.begin({
    effectId: effectIds[index],
    logicalTabId,
    serverSeq: 2,
    expectation,
    startedAtMs: 1_000,
    expiresAtMs: 2_000,
  });
}

describe("browser observer", () => {
  it("waits past onCreated, then persists and binds one proven shared tab", async () => {
    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(10, 7, 1, "https://example.com/first"),
      tab(11, 7, 2, "https://example.com/second"),
      tab(12, 7, 3, "https://example.com/third"),
    ]);

    expect(
      await observer.observe({
        type: "TAB_CREATED",
        tabId: 12,
        url: "https://example.com/third",
      }),
    ).toEqual({ kind: "IGNORED", reason: "EARLY_EVENT" });
    expect(writer.operations).toEqual([]);

    expect(await observer.observe({ type: "TAB_UPDATED", tabId: 12 })).toMatchObject({
      kind: "INTENT_RECORDED",
      operation: {
        type: "tab.create",
        logicalTabId: thirdId,
        url: "https://example.com/third",
        after: secondId,
      },
    });
    expect((await replica.getRecord()).bindings).toContainEqual(binding(thirdId, 12));
    expect((await replica.getOptimisticState()).order).toEqual([firstId, secondId, thirdId]);
  });

  it("bootstraps an empty room only after an explicit share-current-tab command", async () => {
    await repository.update(roomId, (record) => ({
      ...record,
      confirmedSnapshot: {
        ...record.confirmedSnapshot!,
        order: [],
        tabs: [],
      },
      bindings: [],
    }));
    browser.state = BrowserStateSchema.parse({
      ...browser.state,
      groups: [],
      tabs: [tab(50, null, 0, "https://personal.example/to-share")],
    });

    expect(await observer.shareTab(50)).toMatchObject({
      kind: "INTENT_RECORDED",
      operation: {
        type: "tab.create",
        logicalTabId: thirdId,
        url: "https://personal.example/to-share",
        after: null,
      },
    });
    expect((await replica.getRecord()).bindings).toContainEqual({
      ...binding(thirdId, 50),
      groupId: null,
    });
    expect(browser.state.tabs).toEqual([tab(50, null, 0, "https://personal.example/to-share")]);
  });

  it("keeps an explicitly shared personal tab open and unbound after capacity rejection", async () => {
    await repository.update(roomId, (record) => ({
      ...record,
      confirmedSnapshot: {
        ...record.confirmedSnapshot!,
        order: [],
        tabs: [],
      },
      bindings: [],
    }));
    browser.state = BrowserStateSchema.parse({
      ...browser.state,
      groups: [],
      tabs: [tab(50, null, 0, "https://personal.example/kept-open")],
    });
    observer = createObserver(() => true, new CapacityRejectingWriter(replica));
    const writesBeforeShare = persistence.writes.length;

    await expect(observer.shareTab(50)).resolves.toEqual({
      kind: "BLOCKED",
      reason: "ROOM_TAB_LIMIT_REACHED",
    });

    expect(browser.state.tabs).toEqual([tab(50, null, 0, "https://personal.example/kept-open")]);
    expect(browser.ungroupCount).toBe(0);
    expect(await replica.getRecord()).toMatchObject({
      mode: "SYNCED",
      outbox: [],
      bindings: [],
    });
    expect(persistence.writes).toHaveLength(writesBeforeShare + 3);
  });

  it.each([
    {
      freshState: "grouped",
      updateBrowser: () => undefined,
      expectedUngroupCount: 1,
      expectedTabGroupId: null,
    },
    {
      freshState: "already ungrouped",
      updateBrowser: () => {
        browser.state.tabs.find((candidate) => candidate.tabId === 12)!.groupId = null;
        browser.state = BrowserStateSchema.parse(browser.state);
      },
      expectedUngroupCount: 0,
      expectedTabGroupId: null,
    },
    {
      freshState: "missing",
      updateBrowser: () => {
        browser.setTabs(browser.state.tabs.filter((candidate) => candidate.tabId !== 12));
      },
      expectedUngroupCount: 0,
      expectedTabGroupId: undefined,
    },
  ])(
    "cleans a rejected unbound room tab from a fresh $freshState browser snapshot",
    async ({ updateBrowser, expectedUngroupCount, expectedTabGroupId }) => {
      browser.setTabs([
        tab(50, null, 0, "https://personal.example/"),
        tab(10, 7, 1, "https://example.com/first"),
        tab(11, 7, 2, "https://example.com/second"),
        tab(12, 7, 3, "https://example.com/rejected"),
      ]);
      observer = createObserver(() => true, new CapacityRejectingWriter(replica, updateBrowser));

      await expect(
        observer.observe({
          type: "TAB_UPDATED",
          tabId: 12,
        }),
      ).resolves.toEqual({
        kind: "BLOCKED",
        reason: "ROOM_TAB_LIMIT_REACHED",
      });

      expect(browser.ungroupCount).toBe(expectedUngroupCount);
      expect(browser.state.tabs.find((candidate) => candidate.tabId === 12)?.groupId).toBe(
        expectedTabGroupId,
      );
      const record = await replica.getRecord();
      expect(record.mode).toBe("SYNCED");
      expect(record.outbox).toEqual([]);
      expect(record.bindings).not.toContainEqual(
        expect.objectContaining({ logicalTabId: thirdId }),
      );
      expect(record.bindings).not.toContainEqual(expect.objectContaining({ tabId: 12 }));
    },
  );

  it.each([
    {
      race: "CLOSE_THEN_THROW" as const,
      expectedGroupId: undefined,
    },
    {
      race: "UNGROUP_THEN_THROW" as const,
      expectedGroupId: null,
    },
  ])(
    "tolerates a concurrent $race during rejected-tab ungroup cleanup",
    async ({ race, expectedGroupId }) => {
      browser.setTabs([
        tab(50, null, 0, "https://personal.example/"),
        tab(10, 7, 1, "https://example.com/first"),
        tab(11, 7, 2, "https://example.com/second"),
        tab(12, 7, 3, "https://example.com/rejected"),
      ]);
      browser.ungroupRace = race;
      observer = createObserver(() => true, new CapacityRejectingWriter(replica));

      await expect(
        observer.observe({
          type: "TAB_UPDATED",
          tabId: 12,
        }),
      ).resolves.toEqual({
        kind: "BLOCKED",
        reason: "ROOM_TAB_LIMIT_REACHED",
      });

      expect(browser.ungroupCount).toBe(1);
      expect(browser.readCount).toBe(3);
      expect(browser.state.tabs.find((candidate) => candidate.tabId === 12)?.groupId).toBe(
        expectedGroupId,
      );
      expect((await replica.getRecord()).bindings).not.toContainEqual(
        expect.objectContaining({ logicalTabId: thirdId }),
      );
    },
  );

  it("rethrows an ungroup failure when the fresh tab is still grouped without retrying", async () => {
    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(10, 7, 1, "https://example.com/first"),
      tab(11, 7, 2, "https://example.com/second"),
      tab(12, 7, 3, "https://example.com/rejected"),
    ]);
    browser.ungroupRace = "THROW";
    observer = createObserver(() => true, new CapacityRejectingWriter(replica));

    await expect(
      observer.observe({
        type: "TAB_UPDATED",
        tabId: 12,
      }),
    ).rejects.toBe(browser.ungroupFailure);

    expect(browser.ungroupCount).toBe(1);
    expect(browser.readCount).toBe(3);
    expect(browser.state.tabs.find((candidate) => candidate.tabId === 12)?.groupId).toBe(7);
  });

  it.each([
    {
      failureKind: "ordinary failure",
      createFailure: () => new Error("temporary transport failure"),
    },
    {
      failureKind: "lookalike capacity code",
      createFailure: () =>
        Object.assign(new Error("lookalike"), {
          serverCode: "ROOM_TAB_LIMIT_REACHED",
        }),
    },
    {
      failureKind: "different permanent server code",
      createFailure: () =>
        Object.defineProperty(
          new ReplicaPermanentOperationError("ROOM_TAB_LIMIT_REACHED"),
          "serverCode",
          { value: "ROOM_NOT_FOUND" },
        ),
    },
  ])("does not classify or clean up a $failureKind", async ({ createFailure }) => {
    const failure = createFailure();
    await repository.update(roomId, (record) => ({
      ...record,
      confirmedSnapshot: {
        ...record.confirmedSnapshot!,
        order: [],
        tabs: [],
      },
      bindings: [],
    }));
    browser.state = BrowserStateSchema.parse({
      ...browser.state,
      groups: [],
      tabs: [tab(50, null, 0, "https://personal.example/transient")],
    });
    observer = createObserver(() => true, new FailingWriter(replica, failure));

    await expect(observer.shareTab(50)).rejects.toBe(failure);

    expect(browser.ungroupCount).toBe(0);
    expect((await replica.getRecord()).bindings).toContainEqual(
      expect.objectContaining({ logicalTabId: thirdId, tabId: 50 }),
    );
  });

  it("records committed supported navigation but ignores loading and rejects unsupported room URLs", async () => {
    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(10, 7, 1, "https://example.com/loading", "loading"),
      tab(11, 7, 2, "https://example.com/second"),
    ]);
    expect(await observer.observe({ type: "TAB_UPDATED", tabId: 10 })).toEqual({
      kind: "IGNORED",
      reason: "LOADING",
    });
    expect(writer.operations).toEqual([]);

    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(10, 7, 1, "https://example.com/local"),
      tab(11, 7, 2, "https://example.com/second"),
    ]);
    expect(await observer.observe({ type: "TAB_UPDATED", tabId: 10 })).toMatchObject({
      kind: "INTENT_RECORDED",
      operation: {
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/local",
      },
    });

    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(10, 7, 1, "chrome://settings"),
      tab(11, 7, 2, "https://example.com/second"),
    ]);
    expect(await observer.observe({ type: "TAB_UPDATED", tabId: 10 })).toEqual({
      kind: "RECOVERY_REQUIRED",
      reason: "UNSUPPORTED_ROOM_TAB",
    });
  });

  it("derives move anchors from a fresh, completely bound room-group order", async () => {
    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(11, 7, 1, "https://example.com/second"),
      tab(10, 7, 2, "https://example.com/first"),
    ]);

    expect(
      await observer.observe({
        type: "TAB_MOVED",
        tabId: 10,
        windowId: 1,
        index: 2,
      }),
    ).toMatchObject({
      kind: "INTENT_RECORDED",
      operation: {
        type: "tab.move",
        logicalTabId: firstId,
        predecessor: secondId,
        successor: null,
      },
    });
  });

  it("records exact local close after persist and never turns window teardown into close intent", async () => {
    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(11, 7, 1, "https://example.com/second"),
    ]);
    expect(
      await observer.observe({
        type: "TAB_REMOVED",
        tabId: 10,
        windowId: 1,
        isWindowClosing: false,
      }),
    ).toMatchObject({
      kind: "INTENT_RECORDED",
      operation: { type: "tab.close", logicalTabId: firstId },
    });
    expect((await replica.getRecord()).bindings).not.toContainEqual(binding(firstId, 10));

    expect(
      await observer.observe({
        type: "TAB_REMOVED",
        tabId: 11,
        windowId: 1,
        isWindowClosing: true,
      }),
    ).toEqual({
      kind: "RECOVERY_REQUIRED",
      reason: "WINDOW_CLOSING",
    });
    expect(writer.operations).toHaveLength(1);
  });

  it("ignores personal tabs and treats attach, detach, or replacement as recovery", async () => {
    browser.setTabs([
      tab(50, null, 0, "https://personal.example/changed"),
      tab(10, 7, 1, "https://example.com/first"),
      tab(11, 7, 2, "https://example.com/second"),
    ]);
    expect(await observer.observe({ type: "TAB_UPDATED", tabId: 50 })).toEqual({
      kind: "IGNORED",
      reason: "PERSONAL_TAB",
    });
    expect(await observer.observe({ type: "TAB_DETACHED", tabId: 10 })).toEqual({
      kind: "RECOVERY_REQUIRED",
      reason: "TAB_DETACHED",
    });
    expect(await observer.observe({ type: "TAB_ATTACHED", tabId: 10 })).toEqual({
      kind: "RECOVERY_REQUIRED",
      reason: "TAB_ATTACHED",
    });
    expect(
      await observer.observe({
        type: "TAB_REPLACED",
        addedTabId: 20,
        removedTabId: 10,
      }),
    ).toEqual({
      kind: "RECOVERY_REQUIRED",
      reason: "TAB_REPLACED",
    });
    expect(writer.operations).toEqual([]);
  });

  it("consumes exact actuator callbacks before considering any local intent", async () => {
    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(11, 7, 1, "https://example.com/second"),
      tab(10, 7, 2, "https://example.com/remote"),
      tab(90, 7, 3, "https://example.com/restored"),
    ]);
    beginEffect(0, thirdId, {
      type: "TAB_CREATED",
      tabId: 90,
      url: "https://example.com/restored",
    });
    beginEffect(1, thirdId, {
      type: "TAB_GROUPED",
      tabId: 90,
      groupId: 7,
    });
    beginEffect(2, firstId, {
      type: "TAB_NAVIGATED",
      tabId: 10,
      url: "https://example.com/remote",
    });
    beginEffect(3, firstId, {
      type: "TAB_MOVED",
      tabId: 10,
      windowId: 1,
      index: 2,
    });
    beginEffect(4, secondId, {
      type: "TAB_CLOSED",
      tabId: 11,
    });

    expect(
      await observer.observe({
        type: "TAB_CREATED",
        tabId: 90,
        url: "https://example.com/restored",
      }),
    ).toMatchObject({ kind: "EFFECT_CONSUMED", effectId: effectIds[0] });
    expect(
      await observer.observe({
        type: "TAB_GROUP_CHANGED",
        tabId: 90,
        groupId: 7,
      }),
    ).toMatchObject({ kind: "EFFECT_CONSUMED", effectId: effectIds[1] });
    expect(await observer.observe({ type: "TAB_UPDATED", tabId: 10 })).toMatchObject({
      kind: "EFFECT_CONSUMED",
      effectId: effectIds[2],
    });
    expect(
      await observer.observe({
        type: "TAB_MOVED",
        tabId: 10,
        windowId: 1,
        index: 2,
      }),
    ).toMatchObject({ kind: "EFFECT_CONSUMED", effectId: effectIds[3] });

    browser.setTabs([
      tab(50, null, 0, "https://personal.example/"),
      tab(10, 7, 1, "https://example.com/remote"),
      tab(90, 7, 2, "https://example.com/restored"),
    ]);
    expect(
      await observer.observe({
        type: "TAB_REMOVED",
        tabId: 11,
        windowId: 1,
        isWindowClosing: false,
      }),
    ).toMatchObject({ kind: "EFFECT_CONSUMED", effectId: effectIds[4] });
    expect(ledger.size).toBe(0);
    expect(writer.operations).toEqual([]);
  });

  it("blocks durable intent when the replica is not actuatable", async () => {
    observer = createObserver(() => false);
    expect(await observer.observe({ type: "TAB_UPDATED", tabId: 10 })).toEqual({
      kind: "BLOCKED",
      reason: "REPLICA_NOT_ACTUATABLE",
    });
    expect(writer.operations).toEqual([]);
  });
});
