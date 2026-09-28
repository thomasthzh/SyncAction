import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UiCommandInput, UiStore } from "../store.js";
import { announce } from "../accessibility.js";
import { Icon } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";
import { ModalDialog } from "./modal-dialog.js";

type LifecycleView = "HOME" | "LEAVE" | "SETTINGS" | "TRANSFER" | "DISSOLVE";

export interface RoomLifecycleSheetProps {
  readonly store: UiStore;
  readonly onClose: () => void;
}

export function RoomLifecycleSheet({ store, onClose }: RoomLifecycleSheetProps): JSX.Element {
  const room = store.room.value.detail;
  const isOwner = room?.role === "OWNER";
  const transferCandidates = room?.members.filter(({ role }) => role !== "OWNER") ?? [];
  const [view, setView] = useState<LifecycleView>(isOwner ? "HOME" : "LEAVE");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState(transferCandidates[0]?.userId ?? "");
  const [dissolveName, setDissolveName] = useState("");
  const [roomName, setRoomName] = useState(room?.name ?? "");
  const [visibility, setVisibility] = useState<"PRIVATE" | "PUBLIC">(room?.visibility ?? "PRIVATE");
  const [joinPolicy, setJoinPolicy] = useState<"OPEN" | "APPROVAL" | "INVITE_ONLY">(
    room?.joinPolicy ?? "INVITE_ONLY",
  );
  const [managedUserId, setManagedUserId] = useState<string | null>(null);
  const titleId = "room-lifecycle-title";

  async function submit(
    actionKey: string,
    command: UiCommandInput,
    completion: string,
  ): Promise<void> {
    if (pendingAction !== null) {
      return;
    }
    setPendingAction(actionKey);
    setErrorCode(null);
    const result = await store.command(command);
    if (result.ok) {
      announce(`${completion}，等待房间同步`);
      onClose();
      return;
    }
    setPendingAction(null);
    setErrorCode(result.errorCode);
  }

  function returnHome(): void {
    setView("HOME");
    setErrorCode(null);
    setManagedUserId(null);
  }

  function changeVisibility(next: "PRIVATE" | "PUBLIC"): void {
    setVisibility(next);
    setJoinPolicy(next === "PRIVATE" ? "INVITE_ONLY" : "APPROVAL");
  }

  return (
    <ModalDialog titleId={titleId} onClose={onClose} className="room-lifecycle-sheet">
      <header class="dialog-header">
        <div>
          <p class="eyebrow">{isOwner ? "房主管理" : "成员操作"}</p>
          <h2 id={titleId}>{view === "LEAVE" ? `退出${room?.name ?? "房间"}` : "房间操作"}</h2>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {view === "LEAVE" ? (
        <section class="lifecycle-panel">
          <p>退出后，共享标签页不会被本地关闭；你可以稍后重新申请加入。</p>
          <footer class="dialog-actions">
            <button class="secondary-button" type="button" onClick={onClose}>
              取消
            </button>
            <button
              class="danger-button"
              type="button"
              disabled={pendingAction === "LEAVE"}
              onClick={() => void submit("LEAVE", { name: "ROOM_LEAVE" }, "退出请求已提交")}
            >
              <Icon name="leave" size={18} />
              确认退出房间
            </button>
          </footer>
        </section>
      ) : null}

      {view === "HOME" ? (
        <section class="lifecycle-panel">
          <div class="lifecycle-primary-actions">
            <button type="button" onClick={() => setView("SETTINGS")}>
              <Icon name="pen" size={18} />
              编辑房间设置
            </button>
            <button type="button" onClick={() => setView("TRANSFER")}>
              <Icon name="transfer" size={18} />
              转让房主
            </button>
            <button class="danger-button" type="button" onClick={() => setView("DISSOLVE")}>
              <Icon name="trash" size={18} />
              解散房间
            </button>
          </div>
          <div class="lifecycle-member-list" aria-label="成员管理">
            <h3>成员</h3>
            {transferCandidates.map((member) => (
              <div class="lifecycle-member-row" key={member.userId}>
                <span>
                  <strong>{member.displayName}</strong>
                  <small>@{member.username}</small>
                </span>
                <button
                  type="button"
                  aria-label={`管理 ${member.displayName}`}
                  aria-expanded={managedUserId === member.userId}
                  onClick={() =>
                    setManagedUserId((current) =>
                      current === member.userId ? null : member.userId,
                    )
                  }
                >
                  管理
                </button>
                {managedUserId === member.userId ? (
                  <button
                    class="danger-button"
                    type="button"
                    disabled={pendingAction === `REMOVE:${member.userId}`}
                    onClick={() =>
                      void submit(
                        `REMOVE:${member.userId}`,
                        {
                          name: "ROOM_MEMBER_REMOVE",
                          payload: { userId: member.userId },
                        },
                        `已提交移除 ${member.displayName}`,
                      )
                    }
                  >
                    <Icon name="trash" size={16} />
                    移除 {member.displayName}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {view === "SETTINGS" ? (
        <form
          class="lifecycle-panel form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              "UPDATE",
              {
                name: "ROOM_UPDATE",
                payload: {
                  name: roomName.trim(),
                  visibility,
                  joinPolicy,
                },
              },
              "房间设置已提交",
            );
          }}
        >
          <label>
            房间名称
            <input
              name="lifecycleRoomName"
              value={roomName}
              maxlength={80}
              required
              onInput={(event) => setRoomName(event.currentTarget.value)}
            />
          </label>
          <label>
            可见性
            <select
              name="lifecycleVisibility"
              value={visibility}
              onChange={(event) =>
                changeVisibility(event.currentTarget.value as "PRIVATE" | "PUBLIC")
              }
            >
              <option value="PUBLIC">公开</option>
              <option value="PRIVATE">私密</option>
            </select>
          </label>
          <label>
            加入方式
            <select
              name="lifecycleJoinPolicy"
              value={joinPolicy}
              disabled={visibility === "PRIVATE"}
              onChange={(event) =>
                setJoinPolicy(event.currentTarget.value as "OPEN" | "APPROVAL" | "INVITE_ONLY")
              }
            >
              <option value="APPROVAL">需要批准</option>
              <option value="OPEN">直接加入</option>
              <option value="INVITE_ONLY">仅邀请</option>
            </select>
          </label>
          <footer class="dialog-actions">
            <button class="secondary-button" type="button" onClick={returnHome}>
              返回房间操作
            </button>
            <button
              class="primary-button"
              type="submit"
              disabled={pendingAction === "UPDATE" || roomName.trim().length === 0}
            >
              保存设置
            </button>
          </footer>
        </form>
      ) : null}

      {view === "TRANSFER" ? (
        <section class="lifecycle-panel">
          <label>
            新房主
            <select
              name="transferTarget"
              value={transferTarget}
              onChange={(event) => setTransferTarget(event.currentTarget.value)}
            >
              {transferCandidates.map((member) => (
                <option value={member.userId} key={member.userId}>
                  {member.displayName}
                </option>
              ))}
            </select>
          </label>
          <p>转让成功后，你将成为普通成员。</p>
          <footer class="dialog-actions">
            <button class="secondary-button" type="button" onClick={returnHome}>
              返回房间操作
            </button>
            <button
              class="primary-button"
              type="button"
              disabled={pendingAction === "TRANSFER" || transferTarget === ""}
              onClick={() =>
                void submit(
                  "TRANSFER",
                  {
                    name: "ROOM_OWNERSHIP_TRANSFER",
                    payload: { userId: transferTarget },
                  },
                  "房主转让已提交",
                )
              }
            >
              <Icon name="transfer" size={18} />
              确认转让房主
            </button>
          </footer>
        </section>
      ) : null}

      {view === "DISSOLVE" ? (
        <section class="lifecycle-panel">
          <p>
            输入完整房间名 <strong>{room?.name}</strong> 以确认。此操作将结束所有人的房间协作。
          </p>
          <label>
            房间名称
            <input
              name="dissolveName"
              autocomplete="off"
              value={dissolveName}
              onInput={(event) => setDissolveName(event.currentTarget.value)}
            />
          </label>
          <footer class="dialog-actions">
            <button class="secondary-button" type="button" onClick={returnHome}>
              返回房间操作
            </button>
            <button
              class="danger-button"
              type="button"
              disabled={pendingAction === "DISSOLVE" || dissolveName !== room?.name}
              onClick={() => void submit("DISSOLVE", { name: "ROOM_DISSOLVE" }, "解散请求已提交")}
            >
              <Icon name="trash" size={18} />
              确认解散
            </button>
          </footer>
        </section>
      ) : null}

      <ActionableStatus errorCode={errorCode} />
    </ModalDialog>
  );
}
