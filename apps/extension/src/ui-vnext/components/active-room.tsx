import { LogicalTabIdSchema, type ServerCapability } from "@syncaction/protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { createSharedTabRows, type PageCompatibility } from "../../ui/collaboration-view-model.js";
import { createMediaViewModel, type MediaViewIntent } from "../../ui/media-view-model.js";
import { ActionableStatus, type StatusRecoveryAction } from "./actionable-status.js";
import { recoveryResult } from "../recovery-result.js";
import { BottomActionDock } from "./bottom-action-dock.js";
import { WatchWorkspace } from "./watch-workspace.js";
import { SharedTabRow } from "./shared-tab-row.js";
import { RoomSwitcher } from "./room-switcher.js";
import { StartWatchingCard } from "./start-watching-card.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import type { UiCommandInput } from "../store.js";
import { WorkspaceTabs } from "./workspace-tabs.js";
import { RoomMembersWorkspace } from "./room-members-workspace.js";
import { RoomPageUpdates } from "./room-page-updates.js";
import { RoomMeetingPlace } from "./room-meeting-place.js";
import { useWatchParticipation } from "../use-watch-participation.js";
import { WatchPreparationRecovery } from "./watch-preparation-recovery.js";
import { sameMediaTarget } from "../../media-controller-model.js";
import type { PagePermissionRequester } from "../../origin-permission-coordinator.js";
import type { PageToolShortcutRequest } from "../../page-tool-shortcut-intent.js";

export interface ActiveRoomProps {
  readonly store: UiStore;
  readonly serverHost: string;
  readonly now: () => number;
  readonly onOpenServerProfiles: () => void;
  readonly onOpenInvite: () => void;
  readonly onOpenRoomLifecycle: () => void;
  readonly onRequestPagePermission: PagePermissionRequester;
  readonly shortcut?: PageToolShortcutRequest | null | undefined;
  readonly onShortcutHandled?: ((id: string) => void) | undefined;
}

