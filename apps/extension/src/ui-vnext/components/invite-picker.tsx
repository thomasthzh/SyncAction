import { DirectoryUserSchema, type DirectoryUser } from "@syncaction/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { z } from "zod";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";

const DirectoryResultSchema = z
  .object({
    items: z.array(DirectoryUserSchema).max(50),
    nextCursor: z.string().min(1).max(1_024).nullable(),
  })
  .strict();

export interface InvitePickerProps {
  readonly store: UiStore;
  readonly onBack: () => void;
  readonly backLabel?: string;
}

export function InvitePicker({
  store,
  onBack,
  backLabel = "关闭邀请",
}: InvitePickerProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const requestNumber = useRef(0);
  const room = store.room.value.detail;
  const currentUserId = store.shell.value.account?.id ?? null;
  const memberIds = new Set(room?.members.map(({ userId }) => userId) ?? []);
  const invitedIds = new Set(
    room?.pendingInvitations?.map(({ invitedUserId }) => invitedUserId) ?? [],
  );

  useEffect(() => {
    const normalized = query.trim();
    requestNumber.current += 1;
    const currentRequest = requestNumber.current;
    if (normalized.length < 2 || room === null) {
      setResults([]);
      setSearching(false);
      setErrorCode(null);
      return;
    }
    setSearching(true);
    const timeout = globalThis.setTimeout(() => {
      void (async () => {
        const result = await store.command({
          name: "DIRECTORY_SEARCH",
          payload: {
            roomId: room.id,
            query: normalized,
            cursor: null,
            limit: 20,
          },
        });
        if (currentRequest !== requestNumber.current) {
          return;
        }
        if (!result.ok) {
          setErrorCode(result.errorCode);
          setResults([]);
          setSearching(false);
          return;
        }
        const parsed = DirectoryResultSchema.safeParse(result.value);
        if (!parsed.success) {
          setErrorCode("INVALID_DIRECTORY_RESPONSE");
          setResults([]);
          setSearching(false);
          return;
        }
        setResults(parsed.data.items);
        setErrorCode(null);
        setSearching(false);
      })();
    }, 200);
    return () => globalThis.clearTimeout(timeout);
  }, [query, room?.id, store]);

  function disabledReason(user: DirectoryUser): string | null {
    if (user.userId === currentUserId) {
      return "这是你自己";
    }
    if (memberIds.has(user.userId)) {
      return "已经是房间成员";
    }
    if (invitedIds.has(user.userId)) {
      return "已有待处理邀请";
    }
    if (!selected.has(user.userId) && selected.size >= 20) {
      return "每次最多邀请 20 人";
    }
    return null;
  }

  function toggle(userId: string, checked: boolean): void {
    const next = new Set(selected);
    if (checked) {
      next.add(userId);
    } else {
      next.delete(userId);
    }
    setSelected(next);
  }

  async function send(): Promise<void> {
    if (selected.size === 0) {
      return;
    }
    setSending(true);
    setErrorCode(null);
    const result = await store.command({
      name: "INVITE_BATCH",
      payload: { userIds: [...selected] },
    });
    if (result.ok) {
      setSelected(new Set());
    } else {
      setErrorCode(result.errorCode);
    }
    setSending(false);
  }

  return (
    <section class="invite-picker" aria-labelledby="invite-picker-title">
      <header class="dialog-header">
        <button
          class="icon-button"
          type="button"
          aria-label={backLabel}
          title={backLabel}
          onClick={onBack}
        >
          <Icon name={backLabel === "关闭邀请" ? "close" : "chevron"} />
        </button>
        <div>
          <p class="eyebrow">从账号目录选择</p>
          <h2 id="invite-picker-title">邀请成员</h2>
        </div>
      </header>
      <label class="search-field">
        搜索账号
        <input
          name="directorySearch"
          type="search"
          autocomplete="off"
          placeholder="至少输入两个字符"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      {searching ? <p class="subtle-copy">正在搜索…</p> : null}
      {!searching && query.trim().length > 0 && query.trim().length < 2 ? (
        <p class="subtle-copy">再输入一个字符即可搜索。</p>
      ) : null}
      <div class="directory-results">
        {results.map((user) => {
          const reason = disabledReason(user);
          return (
            <label
              class={reason === null ? "directory-row" : "directory-row is-disabled"}
              key={user.userId}
            >
              <input
                type="checkbox"
                value={user.userId}
                checked={selected.has(user.userId)}
                disabled={reason !== null}
                onChange={(event) => toggle(user.userId, event.currentTarget.checked)}
              />
              <span>
                <strong>{user.displayName}</strong>
                <small>@{user.username}</small>
              </span>
              <span>{reason ?? (user.online ? "在线" : "离线")}</span>
            </label>
          );
        })}
      </div>
      <ActionableStatus errorCode={errorCode} />
      <footer class="dialog-actions">
        <button class="secondary-button" type="button" onClick={onBack}>
          返回
        </button>
        <button
          class="primary-button"
          type="button"
          aria-label="发送邀请"
          disabled={sending || selected.size === 0}
          onClick={() => void send()}
        >
          {sending ? "正在发送…" : `发送邀请${selected.size > 0 ? ` (${selected.size})` : ""}`}
        </button>
      </footer>
    </section>
  );
}
