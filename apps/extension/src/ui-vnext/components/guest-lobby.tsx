import type { PublicRoomSummary } from "@syncaction/protocol";
import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import type { UiCommandResult } from "../../ui/ui-protocol.js";
import { ActionableStatus } from "./actionable-status.js";
import { PublicRoomFeed } from "./public-room-feed.js";
import { ServiceStatusCard, type ServiceStatusProbe } from "./service-status-card.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import { isPlaceholderServerOrigin } from "../../server-configuration.js";

export interface GuestLobbyProps {
  readonly store: UiStore;
  readonly actionError: string | null;
  readonly onJoinPublicRoom: (room: PublicRoomSummary) => Promise<UiCommandResult>;
  readonly onOpenCreateRoom: () => void;
  readonly onOpenAuth: () => void;
  readonly onOpenServerProfiles?: () => void;
  readonly serviceStatusProbe?: ServiceStatusProbe;
}

export function GuestLobby({
  store,
  actionError,
  onJoinPublicRoom,
  onOpenCreateRoom,
  onOpenAuth,
  onOpenServerProfiles = onOpenAuth,
  serviceStatusProbe,
}: GuestLobbyProps): JSX.Element {
  const shell = store.shell.value;
  const discovery = store.discovery.value;
  const feedback = useCommandFeedback();
  const authenticated = shell.account?.status === "ACTIVE" && shell.phase !== "SESSION_EXPIRED";
  const pending = shell.phase === "ACCOUNT_PENDING" || shell.account?.status === "PENDING";
  const selectedProfile =
    shell.profiles.find(({ profileId }) => profileId === shell.selectedProfileId) ??
    shell.profiles[0]!;
  const returning = authenticated && discovery.rooms.length > 0;
  const connectionErrorCode = shell.phase === "ERROR" ? (shell.errorCode ?? "NETWORK_ERROR") : null;
  const reconnectAllowed =
    connectionErrorCode !== null &&
    !["SERVER_IDENTITY_CHANGED", "SERVER_PROTOCOL_UNSUPPORTED", "CLIENT_UPGRADE_REQUIRED"].includes(
      connectionErrorCode,
    );

  if (isPlaceholderServerOrigin(selectedProfile.baseUrl)) {
    return (
      <div class="lobby-surface">
        <section class="welcome-strip editorial-surface" aria-labelledby="first-server-title">
          <div>
            <p class="eyebrow">首次使用</p>
            <h1 id="first-server-title">先连接你的服务器</h1>
            <p>请向邀请你的朋友或管理员取得服务器地址。此安装包没有预设共享服务器。</p>
            <p class="subtle-copy">连接后即可登录、注册或浏览该服务器的公开房间。</p>
          </div>
          <button class="primary-button" type="button" onClick={onOpenServerProfiles}>
            配置服务器
          </button>
        </section>
      </div>
    );
  }

  return (
    <div class={`lobby-surface${returning ? " lobby-surface--returning" : ""}`}>
      <section class={`welcome-strip${returning ? " welcome-strip--compact" : ""}`}>
        <div>
          <p class="eyebrow">
            {authenticated ? `你好，${shell.account?.displayName}` : "欢迎使用 SyncAction"}
          </p>
          <h1>{returning ? "继续协作" : pending ? "等待管理员批准" : "一起浏览"}</h1>
          <p class="welcome-strip__lede">
            {returning
              ? "选择房间，回到朋友正在浏览的现场。"
              : pending
                ? "账号申请已提交，管理员批准后即可登录。"
                : "和朋友共享页面，一起看、一起聊。"}
          </p>
        </div>
        <button
          class={`${returning ? "secondary-button" : "primary-button"} welcome-strip__action`}
          type="button"
          onClick={authenticated ? onOpenCreateRoom : onOpenAuth}
        >
          <Icon name={authenticated ? "invite" : "chevron"} size={18} />
          {authenticated ? "创建房间" : pending ? "批准后登录" : "登录开始协作"}
        </button>
      </section>

      {!authenticated && !pending ? (
        <p class="getting-started">先选择房间，登录后即可加入。已有账户密钥也可直接登录。</p>
      ) : null}

      {pending ? (
        <p class="account-pending" role="status">
          管理员批准后点击「批准后登录」继续；此页面不会自动确认批准结果，无需重复注册。
        </p>
      ) : null}

      {authenticated ? (
        <section
          class="my-rooms editorial-surface"
          data-editorial-surface="my-rooms"
          aria-labelledby="my-room-heading"
        >
          <header class="section-heading">
            <div>
              {returning ? null : <p class="eyebrow">继续协作</p>}
              <h2 id="my-room-heading">我的房间</h2>
            </div>
            <span>{discovery.rooms.length} 个房间</span>
          </header>
          {discovery.rooms.length === 0 ? (
            <p class="subtle-copy">还没有房间，创建一个或从公开房间开始。</p>
          ) : (
            <div class="my-room-list divided-list">
              {discovery.rooms.map((room) => (
                <button
                  class="my-room-row"
                  type="button"
                  key={room.id}
                  aria-label={room.name}
                  disabled={feedback.pending !== null}
                  aria-busy={feedback.pending === room.id}
                  onClick={() =>
                    void feedback.run(room.id, () =>
                      store.command({
                        name: "ROOM_SELECT",
                        payload: { roomId: room.id },
                      }),
                    )
                  }
                >
                  <span>
                    <strong>{room.name}</strong>
                    <small>
                      {room.role === "OWNER" ? "房主" : "成员"} ·{" "}
                      {room.visibility === "PUBLIC" ? "公开" : "私密"}
                    </small>
                  </span>
                  <Icon
                    name={feedback.pending === room.id ? "sync" : "chevron"}
                    size={18}
                    className={feedback.pending === room.id ? "is-spinning" : ""}
                  />
                </button>
              ))}
            </div>
          )}

          {discovery.invitations.length > 0 ? (
            <div class="invitation-preview">
              <strong>邀请</strong>
              {discovery.invitations.map((invitation) => (
                <div class="invitation-preview__row" key={invitation.id}>
                  <span>{invitation.roomName}</span>
                  <button
                    class="compact-button"
                    type="button"
                    disabled={feedback.pending !== null}
                    onClick={() =>
                      void feedback.run(
                        invitation.id,
                        () =>
                          store.command({
                            name: "INVITATION_ACCEPT",
                            payload: { invitationId: invitation.id },
                          }),
                        "已接受邀请",
                      )
                    }
                  >
                    {feedback.pending === invitation.id ? "接受中…" : "接受"}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <ServiceStatusCard
        profile={selectedProfile}
        transport={store.transport.value}
        connectionErrorCode={connectionErrorCode}
        onOpenServerProfiles={onOpenServerProfiles}
        {...(reconnectAllowed
          ? {
              onReconnect: () =>
                store.command({
                  name: "SERVER_SELECT",
                  payload: { profileId: selectedProfile.profileId },
                }),
            }
          : {})}
        {...(serviceStatusProbe === undefined ? {} : { probe: serviceStatusProbe })}
      />

      <ActionableStatus errorCode={actionError} />
      <ActionableStatus errorCode={feedback.errorCode} />
      {feedback.message !== null ? (
        <p class="command-feedback" role="status">
          {feedback.message}
        </p>
      ) : null}
      <PublicRoomFeed
        rooms={discovery.publicRooms}
        onJoin={onJoinPublicRoom}
        onRefresh={() => store.command({ name: "PUBLIC_ROOMS_REFRESH" })}
      />
    </div>
  );
}
