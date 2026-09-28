import { useEffect, useState } from "preact/hooks";
import { Icon } from "../icons.js";
import type { UiCommandResult } from "../../ui/ui-protocol.js";
import { ActionableStatus } from "./actionable-status.js";
import { ModalDialog } from "./modal-dialog.js";

export type AuthMode = "LOGIN" | "REGISTER" | "ACTIVATE" | "KEY_LOGIN";

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
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    setUsername("");
    setDisplayName("");
    setPassword("");
    setActivationKey("");
    setErrorCode(null);
  }, [selectedProfileId]);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setErrorCode(null);
    const trimmedKey = activationKey.trim();
    if (mode === "KEY_LOGIN" || mode === "ACTIVATE") {
      if (trimmedKey.length === 0) {
        setErrorCode("ACTIVATION_KEY_REQUIRED");
        return;
      }
      if (!/^sak_[A-Za-z0-9_-]{43}$/u.test(trimmedKey)) {
        setErrorCode("ACTIVATION_KEY_FORMAT_INVALID");
        return;
      }
    }
    if (mode !== "KEY_LOGIN") {
      const normalizedUsername = username.trim().normalize("NFKC");
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])$/u.test(normalizedUsername)) {
        setErrorCode("USERNAME_INVALID");
        return;
      }
      if (mode === "REGISTER" || mode === "ACTIVATE") {
        const normalizedDisplayName = displayName.trim().replace(/\s+/gu, " ");
        const displayNameLength = Array.from(normalizedDisplayName).length;
        if (displayNameLength < 1 || displayNameLength > 64) {
          setErrorCode("DISPLAY_NAME_INVALID");
          return;
        }
      }
      const passwordLength = Array.from(password).length;
      if (passwordLength < 12 || passwordLength > 128) {
        setErrorCode("PASSWORD_INVALID");
        return;
      }
    }
    setPending(true);
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
      setErrorCode(result.errorCode);
    }
    setPending(false);
  }

  const titleId = "syncaction-auth-title";
  return (
    <ModalDialog titleId={titleId} pending={pending} onClose={onClose}>
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
        <button class="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      <div
        class="segmented-control"
        data-options={activationSupported || keyLoginSupported ? "3" : "2"}
        aria-label="登录、注册或账户密钥"
      >
        <button
          type="button"
          aria-pressed={mode === "LOGIN"}
          onClick={() => {
            setErrorCode(null);
            onModeChange("LOGIN");
          }}
        >
          登录
        </button>
        <button
          type="button"
          aria-pressed={mode === "REGISTER"}
          onClick={() => {
            setErrorCode(null);
            onModeChange("REGISTER");
          }}
        >
          注册
        </button>
        {activationSupported || keyLoginSupported ? (
          <button
            type="button"
            aria-pressed={mode === "ACTIVATE" || mode === "KEY_LOGIN"}
            onClick={() => {
              setErrorCode(null);
              onModeChange(keyLoginSupported ? "KEY_LOGIN" : "ACTIVATE");
            }}
          >
            {keyLoginSupported ? "密钥登录" : "密钥激活"}
          </button>
        ) : null}
      </div>

      <form class="dialog-form" noValidate onSubmit={(event) => void submit(event)}>
        {mode === "ACTIVATE" || mode === "KEY_LOGIN" ? (
          <>
            <label>
              管理员提供的账户密钥
              <input
                name="activationKey"
                autocomplete="off"
                spellcheck={false}
                value={activationKey}
                onInput={(event) => setActivationKey(event.currentTarget.value)}
              />
            </label>
            <p class="field-help">
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
                minlength={3}
                maxlength={32}
                pattern="[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])"
                title="3–32 位英文字母、数字或 ._-，首尾须为字母或数字"
                value={username}
                onInput={(event) => setUsername(event.currentTarget.value)}
              />
            </label>
            <p class="field-help">
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
              maxlength={64}
              pattern={".*\\S.*"}
              value={displayName}
              onInput={(event) => setDisplayName(event.currentTarget.value)}
            />
          </label>
        ) : null}
        {mode === "REGISTER" || mode === "ACTIVATE" ? (
          <p class="field-help">显示名称不能为空或只包含空格，最多 64 个字符。</p>
        ) : null}
        {mode === "KEY_LOGIN" ? null : (
          <>
            <label>
              密码
              <input
                name="password"
                type="password"
                autocomplete={mode === "LOGIN" ? "current-password" : "new-password"}
                minlength={12}
                maxlength={128}
                value={password}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
            </label>
            <p class="field-help">密码必须为 12–128 个字符。</p>
          </>
        )}

        <button
          class="server-context-row"
          type="button"
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

        <ActionableStatus errorCode={errorCode} id="auth-error" />
        <div class="dialog-actions">
          <button class="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button class="primary-button" type="submit" disabled={pending}>
            {pending
              ? "请稍候…"
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
