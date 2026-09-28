import { describe, expect, it } from "vitest";
import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  MediaTargetSchema,
  RoomIdSchema,
  type MediaTarget,
  type PlaybackGroupSnapshot,
} from "@syncaction/protocol";
import { predictGroupPosition, recommendGroup } from "../src/index.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-323456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-323456789a02");
const nowMs = 1_700_000_010_000;
const target: MediaTarget = MediaTargetSchema.parse({
  logicalTabId,
  documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
});

function group(
  playbackGroupId: string,
  positionMs: number,
  memberCount: number,
  overrides: Partial<PlaybackGroupSnapshot> = {},
): PlaybackGroupSnapshot {
  const members = Array.from({ length: memberCount }, (_, index) => ({
    userId: `018f8f8e-4b5c-4d6e-8f90-${String(400 + index).padStart(12, "0")}`,
    username: `user${index}`,
    displayName: `User ${index}`,
    activeDeviceId: DeviceIdSchema.parse(
      `018f8f8e-4b5c-4d6e-8f90-${String(500 + index).padStart(12, "0")}`,
    ),
    joinedAtServerMs: nowMs - 5_000 + index,
    online: true,
  }));
  const leader = members[0]!;
  return {
    playbackGroupId,
    roomId,
    groupRevision: 3,
    status: "PLAYING",
    leaderUserId: leader.userId,
    leaderDeviceId: leader.activeDeviceId,
    members,
    target,
    observed: {
      observedAtClientMs: nowMs - 2_000,
      positionMs,
      paused: false,
      playbackRate: 1,
      ended: false,
      buffering: false,
    },
    observedAtServerMs: nowMs - 2_000,
    proposals: [],
    leaderGraceExpiresAtServerMs: null,
    updatedAtServerMs: nowMs - 2_000,
    ...overrides,
  };
}

describe("deterministic playback group recommendation", () => {
  it("sorts by online member count, then predicted progress, then group ID", () => {
    const groups = [
      group("00000000-0000-4000-8000-000000000003", 80_000, 2),
      group("00000000-0000-4000-8000-000000000002", 60_000, 3),
      group("00000000-0000-4000-8000-000000000001", 40_000, 1),
    ];
    expect(recommendGroup(groups, target, nowMs)?.playbackGroupId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );

    const sameCount = [
      group("00000000-0000-4000-8000-000000000003", 40_000, 2),
      group("00000000-0000-4000-8000-000000000002", 60_000, 2),
    ];
    expect(recommendGroup(sameCount, target, nowMs)?.playbackGroupId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );

    const exactTie = [
      group("00000000-0000-4000-8000-000000000003", 60_000, 2),
      group("00000000-0000-4000-8000-000000000002", 60_000, 2),
    ];
    expect(recommendGroup(exactTie, target, nowMs)?.playbackGroupId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
  });

  it("counts only online members and ignores grace or nonmatching groups", () => {
    const mostlyOffline = group("00000000-0000-4000-8000-000000000001", 100_000, 4, {
      members: group("00000000-0000-4000-8000-000000000004", 0, 4).members.map((member, index) => ({
        ...member,
        online: index === 0,
      })),
    });
    const eligible = group("00000000-0000-4000-8000-000000000002", 20_000, 2);
    const grace = group("00000000-0000-4000-8000-000000000003", 200_000, 5, {
      status: "LEADER_GRACE",
      leaderGraceExpiresAtServerMs: nowMs + 5_000,
    });
    const otherTarget = group("00000000-0000-4000-8000-000000000004", 200_000, 5, {
      target: { ...target, mediaKey: "youtube:9bZkp7q19f0" },
    });
    expect(
      recommendGroup([mostlyOffline, eligible, grace, otherTarget], target, nowMs)?.playbackGroupId,
    ).toBe(eligible.playbackGroupId);
  });

  it("requires exact document identity for generic HTML5 media", () => {
    const htmlTarget: MediaTarget = MediaTargetSchema.parse({
      ...target,
      provider: "HTML5",
      mediaKey: "html5:hero-video",
    });
    const wrongDocument = group("00000000-0000-4000-8000-000000000001", 50_000, 3, {
      target: {
        ...htmlTarget,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 13 },
      },
    });
    expect(recommendGroup([wrongDocument], htmlTarget, nowMs)).toBeUndefined();
  });

  it("predicts only active playback and clamps to duration", () => {
    expect(
      predictGroupPosition(group("00000000-0000-4000-8000-000000000001", 42_000, 1), nowMs),
    ).toBe(44_000);
    expect(
      predictGroupPosition(
        group("00000000-0000-4000-8000-000000000001", 42_000, 1, {
          status: "PAUSED",
          observed: {
            observedAtClientMs: nowMs - 2_000,
            positionMs: 42_000,
            paused: true,
            playbackRate: 1,
            ended: false,
            buffering: false,
          },
        }),
        nowMs,
      ),
    ).toBe(42_000);
    for (const state of [
      { status: "LOADING" as const, ended: false, buffering: true },
      { status: "ENDED_WAITING" as const, ended: true, buffering: false },
    ]) {
      expect(
        predictGroupPosition(
          group("00000000-0000-4000-8000-000000000001", 42_000, 1, {
            status: state.status,
            observed: {
              observedAtClientMs: nowMs - 2_000,
              positionMs: 42_000,
              paused: false,
              playbackRate: 1,
              ended: state.ended,
              buffering: state.buffering,
            },
          }),
          nowMs,
        ),
      ).toBe(42_000);
    }
    expect(
      predictGroupPosition(group("00000000-0000-4000-8000-000000000001", 211_500, 1), nowMs),
    ).toBe(212_000);
  });
});
