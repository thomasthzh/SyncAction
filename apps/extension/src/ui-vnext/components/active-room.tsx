import { LogicalTabIdSchema, type ServerCapability } from "@syncaction/protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { createSharedTabRows, type PageCompatibility } from "../../ui/collaboration-view-model.js";
import { createMediaViewModel, type MediaViewIntent } from "../../ui/media-view-model.js";
import { ActionableStatus, type StatusRecoveryAction } from "./actionable-status.js";
import { BottomActionDock } from "./bottom-action-dock.js";
import { WatchWorkspace } from "./watch-workspace.js";
import { SharedTabRow } from "./shared-tab-row.js";
import { RoomSwitcher } from "./room-switcher.js";
import { StartWatchingCard } from "./start-watching-card.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import type { UiCommandInput } from "../store.js";
import { WorkspaceTabs } from "./workspace-tabs.js";
import { RoomMembersWorkspace } from "./room-members-workspace.js";

export interface ActiveRoomProps {
  readonly store: UiStore;
  readonly serverHost: string;
  readonly now: () => number;
  readonly onOpenServerProfiles: () => void;
  readonly onOpenInvite: () => void;
  readonly onOpenRoomLifecycle: () => void;
  readonly onRequestPagePermission: (intentKey: string, expectedUrl?: string) => void;
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
  const [pageQuery, setPageQuery] = useState("");
  const [workspace, setWorkspace] = useState("watch");
  const surface = useRef<HTMLDivElement>(null);
  const activeElement = document.activeElement;
  const focusedWatchControl =
    activeElement instanceof HTMLElement &&
    surface.current?.contains(activeElement) &&
    activeElement.closest(".watch-workspace") !== null
      ? activeElement
      : null;
  const feedback = useCommandFeedback();
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
  const watchConnected =
    runtime?.state === "SYNCED" &&
    store.transport.value !== "RECONNECTING" &&
    media?.state !== "OFFLINE" &&
    (media === null || media.roomMediaRevision !== null);
  const watchAwaiting = mediaView.groups.length === 0 && !watchConnected;
  const pendingOwnProposals = mediaView.groups
    .filter((group) =>
      group.members.some((member) => member.userId === currentUserId && member.role === "LEADER"),
    )
    .reduce((count, group) => count + group.proposals.length, 0);
  useLayoutEffect(() => {
    if (
      focusedWatchControl !== null &&
      !focusedWatchControl.isConnected &&
      document.activeElement === document.body
    ) {
      surface.current
        ?.querySelector<HTMLElement>(
          mediaView.groups.length === 0
            ? "[data-start-watching-action], [data-watch-awaiting]"
            : '[data-editorial-surface="playback"]',
        )
        ?.focus();
    }
  }, [mediaView.groups.length, media?.localMembership?.playbackGroupId, watchAwaiting]);
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
  const normalizedQuery = pageQuery.trim().toLocaleLowerCase();
  const visibleRows = useMemo(
    () =>
      normalizedQuery === ""
        ? rows
        : rows.filter((row) =>
            `${row.title} ${row.domain}`.toLocaleLowerCase().includes(normalizedQuery),
          ),
    [rows, normalizedQuery],
  );
  const statusCode = roomStatusCode(store);
  const connectionLabel =
    statusCode === null
      ? "房间已同步"
      : statusCode === "RECONNECTING" || statusCode === "RECOVERING"
        ? "恢复中"
        : statusCode === "LOADING" ||
            statusCode === "CONNECTING" ||
            statusCode === "WAITING_SNAPSHOT"
          ? "载入中"
          : "需处理";

  function sendMediaIntent(intent: MediaViewIntent): void {
    const access = store.pageAccess.value;
    if (
      intent.type === "JOIN_GROUP" &&
      (!access.browserPermissionGranted || !access.termsAccepted)
    ) {
      onRequestPagePermission(`media-join:${intent.playbackGroupId}`);
      return;
    }
    void feedback.run("media", () => store.command(mediaCommand(intent)));
  }

