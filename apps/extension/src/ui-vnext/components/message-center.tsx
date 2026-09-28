import type { Notification, NotificationType } from "@syncaction/protocol";
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon, type IconName } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";
import { InvitePicker } from "./invite-picker.js";
import { ModalDialog } from "./modal-dialog.js";

type ThreadKind = "REQUEST" | "INVITATION" | "SINGLE";

export interface NotificationThread {
  readonly key: string;
  readonly kind: ThreadKind;
  readonly notifications: readonly Notification[];
  readonly firstCursor: number;
  readonly latest: Notification;
  readonly unread: boolean;
}

export function foldNotificationThreads(
  notifications: readonly Notification[],
): NotificationThread[] {
  const groups = new Map<string, Notification[]>();
  for (const notification of [...notifications].sort((left, right) => left.cursor - right.cursor)) {
    const key =
      notification.requestId !== null
        ? `request:${notification.requestId}`
        : notification.invitationId !== null
          ? `invitation:${notification.invitationId}`
          : `notification:${notification.notificationId}`;
    const thread = groups.get(key) ?? [];
    thread.push(notification);
    groups.set(key, thread);
  }
  return [...groups.entries()]
    .map(([key, values]): NotificationThread => {
      const latest = values.at(-1)!;
      return {
        key,
        kind:
          latest.requestId !== null
            ? "REQUEST"
            : latest.invitationId !== null
              ? "INVITATION"
              : "SINGLE",
        notifications: values,
        firstCursor: values[0]!.cursor,
        latest,
        unread: values.some(({ readAt }) => readAt === null),
      };
    })
    .sort(
      (left, right) =>
        Number(right.unread) - Number(left.unread) ||
        right.firstCursor - left.firstCursor ||
        left.key.localeCompare(right.key),
    );
}

export interface MessageCenterProps {
  readonly store: UiStore;
  readonly onClose: () => void;
}

