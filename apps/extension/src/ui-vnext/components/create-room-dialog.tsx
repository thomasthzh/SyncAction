import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons.js";
import type { UiCommandResult } from "../../ui/ui-protocol.js";
import { ActionableStatus } from "./actionable-status.js";
import { ModalDialog } from "./modal-dialog.js";

type Visibility = "PRIVATE" | "PUBLIC";
type JoinPolicy = "OPEN" | "APPROVAL" | "INVITE_ONLY";

export interface CreateRoomDialogProps {
  readonly onSubmit: (input: {
    name: string;
    visibility: Visibility;
    joinPolicy: JoinPolicy;
  }) => Promise<UiCommandResult>;
  readonly onClose: () => void;
}

export function CreateRoomDialog({ onSubmit, onClose }: CreateRoomDialogProps): preact.JSX.Element {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("PRIVATE");
  const [joinPolicy, setJoinPolicy] = useState<JoinPolicy>("INVITE_ONLY");
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [nameInvalid, setNameInvalid] = useState(false);
  const submitting = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!pending) {
      if (nameInvalid) {
        nameRef.current?.focus();
      } else if (errorCode !== null) {
        feedbackRef.current?.focus();
      }
    }
  }, [nameInvalid, errorCode, pending]);

  function close(): void {
    if (!submitting.current) {
      onClose();
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting.current) {
      return;
    }
    setErrorCode(null);
    const normalizedName = name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const nameLength = Array.from(normalizedName).length;
    if (nameLength < 1 || nameLength > 100) {
      setNameInvalid(true);
      nameRef.current?.focus();
      return;
    }
    setNameInvalid(false);
    submitting.current = true;
    setPending(true);
    try {
      const result = await onSubmit({ name: normalizedName, visibility, joinPolicy });
      if (!result.ok) {
        setErrorCode(result.errorCode);
      }
    } catch {
      setErrorCode("NETWORK_ERROR");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const titleId = "syncaction-create-room-title";
  return (
    <ModalDialog titleId={titleId} pending={pending} onClose={close} className="create-room-dialog">
      <header class="dialog-header">
        <div>
          <p class="eyebrow">新协作空间</p>
          <h2 id={titleId}>创建房间</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="关闭"
          title="关闭"
          disabled={pending}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>
      <form class="dialog-form" noValidate onSubmit={(event) => void submit(event)}>
        <label>
          房间名称
          <input
            ref={nameRef}
            name="name"
            autocomplete="off"
            placeholder="例如：周末观影、产品讨论"
            maxlength={100}
            required
            disabled={pending}
            data-dialog-autofocus
            aria-invalid={nameInvalid}
            aria-describedby={nameInvalid ? "room-name-help room-name-error" : "room-name-help"}
            value={name}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setNameInvalid(false);
            }}
          />
        </label>
        <p class="field-help" id="room-name-help">
          给这次协作起个名字，1–100 个字符。
        </p>
        {nameInvalid ? (
          <p class="field-error" id="room-name-error" role="alert">
            请输入 1–100 个字符的房间名称，不能只包含空格。
          </p>
        ) : null}
        <label>
          可见范围
          <select
            name="visibility"
            value={visibility}
            disabled={pending}
            aria-describedby="room-visibility-help"
            onChange={(event) => {
              const next = event.currentTarget.value as Visibility;
              setVisibility(next);
              setJoinPolicy(next === "PRIVATE" ? "INVITE_ONLY" : "APPROVAL");
            }}
          >
            <option value="PRIVATE">私密 · 仅邀请</option>
            <option value="PUBLIC">公开 · 可发现</option>
          </select>
        </label>
        <p class="field-help" id="room-visibility-help">
          {visibility === "PRIVATE"
            ? "仅受邀成员可见，适合与熟悉的人一起协作。"
            : "所有使用此服务器的人都能在公开大厅发现房间。"}
        </p>
        <label>
          加入方式
          <select
            name="joinPolicy"
            value={joinPolicy}
            disabled={pending || visibility === "PRIVATE"}
            aria-describedby="room-join-help"
            onChange={(event) => setJoinPolicy(event.currentTarget.value as JoinPolicy)}
          >
            {visibility === "PUBLIC" ? <option value="OPEN">直接加入</option> : null}
            {visibility === "PUBLIC" ? <option value="APPROVAL">需要批准</option> : null}
            <option value="INVITE_ONLY">仅限邀请</option>
          </select>
        </label>
        <p class="field-help" id="room-join-help">
          {joinPolicy === "OPEN"
            ? "登录用户可以直接加入，无需房主批准。"
            : joinPolicy === "APPROVAL"
              ? "用户先申请，由你批准后加入。"
              : "由你发送邀请，受邀用户接受后加入。"}
        </p>
        <div ref={feedbackRef} class="dialog-feedback" role="alert" tabIndex={-1}>
          <ActionableStatus errorCode={errorCode} id="create-room-error" />
        </div>
        <div class="dialog-actions">
          <button class="secondary-button" type="button" disabled={pending} onClick={close}>
            取消
          </button>
          <button class="primary-button" type="submit" disabled={pending}>
            {pending ? "正在创建…" : "创建"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
