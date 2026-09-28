import type { PublicRoomSummary } from "@syncaction/protocol";
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { UiCommandResult } from "../../ui/ui-protocol.js";

export interface PublicRoomFeedProps {
  readonly rooms: readonly PublicRoomSummary[];
  readonly onJoin: (room: PublicRoomSummary) => Promise<UiCommandResult>;
  readonly onRefresh: () => Promise<UiCommandResult>;
}

function roomActionLabel(room: PublicRoomSummary): string | null {
  if (room.joinPolicy === "OPEN") {
    return "直接加入";
  }
  if (room.joinPolicy === "APPROVAL") {
    return "申请加入";
  }
  return null;
}

export function PublicRoomFeed({ rooms, onJoin, onRefresh }: PublicRoomFeedProps): JSX.Element {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredRooms = useMemo(
    () =>
      normalizedQuery === ""
        ? rooms
        : rooms.filter(({ name }) => name.toLocaleLowerCase().includes(normalizedQuery)),
    [normalizedQuery, rooms],
  );

  return (
    <section
      class="room-feed editorial-surface"
      data-editorial-surface="public-rooms"
      aria-labelledby="public-room-heading"
    >
      <header class="section-heading room-feed__heading">
        <div>
          <p class="eyebrow">无需邀请即可发现</p>
          <h2 id="public-room-heading">公开房间</h2>
        </div>
        <div class="room-feed__tools">
          {rooms.length > 0 ? (
            <label class="room-search">
              <span class="sr-only">搜索公开房间</span>
              <input
                type="search"
                aria-label="搜索公开房间"
                placeholder="搜索房间"
                value={query}
                onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
          ) : null}
          <button class="text-button" type="button" onClick={() => void onRefresh()}>
            刷新
          </button>
        </div>
      </header>

      {rooms.length === 0 ? (
        <div class="empty-state">
          <strong>暂时没有公开房间</strong>
          <span>你仍可登录后创建房间，或等待朋友邀请。</span>
        </div>
      ) : filteredRooms.length === 0 ? (
        <div class="empty-state">
          <strong>没有匹配的公开房间</strong>
          <span>换个关键词试试，或清空搜索查看全部房间。</span>
        </div>
      ) : (
        <div class="room-feed__list divided-list">
          {filteredRooms.map((room) => {
            const actionLabel = roomActionLabel(room);
            return (
              <article class="public-room-row" data-room-id={room.roomId} key={room.roomId}>
                <div class="public-room-row__body">
                  <div class="public-room-row__title">
                    <h3>{room.name}</h3>
                    {room.hasActivePlayback ? <span class="live-pill">正在播放</span> : null}
                  </div>
                  <p>
                    {room.onlineCount} 在线 · {room.memberCount} 位成员 · {room.openTabCount}{" "}
                    个标签页
                  </p>
                </div>
                {actionLabel === null ? (
                  <span class="policy-label">仅限邀请</span>
                ) : (
                  <button class="compact-button" type="button" onClick={() => void onJoin(room)}>
                    {actionLabel}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
