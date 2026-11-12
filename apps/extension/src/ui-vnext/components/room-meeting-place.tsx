import type { JSX } from "preact";
import type { SharedTabRowModel } from "../../ui/collaboration-view-model.js";
import type { ExtensionCollaborationMemberSummary } from "../../app-controller.js";

export function RoomMeetingPlace({
  rows,
  members,
  currentUserId,
  busy,
  onOpen,
  onViewAll,
}: {
  readonly rows: readonly SharedTabRowModel[];
  readonly members: ReadonlyMap<string, ExtensionCollaborationMemberSummary>;
  readonly currentUserId: string | null;
  readonly busy: boolean;
  readonly onOpen: (pageId: string) => void;
  readonly onViewAll: () => void;
}): JSX.Element {
  const withPeers = rows.filter((row) =>
    row.viewerAccountIds.some((id) => id !== currentUserId && members.get(id)?.online),
  );
  const meeting = (withPeers.length > 0 ? withPeers : rows).slice(0, 3);
  return (
    <section class="room-meeting-place editorial-surface" aria-labelledby="room-meeting-title">
      <header>
        <p class="eyebrow">共同现场</p>
        <h2 id="room-meeting-title">先到同伴的页面</h2>
        <p class="section-description">打开房间已分享的内容。选好具体视频后，再开始一起看。</p>
      </header>
      <div class="divided-list">
        {meeting.map((row) => {
          const viewers = row.viewerAccountIds
            .filter((id) => id !== currentUserId && members.get(id)?.online)
            .map((id) => members.get(id)!.displayName);
          return (
            <article class="meeting-page" key={row.pageKey}>
              <span>
                <strong>{row.title}</strong>
                <small>
                  {viewers.length > 0
                    ? `${viewers.slice(0, 2).join("、")}${viewers.length > 2 ? `等 ${viewers.length} 人` : ""} 正在查看`
                    : row.domain}
                </small>
              </span>
              <button
                class="compact-button"
                type="button"
                disabled={busy}
                aria-label={`打开共同页面 ${row.title}`}
                onClick={() => onOpen(row.pageKey)}
              >
                打开
              </button>
            </article>
          );
        })}
      </div>
      <button class="text-button" type="button" onClick={onViewAll}>
        查看全部 {rows.length} 个共享页面
      </button>
    </section>
  );
}
