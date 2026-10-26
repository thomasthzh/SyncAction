import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
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
  readonly onRemove?: (pageId: string) => Promise<boolean>;
}

export function SharedTabRow({
  row,
  memberById,
  currentUserId,
  isMediaPage,
  onActivate,
  onMediaMemberJump,
  onRemove,
}: SharedTabRowProps): JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const inFlight = useRef(false);
  async function remove(): Promise<void> {
    if (inFlight.current || onRemove === undefined) return;
    inFlight.current = true;
    setRemoving(true);
    try {
      if (await onRemove(row.pageKey)) setConfirmRemove(false);
    } finally {
      inFlight.current = false;
      setRemoving(false);
    }
  }
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
    <article
      class="shared-tab-row"
      data-page-id={row.pageKey}
      data-current-page={
        currentUserId !== null && row.viewerAccountIds.includes(currentUserId) ? "true" : "false"
      }
    >
      <div class="favicon-fallback" data-favicon-fallback aria-hidden="true">
        {(row.domain[0] ?? "·").toUpperCase()}
      </div>
      <div class="shared-tab-row__content">
        <div class="shared-tab-row__title">
          <strong title={row.title}>{row.title}</strong>
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
      <div class="shared-tab-row__actions">
        <button
          class="compact-button"
          type="button"
          disabled={removing}
          onClick={() => onActivate(row.pageKey)}
        >
          打开
        </button>
        {onRemove === undefined ? null : (
          <button
            class="text-button"
            type="button"
            disabled={removing}
            aria-label={`移除共享页面 ${row.title}`}
            onClick={() => setConfirmRemove(true)}
          >
            移除
          </button>
        )}
      </div>
      {confirmRemove ? (
        <div
          class="shared-tab-row__remove-confirm"
          role="group"
          aria-label={`确认移除 ${row.title}`}
        >
          <p>从房间移除这页？成员仍在查看的房间标签页也会关闭。</p>
          <button
            class="secondary-button"
            type="button"
            disabled={removing}
            onClick={() => setConfirmRemove(false)}
          >
            保留
          </button>
          <button
            class="primary-button"
            type="button"
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? "正在移除…" : "确认移除"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
