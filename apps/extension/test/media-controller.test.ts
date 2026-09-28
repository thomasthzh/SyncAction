import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  MediaCommandAckSchema,
  MediaGroupsSnapshotMessageSchema,
  MediaTargetSchema,
  PlaybackGroupSnapshotSchema,
  RoomIdSchema,
  RoomSnapshotStateSchema,
  type MediaCommand,
  type MediaCommandAck,
  type MediaGroupsSnapshotMessage,
  type MediaHeartbeat,
  type MediaObservedState,
  type MediaTarget,
  type PlaybackGroupMember,
  type PlaybackGroupSnapshot,
} from "@syncaction/protocol";
import { ReplicaRecordSchema, type ReplicaRecord } from "@syncaction/replica";
import { describe, expect, it } from "vitest";
import {
  MediaController,
  type MediaControllerOptions,
  type MediaNavigationPort,
  type MediaPagePort,
  type MediaScheduler,
} from "../src/media-controller.js";
import {
  MediaObservedMessageSchema,
  type MediaObservedMessage,
  type MediaPageApplyAction,
} from "../src/page-collaboration/messages.js";
import type { MediaTransport } from "../src/socket-transport.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a02");
const secondLogicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a0a");
const leaderUserId = "018f8f8e-4b5c-7d6e-8f90-123456789a03";
const leaderDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a04");
const followerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789a05";
const followerDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a06");
const secondFollowerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789a07";
const secondFollowerDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a08");
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789a09";
const playbackGroupId = "00000000-0000-4000-8000-000000000101";
const nowMs = 1_700_000_000_000;

const target = MediaTargetSchema.parse({
  logicalTabId,
  documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
});
const secondTarget = MediaTargetSchema.parse({
  logicalTabId: secondLogicalTabId,
  documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:9bZkp7q19f0",
  durationMs: 253_000,
});
const sameDocumentSecondTarget = MediaTargetSchema.parse({
  ...target,
  provider: "HTML5",
  mediaKey: "html5:secondary-player",
  durationMs: 253_000,
});

const playing: MediaObservedState = {
  observedAtClientMs: nowMs,
  positionMs: 42_000,
  paused: false,
  playbackRate: 1,
  ended: false,
  buffering: false,
};

function member(
  userId: string,
  activeDeviceId: string,
  overrides: Partial<PlaybackGroupMember> = {},
): PlaybackGroupMember {
  return {
    userId,
    username: `user-${userId.slice(-2)}`,
    displayName: `Member ${userId.slice(-2)}`,
    activeDeviceId: activeDeviceId as PlaybackGroupMember["activeDeviceId"],
    joinedAtServerMs: nowMs - 5_000,
    online: true,
    ...overrides,
  };
}

function group(overrides: Partial<PlaybackGroupSnapshot> = {}): PlaybackGroupSnapshot {
  return PlaybackGroupSnapshotSchema.parse({
    playbackGroupId,
    roomId,
    groupRevision: 3,
    status: "PLAYING",
    leaderUserId,
    leaderDeviceId,
    members: [
      member(leaderUserId, leaderDeviceId),
      member(followerUserId, followerDeviceId),
      member(secondFollowerUserId, secondFollowerDeviceId),
    ],
    target,
    observed: playing,
    observedAtServerMs: nowMs,
    proposals: [],
    leaderGraceExpiresAtServerMs: null,
    updatedAtServerMs: nowMs,
    ...overrides,
  });
}

function snapshot(
  groups: PlaybackGroupSnapshot[] = [group()],
  roomMediaRevision = 1,
): MediaGroupsSnapshotMessage {
  return MediaGroupsSnapshotMessageSchema.parse({
    type: "media.groups.snapshot",
    protocolVersion: 1,
    roomId,
    roomMediaRevision,
    groups,
  });
}

function record(
  sessionId = browserSessionId,
  tabId = 10,
  overrides: Partial<ReplicaRecord> = {},
): ReplicaRecord {
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId,
    mode: "SYNCED",
    confirmedSnapshot: RoomSnapshotStateSchema.parse({
      roomId,
      roomEpoch: 0,
      serverSeq: 12,
      order: [logicalTabId],
      tabs: [
        {
          id: logicalTabId,
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          title: "Existing product title",
          favIconUrl: null,
          createdAtSeq: 1,
          updatedAtSeq: 12,
          closedAtSeq: null,
        },
      ],
    }),
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: [
      {
        logicalTabId,
        tabId,
        windowId: 1,
        groupId: null,
        browserSessionId: sessionId,
        validatedAtServerSeq: 12,
      },
    ],
    quarantineReason: null,
    updatedAtMs: nowMs,
    ...overrides,
  });
}

class FakeScheduler implements MediaScheduler {
  public now = nowMs;
  #nextId = 1;
  readonly #tasks = new Map<
    number,
    { callback: () => void; at: number; intervalMs: number | null }
  >();

  public setTimeout(callback: () => void, delayMs: number): number {
    return this.#schedule(callback, delayMs, null);
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.#tasks.delete(handle);
    }
  }

  public setInterval(callback: () => void, intervalMs: number): number {
    return this.#schedule(callback, intervalMs, intervalMs);
  }

  public clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }

  public advanceBy(deltaMs: number): void {
    const destination = this.now + deltaMs;
    for (;;) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.at <= destination)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (next === undefined) {
        break;
      }
      const [id, task] = next;
      this.now = task.at;
      if (task.intervalMs === null) {
        this.#tasks.delete(id);
      } else {
        task.at += task.intervalMs;
      }
      task.callback();
    }
    this.now = destination;
  }

  public get taskCount(): number {
    return this.#tasks.size;
  }

  #schedule(callback: () => void, delayMs: number, intervalMs: number | null): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, {
      callback,
      at: this.now + delayMs,
      intervalMs,
    });
    return id;
  }
}

interface PageApply {
  tabId: number;
  frameId: number;
  context: MediaObservedMessage["context"];
  target: MediaTarget;
  action: MediaPageApplyAction;
  applyToken: string;
}

class FakePage implements MediaPagePort {
  public playbackRate = 1;
  public readonly observations: Array<{
    tabId: number;
    frameId: number;
    context: MediaObservedMessage["context"];
    target?: MediaTarget;
  }> = [];
  public readonly applies: PageApply[] = [];
  public readonly locks: Array<{
    tabId: number;
    frameId: number;
    target: MediaTarget;
    locked: boolean;
  }> = [];
  public observeBarrier: Promise<void> | undefined;
  public applyBarrier: Promise<void> | undefined;
  public observeErrorOnce: Error | undefined;
  public lockEnableErrorOnce: Error | undefined;
  public onApply: ((apply: PageApply) => void) | undefined;
  #temporaryRateRestore: { target: MediaTarget; restoreRate: number } | undefined;

  public async observe(
    tabId: number,
    frameId: number,
    context: MediaObservedMessage["context"],
    target?: MediaTarget,
  ): Promise<void> {
    this.observations.push({
      tabId,
      frameId,
      context: structuredClone(context),
      ...(target === undefined ? {} : { target: structuredClone(target) }),
    });
    if (this.observeErrorOnce !== undefined) {
      const error = this.observeErrorOnce;
      this.observeErrorOnce = undefined;
      throw error;
    }
    await this.observeBarrier;
  }

  public async apply(
    tabId: number,
    frameId: number,
    context: MediaObservedMessage["context"],
    applyTarget: MediaTarget,
    action: MediaPageApplyAction,
    applyToken: string,
  ): Promise<void> {
    const pageApply = {
      tabId,
      frameId,
      context: structuredClone(context),
      target: structuredClone(applyTarget),
      action: structuredClone(action),
      applyToken,
    };
    this.applies.push(pageApply);
    if (action.type === "SET_RATE_TEMPORARY") {
      this.playbackRate = action.playbackRate;
      this.#temporaryRateRestore = {
        target: structuredClone(applyTarget),
        restoreRate: action.restoreRate,
      };
    } else if (action.type === "SET_RATE") {
      this.playbackRate = action.playbackRate;
      this.#temporaryRateRestore = undefined;
    }
    this.onApply?.(pageApply);
    await this.applyBarrier;
  }

  public async setFollowerLock(
    tabId: number,
    frameId: number,
    _context: MediaObservedMessage["context"],
    lockTarget: MediaTarget,
    locked: boolean,
  ): Promise<void> {
    this.locks.push({
      tabId,
      frameId,
      target: structuredClone(lockTarget),
      locked,
    });
    if (locked && this.lockEnableErrorOnce !== undefined) {
      const error = this.lockEnableErrorOnce;
      this.lockEnableErrorOnce = undefined;
      throw error;
    }
    if (
      !locked &&
      this.#temporaryRateRestore !== undefined &&
      sameTestTarget(this.#temporaryRateRestore.target, lockTarget)
    ) {
      this.playbackRate = this.#temporaryRateRestore.restoreRate;
      this.#temporaryRateRestore = undefined;
    }
  }
}

class FakeNavigation implements MediaNavigationPort {
  public readonly activated: number[] = [];

  public async activateTab(tabId: number): Promise<void> {
    this.activated.push(tabId);
  }
}

class FakeMediaTransport implements MediaTransport {
  public handler: ((message: MediaGroupsSnapshotMessage) => void) | undefined;
  public readonly commands: MediaCommand[] = [];
  public readonly heartbeats: MediaHeartbeat[] = [];
  public commandResponder:
    ((command: MediaCommand) => MediaCommandAck | Promise<MediaCommandAck>) | undefined;

  public setMediaHandler(
    handler: ((message: MediaGroupsSnapshotMessage) => void) | undefined,
  ): void {
    this.handler = handler;
  }

  public async sendMediaCommand(command: MediaCommand): Promise<MediaCommandAck> {
    this.commands.push(structuredClone(command));
    if (this.commandResponder !== undefined) {
      return this.commandResponder(command);
    }
    return MediaCommandAckSchema.parse({
      type: "media.command.ack",
      protocolVersion: 1,
      commandId: command.commandId,
      roomId,
      roomMediaRevision: 100,
      accepted: true,
      code: null,
      playbackGroupId: command.type === "group.create" ? playbackGroupId : command.playbackGroupId,
      groupRevision: command.type === "group.create" ? 1 : command.expectedGroupRevision + 1,
    });
  }

  public publishMediaHeartbeat(heartbeat: MediaHeartbeat): void {
    this.heartbeats.push(structuredClone(heartbeat));
  }

  public emit(value: MediaGroupsSnapshotMessage): void {
    this.handler?.(value);
  }
}

interface Harness {
  controller: MediaController;
  scheduler: FakeScheduler;
  replicaRecord: ReplicaRecord;
  replicaGates: Array<
    | undefined
    | {
        entered(): void;
        promise: Promise<void>;
      }
  >;
  page: FakePage;
  transport: FakeMediaTransport;
  navigation: FakeNavigation;
}

