// @vitest-environment happy-dom
import { act } from "preact/test-utils";
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
