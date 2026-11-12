import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { useState } from "preact/hooks";

export function RoomPageUpdates({
  store,
  busy,
  onPreview,
}: {
  readonly store: UiStore;
  readonly busy: boolean;
  readonly onPreview: (tabId: number, logicalTabId: string) => void;
}): JSX.Element | null {
  const pending = store.room.value.runtime?.browser?.pendingPublications ?? [];
  const [visibleCount, setVisibleCount] = useState(5);
  if (pending.length === 0) return null;
  const pages = new Map(store.collaboration.value.pages.map((page) => [page.pageId, page]));
  return (
    <section class="room-page-updates" aria-labelledby="local-page-updates-title">
      <header>
        <h3 id="local-page-updates-title">
          你的浏览尚未提交 <span>{pending.length}</span>
        </h3>
        <p>先查看本机页面，再决定更新房间或作为新页面分享。</p>
      </header>
      <div class="divided-list">
        {pending.slice(0, visibleCount).map((item, index) => {
          const page = pages.get(item.logicalTabId);
          const viewing = store.pageAccess.value.tabId === item.tabId;
          return (
            <article class="local-page-update" key={item.tabId}>
              <span>
                <strong>{page?.title ?? "原共享页已不在房间"}</strong>
                <small>
                  {page === undefined
                    ? "本机页面仍保留，可另行分享"
                    : `对应房间页面 · ${page.domain}`}
                </small>
              </span>
              <button
                class="compact-button"
                type="button"
                disabled={busy || viewing}
                aria-label={`查看本机页面 ${page?.title ?? "原共享页已移除"}（${index + 1}）`}
                onClick={() => onPreview(item.tabId, item.logicalTabId)}
              >
                {viewing ? "正在查看" : "查看本机页面"}
              </button>
            </article>
          );
        })}
      </div>
      {pending.length > visibleCount ? (
        <button
          class="text-button"
          type="button"
          onClick={() => setVisibleCount((count) => count + 20)}
        >
          显示更多待提交页面 ({pending.length - visibleCount})
        </button>
      ) : null}
    </section>
  );
}
