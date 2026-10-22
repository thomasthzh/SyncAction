import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { MediaControllerStatus } from "../../media-controller.js";
import type { MediaViewIntent, MediaViewModel } from "../../ui/media-view-model.js";
import { PlaybackGroupCard, PlaybackGroupProposals } from "./playback-group-card.js";

interface WatchWorkspaceProps {
  readonly view: MediaViewModel;
  readonly media: MediaControllerStatus;
  readonly currentUserId: string | null;
  readonly busy: boolean;
  readonly onIntent: (intent: MediaViewIntent) => void;
}

/** Viewing another group is local navigation, separate from joining or aligning. */
export function WatchWorkspace({
  view,
  media,
  currentUserId,
  busy,
  onIntent,
}: WatchWorkspaceProps): JSX.Element | null {
  const membershipId = media.localMembership?.playbackGroupId ?? null;
  const ownGroup = view.groups.find((group) => group.groupId === membershipId);
  const defaultGroup =
    ownGroup ??
    view.groups.find((group) => group.groupId === view.recommendedPlaybackGroupId) ??
    view.groups[0];
  const [viewed, setViewed] = useState(() => ({
    groupId: defaultGroup?.groupId ?? null,
    membershipId,
  }));
  const section = useRef<HTMLElement>(null);
  const chooser = useRef<HTMLSelectElement>(null);
  const focusedBeforeUpdate = section.current?.contains(document.activeElement)
    ? document.activeElement
    : null;
  const selectedGroup =
    (viewed.membershipId === membershipId
      ? view.groups.find((group) => group.groupId === viewed.groupId)
      : undefined) ?? defaultGroup;
  const selectedGroupId = selectedGroup?.groupId ?? null;
  useLayoutEffect(() => {
    if (viewed.membershipId !== membershipId || viewed.groupId !== selectedGroupId) {
      setViewed({ groupId: selectedGroupId, membershipId });
    }
  }, [membershipId, selectedGroupId, viewed.membershipId, viewed.groupId]);
  useLayoutEffect(() => {
    if (
      focusedBeforeUpdate !== null &&
      !focusedBeforeUpdate.isConnected &&
      document.activeElement === document.body
    ) {
      (chooser.current ?? section.current)?.focus();
    }
  }, [selectedGroupId, view.groups.length]);
  if (selectedGroup === undefined) return null;
  const viewingOther = ownGroup !== undefined && ownGroup.groupId !== selectedGroup.groupId;

  return (
    <section
      class="watch-workspace playback-section editorial-surface"
      ref={section}
      tabIndex={-1}
      data-editorial-surface="playback"
      data-watch-state={media.state}
      aria-labelledby="playback-heading"
    >
      <header class="section-heading watch-workspace__heading">
        <div>
          <h2 id="playback-heading">一起看</h2>
          <p class="section-description">
            {ownGroup === undefined ? "选好视频，再决定如何参与" : "当前视频与播放协作"}
          </p>
        </div>
        {view.groups.length > 1 ? <span>{view.groups.length} 个播放组</span> : null}
      </header>

      {view.groups.length > 1 ? (
        <div class="watch-workspace__navigation">
          <label class="watch-workspace__switcher">
            <span>查看播放组</span>
            <select
              ref={chooser}
              aria-label="查看播放组"
              aria-describedby="watch-view-help"
              value={selectedGroup.groupId}
              onChange={(event) => setViewed({ groupId: event.currentTarget.value, membershipId })}
            >
              {view.groups.map((group) => (
                <option value={group.groupId} key={group.groupId}>
                  {group.target?.pageTitle ?? group.name} · {group.memberCount} 人
                  {group.groupId === membershipId
                    ? " · 我的播放组"
                    : group.recommended
                      ? " · 推荐"
                      : ""}
                </option>
              ))}
            </select>
          </label>
          <p id="watch-view-help" class="watch-workspace__view-help">
            切换这里只查看，不会改变跟随关系。
          </p>
        </div>
      ) : null}

      {viewingOther ? (
        <button
          class="text-button watch-workspace__return"
          type="button"
          onClick={() => setViewed({ groupId: ownGroup.groupId, membershipId })}
        >
          返回我的播放组
        </button>
      ) : null}

      <PlaybackGroupCard
        key={selectedGroup.groupId}
        group={selectedGroup}
        mediaState={media.state}
        localMembership={media.localMembership}
        currentUserId={currentUserId}
        onIntent={onIntent}
        busy={busy}
      />

      {viewingOther && ownGroup.proposals.length > 0 ? (
        <aside class="watch-proposal-inbox" aria-label="你领播的播放组提议">
          <h3>你的播放组有 {ownGroup.proposals.length} 条待处理提议</h3>
          <p class="section-description">{ownGroup.target?.pageTitle ?? ownGroup.name}</p>
          <PlaybackGroupProposals group={ownGroup} onIntent={onIntent} busy={busy} />
        </aside>
      ) : null}
    </section>
  );
}
