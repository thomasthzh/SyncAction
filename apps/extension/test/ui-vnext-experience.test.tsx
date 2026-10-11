// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { PublicRoomFeed } from "../src/ui-vnext/components/public-room-feed.js";
import type { UiCommandResult } from "../src/ui/ui-protocol.js";
import { createVisualStore, FIXTURE_NOW_MS } from "../visual/fixture-store.js";
import {
  TestUiStore,
  byRole,
  click,
  failure,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

afterEach(() => unmountPanel());

function denseRoom(): TestUiStore {
  const fixture = createVisualStore("room");
  const store = new TestUiStore();
  store.update({
    shell: fixture.shell.value,
    discovery: fixture.discovery.value,
    room: fixture.room.value,
    collaboration: fixture.collaboration.value,
    pageAccess: fixture.pageAccess.value,
  });
  return store;
}

describe("sidepanel everyday workflows", () => {
  it("gives a signed-out user a direct start action", async () => {
    const root = renderPanel(<App store={new TestUiStore()} />);
    await click(byRole(root, "button", "登录开始协作"));
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("name")).toBe("username");
  });

  it("uses the actual transport state for the header status", () => {
    const store = new TestUiStore();
    const root = renderPanel(<App store={store} />);
    expect(root.querySelector(".server-button .status-dot--online")).not.toBeNull();
    act(() => {
      store.transport.value = "RECONNECTING";
    });
    expect(root.querySelector(".server-button .status-dot--online")).toBeNull();
  });

  it("shows a disconnected room runtime even when its local UI port is connected", () => {
    const store = denseRoom();
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    act(() =>
      store.update({
        room: {
          ...store.room.value,
          runtime: { ...store.room.value.runtime!, state: "DISCONNECTED" },
        },
      }),
    );
    expect(root.querySelector(".server-button .status-dot--online")).toBeNull();
    expect(root.querySelector(".room-live-rail")?.textContent).toContain("恢复中");
    expect(root.querySelector(".active-room")?.textContent).toContain("连接正在恢复");
  });

  it.each(["room", "profile"])(
    "isolates pending command feedback when the %s context changes",
    async (context) => {
      const store = denseRoom();
      let resolve!: (result: UiCommandResult) => void;
      store.responder = () =>
        new Promise<UiCommandResult>((resolvePromise) => {
          resolve = resolvePromise;
        });
      const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
      await click(byRole(root, "button", "分享当前页"));
      expect((byRole(root, "button", "分享当前页") as HTMLButtonElement).disabled).toBe(true);
      act(() => {
        if (context === "room") {
          store.update({
            room: { ...store.room.value, selectedRoomId: store.discovery.value.rooms[1]!.id },
          });
        } else {
          const profile = {
            ...store.shell.value.profiles[0]!,
            profileId: "another-server",
            baseUrl: "https://another.example",
          };
          store.update({
            shell: {
              ...store.shell.value,
              selectedProfileId: profile.profileId,
              profiles: [...store.shell.value.profiles, profile],
            },
          });
        }
      });
      expect((byRole(root, "button", "分享当前页") as HTMLButtonElement).disabled).toBe(false);
      await act(async () => {
        resolve(success({ kind: "INTENT_RECORDED" }));
        await Promise.resolve();
      });
      expect(root.querySelector('.bottom-action-dock [role="status"]')).toBeNull();
      expect(root.querySelector("#syncaction-live-status")?.textContent).not.toContain(
        "当前页面已提交分享",
      );
    },
  );

  it("guards repeated joins and restores the action after a network exception", async () => {
    const rooms = createVisualStore("lobby").discovery.value.publicRooms;
    let reject!: (reason: Error) => void;
    const onJoin = vi.fn(
      () =>
        new Promise<UiCommandResult>((_, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const root = renderPanel(
      <PublicRoomFeed rooms={rooms} onJoin={onJoin} onRefresh={async () => success()} />,
    );
    const button = root.querySelector<HTMLButtonElement>(".room-join-button")!;
    act(() => {
      button.click();
      button.click();
    });
    expect(onJoin).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      reject(new Error("offline"));
      await Promise.resolve();
    });
    expect(root.textContent).toContain("网络连接失败");
    expect(button.disabled).toBe(false);
  });

  it("shows an approval result and clears a local room search without fetching", async () => {
    const rooms = createVisualStore("lobby").discovery.value.publicRooms;
    const refresh = vi.fn(async () => success());
    const root = renderPanel(
      <PublicRoomFeed rooms={rooms} onJoin={async () => success()} onRefresh={refresh} />,
    );
    await click(byRole(root, "button", "申请加入"));
    expect(root.querySelector('[role="status"]')?.textContent).toContain("加入申请已发送");
    input(root.querySelector('input[type="search"]')!, "周末");
    expect(root.querySelectorAll(".public-room-row")).toHaveLength(1);
    await click(byRole(root, "button", "清空房间搜索"));
    expect(root.querySelectorAll(".public-room-row")).toHaveLength(3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reports share results visibly and preserves retry after failure", async () => {
    const store = denseRoom();
    store.responder = async () => failure("ROOM_TAB_LIMIT_REACHED");
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    await click(byRole(root, "button", "分享当前页"));
    expect(root.querySelector(".bottom-action-dock")?.textContent).toContain(
      "最多共享 20 个标签页",
    );
    store.responder = async () => success({ kind: "INTENT_RECORDED" });
    await click(byRole(root, "button", "分享当前页"));
    expect(root.querySelector('.bottom-action-dock [role="status"]')?.textContent).toBe(
      "当前页面已提交分享",
    );
  });

  it("recognizes a page that is already shared without claiming a new submission", async () => {
    const store = denseRoom();
    store.responder = async () => success({ kind: "IGNORED", reason: "NO_CHANGE" });
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    await click(byRole(root, "button", "分享当前页"));
    expect(root.querySelector('.bottom-action-dock [role="status"]')?.textContent).toBe(
      "当前页面已在共享列表中",
    );
    expect(root.querySelector("#syncaction-live-status")?.textContent).not.toContain("已提交分享");
  });

  it.each([
    [{ kind: "BLOCKED", reason: "ROOM_TAB_LIMIT_REACHED" }, "最多共享 20 个标签页"],
    [{ kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" }, "房间尚未准备好"],
    [{ kind: "IGNORED", reason: "LOADING" }, "页面仍在加载"],
    [{ kind: "IGNORED", reason: "PERSONAL_TAB" }, "当前页面未分享"],
    [{ kind: "RECOVERY_REQUIRED", reason: "STALE_BROWSER_SESSION" }, "房间的恢复提示"],
    [undefined, "尚未确认分享结果"],
    [null, "尚未确认分享结果"],
    [{ kind: "UNRECOGNIZED" }, "尚未确认分享结果"],
  ])("does not report a submitted share for %j", async (value, expectedText) => {
    const store = denseRoom();
    store.responder = async () => success(value);
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    await click(byRole(root, "button", "分享当前页"));
    expect(root.querySelector(".bottom-action-dock")?.textContent).toContain(expectedText);
    expect(root.querySelector('.bottom-action-dock [role="status"]')).toBeNull();
    expect(root.querySelector("#syncaction-live-status")?.textContent).not.toContain("已提交分享");
    expect((byRole(root, "button", "分享当前页") as HTMLButtonElement).disabled).toBe(false);
  });

  it("filters shared pages by title or domain without issuing commands", () => {
    const store = denseRoom();
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    input(root.querySelector('input[aria-label="搜索共享页面"]')!, "video.example");
    expect(root.querySelectorAll("[data-page-id]")).toHaveLength(1);
    expect(root.textContent).toContain("发布会回放");
    expect(store.commandCalls).toHaveLength(0);
  });

  it("makes room switching usable with arrow keys and Escape", async () => {
    const store = denseRoom();
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    const trigger = byRole(root, "button", "切换房间");
    await click(trigger);
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("界面评审");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([false, true])("moves focus out of the room menu on Tab (shift=%s)", async (shiftKey) => {
    const root = renderPanel(<App store={denseRoom()} now={() => FIXTURE_NOW_MS} />);
    const trigger = byRole(root, "button", "切换房间");
    await click(trigger);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
      );
    });
    expect(root.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    if (shiftKey) expect(document.activeElement).toBe(trigger);
    else expect(document.activeElement?.closest(".playback-card")).not.toBeNull();
  });

  it("shows playback command failures instead of silently dropping them", async () => {
    const store = denseRoom();
    store.responder = async () => failure("NETWORK_ERROR");
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    await click(root.querySelector<HTMLButtonElement>(".playback-card__summary button")!);
    expect(root.querySelector(".active-room > .inline-status--error")?.textContent).toContain(
      "网络连接失败",
    );
  });
});