function harness(
  options: {
    userId?: string;
    deviceId?: string;
    sessionId?: string;
    tabId?: number;
    presenceLogicalTabId?: string | null;
    mediaCompatible?: boolean;
  } = {},
): Harness {
  const scheduler = new FakeScheduler();
  const page = new FakePage();
  const transport = new FakeMediaTransport();
  const navigation = new FakeNavigation();
  const replicaRecord = record(options.sessionId, options.tabId);
  const replicaGates: Harness["replicaGates"] = [];
  let uuidCounter = 1;
  const controllerOptions: MediaControllerOptions = {
    roomId,
    userId: options.userId ?? followerUserId,
    deviceId: options.deviceId ?? followerDeviceId,
    browserSessionId: options.sessionId ?? browserSessionId,
    replica: {
      getRecord: async () => {
        const gate = replicaGates.shift();
        if (gate !== undefined) {
          gate.entered();
          await gate.promise;
        }
        return structuredClone(replicaRecord);
      },
    },
    presence: {
      getStatus: () => ({
        state: "ONLINE",
        lastAckExpiresAt: nowMs + 30_000,
        errorCode: null,
        presences: [
          {
            userId: secondFollowerUserId,
            username: "second",
            displayName: "Second follower",
            deviceId: secondFollowerDeviceId,
            logicalTabId: LogicalTabIdSchema.nullable().parse(
              options.presenceLogicalTabId ?? logicalTabId,
            ),
            expiresAt: nowMs + 30_000,
          },
        ],
      }),
    },
    page,
    transport,
    ...(options.mediaCompatible === undefined
      ? {}
      : {
          compatibility: {
            canSynchronizeKnownMedia: () => options.mediaCompatible!,
          },
        }),
    navigation,
    now: () => scheduler.now,
    createUuid: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`,
    scheduler,
  };
  return {
    controller: new MediaController(controllerOptions),
    scheduler,
    replicaRecord,
    replicaGates,
    page,
    transport,
    navigation,
  };
}

function observedMessage(
  observed: MediaObservedState,
  overrides: Partial<MediaObservedMessage> = {},
): MediaObservedMessage {
  return MediaObservedMessageSchema.parse({
    type: "syncaction.media.observed",
    event: "DISCOVERED",
    context: {
      roomId,
      logicalTabId,
      documentRevision: target.documentRevision,
      frameKey: target.frameKey,
    },
    target,
    observed,
    applyToken: null,
    resultCode: null,
    ...overrides,
  });
}

async function connect(
  value: Harness,
  mediaSnapshot: MediaGroupsSnapshotMessage = snapshot(),
): Promise<void> {
  await value.controller.setSynchronized(true);
  await value.controller.handleActiveTabChanged(10);
  value.transport.emit(mediaSnapshot);
  await value.controller.whenIdle();
}

async function observe(
  value: Harness,
  observed: MediaObservedState = playing,
  overrides: Partial<MediaObservedMessage> = {},
): Promise<void> {
  await value.controller.handleMediaObserved(10, 0, observedMessage(observed, overrides));
  await value.controller.whenIdle();
}

interface LeaderAuthorityBatchFixture {
  authority: MediaObservedState;
  local: MediaObservedState;
  applies: [PageApply, PageApply, PageApply];
}

async function beginLeaderAuthorityBatch(value: Harness): Promise<LeaderAuthorityBatchFixture> {
  await connect(value);
  await observe(value);
  const initialAlignment = value.page.applies.at(-1);
  if (initialAlignment === undefined) {
    throw new Error("expected initial leader alignment");
  }
  await reportApplyResult(value, initialAlignment, playing);
  value.page.applies.length = 0;
  value.transport.heartbeats.length = 0;
  const local: MediaObservedState = {
    ...playing,
    positionMs: 75_000,
    paused: true,
    playbackRate: 0.75,
  };
  await observe(value, local);
  value.page.applies.length = 0;
  value.transport.heartbeats.length = 0;
  const authority: MediaObservedState = {
    ...playing,
    positionMs: 80_000,
    paused: false,
    playbackRate: 1.25,
  };
  value.transport.emit(
    snapshot(
      [
        group({
          groupRevision: 4,
          observed: authority,
          observedAtServerMs: nowMs,
          updatedAtServerMs: nowMs + 1,
        }),
      ],
      2,
    ),
  );
  await value.controller.whenIdle();
  expect(value.page.applies.map(({ action }) => action)).toEqual([
    { type: "SEEK", positionMs: 80_000 },
    { type: "SET_RATE", playbackRate: 1.25 },
    { type: "PLAY" },
  ]);
  return {
    authority,
    local,
    applies: value.page.applies as [PageApply, PageApply, PageApply],
  };
}

async function reportApplyResult(
  value: Harness,
  apply: PageApply,
  observed: MediaObservedState,
  resultCode: Extract<MediaObservedMessage, { event: "APPLY_RESULT" }>["resultCode"] = null,
): Promise<void> {
  await value.controller.handleMediaObserved(
    apply.tabId,
    apply.frameId,
    observedMessage(observed, {
      event: "APPLY_RESULT",
      context: apply.context,
      target: apply.target,
      applyToken: apply.applyToken,
      resultCode,
    }),
  );
  await value.controller.whenIdle();
}

describe("MediaController", () => {
  it("does not lock or control follower media when the leader media identity is incompatible", async () => {
    const value = harness({ mediaCompatible: false });

    await connect(value);

    expect(value.page.locks.some(({ locked }) => locked)).toBe(false);
    expect(value.page.applies).toEqual([]);
    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "MEDIA_MISMATCH",
      localMembership: null,
    });
  });

  it("publishes heartbeats only for the exact browser-session binding and document context", async () => {
    const value = harness({ userId: leaderUserId, deviceId: leaderDeviceId });
    await connect(value);

    await value.controller.handleMediaObserved(
      11,
      0,
      observedMessage({ ...playing, positionMs: 41_000 }),
    );
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        { ...playing, positionMs: 41_500 },
        {
          context: {
            roomId,
            logicalTabId,
            documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 11 },
            frameKey: "top",
          },
          target: {
            ...target,
            documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 11 },
          },
        },
      ),
    );
    value.scheduler.advanceBy(500);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toHaveLength(0);

    await observe(value, {
      ...playing,
      observedAtClientMs: value.scheduler.now,
      positionMs: 42_500,
    });
    const restoration = value.page.applies.at(-1);
    if (restoration === undefined) {
      throw new Error("expected initial leader restoration");
    }
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          observedAtClientMs: value.scheduler.now,
          positionMs: 42_500,
        },
        {
          event: "APPLY_RESULT",
          applyToken: restoration.applyToken,
        },
      ),
    );
    value.transport.heartbeats.length = 0;
    value.scheduler.advanceBy(500);
    await value.controller.whenIdle();

    expect(value.transport.heartbeats).toHaveLength(1);
    expect(value.transport.heartbeats[0]).toMatchObject({
      playbackGroupId,
      groupRevision: 3,
      target,
      positionMs: 43_000,
    });
  });

  it("coalesces ordinary leader samples to the latest heartbeat every 500 ms", async () => {
    const value = harness({ userId: leaderUserId, deviceId: leaderDeviceId });
    await connect(value);
    await observe(value);
    const initialAlignment = value.page.applies.at(-1);
    if (initialAlignment === undefined) {
      throw new Error("expected initial leader alignment");
    }
    await reportApplyResult(value, initialAlignment, playing);
    value.transport.heartbeats.length = 0;
    await observe(value, { ...playing, positionMs: 43_000 });
    await observe(value, { ...playing, positionMs: 44_000 });
    await observe(value, { ...playing, positionMs: 45_000 });

    value.scheduler.advanceBy(499);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toHaveLength(0);

    value.scheduler.advanceBy(1);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toHaveLength(1);
    expect(value.transport.heartbeats[0]?.positionMs).toBe(45_500);
  });

  it("uses a two-second heartbeat cadence while the media page is hidden", async () => {
    const value = harness({ userId: leaderUserId, deviceId: leaderDeviceId });
    await connect(value);
    await observe(value);
    const initialAlignment = value.page.applies.at(-1);
    if (initialAlignment === undefined) {
      throw new Error("expected initial leader alignment");
    }
    await reportApplyResult(value, initialAlignment, playing);
    value.transport.heartbeats.length = 0;

    await value.controller.handleMediaObserved(
      10,
      0,
      MediaObservedMessageSchema.parse({
        type: "syncaction.media.observed",
        event: "VISIBILITY_CHANGED",
        context: {
          roomId,
          logicalTabId,
          documentRevision: target.documentRevision,
          frameKey: target.frameKey,
        },
        target,
        observed: playing,
        visibilityState: "hidden",
        applyToken: null,
        resultCode: null,
      }),
    );
    value.scheduler.advanceBy(1_999);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toHaveLength(0);
    value.scheduler.advanceBy(1);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toHaveLength(1);

    value.transport.heartbeats.length = 0;
    await value.controller.handleMediaObserved(
      10,
      0,
      MediaObservedMessageSchema.parse({
        type: "syncaction.media.observed",
        event: "VISIBILITY_CHANGED",
        context: {
          roomId,
          logicalTabId,
          documentRevision: target.documentRevision,
          frameKey: target.frameKey,
        },
        target,
        observed: playing,
        visibilityState: "visible",
        applyToken: null,
        resultCode: null,
      }),
    );
    value.scheduler.advanceBy(499);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toHaveLength(0);
    value.scheduler.advanceBy(1);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toHaveLength(1);
  });

  it("publishes discrete leader events immediately without waiting for the sample timer", async () => {
    const value = harness({ userId: leaderUserId, deviceId: leaderDeviceId });
    await connect(value);
    await observe(value);
    const restoration = value.page.applies.at(-1);
    if (restoration === undefined) {
      throw new Error("expected initial leader restoration");
    }
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(playing, {
        event: "APPLY_RESULT",
        applyToken: restoration.applyToken,
      }),
    );
    value.transport.heartbeats.length = 0;

    await observe(
      value,
      { ...playing, positionMs: 47_000, paused: true },
      { event: "STATE_CHANGED" },
    );

    expect(value.transport.heartbeats).toHaveLength(1);
    expect(value.transport.heartbeats[0]).toMatchObject({
      positionMs: 47_000,
      paused: true,
    });
  });

  it("turns one follower gesture into one proposal and immediately restores authority with tokens", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;
    value.transport.commands.length = 0;

    const gesture = {
      ...playing,
      positionMs: 48_000,
      paused: true,
      observedAtClientMs: nowMs + 10,
    };
    await observe(value, gesture, { event: "STATE_CHANGED" });

    expect(value.transport.commands).toHaveLength(1);
    expect(value.transport.commands[0]).toMatchObject({
      type: "proposal.create",
      playbackGroupId,
      expectedGroupRevision: 3,
      action: { type: "PAUSE" },
    });
    expect(value.page.applies.some((entry) => entry.action.type === "PLAY")).toBe(true);
    expect(new Set(value.page.applies.map((entry) => entry.applyToken)).size).toBe(
      value.page.applies.length,
    );
    expect(value.page.applies.every((entry) => /^[0-9a-f-]{36}$/u.test(entry.applyToken))).toBe(
      true,
    );
    const controllerApply = value.page.applies.find((entry) => entry.action.type === "PLAY")!;
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(gesture, {
        event: "STATE_CHANGED",
        applyToken: controllerApply.applyToken,
      }),
    );
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(playing, {
        event: "APPLY_RESULT",
        applyToken: controllerApply.applyToken,
        resultCode: null,
      }),
    );
    expect(value.transport.commands).toHaveLength(1);
  });

  it("proposes an explicit sub-300 ms seek and immediately restores authority", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;
    value.transport.commands.length = 0;

    await observe(
      value,
      {
        ...playing,
        positionMs: 42_150,
        observedAtClientMs: nowMs + 10,
      },
      { event: "STATE_CHANGED", trigger: "SEEKED" },
    );

    expect(value.transport.commands).toEqual([
      expect.objectContaining({
        type: "proposal.create",
        action: { type: "SEEK", positionMs: 42_150 },
      }),
    ]);
    expect(value.page.applies).toEqual([
      expect.objectContaining({
        action: { type: "SEEK", positionMs: 42_000 },
      }),
    ]);
  });

  it("keeps an ordinary sub-300 ms observation below the gesture threshold", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;
    value.transport.commands.length = 0;

    await observe(value, { ...playing, positionMs: 42_150 }, { event: "STATE_CHANGED" });

    expect(value.transport.commands).toHaveLength(0);
    expect(value.page.applies).toHaveLength(0);
  });

  it("coordinates an unapproved and approved target switch through exact existing bindings", async () => {
    const value = harness();
    addSecondSharedTab(value);
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;
    value.page.locks.length = 0;
    value.transport.commands.length = 0;
    value.navigation.activated.length = 0;

    await value.controller.handleActiveTabChanged(20);
    const unapprovedSecondState = {
      ...playing,
      positionMs: 75_000,
      paused: false,
      playbackRate: 0.75,
    };
    await value.controller.handleMediaObserved(
      20,
      0,
      observedMessage(unapprovedSecondState, {
        event: "TARGET_CHANGED",
        context: {
          roomId,
          logicalTabId: secondLogicalTabId,
          documentRevision: secondTarget.documentRevision,
          frameKey: "top",
        },
        target: secondTarget,
      }),
    );

    expect(value.transport.commands).toEqual([
      expect.objectContaining({
        type: "proposal.create",
        playbackGroupId,
        action: {
          type: "SWITCH_TARGET",
          target: secondTarget,
          observed: unapprovedSecondState,
        },
      }),
    ]);
    const pauseSecond = value.page.applies.find(
      ({ target: applyTarget, action }) =>
        sameTestTarget(applyTarget, secondTarget) && action.type === "PAUSE",
    );
    expect(pauseSecond).toBeDefined();
    expect(value.page.locks.at(-1)).toMatchObject({
      target: secondTarget,
      locked: true,
    });
    expect(value.navigation.activated).toEqual([10]);

    await value.controller.handleMediaObserved(
      20,
      0,
      observedMessage(
        { ...unapprovedSecondState, paused: true },
        {
          event: "APPLY_RESULT",
          context: {
            roomId,
            logicalTabId: secondLogicalTabId,
            documentRevision: secondTarget.documentRevision,
            frameKey: "top",
          },
          target: secondTarget,
          applyToken: pauseSecond!.applyToken,
        },
      ),
    );
    await value.controller.handleActiveTabChanged(10);
    await observe(value);
    value.page.applies.length = 0;
    value.transport.heartbeats.length = 0;
    value.page.observeErrorOnce = new Error("target page not ready");
    value.page.lockEnableErrorOnce = new Error("target page not ready");

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            target: secondTarget,
            observed: {
              ...playing,
              positionMs: 80_000,
              paused: false,
              playbackRate: 1,
            },
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    expect(value.navigation.activated).toEqual([10, 20]);
    expect(value.page.applies).toHaveLength(0);
    expect(value.transport.heartbeats).toHaveLength(0);

    await value.controller.handleActiveTabChanged(20);
    await value.controller.handleMediaObserved(
      20,
      0,
      observedMessage(
        {
          ...unapprovedSecondState,
          paused: true,
        },
        {
          context: {
            roomId,
            logicalTabId: secondLogicalTabId,
            documentRevision: secondTarget.documentRevision,
            frameKey: "top",
          },
          target: secondTarget,
        },
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.applies.map(({ action }) => action)).toEqual([
      { type: "SEEK", positionMs: 80_000 },
      { type: "SET_RATE", playbackRate: 1 },
      { type: "PLAY" },
    ]);
    expect(value.page.locks.at(-1)).toMatchObject({
      target: secondTarget,
      locked: true,
    });
    expect(value.replicaRecord.bindings.map(({ tabId }) => tabId).sort()).toEqual([10, 20]);
  });

  it("degrades an approved target switch when no exact binding exists", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.navigation.activated.length = 0;
    value.page.observations.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            target: secondTarget,
            observed: {
              ...playing,
              positionMs: 80_000,
            },
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "MEDIA_TARGET_UNBOUND",
      localMembership: null,
    });
    expect(value.navigation.activated).toEqual([]);
    expect(value.page.observations).toEqual([]);
    expect(value.replicaRecord.bindings.map(({ tabId }) => tabId)).toEqual([10]);
  });

  it("selects and force-aligns an approved second target in the same document", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;
    value.page.observations.length = 0;
    value.transport.commands.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            target: sameDocumentSecondTarget,
            observed: {
              ...playing,
              positionMs: 80_000,
              playbackRate: 1.25,
            },
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    expect(value.navigation.activated).toEqual([]);
    expect(value.page.observations.at(-1)).toMatchObject({
      tabId: 10,
      frameId: 0,
      target: sameDocumentSecondTarget,
    });
    value.page.observations.length = 0;
    await value.controller.handleActiveTabChanged(10);
    expect(value.page.observations.at(-1)).toMatchObject({
      tabId: 10,
      frameId: 0,
      target: sameDocumentSecondTarget,
    });

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          positionMs: 75_000,
          paused: true,
          playbackRate: 0.75,
        },
        {
          event: "TARGET_CHANGED",
          target: sameDocumentSecondTarget,
        },
      ),
    );
    await value.controller.whenIdle();

    expect(
      value.transport.commands.filter((command) => command.type === "proposal.create"),
    ).toHaveLength(0);
    expect(value.page.applies.map(({ action }) => action)).toEqual([
      { type: "SEEK", positionMs: 80_000 },
      { type: "SET_RATE", playbackRate: 1.25 },
      { type: "PLAY" },
    ]);
    expect(
      value.page.applies.every(({ target: applyTarget }) =>
        sameTestTarget(applyTarget, sameDocumentSecondTarget),
      ),
    ).toBe(true);
  });

  it("selects the exact authoritative target on initial follower membership", async () => {
    const value = harness();
    await value.controller.setSynchronized(true);
    await value.controller.handleActiveTabChanged(10);
    await observe(value);
    value.page.applies.length = 0;
    value.page.observations.length = 0;
    value.navigation.activated.length = 0;

    value.transport.emit(
      snapshot([
        group({
          target: sameDocumentSecondTarget,
          observed: {
            ...playing,
            positionMs: 80_000,
            playbackRate: 1.25,
          },
        }),
      ]),
    );
    await value.controller.whenIdle();

    expect(value.navigation.activated).toEqual([]);
    expect(value.page.observations.at(-1)).toMatchObject({
      tabId: 10,
      frameId: 0,
      target: sameDocumentSecondTarget,
    });

    await observe(value);
    expect(value.page.applies).toHaveLength(0);

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          positionMs: 75_000,
          paused: true,
          playbackRate: 0.75,
        },
        {
          event: "TARGET_CHANGED",
          target: sameDocumentSecondTarget,
        },
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.applies.map(({ action }) => action)).toEqual([
      { type: "SEEK", positionMs: 80_000 },
      { type: "SET_RATE", playbackRate: 1.25 },
      { type: "PLAY" },
    ]);
  });

  it("selects and restores the exact authoritative target on initial leader membership", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await value.controller.setSynchronized(true);
    await value.controller.handleActiveTabChanged(10);
    await observe(value);
    value.page.applies.length = 0;
    value.page.observations.length = 0;
    value.transport.heartbeats.length = 0;

    value.transport.emit(
      snapshot([
        group({
          target: sameDocumentSecondTarget,
          observed: {
            ...playing,
            positionMs: 80_000,
            playbackRate: 1.25,
          },
        }),
      ]),
    );
    await value.controller.whenIdle();

    expect(value.page.observations.at(-1)).toMatchObject({
      target: sameDocumentSecondTarget,
    });
    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            target: sameDocumentSecondTarget,
            observed: {
              ...playing,
              positionMs: 80_000,
              playbackRate: 1.25,
            },
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    await observe(value);
    expect(value.page.applies).toHaveLength(0);
    expect(value.transport.heartbeats).toHaveLength(0);

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          positionMs: 75_000,
          paused: true,
          playbackRate: 0.75,
        },
        {
          event: "TARGET_CHANGED",
          target: sameDocumentSecondTarget,
        },
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.applies.map(({ action }) => action)).toEqual([
      { type: "SEEK", positionMs: 80_000 },
      { type: "SET_RATE", playbackRate: 1.25 },
      { type: "PLAY" },
    ]);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("clears old active-tab projection and ignores its later target gesture", async () => {
    const value = harness();
    addSecondSharedTab(value);
    await connect(value);
    await observe(value);
    expect(value.controller.getStatus().localObservation?.target).toEqual(target);

    await value.controller.handleActiveTabChanged(20);
    expect(value.controller.getStatus().localObservation).toBeNull();
    value.transport.commands.length = 0;
    value.navigation.activated.length = 0;

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          positionMs: 75_000,
        },
        {
          event: "TARGET_CHANGED",
          target: sameDocumentSecondTarget,
        },
      ),
    );
    await value.controller.whenIdle();

    expect(value.controller.getStatus().localObservation).toBeNull();
    expect(
      value.transport.commands.filter((command) => command.type === "proposal.create"),
    ).toHaveLength(0);
    expect(value.navigation.activated).toHaveLength(0);
  });

  it("stops heartbeating the prior active tab until the new active page is observed", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    addSecondSharedTab(value);
    await connect(value);
    await observe(value);

    await value.controller.handleActiveTabChanged(20);
    value.scheduler.advanceBy(500);
    await value.controller.whenIdle();

    expect(value.controller.getStatus().localObservation).toBeNull();
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("uses a non-active tagged apply only for exact echo cleanup", async () => {
    const value = harness();
    addSecondSharedTab(value);
    await connect(value);
    await observe(value);
    await value.controller.alignOnce(playbackGroupId);
    const controllerApply = value.page.applies.at(-1);
    if (controllerApply === undefined) {
      throw new Error("expected controller apply");
    }
    await value.controller.handleActiveTabChanged(20);
    value.transport.commands.length = 0;

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(playing, {
        event: "APPLY_RESULT",
        applyToken: controllerApply.applyToken,
      }),
    );
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        { ...playing, positionMs: 42_150 },
        {
          event: "STATE_CHANGED",
          trigger: "SEEKED",
          applyToken: controllerApply.applyToken,
        },
      ),
    );

    expect(value.controller.getStatus().localObservation).toBeNull();
    expect(
      value.transport.commands.filter((command) => command.type === "proposal.create"),
    ).toHaveLength(0);
  });

  it("degrades and clears state for an active no-media observation before gesture enqueue", async () => {
    const value = harness();
    await connect(value);
    await observe(value);

    await value.controller.handleMediaObserved(10, 0, {
      type: "syncaction.media.observed",
      event: "UNSUPPORTED",
      context: {
        roomId,
        logicalTabId,
        documentRevision: target.documentRevision,
        frameKey: target.frameKey,
      },
      target: null,
      observed: null,
      applyToken: null,
      resultCode: "MEDIA_NOT_FOUND",
    });

    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "MEDIA_NOT_FOUND",
      localObservation: null,
    });
  });

  it("applies an approved authoritative snapshot to every local follower controller", async () => {
    const first = harness();
    const second = harness({
      userId: secondFollowerUserId,
      deviceId: secondFollowerDeviceId,
      sessionId: "018f8f8e-4b5c-7d6e-8f90-123456789a10",
    });
    await connect(first);
    await connect(second);
    await observe(first);
    await second.controller.handleActiveTabChanged(10);
    await second.controller.handleMediaObserved(10, 0, observedMessage(playing));
    await Promise.all([first.controller.whenIdle(), second.controller.whenIdle()]);
    first.page.applies.length = 0;
    second.page.applies.length = 0;

    const approved = group({
      groupRevision: 4,
      observed: { ...playing, positionMs: 80_000 },
      observedAtServerMs: nowMs,
      updatedAtServerMs: nowMs + 1,
    });
    first.transport.emit(snapshot([approved], 2));
    second.transport.emit(snapshot([approved], 2));
    await Promise.all([first.controller.whenIdle(), second.controller.whenIdle()]);

    for (const page of [first.page, second.page]) {
      expect(page.applies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: { type: "SEEK", positionMs: 80_000 },
          }),
        ]),
      );
    }
  });

  it("applies an approved sub-300 ms seek but ignores a proposal-only revision", async () => {
    for (const identity of [
      { userId: followerUserId, deviceId: followerDeviceId },
      { userId: leaderUserId, deviceId: leaderDeviceId },
    ]) {
      const value = harness(identity);
      await connect(value);
      await observe(value);
      value.page.applies.length = 0;

      const approvedSmallSeek = group({
        groupRevision: 4,
        observed: { ...playing, positionMs: 42_150 },
        observedAtServerMs: nowMs,
        updatedAtServerMs: nowMs + 1,
      });
      value.transport.emit(snapshot([approvedSmallSeek], 2));
      await value.controller.whenIdle();

      expect(value.page.applies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: { type: "SEEK", positionMs: 42_150 },
          }),
        ]),
      );

      value.page.applies.length = 0;
      value.transport.emit(
        snapshot(
          [
            group({
              groupRevision: 5,
              observed: approvedSmallSeek.observed,
              observedAtServerMs: approvedSmallSeek.observedAtServerMs,
              proposals: [
                {
                  proposalId: "00000000-0000-4000-8000-000000000778",
                  proposedByUserId: secondFollowerUserId,
                  proposedByDeviceId: secondFollowerDeviceId,
                  baseGroupRevision: 5,
                  action: { type: "PAUSE" },
                  createdAtServerMs: nowMs + 1,
                  expiresAtServerMs: nowMs + 30_001,
                },
              ],
              updatedAtServerMs: nowMs + 2,
            }),
          ],
          3,
        ),
      );
      await value.controller.whenIdle();

      expect(value.page.applies).toHaveLength(0);
    }
  });

  it("aligns once without joining or changing the local paused state", async () => {
    const ungrouped = group({
      members: [member(leaderUserId, leaderDeviceId)],
    });
    const value = harness();
    await connect(value, snapshot([ungrouped]));
    await observe(value, { ...playing, positionMs: 10_000, paused: true });
    value.page.applies.length = 0;

    await value.controller.alignOnce(playbackGroupId);

    expect(value.page.applies).toHaveLength(1);
    expect(value.page.applies[0]?.action).toEqual({ type: "SEEK", positionMs: 42_000 });
    expect(value.transport.commands).toHaveLength(0);
    expect(value.controller.getStatus().localMembership).toBeNull();
  });

  it("starts continuous correction only after an authoritative join snapshot", async () => {
    const ungrouped = group({
      members: [member(leaderUserId, leaderDeviceId)],
    });
    const value = harness();
    await connect(value, snapshot([ungrouped]));
    await observe(value, { ...playing, positionMs: 10_000 });
    value.page.applies.length = 0;

    await value.controller.joinGroup(playbackGroupId);
    expect(value.transport.commands.at(-1)).toMatchObject({
      type: "group.join",
      expectedGroupRevision: 3,
    });
    expect(value.page.applies).toHaveLength(0);

    value.transport.emit(snapshot([group({ groupRevision: 4 })], 2));
    await value.controller.whenIdle();
    expect(value.page.applies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: { type: "SEEK", positionMs: 42_000 },
        }),
      ]),
    );
  });

  it("uses the pure three-band correction plan and restores the exact rate after three seconds", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            observed: { ...playing, positionMs: 42_200 },
            observedAtServerMs: nowMs + 200,
            updatedAtServerMs: nowMs + 200,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.applies).toHaveLength(0);

    value.transport.emit(
      snapshot(
        [
          group({
            observed: { ...playing, positionMs: 42_800 },
            observedAtServerMs: nowMs + 800,
            updatedAtServerMs: nowMs + 800,
          }),
        ],
        3,
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.applies.at(-1)?.action).toEqual({
      type: "SET_RATE_TEMPORARY",
      playbackRate: 1.05,
      restoreRate: 1,
      durationMs: 3_000,
    });

    value.scheduler.advanceBy(2_999);
    await value.controller.whenIdle();
    expect(value.page.applies.at(-1)?.action).toEqual({
      type: "SET_RATE_TEMPORARY",
      playbackRate: 1.05,
      restoreRate: 1,
      durationMs: 3_000,
    });
    value.scheduler.advanceBy(1);
    await value.controller.whenIdle();
    expect(value.page.applies.at(-1)?.action).toEqual({
      type: "SET_RATE",
      playbackRate: 1,
    });

    await observe(value, {
      ...playing,
      observedAtClientMs: value.scheduler.now,
      positionMs: 42_000,
    });
    value.page.applies.length = 0;
    value.transport.emit(
      snapshot(
        [
          group({
            observed: {
              ...playing,
              observedAtClientMs: value.scheduler.now,
              positionMs: 44_000,
            },
            observedAtServerMs: value.scheduler.now,
            updatedAtServerMs: value.scheduler.now,
          }),
        ],
        4,
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.applies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: { type: "SEEK", positionMs: 44_000 },
        }),
      ]),
    );
  });

  it("keeps one three-second rate correction across ordinary heartbeat snapshots", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            observed: {
              ...playing,
              observedAtClientMs: nowMs + 200,
              positionMs: 42_200,
            },
            observedAtServerMs: nowMs + 200,
            updatedAtServerMs: nowMs + 200,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.applies).toHaveLength(0);

    const emitRateCorrectionSnapshot = async (roomMediaRevision: number): Promise<void> => {
      const authoritativeAtMs = value.scheduler.now + 800;
      value.transport.emit(
        snapshot(
          [
            group({
              observed: {
                ...playing,
                observedAtClientMs: authoritativeAtMs,
                positionMs: 42_800 + (value.scheduler.now - nowMs),
              },
              observedAtServerMs: authoritativeAtMs,
              updatedAtServerMs: authoritativeAtMs,
            }),
          ],
          roomMediaRevision,
        ),
      );
      await value.controller.whenIdle();
    };

    await emitRateCorrectionSnapshot(3);
    expect(value.page.applies.map(({ action }) => action)).toEqual([
      {
        type: "SET_RATE_TEMPORARY",
        playbackRate: 1.05,
        restoreRate: 1,
        durationMs: 3_000,
      },
    ]);

    for (let revision = 4; revision <= 8; revision += 1) {
      value.scheduler.advanceBy(500);
      await emitRateCorrectionSnapshot(revision);
    }
    expect(value.scheduler.now).toBe(nowMs + 2_500);
    expect(value.page.applies.map(({ action }) => action)).toEqual([
      {
        type: "SET_RATE_TEMPORARY",
        playbackRate: 1.05,
        restoreRate: 1,
        durationMs: 3_000,
      },
    ]);

    value.scheduler.advanceBy(499);
    await value.controller.whenIdle();
    expect(value.page.applies.map(({ action }) => action)).toEqual([
      {
        type: "SET_RATE_TEMPORARY",
        playbackRate: 1.05,
        restoreRate: 1,
        durationMs: 3_000,
      },
    ]);

    value.scheduler.advanceBy(1);
    await value.controller.whenIdle();
    expect(value.page.applies.map(({ action }) => action)).toEqual([
      {
        type: "SET_RATE_TEMPORARY",
        playbackRate: 1.05,
        restoreRate: 1,
        durationMs: 3_000,
      },
      { type: "SET_RATE", playbackRate: 1 },
    ]);
  });

  it("terminates a rate correction when the authoritative playback rate changes", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            observed: { ...playing, positionMs: 42_800 },
            observedAtServerMs: nowMs + 800,
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    const temporary = value.page.applies.at(-1);
    expect(temporary?.action).toEqual({
      type: "SET_RATE_TEMPORARY",
      playbackRate: 1.05,
      restoreRate: 1,
      durationMs: 3_000,
    });
    if (temporary === undefined) {
      throw new Error("expected temporary correction");
    }

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          positionMs: 42_800,
          playbackRate: 1.05,
        },
        {
          event: "APPLY_RESULT",
          applyToken: temporary.applyToken,
        },
      ),
    );
    value.page.applies.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            observed: {
              ...playing,
              positionMs: 42_800,
              playbackRate: 1.25,
            },
            observedAtServerMs: nowMs + 800,
            updatedAtServerMs: nowMs + 2,
          }),
        ],
        3,
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.applies.map(({ action }) => action)).toEqual([
      { type: "SET_RATE", playbackRate: 1 },
      { type: "SET_RATE", playbackRate: 1.25 },
    ]);
    expect(value.page.playbackRate).toBe(1.25);

    value.scheduler.advanceBy(3_000);
    await value.controller.whenIdle();
    expect(value.page.playbackRate).toBe(1.25);
    expect(value.page.applies.at(-1)?.action).toEqual({
      type: "SET_RATE",
      playbackRate: 1.25,
    });
  });

  it("suppresses a controller event when APPLY_RESULT arrives before ratechange", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.transport.emit(
      snapshot(
        [
          group({
            observed: { ...playing, positionMs: 42_800 },
            observedAtServerMs: nowMs + 800,
            updatedAtServerMs: nowMs + 800,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    const correction = value.page.applies.at(-1);
    if (correction === undefined) {
      throw new Error("expected rate correction");
    }
    value.transport.commands.length = 0;
    const correctedObservation = {
      ...playing,
      playbackRate: 1.05,
    };

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(correctedObservation, {
        event: "APPLY_RESULT",
        applyToken: correction.applyToken,
      }),
    );
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(correctedObservation, {
        event: "STATE_CHANGED",
        applyToken: correction.applyToken,
      }),
    );

    expect(
      value.transport.commands.filter((command) => command.type === "proposal.create"),
    ).toHaveLength(0);
  });

  it("suppresses a delayed controller event after a failed APPLY_RESULT", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    await value.controller.alignOnce(playbackGroupId);
    const alignment = value.page.applies.at(-1);
    if (alignment === undefined) {
      throw new Error("expected alignment apply");
    }
    value.transport.commands.length = 0;
    const delayedObservation = {
      ...playing,
      positionMs: 50_000,
    };

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(delayedObservation, {
        event: "APPLY_RESULT",
        applyToken: alignment.applyToken,
        resultCode: "MEDIA_APPLY_FAILED",
      }),
    );
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(delayedObservation, {
        event: "STATE_CHANGED",
        applyToken: alignment.applyToken,
        trigger: "SEEKED",
      }),
    );

    expect(
      value.transport.commands.filter((command) => command.type === "proposal.create"),
    ).toHaveLength(0);
  });

  it("finishes older follower observation work before accepting a newer snapshot", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;
    const routeCheck = deferred<void>();
    const routeCheckEntered = deferred<void>();
    const newerSeekApplied = deferred<void>();
    value.page.onApply = ({ action }) => {
      if (action.type === "SEEK" && action.positionMs === 60_000) {
        newerSeekApplied.resolve();
      }
    };
    value.replicaGates.push(undefined, {
      entered: () => routeCheckEntered.resolve(),
      promise: routeCheck.promise,
    });

    const olderObservation = value.controller.handleMediaObserved(
      10,
      0,
      observedMessage({
        ...playing,
        positionMs: 30_000,
      }),
    );
    await routeCheckEntered.promise;

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            observed: { ...playing, positionMs: 60_000 },
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs,
          }),
        ],
        2,
      ),
    );
    await Promise.race([newerSeekApplied.promise, settleMicrotasks(50)]);
    routeCheck.resolve();
    await olderObservation;
    await value.controller.whenIdle();

    const seeks = value.page.applies
      .map(({ action }) => action)
      .filter(
        (action): action is Extract<MediaPageApplyAction, { type: "SEEK" }> =>
          action.type === "SEEK",
      );
    expect(seeks.at(-1)).toEqual({ type: "SEEK", positionMs: 60_000 });
  });

  it("retries a follower proposal after the prior send fails", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.transport.commands.length = 0;
    value.transport.commandResponder = async () => {
      throw new Error("transport unavailable");
    };
    const pausedGesture = observedMessage({ ...playing, paused: true }, { event: "STATE_CHANGED" });

    await value.controller.handleMediaObserved(10, 0, pausedGesture);
    await value.controller.handleMediaObserved(10, 0, pausedGesture);

    expect(
      value.transport.commands.filter((command) => command.type === "proposal.create"),
    ).toHaveLength(2);
  });

  it("deduplicates an identical pending controller gesture before tail serialization", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.transport.commands.length = 0;
    const firstProposal = deferred<void>();
    let proposalCount = 0;
    value.transport.commandResponder = async (command) => {
      if (command.type === "proposal.create") {
        proposalCount += 1;
        if (proposalCount === 1) {
          await firstProposal.promise;
        }
      }
      return MediaCommandAckSchema.parse({
        type: "media.command.ack",
        protocolVersion: 1,
        commandId: command.commandId,
        roomId,
        roomMediaRevision: 100,
        accepted: true,
        code: null,
        playbackGroupId:
          command.type === "group.create" ? playbackGroupId : command.playbackGroupId,
        groupRevision: command.type === "group.create" ? 1 : command.expectedGroupRevision + 1,
      });
    };
    const pausedGesture = observedMessage(
      { ...playing, paused: true },
      { event: "STATE_CHANGED", trigger: "PAUSED" },
    );

    const first = value.controller.handleMediaObserved(10, 0, pausedGesture);
    await settleMicrotasks(20);
    const duplicate = value.controller.handleMediaObserved(10, 0, pausedGesture);
    const replacement = value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        { ...playing, playbackRate: 1.25 },
        { event: "STATE_CHANGED", trigger: "RATE_CHANGED" },
      ),
    );
    await settleMicrotasks(20);
    expect(
      value.transport.commands.filter((command) => command.type === "proposal.create"),
    ).toHaveLength(1);

    firstProposal.resolve();
    await Promise.all([first, duplicate, replacement]);
    expect(
      value.transport.commands
        .filter((command) => command.type === "proposal.create")
        .map((command) => command.action),
    ).toEqual([{ type: "PAUSE" }, { type: "SET_RATE", playbackRate: 1.25 }]);

    await value.controller.handleMediaObserved(10, 0, pausedGesture);
    expect(
      value.transport.commands
        .filter((command) => command.type === "proposal.create")
        .map((command) => command.action),
    ).toEqual([{ type: "PAUSE" }, { type: "SET_RATE", playbackRate: 1.25 }, { type: "PAUSE" }]);
  });

  it("applies an approved authoritative seek on the leader before heartbeating again", async () => {
    const proposalId = "00000000-0000-4000-8000-000000000777";
    const proposedGroup = group({
      proposals: [
        {
          proposalId,
          proposedByUserId: followerUserId,
          proposedByDeviceId: followerDeviceId,
          baseGroupRevision: 3,
          action: { type: "SEEK", positionMs: 50_000 },
          createdAtServerMs: nowMs,
          expiresAtServerMs: nowMs + 30_000,
        },
      ],
    });
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await connect(value, snapshot([proposedGroup]));
    await observe(value);
    value.page.applies.length = 0;

    await value.controller.decide(playbackGroupId, proposalId, "APPROVE");
    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            observed: { ...playing, positionMs: 50_000 },
            observedAtServerMs: nowMs,
            proposals: [],
            updatedAtServerMs: nowMs,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.applies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: { type: "SEEK", positionMs: 50_000 },
        }),
      ]),
    );
    value.scheduler.advanceBy(500);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toHaveLength(0);

    const authoritativeApply = value.page.applies.find(
      ({ action }) => action.type === "SEEK" && action.positionMs === 50_000,
    );
    if (authoritativeApply === undefined) {
      throw new Error("expected authoritative leader seek");
    }
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          observedAtClientMs: value.scheduler.now,
          positionMs: 50_000,
        },
        {
          event: "APPLY_RESULT",
          applyToken: authoritativeApply.applyToken,
        },
      ),
    );
    await value.controller.whenIdle();
    expect(value.transport.heartbeats.at(-1)).toMatchObject({
      groupRevision: 4,
      positionMs: 50_000,
    });
  });

  it("restores medium leader drift with an exact seek and authoritative rate", async () => {
    const pausedAuthority: MediaObservedState = {
      ...playing,
      positionMs: 42_000,
      paused: true,
      playbackRate: 1,
    };
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await connect(
      value,
      snapshot([
        group({
          status: "PAUSED",
          observed: pausedAuthority,
        }),
      ]),
    );
    await observe(value, pausedAuthority);
    const initialAlignment = value.page.applies.at(-1);
    if (initialAlignment === undefined) {
      throw new Error("expected initial leader alignment");
    }
    await reportApplyResult(value, initialAlignment, pausedAuthority);
    value.page.applies.length = 0;
    value.transport.heartbeats.length = 0;

    value.scheduler.advanceBy(800);
    await value.controller.whenIdle();
    value.transport.heartbeats.length = 0;
    const playingAuthority = {
      ...pausedAuthority,
      paused: false,
    };
    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            status: "PLAYING",
            observed: playingAuthority,
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    const exactSeek = value.page.applies.find(({ action }) => action.type === "SEEK");
    const restoredPositionMs =
      exactSeek?.action.type === "SEEK" ? exactSeek.action.positionMs : 42_000;
    for (const apply of value.page.applies) {
      await reportApplyResult(value, apply, {
        ...playingAuthority,
        observedAtClientMs: value.scheduler.now,
        positionMs: restoredPositionMs,
        paused: apply.action.type !== "PLAY",
        playbackRate: value.page.playbackRate,
      });
    }

    expect(value.page.applies.map(({ action }) => action)).toEqual([
      { type: "SEEK", positionMs: 42_800 },
      { type: "PLAY" },
    ]);
    expect(value.transport.heartbeats).toEqual([
      expect.objectContaining({
        groupRevision: 4,
        positionMs: 42_800,
        paused: false,
        playbackRate: 1,
      }),
    ]);
  });

  it("restores exact authority when a read-only device takes over as leader", async () => {
    const authority: MediaObservedState = {
      ...playing,
      positionMs: 80_000,
      playbackRate: 1.25,
    };
    const inactiveDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789a99";
    const value = harness();
    await connect(
      value,
      snapshot([
        group({
          observed: authority,
          members: [member(leaderUserId, leaderDeviceId), member(followerUserId, inactiveDeviceId)],
        }),
      ]),
    );
    const staleLocal = {
      ...playing,
      positionMs: 75_000,
      paused: true,
      playbackRate: 0.75,
    };
    await observe(value, staleLocal);
    expect(value.page.applies).toHaveLength(0);

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            leaderUserId: followerUserId,
            leaderDeviceId: followerDeviceId,
            observed: authority,
            members: [
              member(leaderUserId, leaderDeviceId),
              member(followerUserId, followerDeviceId),
            ],
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.applies.map(({ action }) => action)).toEqual([
      { type: "SEEK", positionMs: 80_000 },
      { type: "SET_RATE", playbackRate: 1.25 },
      { type: "PLAY" },
    ]);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("restores exact authority when a follower is transferred leadership", async () => {
    const authority: MediaObservedState = {
      ...playing,
      positionMs: 80_000,
      playbackRate: 1.25,
    };
    const value = harness();
    await connect(value, snapshot([group({ observed: authority })]));
    await observe(value, {
      ...playing,
      positionMs: 75_000,
      paused: true,
      playbackRate: 0.75,
    });
    value.page.applies.length = 0;
    value.transport.heartbeats.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            leaderUserId: followerUserId,
            leaderDeviceId: followerDeviceId,
            observed: authority,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.applies.map(({ action }) => action)).toEqual([
      { type: "SEEK", positionMs: 80_000 },
      { type: "SET_RATE", playbackRate: 1.25 },
      { type: "PLAY" },
    ]);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("reseeds the leader heartbeat when only non-media group state changes", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await connect(value);
    await observe(value);
    const initialAlignment = value.page.applies.at(-1);
    if (initialAlignment === undefined) {
      throw new Error("expected initial leader alignment");
    }
    await reportApplyResult(value, initialAlignment, playing);
    value.transport.heartbeats.length = 0;
    value.page.applies.length = 0;

    value.transport.emit(snapshot([group({ groupRevision: 4 })], 2));
    await value.controller.whenIdle();

    expect(value.page.applies).toHaveLength(0);
    value.scheduler.advanceBy(500);
    await value.controller.whenIdle();
    expect(value.transport.heartbeats).toEqual([
      expect.objectContaining({
        groupRevision: 4,
        positionMs: 42_500,
      }),
    ]);
  });

  it("keeps periodic leader heartbeats after buffering and ready snapshots need no page action", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await connect(value);
    await observe(value);
    const initialAlignment = value.page.applies.at(-1);
    if (initialAlignment === undefined) {
      throw new Error("expected initial leader alignment");
    }
    await reportApplyResult(value, initialAlignment, playing);
    value.page.applies.length = 0;
    value.transport.heartbeats.length = 0;

    const buffering = {
      ...playing,
      buffering: true,
    };
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(buffering, {
        event: "STATE_CHANGED",
        trigger: "BUFFERING",
      }),
    );
    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            status: "LOADING",
            observed: buffering,
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(playing, {
        event: "STATE_CHANGED",
        trigger: "READY",
      }),
    );
    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 5,
            status: "PLAYING",
            observed: playing,
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs + 2,
          }),
        ],
        3,
      ),
    );
    await value.controller.whenIdle();

    value.transport.heartbeats.length = 0;
    value.scheduler.advanceBy(500);
    await value.controller.whenIdle();

    expect(value.transport.heartbeats).toEqual([
      expect.objectContaining({
        groupRevision: 5,
        buffering: false,
        playbackRate: 1,
      }),
    ]);
  });

  it("does not retag a stale leader sample across even a sub-ms media change", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await connect(value);
    await observe(value);

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            observed: { ...playing, positionMs: 42_000.5 },
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    const applyCountBeforeRealignment = value.page.applies.length;
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          positionMs: 42_000.5,
        },
        {
          event: "STATE_CHANGED",
          trigger: "READY",
        },
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.applies.length).toBeGreaterThan(applyCountBeforeRealignment);
    expect(value.controller.getStatus().localObservation?.observed.positionMs).toBe(42_000.5);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("reseeds a completed leader after a sub-ms revision change", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await connect(value);
    await observe(value);
    const initialAlignment = value.page.applies.at(-1);
    if (initialAlignment === undefined) {
      throw new Error("expected initial leader alignment");
    }
    await reportApplyResult(value, initialAlignment, playing);
    value.transport.heartbeats.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            observed: { ...playing, positionMs: 42_000.5 },
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();

    value.scheduler.advanceBy(500);
    await value.controller.whenIdle();

    expect(value.transport.heartbeats).toEqual([
      expect.objectContaining({
        groupRevision: 4,
        positionMs: 42_500,
      }),
    ]);
  });

  it("publishes one final observation only after an out-of-order leader authority batch succeeds", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority, local } = await beginLeaderAuthorityBatch(value);
    const [seekApply, rateApply, playApply] = applies;
    const finalObservation = {
      ...authority,
      observedAtClientMs: value.scheduler.now,
    };

    await reportApplyResult(value, playApply, finalObservation);
    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(local);

    await reportApplyResult(value, seekApply, {
      ...local,
      positionMs: 80_000,
    });
    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(local);

    await reportApplyResult(value, rateApply, {
      ...local,
      positionMs: 80_000,
      playbackRate: 1.25,
    });
    expect(value.transport.heartbeats).toEqual([
      expect.objectContaining({
        groupRevision: 4,
        positionMs: 80_000,
        paused: false,
        playbackRate: 1.25,
      }),
    ]);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(finalObservation);

    await value.controller.handleMediaObserved(
      seekApply.tabId,
      seekApply.frameId,
      observedMessage(
        {
          ...local,
          positionMs: 80_000,
        },
        {
          event: "STATE_CHANGED",
          trigger: "SEEKED",
          context: seekApply.context,
          target: seekApply.target,
          applyToken: seekApply.applyToken,
        },
      ),
    );
    await reportApplyResult(value, seekApply, {
      ...local,
      positionMs: 66_000,
    });

    expect(value.transport.heartbeats).toHaveLength(1);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(finalObservation);
  });

  it("expires an incomplete leader authority batch and permits realignment", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, local } = await beginLeaderAuthorityBatch(value);

    await reportApplyResult(value, applies[0], {
      ...local,
      positionMs: 80_000,
    });
    await reportApplyResult(value, applies[1], {
      ...local,
      positionMs: 80_000,
      playbackRate: 1.25,
    });
    value.scheduler.advanceBy(5_000);
    await value.controller.whenIdle();

    expect(value.transport.heartbeats).toHaveLength(0);
    const applyCountBeforeRealignment = value.page.applies.length;
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...local,
          positionMs: 76_000,
        },
        {
          event: "STATE_CHANGED",
          trigger: "READY",
        },
      ),
    );
    await value.controller.whenIdle();

    expect(
      value.page.applies.slice(applyCountBeforeRealignment).map(({ action }) => action),
    ).toEqual([
      { type: "SEEK", positionMs: 86_250 },
      { type: "SET_RATE", playbackRate: 1.25 },
      { type: "PLAY" },
    ]);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("reobserves once when a timed-out batch receives only a late terminal result", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority, local } = await beginLeaderAuthorityBatch(value);
    await reportApplyResult(value, applies[0], {
      ...local,
      positionMs: 80_000,
    });
    await reportApplyResult(value, applies[1], {
      ...local,
      positionMs: 80_000,
      playbackRate: 1.25,
    });
    value.scheduler.advanceBy(5_000);
    await value.controller.whenIdle();
    const observationsBeforeLateResult = value.page.observations.length;

    await reportApplyResult(value, applies[2], authority);

    expect(value.page.observations).toHaveLength(observationsBeforeLateResult + 1);
    expect(value.page.observations.at(-1)).toEqual(
      expect.objectContaining({
        tabId: 10,
        frameId: 0,
        target,
      }),
    );
    expect(value.controller.getStatus().localObservation?.observed).toEqual(local);
    expect(value.controller.getStatus().errorCode).toBe("MEDIA_APPLY_TIMEOUT");
    expect(value.transport.heartbeats).toHaveLength(0);

    await value.controller.handleMediaObserved(
      applies[1].tabId,
      applies[1].frameId,
      observedMessage(authority, {
        event: "STATE_CHANGED",
        trigger: "RATE_CHANGED",
        context: applies[1].context,
        target: applies[1].target,
        applyToken: applies[1].applyToken,
      }),
    );
    await value.controller.whenIdle();
    expect(value.page.observations).toHaveLength(observationsBeforeLateResult + 1);

    const freshAuthority = {
      ...authority,
      observedAtClientMs: value.scheduler.now,
      positionMs: 86_250,
    };
    const applyCountBeforeFreshObservation = value.page.applies.length;
    await observe(value, freshAuthority);
    expect(value.controller.getStatus().errorCode).toBe("MEDIA_APPLY_TIMEOUT");
    const recoveryApply = value.page.applies.at(applyCountBeforeFreshObservation);
    if (recoveryApply === undefined) {
      throw new Error("expected a forced recovery apply");
    }
    expect(recoveryApply.action).toEqual({
      type: "SEEK",
      positionMs: 86_250,
    });
    await reportApplyResult(value, recoveryApply, freshAuthority);

    expect(value.controller.getStatus().errorCode).toBeNull();
    expect(value.transport.heartbeats).toHaveLength(1);
  });

  it("does not reobserve a timed-out batch after an active-tab ABA transition", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority } = await beginLeaderAuthorityBatch(value);
    value.scheduler.advanceBy(5_000);
    await value.controller.whenIdle();
    await value.controller.handleActiveTabChanged(20);
    await value.controller.handleActiveTabChanged(10);
    const observationsAfterTabAba = value.page.observations.length;

    await reportApplyResult(value, applies[2], authority);

    expect(value.page.observations).toHaveLength(observationsAfterTabAba);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("does not reobserve a timed-out batch after a binding ABA transition", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority } = await beginLeaderAuthorityBatch(value);
    value.scheduler.advanceBy(5_000);
    await value.controller.whenIdle();
    const originalBindings = structuredClone(value.replicaRecord.bindings);
    value.replicaRecord.bindings = [];
    const bindingRemoved = value.controller.handleBindingsChanged();
    value.replicaRecord.bindings = originalBindings;
    const bindingRestored = value.controller.handleBindingsChanged();
    await Promise.all([bindingRemoved, bindingRestored]);
    const observationsAfterBindingAba = value.page.observations.length;

    await reportApplyResult(value, applies[2], authority);

    expect(value.page.observations).toHaveLength(observationsAfterBindingAba);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("does not retry a failed recovery observation with another old batch token", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority } = await beginLeaderAuthorityBatch(value);
    value.scheduler.advanceBy(5_000);
    await value.controller.whenIdle();
    value.page.observeErrorOnce = new Error("MEDIA_RECOVERY_OBSERVE_FAILED");
    const observationsBeforeRecovery = value.page.observations.length;

    await reportApplyResult(value, applies[2], authority);
    expect(value.page.observations).toHaveLength(observationsBeforeRecovery + 1);
    expect(value.controller.getStatus().errorCode).toBe("MEDIA_APPLY_TIMEOUT");

    await value.controller.handleMediaObserved(
      applies[1].tabId,
      applies[1].frameId,
      observedMessage(authority, {
        event: "STATE_CHANGED",
        trigger: "RATE_CHANGED",
        context: applies[1].context,
        target: applies[1].target,
        applyToken: applies[1].applyToken,
      }),
    );
    await value.controller.whenIdle();

    expect(value.page.observations).toHaveLength(observationsBeforeRecovery + 1);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("does not let an older failed batch borrow a newer batch recovery state", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies: firstBatchApplies, authority, local } = await beginLeaderAuthorityBatch(value);
    value.scheduler.advanceBy(5_000);
    await value.controller.whenIdle();

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...local,
          observedAtClientMs: value.scheduler.now,
          positionMs: 76_000,
        },
        {
          event: "STATE_CHANGED",
          trigger: "READY",
        },
      ),
    );
    await value.controller.whenIdle();
    value.scheduler.advanceBy(5_000);
    await value.controller.whenIdle();
    const observationsAfterSecondTimeout = value.page.observations.length;

    await reportApplyResult(value, firstBatchApplies[2], authority);

    expect(value.page.observations).toHaveLength(observationsAfterSecondTimeout);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("does not reobserve a timed-out batch after its group revision advances", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority } = await beginLeaderAuthorityBatch(value);
    value.scheduler.advanceBy(5_000);
    await value.controller.whenIdle();
    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 5,
            observed: authority,
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs + 2,
          }),
        ],
        3,
      ),
    );
    await value.controller.whenIdle();
    const observationsAfterRevision = value.page.observations.length;

    await reportApplyResult(value, applies[2], authority);

    expect(value.page.observations).toHaveLength(observationsAfterRevision);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it("expires a leader authority batch when a page apply promise never settles", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await connect(value);
    await observe(value);
    const initialAlignment = value.page.applies.at(-1);
    if (initialAlignment === undefined) {
      throw new Error("expected initial leader alignment");
    }
    await reportApplyResult(value, initialAlignment, playing);
    value.page.applies.length = 0;
    value.transport.heartbeats.length = 0;
    const local: MediaObservedState = {
      ...playing,
      positionMs: 75_000,
      paused: true,
      playbackRate: 0.75,
    };
    await observe(value, local);
    value.page.applies.length = 0;
    value.transport.heartbeats.length = 0;

    const applyStarted = deferred<void>();
    const applyBarrier = deferred<void>();
    value.page.onApply = () => {
      applyStarted.resolve(undefined);
    };
    value.page.applyBarrier = applyBarrier.promise;
    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            observed: {
              ...playing,
              positionMs: 80_000,
              playbackRate: 1.25,
            },
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await applyStarted.promise;
    let controllerSettled = false;
    const controllerIdle = value.controller.whenIdle().then(() => {
      controllerSettled = true;
    });

    value.scheduler.advanceBy(5_000);
    await settleMicrotasks(20);
    const settledAfterDeadline = controllerSettled;
    value.page.applyBarrier = undefined;
    applyBarrier.resolve(undefined);
    await controllerIdle;

    expect(settledAfterDeadline).toBe(true);
    expect(value.transport.heartbeats).toHaveLength(0);
    const applyCountBeforeRealignment = value.page.applies.length;
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...local,
          positionMs: 76_000,
        },
        {
          event: "STATE_CHANGED",
          trigger: "READY",
        },
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.applies.length).toBeGreaterThan(applyCountBeforeRealignment);
  });

  it("quarantines untagged exact-target events until the leader authority batch completes", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority, local } = await beginLeaderAuthorityBatch(value);

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...authority,
          buffering: true,
        },
        {
          event: "STATE_CHANGED",
          trigger: "BUFFERING",
          applyToken: null,
        },
      ),
    );
    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(local);

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(authority, {
        event: "STATE_CHANGED",
        trigger: "READY",
        applyToken: null,
      }),
    );
    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(local);

    await reportApplyResult(value, applies[0], {
      ...local,
      positionMs: 80_000,
    });
    await reportApplyResult(value, applies[1], {
      ...local,
      positionMs: 80_000,
      playbackRate: 1.25,
    });
    await reportApplyResult(value, applies[2], authority);

    expect(value.transport.heartbeats).toEqual([
      expect.objectContaining({
        groupRevision: 4,
        positionMs: 80_000,
        paused: false,
        playbackRate: 1.25,
      }),
    ]);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(authority);
  });

  it("quarantines a late follower apply result during a new leader authority batch", async () => {
    const authority: MediaObservedState = {
      ...playing,
      positionMs: 80_000,
      playbackRate: 1.25,
    };
    const local: MediaObservedState = {
      ...playing,
      positionMs: 75_000,
      paused: true,
      playbackRate: 0.75,
    };
    const value = harness();
    await connect(value, snapshot([group({ observed: authority })]));
    await observe(value, local);
    const delayedFollowerApply = value.page.applies.at(0);
    if (delayedFollowerApply === undefined) {
      throw new Error("expected a pending follower apply");
    }
    value.page.applies.length = 0;
    value.transport.heartbeats.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            leaderUserId: followerUserId,
            leaderDeviceId: followerDeviceId,
            observed: authority,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    const leaderApplies = [...value.page.applies];
    expect(leaderApplies.map(({ action }) => action)).toEqual([
      { type: "SEEK", positionMs: 80_000 },
      { type: "SET_RATE", playbackRate: 1.25 },
      { type: "PLAY" },
    ]);
    const [seekApply, rateApply, playApply] = leaderApplies;
    if (seekApply === undefined || rateApply === undefined || playApply === undefined) {
      throw new Error("expected a complete leader authority batch");
    }

    await reportApplyResult(value, delayedFollowerApply, {
      ...local,
      positionMs: 76_000,
    });

    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(local);

    await reportApplyResult(value, seekApply, {
      ...local,
      positionMs: 80_000,
    });
    await reportApplyResult(value, rateApply, {
      ...local,
      positionMs: 80_000,
      playbackRate: 1.25,
    });
    await reportApplyResult(value, playApply, authority);

    expect(value.transport.heartbeats).toEqual([
      expect.objectContaining({
        groupRevision: 4,
        positionMs: 80_000,
        paused: false,
        playbackRate: 1.25,
      }),
    ]);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(authority);
  });

  it("cancels a leader authority batch instead of swallowing an untagged different target", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority } = await beginLeaderAuthorityBatch(value);
    const otherObserved = {
      ...authority,
      positionMs: 12_000,
    };

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(otherObserved, {
        event: "TARGET_CHANGED",
        target: sameDocumentSecondTarget,
      }),
    );
    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation).toEqual({
      target: sameDocumentSecondTarget,
      observed: otherObserved,
    });

    await reportApplyResult(value, applies[0], authority);
    await reportApplyResult(value, applies[1], authority);
    await reportApplyResult(value, applies[2], authority);

    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation).toEqual({
      target: sameDocumentSecondTarget,
      observed: otherObserved,
    });
  });

  it("ignores stale apply tokens after their bounded tracking entry is unavailable", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    await connect(value);
    await observe(value);
    const baseline = value.controller.getStatus().localObservation?.observed;
    value.transport.heartbeats.length = 0;
    const staleApplyToken = "00000000-0000-4000-8000-000000999999";

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          positionMs: 99_999,
        },
        {
          event: "APPLY_RESULT",
          applyToken: staleApplyToken,
        },
      ),
    );
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        {
          ...playing,
          positionMs: 88_888,
        },
        {
          event: "STATE_CHANGED",
          trigger: "SEEKED",
          applyToken: staleApplyToken,
        },
      ),
    );
    await value.controller.whenIdle();

    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(baseline);
  });

  it("retags an incomplete leader authority batch across a timeline-equivalent revision", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority, local } = await beginLeaderAuthorityBatch(value);

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 5,
            observed: authority,
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs + 2,
          }),
        ],
        3,
      ),
    );
    await value.controller.whenIdle();
    value.scheduler.advanceBy(500);
    await value.controller.whenIdle();

    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(local);

    const finalObservation = {
      ...authority,
      observedAtClientMs: value.scheduler.now,
      positionMs: 80_625,
    };
    await reportApplyResult(value, applies[0], {
      ...local,
      observedAtClientMs: value.scheduler.now,
      positionMs: 80_000,
    });
    await reportApplyResult(value, applies[1], {
      ...local,
      observedAtClientMs: value.scheduler.now,
      positionMs: 80_000,
      playbackRate: 1.25,
    });
    await reportApplyResult(value, applies[2], finalObservation);

    expect(value.transport.heartbeats).toEqual([
      expect.objectContaining({
        groupRevision: 5,
        positionMs: 80_625,
      }),
    ]);
    expect(value.controller.getStatus().localObservation?.observed).toEqual(finalObservation);
  });

  it("degrades and waits for realignment when any leader authority apply fails", async () => {
    const value = harness({
      userId: leaderUserId,
      deviceId: leaderDeviceId,
    });
    const { applies, authority, local } = await beginLeaderAuthorityBatch(value);

    await reportApplyResult(
      value,
      applies[1],
      {
        ...local,
        positionMs: 80_000,
      },
      "AUTOPLAY_BLOCKED",
    );
    await reportApplyResult(value, applies[0], {
      ...local,
      positionMs: 80_000,
    });
    await reportApplyResult(value, applies[2], authority);

    expect(value.transport.heartbeats).toHaveLength(0);
    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "AUTOPLAY_BLOCKED",
      localObservation: {
        observed: local,
      },
    });

    const priorApplyCount = value.page.applies.length;
    await observe(value, local);
    expect(value.page.applies.length).toBeGreaterThan(priorApplyCount);
    expect(value.transport.heartbeats).toHaveLength(0);
  });

  it.each([
    "tab change",
    "disconnect",
    "permission boundary",
    "binding refresh",
    "role change",
    "target change",
    "new authority",
  ] as const)(
    "cancels a leader authority batch on %s and suppresses its late token",
    async (kind) => {
      const value = harness({
        userId: leaderUserId,
        deviceId: leaderDeviceId,
      });
      if (kind === "tab change" || kind === "target change") {
        addSecondSharedTab(value);
      }
      const { applies, authority } = await beginLeaderAuthorityBatch(value);
      const lateObservation: MediaObservedState = {
        ...authority,
        positionMs: 99_999,
      };

      if (kind === "tab change") {
        await value.controller.handleActiveTabChanged(20);
        await value.controller.handleActiveTabChanged(10);
      } else if (kind === "disconnect") {
        await value.controller.setSynchronized(false);
        await value.controller.setSynchronized(true);
        value.transport.emit(
          snapshot(
            [
              group({
                groupRevision: 4,
                observed: authority,
                observedAtServerMs: nowMs,
                updatedAtServerMs: nowMs + 1,
              }),
            ],
            3,
          ),
        );
        await value.controller.whenIdle();
      } else if (kind === "permission boundary") {
        await value.controller.handlePermissionBoundaryChanged();
      } else if (kind === "binding refresh") {
        await value.controller.handleBindingsChanged();
      } else if (kind === "role change") {
        value.transport.emit(
          snapshot(
            [
              group({
                groupRevision: 5,
                leaderUserId: followerUserId,
                leaderDeviceId: followerDeviceId,
                observed: authority,
                observedAtServerMs: nowMs,
                updatedAtServerMs: nowMs + 2,
              }),
            ],
            3,
          ),
        );
        await value.controller.whenIdle();
      } else if (kind === "target change") {
        value.transport.emit(
          snapshot(
            [
              group({
                groupRevision: 5,
                target: secondTarget,
                observed: authority,
                observedAtServerMs: nowMs,
                updatedAtServerMs: nowMs + 2,
              }),
            ],
            3,
          ),
        );
        await value.controller.whenIdle();
      } else {
        value.transport.emit(
          snapshot(
            [
              group({
                groupRevision: 5,
                observed: {
                  ...authority,
                  positionMs: 90_000,
                },
                observedAtServerMs: nowMs,
                updatedAtServerMs: nowMs + 2,
              }),
            ],
            3,
          ),
        );
        await value.controller.whenIdle();
      }

      value.transport.heartbeats.length = 0;
      await reportApplyResult(value, applies[2], lateObservation);

      expect(value.transport.heartbeats).toHaveLength(0);
      expect(value.controller.getStatus().localObservation?.observed.positionMs).not.toBe(99_999);
    },
  );

  it("pauses a follower before unlocking when leader grace expires", async () => {
    const value = harness();
    await connect(
      value,
      snapshot([
        group({
          status: "LEADER_GRACE",
          leaderGraceExpiresAtServerMs: nowMs + 10_000,
          members: [
            member(leaderUserId, leaderDeviceId, { online: false }),
            member(followerUserId, followerDeviceId),
            member(secondFollowerUserId, secondFollowerDeviceId),
          ],
        }),
      ]),
    );
    await observe(value);
    value.page.applies.length = 0;
    let lockStateWhenPaused: boolean | null = null;
    value.page.onApply = ({ action }) => {
      if (action.type === "PAUSE") {
        lockStateWhenPaused = value.page.locks.at(-1)?.locked ?? null;
      }
    };

    value.transport.emit(snapshot([], 2));
    await value.controller.whenIdle();

    expect(value.page.applies.map(({ action }) => action)).toEqual([{ type: "PAUSE" }]);
    expect(lockStateWhenPaused).toBe(true);
    expect(value.page.locks.at(-1)).toMatchObject({
      target,
      locked: false,
    });
  });

  it("restores an active temporary rate before disconnecting or disposing", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;

    value.transport.emit(
      snapshot(
        [
          group({
            observed: { ...playing, positionMs: 42_800 },
            observedAtServerMs: nowMs + 800,
            updatedAtServerMs: nowMs + 800,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.applies.at(-1)?.action).toEqual({
      type: "SET_RATE_TEMPORARY",
      playbackRate: 1.05,
      restoreRate: 1,
      durationMs: 3_000,
    });

    await value.controller.dispose();

    expect(value.page.applies.at(-1)?.action).toEqual({
      type: "SET_RATE",
      playbackRate: 1,
    });
    expect(value.scheduler.taskCount).toBe(0);
  });

  it("restores a temporary rate when permission cleanup races the timer callback", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;
    value.transport.emit(
      snapshot(
        [
          group({
            observed: { ...playing, positionMs: 42_800 },
            observedAtServerMs: nowMs + 800,
            updatedAtServerMs: nowMs + 800,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.applies.at(-1)?.action).toEqual({
      type: "SET_RATE_TEMPORARY",
      playbackRate: 1.05,
      restoreRate: 1,
      durationMs: 3_000,
    });

    value.scheduler.advanceBy(3_000);
    await value.controller.handlePermissionBoundaryChanged();
    await value.controller.whenIdle();

    expect(value.page.applies.at(-1)?.action).toEqual({
      type: "SET_RATE",
      playbackRate: 1,
    });
    expect(value.page.locks.at(-1)?.locked).toBe(false);
  });

  it("restores the page-owned temporary rate after the binding becomes invalid", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    const originalBindings = structuredClone(value.replicaRecord.bindings);
    value.page.applies.length = 0;
    value.transport.emit(
      snapshot(
        [
          group({
            observed: { ...playing, positionMs: 42_800 },
            observedAtServerMs: nowMs + 800,
            updatedAtServerMs: nowMs + 800,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.playbackRate).toBe(1.05);

    value.replicaRecord.bindings = [];
    await value.controller.handleBindingsChanged();

    expect(value.page.applies.filter(({ action }) => action.type === "SET_RATE")).toHaveLength(0);
    expect(value.page.locks.at(-1)).toMatchObject({
      locked: false,
      target,
    });
    expect(value.page.playbackRate).toBe(1);
    expect(value.controller.getStatus()).toMatchObject({
      localObservation: null,
      localMembership: null,
      recommendedPlaybackGroupId: null,
    });

    value.replicaRecord.bindings = originalBindings;
    await value.controller.handleBindingsChanged();
    expect(value.controller.getStatus().localMembership).toBeNull();

    value.transport.emit(snapshot([group()], 3));
    await value.controller.whenIdle();
    expect(value.controller.getStatus().localMembership).toMatchObject({
      playbackGroupId,
      role: "FOLLOWER",
      activeDevice: true,
    });
  });

  it("invalidates membership when its target binding disappears before page observation", async () => {
    const value = harness();
    await connect(value);
    expect(value.controller.getStatus().localMembership?.role).toBe("FOLLOWER");

    value.replicaRecord.bindings = [];
    await value.controller.handleBindingsChanged();

    expect(value.controller.getStatus()).toMatchObject({
      localObservation: null,
      localMembership: null,
      recommendedPlaybackGroupId: null,
      errorCode: "STALE_MEDIA_CONTEXT",
    });
  });

  it("clears a media capability error when the exact page capability recovers", async () => {
    const value = harness();
    await connect(value);
    await value.controller.handlePageReady(10, 1, "frame:child");

    await value.controller.handlePageCapability({
      tabId: 10,
      frameId: 1,
      message: {
        type: "syncaction.page.capability",
        capability: "MEDIA",
        state: "DEGRADED",
        errorCode: "MEDIA_ADAPTER_FAILURE",
      },
    });
    expect(value.controller.getStatus()).toMatchObject({
      state: "ONLINE",
      errorCode: null,
    });

    await value.controller.handlePageCapability({
      tabId: 10,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "MEDIA",
        state: "DEGRADED",
        errorCode: "MEDIA_ADAPTER_FAILURE",
      },
    });
    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "MEDIA_ADAPTER_FAILURE",
    });

    value.transport.emit(snapshot([group()], 2));
    await value.controller.whenIdle();
    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "MEDIA_ADAPTER_FAILURE",
    });

    await value.controller.handlePageCapability({
      tabId: 10,
      frameId: 1,
      message: {
        type: "syncaction.page.capability",
        capability: "MEDIA",
        state: "AVAILABLE",
        errorCode: null,
      },
    });
    await value.controller.handlePageCapability({
      tabId: 10,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "AVAILABLE",
        errorCode: null,
      },
    });
    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "MEDIA_ADAPTER_FAILURE",
    });

    await value.controller.handlePageCapability({
      tabId: 10,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "MEDIA",
        state: "AVAILABLE",
        errorCode: null,
      },
    });
    expect(value.controller.getStatus()).toMatchObject({
      state: "ONLINE",
      errorCode: null,
    });
  });

  it("keeps autoplay rejection visible across snapshots until a page apply succeeds", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.page.applies.length = 0;

    await value.controller.alignOnce(playbackGroupId);
    const rejectedApply = value.page.applies.at(-1);
    if (rejectedApply === undefined) {
      throw new Error("expected alignment apply");
    }
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(playing, {
        event: "APPLY_RESULT",
        applyToken: rejectedApply.applyToken,
        resultCode: "AUTOPLAY_BLOCKED",
      }),
    );
    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "AUTOPLAY_BLOCKED",
    });

    value.transport.emit(snapshot([group()], 2));
    await value.controller.whenIdle();
    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "AUTOPLAY_BLOCKED",
    });

    await value.controller.alignOnce(playbackGroupId);
    const successfulApply = value.page.applies.at(-1);
    if (successfulApply === undefined) {
      throw new Error("expected retry alignment apply");
    }
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(playing, {
        event: "APPLY_RESULT",
        applyToken: successfulApply.applyToken,
        resultCode: null,
      }),
    );
    expect(value.controller.getStatus()).toMatchObject({
      state: "ONLINE",
      errorCode: null,
    });
  });

  it("does not leak a page apply error across exact tab routes and clears it on success", async () => {
    const value = harness();
    addSecondSharedTab(value);
    await connect(value);
    await observe(value);

    await value.controller.alignOnce(playbackGroupId);
    const rejectedApply = value.page.applies.at(-1);
    if (rejectedApply === undefined) {
      throw new Error("expected alignment apply");
    }
    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(playing, {
        event: "APPLY_RESULT",
        applyToken: rejectedApply.applyToken,
        resultCode: "AUTOPLAY_BLOCKED",
      }),
    );
    expect(value.controller.getStatus().errorCode).toBe("AUTOPLAY_BLOCKED");

    await value.controller.handleActiveTabChanged(20);
    expect(value.controller.getStatus()).toMatchObject({
      state: "ONLINE",
      errorCode: null,
    });

    const secondObserved = {
      ...playing,
      positionMs: 75_000,
      paused: true,
    };
    await value.controller.handleMediaObserved(
      20,
      0,
      observedMessage(secondObserved, {
        context: {
          roomId,
          logicalTabId: secondLogicalTabId,
          documentRevision: secondTarget.documentRevision,
          frameKey: "top",
        },
        target: secondTarget,
      }),
    );
    expect(value.controller.getStatus().errorCode).toBeNull();

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 4,
            target: secondTarget,
            observed: {
              ...secondObserved,
              positionMs: 80_000,
              paused: false,
            },
            observedAtServerMs: nowMs,
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    const successfulApply = value.page.applies.find(({ target: applyTarget }) =>
      sameTestTarget(applyTarget, secondTarget),
    );
    if (successfulApply === undefined) {
      throw new Error("expected second-route apply");
    }
    await value.controller.handleMediaObserved(
      20,
      0,
      observedMessage(
        {
          ...secondObserved,
          positionMs: 80_000,
          paused: false,
        },
        {
          event: "APPLY_RESULT",
          context: {
            roomId,
            logicalTabId: secondLogicalTabId,
            documentRevision: secondTarget.documentRevision,
            frameKey: "top",
          },
          target: secondTarget,
          applyToken: successfulApply.applyToken,
          resultCode: null,
        },
      ),
    );
    expect(value.controller.getStatus().errorCode).toBeNull();
  });

  it("clears the cooperative lock, UI state, and correction timer for stale revisions", async () => {
    const value = harness();
    await connect(value);
    await observe(value);
    value.transport.emit(
      snapshot(
        [
          group({
            observed: { ...playing, positionMs: 42_800 },
            updatedAtServerMs: nowMs + 1,
          }),
        ],
        2,
      ),
    );
    await value.controller.whenIdle();
    expect(value.page.locks.at(-1)?.locked).toBe(true);

    value.transport.emit(
      snapshot(
        [
          group({
            groupRevision: 2,
            updatedAtServerMs: nowMs + 2,
          }),
        ],
        3,
      ),
    );
    await value.controller.whenIdle();

    expect(value.page.locks.at(-1)?.locked).toBe(false);
    expect(value.controller.getStatus()).toMatchObject({
      errorCode: "STALE_MEDIA_SNAPSHOT",
      localObservation: null,
      localMembership: null,
    });
    expect(value.scheduler.taskCount).toBe(1);
  });

  it("fails media commands offline without touching the durable replica outbox", async () => {
    const value = harness();
    await connect(value);
    await value.controller.setSynchronized(false);

    await expect(value.controller.joinGroup(playbackGroupId)).rejects.toMatchObject({
      code: "MEDIA_OFFLINE",
    });

    expect(value.transport.commands).toHaveLength(0);
    expect(value.replicaRecord.outbox).toEqual([]);
    expect(value.replicaRecord.pendingConfirmations).toEqual([]);
    expect(value.transport.handler).toBeUndefined();
  });

  it("cancels stale context work when disposed during an observation race", async () => {
    const value = harness();
    let release!: () => void;
    value.page.observeBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await value.controller.setSynchronized(true);
    const active = value.controller.handleActiveTabChanged(10);
    await Promise.resolve();
    const disposed = value.controller.dispose();
    release();

    await Promise.all([active, disposed]);
    await value.controller.whenIdle();

    expect(value.transport.handler).toBeUndefined();
    expect(value.page.applies).toHaveLength(0);
    expect(value.page.locks.every((entry) => !entry.locked)).toBe(true);
    expect(value.scheduler.taskCount).toBe(0);
  });

  it("projects autoplay rejection from an exact controller apply result", async () => {
    const value = harness();
    await connect(value);
    await observe(value, { ...playing, paused: true });
    const playApply = value.page.applies.find((entry) => entry.action.type === "PLAY");
    expect(playApply).toBeDefined();

    await value.controller.handleMediaObserved(
      10,
      0,
      observedMessage(
        { ...playing, paused: true },
        {
          event: "APPLY_RESULT",
          applyToken: playApply!.applyToken,
          resultCode: "AUTOPLAY_BLOCKED",
        },
      ),
    );

    expect(value.controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "AUTOPLAY_BLOCKED",
    });
  });

  it("ignores duplicate snapshots and rejects stale or mismatched command acknowledgements", async () => {
    const value = harness();
    await connect(value, snapshot([group()], 5));
    await observe(value);
    value.page.applies.length = 0;

    value.transport.emit(snapshot([group()], 5));
    await value.controller.whenIdle();
    expect(value.page.applies).toHaveLength(0);

    value.transport.commandResponder = (command) =>
      MediaCommandAckSchema.parse({
        type: "media.command.ack",
        protocolVersion: 1,
        commandId: "00000000-0000-4000-8000-000000009999",
        roomId,
        roomMediaRevision: 6,
        accepted: true,
        code: null,
        playbackGroupId,
        groupRevision: command.type === "group.create" ? 1 : command.expectedGroupRevision + 1,
      });
    await expect(value.controller.leaveGroup(playbackGroupId)).rejects.toMatchObject({
      code: "STALE_MEDIA_ACK",
    });

    value.transport.commandResponder = (command) =>
      MediaCommandAckSchema.parse({
        type: "media.command.ack",
        protocolVersion: 1,
        commandId: command.commandId,
        roomId,
        roomMediaRevision: 4,
        accepted: true,
        code: null,
        playbackGroupId,
        groupRevision: command.type === "group.create" ? 1 : command.expectedGroupRevision + 1,
      });
    await expect(value.controller.leaveGroup(playbackGroupId)).rejects.toMatchObject({
      code: "STALE_MEDIA_ACK",
    });
  });

  it("keeps a non-active account device read-only until explicit takeover", async () => {
    const inactiveDeviceGroup = group({
      members: [
        member(leaderUserId, leaderDeviceId),
        member(followerUserId, "018f8f8e-4b5c-7d6e-8f90-123456789a99"),
      ],
    });
    const value = harness();
    await connect(value, snapshot([inactiveDeviceGroup]));
    await observe(value, { ...playing, paused: true }, { event: "STATE_CHANGED" });

    expect(value.page.locks.some((entry) => entry.locked)).toBe(false);
    expect(value.page.applies).toHaveLength(0);
    expect(value.transport.commands).toHaveLength(0);
    expect(value.controller.getStatus().localMembership).toMatchObject({
      role: "READ_ONLY",
      activeDevice: false,
    });

    await value.controller.takeOverDevice(playbackGroupId);
    expect(value.transport.commands).toEqual([
      expect.objectContaining({
        type: "group.takeover",
        playbackGroupId,
        expectedGroupRevision: 3,
      }),
    ]);
  });

  it("activates only an existing exact browser-session binding when jumping to a member", async () => {
    const value = harness();
    await connect(value);

    await value.controller.jumpToMember(secondFollowerUserId);
    expect(value.navigation.activated).toEqual([10]);

    value.replicaRecord.bindings = [];
    await value.controller.handleBindingsChanged();
    await expect(value.controller.jumpToMember(secondFollowerUserId)).rejects.toMatchObject({
      code: "MEDIA_MEMBER_TAB_UNBOUND",
    });
    expect(value.navigation.activated).toEqual([10]);
  });

  it("uses the newest snapshot revision for every explicit reliable command", async () => {
    const value = harness();
    await connect(value, snapshot([group({ groupRevision: 7 })], 9));

    await value.controller.transferLeader(
      playbackGroupId,
      secondFollowerUserId,
      secondFollowerDeviceId,
    );
    await value.controller.switchTarget(playbackGroupId, target, playing);
    await value.controller.propose(playbackGroupId, {
      type: "SEEK",
      positionMs: 50_000,
    });
    await value.controller.decide(
      playbackGroupId,
      "00000000-0000-4000-8000-000000000777",
      "REJECT",
    );
    await value.controller.closeGroup(playbackGroupId);

    expect(
      value.transport.commands.map((command) =>
        command.type === "group.create" ? null : command.expectedGroupRevision,
      ),
    ).toEqual([7, 7, 7, 7, 7]);
    expect(new Set(value.transport.commands.map((command) => command.commandId)).size).toBe(5);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleMicrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function sameTestTarget(left: MediaTarget, right: MediaTarget): boolean {
  return (
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey &&
    left.provider === right.provider &&
    left.mediaKey === right.mediaKey &&
    left.durationMs === right.durationMs
  );
}

function addSecondSharedTab(value: Harness): void {
  const confirmed = value.replicaRecord.confirmedSnapshot;
  if (confirmed === null) {
    throw new Error("expected confirmed snapshot");
  }
  confirmed.order.push(secondLogicalTabId);
  confirmed.tabs.push({
    id: secondLogicalTabId,
    url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
    title: "Second shared media",
    favIconUrl: null,
    createdAtSeq: 2,
    updatedAtSeq: 12,
    closedAtSeq: null,
  });
  value.replicaRecord.bindings.push({
    logicalTabId: secondLogicalTabId,
    tabId: 20,
    windowId: 1,
    groupId: null,
    browserSessionId,
    validatedAtServerSeq: 12,
  });
}
