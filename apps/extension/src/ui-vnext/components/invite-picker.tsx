import { DirectoryUserSchema, type DirectoryUser } from "@syncaction/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { z } from "zod";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";
import { BatchInvitationResponseSchema, type BatchInvitationResult } from "../../api-client.js";

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

export function InvitePicker(props: InvitePickerProps): JSX.Element {
  const scope = `${props.store.shell.value.selectedProfileId}:${props.store.shell.value.account?.id}:${props.store.room.value.detail?.id}`;
  return <InvitePickerContent key={scope} {...props} />;
}

function InvitePickerContent({
  store,
  onBack,
  backLabel = "关闭邀请",
}: InvitePickerProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [selected, setSelected] = useState<ReadonlyMap<string, DirectoryUser>>(new Map());
  const [outcomes, setOutcomes] = useState<
    readonly { user: DirectoryUser; status: BatchInvitationResult["status"] }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const requestNumber = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const room = store.room.value.detail;
  const scope = useRef({
    profileId: store.shell.value.selectedProfileId,
    roomId: room?.id,
    accountId: store.shell.value.account?.id,
  }).current;
  const isCurrent = () =>
    mounted.current &&
    scope.profileId === store.shell.value.selectedProfileId &&
    scope.roomId === store.room.value.detail?.id &&
    scope.accountId === store.shell.value.account?.id;
  useEffect(
    () => () => {
      mounted.current = false;
      requestNumber.current += 1;
    },
    [],
  );
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
      setSearchError(null);
      return;
    }
    setSearching(true);
    const timeout = globalThis.setTimeout(() => {
      void (async () => {
        try {
          const result = await store.command({
            name: "DIRECTORY_SEARCH",
            payload: {
              roomId: room.id,
              query: normalized,
              cursor: null,
              limit: 20,
            },
          });
          if (currentRequest !== requestNumber.current || !isCurrent()) {
            return;
          }
          if (!result.ok) {
            setSearchError(result.errorCode);
            setResults([]);
            setSearching(false);
            return;
          }
          const parsed = DirectoryResultSchema.safeParse(result.value);
          if (!parsed.success) {
            setSearchError("INVALID_DIRECTORY_RESPONSE");
            setResults([]);
            setSearching(false);
            return;
          }
          setResults(parsed.data.items);
          setSearchError(null);
          setSearching(false);
        } catch {
          if (currentRequest === requestNumber.current && isCurrent()) {
            setSearchError("NETWORK_ERROR");
            setSearching(false);
          }
        }
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

  function toggle(user: DirectoryUser, checked: boolean): void {
    const next = new Map(selected);
    if (checked) {
      next.set(user.userId, user);
    } else {
      next.delete(user.userId);
    }
    setSelected(next);
  }

  async function send(): Promise<void> {
    if (selected.size === 0 || inFlight.current || !isCurrent() || scope.roomId === undefined) {
      return;
    }
    setSending(true);
    inFlight.current = true;
    setErrorCode(null);
    const sent = new Map(selected);
    try {
      const result = await store.command({
        name: "INVITE_BATCH",
        payload: {
          userIds: [...sent.keys()],
          expectedContext: { profileId: scope.profileId, roomId: scope.roomId },
        },
      });
      if (!isCurrent()) return;
      if (result.ok) {
        const parsed = BatchInvitationResponseSchema.safeParse(result.value);
        if (
          !parsed.success ||
          parsed.data.length !== sent.size ||
          new Set(parsed.data.map((item) => item.userId)).size !== sent.size ||
          parsed.data.some((item) => !sent.has(item.userId))
        ) {
          setErrorCode("INVITE_RESULT_UNCONFIRMED");
          return;
        }
        setOutcomes(
          parsed.data.map((item) => ({ user: sent.get(item.userId)!, status: item.status })),
        );
        const remaining = new Map(sent);
        for (const item of parsed.data)
          if (!["NOT_FOUND", "FORBIDDEN"].includes(item.status)) remaining.delete(item.userId);
        setSelected(remaining);
      } else {
        setErrorCode(result.errorCode);
      }
    } catch {
      if (isCurrent()) setErrorCode("NETWORK_ERROR");
    } finally {
      inFlight.current = false;
      if (isCurrent()) setSending(false);
    }
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
      <p class="subtle-copy">
        邀请到「{room?.name ?? "当前房间"}」。可跨搜索选择，每次最多 20 人。
      </p>
      {selected.size > 0 ? (
        <section class="invite-roster" aria-label="已选成员">
          <strong>已选 {selected.size} 人</strong>
          {[...selected.values()].map((user) => (
            <div class="invitation-preview__row" key={user.userId}>
              <span>
                {user.displayName} <small>@{user.username}</small>
              </span>
              <button
                class="text-button"
                type="button"
                disabled={sending}
                aria-label={`移除 ${user.displayName}`}
                onClick={() => toggle(user, false)}
              >
                移除
              </button>
            </div>
          ))}
        </section>
      ) : null}
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
                disabled={sending || reason !== null}
                onChange={(event) => toggle(user, event.currentTarget.checked)}
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
      {!searching && query.trim().length >= 2 && results.length === 0 && errorCode === null ? (
        <p class="subtle-copy">没有找到账号，试试用户名或请朋友先注册。</p>
      ) : null}
      {outcomes.length > 0 ? (
        <section class="invite-outcomes" aria-label="邀请结果" aria-live="polite">
          {outcomes.map((item) => (
            <p key={item.user.userId}>
              <strong>{item.user.displayName}</strong> ·{" "}
              {
                (
                  {
                    CREATED: "邀请已发送",
                    ALREADY_MEMBER: "已经是成员",
                    ALREADY_PENDING: "已有待处理邀请",
                    NOT_FOUND: "账号已不可用，可移除后重试",
                    FORBIDDEN: "暂时无法邀请，已保留供重试",
                  } as const
                )[item.status]
              }
            </p>
          ))}
        </section>
      ) : null}
      <ActionableStatus errorCode={searchError} />
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
