import { useState } from "preact/hooks";
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

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setErrorCode(null);
    const result = await onSubmit({
      name: name.trim(),
      visibility,
      joinPolicy,
    });
    if (!result.ok) {
      setErrorCode(result.errorCode);
    }
    setPending(false);
  }

  const titleId = "syncaction-create-room-title";
  return (
    <ModalDialog titleId={titleId} pending={pending} onClose={onClose}>
      <header class="dialog-header">
        <div>
          <p class="eyebrow">新协作空间</p>
          <h2 id={titleId}>创建房间</h2>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <form class="dialog-form" onSubmit={(event) => void submit(event)}>
        <label>
          房间名称
          <input
            name="name"
            maxlength={100}
            required
            value={name}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          可见范围
          <select
            name="visibility"
            value={visibility}
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
        <label>
          加入方式
          <select
            name="joinPolicy"
            value={joinPolicy}
            onChange={(event) => setJoinPolicy(event.currentTarget.value as JoinPolicy)}
          >
            {visibility === "PUBLIC" ? <option value="OPEN">直接加入</option> : null}
            {visibility === "PUBLIC" ? <option value="APPROVAL">需要批准</option> : null}
            <option value="INVITE_ONLY">仅限邀请</option>
          </select>
        </label>
        <ActionableStatus errorCode={errorCode} id="create-room-error" />
        <div class="dialog-actions">
          <button class="secondary-button" type="button" onClick={onClose}>
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
