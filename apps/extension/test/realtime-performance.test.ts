// @vitest-environment happy-dom

import {
  ClientOpIdSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type ClientOperationEnvelope,
  type MediaHeartbeat,
  type OperationAck,
  type PointerFrame,
  type PointerFrameEvent,
  type PointerLeaseRecord,
  type PresenceDeltaMessage,
  type PresenceRecordV2,
  type PresenceSnapshotV2Message,
  type RoomEventMessage,
} from "@syncaction/protocol";
import { io } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PointerPageContext } from "../src/pointer-controller.js";
import { PointerPageRuntime, type PointerPageScheduler } from "../src/pointer-page.js";
import { RealtimeMetrics } from "../src/realtime-metrics.js";
import { SocketReplicaTransport, type PresenceMessage } from "../src/socket-transport.js";

vi.mock("socket.io-client", () => ({
  io: vi.fn(),
}));

const ROOM_ID = RoomIdSchema.parse("10000000-0000-4000-8000-000000000001");
const LOGICAL_TAB_ID = LogicalTabIdSchema.parse("20000000-0000-4000-8000-000000000001");
const REMOTE_USER_ID = "30000000-0000-4000-8000-000000000001";
const REMOTE_DEVICE_ID = DeviceIdSchema.parse("40000000-0000-4000-8000-000000000001");
const LEASE_ID = "50000000-0000-4000-8000-000000000001";
const PLAYBACK_GROUP_ID = "60000000-0000-4000-8000-000000000001";
const INITIAL_TIME_MS = Date.parse("2026-07-30T00:00:00.000Z");

