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
  readonly onIntent: (intent: MediaViewIntent) => void;
  readonly busy?: boolean;
}

export function PlaybackGroupCard({
  group,
  currentUserId,
  mediaState,
  localMembership,
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
        ? "打开页面只会跳转。加入后参与持续跟随；对齐一次不会加入。"
        : "你仍在原播放组中，查看此组不会改变跟随关系。"
      : readOnly
        ? "播放由另一台设备参与，此设备不会自动跟随。"
        : mediaState === "OFFLINE"
          ? "媒体连接已断开，当前无法持续同步。"
          : mediaState === "DEGRADED"
            ? "媒体同步需要处理，请查看当前提示；加入状态仍然保留。"
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
        {leader !== null ? (
          <button
            class="compact-button"
            type="button"
            title={leader.primaryAction.disabledReason ?? leader.primaryAction.accessibleText}
            disabled={busy || leader.primaryAction.disabled}
            onClick={() => onIntent(leader.primaryAction.intent)}
          >
            打开领播页面
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
          playbackGroupId={group.groupId}
          onMemberClick={(member) => onIntent({ type: "JUMP_TO_MEMBER", userId: member.userId })}
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
