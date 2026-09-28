// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { errorLabel } from "../src/ui-vnext/components/actionable-status.js";
import { UiDiscoverySliceSchema } from "../src/ui/ui-protocol.js";
import {
  TestUiStore,
  baseSlices,
  byRole,
  click,
  failure,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

const account = {
  id: "018f8f8e-4b5c-7d6e-8f90-123456789c33",
  username: "aming",
  displayName: "阿明",
  status: "ACTIVE" as const,
  passwordResetRequired: false,
  createdAt: "2026-07-30T00:00:00.000Z",
};

afterEach(() => unmountPanel());

describe("vNext one-screen shell", () => {
  it("mounts the event-driven Preact app exactly once from the production entrypoint", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../entrypoints/sidepanel/main.ts"),
      "utf8",
    );
    const html = readFileSync(
      resolve(import.meta.dirname, "../entrypoints/sidepanel/index.html"),
      "utf8",
    );

    expect(source).toContain('from "../../src/ui-vnext/app.js"');
    expect(source).toContain('from "../../src/ui-vnext/store.js"');
    expect(source).toContain("createUiStore");
    expect(source).toContain("CustomServerVerifier");
    expect(source.match(/\brender\(/gu)).toHaveLength(2);
    expect(source).not.toMatch(
      /createSidePanelRuntime|createSidePanelRenderer|createSidePanelViewModel|scheduleRefresh|setInterval|syncaction\.app\.status\.get/u,
    );
    expect(source).not.toMatch(
      /SyncActionApiClient|browser\.tabs\.|browser\.permissions\.request/u,
    );

    expect(html.match(/id="sidepanel-app"/gu)).toHaveLength(1);
    expect(html).not.toMatch(/sa-primary-tabs|tablist|房间管理/u);
    expect(html).toMatch(/content="width=device-width,\s*initial-scale=1(?:\.0)?"/u);
    expect(html).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/iu);
  });

  it("keeps the guest identity, server, messages, and auth action in one compact header", () => {
    const store = new TestUiStore();
    const root = renderPanel(<App store={store} />);

    expect(root.textContent).toContain("SyncAction");
    expect(root.textContent).toContain("syncaction.example.com");
    expect(byRole(root, "button", "消息")).toBeTruthy();
    expect(byRole(root, "button", "登录 | 注册")).toBeTruthy();
    expect(root.textContent).toContain("一起浏览");
    expect(root.textContent).toContain("房间、页面和播放进度会自动同步");
    for (const legacyLabel of ["活动", "成员", "标签页", "房间管理"]) {
      expect(
        [...root.querySelectorAll("nav a, nav button")].map((node) => node.textContent),
      ).not.toContain(legacyLabel);
    }
  });

  it("uses one login/register dialog and closes it after a successful login", async () => {
    const store = new TestUiStore();
    store.responder = async (command) => {
      if (command.name === "AUTH_LOGIN") {
        store.update({
          shell: {
            ...store.shell.value,
            phase: "AUTHENTICATED_NO_ROOM",
            account,
          },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "登录 | 注册"));
    const dialog = root.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.textContent).toContain("登录 SyncAction");
    expect(dialog?.textContent).toContain("注册");
    expect(dialog?.textContent).toContain("syncaction.example.com");

    input(root.querySelector('input[name="username"]')!, "aming");
    input(root.querySelector('input[name="password"]')!, "correct horse");
    await click(root.querySelector('button[type="submit"]')!);

    expect(store.commandCalls).toContainEqual({
      name: "AUTH_LOGIN",
      payload: { username: "aming", password: "correct horse" },
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).toContain("阿明");
    expect(root.textContent).toContain("退出");
  });

  it("switches to registration, reports pending approval, and keeps command errors inline", async () => {
    const store = new TestUiStore();
    let shouldFail = true;
    store.responder = async (command) => {
      if (command.name !== "AUTH_REGISTER") {
        return success();
      }
      if (shouldFail) {
        return failure("USERNAME_TAKEN");
      }
      store.update({
        shell: {
          ...store.shell.value,
          phase: "ACCOUNT_PENDING",
          account: null,
        },
      });
      return success();
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "登录 | 注册"));
    await click(byRole(root, "button", "注册"));
    input(root.querySelector('input[name="username"]')!, "new-user");
    input(root.querySelector('input[name="displayName"]')!, "新用户");
    input(root.querySelector('input[name="password"]')!, "correct horse");
    await click(byRole(root, "button", "提交注册"));

    expect(root.textContent).toContain("用户名已被占用");
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();

    shouldFail = false;
    await click(byRole(root, "button", "提交注册"));
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).toContain("账号申请已提交，管理员批准后即可登录");
  });

  it("offers administrator-key activation only on a capable server", async () => {
    const store = new TestUiStore();
    const selected = store.shell.value.profiles[0]!;
    store.update({
      shell: {
        ...store.shell.value,
        profiles: [
          {
            ...selected,
            metadata: {
              ...selected.metadata!,
              capabilities: [...selected.metadata!.capabilities, "account-activation-v1"],
            },
          },
        ],
      },
    });
    store.responder = async (command) => {
      if (command.name === "AUTH_ACTIVATE") {
        store.update({
          shell: { ...store.shell.value, phase: "AUTHENTICATED_NO_ROOM", account },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "登录 | 注册"));
    await click(byRole(root, "button", "密钥激活"));
    expect(root.textContent).toContain("使用管理员密钥激活");
    expect(root.textContent).toContain("完整密钥只提交给当前服务器");
    input(
      root.querySelector<HTMLInputElement>('input[name="activationKey"]')!,
      `sak_${"A".repeat(43)}`,
    );
    input(root.querySelector<HTMLInputElement>('input[name="username"]')!, "aming");
    input(root.querySelector<HTMLInputElement>('input[name="displayName"]')!, "阿明");
    input(root.querySelector<HTMLInputElement>('input[name="password"]')!, "correct horse battery");
    await click(byRole(root, "button", "激活并登录"));

    expect(store.commandCalls.at(-1)).toEqual({
      name: "AUTH_ACTIVATE",
      payload: {
        activationKey: `sak_${"A".repeat(43)}`,
        username: "aming",
        displayName: "阿明",
        password: "correct horse battery",
      },
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).toContain("阿明");
  });

  it("prefers key-only login and writes every account-key rule in plain language", async () => {
    const store = new TestUiStore();
    const selected = store.shell.value.profiles[0]!;
    store.update({
      shell: {
        ...store.shell.value,
        profiles: [
          {
            ...selected,
            metadata: {
              ...selected.metadata!,
              capabilities: [
                ...selected.metadata!.capabilities,
                "account-activation-v1",
                "account-key-login-v1",
              ],
            },
          },
        ],
      },
    });
    store.responder = async (command) => {
      if (command.name === "AUTH_KEY_LOGIN") {
        store.update({
          shell: {
            ...store.shell.value,
            phase: "AUTHENTICATED_NO_ROOM",
            account: { ...account, passwordResetRequired: true },
          },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "登录 | 注册"));
    await click(byRole(root, "button", "密钥登录"));
    expect(root.textContent).toContain("使用账户密钥登录");
    expect(root.textContent).toContain(
      "密钥以 sak_ 开头，后接 43 个英文字母、数字、- 或 _，区分大小写",
    );
    expect(root.querySelector('input[name="username"]')).toBeNull();
    expect(root.querySelector('input[name="displayName"]')).toBeNull();
    expect(root.querySelector('input[name="password"]')).toBeNull();

    await click(byRole(root, "button", "使用密钥登录"));
    expect(root.textContent).toContain("请输入账户密钥");
    expect(store.commandCalls).toHaveLength(0);

    input(root.querySelector<HTMLInputElement>('input[name="activationKey"]')!, "wrong-key");
    await click(byRole(root, "button", "使用密钥登录"));
    expect(root.textContent).toContain(
      "密钥格式不正确：应以 sak_ 开头，后接 43 个英文字母、数字、- 或 _，并区分大小写",
    );
    expect(store.commandCalls).toHaveLength(0);

    input(
      root.querySelector<HTMLInputElement>('input[name="activationKey"]')!,
      `sak_${"B".repeat(43)}`,
    );
    await click(byRole(root, "button", "使用密钥登录"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "AUTH_KEY_LOGIN",
      payload: { activationKey: `sak_${"B".repeat(43)}` },
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("mirrors the server account policy before submitting activation", async () => {
    const store = new TestUiStore();
    const selected = store.shell.value.profiles[0]!;
    store.update({
      shell: {
        ...store.shell.value,
        profiles: [
          {
            ...selected,
            metadata: {
              ...selected.metadata!,
              capabilities: [...selected.metadata!.capabilities, "account-activation-v1"],
            },
          },
        ],
      },
    });
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "登录 | 注册"));
    await click(byRole(root, "button", "密钥激活"));
    const username = root.querySelector<HTMLInputElement>('input[name="username"]')!;
    const displayName = root.querySelector<HTMLInputElement>('input[name="displayName"]')!;
    const password = root.querySelector<HTMLInputElement>('input[name="password"]')!;

    expect(username.minLength).toBe(3);
    expect(username.pattern).toBe("[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])");
    expect(displayName.pattern).toBe(".*\\S.*");
    expect(password.minLength).toBe(12);
    expect(password.maxLength).toBe(128);
    expect(root.textContent).toContain("用户名必须为 3–32 位");
    expect(root.textContent).toContain("显示名称不能为空或只包含空格");
    expect(root.textContent).toContain("密码必须为 12–128 个字符");

    input(
      root.querySelector<HTMLInputElement>('input[name="activationKey"]')!,
      `sak_${"A".repeat(43)}`,
    );
    input(username, "ab");
    input(displayName, "阿明");
    input(password, "short");
    await click(byRole(root, "button", "激活并登录"));

    expect(store.commandCalls).not.toContainEqual(
      expect.objectContaining({ name: "AUTH_ACTIVATE" }),
    );
  });

  it("explains a rejected account-policy input", () => {
    expect(errorLabel("INVALID_INPUT")).toBe("提交内容格式无效，请按字段下方明文规则检查后重试");
    expect(errorLabel("USERNAME_INVALID")).toContain("用户名必须为 3–32 位");
    expect(errorLabel("DISPLAY_NAME_INVALID")).toBe("显示名称不能为空或只包含空格，最多 64 个字符");
    expect(errorLabel("PASSWORD_INVALID")).toBe("密码必须为 12–128 个字符");
    expect(errorLabel("ACTIVATION_KEY_INVALID")).toBe(
      "密钥不存在或输入错误，请核对管理员发送的完整密钥",
    );
    expect(errorLabel("ACTIVATION_KEY_USED")).toBe(
      "此密钥对应的账户已完成设置，请使用用户名和密码登录",
    );
  });

  it("returns to login when switching from activation to an unsupported server", async () => {
    const store = new TestUiStore();
    const capable = {
      ...store.shell.value.profiles[0]!,
      metadata: {
        ...store.shell.value.profiles[0]!.metadata!,
        capabilities: [
          ...store.shell.value.profiles[0]!.metadata!.capabilities,
          "account-activation-v1",
        ],
      },
    };
    const legacy = {
      profileId: "legacy-server",
      baseUrl: "https://legacy.example.com",
      mode: "VNEXT" as const,
      metadata: {
        ...capable.metadata,
        serverId: "018f8f8e-4b5c-7d6e-8f90-123456789c38",
        displayName: "Legacy Server",
        softwareVersion: "0.9.5",
        capabilities: ["public-rooms"],
      },
      lastHealthyAt: 1,
    };
    store.update({
      shell: { ...store.shell.value, profiles: [capable, legacy] },
    });
    store.responder = async (command) => {
      if (command.name === "SERVER_SELECT") {
        store.update({
          shell: {
            ...store.shell.value,
            selectedProfileId: command.payload.profileId,
          },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "登录 | 注册"));
    await click(byRole(root, "button", "密钥激活"));
    await click(root.querySelector(".server-context-row")!);
    await click(byRole(root, "button", "选择 Legacy Server"));

    expect(root.textContent).toContain("登录 SyncAction");
    expect(root.querySelector('input[name="activationKey"]')).toBeNull();
    expect(root.textContent).not.toContain("使用管理员密钥激活");
  });

  it("normalizes activation immediately when the selected server changes outside the dialog", async () => {
    const store = new TestUiStore();
    const capable = {
      ...store.shell.value.profiles[0]!,
      metadata: {
        ...store.shell.value.profiles[0]!.metadata!,
        capabilities: [
          ...store.shell.value.profiles[0]!.metadata!.capabilities,
          "account-activation-v1",
        ],
      },
    };
    const legacy = {
      profileId: "external-legacy-server",
      baseUrl: "https://external-legacy.example.com",
      mode: "VNEXT" as const,
      metadata: {
        ...capable.metadata,
        serverId: "018f8f8e-4b5c-7d6e-8f90-123456789c39",
        displayName: "External Legacy Server",
        softwareVersion: "0.9.5",
        capabilities: ["public-rooms"],
      },
      lastHealthyAt: 1,
    };
    store.update({
      shell: { ...store.shell.value, profiles: [capable, legacy] },
    });
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "登录 | 注册"));
    await click(byRole(root, "button", "密钥激活"));
    await act(async () => {
      store.update({
        shell: {
          ...store.shell.value,
          selectedProfileId: legacy.profileId,
        },
      });
      await Promise.resolve();
    });

    expect(root.textContent).toContain("登录 SyncAction");
    expect(root.querySelector('input[name="activationKey"]')).toBeNull();
  });

  it("hides account settings on an unsupported server, including an already-open overlay", async () => {
    const store = new TestUiStore();
    const capable = {
      ...store.shell.value.profiles[0]!,
      metadata: {
        ...store.shell.value.profiles[0]!.metadata!,
        capabilities: [
          ...store.shell.value.profiles[0]!.metadata!.capabilities,
          "account-activation-v1",
        ],
      },
    };
    const legacy = {
      profileId: "legacy-account-server",
      baseUrl: "https://legacy-account.example.com",
      mode: "VNEXT" as const,
      metadata: {
        ...capable.metadata,
        serverId: "018f8f8e-4b5c-7d6e-8f90-123456789c40",
        displayName: "Legacy Account Server",
        softwareVersion: "0.9.5",
        capabilities: ["public-rooms"],
      },
      lastHealthyAt: 1,
    };
    store.update({
      shell: {
        ...store.shell.value,
        phase: "AUTHENTICATED_NO_ROOM",
        account,
        profiles: [capable, legacy],
      },
    });
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "账户设置，当前 阿明"));
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      store.update({
        shell: {
          ...store.shell.value,
          selectedProfileId: legacy.profileId,
        },
      });
      await Promise.resolve();
    });

    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.textContent).toContain("阿明");
    expect(
      [...root.querySelectorAll("button")].some((button) => button.textContent === "阿明"),
    ).toBe(false);
  });

  it("lets an authenticated user change account identity and password", async () => {
    const store = new TestUiStore();
    const selected = store.shell.value.profiles[0]!;
    store.update({
      shell: {
        ...store.shell.value,
        phase: "AUTHENTICATED_NO_ROOM",
        account,
        profiles: [
          {
            ...selected,
            metadata: {
              ...selected.metadata!,
              capabilities: [...selected.metadata!.capabilities, "account-activation-v1"],
            },
          },
        ],
      },
    });
    store.responder = async (command) => {
      if (command.name === "ACCOUNT_PROFILE_UPDATE") {
        store.update({
          shell: {
            ...store.shell.value,
            account: { ...account, ...command.payload },
          },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "账户设置，当前 阿明"));
    expect(root.textContent).toContain("账户设置");
    const profileUsername = root.querySelector<HTMLInputElement>('input[name="profileUsername"]')!;
    const profileDisplayName = root.querySelector<HTMLInputElement>(
      'input[name="profileDisplayName"]',
    )!;
    const currentPassword = root.querySelector<HTMLInputElement>('input[name="currentPassword"]')!;
    const newPassword = root.querySelector<HTMLInputElement>('input[name="newPassword"]')!;
    const confirmPassword = root.querySelector<HTMLInputElement>('input[name="confirmPassword"]')!;
    expect(profileUsername.minLength).toBe(3);
    expect(profileUsername.pattern).toBe("[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])");
    expect(profileDisplayName.pattern).toBe(".*\\S.*");
    for (const passwordInput of [currentPassword, newPassword, confirmPassword]) {
      expect(passwordInput.minLength).toBe(12);
      expect(passwordInput.maxLength).toBe(128);
    }
    expect(root.textContent).toContain("用户名必须为 3–32 位");
    expect(root.textContent).toContain("密码必须为 12–128 个字符");

    input(profileUsername, "aming.renamed");
    input(profileDisplayName, "阿明新名称");
    await click(byRole(root, "button", "保存账户名称"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "ACCOUNT_PROFILE_UPDATE",
      payload: { username: "aming.renamed", displayName: "阿明新名称" },
    });
    expect(root.textContent).toContain("账户名称已保存");

    input(currentPassword, "correct horse battery");
    input(newPassword, "replacement horse battery");
    input(confirmPassword, "replacement horse battery");
    await click(byRole(root, "button", "更新密码"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "ACCOUNT_PASSWORD_CHANGE",
      payload: {
        currentPassword: "correct horse battery",
        newPassword: "replacement horse battery",
      },
    });
    expect(root.textContent).toContain("密码已更新，当前设备保持登录");
  });

  it("sets the first password without asking for a current password", async () => {
    const store = new TestUiStore();
    const selected = store.shell.value.profiles[0]!;
    store.update({
      shell: {
        ...store.shell.value,
        phase: "AUTHENTICATED_NO_ROOM",
        account: { ...account, passwordResetRequired: true },
        profiles: [
          {
            ...selected,
            metadata: {
              ...selected.metadata!,
              capabilities: [
                ...selected.metadata!.capabilities,
                "account-activation-v1",
                "account-key-login-v1",
              ],
            },
          },
        ],
      },
    });
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "账户设置，当前 阿明"));
    expect(root.textContent).toContain("设置登录密码");
    expect(root.textContent).toContain("密码必须为 12–128 个字符");
    expect(root.querySelector('input[name="currentPassword"]')).toBeNull();

    input(root.querySelector<HTMLInputElement>('input[name="newPassword"]')!, "short");
    input(root.querySelector<HTMLInputElement>('input[name="confirmPassword"]')!, "short");
    await click(byRole(root, "button", "设置登录密码"));
    expect(root.textContent).toContain("密码必须为 12–128 个字符");
    expect(store.commandCalls).toHaveLength(0);

    input(
      root.querySelector<HTMLInputElement>('input[name="newPassword"]')!,
      "correct horse battery",
    );
    input(
      root.querySelector<HTMLInputElement>('input[name="confirmPassword"]')!,
      "correct horse battery",
    );
    await click(byRole(root, "button", "设置登录密码"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "ACCOUNT_PASSWORD_INITIALIZE",
      payload: { newPassword: "correct horse battery" },
    });
    expect(root.textContent).toContain("登录密码已设置，此账户密钥已永久失效");
  });

  it("renders authenticated rooms, invitations, create-room, and logout without hidden tabs", async () => {
    const store = new TestUiStore();
    const state = baseSlices();
    store.update({
      shell: {
        ...state.shell,
        phase: "AUTHENTICATED_NO_ROOM",
        account,
      },
      discovery: UiDiscoverySliceSchema.parse({
        ...state.discovery,
        rooms: [
          {
            id: "018f8f8e-4b5c-7d6e-8f90-123456789c34",
            name: "产品讨论",
            role: "OWNER",
            roomEpoch: 0,
            visibility: "PRIVATE",
            joinPolicy: "INVITE_ONLY",
            roomRevision: 1,
            createdAt: "2026-07-30T00:00:00.000Z",
            updatedAt: "2026-07-30T00:00:00.000Z",
          },
        ],
        invitations: [
          {
            id: "018f8f8e-4b5c-7d6e-8f90-123456789c35",
            roomId: "018f8f8e-4b5c-7d6e-8f90-123456789c36",
            roomName: "观影夜",
            invitedByUserId: "018f8f8e-4b5c-7d6e-8f90-123456789c37",
            invitedByUsername: "friend",
            expiresAt: "2026-07-31T00:00:00.000Z",
            createdAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      }),
    });
    const root = renderPanel(<App store={store} />);

    expect(root.textContent).toContain("我的房间");
    expect(root.querySelector('[data-editorial-surface="my-rooms"]')).not.toBeNull();
    expect(root.textContent).toContain("产品讨论");
    expect(root.textContent).toContain("邀请");
    expect(root.textContent).toContain("观影夜");
    expect(byRole(root, "button", "创建房间")).toBeTruthy();
    await click(byRole(root, "button", "产品讨论"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_SELECT",
      payload: { roomId: "018f8f8e-4b5c-7d6e-8f90-123456789c34" },
    });
    await click(byRole(root, "button", "退出"));
    expect(store.commandCalls.at(-1)).toEqual({ name: "AUTH_LOGOUT" });
  });

  it("shows a nonmodal one-time upgrade notice while leaving room actions available", async () => {
    const store = new TestUiStore();
    store.update({
      shell: {
        ...store.shell.value,
        onboardingRequired: true,
        profiles: [
          {
            ...store.shell.value.profiles[0]!,
            mode: "LEGACY_V081",
            metadata: null,
          },
        ],
      },
    });
    store.responder = async (command) => {
      if (command.name === "ONBOARDING_DISMISS") {
        store.update({
          shell: {
            ...store.shell.value,
            onboardingRequired: false,
          },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);

    expect(root.textContent).toContain("房间现在集中在一个页面");
    expect(root.textContent).toContain("按网站授权光标、弹幕与画笔");
    expect(byRole(root, "button", "登录 | 注册").hasAttribute("disabled")).toBe(false);
    await click(byRole(root, "button", "知道了"));
    expect(store.commandCalls.at(-1)).toEqual({ name: "ONBOARDING_DISMISS" });
    expect(root.textContent).not.toContain("房间现在集中在一个页面");
  });
});