export function ActiveRoom({
  store,
  serverHost,
  now,
  onOpenServerProfiles,
  onOpenInvite,
  onOpenRoomLifecycle,
  onRequestPagePermission,
  shortcut,
  onShortcutHandled,
}: ActiveRoomProps): JSX.Element {
  const [pageQuery, setPageQuery] = useState("");
  const [workspace, setWorkspace] = useState("watch");
  const [watchSelection, setWatchSelection] = useState<{
    groupId: string | null;
    membershipId: string | null;
  }>({ groupId: null, membershipId: null });
  const surface = useRef<HTMLDivElement>(null);
  const activeElement = document.activeElement;
  const focusedWatchControl =
    activeElement instanceof HTMLElement &&
    surface.current?.contains(activeElement) &&
    activeElement.closest(".watch-workspace, .watch-preparation, .watch-recovery") !== null
      ? activeElement
      : null;
  const feedback = useCommandFeedback();
  const participation = useWatchParticipation(store, onRequestPagePermission);
  const shell = store.shell.value;
  const room = store.room.value;
  const collaboration = store.collaboration.value;
  const detail = room.detail;
  const runtime = room.runtime;
  const pages = collaboration.pages;
  const members = collaboration.members;
  const presenceKnown = collaboration.presenceKnown !== false;
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
  const membershipId = media?.localMembership?.playbackGroupId ?? null;
  const ownGroup = mediaView.groups.find((group) => group.groupId === membershipId);
  const defaultGroup =
    ownGroup ?? mediaView.groups.find((group) => group.recommended) ?? mediaView.groups[0];
  const selectedWatchGroup =
    (watchSelection.membershipId === membershipId
      ? mediaView.groups.find((group) => group.groupId === watchSelection.groupId)
      : undefined) ?? defaultGroup;
  useLayoutEffect(() => {
    const groupId = selectedWatchGroup?.groupId ?? null;
    if (watchSelection.membershipId !== membershipId || watchSelection.groupId !== groupId)
      setWatchSelection({ groupId, membershipId });
  }, [membershipId, selectedWatchGroup?.groupId, watchSelection]);
  const ownTarget = media?.playbackGroups.find(
    (group) => group.playbackGroupId === membershipId,
  )?.target;
  const localPrepared =
    media?.state === "ONLINE" &&
    media.controlReady === true &&
    ownTarget != null &&
    media.localObservation != null &&
    sameMediaTarget(media.localObservation.target, ownTarget);
  const ownReadiness = !media?.localMembership?.activeDevice
    ? "由你的另一台设备参与"
    : media.state === "OFFLINE"
      ? "连接恢复后可继续"
      : !localPrepared
        ? "本设备尚未跟上当前视频"
        : media.localMembership.role === "LEADER"
          ? "本设备领播"
          : "本设备跟随已准备";
  const watchConnected =
    runtime?.state === "SYNCED" &&
    store.transport.value !== "RECONNECTING" &&
    media?.state !== "OFFLINE" &&
    (media === null || media.roomMediaRevision !== null);
  const watchAwaiting = mediaView.groups.length === 0 && !watchConnected;
  const currentSharedVideo =
    store.pageAccess.value.documentRevision !== null &&
    media?.localObservation != null &&
    media.localObservation.target.logicalTabId === store.pageAccess.value.logicalTabId;
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
  }, [
    mediaView.groups.length,
    media?.localMembership?.playbackGroupId,
    watchAwaiting,
    participation.phase,
    room.watchPreparation?.id,
  ]);
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
  const pendingPublications = runtime?.browser?.pendingPublications ?? [];
  const pendingByPage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of pendingPublications)
      counts.set(item.logicalTabId, (counts.get(item.logicalTabId) ?? 0) + 1);
    return counts;
  }, [pendingPublications]);
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

  function viewPages(): void {
    setWorkspace("pages");
    queueMicrotask(() =>
      surface.current?.querySelector<HTMLElement>("#room-workspace-tab-pages")?.focus(),
    );
  }
  function openSharedPage(pageId: string): void {
    if (room.selectedRoomId === null) return;
    const expectedContext = { profileId: shell.selectedProfileId, roomId: room.selectedRoomId };
    void feedback.run("page", () =>
      store.command({
        name: "ROOM_TAB_ACTIVATE",
        payload: { logicalTabId: LogicalTabIdSchema.parse(pageId), expectedContext },
      }),
    );
  }
  function viewWatchGroup(groupId: string): void {
    setWatchSelection({ groupId, membershipId });
    setWorkspace("watch");
    queueMicrotask(() =>
      surface.current?.querySelector<HTMLElement>("#room-workspace-tab-watch")?.focus(),
    );
  }
  function previewLocalPage(tabId: number, logicalTabId: string): void {
    if (room.selectedRoomId === null) return;
    void feedback.run("local-page", () =>
      store.command({
        name: "LOCAL_PAGE_ACTIVATE",
        payload: {
          tabId,
          logicalTabId: LogicalTabIdSchema.parse(logicalTabId),
          profileId: shell.selectedProfileId,
          roomId: room.selectedRoomId!,
        },
      }),
    );
  }
  function sendMediaIntent(intent: MediaViewIntent): void {
    if (intent.type === "OPEN_PAGE") {
      if (intent.pageId !== null) openSharedPage(intent.pageId);
      return;
    }
    if (intent.type === "ALIGN_ONCE") {
      void participation.follow(intent.playbackGroupId, "ALIGN");
      return;
    }
    if (intent.type === "JOIN_GROUP") {
      void participation.follow(intent.playbackGroupId);
      return;
    }
    if (intent.type === "TAKEOVER_DEVICE") {
      void participation.follow(intent.playbackGroupId, "TAKEOVER");
      return;
    }
    void feedback.run("media", () => store.command(mediaCommand(intent)));
  }

  function mediaCommand(
    intent: Exclude<
      MediaViewIntent,
      { type: "JOIN_GROUP" | "ALIGN_ONCE" | "OPEN_PAGE" | "TAKEOVER_DEVICE" }
    >,
  ): UiCommandInput {
    switch (intent.type) {
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
        if (store.room.value.selectedRoomId === null) return;
        void feedback.run(
          "recovery",
          async () =>
            recoveryResult(
              await store.command({
                name: "BROWSER_RECOVERY_CONFIRM",
                payload: {
                  expectedContext: {
                    profileId: store.shell.value.selectedProfileId,
                    roomId: store.room.value.selectedRoomId!,
                  },
                },
              }),
            ),
          "房间页面已恢复同步",
        );
        return;
      case "ALLOW_PAGE":
        onRequestPagePermission("page-collaboration");
        return;
      case "RETRY":
        void feedback.run("refresh-page", () => store.command({ name: "PAGE_PERMISSION_REFRESH" }));
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
            {presenceKnown ? `${onlineCount} 在线` : "在线状态恢复中"} · {totalCount} 位成员
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

      <ActionableStatus
        statusCode={statusCode}
        onAction={recover}
        pending={feedback.pending !== null}
      />
      {ownGroup !== undefined &&
      (workspace !== "watch" || selectedWatchGroup?.groupId !== ownGroup.groupId) ? (
        <section class="watch-return" aria-label="我的一起看">
          <div>
            <span class="eyebrow">我的一起看</span>
            <strong>{ownGroup.target?.pageTitle ?? ownGroup.name}</strong>
            <p>{ownReadiness}</p>
          </div>
          <div class="watch-return__actions">
            <button
              class="compact-button"
              type="button"
              onClick={() => viewWatchGroup(ownGroup.groupId)}
            >
              返回我的播放组
            </button>
            {watchConnected &&
            media?.localMembership?.role === "FOLLOWER" &&
            media.localMembership.activeDevice &&
            !localPrepared &&
            ownTarget != null ? (
              <button
                class="primary-button"
                type="button"
                disabled={participation.busy}
                onClick={() => {
                  viewWatchGroup(ownGroup.groupId);
                  void participation.follow(ownGroup.groupId);
                }}
              >
                跟上当前视频
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
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
      {workspace !== "pages" && pendingPublications.length > 0 ? (
        <button class="workspace-pending-action" type="button" onClick={viewPages}>
          <Icon name="share" size={16} />
          <span>{pendingPublications.length} 个本机页面尚未提交</span>
          <Icon name="chevron" size={16} />
        </button>
      ) : null}
      {feedback.message !== null ? (
        <p class="command-feedback" role="status">
          {feedback.message}
        </p>
      ) : null}
      {feedback.pending === "media" ? (
        <p class="command-feedback" role="status">
          正在执行播放操作…
        </p>
      ) : null}
      {mediaView.notice === null ? null : (
        <p class={`media-notice media-notice--${mediaView.notice.tone}`}>{mediaView.notice.text}</p>
      )}

      {participation.phase !== null && workspace !== "watch" ? (
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
          视频准备仍在进行 · 查看进度
        </button>
      ) : null}
      <div
        class="workspace-panel"
        id="room-workspace-panel-watch"
        role="tabpanel"
        aria-labelledby="room-workspace-tab-watch"
        hidden={workspace !== "watch"}
      >
        {!participation.busy ? (
          <WatchPreparationRecovery
            store={store}
            busy={feedback.pending !== null}
            onResume={(task) => {
              const own = store.room.value.runtime?.media?.localMembership;
              const action =
                task.action === "TAKEOVER" &&
                own?.playbackGroupId === task.groupId &&
                own.activeDevice &&
                own.role === "FOLLOWER"
                  ? "JOIN"
                  : task.action;
              void participation.follow(
                task.groupId,
                action,
                task.target,
                action === "TAKEOVER" ? task.takeoverFrom : undefined,
              );
            }}
            onOpen={openSharedPage}
            onDismiss={(id) => {
              void feedback.run("watch-preparation", () =>
                store.command({ name: "WATCH_PREPARATION_DISMISS", payload: { id } }),
              );
            }}
          />
        ) : null}
        {participation.phase === null ? null : (
          <p class="watch-preparation" role="status" data-watch-preparation={participation.phase}>
            <span class="watch-preparation__spinner" aria-hidden="true" />
            {participation.phase === "PERMISSION"
              ? "等待允许视频页面…"
              : participation.phase === "WAITING_MEDIA"
                ? "正在识别这段视频…"
                : participation.phase === "OPENING"
                  ? "正在打开你选择的视频…"
                  : participation.phase === "WAITING_PAGE"
                    ? "等待视频页面就绪…"
                    : participation.phase === "CONFIRMING_DEVICE"
                      ? "设备切换请求已提交，等待房间确认…"
                      : participation.phase === "TAKING_OVER"
                        ? "正在将同步移到这台设备…"
                        : participation.phase === "ALIGNING"
                          ? "正在对齐当前进度…"
                          : "正在准备本设备跟随…"}
            {participation.canCancel ? (
              <button class="text-button" type="button" onClick={participation.cancel}>
                停止准备
              </button>
            ) : null}
          </p>
        )}
        <ActionableStatus errorCode={participation.errorCode} />
        {participation.message === null ? null : (
          <p class="command-feedback" role="status">
            {participation.message}
          </p>
        )}
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
          <>
            {rows.length > 0 && !currentSharedVideo ? (
              <RoomMeetingPlace
                rows={rows}
                members={memberById}
                currentUserId={currentUserId}
                busy={feedback.pending !== null}
                onOpen={openSharedPage}
                onViewAll={viewPages}
              />
            ) : null}
            <StartWatchingCard
              key="initial-watch"
              store={store}
              collapsible={rows.length > 0 && !currentSharedVideo}
              onRequestPagePermission={onRequestPagePermission}
            />
          </>
        ) : null}
        {media !== null && mediaView.groups.length > 0 ? (
          <WatchWorkspace
            key={`${shell.selectedProfileId}:${room.selectedRoomId}`}
            view={mediaView}
            selectedGroup={selectedWatchGroup!}
            onViewGroup={(groupId) => setWatchSelection({ groupId, membershipId })}
            media={media}
            presenceKnown={presenceKnown}
            currentUserId={currentUserId}
            onIntent={sendMediaIntent}
            busy={feedback.pending === "media" || participation.busy}
          />
        ) : null}
        {watchConnected &&
        media?.localMembership?.role === "LEADER" &&
        media.localMembership.activeDevice ? (
          <details class="watch-new-group" open={media.state === "DEGRADED"}>
            <summary>换个视频，继续一起看</summary>
            <StartWatchingCard
              key={media.localMembership.playbackGroupId}
              store={store}
              playbackGroupId={media.localMembership.playbackGroupId}
              onRequestPagePermission={onRequestPagePermission}
            />
          </details>
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
            <p class="section-description">在插件内提交或移除共享。浏览器关页不影响房间列表。</p>
          </div>
          <span>
            {collaboration.capacity.openTabCount}
            {collaboration.capacity.limit === null ? "" : `/${collaboration.capacity.limit}`}
          </span>
        </header>
        <RoomPageUpdates
          store={store}
          busy={feedback.pending !== null}
          onPreview={previewLocalPage}
        />
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
          <p class="section-description">
            {runtime?.state === "SYNCED" ? "还没有共享页面" : "正在读取共享页面…"}
          </p>
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
                presenceKnown={presenceKnown}
                row={row}
                memberById={memberById}
                currentUserId={currentUserId}
                isCurrentPage={
                  store.pageAccess.value.logicalTabId === row.pageKey &&
                  store.pageAccess.value.documentRevision !== null
                }
                pendingCount={pendingByPage.get(row.pageKey) ?? 0}
                onActivate={openSharedPage}
                onRemove={async (pageId) => {
                  if (shell.selectedProfileId === null || room.selectedRoomId === null)
                    return false;
                  const profileId = shell.selectedProfileId;
                  const roomId = room.selectedRoomId;
                  const result = await feedback.run(
                    "page",
                    () =>
                      store.command({
                        name: "ROOM_TAB_REMOVE",
                        payload: {
                          logicalTabId: LogicalTabIdSchema.parse(pageId),
                          profileId,
                          roomId,
                        },
                      }),
                    "已提交移除共享页面",
                  );
                  return result?.ok === true;
                }}
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
        shortcut={shortcut}
        onShortcutHandled={onShortcutHandled}
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
