// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { LogicalTabIdSchema } from "@syncaction/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { InvitePicker } from "../src/ui-vnext/components/invite-picker.js";
import { recoveryResult } from "../src/ui-vnext/recovery-result.js";
import { createVisualStore } from "../visual/fixture-store.js";
import type { PendingRoomJoin } from "../src/pending-room-join.js";
import {
  TestUiStore,
  byRole,
  click,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

afterEach(() => {
  unmountPanel();
  vi.useRealTimers();
});
function scenario(fixture: "room" | "lobby") {
  const source = createVisualStore(fixture);
  const store = new TestUiStore();
  store.update({
    shell: source.shell.value,
    discovery: source.discovery.value,
    room: source.room.value,
    collaboration: source.collaboration.value,
    pageAccess: source.pageAccess.value,
  });
  return store;
}
const requestId = "00000000-0000-4000-8000-00000000a001";
const invitationId = "00000000-0000-4000-8000-00000000a002";

describe("complete collaboration tasks", () => {
  it("keeps the first-watch task alive when sharing adds the first room page", async () => {
    const store = scenario("room");
    const page = store.collaboration.value.pages[0]!;
    const revision = store.pageAccess.value.documentRevision!;
    const url = "https://video.example/first";
    store.update({
      collaboration: { ...store.collaboration.value, pages: [] },
      pageAccess: { ...store.pageAccess.value, documentRevision: null, url },
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          media: { ...store.room.value.runtime!.media!, playbackGroups: [], localMembership: null },
        },
      },
    });
    store.responder = async (command) => {
      if (command.name === "CURRENT_TAB_SHARE") {
        store.update({ collaboration: { ...store.collaboration.value, pages: [page] } });
        return success({
          kind: "INTENT_RECORDED",
          sharedPageContext: { tabId: store.pageAccess.value.tabId, url },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "开始一起看"));
    await vi.waitFor(() =>
      expect(root.querySelector('[data-watch-stage="WAITING_PAGE"]')).not.toBeNull(),
    );
    act(() =>
      store.update({ pageAccess: { ...store.pageAccess.value, documentRevision: revision } }),
    );
    await vi.waitFor(() => expect(store.commandCalls.at(-1)?.name).toBe("MEDIA_GROUP_CREATE"));
    expect(
      store.commandCalls.filter((command) => command.name === "CURRENT_TAB_SHARE"),
    ).toHaveLength(1);
  });
  it("starts at the existing shared scene before offering an unrelated current video", async () => {
    const store = scenario("room");
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          media: { ...store.room.value.runtime!.media!, playbackGroups: [], localMembership: null },
        },
      },
    });
    const root = renderPanel(<App store={store} />);
    expect(root.querySelector('[aria-labelledby="room-meeting-title"]')).not.toBeNull();
    const action = root.querySelector<HTMLButtonElement>(".meeting-page button")!;
    await click(action);
    expect(store.commandCalls.at(-1)).toMatchObject({
      name: "ROOM_TAB_ACTIVATE",
      payload: {
        expectedContext: {
          profileId: store.shell.value.selectedProfileId,
          roomId: store.room.value.selectedRoomId,
        },
      },
    });
    expect(
      store.commandCalls.some(
        (command) => command.name === "CURRENT_TAB_SHARE" || command.name === "MEDIA_GROUP_CREATE",
      ),
    ).toBe(false);
  });

  it("finds pending pages after switching away, including an orphan, and previews without publishing", async () => {
    const store = scenario("room");
    const logicalTabId = store.collaboration.value.pages[0]!.pageId;
    const removed = LogicalTabIdSchema.parse("00000000-0000-4000-8000-00000000c099");
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          browser: {
            ...store.room.value.runtime!.browser!,
            pendingPublications: [
              { tabId: 84, logicalTabId },
              { tabId: 85, logicalTabId: removed },
            ],
          },
        },
      },
    });
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "2 个本机页面尚未提交"));
    expect(root.textContent).toContain("原共享页已不在房间");
    expect(root.querySelector(`[data-page-id="${logicalTabId}"]`)?.textContent).toContain(
      "1 个本机页面待提交",
    );
    await click(root.querySelector<HTMLButtonElement>(".local-page-update button")!);
    expect(store.commandCalls).toEqual([
      {
        name: "LOCAL_PAGE_ACTIVATE",
        payload: {
          tabId: 84,
          logicalTabId,
          profileId: store.shell.value.selectedProfileId,
          roomId: store.room.value.selectedRoomId,
        },
      },
    ]);
  });

  it("lets a member with several device pages choose an exact shared page without media navigation", async () => {
    const store = scenario("room");
    const target = store.collaboration.value.members[1]!;
    const ids = store.collaboration.value.pages.slice(0, 2).map((page) => page.pageId);
    store.update({
      collaboration: {
        ...store.collaboration.value,
        members: store.collaboration.value.members.map((member) =>
          member.userId === target.userId
            ? { ...member, activePageIds: ids, deviceCount: 2 }
            : member,
        ),
      },
      room: { ...store.room.value, runtime: { ...store.room.value.runtime!, media: null } },
    });
    const root = renderPanel(<App store={store} />);
    await click(root.querySelector("#room-workspace-tab-members")!);
    const choices = root.querySelector(
      `.workspace-member-row[data-member-id="${target.userId}"] details`,
    )!;
    expect(choices).not.toBeNull();
    const buttons = choices.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    await click(buttons[1]!);
    expect(store.commandCalls.at(-1)).toMatchObject({
      name: "ROOM_TAB_ACTIVATE",
      payload: { logicalTabId: ids[1] },
    });
    expect(store.commandCalls.some((command) => command.name === "MEDIA_MEMBER_JUMP")).toBe(false);
  });
  it("receives a confirmed request after reopening before its original response", async () => {
    const store = scenario("lobby");
    const target = store.discovery.value.publicRooms.find(
      (room) => room.joinPolicy === "APPROVAL",
    )!;
    const profile = store.shell.value.profiles[0]!;
    const saved: PendingRoomJoin = {
      version: 1,
      profileId: profile.profileId,
      serverOrigin: profile.baseUrl,
      serverId: profile.metadata!.serverId,
      roomId: target.roomId,
      roomName: target.name,
      joinPolicy: "APPROVAL",
      stage: "READY",
      accountId: store.shell.value.account!.id,
    };
    let changed!: (intent: PendingRoomJoin | null) => void;
    const storage = {
      read: async () => saved,
      write: vi.fn(async () => undefined),
      subscribe: (listener: typeof changed) => {
        changed = listener;
        return () => undefined;
      },
    };
    const root = renderPanel(<App store={store} pendingRoomJoinStorage={storage} />);
    await vi.waitFor(() => expect(root.textContent).toContain(`继续加入 ${target.name}`));
    act(() => changed({ ...saved, stage: "REQUESTED", requestId }));
    await vi.waitFor(() => expect(store.commandCalls).toContainEqual({ name: "PRODUCT_REFRESH" }));
    expect(root.textContent).toContain("正在等待房主批准");
    expect(root.textContent).toContain("撤回申请");
    expect(store.commandCalls.some((command) => command.name === "ROOM_JOIN_REQUEST")).toBe(false);
  });
  it("opens and prepares the chosen video, then waits for a genuine observation before joining", async () => {
    const store = scenario("room");
    const group = store.room.value.runtime!.media!.playbackGroups[0]!;
    store.update({
      pageAccess: {
        ...store.pageAccess.value,
        logicalTabId: null,
        tabId: 91,
        documentRevision: null,
      },
    });
    store.responder = async (command) => {
      if (command.name === "ROOM_TAB_ACTIVATE")
        store.update({
          pageAccess: {
            ...store.pageAccess.value,
            tabId: 42,
            logicalTabId: group.target!.logicalTabId,
            documentRevision: group.target!.documentRevision,
          },
        });
      return success();
    };
    const root = renderPanel(<App store={store} />);
    const card = root.querySelector(`[data-group-id="${group.playbackGroupId}"]`)!;
    await click(byRole(card, "button", "打开并一起看"));
    expect(store.commandCalls.map((command) => command.name)).toEqual([
      "ROOM_TAB_ACTIVATE",
      "PAGE_PERMISSION_REFRESH",
      "MEDIA_GROUP_PREPARE",
    ]);
    expect(root.textContent).toContain("正在识别这段视频");
    act(() =>
      store.update({
        room: {
          ...store.room.value,
          runtime: {
            ...store.room.value.runtime!,
            media: {
              ...store.room.value.runtime!.media!,
              localObservation: { target: group.target!, observed: group.observed! },
            },
          },
        },
      }),
    );
    await vi.waitFor(() => expect(store.commandCalls.at(-1)?.name).toBe("MEDIA_GROUP_JOIN"));
    expect(store.commandCalls.at(-1)).toMatchObject({
      payload: { expectedTarget: group.target, expectedContext: { tabId: 42 } },
    });
    expect(store.commandCalls.some((command) => command.name === "CURRENT_TAB_SHARE")).toBe(false);
  });

  it("does not continue a late preparation on another local tab", async () => {
    const store = scenario("room");
    let complete!: (value: ReturnType<typeof success>) => void;
    store.responder = async (command) =>
      command.name === "MEDIA_GROUP_PREPARE"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : success();
    const root = renderPanel(<App store={store} />);
    await click(byRole(root.querySelector("[data-group-id]")!, "button", "打开并一起看"));
    await act(async () => {
      store.update({ pageAccess: { ...store.pageAccess.value, tabId: 99 } });
      complete(success());
    });
    expect(store.commandCalls.some((command) => command.name === "MEDIA_GROUP_JOIN")).toBe(false);
    expect(root.textContent).toContain("页面或房间已变化");
  });

  it("keeps an approval request, refreshes progress, and enters the approved room without requesting again", async () => {
    const store = scenario("lobby");
    const target = store.discovery.value.publicRooms.find(
      (room) => room.joinPolicy === "APPROVAL",
    )!;
    const storage = { read: async () => null, write: vi.fn(async () => undefined) };
    store.responder = async (command) => {
      if (command.name === "ROOM_JOIN_REQUEST")
        return success({
          requestId,
          roomId: target.roomId,
          applicant: {
            userId: store.shell.value.account!.id,
            username: "tester",
            displayName: "测试成员",
          },
          status: "PENDING",
          createdAt: "2026-11-13T00:00:00.000Z",
          decidedAt: null,
        });
      if (command.name === "PRODUCT_REFRESH")
        store.update({
          discovery: {
            ...store.discovery.value,
            publicRooms: [],
            rooms: [
              ...store.discovery.value.rooms,
              {
                ...store.discovery.value.rooms[0]!,
                id: target.roomId,
                name: target.name,
                role: "MEMBER",
              },
            ],
          },
        });
      return success();
    };
    const root = renderPanel(<App store={store} pendingRoomJoinStorage={storage} />);
    await click(root.querySelector("#lobby-workspace-tab-discover")!);
    await click(byRole(root, "button", "申请加入"));
    expect(root.textContent).toContain("正在等待房主批准");
    expect(byRole(root, "button", "等待批准").hasAttribute("disabled")).toBe(true);
    expect(storage.write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: "REQUESTED",
        requestId,
        accountId: store.shell.value.account!.id,
      }),
    );
    await click(byRole(root, "button", "查看进度"));
    expect(store.commandCalls.map((command) => command.name)).toEqual([
      "ROOM_JOIN_REQUEST",
      "PRODUCT_REFRESH",
      "ROOM_SELECT",
    ]);
    expect(storage.write).toHaveBeenLastCalledWith(null);
  });

  it("keeps failed invitees visible across searches and retries only them", async () => {
    vi.useFakeTimers();
    const store = scenario("room");
    const users = [1, 2].map((index) => ({
      userId: `00000000-0000-4000-8000-00000000b00${index}`,
      username: `tester${index}`,
      displayName: `测试${index}`,
      online: true,
    }));
    let round = 0;
    store.responder = async (command) => {
      if (command.name === "DIRECTORY_SEARCH") return success({ items: users, nextCursor: null });
      if (command.name === "INVITE_BATCH") {
        round += 1;
        return success(
          round === 1
            ? [
                { userId: users[0]!.userId, status: "CREATED", invitationId },
                { userId: users[1]!.userId, status: "FORBIDDEN", invitationId: null },
              ]
            : [{ userId: users[1]!.userId, status: "ALREADY_PENDING", invitationId: null }],
        );
      }
      return success();
    };
    const root = renderPanel(<InvitePicker store={store} onBack={() => undefined} />);
    input(root.querySelector('input[type="search"]')!, "tester");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) await click(checkbox);
    await click(byRole(root, "button", "发送邀请"));
    expect(root.querySelector('[aria-label="已选成员"]')?.textContent).toContain("测试2");
    expect(root.querySelector('[aria-label="已选成员"]')?.textContent).not.toContain("测试1");
    expect(root.textContent).toContain("邀请已发送");
    expect(root.textContent).toContain("暂时无法邀请");
    await click(byRole(root, "button", "发送邀请"));
    expect(store.commandCalls.at(-1)).toMatchObject({
      payload: {
        userIds: [users[1]!.userId],
        expectedContext: { roomId: store.room.value.selectedRoomId },
      },
    });
  });

  it("does not turn blocked, pending or missing browser outcomes into success", () => {
    expect(recoveryResult(success({ kind: "SYNCHRONIZED", effectsApplied: 3 })).ok).toBe(true);
    for (const value of [
      undefined,
      { kind: "BLOCKED", reason: "STALE_BINDINGS", effectsApplied: 0 },
      { kind: "CONFIRMATION_REQUIRED", missingTabCount: 2, effectsApplied: 0 },
    ])
      expect(recoveryResult(success(value)).ok).toBe(false);
  });
});
