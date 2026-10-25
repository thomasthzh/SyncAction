import type { ComponentChildren, JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { GlassMaterial } from "./glass-material.js";
import { isPlaceholderServerOrigin } from "../../server-configuration.js";

export interface AppShellProps {
  readonly store: UiStore;
  readonly serverHost: string;
  readonly serverConnected: boolean;
  readonly onOpenAuth: () => void;
  readonly onOpenMessages: () => void;
  readonly onOpenServerProfiles: () => void;
  readonly onOpenSettings: () => void;
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
  onOpenSettings,
  onOpenAccountSettings,
  children,
}: AppShellProps): JSX.Element {
  const shell = store.shell.value;
  const account = shell.account;
  const selectedProfile = shell.profiles.find(
    ({ profileId }) => profileId === shell.selectedProfileId,
  );
  const configurationRequired = isPlaceholderServerOrigin(selectedProfile?.baseUrl ?? "");
  const authLabel = configurationRequired
    ? "配置服务器"
    : shell.phase === "ACCOUNT_PENDING" || account?.status === "PENDING"
      ? "批准后登录"
      : shell.phase === "SESSION_EXPIRED"
        ? "重新登录"
        : "登录 | 注册";

  return (
    <div class="syncaction-app" data-native-sidepanel>
      <header class="top-bar" data-editorial-identity>
        <GlassMaterial />
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true">
            <Icon name="logo" size={30} />
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
            aria-label="设置"
            title="设置"
            onClick={onOpenSettings}
          >
            <Icon name="settings" />
          </button>
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
          {account?.status !== "ACTIVE" || shell.phase === "SESSION_EXPIRED" ? (
            <button
              class="auth-button"
              type="button"
              onClick={configurationRequired ? onOpenServerProfiles : onOpenAuth}
            >
              {authLabel}
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
