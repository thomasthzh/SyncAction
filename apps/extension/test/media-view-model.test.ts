import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type PlaybackGroupSnapshot,
} from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import type {
  ExtensionCollaborationMemberSummary,
  ExtensionCollaborationPageSummary,
} from "../src/app-controller.js";
import type { MediaControllerStatus } from "../src/media-controller.js";
import { createMediaViewModel } from "../src/ui/media-view-model.js";

const nowMs = 1_700_000_010_000;
const roomId = RoomIdSchema.parse("00000000-0000-4000-8000-000000000001");
const pageA = LogicalTabIdSchema.parse("00000000-0000-4000-8000-000000000011");
const pageB = LogicalTabIdSchema.parse("00000000-0000-4000-8000-000000000012");
const groupA = "00000000-0000-4000-8000-000000000101";
const groupB = "00000000-0000-4000-8000-000000000102";
const proposalId = "00000000-0000-4000-8000-000000000201";
const leaderA = "00000000-0000-4000-8000-000000000301";
const followerA = "00000000-0000-4000-8000-000000000302";
const followerB = "00000000-0000-4000-8000-000000000303";
const leaderB = "00000000-0000-4000-8000-000000000304";
const outsideUser = "00000000-0000-4000-8000-000000000305";
const leaderDeviceA = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000401");
const followerDeviceA = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000402");
const followerDeviceB = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000403");
const leaderDeviceB = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000404");
const outsideDevice = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000405");

