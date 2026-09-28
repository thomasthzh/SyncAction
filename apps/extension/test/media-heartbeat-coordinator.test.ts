import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  MediaTargetSchema,
  PlaybackGroupSnapshotSchema,
  RoomIdSchema,
  type MediaHeartbeat,
  type MediaObservedState,
  type PlaybackGroupSnapshot,
} from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import {
  MediaHeartbeatCoordinator,
  type MediaHeartbeatSample,
  type MediaHeartbeatScheduler,
} from "../src/media-heartbeat-coordinator.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a02");
const leaderUserId = "018f8f8e-4b5c-7d6e-8f90-123456789a03";
const leaderDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a04");
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

class TickScheduler implements MediaHeartbeatScheduler {
  #callback: (() => void) | null = null;
  public readonly intervals: number[] = [];

  public setInterval(callback: () => void, intervalMs: number): number {
    this.#callback = callback;
    this.intervals.push(intervalMs);
    return 1;
  }

  public clearInterval(): void {
    this.#callback = null;
  }

  public tick(count = 1): void {
    for (let index = 0; index < count; index += 1) {
      this.#callback?.();
    }
  }
}

function observed(positionMs: number, paused = false, ended = false): MediaObservedState {
  return {
    observedAtClientMs: nowMs,
    positionMs,
    paused,
    playbackRate: 1,
    ended,
    buffering: false,
  };
}

function group(groupRevision: number): PlaybackGroupSnapshot {
  return PlaybackGroupSnapshotSchema.parse({
    playbackGroupId,
    roomId,
    groupRevision,
    status: "PLAYING",
    leaderUserId,
    leaderDeviceId,
    members: [
      {
        userId: leaderUserId,
        username: "leader",
        displayName: "Leader",
        activeDeviceId: leaderDeviceId,
        joinedAtServerMs: nowMs - 5_000,
        online: true,
      },
    ],
    target,
    observed: observed(42_000),
    observedAtServerMs: nowMs,
    proposals: [],
    leaderGraceExpiresAtServerMs: null,
    updatedAtServerMs: nowMs,
  });
}

