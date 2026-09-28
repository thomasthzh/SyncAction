import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  MediaCommandAckSchema,
  MediaTargetSchema,
  PlaybackGroupSnapshotSchema,
  RoomIdSchema,
} from "@syncaction/protocol";
import { ReplicaRecordSchema } from "@syncaction/replica";
import { describe, expect, it } from "vitest";
import {
  buildExistingMediaCommand,
  isCurrentMediaCommandAck,
} from "../src/media-controller-commands.js";
import {
  inferMediaFollowerAction,
  planMediaFollowerCorrection,
  planMediaLeaderAuthorityRestoration,
} from "../src/media-controller-correction.js";
import { deriveMediaMembership, resolveMediaRoute } from "../src/media-controller-model.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c02");
const leaderUserId = "018f8f8e-4b5c-7d6e-8f90-123456789c03";
const leaderDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c04");
const followerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789c05";
const followerDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c06");
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789c07";
const playbackGroupId = "00000000-0000-4000-8000-000000000201";
const nowMs = 1_700_000_000_000;

const target = MediaTargetSchema.parse({
  logicalTabId,
  documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 9 },
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
});

const group = PlaybackGroupSnapshotSchema.parse({
  playbackGroupId,
  roomId,
  groupRevision: 7,
  status: "PLAYING",
  leaderUserId,
  leaderDeviceId,
  members: [
    {
      userId: leaderUserId,
      username: "leader",
      displayName: "Leader",
      activeDeviceId: leaderDeviceId,
      joinedAtServerMs: nowMs - 2_000,
      online: true,
    },
    {
      userId: followerUserId,
      username: "follower",
      displayName: "Follower",
      activeDeviceId: followerDeviceId,
      joinedAtServerMs: nowMs - 1_000,
      online: true,
    },
  ],
  target,
  observed: {
    observedAtClientMs: nowMs,
    positionMs: 42_000,
    paused: false,
    playbackRate: 1,
    ended: false,
    buffering: false,
  },
  observedAtServerMs: nowMs,
  proposals: [],
  leaderGraceExpiresAtServerMs: null,
  updatedAtServerMs: nowMs,
});

