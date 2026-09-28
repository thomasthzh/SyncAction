import { LogicalTabIdSchema, type ServerCapability } from "@syncaction/protocol";
import { useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { createSharedTabRows, type PageCompatibility } from "../../ui/collaboration-view-model.js";
import { createMediaViewModel, type MediaViewIntent } from "../../ui/media-view-model.js";
import { ActionableStatus, type StatusRecoveryAction } from "./actionable-status.js";
import { BottomActionDock } from "./bottom-action-dock.js";
import { PlaybackGroupCard } from "./playback-group-card.js";
import { SharedTabRow } from "./shared-tab-row.js";

export interface ActiveRoomProps {
  readonly store: UiStore;
  readonly serverHost: string;
  readonly now: () => number;
  readonly onOpenServerProfiles: () => void;
  readonly onOpenInvite: () => void;
  readonly onOpenRoomLifecycle: () => void;
  readonly onRequestPagePermission: (intentKey: string) => void;
}

export function ActiveRoom({
  store,
  serverHost,
  now,
  onOpenServerProfiles,
  onOpenInvite,
  onOpenRoomLifecycle,
  onRequestPagePermission,
}: ActiveRoomProps): JSX.Element {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const shell = store.shell.value;
  const room = store.room.value;
  const collaboration = store.collaboration.value;
  const detail = room.detail;
  const runtime = room.runtime;
  const pages = collaboration.pages;
  const members = collaboration.members;
  const nowMs = now();
  const currentUserId = shell.account?.id ?? null;
  const memberById = useMemo(
    () => new Map(members.map((member) => [member.userId, member] as const)),
    [members],
  );
  const onlineCount = useMemo(
    () => members.reduce((count, member) => count + (member.online ? 1 : 0), 0),
    [members],
  );
  const totalCount = detail?.members.length ?? collaboration.members.length;
  const selectedProfile =
    shell.profiles.find(({ profileId }) => profileId === shell.selectedProfileId) ?? null;
  const profileCapabilities = selectedProfile?.metadata?.capabilities;
  const capabilities = useMemo(
    () =>
      new Set<ServerCapability>(
        (profileCapabilities ?? []).filter(
          (capability): capability is ServerCapability =>
            capability === "public-rooms" ||
            capability === "join-requests" ||
            capability === "notifications" ||
            capability === "volatile-pointer-v2" ||
            capability === "content-compatibility-v1",
        ),
      ),
    [profileCapabilities],
  );
  const media = runtime?.media ?? null;
  const mediaView = useMemo(
    () => createMediaViewModel({ media, pages, members, nowMs }),
    [media, pages, members, nowMs],
  );
  const compatibilityByPage = useMemo(
    () =>
      Object.fromEntries(
        pages.map((page) => [
          page.pageId,
          page.compatibility ??
            pageCompatibility(
              capabilities.has("content-compatibility-v1"),
              media?.errorCode ?? null,
            ),
        ]),
      ),
    [capabilities, media?.errorCode, pages],
  );
  const rows = useMemo(
    () => createSharedTabRows({ pages, members, currentUserId, compatibilityByPage }),
    [pages, members, currentUserId, compatibilityByPage],
  );
  const mediaPageIds = useMemo(() => {
    const pageIds = new Set<string>();
    for (const group of mediaView.groups) {
      if (group.target !== null) {
        pageIds.add(group.target.pageId);
      }
    }
    return pageIds;
  }, [mediaView.groups]);
  const statusCode = roomStatusCode(store);
  const connectionLabel =
    statusCode === null
      ? "已同步"
      : statusCode === "RECONNECTING"
        ? "恢复中"
        : statusCode === "LOADING"
          ? "载入中"
          : "需处理";

  function sendMediaIntent(intent: MediaViewIntent): void {
    switch (intent.type) {
      case "JUMP_TO_MEMBER":
        void store.command({
          name: "MEDIA_MEMBER_JUMP",
          payload: { userId: intent.userId },
        });
        return;
      case "ALIGN_ONCE":
        void store.command({
          name: "MEDIA_GROUP_ALIGN_ONCE",
          payload: { playbackGroupId: intent.playbackGroupId },
        });
        return;
      case "JOIN_GROUP":
        void store.command({
          name: "MEDIA_GROUP_JOIN",
          payload: { playbackGroupId: intent.playbackGroupId },
        });
        return;
      case "LEAVE_GROUP":
        void store.command({
          name: "MEDIA_GROUP_LEAVE",
          payload: { playbackGroupId: intent.playbackGroupId },
        });
        return;
      case "CLOSE_GROUP":
        void store.command({
          name: "MEDIA_GROUP_CLOSE",
          payload: { playbackGroupId: intent.playbackGroupId },
        });
        return;
      case "TAKEOVER_DEVICE":
        void store.command({
          name: "MEDIA_DEVICE_TAKEOVER",
          payload: { playbackGroupId: intent.playbackGroupId },
        });
        return;
      case "DECIDE_PROPOSAL":
        void store.command({
          name: "MEDIA_PROPOSAL_DECIDE",
          payload: {
            playbackGroupId: intent.playbackGroupId,
            proposalId: intent.proposalId,
            decision: intent.decision,
          },
        });
    }
  }

  function recover(action: StatusRecoveryAction): void {
    switch (action) {
      case "CONFIRM_RECOVERY":
        void store.command({ name: "BROWSER_RECOVERY_CONFIRM" });
        return;
      case "ALLOW_PAGE":
        onRequestPagePermission("page-collaboration");
        return;
      case "RETRY":
        void store.command({ name: "PAGE_PERMISSION_REFRESH" });
        return;
      case "SWITCH_SERVER":
      case "UPGRADE_CLIENT":
        onOpenServerProfiles();
    }
  }

  return (
    <div class="active-room">
      <header class="room-header">
        <div class="room-switcher">
          <button
            class="room-title-button"
            type="button"
            aria-label="切换房间"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((open) => !open)}
          >
            <span>{detail?.name ?? runtime?.roomName ?? "房间"}</span>
            <Icon name="chevron" size={16} />
          </button>
          {switcherOpen ? (
            <div class="room-switcher__menu" role="menu" aria-label="我的房间">
              <strong>我的房间</strong>
              {store.discovery.value.rooms.map((candidate) => (
                <button
                  type="button"
                  role="menuitem"
                  key={candidate.id}
                  aria-label={candidate.name}
                  aria-current={candidate.id === room.selectedRoomId ? "true" : undefined}
                  onClick={() => {
                    setSwitcherOpen(false);
                    void store.command({
                      name: "ROOM_SELECT",
                      payload: { roomId: candidate.id },
                    });
                  }}
                >
                  {candidate.name}
                </button>
              ))}
              {detail?.role === "OWNER" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSwitcherOpen(false);
                    onOpenRoomLifecycle();
                  }}
                >
                  房间设置
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div class="room-header__meta" data-room-presence-summary>
          <strong>
            {onlineCount} 在线 · {totalCount} 位成员
          </strong>
          <span>{serverHost}</span>
        </div>
      </header>

      <div class="room-live-rail" data-room-live-rail aria-label="房间实时摘要">
        <span
          class={`room-live-rail__item room-live-rail__item--connection${
            statusCode === null ? "" : " room-live-rail__item--attention"
          }`}
          data-connection-state={statusCode === null ? "SYNCED" : "ATTENTION"}
        >
          <span class={`status-dot${statusCode === null ? " status-dot--online" : ""}`} />
          <strong>{connectionLabel}</strong>
        </span>
        <span class="room-live-rail__item">
          <Icon name="users" size={15} />
          <strong>{onlineCount} 在线</strong>
        </span>
        <span class="room-live-rail__item">
          <Icon name="sync" size={15} />
          <strong>{rows.length} 个页面</strong>
        </span>
        <span class="room-live-rail__item">
          <Icon name="play" size={15} />
          <strong>{mediaView.groups.length} 个播放组</strong>
        </span>
      </div>

      <ActionableStatus statusCode={statusCode} onAction={recover} />
      {mediaView.notice === null ? null : (
        <p class={`media-notice media-notice--${mediaView.notice.tone}`}>{mediaView.notice.text}</p>
      )}

      {mediaView.groups.length > 0 ? (
        <section
          class="playback-section editorial-surface"
          data-editorial-surface="playback"
          aria-labelledby="playback-heading"
        >
          <header class="section-heading">
            <div>
              <p class="eyebrow">同步播放</p>
              <h2 id="playback-heading">播放组</h2>
            </div>
            <span>{mediaView.groups.length}</span>
          </header>
          <div class="playback-section__list divided-list">
            {mediaView.groups.map((group) => (
              <PlaybackGroupCard
                group={group}
                currentUserId={currentUserId}
                onIntent={sendMediaIntent}
                key={group.groupId}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section
        class="shared-tab-stream editorial-surface"
        data-editorial-surface="shared-pages"
        aria-labelledby="shared-page-heading"
      >
        <header class="section-heading">
          <div>
            <p class="eyebrow">实时位置</p>
            <h2 id="shared-page-heading">共享页面</h2>
          </div>
          <span>
            {collaboration.capacity.openTabCount}
            {collaboration.capacity.limit === null ? "" : `/${collaboration.capacity.limit}`}
          </span>
        </header>
        {rows.length === 0 ? (
          <p class="subtle-copy">还没有共享页面。底部操作可将当前标签页加入房间。</p>
        ) : (
          <div class="shared-tab-stream__list divided-list">
            {rows.map((row) => (
              <SharedTabRow
                row={row}
                memberById={memberById}
                currentUserId={currentUserId}
                isMediaPage={mediaPageIds.has(row.pageKey)}
                onActivate={(pageId) =>
                  void store.command({
                    name: "ROOM_TAB_ACTIVATE",
                    payload: { logicalTabId: LogicalTabIdSchema.parse(pageId) },
                  })
                }
                onMediaMemberJump={(userId) =>
                  void store.command({
                    name: "MEDIA_MEMBER_JUMP",
                    payload: { userId },
                  })
                }
                key={row.pageKey}
              />
            ))}
          </div>
        )}
      </section>

      {detail?.visibility === "PUBLIC" ? (
        <details class="public-room-details">
          <summary>公开房间信息</summary>
          <p>
            {detail.joinPolicy === "OPEN"
              ? "任何已登录用户可直接加入"
              : detail.joinPolicy === "APPROVAL"
                ? "新成员需房主批准"
                : "公开可见，仅可通过邀请加入"}
          </p>
        </details>
      ) : null}
      <BottomActionDock
        store={store}
        isOwner={detail?.role === "OWNER"}
        onOpenInvite={onOpenInvite}
        onOpenRoomLifecycle={onOpenRoomLifecycle}
        onRequestPagePermission={onRequestPagePermission}
      />
    </div>
  );
}

function pageCompatibility(
  serverSupportsCompatibility: boolean,
  mediaErrorCode: string | null,
): PageCompatibility {
  if (mediaErrorCode === "TARGET_MISMATCH" || mediaErrorCode === "PAGE_MISMATCH") {
    return "MISMATCH";
  }
  return serverSupportsCompatibility ? "EXACT" : "UNKNOWN";
}

function roomStatusCode(store: UiStore): string | null {
  if (store.transport.value === "RECONNECTING") {
    return "RECONNECTING";
  }
  if (store.shell.value.phase === "CONNECTING_ROOM") {
    return "LOADING";
  }
  const runtime = store.room.value.runtime;
  if (runtime === null) {
    return "WAITING_SNAPSHOT";
  }
  if (runtime.state === "WAITING_SNAPSHOT") {
    return "WAITING_SNAPSHOT";
  }
  if (runtime.browser?.state === "RECOVERY_REQUIRED") {
    return runtime.browser.reason === "CIRCUIT_BREAKER" ? "CIRCUIT_BREAKER" : "RECOVERY_REQUIRED";
  }
  return null;
}
