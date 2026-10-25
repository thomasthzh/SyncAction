import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { ModalDialog } from "./modal-dialog.js";
import { ServiceStatusCard, type ServiceStatusProbe } from "./service-status-card.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import { ActionableStatus } from "./actionable-status.js";
import { isPlaceholderServerOrigin } from "../../server-configuration.js";

export function WorkspaceSettings({
  store,
  onClose,
  onOpenServerProfiles,
  onOpenAuthorizedSites,
  onOpenAccountSettings,
  serviceStatusProbe,
}: {
  readonly store: UiStore;
  readonly onClose: () => void;
  readonly onOpenServerProfiles: () => void;
  readonly onOpenAuthorizedSites: () => void;
  readonly onOpenAccountSettings: (() => void) | null;
  readonly serviceStatusProbe?: ServiceStatusProbe;
}): JSX.Element {
  const shell = store.shell.value;
  const profile = shell.profiles.find(({ profileId }) => profileId === shell.selectedProfileId)!;
  const feedback = useCommandFeedback();
  const errorCode = shell.phase === "ERROR" ? (shell.errorCode ?? "NETWORK_ERROR") : null;
  return (
    <ModalDialog
      titleId="workspace-settings-title"
      onClose={onClose}
      pending={feedback.pending !== null}
      className="workspace-settings"
    >
      <header class="dialog-header">
        <div>
          <p class="eyebrow">SyncAction</p>
          <h2 id="workspace-settings-title">设置</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
          disabled={feedback.pending !== null}
        >
          <Icon name="close" />
        </button>
      </header>
      <section class="settings-section" aria-labelledby="settings-account-title">
        <h3 id="settings-account-title">账户</h3>
        <div class="settings-identity">
          <span class="avatar" aria-hidden="true">
            {shell.account?.displayName.slice(0, 1) ?? "S"}
          </span>
          <div>
            <strong>{shell.account?.displayName ?? "尚未登录"}</strong>
            <small>
              {shell.account === null
                ? "连接服务器后登录，继续你的协作"
                : `@${shell.account.username}`}
            </small>
          </div>
        </div>
        {onOpenAccountSettings === null ? null : (
          <button
            class="settings-row"
            type="button"
            disabled={feedback.pending !== null}
            onClick={onOpenAccountSettings}
          >
            <span>
              <strong>账户设置</strong>
              <small>名称、账户密钥与安全</small>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        )}
      </section>
      <section class="settings-section" aria-labelledby="settings-service-title">
        <h3 id="settings-service-title">连接与权限</h3>
        <button
          class="settings-row"
          type="button"
          aria-label="服务器"
          disabled={feedback.pending !== null}
          onClick={onOpenServerProfiles}
        >
          <span>
            <strong>服务器</strong>
            <small>{profile.baseUrl}</small>
          </span>
          <Icon name="chevron" size={16} />
        </button>
        <button
          class="settings-row"
          type="button"
          disabled={feedback.pending !== null}
          onClick={onOpenAuthorizedSites}
        >
          <span>
            <strong>已授权站点</strong>
            <small>查看与撤销网站协作权限</small>
          </span>
          <Icon name="chevron" size={16} />
        </button>
        {isPlaceholderServerOrigin(profile.baseUrl) ? (
          <p class="subtle-copy">先配置服务器，再检测连接状态。</p>
        ) : (
          <ServiceStatusCard
            profile={profile}
            transport={store.transport.value}
            connectionErrorCode={errorCode}
            onOpenServerProfiles={() => {
              if (feedback.pending === null) onOpenServerProfiles();
            }}
            {...(serviceStatusProbe === undefined ? {} : { probe: serviceStatusProbe })}
          />
        )}
      </section>
      <ActionableStatus errorCode={feedback.errorCode} />
      {shell.account?.status === "ACTIVE" ? (
        <footer class="dialog-actions">
          <button
            class="text-button"
            type="button"
            disabled={feedback.pending !== null}
            onClick={() =>
              void feedback
                .run("logout", () => store.command({ name: "AUTH_LOGOUT" }))
                .then((result) => {
                  if (result?.ok) onClose();
                })
            }
          >
            {feedback.pending === "logout" ? "退出中…" : "退出登录"}
          </button>
        </footer>
      ) : null}
    </ModalDialog>
  );
}
