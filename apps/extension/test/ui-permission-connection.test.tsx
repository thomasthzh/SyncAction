// @vitest-environment happy-dom

import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { PermissionDialog } from "../src/ui-vnext/components/permission-dialog.js";
import type {
  PermissionConfirmation,
  PermissionIntent,
} from "../src/origin-permission-coordinator.js";
import { createVisualStore } from "../visual/fixture-store.js";
import {
  TestUiStore,
  byRole,
  click,
  failure,
  renderPanel,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

afterEach(unmountPanel);

function permission(
  onConfirm: (agreed: boolean) => Promise<PermissionConfirmation>,
  onClose = vi.fn(),
) {
  return renderPanel(
    <PermissionDialog
      feature="MEDIA_CONTROL"
      continuation="JOIN_MEDIA_GROUP"
      origin="https://video.example"
      browserPermission="https://video.example/*"
      termsVersion="2026-08-01"
      privacyPageUrl="privacy.html"
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
}

function agree(root: HTMLElement): void {
  act(() => root.querySelector<HTMLInputElement>('input[name="agreement"]')!.click());
}

describe("task-scoped permission and connection UI", () => {
  it.each(["create", "join"] as const)(
    "carries the original %s intent into its permission explanation and confirmation",
    async (action) => {
      const fixture = createVisualStore("room");
      const store = new TestUiStore();
      store.update({
        shell: fixture.shell.value,
        discovery: fixture.discovery.value,
        room: fixture.room.value,
        collaboration: fixture.collaboration.value,
        pageAccess: {
          ...fixture.pageAccess.value,
          browserPermissionGranted: false,
          termsAccepted: false,
          enabledFeatures: [],
        },
      });
      if (action === "create") {
        store.update({
          room: {
            ...store.room.value,
            runtime: {
              ...store.room.value.runtime!,
              media: {
                ...store.room.value.runtime!.media!,
                playbackGroups: [],
                localMembership: null,
              },
            },
          },
        });
      }
      const access = store.pageAccess.value;
      const captured: PermissionIntent = {
        profileId: store.shell.value.selectedProfileId,
        roomId: store.room.value.selectedRoomId!,
        tabId: access.tabId!,
        origin: access.origin!,
        documentRevision: access.documentRevision!,
        feature: "MEDIA_CONTROL",
        serverTermsVersion: access.serverTermsVersion!,
        disclosureVersion: 1,
        permissionPreviouslyGranted: false,
      };
      const confirm = vi.fn(async () => ({
        granted: true,
        errorCode: null,
        policySyncPending: false,
      }));
      const root = renderPanel(
        <App
          store={store}
          pagePermissionCoordinator={{ capture: vi.fn(async () => captured), confirm }}
        />,
      );
      const groupId = root.querySelector<HTMLElement>("[data-group-id]")?.dataset.groupId;
      await click(byRole(root, "button", action === "create" ? "开始一起看" : "加入播放组"));
      expect(root.querySelector(".permission-task")?.textContent).toContain(
        action === "create" ? "从当前视频创建播放组" : "加入原播放组",
      );
      agree(root);
      await click(byRole(root, "button", "允许当前站点"));
      expect(confirm).toHaveBeenCalledWith(
        action === "create" ? captured : { ...captured, mediaJoinGroupId: groupId },
        true,
      );
      expect(store.commandCalls).toEqual([]);
    },
  );

  it("keeps the task and concise disclosure visible while full data and permission details are collapsed", () => {
    const root = permission(vi.fn());
    expect(root.querySelector(".permission-task")?.textContent).toContain("加入原播放组");
    expect(root.querySelector(".permission-task")?.closest("details")).toBeNull();
    expect(root.querySelector(".permission-scope")?.textContent).toContain("https://video.example");
    expect(root.querySelector(".permission-scope")?.textContent).toContain("换房间无需重复授权");
    const details = root.querySelector<HTMLDetailsElement>(".permission-technical-details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("https://video.example/*");
    expect(details.textContent).toContain("2026-08-01");
    expect(root.querySelector(".permission-disclosure")?.closest("details")).toBe(details);
    expect(root.querySelector(".permission-summary-copy")?.closest("details")).toBeNull();
    expect(root.querySelector(".permission-summary-copy")?.textContent).toContain("不发送 Cookie");
    expect(root.querySelector(".agreement-row")?.closest("details")).toBeNull();
    expect(root.querySelector(".permission-disclosure")?.textContent).toContain("不会发送 Cookie");
  });

  it("leaves a failed preflight with an enabled retry rather than a permanent checking state", async () => {
    const confirm = vi.fn();
    const retry = vi.fn();
    const root = renderPanel(
      <PermissionDialog
        feature="DRAWING"
        origin="https://video.example"
        browserPermission="https://video.example/*"
        termsVersion="2026-08-01"
        privacyPageUrl="privacy.html"
        ready={false}
        externalErrorCode="PAGE_PERMISSION_UNAVAILABLE"
        onConfirm={confirm}
        onRetry={retry}
        onClose={vi.fn()}
      />,
    );
    expect(root.textContent).not.toContain("正在检查");
    expect((root.querySelector('input[name="agreement"]') as HTMLInputElement).disabled).toBe(true);
    const button = byRole(root, "button", "重新检查") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await click(button);
    expect(retry).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps native permission confirmation synchronous and prevents duplicate submission, then retries the same task", async () => {
    let resolve!: (result: PermissionConfirmation) => void;
    const confirm = vi.fn(
      () =>
        new Promise<PermissionConfirmation>((done) => {
          resolve = done;
        }),
    );
    const close = vi.fn();
    const root = permission(confirm, close);
    agree(root);
    const submit = byRole(root, "button", "允许当前站点") as HTMLButtonElement;
    act(() => {
      submit.click();
      expect(confirm).toHaveBeenCalledWith(true);
      submit.click();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((byRole(root, "button", "取消") as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      resolve({
        granted: true,
        errorCode: "PAGE_PERMISSION_ACTIVATION_FAILED",
        policySyncPending: true,
      }),
    );
    expect(close).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLInputElement>('input[name="agreement"]')!.checked).toBe(true);
    expect(root.textContent).toContain("加入原播放组");
    await click(byRole(root, "button", "重试启用"));
    expect(confirm).toHaveBeenCalledTimes(2);
    await act(async () => resolve({ granted: true, errorCode: null, policySyncPending: false }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops retrying an expired permission context and allows cancellation without resubmitting", async () => {
    const confirm = vi.fn(async () => ({
      granted: true,
      errorCode: "PAGE_PERMISSION_INTENT_STALE",
      policySyncPending: true,
    }));
    const close = vi.fn();
    const root = permission(confirm, close);
    agree(root);
    await click(byRole(root, "button", "允许当前站点"));
    expect((byRole(root, "button", "请重新发起授权") as HTMLButtonElement).disabled).toBe(true);
    expect(root.textContent).toContain("页面或服务器已变化");
    await click(byRole(root, "button", "取消"));
    expect(close).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("does not let a completion from a closed dialog affect its next screen", async () => {
    let resolve!: (result: PermissionConfirmation) => void;
    const close = vi.fn();
    const root = permission(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      close,
    );
    agree(root);
    await click(byRole(root, "button", "允许当前站点"));
    unmountPanel();
    await act(async () => resolve({ granted: true, errorCode: null, policySyncPending: false }));
    expect(close).not.toHaveBeenCalled();
  });

  it("prioritizes returning rooms without health polling and keeps room selection as the real command", async () => {
    const fixture = createVisualStore("lobby");
    const store = new TestUiStore();
    store.update({ shell: fixture.shell.value, discovery: fixture.discovery.value });
    const root = renderPanel(<App store={store} />);
    const roomList = root.querySelector<HTMLElement>(".my-rooms")!;
    expect(root.querySelector(".service-status-card")).toBeNull();
    expect(roomList.hidden).toBe(false);
    expect(root.querySelector(".welcome-strip .primary-button")).toBeNull();
    await click(byRole(roomList, "button", store.discovery.value.rooms[0]!.name));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_SELECT",
      payload: { roomId: store.discovery.value.rooms[0]!.id },
    });
  });

  it("retries a failed server connection through SERVER_SELECT and preserves a rejected result", async () => {
    const store = new TestUiStore();
    store.update({ shell: { ...store.shell.value, phase: "ERROR", errorCode: "NETWORK_ERROR" } });
    store.responder = async () => failure("SERVER_IDENTITY_CHANGED");
    const root = renderPanel(
      <App store={store} serviceStatusProbe={{ probe: vi.fn(async () => ({ latencyMs: 1 })) }} />,
    );
    await click(byRole(root, "button", "重新连接服务器"));
    expect(store.commandCalls).toEqual([
      { name: "SERVER_SELECT", payload: { profileId: store.shell.value.selectedProfileId } },
    ]);
    expect(root.textContent).toContain("服务器身份已变化，已阻止连接");
    expect(root.querySelector(".service-status-card__summary")?.textContent).not.toContain(
      "服务在线",
    );
  });

  it("keeps identity failures on the server-inspection path and scopes port reconnection separately", async () => {
    const store = new TestUiStore();
    store.update({
      shell: { ...store.shell.value, phase: "ERROR", errorCode: "SERVER_IDENTITY_CHANGED" },
    });
    const root = renderPanel(<App store={store} />);
    expect(root.textContent).toContain("服务器身份已变化");
    expect(root.querySelector(".service-status-card__actions")?.textContent).not.toContain(
      "重新连接服务器",
    );
    await click(byRole(root, "button", "检查服务器"));
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain("服务器");
    expect(store.commandCalls).toEqual([]);
    await click(byRole(root, "button", "关闭"));
    await act(async () => {
      store.transport.value = "RECONNECTING";
    });
    expect(root.textContent).toContain("侧栏连接正在恢复");
    expect(root.textContent).toContain("侧栏正在重新连接扩展");
    expect(root.querySelector(".service-status-card__actions")).toBeNull();
  });
});
