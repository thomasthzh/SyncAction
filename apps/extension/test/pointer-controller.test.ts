import {
  DeviceIdSchema,
  PointerAckSchema,
  PointerEventMessageSchema,
  PointerLeaseAckSchema,
  PointerLeaseEventSchema,
  PointerLeaseSnapshotSchema,
  PointerSnapshotMessageSchema,
  RoomSnapshotStateSchema,
  type PointerAck,
  type PointerFrame,
  type PointerFrameEvent,
  type PointerLeaseAck,
  type PointerLeaseRecord,
  type PointerLeaseUpdate,
  type PointerRecord,
  type PointerUpdate,
} from "@syncaction/protocol";
import { ReplicaRecordSchema, type ReplicaRecord } from "@syncaction/replica";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PointerController,
  type PointerControllerScheduler,
  type PointerLocalSample,
  type PointerPageContext,
  type PointerPagePort,
} from "../src/pointer-controller.js";
import type {
  PointerMessage,
  PointerMessageHandler,
  PointerTransport,
} from "../src/socket-transport.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789c01";
const otherRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789c02";
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789c03";
const otherLogicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789c04";
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789c05";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c06");
const remoteDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c07");
const remoteUserId = "018f8f8e-4b5c-7d6e-8f90-123456789c08";
const firstLeaseId = "018f8f8e-4b5c-7d6e-8f90-123456789c10";
const secondLeaseId = "018f8f8e-4b5c-7d6e-8f90-123456789c11";
const remoteLeaseId = "018f8f8e-4b5c-7d6e-8f90-123456789c12";
let now = 1_785_110_000_000;

function record(
  overrides: {
    browserSession?: string;
    tabId?: number;
    mode?: ReplicaRecord["mode"];
    tabUpdatedAtSeq?: number;
    roomEpoch?: number;
  } = {},
): ReplicaRecord {
  const snapshot = RoomSnapshotStateSchema.parse({
    roomId,
    roomEpoch: overrides.roomEpoch ?? 2,
    serverSeq: 5,
    order: [logicalTabId],
    tabs: [
      {
        id: logicalTabId,
        url: "https://example.com/article",
        title: "Article",
        favIconUrl: null,
        createdAtSeq: 1,
        updatedAtSeq: overrides.tabUpdatedAtSeq ?? 4,
        closedAtSeq: null,
      },
    ],
  });
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId,
    mode: overrides.mode ?? "SYNCED",
    confirmedSnapshot: snapshot,
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: [
      {
        logicalTabId,
        tabId: overrides.tabId ?? 7,
        windowId: 1,
        groupId: 2,
        browserSessionId: overrides.browserSession ?? browserSessionId,
        validatedAtServerSeq: 5,
      },
    ],
    quarantineReason: null,
    updatedAtMs: now,
  });
}

const sample: PointerLocalSample = {
  type: "pointer.sample",
  documentRevision: {
    roomEpoch: 2,
    tabUpdatedAtSeq: 4,
  },
  anchor: {
    path: [
      { tagName: "html", nthOfType: 1 },
      { tagName: "body", nthOfType: 1 },
      { tagName: "main", nthOfType: 1 },
    ],
    x: 0.25,
    y: 0.75,
  },
  viewport: {
    x: 0.4,
    y: 0.6,
  },
  viewportDimensions: {
    widthCssPx: 1_000,
    heightCssPx: 800,
  },
};

class FakePointerTransport implements PointerTransport {
  public handler: PointerMessageHandler | undefined;
  public readonly updates: PointerUpdate[] = [];
  public readonly leases: PointerLeaseUpdate[] = [];
  public readonly frames: PointerFrame[] = [];
  public publishImplementation: ((update: PointerUpdate) => Promise<PointerAck>) | undefined;
  public leaseImplementation:
    ((update: PointerLeaseUpdate) => Promise<PointerLeaseAck>) | undefined;

  public setPointerHandler(handler: PointerMessageHandler | undefined): void {
    this.handler = handler;
  }

  public async publishPointer(update: PointerUpdate) {
    this.updates.push(structuredClone(update));
    if (this.publishImplementation !== undefined) {
      return this.publishImplementation(update);
    }
    return PointerAckSchema.parse({
      type: "pointer.ack",
      protocolVersion: 1,
      roomId,
      accepted: true,
      expiresAt: now + 3_000,
    });
  }

