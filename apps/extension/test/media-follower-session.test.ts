import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  MediaTargetSchema,
  PlaybackGroupSnapshotSchema,
  RoomIdSchema,
  type PlaybackAction,
} from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import { MediaFollowerSession } from "../src/media-follower-session.js";
import type { MediaRoute } from "../src/media-controller-model.js";

const nowMs = 1_700_000_000_000;
const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a02");
const leaderUserId = "018f8f8e-4b5c-7d6e-8f90-123456789a03";
const leaderDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a04");
const followerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789a05";
const followerDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a06");
const playbackGroupId = "00000000-0000-4000-8000-000000000101";
const target = MediaTargetSchema.parse({
  logicalTabId,
  documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
});
const authoritativeObserved = {
  observedAtClientMs: nowMs,
  positionMs: 42_000,
  paused: false,
  playbackRate: 1,
  ended: false,
  buffering: false,
};
const route: MediaRoute = {
  tabId: 10,
  frameId: 0,
  context: {
    roomId,
    logicalTabId,
    documentRevision: target.documentRevision,
    frameKey: "top",
  },
};

function group(proposals: unknown[] = []) {
  return PlaybackGroupSnapshotSchema.parse({
    playbackGroupId,
    roomId,
    groupRevision: 3,
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
      {
        userId: followerUserId,
        username: "follower",
        displayName: "Follower",
        activeDeviceId: followerDeviceId,
        joinedAtServerMs: nowMs - 4_000,
        online: true,
      },
    ],
    target,
    observed: authoritativeObserved,
    observedAtServerMs: nowMs,
    proposals,
    leaderGraceExpiresAtServerMs: null,
    updatedAtServerMs: nowMs,
  });
}

function createSession(options: {
  propose(action: PlaybackAction): Promise<void>;
  errors?: string[];
}) {
  let uuidCounter = 1;
  return new MediaFollowerSession({
    userId: followerUserId,
    deviceId: followerDeviceId,
    page: {
      apply: async () => undefined,
      setFollowerLock: async () => undefined,
    },
    scheduler: {
      setTimeout: () => Symbol("timer"),
      clearTimeout: () => undefined,
    },
    now: () => nowMs,
    createUuid: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`,
    isRouteCurrent: async () => true,
    getGroup: () => group(),
    propose: async (_group, action) => options.propose(action),
    onError: (errorCode) => options.errors?.push(errorCode),
  });
}

describe("MediaFollowerSession proposal lifecycle", () => {
  it("releases a reserved token that was never dispatched", () => {
    const session = createSession({
      propose: async () => undefined,
    });

    const applyToken = session.reserveApplyToken();
    expect(session.matchesApplyToken(applyToken)).toBe(true);

    session.releaseApplyToken(applyToken);
    expect(session.matchesApplyToken(applyToken)).toBe(false);
  });

  it("deduplicates only an identical in-flight action and allows success/new/expired replacements", async () => {
    const firstProposal = deferred<void>();
    const actions: PlaybackAction[] = [];
    const session = createSession({
      propose: async (action) => {
        actions.push(structuredClone(action));
        if (
          action.type === "PAUSE" &&
          actions.filter(({ type }) => type === "PAUSE").length === 1
        ) {
          await firstProposal.promise;
        }
      },
    });
    const guard = () => true;
    const paused = { ...authoritativeObserved, paused: true };
    const first = session.handleGesture(group(), route, target, paused, guard);
    const duplicate = session.handleGesture(group(), route, target, paused, guard);
    await settleMicrotasks();

    expect(actions).toEqual([{ type: "PAUSE" }]);

    const replacement = session.handleGesture(
      group(),
      route,
      target,
      { ...authoritativeObserved, playbackRate: 1.25 },
      guard,
    );
    await replacement;
    expect(actions).toEqual([{ type: "PAUSE" }, { type: "SET_RATE", playbackRate: 1.25 }]);

    firstProposal.resolve();
    await Promise.all([first, duplicate]);
    await session.handleGesture(group(), route, target, paused, guard);
    expect(actions.filter(({ type }) => type === "PAUSE")).toHaveLength(2);

    const expiredProposal = {
      proposalId: "00000000-0000-4000-8000-000000000777",
      proposedByUserId: followerUserId,
      proposedByDeviceId: followerDeviceId,
      baseGroupRevision: 3,
      action: { type: "SET_RATE", playbackRate: 1.5 },
      createdAtServerMs: nowMs - 31_000,
      expiresAtServerMs: nowMs - 1_000,
    };
    await session.handleGesture(
      group([expiredProposal]),
      route,
      target,
      { ...authoritativeObserved, playbackRate: 1.5 },
      guard,
    );
    expect(actions.at(-1)).toEqual({ type: "SET_RATE", playbackRate: 1.5 });
  });

  it("retries the identical action after a failed send settles", async () => {
    const actions: PlaybackAction[] = [];
    const errors: string[] = [];
    let fail = true;
    const session = createSession({
      errors,
      propose: async (action) => {
        actions.push(structuredClone(action));
        if (fail) {
          fail = false;
          throw new Error("transport unavailable");
        }
      },
    });
    const paused = { ...authoritativeObserved, paused: true };

    await session.handleGesture(group(), route, target, paused, () => true);
    await session.handleGesture(group(), route, target, paused, () => true);

    expect(actions).toEqual([{ type: "PAUSE" }, { type: "PAUSE" }]);
    expect(errors).toContain("transport unavailable");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
