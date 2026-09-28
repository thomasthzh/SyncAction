// @vitest-environment happy-dom

import type { ServerMeta } from "@syncaction/protocol";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { InvitePicker } from "../src/ui-vnext/components/invite-picker.js";
import { PermissionDialog } from "../src/ui-vnext/components/permission-dialog.js";
import { getFocusableElements, installFocusTrap } from "../src/ui-vnext/accessibility.js";
import {
  CustomServerVerifier,
  type ServerHostPermissionApi,
} from "../src/server-host-permission.js";
import type { VerifiedServerCandidate } from "../src/server-profile.js";
import {
  TestUiStore,
  byRole,
  click,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

const metadata: ServerMeta = {
  serverId: "018f8f8e-4b5c-7d6e-8f90-123456789e01",
  displayName: "Team Shanghai",
  softwareVersion: "0.9.3",
  protocolVersion: "2",
  minimumClientVersion: "0.9.0",
  termsVersion: "2026-08-01",
  capabilities: ["public-rooms", "join-requests", "notifications", "volatile-pointer-v2"],
  limits: {
    ordinaryActiveRooms: 5,
    ordinaryOpenTabs: 20,
  },
};

afterEach(() => unmountPanel());

describe("vNext server and permission dialogs", () => {
  it("uses a context-neutral close label for the standalone invite overlay", () => {
    const root = renderPanel(<InvitePicker store={new TestUiStore()} onBack={() => undefined} />);

    expect(byRole(root, "button", "关闭邀请")).toBeTruthy();
    expect(root.textContent).toContain("邀请成员");
  });

  it("names and selects the production server by default", async () => {
    const store = new TestUiStore();
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "切换服务器，当前 syncaction.example.com"));

    expect(root.textContent).toContain("服务器");
    expect(root.textContent).toContain("SyncAction 香港");
    expect(root.textContent).toContain("syncaction.example.com");
    expect(root.textContent).toContain("当前");
    expect(root.textContent).toContain("默认服务器");
    await click(byRole(root, "button", "已授权站点"));
    await vi.waitFor(() => {
      expect(root.textContent).toContain("暂无已同意站点");
    });
  });

  it.each(["http://remote.example", "https://user:secret@team.example"])(
    "rejects unsafe server URL %s before verifier invocation",
    async (baseUrl) => {
      const store = new TestUiStore();
      const verifyFromClick = vi.fn<(input: unknown) => Promise<VerifiedServerCandidate>>();
      const root = renderPanel(<App store={store} serverVerifier={{ verifyFromClick }} />);
      await click(byRole(root, "button", "切换服务器，当前 syncaction.example.com"));
      await click(byRole(root, "button", "添加服务器"));
      input(root.querySelector<HTMLInputElement>('input[name="serverUrl"]')!, baseUrl);
      await click(byRole(root, "button", "验证服务器"));

      expect(root.textContent).toContain("服务器地址无效");
      expect(verifyFromClick).not.toHaveBeenCalled();
    },
  );

  it.each(["https://team.example", "http://localhost:29373", "http://127.0.0.1:29373"])(
    "accepts secure or loopback origin %s",
    async (baseUrl) => {
      const store = new TestUiStore();
      const verifyFromClick = vi
        .fn<(input: unknown) => Promise<VerifiedServerCandidate>>()
        .mockResolvedValue({
          baseUrl,
          mode: "VNEXT",
          metadata,
          healthyAt: 1,
        });
      const root = renderPanel(<App store={store} serverVerifier={{ verifyFromClick }} />);
      await click(byRole(root, "button", "切换服务器，当前 syncaction.example.com"));
      await click(byRole(root, "button", "添加服务器"));
      input(root.querySelector<HTMLInputElement>('input[name="serverUrl"]')!, baseUrl);
      await click(byRole(root, "button", "验证服务器"));

      expect(verifyFromClick).toHaveBeenCalledWith(baseUrl);
      expect(root.textContent).toContain("Team Shanghai");
    },
  );

  it("requests the exact optional origin before any cross-origin fetch and saves only after preview", async () => {
    let resolvePermission: (granted: boolean) => void = () => undefined;
    const request = vi.fn<ServerHostPermissionApi["request"]>(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (requestInfo) => {
      const url = String(requestInfo);
      return url.endsWith("/healthz") ? jsonResponse({ status: "ok" }) : jsonResponse(metadata);
    });
    const verifier = new CustomServerVerifier({
      permissions: { request },
      fetch,
      now: () => 1_785_369_600_000,
    });
    const store = new TestUiStore();
    const root = renderPanel(<App store={store} serverVerifier={verifier} />);
    await click(byRole(root, "button", "切换服务器，当前 syncaction.example.com"));
    await click(byRole(root, "button", "添加服务器"));
    input(
      root.querySelector<HTMLInputElement>('input[name="serverUrl"]')!,
      "https://team.example:8443",
    );

    const verification = click(byRole(root, "button", "验证服务器"));
    expect(request).toHaveBeenCalledWith({ origins: ["https://team.example:8443/*"] });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.commandCalls).toHaveLength(0);
    expect(root.textContent).not.toContain("保存服务器");

    resolvePermission(true);
    await verification;
    await vi.waitFor(() => {
      expect(root.textContent).toContain("Team Shanghai");
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://team.example:8443/healthz",
      "https://team.example:8443/v1/meta",
    ]);
    expect(root.textContent).toContain("Team Shanghai");
    expect(root.textContent).toContain(metadata.serverId);
    expect(root.textContent).toContain("协议 2");
    expect(root.textContent).toContain("最低客户端 0.9.0");
    expect(store.commandCalls).toHaveLength(0);

    await click(byRole(root, "button", "保存服务器"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "SERVER_ADD",
      payload: { baseUrl: "https://team.example:8443" },
    });
  });

  it("keeps a healthy metadata-404 server as an explicit legacy preview before save", async () => {
    const store = new TestUiStore();
    const verifier = {
      verifyFromClick: vi.fn(async (): Promise<VerifiedServerCandidate> => ({
        baseUrl: "https://legacy.example",
        mode: "LEGACY_V081",
        metadata: null,
        healthyAt: 1,
      })),
    };
    const root = renderPanel(<App store={store} serverVerifier={verifier} />);
    await click(byRole(root, "button", "切换服务器，当前 syncaction.example.com"));
    await click(byRole(root, "button", "添加服务器"));
    input(
      root.querySelector<HTMLInputElement>('input[name="serverUrl"]')!,
      "https://legacy.example",
    );
    await click(byRole(root, "button", "验证服务器"));

    expect(root.textContent).toContain("旧版服务器，仅基础协作");
    expect(store.commandCalls).toHaveLength(0);
    expect(byRole(root, "button", "保存服务器")).toBeTruthy();
  });

  it("switches profile-scoped account and room state atomically", async () => {
    const store = new TestUiStore();
    store.update({
      shell: {
        ...store.shell.value,
        profiles: [
          ...store.shell.value.profiles,
          {
            profileId: "team-shanghai",
            baseUrl: "https://team.example",
            mode: "VNEXT",
            metadata,
            lastHealthyAt: 1,
          },
        ],
      },
    });
    store.responder = async (command) => {
      if (command.name === "SERVER_SELECT") {
        store.update({
          shell: {
            ...store.shell.value,
            selectedProfileId: "team-shanghai",
            phase: "AUTHENTICATED_NO_ROOM",
            account: {
              id: "018f8f8e-4b5c-7d6e-8f90-123456789e02",
              username: "team-user",
              displayName: "Team 用户",
              status: "ACTIVE",
              passwordResetRequired: false,
              createdAt: "2026-07-30T00:00:00.000Z",
            },
          },
          discovery: {
            publicRooms: [],
            rooms: [],
            invitations: [],
          },
          room: {
            selectedRoomId: null,
            detail: null,
            runtime: null,
          },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "切换服务器，当前 syncaction.example.com"));
    await click(byRole(root, "button", "选择 Team Shanghai"));

    expect(store.commandCalls.at(-1)).toEqual({
      name: "SERVER_SELECT",
      payload: { profileId: "team-shanghai" },
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).toContain("team.example");
    expect(root.textContent).toContain("Team 用户");
    expect(root.textContent).not.toContain("正在载入房间");
  });

  it("blocks save when a known URL returns a changed server identity", async () => {
    const store = new TestUiStore();
    const known = store.shell.value.profiles[0]!;
    const verifier = {
      verifyFromClick: vi.fn(async (): Promise<VerifiedServerCandidate> => ({
        baseUrl: known.baseUrl,
        mode: "VNEXT",
        metadata: {
          ...known.metadata!,
          serverId: "018f8f8e-4b5c-7d6e-8f90-123456789e03",
        },
        healthyAt: 2,
      })),
    };
    const root = renderPanel(<App store={store} serverVerifier={verifier} />);
    await click(byRole(root, "button", "切换服务器，当前 syncaction.example.com"));
    await click(byRole(root, "button", "添加服务器"));
    input(root.querySelector<HTMLInputElement>('input[name="serverUrl"]')!, known.baseUrl);
    await click(byRole(root, "button", "验证服务器"));

    expect(root.textContent).toContain("服务器身份已变化，已阻止连接");
    expect(root.querySelector('button[aria-label="保存服务器"]')).toBeNull();
  });

  it("requires explicit agreement and starts permission confirmation synchronously", () => {
    const confirm = vi.fn(() => ({
      granted: true,
      errorCode: null,
      policySyncPending: false,
    }));
    const root = renderPanel(
      <PermissionDialog
        feature="DANMAKU"
        origin="https://video.example"
        browserPermission="https://video.example/*"
        termsVersion="2026-08-01"
        privacyPageUrl="chrome-extension://syncaction/privacy.html"
        onConfirm={confirm}
        onClose={() => undefined}
      />,
    );

    expect(root.textContent).toContain("页面弹幕");
    expect(root.textContent).toContain("https://video.example");
    expect(root.textContent).toContain("https://video.example/*");
    expect(root.textContent).toContain("2026-08-01");
    expect(root.textContent).toContain("逻辑标签页标识");
    expect(root.textContent).toContain("量化后的光标与画笔坐标");
    expect(root.textContent).toContain("不会发送 Cookie、密码或表单输入");
    expect(root.textContent).toContain("不会发送页面文字、DOM、截图或视频流");
    expect(root.textContent).toContain("不会发送浏览历史或无关标签页");
    expect(root.querySelector<HTMLAnchorElement>('a[href*="privacy.html"]')?.target).toBe("_blank");
    const button = byRole(root, "button", "允许当前站点") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const agreement = root.querySelector<HTMLInputElement>('input[name="agreement"]')!;
    act(() => agreement.click());
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(confirm).toHaveBeenCalledWith(true);
  });

  it("shares one focus trap, Escape close, and opener restoration across dialogs", async () => {
    const store = new TestUiStore();
    const root = renderPanel(<App store={store} />);
    const opener = byRole(root, "button", "切换服务器，当前 syncaction.example.com");
    opener.focus();
    await click(opener);
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusable = getFocusableElements(dialog);
    expect(focusable.length).toBeGreaterThan(1);
    const cleanup = installFocusTrap(dialog, opener);
    focusable.at(-1)!.focus();
    act(() => {
      focusable.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(focusable[0]);
    focusable[0]!.focus();
    act(() => {
      focusable[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(focusable.at(-1));
    cleanup();

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