  public async publishPointerLease(update: PointerLeaseUpdate): Promise<PointerLeaseAck> {
    this.leases.push(structuredClone(update));
    if (this.leaseImplementation !== undefined) {
      return this.leaseImplementation(update);
    }
    return PointerLeaseAckSchema.parse({
      type: "pointer.lease.ack",
      protocolVersion: 1,
      roomId,
      leaseId: update.leaseId,
      accepted: true,
      expiresAt: now + 3_000,
    });
  }

  public publishPointerFrame(frame: PointerFrame): void {
    this.frames.push(structuredClone(frame));
  }

  public emit(message: unknown): void {
    this.handler?.(message as PointerMessage);
  }
}

class FakePointerPagePort implements PointerPagePort {
  public allowInjection = true;
  public failure: Error | undefined;
  public readonly injected: number[] = [];
  public readonly verified: number[] = [];
  public readonly contexts: Array<{ tabId: number; context: PointerPageContext }> = [];
  public readonly rendered: Array<{ tabId: number; pointer: PointerRecord }> = [];
  public readonly renderedLeases: Array<{ tabId: number; lease: PointerLeaseRecord }> = [];
  public readonly renderedFrames: Array<{ tabId: number; frame: PointerFrameEvent }> = [];
  public frameImplementation:
    ((tabId: number, frame: PointerFrameEvent) => Promise<void>) | undefined;
  public readonly cleared: Array<{
    tabId: number;
    identity?: { userId: string; deviceId: string };
  }> = [];
  public readonly disposed: number[] = [];

  public async ensureInjected(tabId: number): Promise<boolean> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.injected.push(tabId);
    return this.allowInjection;
  }

  public async verifyInjected(tabId: number): Promise<boolean> {
    this.verified.push(tabId);
    return this.allowInjection;
  }

  public async setContext(tabId: number, context: PointerPageContext): Promise<void> {
    this.contexts.push({ tabId, context: structuredClone(context) });
  }

  public async render(tabId: number, pointer: PointerRecord): Promise<void> {
    this.rendered.push({ tabId, pointer: structuredClone(pointer) });
  }

  public async renderLease(tabId: number, lease: PointerLeaseRecord): Promise<void> {
    this.renderedLeases.push({ tabId, lease: structuredClone(lease) });
  }

  public async renderFrame(tabId: number, frame: PointerFrameEvent): Promise<void> {
    this.renderedFrames.push({ tabId, frame: structuredClone(frame) });
    await this.frameImplementation?.(tabId, frame);
  }

  public async clear(
    tabId: number,
    identity?: { userId: string; deviceId: string },
  ): Promise<void> {
    this.cleared.push({ tabId, ...(identity === undefined ? {} : { identity }) });
  }

  public async dispose(tabId: number): Promise<void> {
    this.disposed.push(tabId);
  }
}

class FakePointerControllerScheduler implements PointerControllerScheduler {
  public readonly intervals = new Map<
    number,
    {
      callback: () => void;
      delayMs: number;
    }
  >();
  private nextId = 1;

  public setInterval(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.intervals.set(id, { callback, delayMs });
    return id;
  }

  public clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  public tick(delayMs: number): void {
    for (const interval of [...this.intervals.values()]) {
      if (interval.delayMs === delayMs) {
        interval.callback();
      }
    }
  }
}

let currentRecord: ReplicaRecord;
let transport: FakePointerTransport;
let page: FakePointerPagePort;
let pointers: PointerController;
let scheduler: FakePointerControllerScheduler;
let leaseIds: string[];
let recordReads: number;
let compatibilityAllowed: boolean;
let observerCompatibilityAllowed: boolean;

beforeEach(() => {
  now = 1_785_110_000_000;
  currentRecord = record();
  transport = new FakePointerTransport();
  page = new FakePointerPagePort();
  scheduler = new FakePointerControllerScheduler();
  leaseIds = [firstLeaseId, secondLeaseId];
  recordReads = 0;
  compatibilityAllowed = true;
  observerCompatibilityAllowed = true;
  pointers = new PointerController({
    roomId,
    browserSessionId,
    deviceId,
    replica: {
      getRecord: async () => {
        recordReads += 1;
        return currentRecord;
      },
    },
    transport,
    page,
    compatibility: {
      canRenderRemotePointer: () => compatibilityAllowed,
      hasCompatibleRemotePointerObserver: () => observerCompatibilityAllowed,
    },
    now: () => now,
    scheduler,
    createLeaseId: () => leaseIds.shift() ?? secondLeaseId,
  });
});