export function MessageCenter({ store, onClose }: MessageCenterProps): JSX.Element {
  const [view, setView] = useState<"MESSAGES" | "INVITE">("MESSAGES");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const threads = foldNotificationThreads(store.notifications.value.items);
  const policySyncPendingCount = store.pageAccess.value.policySyncPendingCount;
  const room = store.room.value.detail;
  const canInvite = room?.role === "OWNER";

  async function run(key: string, command: Parameters<UiStore["command"]>[0]): Promise<void> {
    setPendingKey(key);
    setErrorCode(null);
    const result = await store.command(command);
    if (!result.ok) {
      setErrorCode(result.errorCode);
    }
    setPendingKey(null);
  }

  const titleId = view === "INVITE" ? "invite-picker-title" : "syncaction-message-center-title";
  return (
    <ModalDialog titleId={titleId} onClose={onClose}>
      {view === "INVITE" ? (
        <InvitePicker store={store} backLabel="返回消息" onBack={() => setView("MESSAGES")} />
      ) : (
        <section class="message-center">
          <header class="dialog-header">
            <div>
              <p class="eyebrow">{store.notifications.value.unreadCount} 条未读</p>
              <h2 id={titleId}>消息中心</h2>
            </div>
            <div class="dialog-header__actions">
              {canInvite ? (
                <button class="compact-button" type="button" onClick={() => setView("INVITE")}>
                  邀请成员
                </button>
              ) : null}
              <button
                class="text-button"
                type="button"
                onClick={() => void run("all", { name: "NOTIFICATIONS_READ_ALL" })}
              >
                全部已读
              </button>
              <button
                class="icon-button"
                type="button"
                aria-label="关闭"
                title="关闭"
                onClick={onClose}
              >
                <Icon name="close" />
              </button>
            </div>
          </header>
          <ActionableStatus errorCode={errorCode} />
          {policySyncPendingCount > 0 ? (
            <article class="message-card is-unread" data-local-policy-sync>
              <div class="message-card__body">
                <span class="message-card__icon" aria-hidden="true">
                  <Icon name="sync" size={18} />
                </span>
                <span>
                  <strong>页面授权记录待同步</strong>
                  <small>
                    {policySyncPendingCount} 个站点的本地授权可继续使用，服务器策略记录仍待同步。
                  </small>
                </span>
                <i class="unread-dot" aria-hidden="true" />
              </div>
              <div class="message-card__actions">
                <button
                  class="compact-button"
                  type="button"
                  aria-label="重试同步页面授权记录"
                  disabled={pendingKey === "local-policy-sync"}
                  onClick={() =>
                    void run("local-policy-sync", {
                      name: "POLICY_ACCEPTANCE_RECORD",
                    })
                  }
                >
                  {pendingKey === "local-policy-sync" ? "正在重试…" : "重试同步"}
                </button>
              </div>
            </article>
          ) : null}
          {threads.length === 0 && policySyncPendingCount === 0 ? (
            <div class="empty-state">
              <strong>暂无消息</strong>
              <span>加入申请、邀请和系统更新会出现在这里。</span>
            </div>
          ) : (
            <div class="message-list">
              {threads.map((thread) => (
                <MessageCard
                  thread={thread}
                  store={store}
                  pending={pendingKey === thread.key}
                  onCommand={(command) => void run(thread.key, command)}
                  key={thread.key}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </ModalDialog>
  );
}

function MessageCard({
  thread,
  store,
  pending,
  onCommand,
}: {
  readonly thread: NotificationThread;
  readonly store: UiStore;
  readonly pending: boolean;
  readonly onCommand: (command: Parameters<UiStore["command"]>[0]) => void;
}): JSX.Element {
  const notification = thread.latest;
  const view = notificationView(notification, store);
  const isCurrentOwner =
    notification.room !== null &&
    store.discovery.value.rooms.some(
      (room) => room.id === notification.room!.roomId && room.role === "OWNER",
    );
  const canDecide =
    thread.kind === "REQUEST" &&
    notification.type === "ROOM_JOIN_REQUEST_CREATED" &&
    isCurrentOwner;
  const canAccept =
    thread.kind === "INVITATION" &&
    notification.type === "ROOM_INVITATION_CREATED" &&
    notification.invitationId !== null &&
    store.discovery.value.invitations.some(({ id }) => id === notification.invitationId);
  return (
    <article
      class={thread.unread ? "message-card is-unread" : "message-card"}
      data-message-card
      data-unread={thread.unread ? "true" : "false"}
    >
      <button
        class="message-card__body"
        type="button"
        aria-label={`阅读 ${view.title}`}
        onClick={() =>
          onCommand({
            name: "NOTIFICATION_READ",
            payload: { notificationId: notification.notificationId },
          })
        }
      >
        <span class="message-card__icon" aria-hidden="true">
          <Icon name={view.icon} size={18} />
        </span>
        <span>
          <strong>{view.title}</strong>
          <small>{view.detail}</small>
        </span>
        {thread.unread ? <i class="unread-dot" aria-hidden="true" /> : null}
      </button>
      {canDecide ? (
        <div class="message-card__actions">
          <button
            class="compact-button"
            type="button"
            disabled={pending}
            onClick={() =>
              onCommand({
                name: "JOIN_REQUEST_DECIDE",
                payload: {
                  requestId: notification.requestId!,
                  decision: "APPROVE",
                },
              })
            }
          >
            同意申请
          </button>
          <button
            class="text-button"
            type="button"
            disabled={pending}
            onClick={() =>
              onCommand({
                name: "JOIN_REQUEST_DECIDE",
                payload: {
                  requestId: notification.requestId!,
                  decision: "REJECT",
                },
              })
            }
          >
            拒绝申请
          </button>
        </div>
      ) : null}
      {canAccept ? (
        <div class="message-card__actions">
          <button
            class="compact-button"
            type="button"
            disabled={pending}
            onClick={() =>
              onCommand({
                name: "INVITATION_ACCEPT",
                payload: { invitationId: notification.invitationId! },
              })
            }
          >
            接受邀请
          </button>
        </div>
      ) : null}
    </article>
  );
}

function notificationView(
  notification: Notification,
  store: UiStore,
): { title: string; detail: string; icon: IconName } {
  const actor = notification.actor?.displayName ?? "成员";
  const room = notification.room?.name ?? "房间";
  switch (notification.type) {
    case "ROOM_INVITATION_CREATED": {
      const active = store.discovery.value.invitations.some(
        ({ id }) => id === notification.invitationId,
      );
      return {
        title: active ? "邀请加入" : "邀请已处理",
        detail: `${actor} 邀请你加入「${room}」`,
        icon: "invite",
      };
    }
    case "ROOM_INVITATION_REVOKED":
      return { title: "邀请已撤回", detail: `「${room}」的邀请已失效`, icon: "close" };
    case "ROOM_JOIN_REQUEST_CREATED":
      return { title: "新的加入申请", detail: `${actor} 申请加入「${room}」`, icon: "users" };
    case "ROOM_JOIN_REQUEST_APPROVED":
      return { title: "加入申请已通过", detail: `${actor} 已加入「${room}」`, icon: "sync" };
    case "ROOM_JOIN_REQUEST_REJECTED":
      return { title: "加入申请已拒绝", detail: `「${room}」的申请已结束`, icon: "close" };
    case "ROOM_JOIN_REQUEST_CANCELLED":
      return { title: "加入申请已取消", detail: `${actor} 取消了申请`, icon: "close" };
    case "ROOM_MEMBER_REMOVED":
      return { title: "成员变更", detail: `${actor} 已离开「${room}」`, icon: "leave" };
    case "ROOM_OWNERSHIP_TRANSFERRED":
      return { title: "房主已变更", detail: `${actor} 现在管理「${room}」`, icon: "transfer" };
    case "ROOM_DISSOLVED":
      return { title: "房间已解散", detail: `「${room}」已停止协作`, icon: "trash" };
    case "SYSTEM_ANNOUNCEMENT":
    case "SYSTEM_UPDATE":
      return {
        title: notification.title ?? "系统通知",
        detail: notification.body ?? "",
        icon: notification.type === "SYSTEM_UPDATE" ? "sync" : "message",
      };
  }
}

export function isRequestNotification(type: NotificationType): boolean {
  return type.startsWith("ROOM_JOIN_REQUEST_");
}
