import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons.js";
import type { UiCommandResult } from "../../ui/ui-protocol.js";
import { ActionableStatus } from "./actionable-status.js";
import { ModalDialog } from "./modal-dialog.js";

export type AuthMode = "LOGIN" | "REGISTER" | "ACTIVATE" | "KEY_LOGIN";
type AuthField = "username" | "displayName" | "password" | "activationKey";

export interface AuthDialogProps {
  readonly mode: AuthMode;
  readonly selectedProfileId: string;
  readonly serverHost: string;
  readonly serverConnected: boolean;
  readonly activationSupported: boolean;
  readonly keyLoginSupported: boolean;
  readonly onModeChange: (mode: AuthMode) => void;
  readonly onOpenServerProfiles: () => void;
  readonly onSubmit: (
    input:
      | { mode: "LOGIN"; username: string; password: string }
      | { mode: "REGISTER"; username: string; displayName: string; password: string }
      | {
          mode: "ACTIVATE";
          activationKey: string;
          username: string;
          displayName: string;
          password: string;
        }
      | { mode: "KEY_LOGIN"; activationKey: string },
  ) => Promise<UiCommandResult>;
  readonly onClose: () => void;
}

export function AuthDialog({
  mode,
  selectedProfileId,
  serverHost,
  serverConnected,
  activationSupported,
  keyLoginSupported,
  onModeChange,
  onOpenServerProfiles,
  onSubmit,
  onClose,
}: AuthDialogProps): preact.JSX.Element {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [activationKey, setActivationKey] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<AuthField | null>(null);
  const submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    setUsername("");
    setDisplayName("");
    setPassword("");
    setActivationKey("");
    setErrorCode(null);
    setErrorField(null);
    setPasswordVisible(false);
  }, [selectedProfileId]);

  useLayoutEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("[data-dialog-autofocus]")?.focus();
  }, [mode]);

  useLayoutEffect(() => {
    if (errorCode !== null && !pending) {
      const field =
        errorField === null
          ? null
          : formRef.current?.querySelector<HTMLInputElement>(`[name="${errorField}"]`);
      (field ?? feedbackRef.current)?.focus();
    }
  }, [errorCode, errorField, pending]);

  function showError(code: string | null, field: AuthField | null = null): void {
    setErrorCode(code);
    setErrorField(field);
  }

  function clearFieldError(field: AuthField): void {
    if (errorField === field) {
      showError(null);
    }
  }

  function changeMode(next: AuthMode): void {
    if (submitting.current || next === mode) {
      return;
    }
    setPassword("");
    setActivationKey("");
    setPasswordVisible(false);
    showError(null);
    onModeChange(next);
  }

  function close(): void {
    if (!submitting.current) {
      onClose();
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting.current) {
      return;
    }
    setErrorCode(null);
    setErrorField(null);
    const trimmedKey = activationKey.trim();
    if (mode === "KEY_LOGIN" || mode === "ACTIVATE") {
      if (trimmedKey.length === 0) {
        showError("ACTIVATION_KEY_REQUIRED", "activationKey");
        return;
      }
      if (!/^sak_[A-Za-z0-9_-]{43}$/u.test(trimmedKey)) {
        showError("ACTIVATION_KEY_FORMAT_INVALID", "activationKey");
        return;
      }
    }
    if (mode !== "KEY_LOGIN") {
      const normalizedUsername = username.trim().normalize("NFKC");
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])$/u.test(normalizedUsername)) {
        showError("USERNAME_INVALID", "username");
        return;
      }
      if (mode === "REGISTER" || mode === "ACTIVATE") {
        const normalizedDisplayName = displayName.trim().replace(/\s+/gu, " ");
        const displayNameLength = Array.from(normalizedDisplayName).length;
        if (displayNameLength < 1 || displayNameLength > 64) {
          showError("DISPLAY_NAME_INVALID", "displayName");
          return;
        }
      }
      const passwordLength = Array.from(password).length;
      if (passwordLength < 12 || passwordLength > 128) {
        showError("PASSWORD_INVALID", "password");
        return;
      }
    }
    submitting.current = true;
    setPending(true);
    try {
      const result = await onSubmit(
        mode === "LOGIN"
          ? { mode, username, password }
          : mode === "REGISTER"
            ? { mode, username, displayName, password }
            : mode === "ACTIVATE"
              ? { mode, activationKey: trimmedKey, username, displayName, password }
              : { mode, activationKey: trimmedKey },
      );
      if (!result.ok) {
        showError(
          result.errorCode,
          result.errorCode.startsWith("ACTIVATION_KEY_")
            ? "activationKey"
            : result.errorCode === "USERNAME_TAKEN"
              ? "username"
              : result.errorCode === "INVALID_CREDENTIALS"
                ? "password"
                : null,
        );
      }
    } catch {
      showError("NETWORK_ERROR");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const titleId = "syncaction-auth-title";
  return (
    <ModalDialog titleId={titleId} pending={pending} onClose={close} className="auth-dialog">
      <header class="dialog-header">
        <div>
          <p class="eyebrow">SyncAction 账号</p>
          <h2 id={titleId}>
            {mode === "LOGIN"
              ? "登录 SyncAction"
              : mode === "REGISTER"
                ? "注册 SyncAction"
                : mode === "KEY_LOGIN"
                  ? "使用账户密钥登录"
                  : "使用管理员密钥激活"}
          </h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="关闭"
          title="关闭"
          disabled={pending}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>

      <div
        class="segmented-control"
        data-options={activationSupported || keyLoginSupported ? "3" : "2"}
        role="group"
        aria-label="登录、注册或账户密钥"
      >
        <button
          type="button"
          disabled={pending}
          aria-pressed={mode === "LOGIN"}
          onClick={() => changeMode("LOGIN")}
        >
          登录
        </button>
        <button
          type="button"
          disabled={pending}
          aria-pressed={mode === "REGISTER"}
          onClick={() => changeMode("REGISTER")}
        >
          注册
        </button>
        {activationSupported || keyLoginSupported ? (
          <button
            type="button"
            disabled={pending}
            aria-pressed={mode === "ACTIVATE" || mode === "KEY_LOGIN"}
            onClick={() => changeMode(keyLoginSupported ? "KEY_LOGIN" : "ACTIVATE")}
          >
            {keyLoginSupported ? "密钥登录" : "密钥激活"}
          </button>
        ) : null}
      </div>

      <form ref={formRef} class="dialog-form" noValidate onSubmit={(event) => void submit(event)}>
        {mode === "ACTIVATE" || mode === "KEY_LOGIN" ? (
          <>
            <label>
              管理员提供的账户密钥
              <input
                name="activationKey"
                autocomplete="off"
                spellcheck={false}
                autoCapitalize="off"
                placeholder="粘贴管理员提供的完整密钥"
                required
                disabled={pending}
                data-dialog-autofocus
                aria-invalid={errorField === "activationKey"}
                aria-describedby={`activation-key-help${errorField === "activationKey" ? " auth-error" : ""}`}
                value={activationKey}
                onInput={(event) => {
                  setActivationKey(event.currentTarget.value);
                  clearFieldError("activationKey");
                }}
              />
            </label>
            <p class="field-help" id="activation-key-help">
              密钥以 sak_ 开头，后接 43 个英文字母、数字、- 或
              _，区分大小写。完整密钥只提交给当前服务器，不会写入扩展设置。
            </p>
          </>
        ) : null}
        {mode === "KEY_LOGIN" ? null : (
          <>
            <label>
              用户名
              <input
                name="username"
                autocomplete="username"
                autoCapitalize="off"
                spellcheck={false}
                placeholder="输入用户名"
                required
                disabled={pending}
                data-dialog-autofocus={mode === "LOGIN" || mode === "REGISTER" ? true : undefined}
                aria-invalid={errorField === "username"}
                aria-describedby={`username-help${errorField === "username" ? " auth-error" : ""}`}
                minlength={3}
                maxlength={32}
                pattern="[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])"
                title="3–32 位英文字母、数字或 ._-，首尾须为字母或数字"
                value={username}
                onInput={(event) => {
                  setUsername(event.currentTarget.value);
                  clearFieldError("username");
                }}
              />
            </label>
            <p class="field-help" id="username-help">
              用户名必须为 3–32 位，仅可使用英文字母、数字及中间的 ._-，首尾必须是字母或数字。
            </p>
          </>
        )}
        {mode === "REGISTER" || mode === "ACTIVATE" ? (
          <label>
            显示名称
            <input
              name="displayName"
              autocomplete="name"
              placeholder="其他成员看到的名称"
              required
              disabled={pending}
              aria-invalid={errorField === "displayName"}
              aria-describedby={`display-name-help${errorField === "displayName" ? " auth-error" : ""}`}
              maxlength={64}
              pattern={".*\\S.*"}
              value={displayName}
              onInput={(event) => {
                setDisplayName(event.currentTarget.value);
                clearFieldError("displayName");
              }}
            />
          </label>
        ) : null}
        {mode === "REGISTER" || mode === "ACTIVATE" ? (
          <p class="field-help" id="display-name-help">
            显示名称不能为空或只包含空格，最多 64 个字符。
          </p>
        ) : null}
        {mode === "KEY_LOGIN" ? null : (
          <>
            <label>
              密码
              <span class="password-field">
                <input
                  name="password"
                  id="auth-password"
                  type={passwordVisible ? "text" : "password"}
                  autocomplete={mode === "LOGIN" ? "current-password" : "new-password"}
                  placeholder={mode === "LOGIN" ? "输入登录密码" : "设置至少 12 个字符的密码"}
                  required
                  disabled={pending}
                  aria-invalid={errorField === "password"}
                  aria-describedby={`password-help${errorField === "password" ? " auth-error" : ""}`}
                  minlength={12}
                  maxlength={128}
                  value={password}
                  onInput={(event) => {
                    setPassword(event.currentTarget.value);
                    clearFieldError("password");
                  }}
                />
                <button
                  class="password-toggle"
                  type="button"
                  aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                  aria-pressed={passwordVisible}
                  aria-controls="auth-password"
                  disabled={pending}
                  onClick={() => setPasswordVisible((visible) => !visible)}
                >
                  {passwordVisible ? "隐藏" : "显示"}
                </button>
              </span>
            </label>
            <p class="field-help" id="password-help">
              密码必须为 12–128 个字符。
            </p>
          </>
        )}

        <button
          class="server-context-row"
          type="button"
          disabled={pending}
          onClick={onOpenServerProfiles}
          aria-label={`服务器 ${serverHost} ${serverConnected ? "已连接" : "待验证"}`}
        >
          <span>服务器</span>
          <strong>{serverHost}</strong>
          <span>
            {serverConnected ? "已连接" : "待验证"}
            <Icon name="chevron" size={16} />
          </span>
        </button>

        <div ref={feedbackRef} class="dialog-feedback" role="alert" tabIndex={-1}>
          <ActionableStatus errorCode={errorCode} id="auth-error" />
        </div>
        {mode === "REGISTER" ? (
          <p class="field-help">注册后需要管理员批准，批准后即可登录。</p>
        ) : null}
        <div class="dialog-actions">
          <button class="secondary-button" type="button" disabled={pending} onClick={close}>
            取消
          </button>
          <button class="primary-button" type="submit" disabled={pending}>
            {pending
              ? mode === "REGISTER"
                ? "正在提交注册…"
                : mode === "ACTIVATE"
                  ? "正在激活…"
                  : mode === "KEY_LOGIN"
                    ? "正在验证密钥…"
                    : "正在登录…"
              : mode === "LOGIN"
                ? "登录"
                : mode === "REGISTER"
                  ? "提交注册"
                  : mode === "KEY_LOGIN"
                    ? "使用密钥登录"
                    : "激活并登录"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