describe("PointerController binding and local publishing", () => {
  it("publishes no positional lease or frame until an exact remote observer exists", async () => {
    observerCompatibilityAllowed = false;
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    await pointers.handleLocalSample(7, sample);
    scheduler.tick(40);

    expect(transport.leases).toEqual([]);
    expect(transport.frames).toEqual([]);

    observerCompatibilityAllowed = true;
    await pointers.handleContentCompatibilityChanged(logicalTabId);
    expect(transport.leases).toHaveLength(1);

    scheduler.tick(40);
    expect(transport.frames).toHaveLength(1);
  });

  it("derives page context only from an exact current-session binding", async () => {
    await expect(pointers.getContextForTab(7)).resolves.toEqual({
      roomId,
      logicalTabId,
      documentRevision: {
        roomEpoch: 2,
        tabUpdatedAtSeq: 4,
      },
    });

    currentRecord = record({
      browserSession: "018f8f8e-4b5c-7d6e-8f90-123456789c09",
    });
    await expect(pointers.getContextForTab(7)).resolves.toBeNull();

    currentRecord = record({ tabId: 8 });
    await expect(pointers.getContextForTab(7)).resolves.toBeNull();
  });

  it("publishes a reliable lease before a quantized frame and drops a stale revision", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    await pointers.whenIdle();
    expect(transport.leases).toEqual([
      {
        type: "pointer.lease",
        protocolVersion: 1,
        roomId,
        deviceId,
        leaseId: firstLeaseId,
        logicalTabId,
        documentRevision: sample.documentRevision,
        anchor: null,
      },
    ]);

    await pointers.handleLocalSample(7, sample);
    expect(transport.frames).toEqual([]);
    scheduler.tick(40);

    expect(transport.frames).toEqual([
      {
        type: "pointer.frame",
        protocolVersion: 1,
        roomId,
        leaseId: firstLeaseId,
        seq: 1,
        xQuantized: 1_638,
        yQuantized: 2_457,
        viewport: { widthBucket: 7, heightBucket: 5 },
        sentAtClientMs: now,
      },
    ]);
    expect(transport.updates).toEqual([]);

    currentRecord = record({ tabUpdatedAtSeq: 5 });
    await pointers.handleBindingsChanged();
    await pointers.handleLocalSample(7, sample);
    scheduler.tick(40);
    expect(transport.frames).toHaveLength(1);
  });

  it("coalesces arbitrary movement to the latest sample on the 40 ms cadence", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    const readsBeforeSamples = recordReads;

    await Promise.all([
      pointers.handleLocalSample(7, {
        ...sample,
        viewport: { x: 0.1, y: 0.1 },
      }),
      pointers.handleLocalSample(7, {
        ...sample,
        viewport: { x: 0.2, y: 0.2 },
      }),
      pointers.handleLocalSample(7, {
        ...sample,
        viewport: { x: 0.9, y: 0.9 },
      }),
    ]);
    expect(transport.frames).toEqual([]);
    expect(recordReads).toBe(readsBeforeSamples);

    scheduler.tick(40);
    expect(transport.frames).toHaveLength(1);
    expect(transport.frames[0]).toMatchObject({
      seq: 1,
      xQuantized: 3_686,
      yQuantized: 3_686,
    });
    scheduler.tick(40);
    expect(transport.frames).toHaveLength(1);
  });

  it("stops frame production while hidden and renews reliably before resuming", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    await pointers.handleLocalSample(7, sample);
    await pointers.handleLocalSample(7, {
      ...sample,
      documentVisible: false,
    });

    expect([...scheduler.intervals.values()].some(({ delayMs }) => delayMs === 40)).toBe(false);
    scheduler.tick(40);
    expect(transport.frames).toHaveLength(0);

    await pointers.handleLocalSample(7, {
      ...sample,
      documentVisible: true,
      viewport: { x: 0.8, y: 0.2 },
    });
    await pointers.whenIdle();
    expect(transport.leases.at(-1)).toMatchObject({ leaseId: firstLeaseId });
    expect([...scheduler.intervals.values()].some(({ delayMs }) => delayMs === 40)).toBe(true);
    scheduler.tick(40);
    expect(transport.frames.at(-1)).toMatchObject({
      xQuantized: 3_276,
      yQuantized: 819,
    });
  });

  it("pauses without another positional renewal when no compatible observer remains", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);

    observerCompatibilityAllowed = false;
    transport.emit(
      PointerLeaseSnapshotSchema.parse({
        type: "pointer.lease.snapshot",
        protocolVersion: 1,
        roomId,
        leases: [],
      }),
    );
    await pointers.whenIdle();
    expect([...scheduler.intervals.values()].some(({ delayMs }) => delayMs === 40)).toBe(true);
    scheduler.tick(2_000);
    await pointers.whenIdle();
    expect(transport.leases).toHaveLength(1);
    expect([...scheduler.intervals.values()].some(({ delayMs }) => delayMs === 40)).toBe(false);
    expect([...scheduler.intervals.values()].some(({ delayMs }) => delayMs === 2_000)).toBe(false);

    observerCompatibilityAllowed = true;
    transport.emit(
      PointerLeaseEventSchema.parse({
        type: "pointer.lease.event",
        protocolVersion: 1,
        roomId,
        lease: remoteLease(),
      }),
    );
    await pointers.whenIdle();
    expect(transport.leases.at(-1)).toMatchObject({ leaseId: firstLeaseId });
    expect(new Set(transport.leases.map(({ leaseId }) => leaseId))).toEqual(
      new Set([firstLeaseId]),
    );
    expect([...scheduler.intervals.values()].some(({ delayMs }) => delayMs === 40)).toBe(true);

    observerCompatibilityAllowed = false;
    transport.emit({
      type: "pointer.lease.clear",
      protocolVersion: 1,
      roomId,
      userId: remoteUserId,
      deviceId: remoteDeviceId,
      leaseId: remoteLeaseId,
    });
    await pointers.whenIdle();
    expect([...scheduler.intervals.values()].some(({ delayMs }) => delayMs === 40)).toBe(true);
    scheduler.tick(2_000);
    await pointers.whenIdle();
    expect([...scheduler.intervals.values()].some(({ delayMs }) => delayMs === 40)).toBe(false);
  });

  it("renews the same lease at two seconds and rotates it for a new page context", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    await pointers.handleLocalSample(7, sample);
    now += 2_000;
    scheduler.tick(2_000);
    await pointers.whenIdle();

    expect(transport.leases).toHaveLength(2);
    expect(transport.leases[1]).toMatchObject({
      leaseId: firstLeaseId,
      anchor: sample.anchor,
    });

    currentRecord = record({ tabUpdatedAtSeq: 5 });
    await pointers.handleBindingsChanged();
    await pointers.whenIdle();
    expect(transport.leases.at(-1)).toMatchObject({
      leaseId: secondLeaseId,
      documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 5 },
    });
    await pointers.handleLocalSample(7, {
      ...sample,
      documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 5 },
    });
    scheduler.tick(40);
    expect(transport.frames.at(-1)).toMatchObject({
      leaseId: secondLeaseId,
      seq: 1,
    });
  });

  it("rejects a local sample carrying privacy-unsafe or malformed fields", async () => {
    await pointers.setSynchronized(true);

    await expect(
      pointers.handleLocalSample(7, {
        ...sample,
        selector: "#account-number",
      }),
    ).rejects.toThrow();
    expect(transport.frames).toEqual([]);
  });
});

