import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UiStore } from "../store.js";
import { avatarForMember } from "../../ui/collaboration-view-model.js";
import { Icon } from "../icons.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import { ActionableStatus } from "./actionable-status.js";
import { LogicalTabIdSchema } from "@syncaction/protocol";

export function RoomMembersWorkspace({
  store,
  onOpenInvite,
  onOpenRoomLifecycle,
}: {
  readonly store: UiStore;
  readonly onOpenInvite: () => void;
  readonly onOpenRoomLifecycle: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const feedback = useCommandFeedback();
  const detail = store.room.value.detail;
  const presence = store.collaboration.value.members;
  const people =
    detail?.members ??
    presence.map((member) => ({ ...member, username: "", role: member.roomRole }));
  const normalized = query.trim().toLocaleLowerCase();
  const visible = people.filter((member) =>
    `${member.displayName} ${member.username}`.toLocaleLowerCase().includes(normalized),
  );
  const selfId = store.shell.value.account?.id;
  const profileId = store.shell.value.selectedProfileId;
  const roomId = store.room.value.selectedRoomId;
  function openPage(memberId: string, pageId: string): void {
    if (roomId === null) return;
    void feedback.run(memberId, () =>
      store.command({
        name: "ROOM_TAB_ACTIVATE",
        payload: {
          logicalTabId: LogicalTabIdSchema.parse(pageId),
          expectedContext: { profileId, roomId },
        },
      }),
    );
  }
  return (
    <section class="room-members-workspace" aria-labelledby="room-members-title">
      <header class="workspace-heading">
        <div>
          <h2 id="room-members-title">房间成员</h2>
          <p class="section-description">找到同伴，打开对方正在看的页面。</p>
        </div>
        {detail?.role === "OWNER" ? (
          <button class="compact-button" type="button" onClick={onOpenInvite}>
            <Icon name="invite" size={16} />
            邀请
          </button>
        ) : null}
      </header>
      {people.length > 6 || query !== "" ? (
        <label class="room-search">
          <Icon name="search" size={18} />
          <input
            aria-label="搜索房间成员"
            type="search"
            value={query}
            placeholder="搜索姓名或用户名"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <div class="workspace-member-list">
        {visible.map((member) => {
          const live = presence.find(({ userId }) => userId === member.userId);
          const pages = store.collaboration.value.pages.filter(({ pageId }) =>
            live?.activePageIds.includes(pageId),
          );
          const avatar = avatarForMember(member.displayName, member.userId);
          return (
            <article
              class="workspace-member-row"
              key={member.userId}
              data-member-id={member.userId}
            >
              <span
                class={`member-avatar ${avatar.paletteToken}`}
                aria-hidden="true"
                data-online={live?.online ? "true" : "false"}
              >
                {avatar.initials}
              </span>
              <div class="workspace-member-row__identity" id={`member-identity-${member.userId}`}>
                <strong>
                  {member.displayName}
                  {member.userId === selfId ? <small>你</small> : null}
                </strong>
                <span>
                  {member.username === "" ? "" : `@${member.username} · `}
                  {member.role === "OWNER" ? "房主" : "成员"} ·{" "}
                  {live === undefined ? "状态待同步" : live.online ? "在线" : "离线"}
                </span>
                <small>
                  {(pages.length > 1
                    ? `${pages.length} 个共享页面${live?.deviceCount ? ` · ${live.deviceCount} 台设备` : ""}`
                    : pages[0]?.title) ??
                    (live === undefined
                      ? "正在读取页面状态"
                      : live.online
                        ? "尚未查看共享页面"
                        : "当前不在线")}
                </small>
              </div>
              {member.userId !== selfId && live?.online && pages.length === 1 ? (
                <button
                  class="compact-button"
                  type="button"
                  aria-label={`打开 ${member.displayName} 的页面`}
                  aria-describedby={`member-identity-${member.userId}`}
                  disabled={feedback.pending !== null}
                  onClick={() => openPage(member.userId, pages[0]!.pageId)}
                >
                  <Icon name="share" size={16} />
                  <span>打开</span>
                </button>
              ) : null}
              {member.userId !== selfId && live?.online && pages.length > 1 ? (
                <details class="member-page-picker">
                  <summary class="compact-button">选择页面 ({pages.length})</summary>
                  <div aria-label={`${member.displayName} 正在查看的共享页面`}>
                    {pages.map((page) => (
                      <button
                        class="text-button"
                        type="button"
                        key={page.pageId}
                        disabled={feedback.pending !== null}
                        onClick={() => openPage(member.userId, page.pageId)}
                      >
                        <strong>{page.title}</strong>
                        <small>{page.domain}</small>
                      </button>
                    ))}
                  </div>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
      {visible.length === 0 ? (
        <div class="empty-state">
          <strong>{people.length === 0 ? "正在读取成员" : "没有找到这个成员"}</strong>
          {query === "" ? null : (
            <button class="text-button" type="button" onClick={() => setQuery("")}>
              清空成员搜索
            </button>
          )}
        </div>
      ) : null}
      <ActionableStatus errorCode={feedback.errorCode} />
      {detail?.role === "OWNER" ? (
        <button
          class="text-button member-management-link"
          type="button"
          onClick={onOpenRoomLifecycle}
        >
          管理成员与房间
        </button>
      ) : null}
    </section>
  );
}
