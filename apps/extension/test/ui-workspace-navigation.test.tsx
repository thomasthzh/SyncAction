// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { createVisualStore, FIXTURE_NOW_MS } from "../visual/fixture-store.js";
import { getFocusableElements, installFocusTrap } from "../src/ui-vnext/accessibility.js";
import {
  TestUiStore,
  byRole,
  change,
  click,
  input,
  renderPanel,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

afterEach(() => unmountPanel());

function fixture(name: "room" | "lobby" = "room"): TestUiStore {
  const source = createVisualStore(name);
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

describe("unified task workspaces", () => {
  it("includes disclosure summaries in modal keyboard navigation and skips their closed content", () => {
    const dialog = document.createElement("div");
    dialog.innerHTML =
      "<button>关闭</button><details><summary>服务详情</summary><button>重试</button></details>";
    document.body.append(dialog);
    const close = dialog.querySelector<HTMLButtonElement>("button")!;
    const summary = dialog.querySelector<HTMLElement>("summary")!;
    const retry = dialog.querySelectorAll<HTMLButtonElement>("button")[1]!;
    expect(getFocusableElements(dialog)).toEqual([close, summary]);
    const uninstall = installFocusTrap(dialog, close);
    close.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(summary);
    dialog.querySelector("details")!.open = true;
    expect(getFocusableElements(dialog)).toEqual([close, summary, retry]);
    uninstall();
    dialog.remove();
  });
  it("switches local room tasks without sending commands or losing viewed group and page search", async () => {
    const store = fixture();
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    const watch = root.querySelector<HTMLElement>("#room-workspace-panel-watch")!;
    const pages = root.querySelector<HTMLElement>("#room-workspace-panel-pages")!;
    const members = root.querySelector<HTMLElement>("#room-workspace-panel-members")!;
    expect([watch.hidden, pages.hidden, members.hidden]).toEqual([false, true, true]);
    const group = root.querySelector<HTMLSelectElement>('[aria-label="查看播放组"]')!;
    const selected = group.options[1]!.value;
    change(group, selected);
    await click(root.querySelector("#room-workspace-tab-pages")!);
    const search = root.querySelector<HTMLInputElement>('[aria-label="搜索共享页面"]')!;
    input(search, "产品路线");
    expect(pages.querySelectorAll("[data-page-id]")).toHaveLength(1);
    await click(root.querySelector("#room-workspace-tab-members")!);
    expect([watch.hidden, pages.hidden, members.hidden]).toEqual([true, true, false]);
    expect(members.querySelectorAll("[data-member-id]")).toHaveLength(20);
    await click(root.querySelector("#room-workspace-tab-watch")!);
    expect(root.querySelector('[aria-label="查看播放组"]')).toBe(group);
    expect(group.value).toBe(selected);
    await click(root.querySelector("#room-workspace-tab-pages")!);
    expect(search.value).toBe("产品路线");
    expect(store.commandCalls).toEqual([]);
  });

  it("supports roving arrow keys and excludes hidden task controls from focus navigation", async () => {
    const root = renderPanel(<App store={fixture()} now={() => FIXTURE_NOW_MS} />);
    const watch = root.querySelector<HTMLButtonElement>("#room-workspace-tab-watch")!;
    watch.focus();
    await act(async () => {
      watch.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const pages = root.querySelector<HTMLButtonElement>("#room-workspace-tab-pages")!;
    expect(document.activeElement).toBe(pages);
    expect(pages.getAttribute("aria-selected")).toBe("true");
    expect(watch.tabIndex).toBe(-1);
    expect(
      getFocusableElements(root).some((el) => el.closest("#room-workspace-panel-watch") !== null),
    ).toBe(false);
    await act(async () => {
      pages.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement).toBe(root.querySelector("#room-workspace-tab-members"));
  });

  it("opens a member's real page command without joining a playback group", async () => {
    const store = fixture();
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    await click(root.querySelector("#room-workspace-tab-members")!);
    await click(
      byRole(root.querySelector("#room-workspace-panel-members")!, "button", "打开 林岚 的页面"),
    );
    expect(store.commandCalls).toEqual([
      {
        name: "MEDIA_MEMBER_JUMP",
        payload: { userId: store.collaboration.value.members[1]!.userId },
      },
    ]);
    expect(store.commandCalls.some((c) => c.name === "MEDIA_GROUP_JOIN")).toBe(false);
  });

  it("keeps the previous member fact unknown until presence arrives", () => {
    const store = fixture();
    store.update({ collaboration: { ...store.collaboration.value, members: [] } });
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    expect(root.querySelector(".workspace-member-row")?.textContent).toContain("状态待同步");
    expect(root.querySelector(".workspace-member-row")?.textContent).not.toContain("离线");
  });

  it("checks a member's own binding even when another member can be opened", async () => {
    const store = fixture();
    const target = store.collaboration.value.members[1]!.userId;
    const runtime = store.room.value.runtime!;
    const media = runtime.media!;
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...runtime,
          media: {
            ...media,
            navigation: media.navigation.map((entry) =>
              entry.userId === target
                ? { ...entry, canJump: false, disabledReason: "MEDIA_MEMBER_TAB_UNBOUND" }
                : entry,
            ),
          },
        },
      },
    });
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    await click(root.querySelector("#room-workspace-tab-members")!);
    const button = byRole(root, "button", "打开 林岚 的页面") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.closest("article")?.textContent).toContain("当前客户端尚未绑定");
    expect(store.commandCalls).toEqual([]);
  });

  it("does not probe the placeholder server from settings", async () => {
    const store = fixture("lobby");
    store.update({
      shell: {
        ...store.shell.value,
        profiles: store.shell.value.profiles.map((profile) => ({
          ...profile,
          baseUrl: "https://syncaction.example.com",
        })),
      },
    });
    const probe = vi.fn(async () => ({ latencyMs: 4 }));
    const root = renderPanel(<App store={store} serviceStatusProbe={{ probe }} />);
    await click(byRole(root, "button", "设置"));
    expect(root.textContent).toContain("先配置服务器，再检测连接状态");
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps settings navigation disabled until logout completes", async () => {
    const store = fixture("lobby");
    let complete: (() => void) | undefined;
    store.responder = () =>
      new Promise((resolve) => {
        complete = () =>
          resolve({
            type: "ui.command.result",
            commandId: "018f8f8e-4b5c-7d6e-8f90-123456789c31",
            ok: true,
          });
      });
    const root = renderPanel(
      <App store={store} serviceStatusProbe={{ probe: async () => ({ latencyMs: 4 }) }} />,
    );
    await click(byRole(root, "button", "设置"));
    await click(byRole(root, "button", "退出登录"));
    expect(
      [...root.querySelectorAll<HTMLButtonElement>(".settings-row")].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    await act(async () => {
      complete!();
    });
    await vi.waitFor(() => expect(root.querySelector("#workspace-settings-title")).toBeNull());
  });

  it("retains rooms and catalogue selection locally without starting a room operation", async () => {
    const store = fixture("lobby");
    const root = renderPanel(<App store={store} />);
    await click(root.querySelector("#lobby-workspace-tab-discover")!);
    expect(root.querySelector<HTMLElement>("#lobby-workspace-panel-mine")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("#lobby-workspace-panel-discover")?.hidden).toBe(false);
    await click(root.querySelector("#lobby-workspace-tab-mine")!);
    expect(store.commandCalls).toEqual([]);
  });

  it("returns from a settings child and stops healthy diagnostics when settings close", async () => {
    const probe = vi.fn(async () => ({ latencyMs: 4 }));
    const store = fixture("lobby");
    const root = renderPanel(<App store={store} serviceStatusProbe={{ probe }} />);
    expect(probe).not.toHaveBeenCalled();
    await click(byRole(root, "button", "设置"));
    expect(root.querySelector("#workspace-settings-title")).not.toBeNull();
    expect(probe).toHaveBeenCalledOnce();
    await click(byRole(root, "button", "服务器"));
    expect(root.querySelector("#workspace-settings-title")).toBeNull();
    await click(byRole(root.querySelector('[role="dialog"]')!, "button", "关闭"));
    expect(root.querySelector("#workspace-settings-title")).not.toBeNull();
    await click(byRole(root.querySelector('[role="dialog"]')!, "button", "关闭"));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(store.commandCalls).toEqual([]);
  });
});