describe("PointerController remote routing and isolation", () => {
  it("hides positional pointers until content is exact and reconciles cached state", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    const valid = remoteEvent();
    compatibilityAllowed = false;

    transport.emit(valid);
    await pointers.whenIdle();

    expect(page.rendered).toEqual([]);
    expect(page.cleared.at(-1)).toEqual({
      tabId: 7,
      identity: { userId: remoteUserId, deviceId: remoteDeviceId },
    });

    compatibilityAllowed = true;
    await pointers.handleContentCompatibilityChanged(logicalTabId);
    expect(page.rendered).toEqual([{ tabId: 7, pointer: valid.pointer }]);

    compatibilityAllowed = false;
    await pointers.handleContentCompatibilityChanged(logicalTabId);
    expect(page.cleared.at(-1)).toEqual({
      tabId: 7,
      identity: { userId: remoteUserId, deviceId: remoteDeviceId },
    });
  });

  it("routes v2 leases and increasing frames while rejecting stale sequences", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    const lease = remoteLease();
    transport.emit(
      PointerLeaseSnapshotSchema.parse({
        type: "pointer.lease.snapshot",
        protocolVersion: 1,
        roomId,
        leases: [lease],
      }),
    );
    await pointers.whenIdle();
    expect(page.renderedLeases).toEqual([{ tabId: 7, lease }]);

    const firstFrame = remoteFrame(1);
    transport.emit(firstFrame);
    await pointers.whenIdle();
    expect(page.renderedFrames).toEqual([{ tabId: 7, frame: firstFrame }]);

    transport.emit(firstFrame);
    transport.emit(remoteFrame(0) as never);
    await pointers.whenIdle();
    expect(page.renderedFrames).toHaveLength(1);

    transport.emit({
      type: "pointer.lease.clear",
      protocolVersion: 1,
      roomId,
      userId: remoteUserId,
      deviceId: remoteDeviceId,
      leaseId: remoteLeaseId,
    });
    await pointers.whenIdle();
    expect(page.cleared.at(-1)).toEqual({
      tabId: 7,
      identity: { userId: remoteUserId, deviceId: remoteDeviceId },
    });
  });

  it("bounds a blocked remote burst to its newest frame without hot-path replica reads", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    transport.emit(
      PointerLeaseSnapshotSchema.parse({
        type: "pointer.lease.snapshot",
        protocolVersion: 1,
        roomId,
        leases: [remoteLease()],
      }),
    );
    await pointers.whenIdle();
    page.renderedFrames.length = 0;
    const readsBeforeFrames = recordReads;
    let releaseFirstFrame: (() => void) | undefined;
    let markFirstFrameStarted: (() => void) | undefined;
    const firstFrameStarted = new Promise<void>((resolve) => {
      markFirstFrameStarted = resolve;
    });
    const firstFrameBlocked = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve;
    });
    page.frameImplementation = async () => {
      markFirstFrameStarted?.();
      await firstFrameBlocked;
      page.frameImplementation = undefined;
    };

    transport.emit(remoteFrame(1));
    await firstFrameStarted;
    for (let sequence = 2; sequence <= 200; sequence += 1) {
      transport.emit(remoteFrame(sequence));
    }
    releaseFirstFrame?.();
    await pointers.whenIdle();

    expect(page.renderedFrames.map(({ frame }) => frame.seq)).toEqual([1, 200]);
    expect(recordReads).toBe(readsBeforeFrames);
  });

  it("renders only matching remote room, logical tab, revision, device, and lease", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    const valid = remoteEvent();
    transport.emit(valid);
    await pointers.whenIdle();
    expect(page.rendered).toEqual([{ tabId: 7, pointer: valid.pointer }]);

    const rejected = [
      { ...valid, roomId: otherRoomId },
      {
        ...valid,
        pointer: { ...valid.pointer, logicalTabId: otherLogicalTabId },
      },
      {
        ...valid,
        pointer: {
          ...valid.pointer,
          documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 3 },
        },
      },
      {
        ...valid,
        pointer: { ...valid.pointer, deviceId },
      },
      {
        ...valid,
        pointer: { ...valid.pointer, expiresAt: now },
      },
      {
        ...valid,
        pointer: { ...valid.pointer, color: "blue" },
      },
    ];
    for (const event of rejected) {
      transport.emit(event);
    }
    await pointers.whenIdle();

    expect(page.rendered).toHaveLength(1);
  });

  it("replaces from snapshots and routes a strict clear to the rendered identity", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    const valid = remoteEvent();
    const snapshot = PointerSnapshotMessageSchema.parse({
      type: "pointer.snapshot",
      protocolVersion: 1,
      roomId,
      pointers: [valid.pointer],
    });

    transport.emit(snapshot);
    await pointers.whenIdle();
    expect(page.rendered.at(-1)).toEqual({ tabId: 7, pointer: valid.pointer });

    transport.emit({
      type: "pointer.clear",
      protocolVersion: 1,
      roomId,
      userId: remoteUserId,
      deviceId: remoteDeviceId,
    });
    await pointers.whenIdle();
    expect(page.cleared.at(-1)).toEqual({
      tabId: 7,
      identity: { userId: remoteUserId, deviceId: remoteDeviceId },
    });
  });

  it("removes the handler and clears managed pages immediately on loss of sync", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    expect(transport.handler).toBeDefined();

    const stopping = pointers.setSynchronized(false);
    expect(transport.handler).toBeUndefined();
    await stopping;

    expect(page.disposed).toContain(7);
    expect(pointers.getStatus()).toEqual({
      state: "OFFLINE",
      lastAckExpiresAt: null,
      errorCode: null,
    });
  });

  it("refreshes an already-ready page without reinjecting the collaboration entrypoint", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    expect(page.injected).toEqual([7]);

    page.injected.length = 0;
    page.contexts.length = 0;
    await pointers.handlePageReady(7);

    expect(page.injected).toEqual([]);
    expect(page.verified).toEqual([7]);
    expect(page.contexts).toEqual([
      {
        tabId: 7,
        context: {
          roomId,
          logicalTabId,
          documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 4 },
        },
      },
    ]);
  });

  it("rejects a late ready when the tracked document no longer passes verification", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    page.contexts.length = 0;
    page.allowInjection = false;

    await pointers.handlePageReady(7);

    expect(page.verified).toEqual([7]);
    expect(page.contexts).toEqual([]);
    expect(page.disposed).toContain(7);
    expect(pointers.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "POINTER_PERMISSION_REQUIRED",
    });
  });

  it("disposes a nonactive managed page after its current-session binding disappears", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    expect(page.injected).toEqual([7]);

    currentRecord = record({ tabId: 8 });
    await pointers.handleActiveTabChanged(8);
    expect(page.injected).toEqual([7, 8]);
    expect(page.disposed).not.toContain(7);

    await pointers.handleBindingsChanged();
    expect(page.disposed).toContain(7);
  });

  it("degrades only the pointer subsystem when permission or injection fails", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    transport.emit(remoteEvent());
    await pointers.whenIdle();
    expect(page.rendered).toHaveLength(1);

    page.allowInjection = false;
    await expect(pointers.handleActiveTabChanged(7)).resolves.toBeUndefined();

    expect(pointers.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "POINTER_PERMISSION_REQUIRED",
    });
    expect(page.disposed).toContain(7);
  });

  it("retains a page-host capability failure for the active managed tab", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);

    pointers.handlePageCapability({
      tabId: 7,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      },
    });

    expect(pointers.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "PAGE_HOST_CONFLICT",
    });

    await pointers.handleActiveTabChanged(7);
    expect(pointers.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "PAGE_HOST_CONFLICT",
    });

    pointers.handlePageCapability({
      tabId: 7,
      frameId: 3,
      message: {
        type: "syncaction.page.capability",
        capability: "MEDIA",
        state: "DEGRADED",
        errorCode: "MEDIA_FRAME_UNAVAILABLE",
      },
    });
    expect(pointers.getStatus().errorCode).toBe("PAGE_HOST_CONFLICT");

    pointers.handlePageCapability({
      tabId: 7,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "ORIGIN_PERMISSION_REVOKED",
      },
    });
    expect(pointers.getStatus().errorCode).toBe("POINTER_PERMISSION_REQUIRED");

    pointers.handlePageCapability({
      tabId: 7,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "AVAILABLE",
        errorCode: null,
      },
    });
    expect(pointers.getStatus()).toMatchObject({
      state: "ONLINE",
      errorCode: null,
    });
  });

  it("rebuilds managed page state after the permission boundary changes", async () => {
    await pointers.handleActiveTabChanged(7);
    await pointers.setSynchronized(true);
    page.injected.length = 0;

    await pointers.handlePermissionBoundaryChanged();

    expect(page.injected).toEqual([7]);
    expect(pointers.getStatus()).toMatchObject({ state: "ONLINE", errorCode: null });
  });
});

