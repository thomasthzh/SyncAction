import type { JSX } from "preact";
import type { SharedTabRowModel } from "../../ui/collaboration-view-model.js";
import type { ExtensionCollaborationMemberSummary } from "../../app-controller.js";
import { MemberCluster, type MemberClusterEntry } from "./member-cluster.js";

export interface SharedTabRowProps {
  readonly row: SharedTabRowModel;
  readonly memberById: ReadonlyMap<string, ExtensionCollaborationMemberSummary>;
  readonly currentUserId: string | null;
  readonly isMediaPage: boolean;
  readonly onActivate: (pageId: string) => void;
  readonly onMediaMemberJump: (userId: string) => void;
}

export function SharedTabRow({
  row,
  memberById,
  currentUserId,
  isMediaPage,
  onActivate,
  onMediaMemberJump,
}: SharedTabRowProps): JSX.Element {
  const viewers: MemberClusterEntry[] = row.viewerAccountIds.flatMap((userId) => {
    const member = memberById.get(userId);
    return member === undefined
      ? []
      : [
          {
            userId: member.userId,
            displayName: member.displayName,
            online: member.online,
          },
        ];
  });
  const compatibilityCopy =
    row.compatibility === "MISMATCH"
      ? "页面内容与共享版本不同"
      : row.compatibility === "UNKNOWN"
        ? "页面一致性尚未验证"
        : null;
  return (
    <article class="shared-tab-row" data-page-id={row.pageKey}>
      <div class="favicon-fallback" data-favicon-fallback aria-hidden="true">
        {(row.domain[0] ?? "·").toUpperCase()}
      </div>
      <div class="shared-tab-row__content">
        <div class="shared-tab-row__title">
          <strong>{row.title}</strong>
          <span>{row.domain}</span>
        </div>
        {compatibilityCopy === null ? null : (
          <span class={`compatibility-note compatibility-note--${row.compatibility.toLowerCase()}`}>
            {compatibilityCopy}
          </span>
        )}
        <div class="shared-tab-row__presence">
          <MemberCluster
            members={viewers}
            currentUserId={currentUserId}
            onMemberClick={(member) => {
              if (isMediaPage) {
                onMediaMemberJump(member.userId);
              } else {
                onActivate(row.pageKey);
              }
            }}
          />
          <span>{viewers.length} 人正在查看</span>
        </div>
      </div>
      <button class="compact-button" type="button" onClick={() => onActivate(row.pageKey)}>
        跳转
      </button>
    </article>
  );
}
