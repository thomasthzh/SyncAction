import type { JSX } from "preact";
import type { MediaControllerStatus } from "../../media-controller.js";
import type {
  MediaGroupView,
  MediaViewAction,
  MediaViewIntent,
} from "../../ui/media-view-model.js";
import { MemberCluster } from "./member-cluster.js";

export interface PlaybackGroupCardProps {
  readonly group: MediaGroupView;
  readonly currentUserId: string | null;
  readonly mediaState: MediaControllerStatus["state"];
  readonly localMembership: MediaControllerStatus["localMembership"];
  readonly controlReady?: boolean | undefined;
  readonly presenceKnown?: boolean | undefined;
  readonly onIntent: (intent: MediaViewIntent) => void;
  readonly busy?: boolean;
}

export function PlaybackGroupCard({
  group,
  currentUserId,
  mediaState,
  localMembership,
  controlReady,
  presenceKnown,
  onIntent,
  busy = false,
}: PlaybackGroupCardProps): JSX.Element {
  const leader = group.members.find(({ role }) => role === "LEADER") ?? null;
  const membership = localMembership?.playbackGroupId === group.groupId ? localMembership : null;
  const readOnly =
    membership !== null && (!membership.activeDevice || membership.role === "READ_ONLY");
  const participationLabel =
    membership === null
      ? localMembership === null
        ? "尚未加入播放组"
        : "正在查看其他播放组"
      : readOnly
        ? "你已加入 · 当前设备只读"
        : membership.role === "LEADER"
          ? "你是领播者 · 本设备"
          : "你是跟随者 · 本设备";
  const participationDetail =
    membership === null
      ? localMembership === null
        ? "打开并一起看会进入这段视频，在正确的页面授权后持续跟随。"
        : "你仍在原播放组中，查看此组不会改变跟随关系。"
      : readOnly
        ? "准备完成后，可将本组同步移到这台设备；原设备会保留页面并停止同步。"
        : mediaState === "OFFLINE"
          ? "媒体连接已断开，当前无法持续同步。"
          : mediaState === "DEGRADED"
            ? "媒体同步需要处理，请查看当前提示；加入状态仍然保留。"
            : controlReady === false
              ? "仍在播放组中，本设备尚未就绪。可打开当前视频后继续。"
              : membership.role === "LEADER"
                ? "此设备负责领播，朋友可加入并跟随播放。"
                : "此设备已参与跟随，视频是否播放仍以播放器状态为准。";
  const closeActions = group.trailingActions.filter(({ intent }) => intent.type === "CLOSE_GROUP");
  const primaryActions = group.trailingActions
    .filter(({ intent }) => intent.type !== "CLOSE_GROUP")
    .sort(
      (left, right) =>
        Number(right.intent.type === "JOIN_GROUP") - Number(left.intent.type === "JOIN_GROUP"),
    );
  return (
    <article
      class={`playback-group-row playback-card playback-card--${group.theme}`}
      data-group-id={group.groupId}
      data-watch-group-state={group.state}
      aria-busy={busy}
    >
      <header class="playback-card__header watch-target">
        <div>
          <p class="eyebrow">
            {group.target?.providerText ?? "同步播放"} · {group.memberCount} 人
          </p>
          <h3>{group.target?.pageTitle ?? group.name}</h3>
          {group.target?.domain ? <p class="watch-target__domain">{group.target.domain}</p> : null}
        </div>
        <span class={`playback-state playback-state--${group.tone}`}>{group.statusText}</span>
      </header>
      <div class="playback-card__summary">
        <span>领播 {leader?.displayName ?? "等待领播者"}</span>
        <strong class="watch-progress">{group.target?.progressText ?? "等待媒体"}</strong>
        {group.target !== null ? (
          <button
            class="compact-button"
            type="button"
            title="打开本播放组当前的视频，不改变参与关系"
            disabled={busy || mediaState === "OFFLINE"}
            onClick={() => onIntent({ type: "OPEN_PAGE", pageId: group.target!.pageId })}
          >
            打开视频页面
          </button>
        ) : null}
      </div>
      <div
        class="watch-membership"
        data-watch-membership
        data-role={membership?.role ?? "OUTSIDE"}
        data-active-device={membership?.activeDevice === true ? "true" : "false"}
        data-media-state={mediaState}
      >
        <strong>{participationLabel}</strong>
        <p>{participationDetail}</p>
      </div>
      <div class="playback-card__controls">
        <MemberCluster
          members={group.members.map((member) => ({
            ...member,
            disabled: busy || member.primaryAction.disabled,
          }))}
          currentUserId={currentUserId}
          presenceKnown={presenceKnown}
          playbackGroupId={group.groupId}
          onMemberClick={(member) => {
            const selected = group.members.find(({ userId }) => userId === member.userId);
            if (selected !== undefined) onIntent(selected.primaryAction.intent);
          }}
        />
        <div class="playback-card__actions">
          {primaryActions.map((action) => (
            <ActionButton key={action.key} action={action} onIntent={onIntent} busy={busy} />
          ))}
        </div>
      </div>
      <PlaybackGroupProposals group={group} onIntent={onIntent} busy={busy} />
      {closeActions.length > 0 ? (
        <details class="watch-group-options" key={group.groupId}>
          <summary>播放组管理</summary>
          <p>关闭会结束所有成员的本组协作。</p>
          {closeActions.map((action) => (
            <ActionButton key={action.key} action={action} onIntent={onIntent} busy={busy} />
          ))}
        </details>
      ) : null}
    </article>
  );
}

export function PlaybackGroupProposals({
  group,
  onIntent,
  busy,
}: {
  readonly group: MediaGroupView;
  readonly onIntent: (intent: MediaViewIntent) => void;
  readonly busy: boolean;
}): JSX.Element | null {
  if (group.proposals.length === 0) return null;
  return (
    <section class="watch-proposals" aria-label="领播者待处理提议" data-watch-proposals>
      {group.proposals.map((proposal) => (
        <div class="proposal-card" key={proposal.key}>
          <div>
            <strong>
              {proposal.proposedByText}
              {proposal.title}
            </strong>
            <span>{proposal.detail}</span>
          </div>
          <div class="proposal-card__actions">
            {proposal.trailingActions.map((action) => (
              <ActionButton key={action.key} action={action} onIntent={onIntent} busy={busy} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function ActionButton({
  action,
  onIntent,
  busy,
}: {
  readonly action: MediaViewAction;
  readonly onIntent: (intent: MediaViewIntent) => void;
  readonly busy: boolean;
}): JSX.Element {
  const isCloseAction = action.intent.type === "CLOSE_GROUP";
  return (
    <button
      class={
        action.tone === "danger"
          ? "danger-button"
          : action.intent.type === "JOIN_GROUP" || action.intent.type === "TAKEOVER_DEVICE"
            ? "primary-button"
            : "compact-button"
      }
      type="button"
      key={action.key}
      aria-label={action.label}
      title={action.disabledReason ?? action.accessibleText}
      aria-disabled={isCloseAction ? busy || action.disabled : undefined}
      disabled={action.disabled || (busy && !isCloseAction)}
      onClick={() => {
        if (isCloseAction && busy) return;
        onIntent(action.intent);
      }}
    >
      {action.label}
    </button>
  );
}
