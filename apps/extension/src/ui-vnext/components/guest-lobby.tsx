import type { PublicRoomSummary } from "@syncaction/protocol";
import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import type { UiCommandResult } from "../../ui/ui-protocol.js";
import { ActionableStatus } from "./actionable-status.js";
import { PublicRoomFeed } from "./public-room-feed.js";
import { ServiceStatusCard, type ServiceStatusProbe } from "./service-status-card.js";

export interface GuestLobbyProps {
  readonly store: UiStore;
  readonly actionError: string | null;
  readonly onJoinPublicRoom: (room: PublicRoomSummary) => Promise<UiCommandResult>;
  readonly onOpenCreateRoom: () => void;
  readonly serviceStatusProbe?: ServiceStatusProbe;
}

export function GuestLobby({
  store,
  actionError,
  onJoinPublicRoom,
  onOpenCreateRoom,
  serviceStatusProbe,
}: GuestLobbyProps): JSX.Element {
  const shell = store.shell.value;
  const discovery = store.discovery.value;
  const authenticated = shell.account !== null && shell.phase !== "SESSION_EXPIRED";
  const selectedProfile =
    shell.profiles.find(({ profileId }) => profileId === shell.selectedProfileId) ??
    shell.profiles[0]!;

  return (
    <div class="lobby-surface">
      <section class="welcome-strip">
        <div>
          <p class="eyebrow">
            {authenticated ? `你好，${shell.account?.displayName}` : "轻量协作"}
          </p>
          <h1>一起浏览</h1>
          <p class="welcome-strip__lede">房间、页面和播放进度会自动同步</p>
        </div>
        {authenticated ? (
          <button class="primary-button" type="button" onClick={onOpenCreateRoom}>
            创建房间
          </button>
        ) : null}
      </section>

      <ServiceStatusCard
        profile={selectedProfile}
        transport={store.transport.value}
        {...(serviceStatusProbe === undefined ? {} : { probe: serviceStatusProbe })}
      />

      {shell.phase === "ACCOUNT_PENDING" ? (
        <p class="account-pending">账号申请已提交，管理员批准后即可登录</p>
      ) : null}

      {store.transport.value === "RECONNECTING" ? (
        <p class="connection-strip">连接正在恢复，已显示上次同步内容</p>
      ) : null}

      {authenticated ? (
        <section
          class="my-rooms editorial-surface"
          data-editorial-surface="my-rooms"
          aria-labelledby="my-room-heading"
        >
          <header class="section-heading">
            <div>
              <p class="eyebrow">继续协作</p>
              <h2 id="my-room-heading">我的房间</h2>
            </div>
            <span>{discovery.rooms.length}/5</span>
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
                  onClick={() =>
                    void store.command({
                      name: "ROOM_SELECT",
                      payload: { roomId: room.id },
                    })
                  }
                >
                  <span>
                    <strong>{room.name}</strong>
                    <small>
                      {room.role === "OWNER" ? "房主" : "成员"} ·{" "}
                      {room.visibility === "PUBLIC" ? "公开" : "私密"}
                    </small>
                  </span>
                  <Icon name="chevron" size={16} />
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
                    onClick={() =>
                      void store.command({
                        name: "INVITATION_ACCEPT",
                        payload: { invitationId: invitation.id },
                      })
                    }
                  >
                    接受
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <ActionableStatus errorCode={actionError} />
      <PublicRoomFeed
        rooms={discovery.publicRooms}
        onJoin={onJoinPublicRoom}
        onRefresh={() => store.command({ name: "PUBLIC_ROOMS_REFRESH" })}
      />
    </div>
  );
}