const pageContext: PointerPageContext = {
  roomId: ROOM_ID,
  logicalTabId: LOGICAL_TAB_ID,
  documentRevision: {
    roomEpoch: 1,
    tabUpdatedAtSeq: 2,
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(INITIAL_TIME_MS);
  vi.clearAllMocks();
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("60-second realtime congestion regression", () => {
  it("bounds volatile work, converges after fallback reconnect, and preserves durable ACKs", async () => {
    const metrics = new RealtimeMetrics();
    const socket = new CongestedFakeSocket();
    vi.mocked(io).mockReturnValue(socket as never);
    let handlerClockOffsetMs = 0;
    const transport = new SocketReplicaTransport({
      serverUrl: "https://syncaction.example.test",
      accessToken: "access-1",
      clientVersion: "0.9.0",
      metrics,
      now: () => Date.now() + handlerClockOffsetMs,
    });
    const surface = document.createElement("section");
    document.documentElement.append(surface);
    const pageScheduler = new PerformancePageScheduler();
    const pointerPage = new PointerPageRuntime({
      document,
      window,
      surface,
      scheduler: pageScheduler,
      now: () => Date.now(),
      emitSample: vi.fn(),
      metrics,
    });
    pointerPage.setContext(pageContext);
    pointerPage.renderLease(remoteLease(Date.now() + 3_000));
    transport.setPointerHandler((message) => {
      if (message.type === "pointer.frame") {
        pointerPage.renderFrame(message);
      }
    });

    const presences = new Map<string, PresenceRecordV2>();
    let presenceSeq = 0;
    transport.setPresenceHandler((message: PresenceMessage) => {
      if (message.type === "presence.snapshot.v2") {
        presences.clear();
        for (const presence of message.presences) {
          presences.set(presenceKey(presence), presence);
        }
        presenceSeq = message.presenceSeq;
      } else if (message.type === "presence.delta.v2" && message.fromPresenceSeq === presenceSeq) {
        for (const change of message.changes) {
          if (change.kind === "UPSERT") {
            presences.set(presenceKey(change.presence), change.presence);
          } else {
            presences.delete(`${change.userId}:${change.deviceId}`);
          }
        }
        presenceSeq = message.toPresenceSeq;
      }
      handlerClockOffsetMs += 8;
    });
    const roomEvents: RoomEventMessage[] = [];
    transport.setRoomEventHandler((event) => {
      roomEvents.push(event);
      handlerClockOffsetMs += 7;
    });

    await transport.connect({
      onCommitted: vi.fn(),
      onDisconnect: vi.fn(),
      onReconnect: vi.fn(),
    });

    const initialPresences = presenceRecords(100, Date.now() + 120_000);
    socket.serverEmit("presence.snapshot.v2", presenceSnapshot(0, initialPresences));
    expect(presences.size).toBe(100);
    for (let index = 1; index <= 20; index += 1) {
      const updated = {
        ...initialPresences[0]!,
        expiresAt: Date.now() + 120_000 + index,
      };
      socket.serverEmit("presence.delta.v2", presenceDelta(index - 1, updated));
      socket.serverEmit("room.event", roomEvent(index));
    }
    expect(presenceSeq).toBe(20);
    expect(roomEvents).toHaveLength(20);
    socket.serverEmit(
      "presence.delta.v2",
      presenceDelta(25, {
        ...initialPresences[0]!,
        expiresAt: Date.now() + 120_000,
      }),
    );
    expect(presenceSeq).toBe(20);

    for (let sequence = 1; sequence <= 1_500; sequence += 1) {
      socket.io.engine.transport.writable = sequence % 20 !== 0 || sequence === 1_500;
      transport.publishPointerFrame(pointerFrame(sequence));
      if (sequence % 12 === 0) {
        transport.publishMediaHeartbeat(mediaHeartbeat(sequence));
      }
      if (sequence % 50 === 0) {
        pointerPage.renderLease(remoteLease(Date.now() + 3_000));
      }
      vi.advanceTimersByTime(40);
    }
    socket.io.engine.transport.writable = true;
    vi.advanceTimersByTime(500);

    const activeMetrics = metrics.snapshot();
    expect(activeMetrics.pointerFrames.emitted).toBe(1_500);
    expect(
      activeMetrics.pointerFrames.dropped / activeMetrics.pointerFrames.emitted,
    ).toBeGreaterThan(0.049);
    expect(activeMetrics.pointerFrames.dropped / activeMetrics.pointerFrames.emitted).toBeLessThan(
      0.051,
    );
    expect(activeMetrics.mediaHeartbeatsEmitted).toBe(125);
    expect(socket.ackEvents).toEqual([]);
    expect(socket.maxRetainedPointerCoordinates).toBe(1);
    expect(pageScheduler.maximumPendingAnimationFrames).toBe(1);
    expect(surface.querySelectorAll(".syncaction-pointer")).toHaveLength(1);
    expect(activeMetrics.maximumPointerDomNodes).toBe(1);
    expect(pointerPage.getPointerPosition(REMOTE_USER_ID, REMOTE_DEVICE_ID)?.x).toBeCloseTo(
      (1_500 / 4_095) * 1_000,
      4,
    );
    const renderedAnimationFrames = pageScheduler.completedAnimationFrames;
    expect(renderedAnimationFrames).toBeGreaterThan(0);

    socket.forceDisconnect();
    socket.io.emit("reconnect_attempt");
    vi.advanceTimersByTime(500);
    socket.io.emit("reconnect_attempt");
    vi.advanceTimersByTime(500);
    const connectionAvailableAt = Date.now();
    vi.advanceTimersByTime(500);
    socket.forceReconnect("polling");
    socket.serverEmit(
      "presence.delta.v2",
      presenceDelta(20, {
        ...initialPresences[0]!,
        expiresAt: Date.now() + 120_000,
      }),
    );
    expect(presenceSeq).toBe(20);
    setTimeout(() => {
      socket.serverEmit(
        "presence.snapshot.v2",
        presenceSnapshot(100, presenceRecords(101, Date.now() + 120_000)),
      );
    }, 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(presences.size).toBe(101);
    const recoveryFromAvailabilityMs = Date.now() - connectionAvailableAt;

    const envelope = durableEnvelope();
    let durableSettled = false;
    const durableAcknowledgement = transport.submit(envelope).then((acknowledgement) => {
      durableSettled = true;
      return acknowledgement;
    });
    expect(socket.ackEvents).toEqual(["operation.submit"]);
    await Promise.resolve();
    expect(durableSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await expect(durableAcknowledgement).resolves.toMatchObject({
      type: "op.ack",
      clientOpId: envelope.clientOpId,
      serverSeq: 1,
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.selectedTransport).toBe("polling");
    expect(snapshot.reconnectAttempts).toBe(2);
    expect(snapshot.presence.snapshots).toBe(2);
    expect(snapshot.presence.deltas).toBe(21);
    expect(snapshot.presence.gaps).toBe(1);
    expect(snapshot.latency.roomEventToUi.p95Ms).toBeLessThan(50);
    expect(snapshot.latency.presenceDeltaToUi.p95Ms).toBeLessThan(50);
    expect(snapshot.latency.reconnectRecovery.maxMs).toBeLessThan(3_000);
    expect(recoveryFromAvailabilityMs).toBeLessThan(3_000);
    if (process.env.SYNCACTION_CAPTURE_REALTIME_METRICS === "1") {
      console.info(
        `[realtime-performance] ${JSON.stringify({
          simulatedDurationMs: 60_000,
          roundTripTimeMs: 250,
          frameSendFrequencyHz: 25,
          rendererAnimationFrequencyHz: renderedAnimationFrames / 60,
          maximumRetainedCoordinates: socket.maxRetainedPointerCoordinates,
          recoveryFromAvailabilityMs,
          metrics: snapshot,
        })}`,
      );
    }

    pointerPage.dispose();
    await transport.disconnect();
  }, 30_000);
});

class FakeManager {
  public readonly engine = {
    transport: {
      name: "websocket",
      writable: true,
    },
  };
  readonly #handlers = new Map<string, Array<() => void>>();

  public on(event: string, handler: () => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  public emit(event: string): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler();
    }
  }
}

class CongestedFakeSocket {
  public connected = false;
  public readonly io = new FakeManager();
  public readonly ackEvents: string[] = [];
  public maxRetainedPointerCoordinates = 0;
  readonly #handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly #onceHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  #volatile = false;
  #pendingPointer: PointerFrame | null = null;
  #pointerDelivery: ReturnType<typeof setTimeout> | null = null;

  public on(event: string, handler: (...args: never[]) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.#handlers.set(event, handlers);
    return this;
  }

  public once(event: string, handler: (...args: never[]) => void): this {
    const handlers = this.#onceHandlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.#onceHandlers.set(event, handlers);
    return this;
  }

  public connect(): this {
    this.connected = true;
    this.serverEmit("connect");
    return this;
  }

  public timeout(): this {
    return this;
  }

  public get volatile(): this {
    this.#volatile = true;
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    const volatile = this.#volatile;
    this.#volatile = false;
    if (event !== "pointer.frame" || !volatile || !this.io.engine.transport.writable) {
      return;
    }
    this.#pendingPointer = structuredClone(args[0] as PointerFrame);
    this.maxRetainedPointerCoordinates = Math.max(
      this.maxRetainedPointerCoordinates,
      this.#pendingPointer === null ? 0 : 1,
    );
    if (this.#pointerDelivery !== null) {
      return;
    }
    this.#pointerDelivery = setTimeout(() => {
      this.#pointerDelivery = null;
      const frame = this.#pendingPointer;
      this.#pendingPointer = null;
      if (frame !== null && this.connected) {
        const eventMessage: PointerFrameEvent = {
          type: "pointer.frame",
          protocolVersion: 1,
          roomId: frame.roomId,
          userId: REMOTE_USER_ID,
          deviceId: REMOTE_DEVICE_ID,
          leaseId: frame.leaseId,
          seq: frame.seq,
          xQuantized: frame.xQuantized,
          yQuantized: frame.yQuantized,
          viewport: frame.viewport,
          receivedAtServerMs: Date.now(),
        };
        this.serverEmit("pointer.frame", eventMessage);
      }
    }, 250);
  }

  public emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.#volatile = false;
    this.ackEvents.push(event);
    return new Promise((resolve) => {
      setTimeout(() => {
        if (event !== "operation.submit") {
          resolve({
            type: "sync.error",
            protocolVersion: 1,
            code: "INVALID_MESSAGE",
          });
          return;
        }
        const envelope = payload as ClientOperationEnvelope;
        const acknowledgement: OperationAck = {
          type: "op.ack",
          protocolVersion: 1,
          clientOpId: envelope.clientOpId,
          roomId: envelope.roomId,
          roomEpoch: envelope.roomEpoch,
          serverSeq: 1,
        };
        resolve(acknowledgement);
      }, 250);
    });
  }

  public forceDisconnect(): void {
    this.connected = false;
    this.serverEmit("disconnect");
  }

  public forceReconnect(transport: "polling" | "websocket"): void {
    this.io.engine.transport.name = transport;
    this.connected = true;
    this.serverEmit("connect");
  }

  public serverEmit(event: string, ...args: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(...args);
    }
    const once = this.#onceHandlers.get(event) ?? [];
    this.#onceHandlers.delete(event);
    for (const handler of once) {
      handler(...args);
    }
  }

  public removeAllListeners(): void {
    this.#handlers.clear();
    this.#onceHandlers.clear();
  }

  public disconnect(): void {
    this.connected = false;
  }
}