  function mediaCommand(intent: MediaViewIntent): UiCommandInput {
    switch (intent.type) {
      case "JUMP_TO_MEMBER":
        return {
          name: "MEDIA_MEMBER_JUMP",
          payload: { userId: intent.userId },
        };
      case "ALIGN_ONCE":
        return {
          name: "MEDIA_GROUP_ALIGN_ONCE",
          payload: { playbackGroupId: intent.playbackGroupId },
        };
      case "JOIN_GROUP": {
        const access = store.pageAccess.value;
        const roomId = store.room.value.selectedRoomId;
        return {
          name: "MEDIA_GROUP_JOIN",
          payload: {
            playbackGroupId: intent.playbackGroupId,
            ...(access.tabId === null || access.documentRevision === null
              ? {}
              : {
                  expectedContext: {
                    profileId: store.shell.value.selectedProfileId,
                    tabId: access.tabId,
                    documentRevision: access.documentRevision,
                    ...(roomId === null ? {} : { roomId }),
                  },
                }),
          },
        };
      }
      case "LEAVE_GROUP":
        return {
          name: "MEDIA_GROUP_LEAVE",
          payload: { playbackGroupId: intent.playbackGroupId },
        };
      case "CLOSE_GROUP":
        return {
          name: "MEDIA_GROUP_CLOSE",
          payload: { playbackGroupId: intent.playbackGroupId },
        };
      case "TAKEOVER_DEVICE":
        return {
          name: "MEDIA_DEVICE_TAKEOVER",
          payload: { playbackGroupId: intent.playbackGroupId },
        };
      case "DECIDE_PROPOSAL":
        return {
          name: "MEDIA_PROPOSAL_DECIDE",
          payload: {
            playbackGroupId: intent.playbackGroupId,
            proposalId: intent.proposalId,
            decision: intent.decision,
          },
        };
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
    <div class="active-room" data-workspace-view={workspace} ref={surface}>
      <header class="room-header">
        <RoomSwitcher
          store={store}
          name={detail?.name ?? runtime?.roomName ?? "房间"}
          isOwner={detail?.role === "OWNER"}
          onOpenSettings={onOpenRoomLifecycle}
        />
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
          <Icon name="sync" size={15} />
          <strong>{rows.length} 个页面</strong>
        </span>
        <span class="room-live-rail__item">
          <Icon name="play" size={15} />
          <strong>{watchAwaiting ? "播放组待更新" : `${mediaView.groups.length} 个播放组`}</strong>
        </span>
      </div>

      <WorkspaceTabs
        id="room-workspace"
        label="房间工作区"
        selected={workspace}
        onSelect={setWorkspace}
        tabs={[
          { id: "watch", label: "观看", count: mediaView.groups.length },
          { id: "pages", label: "页面", count: rows.length },
          { id: "members", label: "成员", count: totalCount },
        ]}
      />

      <ActionableStatus statusCode={statusCode} onAction={recover} />
      {workspace !== "watch" && pendingOwnProposals > 0 ? (
        <button
          class="workspace-pending-action"
          type="button"
          onClick={() => {
            setWorkspace("watch");
            queueMicrotask(() =>
              surface.current?.querySelector<HTMLElement>("#room-workspace-tab-watch")?.focus(),
            );
          }}
        >
          <Icon name="message" size={16} />
          <span>你的播放组有 {pendingOwnProposals} 条待处理提议</span>
          <Icon name="chevron" size={16} />
        </button>
      ) : null}
      <ActionableStatus errorCode={feedback.errorCode} />
      {feedback.pending === "media" ? (
        <p class="command-feedback" role="status">
          正在执行播放操作…
        </p>
      ) : null}
      {mediaView.notice === null ? null : (
        <p class={`media-notice media-notice--${mediaView.notice.tone}`}>{mediaView.notice.text}</p>
      )}

      <div
        class="workspace-panel"
        id="room-workspace-panel-watch"
        role="tabpanel"
        aria-labelledby="room-workspace-tab-watch"
        hidden={workspace !== "watch"}
      >
        {watchAwaiting ? (
          <section
            class="start-watching watch-workspace editorial-surface"
            data-watch-awaiting
            tabIndex={-1}
            aria-labelledby="watch-awaiting-heading"
          >
            <h2 id="watch-awaiting-heading">播放协作暂未连接</h2>
            <p class="section-description">
              连接恢复后会重新显示视频与参与状态；当前先暂停媒体操作。
            </p>
          </section>
        ) : mediaView.groups.length === 0 ? (
          <StartWatchingCard store={store} onRequestPagePermission={onRequestPagePermission} />
        ) : null}
        {media !== null && mediaView.groups.length > 0 ? (
          <WatchWorkspace
            key={`${shell.selectedProfileId}:${room.selectedRoomId}`}
            view={mediaView}
            media={media}
            currentUserId={currentUserId}
            onIntent={sendMediaIntent}
            busy={feedback.pending === "media"}
          />
        ) : null}
        {watchConnected &&
        media !== null &&
        mediaView.groups.length > 0 &&
        media.localMembership === null ? (
          <details class="watch-new-group">
            <summary>用当前视频新建播放组</summary>
            <StartWatchingCard store={store} onRequestPagePermission={onRequestPagePermission} />
          </details>
        ) : null}
      </div>

      <section
        class="shared-tab-stream shared-tab-stream--supporting editorial-surface"
        data-editorial-surface="shared-pages"
        aria-labelledby="room-workspace-tab-pages"
        role="tabpanel"
        id="room-workspace-panel-pages"
        hidden={workspace !== "pages"}
      >
        <header class="section-heading">
          <div>
            <h2 id="shared-page-heading">共享页面</h2>
            <p class="section-description">房间里的页面，打开不会自动加入播放组</p>
          </div>
          <span>
            {collaboration.capacity.openTabCount}
            {collaboration.capacity.limit === null ? "" : `/${collaboration.capacity.limit}`}
          </span>
        </header>
        {rows.length > 4 || pageQuery !== "" ? (
          <label class="room-search shared-page-search">
            <Icon name="search" size={18} />
            <span class="sr-only">搜索共享页面</span>
            <input
              type="search"
              aria-label="搜索共享页面"
              placeholder="搜索页面或网站"
              value={pageQuery}
              onInput={(event) => setPageQuery(event.currentTarget.value)}
            />
          </label>
        ) : null}
        {rows.length === 0 ? (
          <p class="section-description">还没有共享页面</p>
        ) : visibleRows.length === 0 ? (
          <div class="empty-state">
            <strong>没有找到共享页面</strong>
            <button class="text-button" type="button" onClick={() => setPageQuery("")}>
              清空页面搜索
            </button>
          </div>
        ) : (
          <div class="shared-tab-stream__list divided-list">
            {visibleRows.map((row) => (
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

      <div
        class="workspace-panel"
        id="room-workspace-panel-members"
        role="tabpanel"
        aria-labelledby="room-workspace-tab-members"
        hidden={workspace !== "members"}
      >
        <RoomMembersWorkspace
          store={store}
          onOpenInvite={onOpenInvite}
          onOpenRoomLifecycle={onOpenRoomLifecycle}
        />
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
      </div>
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
  if (runtime.browser?.state === "CONFIRMATION_REQUIRED") {
    return "RECOVERY_REQUIRED";
  }
  if (runtime.browser?.state === "BLOCKED") {
    return "BROWSER_BLOCKED";
  }
  switch (runtime.state) {
    case "DISCONNECTED":
      return "RECONNECTING";
    case "AUTHENTICATING":
      return "CONNECTING";
    case "RECOVERING":
      return "RECOVERING";
    case "QUARANTINED":
      return "RECOVERY_REQUIRED";
    case "NOT_CONFIGURED":
    case "CONFIGURATION_ERROR":
      return "CONFIGURATION_ERROR";
  }
  return null;
}
