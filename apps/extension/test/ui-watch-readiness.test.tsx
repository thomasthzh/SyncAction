// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { createVisualStore } from "../visual/fixture-store.js";
import {
  TestUiStore,
  byRole,
  click,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

afterEach(unmountPanel);
function scenario() {
  const source = createVisualStore("room");
  const store = new TestUiStore();
  store.update({
    shell: source.shell.value,
    room: source.room.value,
    collaboration: source.collaboration.value,
    pageAccess: source.pageAccess.value,
  });
  const media = store.room.value.runtime!.media!;
  const group = media.playbackGroups[0]!;
  store.update({
    pageAccess: {
      ...store.pageAccess.value,
      logicalTabId: group.target!.logicalTabId,
      documentRevision: group.target!.documentRevision,
      termsAccepted: true,
      browserPermissionGranted: true,
    },
    room: {
      ...store.room.value,
      runtime: {
        ...store.room.value.runtime!,
        media: { ...media, localMembership: null, localObservation: null, controlReady: false },
      },
    },
  });
  return { store, group };
}

describe("watch readiness and continuity", () => {
  it("opens the group's video independently of the leader's other page and local bindings", async () => {
    const { store, group } = scenario();
    const media = store.room.value.runtime!.media!;
    const other = store.collaboration.value.pages.find(
      (page) => page.pageId !== group.target!.logicalTabId,
    )!;
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          media: {
            ...media,
            navigation: media.navigation.map((item) => ({
              ...item,
              logicalTabId: other.pageId,
              canJump: false,
            })),
          },
        },
      },
    });
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "打开视频页面"));
    expect(store.commandCalls).toEqual([
      {
        name: "ROOM_TAB_ACTIVATE",
        payload: {
          logicalTabId: group.target!.logicalTabId,
          expectedContext: {
            profileId: store.shell.value.selectedProfileId,
            roomId: store.room.value.selectedRoomId,
          },
        },
      },
    ]);
    const leader = group.members.find((member) => member.userId === group.leaderUserId)!;
    await click(byRole(root, "button", `查看 ${leader.displayName} 当前页面`));
    expect(store.commandCalls.at(-1)).toMatchObject({
      name: "ROOM_TAB_ACTIVATE",
      payload: { logicalTabId: other.pageId },
    });
    expect(store.commandCalls.some((command) => command.name === "MEDIA_MEMBER_JUMP")).toBe(false);
  });

  it("opens and prepares before one-time alignment without joining or publishing", async () => {
    const { store, group } = scenario();
    store.responder = async (command) => {
      if (command.name === "MEDIA_GROUP_PREPARE")
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
        });
      return success();
    };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "对齐一次"));
    await vi.waitFor(() => expect(store.commandCalls.at(-1)?.name).toBe("MEDIA_GROUP_ALIGN_ONCE"));
    expect(store.commandCalls.map(({ name }) => name)).toEqual([
      "ROOM_TAB_ACTIVATE",
      "PAGE_PERMISSION_REFRESH",
      "MEDIA_GROUP_PREPARE",
      "MEDIA_GROUP_ALIGN_ONCE",
    ]);
    expect(store.commandCalls.at(-1)).toMatchObject({
      payload: {
        expectedTarget: group.target,
        expectedContext: {
          roomId: store.room.value.selectedRoomId,
          documentRevision: group.target!.documentRevision,
        },
      },
    });
    await vi.waitFor(() => expect(root.textContent).toContain("不会持续跟随"));
    expect(store.room.value.runtime!.media!.localMembership).toBeNull();
  });

  it("stops a pending preparation and ignores its later response", async () => {
    const { store } = scenario();
    let resolve!: (value: ReturnType<typeof success>) => void;
    store.responder = async () =>
      new Promise((done) => {
        resolve = done;
      });
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "打开并一起看"));
    const stop = byRole(root, "button", "停止准备");
    stop.focus();
    await click(stop);
    expect(document.activeElement).toBe(root.querySelector('[data-editorial-surface="playback"]'));
    await act(async () => {
      resolve(success());
    });
    expect(store.commandCalls.map(({ name }) => name)).toEqual(["ROOM_TAB_ACTIVATE"]);
    expect(root.textContent).toContain("打开的页面仍保留");
  });

  it("returns from another workspace to the existing group without changing participation", async () => {
    const { store, group } = scenario();
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          media: {
            ...store.room.value.runtime!.media!,
            localMembership: {
              playbackGroupId: group.playbackGroupId,
              role: "FOLLOWER",
              activeDevice: true,
            },
          },
        },
      },
    });
    const root = renderPanel(<App store={store} />);
    await click(root.querySelector("#room-workspace-tab-pages")!);
    const bar = root.querySelector('[aria-label="我的一起看"]')!;
    expect(bar.textContent).toContain("本设备尚未跟上当前视频");
    await click(byRole(bar, "button", "返回我的播放组"));
    expect(root.querySelector("#room-workspace-panel-watch")?.hasAttribute("hidden")).toBe(false);
    expect(store.commandCalls).toEqual([]);
  });

  it("shows unknown presence while recovering and actual zero after an authoritative empty snapshot", async () => {
    const { store } = scenario();
    store.update({
      collaboration: {
        ...store.collaboration.value,
        presenceKnown: false,
        members: store.collaboration.value.members.map((member) => ({
          ...member,
          online: false,
          activePageIds: [],
        })),
      },
    });
    const root = renderPanel(<App store={store} />);
    expect(root.textContent).toContain("在线状态恢复中");
    expect(root.textContent).not.toContain("0 在线");
    await click(root.querySelector("#room-workspace-tab-members")!);
    expect(root.textContent).toContain("状态待同步");
    expect(root.textContent).not.toContain("当前不在线");
    act(() =>
      store.update({ collaboration: { ...store.collaboration.value, presenceKnown: true } }),
    );
    expect(root.textContent).toContain("0 在线");
    expect(root.textContent).toContain("当前不在线");
  });
});