class PerformancePageScheduler implements PointerPageScheduler {
  public maximumPendingAnimationFrames = 0;
  public completedAnimationFrames = 0;
  readonly #animationTimers = new Map<number, ReturnType<typeof setTimeout>>();
  #nextAnimationId = 1;

  public setTimeout(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  }

  public clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  public requestAnimationFrame(callback: () => void): unknown {
    const id = this.#nextAnimationId;
    this.#nextAnimationId += 1;
    const timer = setTimeout(() => {
      this.#animationTimers.delete(id);
      this.completedAnimationFrames += 1;
      callback();
    }, 16);
    this.#animationTimers.set(id, timer);
    this.maximumPendingAnimationFrames = Math.max(
      this.maximumPendingAnimationFrames,
      this.#animationTimers.size,
    );
    return id;
  }

  public cancelAnimationFrame(handle: unknown): void {
    const id = handle as number;
    const timer = this.#animationTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#animationTimers.delete(id);
    }
  }
}

function pointerFrame(sequence: number): PointerFrame {
  return {
    type: "pointer.frame",
    protocolVersion: 1,
    roomId: ROOM_ID,
    leaseId: LEASE_ID,
    seq: sequence,
    xQuantized: sequence % 4_096,
    yQuantized: (sequence * 3) % 4_096,
    viewport: {
      widthBucket: 7,
      heightBucket: 5,
    },
    sentAtClientMs: Date.now(),
  };
}

