import type { PublicAccount } from "../../api-client.js";
import type { UiStore } from "../store.js";
import { useEffect, useState } from "preact/hooks";
import { ActionableStatus } from "./actionable-status.js";
import { Icon } from "../icons.js";
import { ModalDialog } from "./modal-dialog.js";

export interface AccountSettingsDialogProps {
  readonly store: UiStore;
  readonly account: PublicAccount;
  readonly onClose: () => void;
}

export function AccountSettingsDialog({
  store,
  account,
  onClose,
}: AccountSettingsDialogProps): preact.JSX.Element {
  const [username, setUsername] = useState(account.username);
  const [displayName, setDisplayName] = useState(account.displayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profilePending, setProfilePending] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setUsername(account.username);
    setDisplayName(account.displayName);
  }, [account.id, account.username, account.displayName]);

  async function saveProfile(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setProfileError(null);
    setNotice(null);
    const normalizedUsername = username.trim().normalize("NFKC");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])$/u.test(normalizedUsername)) {
      setProfileError("USERNAME_INVALID");
      return;
    }
    const normalizedDisplayName = displayName.trim().replace(/\s+/gu, " ");
    const displayNameLength = Array.from(normalizedDisplayName).length;
    if (displayNameLength < 1 || displayNameLength > 64) {
      setProfileError("DISPLAY_NAME_INVALID");
      return;
    }
    setProfilePending(true);
    const result = await store.command({
      name: "ACCOUNT_PROFILE_UPDATE",
      payload: { username, displayName },
    });
    if (result.ok) {
      setNotice("账户名称已保存");
    } else {
      setProfileError(result.errorCode);
    }
    setProfilePending(false);
  }

  async function savePassword(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setPasswordError(null);
    setNotice(null);
    if (newPassword !== confirmPassword) {
      setPasswordError("PASSWORD_CONFIRMATION_MISMATCH");
      return;
    }
    const passwordLength = Array.from(newPassword).length;
    if (passwordLength < 12 || passwordLength > 128) {
      setPasswordError("PASSWORD_INVALID");
      return;
    }
    setPasswordPending(true);
    const result = await store.command(
      account.passwordResetRequired
        ? {
            name: "ACCOUNT_PASSWORD_INITIALIZE",
            payload: { newPassword },
          }
        : {
            name: "ACCOUNT_PASSWORD_CHANGE",
            payload: { currentPassword, newPassword },
          },
    );
    if (result.ok) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice(
        account.passwordResetRequired
          ? "登录密码已设置，此账户密钥已永久失效"
          : "密码已更新，当前设备保持登录",
      );
    } else {
      setPasswordError(result.errorCode);
    }
    setPasswordPending(false);
  }

  const titleId = "syncaction-account-settings-title";
  return (
    <ModalDialog titleId={titleId} pending={profilePending || passwordPending} onClose={onClose}>
      <header class="dialog-header">
        <div>
          <p class="eyebrow">当前账户 · @{account.username}</p>
          <h2 id={titleId}>账户设置</h2>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      <div class="account-settings-stack">
        <form
          class="dialog-form account-settings-card"
          data-form="profile"
          noValidate
          onSubmit={(event) => void saveProfile(event)}
        >
          <div>
            <h3>账户名称</h3>
            <p class="field-help">
              用于登录、成员列表和协作标识。用户名必须为 3–32 位，仅可使用英文字母、数字及中间的
              ._-，首尾必须是字母或数字；显示名称不能为空或只包含空格，最多 64 个字符。
            </p>
          </div>
          <label>
            用户名
            <input
              name="profileUsername"
              autocomplete="username"
              minlength={3}
              maxlength={32}
              pattern="[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])"
              title="3–32 位英文字母、数字或 ._-，首尾须为字母或数字"
              value={username}
              onInput={(event) => setUsername(event.currentTarget.value)}
            />
          </label>
          <label>
            显示名称
            <input
              name="profileDisplayName"
              autocomplete="name"
              maxlength={64}
              pattern={".*\\S.*"}
              value={displayName}
              onInput={(event) => setDisplayName(event.currentTarget.value)}
            />
          </label>
          <ActionableStatus errorCode={profileError} />
          <button class="primary-button" type="submit" disabled={profilePending}>
            {profilePending ? "保存中…" : "保存账户名称"}
          </button>
        </form>

        <form
          class="dialog-form account-settings-card"
          data-form="password"
          noValidate
          onSubmit={(event) => void savePassword(event)}
        >
          <div>
            <h3>{account.passwordResetRequired ? "设置登录密码" : "修改登录密码"}</h3>
            <p class="field-help">
              密码必须为 12–128 个字符。
              {account.passwordResetRequired
                ? "设置成功后，此账户密钥将永久失效。"
                : "更新后当前设备继续登录，其他设备会退出。"}
            </p>
          </div>
          {account.passwordResetRequired ? null : (
            <label>
              当前密码
              <input
                name="currentPassword"
                type="password"
                autocomplete="current-password"
                minlength={12}
                maxlength={128}
                value={currentPassword}
                onInput={(event) => setCurrentPassword(event.currentTarget.value)}
              />
            </label>
          )}
          <label>
            新密码
            <input
              name="newPassword"
              type="password"
              autocomplete="new-password"
              minlength={12}
              maxlength={128}
              value={newPassword}
              onInput={(event) => setNewPassword(event.currentTarget.value)}
            />
          </label>
          <label>
            再次输入新密码
            <input
              name="confirmPassword"
              type="password"
              autocomplete="new-password"
              minlength={12}
              maxlength={128}
              value={confirmPassword}
              onInput={(event) => setConfirmPassword(event.currentTarget.value)}
            />
          </label>
          <ActionableStatus errorCode={passwordError} />
          <button class="primary-button" type="submit" disabled={passwordPending}>
            {passwordPending
              ? account.passwordResetRequired
                ? "设置中…"
                : "更新中…"
              : account.passwordResetRequired
                ? "设置登录密码"
                : "更新密码"}
          </button>
        </form>
      </div>
      {notice === null ? null : <div class="inline-status inline-status--success">{notice}</div>}
    </ModalDialog>
  );
}
