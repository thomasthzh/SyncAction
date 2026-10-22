// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "preact/test-utils";
import { App } from "../src/ui-vnext/app.js";
import { PermissionDialog } from "../src/ui-vnext/components/permission-dialog.js";
import { StartWatchingCard } from "../src/ui-vnext/components/start-watching-card.js";
import { createVisualStore, FIXTURE_NOW_MS } from "../visual/fixture-store.js";
import {
  TestUiStore,
  byRole,
  click,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";
import { failure } from "./ui-vnext-test-harness.js";
import type { UiCommandResult } from "../src/ui/ui-protocol.js";
import type { PermissionIntent } from "../src/origin-permission-coordinator.js";

afterEach(unmountPanel);

function roomStore(): TestUiStore {
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

describe("first collaboration recovery and truthful results", () => {
  it.each([
    [{ kind: "BLOCKED", reason: "ROOM_TAB_LIMIT_REACHED" }, "最多共享 20"],
    [{ kind: "IGNORED", reason: "LOADING" }, "页面仍在加载"],
    [{ kind: "RECOVERY_REQUIRED" }, "当前页面未分享"],
    [undefined, "尚未确认分享结果"],
  ])("does not report share success for %j", async (value, text) => {
    const store = roomStore();
    store.responder = async () => success(value);
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    await click(byRole(root, "button", "分享当前页"));
    const dock = root.querySelector(".bottom-action-dock")!;
    expect(dock.textContent).toContain(text);
    expect(dock.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps the permission dialog open when granted permission fails to activate", async () => {
    const close = vi.fn();
    const confirm = vi.fn(async () => ({
      granted: true,
      errorCode: "PAGE_PERMISSION_ACTIVATION_FAILED",
      policySyncPending: false,
    }));
    const root = renderPanel(
      <PermissionDialog
        feature="MEDIA_CONTROL"
        origin="https://video.example"
        browserPermission="https://video.example/*"
        termsVersion="2026-08-01"
        privacyPageUrl="privacy.html"
        onConfirm={confirm}
        onClose={close}
      />,
    );
    act(() => root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click(byRole(root, "button", "允许当前站点"));
    expect(close).not.toHaveBeenCalled();
    expect(root.textContent).toContain("权限已保存");
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("does not show fully synced while browser execution requires confirmation", () => {
    const store = roomStore();
    const runtime = store.room.value.runtime!;
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...runtime,
          browser: {
            ...runtime.browser!,
            state: "CONFIRMATION_REQUIRED",
            reason: "CIRCUIT_BREAKER",
            missingTabCount: 6,
          },
        },
      },
    });
    const root = renderPanel(<App store={store} now={() => FIXTURE_NOW_MS} />);
    expect(root.querySelector('[data-connection-state="SYNCED"]')).toBeNull();
    expect(byRole(root, "button", "确认恢复")).toBeTruthy();
  });

  it("prevents closing an authorization while activation is still pending", async () => {
    let complete!: (value: {
      granted: boolean;
      errorCode: string | null;
      policySyncPending: boolean;
    }) => void;
    const close = vi.fn();
    const root = renderPanel(
      <PermissionDialog
        feature="MEDIA_CONTROL"
        origin="https://video.example"
        browserPermission="https://video.example/*"
        termsVersion="2026-08-01"
        privacyPageUrl="privacy.html"
        onConfirm={() =>
          new Promise((resolve) => {
            complete = resolve;
          })
        }
        onClose={close}
      />,
    );
    act(() => root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click(byRole(root, "button", "允许当前站点"));
    expect((byRole(root, "button", "取消") as HTMLButtonElement).disabled).toBe(true);
    expect((byRole(root, "button", "关闭") as HTMLButtonElement).disabled).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      complete({ granted: false, errorCode: "PAGE_PERMISSION_DENIED", policySyncPending: false });
    });
    expect((byRole(root, "button", "取消") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not automatically create without a frozen shared page context", async () => {
    const store = roomStore();
    store.update({ pageAccess: { ...store.pageAccess.value, documentRevision: null } });
    store.responder = async () => success({ kind: "INTENT_RECORDED" });
    const request = vi.fn();
    const root = renderPanel(<StartWatchingCard store={store} onRequestPagePermission={request} />);
    await click(byRole(root, "button", "开始一起看"));
    expect(store.commandCalls.map(({ name }) => name)).toEqual(["CURRENT_TAB_SHARE"]);
    expect(request).not.toHaveBeenCalled();
  });

  it("creates from consented known media without requiring page-wide equality and prevents duplicate clicks", async () => {
    const store = roomStore();
    store.update({
      pageAccess: {
        ...store.pageAccess.value,
        contentCompatibility: "UNKNOWN",
        enabledFeatures: ["DANMAKU"],
      },
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          media: { ...store.room.value.runtime!.media!, playbackGroups: [], localMembership: null },
        },
      },
    });
    let resolve!: (result: UiCommandResult) => void;
    store.responder = () =>
      new Promise<UiCommandResult>((done) => {
        resolve = done;
      });
    const root = renderPanel(<StartWatchingCard store={store} onRequestPagePermission={vi.fn()} />);
    const start = byRole(root, "button", "开始一起看");
    act(() => {
      start.click();
      start.click();
    });
    expect(store.commandCalls).toEqual([
      {
        name: "MEDIA_GROUP_CREATE",
        payload: {
          expectedContext: {
            profileId: store.shell.value.selectedProfileId,
            tabId: store.pageAccess.value.tabId,
            documentRevision: store.pageAccess.value.documentRevision,
            roomId: store.room.value.selectedRoomId,
          },
        },
      },
    ]);
    await act(async () => {
      resolve(success({ accepted: true }));
      await Promise.resolve();
    });
    expect(root.textContent).toContain("播放组已创建");
  });

  it("requests media consent for a shared page and preserves a usable retry", async () => {
    const store = roomStore();
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          media: { ...store.room.value.runtime!.media!, playbackGroups: [], localMembership: null },
        },
      },
      pageAccess: {
        ...store.pageAccess.value,
        enabledFeatures: [],
        termsAccepted: false,
        browserPermissionGranted: false,
      },
    });
    const request = vi.fn();
    const root = renderPanel(<StartWatchingCard store={store} onRequestPagePermission={request} />);
    await click(byRole(root, "button", "开始一起看"));
    expect(request).toHaveBeenCalledWith("media-create");
    expect(store.commandCalls).toHaveLength(0);
    act(() =>
      store.update({
        pageAccess: {
          ...store.pageAccess.value,
          enabledFeatures: ["MEDIA_CONTROL"],
          termsAccepted: true,
          browserPermissionGranted: true,
        },
      }),
    );
    store.responder = async () => failure("MEDIA_NOT_READY");
    await click(byRole(root, "button", "开始一起看"));
    expect(root.textContent).toContain("请先播放视频再重试");
    expect((byRole(root, "button", "开始一起看") as HTMLButtonElement).disabled).toBe(false);
  });

  it("captures the existing playback group when a new follower needs site consent", async () => {
    const store = roomStore();
    const access = store.pageAccess.value;
    store.update({
      pageAccess: {
        ...access,
        browserPermissionGranted: false,
        termsAccepted: false,
        enabledFeatures: [],
      },
    });
    const capture = vi.fn(async () => ({
      profileId: store.shell.value.selectedProfileId,
      roomId: store.room.value.selectedRoomId!,
      tabId: access.tabId!,
      origin: access.origin!,
      documentRevision: access.documentRevision!,
      feature: "MEDIA_CONTROL" as const,
      serverTermsVersion: access.serverTermsVersion!,
      disclosureVersion: 1 as const,
      permissionPreviouslyGranted: false,
    }));
    const confirm = vi.fn(async (intent: PermissionIntent, agreed: boolean) => ({
      granted: agreed && intent.feature === "MEDIA_CONTROL",
      errorCode: null,
      policySyncPending: false,
    }));
    const root = renderPanel(
      <App store={store} pagePermissionCoordinator={{ capture, confirm }} />,
    );
    const group = root.querySelector<HTMLElement>("[data-group-id]")!;
    await click(byRole(group, "button", "加入播放组"));
    await vi.waitFor(() => expect(root.textContent).toContain("媒体同步控制"));
    act(() => root.querySelector<HTMLInputElement>('input[name="agreement"]')!.click());
    await click(byRole(root, "button", "允许当前站点"));
    expect(capture).toHaveBeenCalledWith("MEDIA_CONTROL");
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ mediaJoinGroupId: group.dataset.groupId });
    expect(store.commandCalls.some(({ name }) => name === "MEDIA_GROUP_CREATE")).toBe(false);
  });

  it("shares before waiting for the canonical document and creates only after readiness", async () => {
    const store = roomStore();
    const revision = store.pageAccess.value.documentRevision;
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          media: { ...store.room.value.runtime!.media!, playbackGroups: [], localMembership: null },
        },
      },
      pageAccess: { ...store.pageAccess.value, documentRevision: null },
    });
    store.responder = async (command) =>
      success(
        command.name === "CURRENT_TAB_SHARE"
          ? {
              kind: "INTENT_RECORDED",
              sharedPageContext: {
                tabId: store.pageAccess.value.tabId,
                url: "https://video.example/watch/first",
              },
            }
          : { accepted: true },
      );
    const root = renderPanel(<StartWatchingCard store={store} onRequestPagePermission={vi.fn()} />);
    await click(byRole(root, "button", "开始一起看"));
    expect(store.commandCalls.map(({ name }) => name)).toEqual([
      "CURRENT_TAB_SHARE",
      "PAGE_PERMISSION_REFRESH",
    ]);
    await vi.waitFor(() => expect(root.textContent).toContain("正在准备共享页面"));
    await act(async () => {
      store.update({ pageAccess: { ...store.pageAccess.value, documentRevision: revision } });
    });
    await vi.waitFor(() =>
      expect(store.commandCalls.map(({ name }) => name)).toEqual([
        "CURRENT_TAB_SHARE",
        "PAGE_PERMISSION_REFRESH",
        "MEDIA_GROUP_CREATE",
      ]),
    );
    expect(store.commandCalls[2]).toMatchObject({
      payload: { expectedContext: { url: "https://video.example/watch/first" } },
    });
  });

  it("does not continue sharing on a different active tab", async () => {
    const store = roomStore();
    store.update({
      room: {
        ...store.room.value,
        runtime: {
          ...store.room.value.runtime!,
          media: { ...store.room.value.runtime!.media!, playbackGroups: [], localMembership: null },
        },
      },
      pageAccess: { ...store.pageAccess.value, documentRevision: null },
    });
    let resolve!: (result: UiCommandResult) => void;
    store.responder = () =>
      new Promise<UiCommandResult>((done) => {
        resolve = done;
      });
    const request = vi.fn();
    const root = renderPanel(<StartWatchingCard store={store} onRequestPagePermission={request} />);
    await click(byRole(root, "button", "开始一起看"));
    await act(async () => {
      store.update({ pageAccess: { ...store.pageAccess.value, tabId: 999 } });
      resolve(success({ kind: "INTENT_RECORDED" }));
    });
    expect(store.commandCalls.map(({ name }) => name)).toEqual(["CURRENT_TAB_SHARE"]);
    expect(request).not.toHaveBeenCalled();
  });
});