function remoteEvent() {
  return PointerEventMessageSchema.parse({
    type: "pointer.event",
    protocolVersion: 1,
    roomId,
    pointer: {
      userId: remoteUserId,
      username: "remote",
      displayName: "Remote",
      deviceId: remoteDeviceId,
      color: "#22c55e",
      logicalTabId,
      documentRevision: sample.documentRevision,
      anchor: sample.anchor,
      viewport: sample.viewport,
      expiresAt: now + 3_000,
    },
  });
}

function remoteLease(): PointerLeaseRecord {
  return PointerLeaseEventSchema.parse({
    type: "pointer.lease.event",
    protocolVersion: 1,
    roomId,
    lease: {
      userId: remoteUserId,
      username: "remote",
      displayName: "Remote",
      deviceId: remoteDeviceId,
      leaseId: remoteLeaseId,
      color: "#22c55e",
      logicalTabId,
      documentRevision: sample.documentRevision,
      anchor: sample.anchor,
      expiresAt: now + 3_000,
    },
  }).lease;
}

function remoteFrame(sequence: number): PointerFrameEvent {
  return {
    type: "pointer.frame",
    protocolVersion: 1,
    roomId: roomId as PointerFrameEvent["roomId"],
    userId: remoteUserId,
    deviceId: remoteDeviceId,
    leaseId: remoteLeaseId,
    seq: sequence,
    xQuantized: 2_048,
    yQuantized: 1_024,
    viewport: { widthBucket: 7, heightBucket: 5 },
    receivedAtServerMs: now + sequence * 40,
  };
}
