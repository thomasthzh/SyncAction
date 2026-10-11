// @vitest-environment happy-dom

import { render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthDialog,
  type AuthDialogProps,
  type AuthMode,
} from "../src/ui-vnext/components/auth-dialog.js";
import { CreateRoomDialog } from "../src/ui-vnext/components/create-room-dialog.js";
import type { UiCommandResult } from "../src/ui/ui-protocol.js";
import {
  byRole,
  change,
  click,
  failure,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

afterEach(() => unmountPanel());

function authProps(overrides: Partial<AuthDialogProps> = {}): AuthDialogProps {
  return {
    mode: "LOGIN",
    selectedProfileId: "current-server",
    serverHost: "team.example",
    serverConnected: true,
    activationSupported: true,
    keyLoginSupported: true,
    onModeChange: vi.fn(),
    onOpenServerProfiles: vi.fn(),
    onSubmit: vi.fn(async () => success()),
    onClose: vi.fn(),
    ...overrides,
  };
}

function submitTwice(root: HTMLElement): void {
  const form = root.querySelector("form")!;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("vNext account form interactions", () => {
  it("opens on the username, explains validation and returns focus to the invalid field", async () => {
    const props = authProps();
    const root = renderPanel(<AuthDialog {...props} />);
    const username = root.querySelector<HTMLInputElement>('[name="username"]')!;
    expect(document.activeElement).toBe(username);

    await click(root.querySelector('button[type="submit"]')!);

    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(username.getAttribute("aria-invalid")).toBe("true");
    expect(username.getAttribute("aria-describedby")).toContain("auth-error");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("用户名必须为 3–32 位");
    expect(document.activeElement).toBe(username);
    input(username, "ming");
    expect(username.getAttribute("aria-invalid")).toBe("false");
  });

  it("shows and hides a password without submitting or changing its value", async () => {
    const props = authProps();
    const root = renderPanel(<AuthDialog {...props} />);
    const password = root.querySelector<HTMLInputElement>('[name="password"]')!;
    input(password, "correct horse");

    await click(byRole(root, "button", "显示密码"));
    expect(password.type).toBe("text");
    expect(password.value).toBe("correct horse");
    expect(byRole(root, "button", "隐藏密码").getAttribute("aria-pressed")).toBe("true");
    await click(byRole(root, "button", "隐藏密码"));
    expect(password.type).toBe("password");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("sends once while pending, locks every control, then focuses the failed credential", async () => {
    let finish!: (result: UiCommandResult) => void;
    const props = authProps({
      onSubmit: vi.fn(
        () =>
          new Promise<UiCommandResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const root = renderPanel(<AuthDialog {...props} />);
    input(root.querySelector<HTMLInputElement>('[name="username"]')!, "ming");
    input(root.querySelector<HTMLInputElement>('[name="password"]')!, "correct horse");

    submitTwice(root);

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(root.querySelector("dialog")?.getAttribute("aria-busy")).toBe("true");
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "input, button",
    )) {
      expect(control.disabled).toBe(true);
    }
    expect(document.activeElement).toBe(root.querySelector("dialog"));
    act(() => {
      root
        .querySelector("dialog")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(props.onClose).not.toHaveBeenCalled();

    await act(async () => {
      finish(failure("INVALID_CREDENTIALS"));
      await Promise.resolve();
    });
    const password = root.querySelector<HTMLInputElement>('[name="password"]')!;
    expect(password.disabled).toBe(false);
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(password);
    expect(root.textContent).toContain("用户名或密码不正确");
  });

  it("recovers from a rejected request with a readable message and allows retry", async () => {
    const onSubmit = vi
      .fn<AuthDialogProps["onSubmit"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(success());
    const root = renderPanel(<AuthDialog {...authProps({ onSubmit })} />);
    input(root.querySelector<HTMLInputElement>('[name="username"]')!, "ming");
    input(root.querySelector<HTMLInputElement>('[name="password"]')!, "correct horse");
    await click(root.querySelector('button[type="submit"]')!);

    expect(root.textContent).toContain("网络连接失败，请稍后重试");
    expect(root.querySelector("dialog")?.getAttribute("aria-busy")).toBe("false");
    expect(document.activeElement).toBe(root.querySelector(".dialog-feedback"));
    await click(root.querySelector('button[type="submit"]')!);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("clears secrets when changing auth mode and focuses the newly relevant field", async () => {
    function Modes(): preact.JSX.Element {
      const [mode, setMode] = useState<AuthMode>("LOGIN");
      return <AuthDialog {...authProps()} mode={mode} onModeChange={setMode} />;
    }
    const root = renderPanel(<Modes />);
    input(root.querySelector<HTMLInputElement>('[name="password"]')!, "correct horse");
    await click(byRole(root, "button", "密钥登录"));
    const key = root.querySelector<HTMLInputElement>('[name="activationKey"]')!;
    expect(document.activeElement).toBe(key);
    input(key, `sak_${"A".repeat(43)}`);
    await click(byRole(root, "button", "登录"));
    expect(root.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe("");
    await click(byRole(root, "button", "密钥登录"));
    expect(root.querySelector<HTMLInputElement>('[name="activationKey"]')!.value).toBe("");
  });

  it("does not carry an account key into another server profile", async () => {
    const props = authProps({ mode: "KEY_LOGIN" });
    const root = renderPanel(<AuthDialog {...props} />);
    input(root.querySelector<HTMLInputElement>('[name="activationKey"]')!, `sak_${"B".repeat(43)}`);
    await act(async () => {
      render(<AuthDialog {...props} selectedProfileId="other-server" />, root);
      await Promise.resolve();
    });
    expect(root.querySelector<HTMLInputElement>('[name="activationKey"]')!.value).toBe("");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("vNext room creation form interactions", () => {
  it("rejects a whitespace-only name before submitting and focuses its readable error", async () => {
    const onSubmit = vi.fn(async () => success());
    const root = renderPanel(<CreateRoomDialog onSubmit={onSubmit} onClose={() => undefined} />);
    const name = root.querySelector<HTMLInputElement>('[name="name"]')!;
    expect(document.activeElement).toBe(name);
    input(name, "   ");
    await click(root.querySelector('button[type="submit"]')!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(root.textContent).toContain("不能只包含空格");
    expect(document.activeElement).toBe(name);
  });

  it("explains access choices and returns to invitation-only when made private", async () => {
    const root = renderPanel(
      <CreateRoomDialog onSubmit={async () => success()} onClose={() => undefined} />,
    );
    const visibility = root.querySelector<HTMLSelectElement>('[name="visibility"]')!;
    const joinPolicy = root.querySelector<HTMLSelectElement>('[name="joinPolicy"]')!;
    expect(joinPolicy.disabled).toBe(true);
    expect(root.textContent).toContain("仅受邀成员可见");
    change(visibility, "PUBLIC");
    expect(joinPolicy.value).toBe("APPROVAL");
    expect(joinPolicy.disabled).toBe(false);
    change(joinPolicy, "OPEN");
    expect(root.textContent).toContain("登录用户可以直接加入");
    change(visibility, "PRIVATE");
    expect(joinPolicy.value).toBe("INVITE_ONLY");
    expect(joinPolicy.disabled).toBe(true);
  });

  it("normalizes the room name, submits once and restores interaction after a failed request", async () => {
    let finish!: (result: UiCommandResult) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<UiCommandResult>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    const root = renderPanel(<CreateRoomDialog onSubmit={onSubmit} onClose={onClose} />);
    input(root.querySelector<HTMLInputElement>('[name="name"]')!, "  周末   观影  ");
    submitTwice(root);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      name: "周末 观影",
      visibility: "PRIVATE",
      joinPolicy: "INVITE_ONLY",
    });
    for (const control of root.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >("input, button, select")) {
      expect(control.disabled).toBe(true);
    }
    await click(byRole(root, "button", "关闭"));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      finish(failure("ROOM_CAPACITY_REACHED"));
      await Promise.resolve();
    });
    expect(root.querySelector<HTMLInputElement>('[name="name"]')!.disabled).toBe(false);
    expect(root.textContent).toContain("最多创建 5 个房间");
    expect(document.activeElement).toBe(root.querySelector(".dialog-feedback"));
  });

  it("releases the busy state if room creation rejects", async () => {
    const root = renderPanel(
      <CreateRoomDialog
        onSubmit={async () => {
          throw new Error("offline");
        }}
        onClose={() => undefined}
      />,
    );
    input(root.querySelector<HTMLInputElement>('[name="name"]')!, "产品讨论");
    await click(root.querySelector('button[type="submit"]')!);
    expect(root.textContent).toContain("网络连接失败，请稍后重试");
    expect((root.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
