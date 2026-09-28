// @vitest-environment happy-dom

import {
  CanonicalUuidSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type PlaybackGroupSnapshot,
} from "@syncaction/protocol";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { ActionableStatus } from "../src/ui-vnext/components/actionable-status.js";
import { avatarForMember, createSharedTabRows } from "../src/ui/collaboration-view-model.js";
import { createMediaViewModel } from "../src/ui/media-view-model.js";
import {
  ExtensionCollaborationSummarySchema,
  UiDiscoverySliceSchema,
  UiRoomSliceSchema,
} from "../src/ui/ui-protocol.js";
import {
  TestUiStore,
  byRole,
  change,
  click,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

const nowMs = 1_785_369_600_000;
const roomId = RoomIdSchema.parse("00000000-0000-4000-8000-000000000501");
const otherRoomId = RoomIdSchema.parse("00000000-0000-4000-8000-000000000502");
const videoPageId = LogicalTabIdSchema.parse("00000000-0000-4000-8000-000000000511");
const documentPageId = LogicalTabIdSchema.parse("00000000-0000-4000-8000-000000000512");
const groupId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000521");
const smallerGroupId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000522");
const proposalId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000523");
const ownerId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000531");
const leaderId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000532");
const followerAId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000533");
const followerBId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000534");
const documentViewerId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000535");
const offlineId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000536");
const leaderDeviceId = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000541");
const followerADeviceId = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000542");
const followerBDeviceId = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000543");
const ownerDeviceId = DeviceIdSchema.parse("00000000-0000-4000-8000-000000000544");

afterEach(() => unmountPanel());

describe("vNext active room", () => {
  it("keeps room identity, playback, shared pages, and clustered members in one surface", async () => {
    const store = roomStore();
    const root = renderPanel(<App store={store} now={() => nowMs} />);

    expect(root.textContent).toContain("联合研究室");
    expect(root.textContent).toContain("5 在线 · 6 位成员");
    expect(root.textContent).toContain("syncaction.example.com");
    expect(root.querySelector("[data-room-presence-summary]")).not.toBeNull();
    const liveRail = root.querySelector("[data-room-live-rail]");
    expect(liveRail).not.toBeNull();
    expect(liveRail?.textContent).toContain("5 在线");
    expect(liveRail?.textContent).toContain("2 个页面");
    expect(liveRail?.textContent).toContain("1 个播放组");
    const playbackSurface = root.querySelector('[data-editorial-surface="playback"]')!;
    const sharedPagesSurface = root.querySelector('[data-editorial-surface="shared-pages"]')!;
    const dock = root.querySelector("[data-bottom-action-dock]")!;
    expect(playbackSurface).not.toBeNull();
    expect(sharedPagesSurface).not.toBeNull();
    expect(
      playbackSurface.compareDocumentPosition(sharedPagesSurface) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      sharedPagesSurface.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await click(byRole(root, "button", "切换房间"));
    expect(root.textContent).toContain("我的房间");
    await click(byRole(root, "button", "备用房间"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_SELECT",
      payload: { roomId: otherRoomId },
    });

    expect(
      root.querySelector(`[data-user-id="${ownerId}"][data-current-user="true"]`),
    ).not.toBeNull();
    const videoRow = root.querySelector(`[data-page-id="${videoPageId}"]`)!;
    const documentRow = root.querySelector(`[data-page-id="${documentPageId}"]`)!;
    const groupCard = root.querySelector(`[data-group-id="${groupId}"]`)!;
    expect(groupCard.classList.contains("playback-group-row")).toBe(true);
    expect(videoRow.textContent).toContain("发布会回放");
    expect(videoRow.textContent).toContain("video.example");
    expect(videoRow.querySelector("[data-favicon-fallback]")).not.toBeNull();
    expect(videoRow.textContent).toContain("页面一致性尚未验证");
    expect(groupCard.textContent).toContain("YouTube");
    expect(groupCard.textContent).toContain("领播 林岚");
    expect(groupCard.textContent).toContain("03:24 / 10:00");
    expect(groupCard.textContent).toContain("3 人");
    expect(groupCard.textContent).toContain("跳转并同步");
    expect(documentRow.textContent).toContain("协作文档");
    expect(documentRow.textContent).toContain("docs.example");
    expect(documentRow.textContent).not.toContain("对齐一次");
    expect(documentRow.textContent).not.toContain("加入播放组");

    const cluster = groupCard.querySelector(`[data-playback-group-id="${groupId}"]`)!;
    expect(cluster.textContent).toContain("林岚");
    expect(cluster.textContent).toContain("小周");
    expect(cluster.textContent).toContain("阿青");
    expect(groupCard.textContent).toContain("对齐一次");
    expect(groupCard.textContent).toContain("加入播放组");

    await click(byRole(videoRow, "button", "跳转"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_TAB_ACTIVATE",
      payload: { logicalTabId: videoPageId },
    });
    await click(byRole(cluster, "button", "查看 林岚 当前页面"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "MEDIA_MEMBER_JUMP",
      payload: { userId: leaderId },
    });
    await click(byRole(videoRow, "button", "查看 房主 Alex 当前页面"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "MEDIA_MEMBER_JUMP",
      payload: { userId: ownerId },
    });
    await click(byRole(documentRow, "button", "查看 文档用户 当前页面"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_TAB_ACTIVATE",
      payload: { logicalTabId: documentPageId },
    });
    await click(byRole(groupCard, "button", "对齐一次"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "MEDIA_GROUP_ALIGN_ONCE",
      payload: { playbackGroupId: groupId },
    });
    await click(byRole(groupCard, "button", "加入播放组"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "MEDIA_GROUP_JOIN",
      payload: { playbackGroupId: groupId },
    });
  });

  it("sorts default groups by size then progress and keeps avatar identity stable", () => {
    const store = roomStore();
    const media = store.room.value.runtime!.media!;
    const view = createMediaViewModel({
      media: {
        ...media,
        recommendedPlaybackGroupId: smallerGroupId,
        playbackGroups: [
          playbackGroup({
            playbackGroupId: smallerGroupId,
            members: [media.playbackGroups[0]!.members[0]!, media.playbackGroups[0]!.members[1]!],
            observed: {
              ...media.playbackGroups[0]!.observed!,
              positionMs: 500_000,
              paused: true,
            },
          }),
          media.playbackGroups[0]!,
        ],
      },
      pages: store.collaboration.value.pages,
      members: store.collaboration.value.members,
      nowMs,
    });

    expect(view.groups.map(({ groupId: id }) => id)).toEqual([groupId, smallerGroupId]);
    expect(view.recommendedPlaybackGroupId).toBe(groupId);
    expect(view.groups[0]).toMatchObject({
      isDefaultForUngroupedViewer: true,
      progressSeconds: 204,
    });
    expect(avatarForMember("林 岚", leaderId)).toEqual(avatarForMember("林 岚", leaderId));
    expect(avatarForMember("林 岚", leaderId)).toMatchObject({
      initials: "林岚",
      paletteToken: expect.stringMatching(/^avatar-[1-6]$/u),
    });

    const tieByProgress = createMediaViewModel({
      media: {
        ...media,
        playbackGroups: [
          media.playbackGroups[0]!,
          playbackGroup({
            playbackGroupId: smallerGroupId,
            observed: {
              ...media.playbackGroups[0]!.observed!,
              positionMs: 500_000,
              paused: true,
            },
          }),
        ],
        localMembership: null,
      },
      pages: store.collaboration.value.pages,
      members: store.collaboration.value.members,
      nowMs,
    });
    expect(tieByProgress.groups.map(({ groupId: id }) => id)).toEqual([smallerGroupId, groupId]);
    expect(tieByProgress.recommendedPlaybackGroupId).toBe(smallerGroupId);
  });

  it("sorts shared pages by current viewer, viewer count, and normalized title", () => {
    const store = roomStore();
    const rows = createSharedTabRows({
      pages: [
        { pageId: documentPageId, title: "Ｂ 文档", domain: "docs.example", state: "OPEN" },
        { pageId: videoPageId, title: "A 视频", domain: "video.example", state: "OPEN" },
      ],
      members: store.collaboration.value.members,
      currentUserId: ownerId,
      compatibilityByPage: {
        [videoPageId]: "UNKNOWN",
        [documentPageId]: "EXACT",
      },
    });

    expect(rows.map(({ pageKey }) => pageKey)).toEqual([videoPageId, documentPageId]);
    expect(rows[0]).toMatchObject({
      viewerAccountIds: expect.arrayContaining([ownerId, leaderId, followerAId, followerBId]),
      compatibility: "UNKNOWN",
      url: "https://video.example",
    });
  });

  it("shows leader proposals and sends exact accept/reject commands", async () => {
    const store = roomStore({
      currentUserId: leaderId,
      localMembership: {
        playbackGroupId: groupId,
        role: "LEADER",
        activeDevice: true,
      },
    });
    const root = renderPanel(<App store={store} now={() => nowMs} />);

    expect(root.textContent).toContain("小周建议调整进度");
    await click(byRole(root, "button", "同意"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "MEDIA_PROPOSAL_DECIDE",
      payload: {
        playbackGroupId: groupId,
        proposalId,
        decision: "APPROVE",
      },
    });
    await click(byRole(root, "button", "拒绝"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "MEDIA_PROPOSAL_DECIDE",
      payload: {
        playbackGroupId: groupId,
        proposalId,
        decision: "REJECT",
      },
    });
  });

  it.each([
    ["FOLLOWER", true, "退出播放组", "MEDIA_GROUP_LEAVE"],
    ["LEADER", true, "关闭播放组", "MEDIA_GROUP_CLOSE"],
    ["FOLLOWER", false, "在此设备接管", "MEDIA_DEVICE_TAKEOVER"],
  ] as const)(
    "offers explicit %s lifecycle action without ending the group automatically",
    async (role, activeDevice, label, commandName) => {
      const store = roomStore({
        currentUserId: role === "LEADER" ? leaderId : followerAId,
        localMembership: {
          playbackGroupId: groupId,
          role,
          activeDevice,
        },
        groupStatus: "ENDED_WAITING",
      });
      const root = renderPanel(<App store={store} now={() => nowMs} />);

      expect(root.textContent).toContain("已结束，等待领播者切换");
      expect(store.commandCalls).toHaveLength(0);
      await click(byRole(root, "button", label));
      expect(store.commandCalls.at(-1)).toEqual({
        name: commandName,
        payload: { playbackGroupId: groupId },
      });
    },
  );

  it("maps distinct actionable states to one valid recovery action", async () => {
    const recoveries: string[] = [];
    const cases = [
      ["LOADING", "正在载入房间", null],
      ["RECONNECTING", "连接正在恢复", null],
      ["WAITING_SNAPSHOT", "等待房间快照", null],
      ["PAGE_PERMISSION_REQUIRED", "允许当前站点", "ALLOW_PAGE"],
      ["PROTECTED_PAGE", "浏览器保护页", null],
      ["CONTENT_MISMATCH", "页面内容与对方不同", null],
      ["SERVER_UNSUPPORTED", "当前服务器不支持此功能", "SWITCH_SERVER"],
      ["CLIENT_UPGRADE_REQUIRED", "客户端版本过旧", "UPGRADE_CLIENT"],
      ["ROOM_CAPACITY_REACHED", "最多创建 5 个房间", null],
      ["ROOM_TAB_LIMIT_REACHED", "最多共享 20 个标签页", null],
      ["RECOVERY_REQUIRED", "需要确认恢复", "CONFIRM_RECOVERY"],
      ["CIRCUIT_BREAKER", "同步已暂停以保护标签页", "CONFIRM_RECOVERY"],
      ["NETWORK_ERROR", "网络连接失败", "RETRY"],
    ] as const;

    for (const [statusCode, copy, action] of cases) {
      const root = renderPanel(
        <ActionableStatus statusCode={statusCode} onAction={(next) => recoveries.push(next)} />,
      );
      expect(root.textContent).toContain(copy);
      const button = root.querySelector("button");
      if (action === null) {
        expect(button).toBeNull();
      } else {
        expect(button).not.toBeNull();
        await click(button!);
        expect(recoveries.at(-1)).toBe(action);
      }
      unmountPanel();
    }
  });

  it("keeps every frequent room action reachable in the 320px bottom dock", async () => {
    const store = roomStore({ currentUserId: followerAId });
    const root = renderPanel(<App store={store} now={() => nowMs} />);
    root.style.width = "320px";

    const dock = root.querySelector<HTMLElement>("[data-bottom-action-dock]")!;
    expect(dock).not.toBeNull();
    for (const label of ["分享当前页", "邀请", "弹幕", "画笔", "退出房间"]) {
      expect(byRole(dock, "button", label)).toBeTruthy();
    }
    expect(dock.querySelectorAll(".dock-tool__label")).toHaveLength(4);
    expect(dock.querySelectorAll('[role="tooltip"]')).toHaveLength(4);

    await click(byRole(dock, "button", "分享当前页"));
    expect(store.commandCalls.at(-1)).toEqual({ name: "CURRENT_TAB_SHARE" });

    await click(byRole(dock, "button", "退出房间"));
    expect(root.textContent).toContain("退出联合研究室");
    await click(byRole(root, "button", "确认退出房间"));
    expect(store.commandCalls.at(-1)).toEqual({ name: "ROOM_LEAVE" });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).toContain("6 位成员");

    act(() => {
      store.update({
        shell: {
          ...store.shell.value,
          phase: "AUTHENTICATED_NO_ROOM",
        },
        room: UiRoomSliceSchema.parse({
          selectedRoomId: null,
          detail: null,
          runtime: null,
        }),
        discovery: UiDiscoverySliceSchema.parse({
          ...store.discovery.value,
          rooms: store.discovery.value.rooms.filter(({ id }) => id !== roomId),
        }),
      });
    });
    expect(root.querySelector("[data-bottom-action-dock]")).toBeNull();
    expect(root.textContent).toContain("继续协作");
  });

  it("gives owners transfer and dissolve paths without a dead-end leave action", async () => {
    const store = roomStore();
    const root = renderPanel(<App store={store} now={() => nowMs} />);
    const dock = root.querySelector<HTMLElement>("[data-bottom-action-dock]")!;

    expect(dock.textContent).not.toContain("退出房间");
    await click(byRole(dock, "button", "房间操作"));
    expect(root.textContent).toContain("转让房主");
    expect(root.textContent).toContain("解散房间");

    await click(byRole(root, "button", "转让房主"));
    const target = root.querySelector<HTMLSelectElement>('select[name="transferTarget"]')!;
    expect([...target.options].map(({ value }) => value)).not.toContain(ownerId);
    expect([...target.options].map(({ value }) => value)).toContain(followerAId);
    change(target, followerAId);
    await click(byRole(root, "button", "确认转让房主"));

    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_OWNERSHIP_TRANSFER",
      payload: { userId: followerAId },
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("removes the member selected from the owner member menu", async () => {
    const store = roomStore();
    const root = renderPanel(<App store={store} now={() => nowMs} />);
    await click(byRole(root, "button", "房间操作"));
    await click(byRole(root, "button", "管理 小周"));
    await click(byRole(root, "button", "移除 小周"));

    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_MEMBER_REMOVE",
      payload: { userId: followerAId },
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("disables only the pending lifecycle action", async () => {
    const store = roomStore();
    const commandResult = deferred<Awaited<ReturnType<TestUiStore["command"]>>>();
    store.responder = async (command) =>
      command.name === "ROOM_DISSOLVE" ? commandResult.promise : success();
    const root = renderPanel(<App store={store} now={() => nowMs} />);
    await click(byRole(root, "button", "房间操作"));
    await click(byRole(root, "button", "解散房间"));
    input(root.querySelector<HTMLInputElement>('input[name="dissolveName"]')!, "联合研究室");

    const dissolve = byRole(root, "button", "确认解散") as HTMLButtonElement;
    act(() => dissolve.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(dissolve.disabled).toBe(true);
    expect((byRole(root, "button", "返回房间操作") as HTMLButtonElement).disabled).toBe(false);

    commandResult.resolve(success());
    await act(async () => {
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens explicit page permission before danmaku or pen commands", async () => {
    const store = roomStore();
    store.update({
      pageAccess: {
        bindings: null,
        tabId: 42,
        documentRevision: { roomEpoch: 1, tabUpdatedAtSeq: 2 },
        contentCompatibility: "UNKNOWN",
        origin: "https://video.example",
        supported: true,
        browserPermissionGranted: false,
        termsAccepted: false,
        serverTermsVersion: "2026-07-30",
        disclosureVersion: 1,
        enabledFeatures: [],
        policySyncPendingCount: 0,
        reason: "BROWSER_PERMISSION_REQUIRED",
      },
    });
    const capture = vi.fn(async () => ({
      profileId: store.shell.value.selectedProfileId,
      tabId: 42,
      documentRevision: { roomEpoch: 1, tabUpdatedAtSeq: 2 },
      origin: "https://video.example",
      feature: "DANMAKU" as const,
      serverTermsVersion: "2026-07-30",
      disclosureVersion: 1 as const,
      permissionPreviouslyGranted: false,
    }));
    const confirm = vi.fn(async () => ({
      granted: true,
      errorCode: null,
      policySyncPending: false,
    }));
    const root = renderPanel(
      <App store={store} now={() => nowMs} pagePermissionCoordinator={{ capture, confirm }} />,
    );
    const dock = root.querySelector<HTMLElement>("[data-bottom-action-dock]")!;
    await click(byRole(dock, "button", "弹幕"));

    expect(root.textContent).toContain("允许页面协作");
    expect(root.textContent).toContain("https://video.example");
    await vi.waitFor(() => {
      expect(byRole(root, "button", "允许当前站点")).toBeTruthy();
    });
    expect(capture).toHaveBeenCalledWith("DANMAKU");
    await click(root.querySelector<HTMLInputElement>('input[name="agreement"]')!);
    await click(byRole(root, "button", "允许当前站点"));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: store.shell.value.selectedProfileId,
        origin: "https://video.example",
        feature: "DANMAKU",
      }),
      true,
    );
    expect(store.commandCalls).not.toContainEqual({ name: "DANMAKU_TOGGLE" });
  });

  it("opens a queued keyboard-shortcut permission intent when the side panel mounts", async () => {
    const store = roomStore();
    const capture = vi.fn(async () => {
      throw new Error("BROWSER_PERMISSION_REQUIRED");
    });
    const root = renderPanel(
      <App
        store={store}
        now={() => nowMs}
        pagePermissionCoordinator={{ capture, confirm: vi.fn() }}
        initialPagePermissionIntent="pen"
      />,
    );

    await vi.waitFor(() => {
      expect(root.textContent).toContain("允许页面协作");
    });
    expect(capture).toHaveBeenCalledWith("DRAWING");
  });

  it("opens a keyboard-shortcut permission intent in an already mounted side panel", async () => {
    const store = roomStore();
    const capture = vi.fn(async () => {
      throw new Error("BROWSER_PERMISSION_REQUIRED");
    });
    let listener: ((intent: "danmaku" | "pen") => void) | undefined;
    const root = renderPanel(
      <App
        store={store}
        now={() => nowMs}
        pagePermissionCoordinator={{ capture, confirm: vi.fn() }}
        pagePermissionIntentSource={{
          subscribe: (next) => {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
        }}
      />,
    );

    act(() => listener?.("danmaku"));
    await vi.waitFor(() => {
      expect(root.textContent).toContain("允许页面协作");
    });
    expect(capture).toHaveBeenCalledWith("DANMAKU");
  });

  it("requires the exact room name before an owner can dissolve it", async () => {
    const store = roomStore();
    const root = renderPanel(<App store={store} now={() => nowMs} />);
    await click(byRole(root, "button", "房间操作"));
    await click(byRole(root, "button", "解散房间"));

    const confirmation = byRole(root, "button", "确认解散") as HTMLButtonElement;
    const roomName = root.querySelector<HTMLInputElement>('input[name="dissolveName"]')!;
    expect(confirmation.disabled).toBe(true);
    input(roomName, "联合研究");
    expect(confirmation.disabled).toBe(true);
    input(roomName, "联合研究室");
    expect(confirmation.disabled).toBe(false);
    await click(confirmation);

    expect(store.commandCalls.at(-1)).toEqual({ name: "ROOM_DISSOLVE" });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("enforces safe join-policy defaults while updating owner room settings", async () => {
    const store = roomStore();
    const root = renderPanel(<App store={store} now={() => nowMs} />);
    await click(byRole(root, "button", "房间操作"));
    await click(byRole(root, "button", "编辑房间设置"));

    const name = root.querySelector<HTMLInputElement>('input[name="lifecycleRoomName"]')!;
    const visibility = root.querySelector<HTMLSelectElement>('select[name="lifecycleVisibility"]')!;
    const joinPolicy = root.querySelector<HTMLSelectElement>('select[name="lifecycleJoinPolicy"]')!;
    change(visibility, "PRIVATE");
    expect(joinPolicy.value).toBe("INVITE_ONLY");
    change(visibility, "PUBLIC");
    expect(joinPolicy.value).toBe("APPROVAL");
    input(name, "远程评审室");
    await click(byRole(root, "button", "保存设置"));

    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_UPDATE",
      payload: {
        name: "远程评审室",
        visibility: "PUBLIC",
        joinPolicy: "APPROVAL",
      },
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });
});

function roomStore(
  options: {
    currentUserId?: string;
    localMembership?: {
      playbackGroupId: string;
      role: "LEADER" | "FOLLOWER" | "READ_ONLY";
      activeDevice: boolean;
    } | null;
    groupStatus?: PlaybackGroupSnapshot["status"];
  } = {},
): TestUiStore {
  const currentUserId = options.currentUserId ?? ownerId;
  const store = new TestUiStore();
  const members = [
    member(ownerId, "owner", "房主 Alex", "OWNER"),
    member(leaderId, "leader", "林岚", "MEMBER"),
    member(followerAId, "zhou", "小周", "MEMBER"),
    member(followerBId, "qing", "阿青", "MEMBER"),
    member(documentViewerId, "writer", "文档用户", "MEMBER"),
    member(offlineId, "offline", "离线成员", "MEMBER"),
  ];
  const accountMember = members.find(({ userId }) => userId === currentUserId)!;
  const currentRole = currentUserId === ownerId ? "OWNER" : "MEMBER";
  store.update({
    shell: {
      ...store.shell.value,
      phase: "ROOM_ACTIVE",
      account: {
        id: accountMember.userId,
        username: accountMember.username,
        displayName: accountMember.displayName,
        status: "ACTIVE",
        passwordResetRequired: false,
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    },
    discovery: UiDiscoverySliceSchema.parse({
      ...store.discovery.value,
      rooms: [
        roomSummary(roomId, "联合研究室", currentRole),
        roomSummary(otherRoomId, "备用房间", currentRole),
      ],
    }),
    room: UiRoomSliceSchema.parse({
      selectedRoomId: roomId,
      detail: {
        ...roomSummary(roomId, "联合研究室", currentRole),
        members,
        pendingInvitations: [],
      },
      runtime: runtime(options.localMembership ?? null, options.groupStatus ?? "PLAYING"),
    }),
    collaboration: ExtensionCollaborationSummarySchema.parse({
      capacity: {
        openTabCount: 2,
        limit: 20,
        exemption: "NOT_EXEMPT",
      },
      navigation: {
        canJump: true,
        disabledReason: null,
      },
      pages: [
        {
          pageId: videoPageId,
          title: "发布会回放",
          domain: "video.example",
          state: "OPEN",
        },
        {
          pageId: documentPageId,
          title: "协作文档",
          domain: "docs.example",
          state: "OPEN",
        },
      ],
      members: [
        collaborationMember(ownerId, "房主 Alex", "OWNER", true, [videoPageId]),
        collaborationMember(leaderId, "林岚", "MEMBER", true, [videoPageId]),
        collaborationMember(followerAId, "小周", "MEMBER", true, [videoPageId]),
        collaborationMember(followerBId, "阿青", "MEMBER", true, [videoPageId]),
        collaborationMember(documentViewerId, "文档用户", "MEMBER", true, [documentPageId]),
        collaborationMember(offlineId, "离线成员", "MEMBER", false, []),
      ],
      playbackGroups: [],
      tools: [],
      proposals: [],
      annotation: {
        used: 0,
        capacity: 2_000,
        lockedCount: 0,
        state: "AVAILABLE",
        canCreate: true,
        disabledReason: null,
      },
      activities: [],
    }),
  });
  return store;
}

function runtime(
  localMembership: {
    playbackGroupId: string;
    role: "LEADER" | "FOLLOWER" | "READ_ONLY";
    activeDevice: boolean;
  } | null,
  groupStatus: PlaybackGroupSnapshot["status"],
) {
  return {
    state: "SYNCED" as const,
    roomName: "联合研究室",
    serverSeq: 12,
    sharedTabCount: 2,
    outboxCount: 0,
    pendingConfirmationCount: 0,
    bindingCount: 2,
    browser: {
      state: "SYNCHRONIZED" as const,
      reason: null,
      missingTabCount: 0,
      effectsApplied: 2,
    },
    presence: {
      state: "ONLINE" as const,
      presences: [],
      lastAckExpiresAt: nowMs + 10_000,
      errorCode: null,
    },
    pointer: {
      state: "ONLINE" as const,
      lastAckExpiresAt: nowMs + 10_000,
      errorCode: null,
    },
    media: {
      state: "ONLINE" as const,
      roomMediaRevision: 12,
      playbackGroups: [playbackGroup({ status: groupStatus })],
      localObservation: null,
      localMembership,
      recommendedPlaybackGroupId: smallerGroupId,
      navigation: [
        navigation(ownerId, ownerDeviceId, videoPageId),
        navigation(leaderId, leaderDeviceId, videoPageId),
        navigation(followerAId, followerADeviceId, videoPageId),
        navigation(followerBId, followerBDeviceId, videoPageId),
      ],
      errorCode: null,
    },
    danmaku: null,
    drawing: null,
    tabs: [
      { logicalTabId: videoPageId, title: "发布会回放", domain: "video.example" },
      { logicalTabId: documentPageId, title: "协作文档", domain: "docs.example" },
    ],
  };
}

function playbackGroup(overrides: Partial<PlaybackGroupSnapshot> = {}): PlaybackGroupSnapshot {
  const status = overrides.status ?? "PLAYING";
  const observed =
    status === "ENDED_WAITING"
      ? {
          observedAtClientMs: nowMs - 4_000,
          positionMs: 600_000,
          paused: true,
          playbackRate: 1,
          ended: true,
          buffering: false,
        }
      : {
          observedAtClientMs: nowMs - 4_000,
          positionMs: 200_000,
          paused: false,
          playbackRate: 1,
          ended: false,
          buffering: false,
        };
  return {
    playbackGroupId: groupId,
    roomId,
    groupRevision: 8,
    status,
    leaderUserId: leaderId,
    leaderDeviceId,
    members: [
      groupMember(leaderId, "leader", "林岚", leaderDeviceId, nowMs - 30_000),
      groupMember(followerAId, "zhou", "小周", followerADeviceId, nowMs - 20_000),
      groupMember(followerBId, "qing", "阿青", followerBDeviceId, nowMs - 10_000),
    ],
    target: {
      logicalTabId: videoPageId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 11 },
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 600_000,
    },
    observed,
    observedAtServerMs: nowMs - 4_000,
    proposals: [
      {
        proposalId,
        proposedByUserId: followerAId,
        proposedByDeviceId: followerADeviceId,
        baseGroupRevision: 8,
        action: { type: "SEEK", positionMs: 260_000 },
        createdAtServerMs: nowMs,
        expiresAtServerMs: nowMs + 30_000,
      },
    ],
    leaderGraceExpiresAtServerMs: null,
    updatedAtServerMs: nowMs - 4_000,
    ...overrides,
  };
}

function roomSummary(id: string, name: string, role: "OWNER" | "MEMBER" = "OWNER") {
  return {
    id,
    name,
    role,
    roomEpoch: 0,
    visibility: "PUBLIC" as const,
    joinPolicy: "APPROVAL" as const,
    roomRevision: 1,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function member(userId: string, username: string, displayName: string, role: "OWNER" | "MEMBER") {
  return {
    userId,
    username,
    displayName,
    role,
    joinedAt: "2026-07-30T00:00:00.000Z",
  };
}

function collaborationMember(
  userId: string,
  displayName: string,
  roomRole: "OWNER" | "MEMBER",
  online: boolean,
  activePageIds: string[],
) {
  return {
    userId,
    displayName,
    roomRole,
    online,
    deviceCount: online ? 1 : 0,
    activePageIds,
  };
}

function groupMember(
  userId: string,
  username: string,
  displayName: string,
  activeDeviceId: PlaybackGroupSnapshot["members"][number]["activeDeviceId"],
  joinedAtServerMs: number,
) {
  return {
    userId,
    username,
    displayName,
    activeDeviceId,
    joinedAtServerMs,
    online: true,
  };
}

function navigation(userId: string, deviceId: string, logicalTabId: string) {
  return {
    userId,
    deviceId,
    logicalTabId,
    canJump: true,
    disabledReason: null,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}
