import { useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";

export interface AppShellProps {
  readonly store: UiStore;
  readonly serverHost: string;
  readonly serverConnected: boolean;
  readonly onOpenAuth: () => void;
  readonly onOpenMessages: () => void;
  readonly onOpenServerProfiles: () => void;
  readonly onOpenAccountSettings: (() => void) | null;
  readonly children: ComponentChildren;
}

export function AppShell({
  store,
  serverHost,
  serverConnected,
  onOpenAuth,
  onOpenMessages,
  onOpenServerProfiles,
  onOpenAccountSettings,
  children,
}: AppShellProps): JSX.Element {
  const [loggingOut, setLoggingOut] = useState(false);
  const shell = store.shell.value;
  const account = shell.account;

  async function logout(): Promise<void> {
    setLoggingOut(true);
    await store.command({ name: "AUTH_LOGOUT" });
    setLoggingOut(false);
  }

  return (
    <div class="syncaction-app" data-native-sidepanel>
      <header class="top-bar" data-editorial-identity>
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true">
            <Icon name="logo" size={36} />
          </span>
          <button
            class="server-button"
            type="button"
            aria-label={`切换服务器，当前 ${serverHost}`}
            onClick={onOpenServerProfiles}
          >
            <strong class="server-button__title">SyncAction</strong>
            <span class="server-button__host">
              <span class={serverConnected ? "status-dot status-dot--online" : "status-dot"} />
              {serverHost}
            </span>
          </button>
        </div>
        <div class="top-bar__actions">
          <button
            class="icon-button"
            type="button"
            aria-label="消息"
            title="消息"
            onClick={onOpenMessages}
          >
            <Icon name="message" />
            {store.notifications.value.unreadCount > 0 ? (
              <span class="notification-badge">
                {store.notifications.value.unreadCount > 99
                  ? "99+"
                  : store.notifications.value.unreadCount}
              </span>
            ) : null}
          </button>
          {account === null ? (
            <button class="auth-button" type="button" onClick={onOpenAuth}>
              登录 | 注册
            </button>
          ) : (
            <div class="account-chip">
              {onOpenAccountSettings === null ? (
                <span class="account-identity-button" title={`当前账户 ${account.displayName}`}>
                  <span class="avatar" aria-hidden="true">
                    {account.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <strong>{account.displayName}</strong>
                </span>
              ) : (
                <button
                  class="account-identity-button"
                  type="button"
                  aria-label={`账户设置，当前 ${account.displayName}`}
                  title="账户设置"
                  onClick={onOpenAccountSettings}
                >
                  <span class="avatar" aria-hidden="true">
                    {account.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <strong>{account.displayName}</strong>
                </button>
              )}
              <button
                class="text-button"
                type="button"
                disabled={loggingOut}
                onClick={() => void logout()}
              >
                {loggingOut ? "退出中…" : "退出"}
              </button>
            </div>
          )}
        </div>
      </header>
      {children}
      <div class="sr-only" id="syncaction-live-status" aria-live="polite" aria-atomic="true" />
      <div class="sr-only" id="syncaction-live-error" aria-live="assertive" aria-atomic="true" />
    </div>
  );
}