describe("media view model", () => {
  it("keeps groups lossless, leaders first, outside members separate, and row jump distinct from group actions", () => {
    const input = fixture();
    const before = structuredClone(input);
    deepFreeze(input);

    const view = createMediaViewModel(input);

    expect(input).toEqual(before);
    expect(view.state).toBe("ONLINE");
    expect(view.recommendedPlaybackGroupId).toBe(groupA);
    expect(view.groups.map((group) => group.groupId)).toEqual([groupA, groupB]);
    expect(view.groups.filter((group) => group.recommended).map((group) => group.groupId)).toEqual([
      groupA,
    ]);
    expect(view.groups[0]).toMatchObject({
      key: `media-group:${groupA}`,
      groupId: groupA,
      state: "PLAYING",
      statusText: "播放中",
      memberCount: 3,
      badgeText: "推荐",
      target: {
        pageId: pageA,
        pageTitle: "发布会回放",
        domain: "video.example",
        providerText: "YouTube",
        progressText: "02:04 / 10:00",
        frameText: "主页面媒体",
      },
    });
    expect(view.groups[0]).not.toHaveProperty("statusGlyph");
    expect(view.groups[0]?.members[0]).not.toHaveProperty("roleGlyph");
    expect(view.groups[0]?.members.map((member) => [member.userId, member.role])).toEqual([
      [leaderA, "LEADER"],
      [followerA, "FOLLOWER"],
      [followerB, "FOLLOWER"],
    ]);
    expect(view.groups[0]?.members[0]).toMatchObject({
      pageId: pageA,
      pageTitle: "发布会回放",
      detail: "发布会回放 · YouTube · 02:04 / 10:00",
      primaryAction: {
        label: "跳转",
        intent: { type: "JUMP_TO_MEMBER", userId: leaderA },
        disabled: false,
      },
      trailingActions: [],
    });
    expect(view.groups[0]?.members[2]).toMatchObject({
      pageId: null,
      detail: "离线",
      primaryAction: {
        disabled: true,
        disabledReason: "成员离线",
      },
    });
    expect(view.groups[0]?.trailingActions).toEqual([
      expect.objectContaining({
        key: `media-group:${groupA}:align-once`,
        label: "对齐一次",
        intent: { type: "ALIGN_ONCE", playbackGroupId: groupA },
        disabled: false,
      }),
      expect.objectContaining({
        key: `media-group:${groupA}:join`,
        label: "加入播放组",
        intent: { type: "JOIN_GROUP", playbackGroupId: groupA },
        disabled: false,
      }),
    ]);
    expect(view.outsideMembers).toEqual([
      expect.objectContaining({
        key: `media-outside-member:${outsideUser}`,
        userId: outsideUser,
        displayName: "组外成员",
        detail: "正在查看 教学视频 · learn.example",
        primaryAction: expect.objectContaining({
          intent: { type: "JUMP_TO_MEMBER", userId: outsideUser },
          disabled: false,
        }),
      }),
    ]);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("shows proposals only to the exact current leader and preserves the group id in both decisions", () => {
    const leaderView = createMediaViewModel(
      fixture({
        localMembership: {
          playbackGroupId: groupA,
          role: "LEADER",
          activeDevice: true,
        },
      }),
    );
    const followerView = createMediaViewModel(
      fixture({
        localMembership: {
          playbackGroupId: groupA,
          role: "FOLLOWER",
          activeDevice: true,
        },
      }),
    );
    const inactiveLeaderDeviceView = createMediaViewModel(
      fixture({
        localMembership: {
          playbackGroupId: groupA,
          role: "LEADER",
          activeDevice: false,
        },
      }),
    );

    expect(leaderView.groups[0]?.proposals).toEqual([
      expect.objectContaining({
        key: `media-group:${groupA}:proposal:${proposalId}`,
        proposalId,
        proposedByText: "跟随 A",
        title: "建议调整进度",
        detail: "跳转到 03:20 · 30 秒内有效",
        trailingActions: [
          expect.objectContaining({
            label: "同意",
            intent: {
              type: "DECIDE_PROPOSAL",
              playbackGroupId: groupA,
              proposalId,
              decision: "APPROVE",
            },
          }),
          expect.objectContaining({
            label: "拒绝",
            intent: {
              type: "DECIDE_PROPOSAL",
              playbackGroupId: groupA,
              proposalId,
              decision: "REJECT",
            },
          }),
        ],
      }),
    ]);
    expect(leaderView.groups[0]?.proposals[0]).not.toHaveProperty("glyph");
    expect(followerView.groups.every((group) => group.proposals.length === 0)).toBe(true);
    expect(inactiveLeaderDeviceView.groups.every((group) => group.proposals.length === 0)).toBe(
      true,
    );
    expect(leaderView.groups[0]?.trailingActions).toEqual([
      expect.objectContaining({
        label: "关闭播放组",
        intent: { type: "CLOSE_GROUP", playbackGroupId: groupA },
        disabled: false,
      }),
    ]);
  });

  it("renders ended waiting, leader grace, unsupported, autoplay-blocked, and degraded frame copy", () => {
    const ended = createMediaViewModel(
      fixture({
        playbackGroups: [
          playbackGroup({
            playbackGroupId: groupA,
            status: "ENDED_WAITING",
            observed: {
              observedAtClientMs: nowMs - 2_000,
              positionMs: 600_000,
              paused: true,
              playbackRate: 1,
              ended: true,
              buffering: false,
            },
          }),
        ],
      }),
    );
    const grace = createMediaViewModel(
      fixture({
        playbackGroups: [
          playbackGroup({
            playbackGroupId: groupA,
            status: "LEADER_GRACE",
            leaderGraceExpiresAtServerMs: nowMs + 7_500,
          }),
        ],
      }),
    );

    expect(ended.groups[0]).toMatchObject({
      state: "ENDED_WAITING",
      statusText: "已结束，等待领播者切换",
    });
    expect(grace.groups[0]).toMatchObject({
      state: "LEADER_GRACE",
      statusText: "等待领播者恢复 · 8 秒",
    });

    expect(
      createMediaViewModel(fixture({ state: "DEGRADED", errorCode: "MEDIA_LIVE_UNSUPPORTED" }))
        .notice,
    ).toEqual({
      tone: "warning",
      text: "当前媒体是直播或不可定位流，仍可共享和跳转，但不能同步进度。",
    });
    expect(
      createMediaViewModel(fixture({ state: "DEGRADED", errorCode: "AUTOPLAY_BLOCKED" })).notice,
    ).toEqual({
      tone: "warning",
      text: "浏览器阻止了自动播放；请在视频页面点击继续，播放组不会解散。",
    });
    expect(
      createMediaViewModel(fixture({ state: "DEGRADED", errorCode: "MEDIA_FRAME_UNAUTHORIZED" }))
        .notice,
    ).toEqual({
      tone: "warning",
      text: "媒体所在的子页面未获授权；当前只能跳转，不能同步播放。",
    });
  });
});

function fixture(
  mediaOverrides: Partial<MediaControllerStatus> = {},
): Parameters<typeof createMediaViewModel>[0] {
  const pages: ExtensionCollaborationPageSummary[] = [
    {
      pageId: pageA,
      title: "发布会回放",
      domain: "video.example",
      state: "OPEN",
    },
    {
      pageId: pageB,
      title: "教学视频",
      domain: "learn.example",
      state: "OPEN",
    },
  ];
  const members: ExtensionCollaborationMemberSummary[] = [
    member(leaderA, "领播 A", true, [pageA]),
    member(followerA, "跟随 A", true, [pageA]),
    member(followerB, "跟随 B", false, []),
    member(leaderB, "领播 B", true, [pageB]),
    member(outsideUser, "组外成员", true, [pageB]),
  ];
  const media: MediaControllerStatus = {
    state: "ONLINE",
    roomMediaRevision: 12,
    playbackGroups: [
      playbackGroup(),
      playbackGroup({
        playbackGroupId: groupB,
        leaderUserId: leaderB,
        leaderDeviceId: leaderDeviceB,
        members: [
          {
            userId: leaderB,
            username: "leader-b",
            displayName: "领播 B",
            activeDeviceId: leaderDeviceB,
            joinedAtServerMs: nowMs - 9_000,
            online: true,
          },
        ],
        target: {
          logicalTabId: pageB,
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
          frameKey: "frame:player",
          provider: "BILIBILI",
          mediaKey: "bilibili:BV1xx411c7mD",
          durationMs: 900_000,
        },
        observed: {
          observedAtClientMs: nowMs - 1_000,
          positionMs: 300_000,
          paused: true,
          playbackRate: 1,
          ended: false,
          buffering: false,
        },
        observedAtServerMs: nowMs - 1_000,
        status: "PAUSED",
        proposals: [],
      }),
    ],
    localObservation: {
      target: {
        logicalTabId: pageA,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 11 },
        frameKey: "top",
        provider: "YOUTUBE",
        mediaKey: "youtube:dQw4w9WgXcQ",
        durationMs: 600_000,
      },
      observed: {
        observedAtClientMs: nowMs,
        positionMs: 124_000,
        paused: true,
        playbackRate: 1,
        ended: false,
        buffering: false,
      },
    },
    localMembership: null,
    recommendedPlaybackGroupId: groupA,
    navigation: [
      navigation(leaderA, leaderDeviceA, pageA, true),
      navigation(followerA, followerDeviceA, pageA, true),
      navigation(followerB, followerDeviceB, null, false),
      navigation(leaderB, leaderDeviceB, pageB, true),
      navigation(outsideUser, outsideDevice, pageB, true),
    ],
    errorCode: null,
    ...mediaOverrides,
  };
  return { media, pages, members, nowMs };
}

function playbackGroup(overrides: Partial<PlaybackGroupSnapshot> = {}): PlaybackGroupSnapshot {
  return {
    playbackGroupId: groupA,
    roomId,
    groupRevision: 7,
    status: "PLAYING",
    leaderUserId: leaderA,
    leaderDeviceId: leaderDeviceA,
    members: [
      {
        userId: followerA,
        username: "follower-a",
        displayName: "跟随 A",
        activeDeviceId: followerDeviceA,
        joinedAtServerMs: nowMs - 8_000,
        online: true,
      },
      {
        userId: leaderA,
        username: "leader-a",
        displayName: "领播 A",
        activeDeviceId: leaderDeviceA,
        joinedAtServerMs: nowMs - 10_000,
        online: true,
      },
      {
        userId: followerB,
        username: "follower-b",
        displayName: "跟随 B",
        activeDeviceId: followerDeviceB,
        joinedAtServerMs: nowMs - 7_000,
        online: false,
      },
    ],
    target: {
      logicalTabId: pageA,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 11 },
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 600_000,
    },
    observed: {
      observedAtClientMs: nowMs - 4_000,
      positionMs: 120_000,
      paused: false,
      playbackRate: 1,
      ended: false,
      buffering: false,
    },
    observedAtServerMs: nowMs - 4_000,
    proposals: [
      {
        proposalId,
        proposedByUserId: followerA,
        proposedByDeviceId: followerDeviceA,
        baseGroupRevision: 7,
        action: { type: "SEEK", positionMs: 200_000 },
        createdAtServerMs: nowMs,
        expiresAtServerMs: nowMs + 30_000,
      },
    ],
    leaderGraceExpiresAtServerMs: null,
    updatedAtServerMs: nowMs - 4_000,
    ...overrides,
  };
}

function member(
  userId: string,
  displayName: string,
  online: boolean,
  activePageIds: string[],
): ExtensionCollaborationMemberSummary {
  return {
    userId,
    displayName,
    roomRole: "MEMBER",
    online,
    deviceCount: online ? 1 : 0,
    activePageIds,
  };
}

function navigation(
  userId: string,
  deviceId: string,
  logicalTabId: string | null,
  canJump: boolean,
): MediaControllerStatus["navigation"][number] {
  return {
    userId,
    deviceId,
    logicalTabId,
    canJump,
    disabledReason: canJump ? null : "MEDIA_MEMBER_TAB_UNBOUND",
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
