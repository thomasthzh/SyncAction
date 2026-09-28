import type { JSX } from "preact";
import type {
  MediaGroupView,
  MediaViewAction,
  MediaViewIntent,
} from "../../ui/media-view-model.js";
import { MemberCluster } from "./member-cluster.js";

export interface PlaybackGroupCardProps {
  readonly group: MediaGroupView;
  readonly currentUserId: string | null;
  readonly onIntent: (intent: MediaViewIntent) => void;
}

export function PlaybackGroupCard({
  group,
  currentUserId,
  onIntent,
}: PlaybackGroupCardProps): JSX.Element {
  const leader = group.members.find(({ role }) => role === "LEADER") ?? null;
  return (
    <article
      class={`playback-group-row playback-card playback-card--${group.theme}`}
      data-group-id={group.groupId}
    >
      <header class="playback-card__header">
        <div>
          <p class="eyebrow">
            {group.target?.providerText ?? "同步播放"} · {group.memberCount} 人
          </p>
          <h3>{group.target?.pageTitle ?? group.name}</h3>
        </div>
        <span class={`playback-state playback-state--${group.tone}`}>{group.statusText}</span>
      </header>
      <div class="playback-card__summary">
        <span>领播 {leader?.displayName ?? "等待领播者"}</span>
        <strong>{group.target?.progressText ?? "等待媒体"}</strong>
        {leader !== null ? (
          <button
            class="compact-button"
            type="button"
            disabled={leader.primaryAction.disabled}
            onClick={() => onIntent(leader.primaryAction.intent)}
          >
            跳转并同步
          </button>
        ) : null}
      </div>
      <MemberCluster
        members={group.members}
        currentUserId={currentUserId}
        playbackGroupId={group.groupId}
        onMemberClick={(member) => onIntent({ type: "JUMP_TO_MEMBER", userId: member.userId })}
      />
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
              <ActionButton action={action} onIntent={onIntent} />
            ))}
          </div>
        </div>
      ))}
      <div class="playback-card__actions">
        {group.trailingActions.map((action) => (
          <ActionButton action={action} onIntent={onIntent} />
        ))}
      </div>
    </article>
  );
}

function ActionButton({
  action,
  onIntent,
}: {
  readonly action: MediaViewAction;
  readonly onIntent: (intent: MediaViewIntent) => void;
}): JSX.Element {
  return (
    <button
      class={action.tone === "danger" ? "danger-button" : "compact-button"}
      type="button"
      key={action.key}
      aria-label={action.label}
      title={action.disabledReason ?? action.accessibleText}
      disabled={action.disabled}
      onClick={() => onIntent(action.intent)}
    >
      {action.label}
    </button>
  );
}