function remoteLease(expiresAt: number): PointerLeaseRecord {
  return {
    userId: REMOTE_USER_ID,
    username: "remote",
    displayName: "Remote",
    deviceId: REMOTE_DEVICE_ID,
    leaseId: LEASE_ID,
    color: "#3b82f6",
    logicalTabId: LOGICAL_TAB_ID,
    documentRevision: pageContext.documentRevision,
    anchor: null,
    expiresAt,
  };
}

function mediaHeartbeat(sequence: number): MediaHeartbeat {
  return {
    type: "media.heartbeat",
    protocolVersion: 1,
    roomId: ROOM_ID,
    playbackGroupId: PLAYBACK_GROUP_ID,
    groupRevision: 1,
    target: {
      logicalTabId: LOGICAL_TAB_ID,
      documentRevision: pageContext.documentRevision,
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 120_000,
    },
    observedAtClientMs: Date.now(),
    positionMs: sequence * 40,
    paused: false,
    playbackRate: 1,
    ended: false,
    buffering: false,
  };
}

function presenceRecords(count: number, expiresAt: number): PresenceRecordV2[] {
  return Array.from({ length: count }, (_, index) => ({
    userId: indexedUuid("7", index),
    username: `member-${String(index)}`,
    displayName: `Member ${String(index)}`,
    deviceId: DeviceIdSchema.parse(indexedUuid("8", index)),
    logicalTabId: null,
    contentContext: null,
    expiresAt,
  }));
}

function presenceSnapshot(
  presenceSeq: number,
  presences: PresenceRecordV2[],
): PresenceSnapshotV2Message {
  return {
    type: "presence.snapshot.v2",
    protocolVersion: 1,
    roomId: ROOM_ID,
    presenceSeq,
    presences,
  };
}

function presenceDelta(fromPresenceSeq: number, presence: PresenceRecordV2): PresenceDeltaMessage {
  return {
    type: "presence.delta.v2",
    protocolVersion: 1,
    roomId: ROOM_ID,
    fromPresenceSeq,
    toPresenceSeq: fromPresenceSeq + 1,
    changes: [
      {
        kind: "UPSERT",
        presence,
      },
    ],
  };
}

function roomEvent(index: number): RoomEventMessage {
  return {
    type: "room.event",
    protocolVersion: 1,
    eventId: indexedUuid("9", index),
    roomId: ROOM_ID,
    roomRevision: index,
    occurredAt: new Date(Date.now()).toISOString(),
    kind: "ROOM_UPDATED",
    name: `Room ${String(index)}`,
    visibility: "PUBLIC",
    joinPolicy: "APPROVAL",
  };
}

function durableEnvelope(): ClientOperationEnvelope {
  return {
    protocolVersion: 1,
    clientOpId: ClientOpIdSchema.parse(indexedUuid("a", 1)),
    roomId: ROOM_ID,
    roomEpoch: 0,
    deviceId: REMOTE_DEVICE_ID,
    baseServerSeq: 0,
    operation: {
      type: "tab.create",
      logicalTabId: LOGICAL_TAB_ID,
      url: "https://example.com/",
      after: null,
    },
  };
}

function indexedUuid(prefix: string, index: number): string {
  return `${prefix}0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function presenceKey(presence: Pick<PresenceRecordV2, "userId" | "deviceId">): string {
  return `${presence.userId}:${presence.deviceId}`;
}