describe("media controller pure logic", () => {
  it("resolves only the exact synchronized browser binding and document revision", () => {
    const record = ReplicaRecordSchema.parse({
      schemaVersion: 1,
      roomId,
      mode: "SYNCED",
      confirmedSnapshot: {
        roomId,
        roomEpoch: 2,
        serverSeq: 9,
        order: [logicalTabId],
        tabs: [
          {
            id: logicalTabId,
            url: "https://example.com/private",
            title: "Private title",
            favIconUrl: null,
            createdAtSeq: 1,
            updatedAtSeq: 9,
            closedAtSeq: null,
          },
        ],
      },
      nextOutboxSeq: 1,
      outbox: [],
      pendingConfirmations: [],
      orphanedOutbox: [],
      bindings: [
        {
          logicalTabId,
          tabId: 10,
          windowId: 1,
          groupId: null,
          browserSessionId,
          validatedAtServerSeq: 9,
        },
      ],
      quarantineReason: null,
      updatedAtMs: nowMs,
    });

    expect(resolveMediaRoute(record, roomId, browserSessionId, 10, 0, "top")).toEqual({
      tabId: 10,
      frameId: 0,
      context: {
        roomId,
        logicalTabId,
        documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 9 },
        frameKey: "top",
      },
    });
    expect(
      resolveMediaRoute(record, roomId, "018f8f8e-4b5c-7d6e-8f90-123456789cff", 10, 0, "top"),
    ).toBeNull();
  });

  it("derives active follower and read-only device membership without page data", () => {
    expect(deriveMediaMembership([group], followerUserId, followerDeviceId)).toEqual({
      playbackGroupId,
      role: "FOLLOWER",
      activeDevice: true,
    });
    expect(
      deriveMediaMembership([group], followerUserId, "018f8f8e-4b5c-7d6e-8f90-123456789c99"),
    ).toEqual({
      playbackGroupId,
      role: "READ_ONLY",
      activeDevice: false,
    });
  });

  it("plans the middle correction band and infers one follower gesture", () => {
    const localObserved = {
      ...group.observed!,
      positionMs: 41_200,
    };
    expect(planMediaFollowerCorrection(group, target, localObserved, nowMs, false)).toEqual({
      actions: [
        {
          type: "SET_RATE_TEMPORARY",
          playbackRate: 1.05,
          restoreRate: 1,
          durationMs: 3_000,
        },
      ],
      rateRestore: { playbackRate: 1, durationMs: 3_000 },
    });
    expect(
      inferMediaFollowerAction(group, target, { ...localObserved, paused: true }, nowMs),
    ).toEqual({ type: "PAUSE" });
  });

  it("seeks instead of rate-slewing medium leader drift before play", () => {
    const localObserved = {
      ...group.observed!,
      paused: true,
    };

    expect(
      planMediaLeaderAuthorityRestoration(group, target, localObserved, nowMs + 800, false),
    ).toEqual([{ type: "SEEK", positionMs: 42_800 }, { type: "PLAY" }]);
  });

  it("leaves small leader drift alone but restores the exact authoritative rate", () => {
    expect(
      planMediaLeaderAuthorityRestoration(
        group,
        target,
        {
          ...group.observed!,
          positionMs: 41_701,
        },
        nowMs,
        false,
      ),
    ).toEqual([]);
    expect(
      planMediaLeaderAuthorityRestoration(
        group,
        target,
        {
          ...group.observed!,
          playbackRate: 1.25,
        },
        nowMs,
        false,
      ),
    ).toEqual([{ type: "SET_RATE", playbackRate: 1 }]);
  });

  it.each([
    {
      status: "PAUSED" as const,
      authority: {
        ...group.observed!,
        paused: true,
      },
    },
    {
      status: "ENDED_WAITING" as const,
      authority: {
        ...group.observed!,
        positionMs: target.durationMs,
        paused: true,
        ended: true,
      },
    },
  ])("seeks and pauses exact $status leader authority", ({ status, authority }) => {
    const authoritativeGroup = PlaybackGroupSnapshotSchema.parse({
      ...group,
      status,
      observed: authority,
    });

    expect(
      planMediaLeaderAuthorityRestoration(
        authoritativeGroup,
        target,
        {
          ...group.observed!,
          positionMs: authority.positionMs,
        },
        nowMs,
        false,
      ),
    ).toEqual([{ type: "SEEK", positionMs: authority.positionMs }, { type: "PAUSE" }]);
  });

  it("treats an explicit small seek as intent without changing the ordinary drift threshold", () => {
    const smallSeek = {
      ...group.observed!,
      positionMs: group.observed!.positionMs + 150,
    };

    expect(inferMediaFollowerAction(group, target, smallSeek, nowMs)).toBeNull();
    expect(inferMediaFollowerAction(group, target, smallSeek, nowMs, "SEEKED")).toEqual({
      type: "SEEK",
      positionMs: 42_150,
    });
  });

  it("builds commands from the latest group revision and rejects stale acknowledgements", () => {
    const command = buildExistingMediaCommand({
      roomId,
      commandId: "00000000-0000-4000-8000-000000000202",
      group,
      payload: { type: "group.leave" },
    });
    expect(command).toMatchObject({
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
    });
    const acknowledgement = MediaCommandAckSchema.parse({
      type: "media.command.ack",
      protocolVersion: 1,
      commandId: command.commandId,
      roomId,
      roomMediaRevision: 3,
      accepted: true,
      code: null,
      playbackGroupId,
      groupRevision: 6,
    });
    expect(
      isCurrentMediaCommandAck({
        command,
        acknowledgement,
        roomId,
        currentRoomRevision: 3,
        currentGroupRevision: 7,
      }),
    ).toBe(false);
  });
});