function sample(positionMs: number, paused = false, ended = false): MediaHeartbeatSample {
  return {
    tabId: 10,
    frameId: 0,
    context: {
      roomId,
      logicalTabId,
      documentRevision: target.documentRevision,
      frameKey: target.frameKey,
    },
    target,
    observed: observed(positionMs, paused, ended),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("MediaHeartbeatCoordinator", () => {
  it("does not relabel a sample captured under an older group revision", async () => {
    const scheduler = new TickScheduler();
    const published: MediaHeartbeat[] = [];
    let currentGroup = group(3);
    const coordinator = new MediaHeartbeatCoordinator({
      roomId,
      scheduler,
      now: () => nowMs,
      findLeaderGroup: () => currentGroup,
      isRouteCurrent: async () => true,
      onError: () => undefined,
      transport: {
        publishMediaHeartbeat: (heartbeat) => {
          published.push(heartbeat);
        },
      },
    });
    coordinator.start();
    coordinator.offerSample(sample(42_100), false);

    currentGroup = group(4);
    scheduler.tick();
    await coordinator.whenIdle();

    expect(published).toHaveLength(0);
    coordinator.offerSample(sample(42_200), false);
    scheduler.tick();
    await coordinator.whenIdle();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      groupRevision: 4,
      positionMs: 42_200,
    });
    await coordinator.dispose();
  });

  it("publishes without waiting and emits only the latest sample on each tick", async () => {
    const scheduler = new TickScheduler();
    const published: MediaHeartbeat[] = [];
    const currentGroup = group(3);
    const coordinator = new MediaHeartbeatCoordinator({
      roomId,
      scheduler,
      now: () => nowMs,
      findLeaderGroup: () => currentGroup,
      isRouteCurrent: async () => true,
      onError: () => undefined,
      transport: {
        publishMediaHeartbeat: (heartbeat) => {
          published.push(heartbeat);
        },
      },
    });
    coordinator.start();
    coordinator.offerSample(sample(42_100), false);
    coordinator.offerSample(sample(42_200), false);
    coordinator.offerSample(sample(42_900), false);
    scheduler.tick();
    await coordinator.whenIdle();
    expect(published).toEqual([expect.objectContaining({ positionMs: 42_900 })]);

    coordinator.offerSample(sample(43_100), false);
    scheduler.tick();
    await coordinator.whenIdle();
    expect(published).toEqual([
      expect.objectContaining({ positionMs: 42_900 }),
      expect.objectContaining({ positionMs: 43_100 }),
    ]);
    await coordinator.dispose();
  });

  it("reschedules from 500 ms to 2 seconds while its current page is hidden", async () => {
    const scheduler = new TickScheduler();
    const published: MediaHeartbeat[] = [];
    const currentGroup = group(3);
    const coordinator = new MediaHeartbeatCoordinator({
      roomId,
      scheduler,
      now: () => nowMs,
      findLeaderGroup: () => currentGroup,
      isRouteCurrent: async () => true,
      onError: () => undefined,
      transport: {
        publishMediaHeartbeat: (heartbeat) => {
          published.push(heartbeat);
        },
      },
    });
    coordinator.start();
    coordinator.offerSample(sample(42_100), false);
    expect(scheduler.intervals).toEqual([500]);

    coordinator.setPageVisibility(sample(42_100), "hidden");
    expect(scheduler.intervals).toEqual([500, 2_000]);
    scheduler.tick();
    await coordinator.whenIdle();
    expect(published).toEqual([expect.objectContaining({ positionMs: 42_100 })]);

    coordinator.setPageVisibility(sample(42_100), "visible");
    expect(scheduler.intervals).toEqual([500, 2_000, 500]);
    await coordinator.dispose();
  });

  it("confirms discrete paused or ended states once before using a two-second heartbeat", async () => {
    const scheduler = new TickScheduler();
    const published: MediaHeartbeat[] = [];
    const currentGroup = group(3);
    const coordinator = new MediaHeartbeatCoordinator({
      roomId,
      scheduler,
      now: () => nowMs,
      findLeaderGroup: () => currentGroup,
      isRouteCurrent: async () => true,
      onError: () => undefined,
      transport: {
        publishMediaHeartbeat: (heartbeat) => {
          published.push(heartbeat);
        },
      },
    });
    coordinator.start();
    expect(scheduler.intervals).toEqual([500]);

    coordinator.offerSample(sample(42_100, true), true);
    await coordinator.whenIdle();
    expect(published).toHaveLength(1);
    expect(scheduler.intervals).toEqual([500]);

    coordinator.offerSample(sample(42_100, true), false);
    expect(scheduler.intervals).toEqual([500]);

    scheduler.tick();
    await coordinator.whenIdle();
    expect(published).toHaveLength(2);
    expect(scheduler.intervals).toEqual([500, 2_000]);

    coordinator.offerSample(sample(42_100, false, true), true);
    expect(scheduler.intervals).toEqual([500, 2_000, 500]);
    scheduler.tick();
    await coordinator.whenIdle();
    expect(scheduler.intervals).toEqual([500, 2_000, 500, 2_000]);

    coordinator.offerSample(sample(42_200), true);
    expect(scheduler.intervals).toEqual([500, 2_000, 500, 2_000, 500]);
    await coordinator.dispose();
  });

  it("invalidates an in-flight sample when authority clears during route validation", async () => {
    const scheduler = new TickScheduler();
    const routeValidationStarted = deferred<void>();
    const routeValidation = deferred<boolean>();
    const published: MediaHeartbeat[] = [];
    const currentGroup = group(3);
    const coordinator = new MediaHeartbeatCoordinator({
      roomId,
      scheduler,
      now: () => nowMs,
      findLeaderGroup: () => currentGroup,
      isRouteCurrent: async () => {
        routeValidationStarted.resolve(undefined);
        return routeValidation.promise;
      },
      onError: () => undefined,
      transport: {
        publishMediaHeartbeat: (heartbeat) => {
          published.push(heartbeat);
        },
      },
    });
    coordinator.start();
    coordinator.offerSample(sample(42_100), false);
    scheduler.tick();
    await routeValidationStarted.promise;

    coordinator.clearSample();
    routeValidation.resolve(true);
    await coordinator.whenIdle();

    expect(published).toHaveLength(0);
    coordinator.offerSample(sample(42_200), false);
    scheduler.tick();
    await coordinator.whenIdle();
    expect(published).toEqual([expect.objectContaining({ positionMs: 42_200 })]);
    await coordinator.dispose();
  });

  it("reports a current route-validation failure", async () => {
    const scheduler = new TickScheduler();
    const errors: string[] = [];
    const currentGroup = group(3);
    const coordinator = new MediaHeartbeatCoordinator({
      roomId,
      scheduler,
      now: () => nowMs,
      findLeaderGroup: () => currentGroup,
      isRouteCurrent: async () => {
        throw new Error("MEDIA_ROUTE_VALIDATION_FAILED");
      },
      onError: (errorCode) => {
        errors.push(errorCode);
      },
      transport: {
        publishMediaHeartbeat: () => undefined,
      },
    });
    coordinator.start();
    coordinator.offerSample(sample(42_100), false);
    scheduler.tick();
    await coordinator.whenIdle();

    expect(errors).toEqual(["MEDIA_ROUTE_VALIDATION_FAILED"]);
    await coordinator.dispose();
  });

  it("suppresses a stale route-validation failure after its sample is cleared", async () => {
    const scheduler = new TickScheduler();
    const routeValidationStarted = deferred<void>();
    const routeValidation = deferred<boolean>();
    const errors: string[] = [];
    const currentGroup = group(3);
    const coordinator = new MediaHeartbeatCoordinator({
      roomId,
      scheduler,
      now: () => nowMs,
      findLeaderGroup: () => currentGroup,
      isRouteCurrent: async () => {
        routeValidationStarted.resolve(undefined);
        return routeValidation.promise;
      },
      onError: (errorCode) => {
        errors.push(errorCode);
      },
      transport: {
        publishMediaHeartbeat: () => undefined,
      },
    });
    coordinator.start();
    coordinator.offerSample(sample(42_100), false);
    scheduler.tick();
    await routeValidationStarted.promise;

    coordinator.clearSample();
    routeValidation.reject(new Error("STALE_ROUTE_FAILURE"));
    await coordinator.whenIdle();

    expect(errors).toHaveLength(0);
    await coordinator.dispose();
  });

  it("drops a sample whose route validation completes after stop", async () => {
    const scheduler = new TickScheduler();
    const routeValidation = deferred<boolean>();
    const published: MediaHeartbeat[] = [];
    const currentGroup = group(3);
    const coordinator = new MediaHeartbeatCoordinator({
      roomId,
      scheduler,
      now: () => nowMs,
      findLeaderGroup: () => currentGroup,
      isRouteCurrent: () => routeValidation.promise,
      onError: () => undefined,
      transport: {
        publishMediaHeartbeat: (heartbeat) => {
          published.push(heartbeat);
        },
      },
    });
    coordinator.start();
    coordinator.offerSample(sample(42_100), false);
    scheduler.tick();
    await Promise.resolve();
    coordinator.offerSample(sample(42_900), false);
    scheduler.tick();

    const stopped = coordinator.stop();
    routeValidation.resolve(true);
    await stopped;

    expect(published).toHaveLength(0);
    scheduler.tick();
    await coordinator.whenIdle();
    expect(published).toHaveLength(0);
  });
});
