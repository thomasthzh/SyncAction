import { applyMediaCommand } from "@syncaction/media";
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
import { HtmlMediaAdapter } from "../src/media-adapters/html-media.js";

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
  it.each(["READY", "BUFFERING"] as const)(
    "still contains a different media target reported by %s",
    (trigger) => {
      const otherTarget = MediaTargetSchema.parse({ ...target, mediaKey: "youtube:9bZkp7q19f0" });
      expect(inferMediaFollowerAction(group, otherTarget, group.observed!, nowMs, trigger)).toEqual(
        {
          type: "SWITCH_TARGET",
          target: otherTarget,
          observed: group.observed,
        },
      );
    },
  );

  it("settles a fractional server pause within the HTML media adapter's millisecond precision", async () => {
    const htmlTarget = MediaTargetSchema.parse({
      ...target,
      provider: "HTML5",
      mediaKey: "html5:principal",
    });
    const playingGroup = PlaybackGroupSnapshotSchema.parse({
      ...group,
      target: htmlTarget,
      observed: { ...group.observed!, playbackRate: 1.25 },
      proposals: [
        {
          proposalId: "00000000-0000-4000-8000-000000000202",
          proposedByUserId: followerUserId,
          proposedByDeviceId: followerDeviceId,
          baseGroupRevision: group.groupRevision,
          action: { type: "PAUSE" },
          createdAtServerMs: nowMs,
          expiresAtServerMs: nowMs + 30_000,
        },
      ],
    });
    const transitioned = applyMediaCommand(
      { roomId, roomMediaRevision: 1, groups: [playingGroup] },
      {
        type: "proposal.decide",
        protocolVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000203",
        roomId,
        playbackGroupId: playingGroup.playbackGroupId,
        expectedGroupRevision: playingGroup.groupRevision,
        proposalId: playingGroup.proposals[0]!.proposalId,
        decision: "APPROVE",
      },
      { userId: leaderUserId, deviceId: leaderDeviceId, username: "leader", displayName: "Leader" },
      nowMs + 1,
    );
    expect(transitioned.outcome.ok).toBe(true);
    const pausedGroup = PlaybackGroupSnapshotSchema.parse(transitioned.state.groups[0]);
    expect(pausedGroup.observed?.positionMs).toBe(42_001.25);
    const media = {
      isConnected: true,
      currentTime: 42.001,
      playbackRate: 1.25,
      paused: true,
      ended: false,
      readyState: 4,
      mediaKeys: null,
    };
    const adapter = new HtmlMediaAdapter({
      media: media as unknown as HTMLMediaElement,
      window: {} as Window,
      target: htmlTarget,
      now: () => nowMs + 1,
    });
    const forced = planMediaFollowerCorrection(
      pausedGroup,
      htmlTarget,
      adapter.read(),
      nowMs + 1,
      true,
    );
    expect(forced.actions).toEqual([{ type: "SEEK", positionMs: 42_001.25 }]);
    for (const action of forced.actions) {
      await adapter.apply({ action } as Parameters<HtmlMediaAdapter["apply"]>[0]);
    }
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const observed = adapter.read();
      expect(observed.positionMs).toBe(42_001);
      expect(
        inferMediaFollowerAction(pausedGroup, htmlTarget, observed, nowMs + 1, "READY"),
      ).toBeNull();
      expect(
        planMediaFollowerCorrection(pausedGroup, htmlTarget, observed, nowMs + 1, false),
      ).toEqual({
        actions: [],
        rateRestore: null,
      });
    }
  });

  it("keeps paused alignment idempotent while preserving real drift, explicit seeks, rate and pause correction", () => {
    const stationary = { ...group.observed!, paused: true, positionMs: 0 };
    const pausedGroup = PlaybackGroupSnapshotSchema.parse({
      ...group,
      status: "PAUSED",
      observed: stationary,
    });
    expect(planMediaFollowerCorrection(pausedGroup, target, stationary, nowMs, false)).toEqual({
      actions: [],
      rateRestore: null,
    });
    expect(
      planMediaFollowerCorrection(pausedGroup, target, stationary, nowMs, true).actions,
    ).toEqual([{ type: "SEEK", positionMs: 0 }]);
    expect(
      planMediaFollowerCorrection(
        pausedGroup,
        target,
        { ...stationary, positionMs: 1 },
        nowMs,
        false,
      ).actions,
    ).toEqual([{ type: "SEEK", positionMs: 0 }]);
    expect(
      planMediaFollowerCorrection(
        pausedGroup,
        target,
        { ...stationary, paused: false, playbackRate: 1.25 },
        nowMs,
        false,
      ).actions,
    ).toEqual([{ type: "SET_RATE", playbackRate: 1 }, { type: "PAUSE" }]);
  });

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
  ])(
    "pauses matching $status leader authority and seeks only real drift",
    ({ status, authority }) => {
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
      ).toEqual([{ type: "PAUSE" }]);
      expect(
        planMediaLeaderAuthorityRestoration(
          authoritativeGroup,
          target,
          {
            ...group.observed!,
            paused: true,
            positionMs: authority.positionMs - 1,
          },
          nowMs,
          false,
        ),
      ).toEqual([{ type: "SEEK", positionMs: authority.positionMs }]);
    },
  );

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
