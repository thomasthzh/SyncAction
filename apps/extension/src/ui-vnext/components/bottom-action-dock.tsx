import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import type { UiCommandInput, UiStore } from "../store.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import { Icon, type IconName } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";
import { GlassMaterial } from "./glass-material.js";
import { shareResult } from "../share-result.js";
import { usePageToolPreparation } from "../use-page-tool-preparation.js";
import { capturePageShareContext } from "../page-share-context.js";

export interface BottomActionDockProps {
  readonly store: UiStore;
  readonly isOwner: boolean;
  readonly onOpenInvite: () => void;
  readonly onOpenRoomLifecycle: () => void;
  readonly onRequestPagePermission: (intentKey: string, expectedUrl?: string) => void;
}

interface DockTool {
  readonly label: string;
  readonly icon: IconName;
  readonly command?: UiCommandInput;
  readonly intentKey?: "danmaku" | "pen";
  readonly pageFeature?: "DANMAKU" | "DRAWING";
}

const tools: readonly DockTool[] = [
  {
    label: "分享当前页",
    icon: "share",
    command: { name: "CURRENT_TAB_SHARE" },
  },
  {
    label: "邀请",
    icon: "invite",
  },
  {
    label: "弹幕",
    icon: "danmaku",
    intentKey: "danmaku",
    pageFeature: "DANMAKU",
    command: { name: "DANMAKU_TOGGLE" },
  },
  {
    label: "画笔",
    icon: "pen",
    intentKey: "pen",
    pageFeature: "DRAWING",
    command: { name: "PEN_TOGGLE" },
  },
] as const;

export function BottomActionDock({
  store,
  isOwner,
  onOpenInvite,
  onOpenRoomLifecycle,
  onRequestPagePermission,
}: BottomActionDockProps): JSX.Element {
  const feedback = useCommandFeedback();
  const preparation = usePageToolPreparation(store, onRequestPagePermission);
  const [showCommandFeedback, setShowCommandFeedback] = useState(true);
  const commandInFlight = useRef(false);
  const busy = preparation.busy || feedback.pending !== null;
  const pendingPublication = store.pageAccess.value.pendingPublication != null;

  async function shareAsNew(): Promise<void> {
    const expectedContext = capturePageShareContext(store);
    if (commandInFlight.current || busy || expectedContext === null) return;
    commandInFlight.current = true;
    try {
      await feedback.run(
        "as-new",
        async () =>
          shareResult(
            await store.command({ name: "CURRENT_TAB_SHARE_AS_NEW", payload: { expectedContext } }),
          ).result,
        "当前页面已作为新页面提交分享",
      );
    } finally {
      commandInFlight.current = false;
    }
  }

  async function run(tool: DockTool): Promise<void> {
    if (commandInFlight.current || preparation.isBusy()) return;
    if (tool.label === "邀请") {
      preparation.cancel();
      onOpenInvite();
      return;
    }
    if (
      tool.intentKey !== undefined &&
      store.pageAccess.value.supported &&
      store.pageAccess.value.documentRevision === null
    ) {
      setShowCommandFeedback(false);
      preparation.request(tool.intentKey);
      return;
    }
    preparation.cancel();
    setShowCommandFeedback(true);
    if (
      tool.intentKey !== undefined &&
      tool.pageFeature !== undefined &&
      !store.pageAccess.value.enabledFeatures.includes(tool.pageFeature)
    ) {
      if (!store.pageAccess.value.supported) {
        feedback.setErrorCode("PROTECTED_PAGE");
      } else if (
        !store.pageAccess.value.browserPermissionGranted ||
        !store.pageAccess.value.termsAccepted
      ) {
        onRequestPagePermission(tool.intentKey);
      } else {
        feedback.setErrorCode(store.pageAccess.value.reason ?? "PAGE_FEATURE_UNAVAILABLE");
      }
      return;
    }
    if (tool.command === undefined) {
      return;
    }
    let command = tool.command;
    if (command.name === "CURRENT_TAB_SHARE") {
      const expectedContext = capturePageShareContext(store);
      if (expectedContext === null) {
        feedback.setErrorCode("PROTECTED_PAGE");
        return;
      }
      command = { name: "CURRENT_TAB_SHARE", payload: { expectedContext } };
    }
    let successMessage =
      command.name === "CURRENT_TAB_SHARE" ? "当前页面已提交分享" : `${tool.label}操作已完成`;
    commandInFlight.current = true;
    try {
      await feedback.run(
        tool.label,
        async () => {
          const result = await store.command(command);
          if (command.name !== "CURRENT_TAB_SHARE") return result;
          const outcome = shareResult(result);
          if (outcome.message !== null) successMessage = outcome.message;
          return outcome.result;
        },
        () => successMessage,
      );
    } finally {
      commandInFlight.current = false;
    }
  }

  return (
    <footer class="bottom-action-dock" data-bottom-action-dock>
      <GlassMaterial />
      <p class="dock-context" title={store.pageAccess.value.origin ?? "当前浏览器页面"}>
        <span>当前页</span>
        <strong>
          {store.pageAccess.value.origin === null
            ? "尚未选择网页"
            : new URL(store.pageAccess.value.origin).host}
        </strong>
      </p>
      {pendingPublication ? (
        <p class="dock-pending-publication" role="status">
          有更新待提交。房间仍使用上次提交的页面，当前页协作已暂停。
        </p>
      ) : null}
      <div class="bottom-action-dock__tools">
        {tools.map((tool) => {
          const label =
            tool.command?.name === "CURRENT_TAB_SHARE" && pendingPublication
              ? "提交页面更新"
              : tool.label;
          return (
            <span class="dock-tool" key={tool.label}>
              <button
                class={`dock-tool__button${tool.command?.name === "CURRENT_TAB_SHARE" ? " dock-tool__button--primary" : ""}`}
                type="button"
                aria-label={label}
                title={label}
                disabled={busy}
                aria-busy={feedback.pending === tool.label}
                onClick={() => void run(tool)}
              >
                <Icon
                  name={feedback.pending === tool.label ? "sync" : tool.icon}
                  className={feedback.pending === tool.label ? "is-spinning" : ""}
                />
                <span class="dock-tool__label">
                  {feedback.pending === tool.label ? "处理中…" : label}
                </span>
              </button>
              <span class="dock-tool__tooltip" role="tooltip">
                {label}
              </span>
            </span>
          );
        })}
      </div>
      <button
        class="dock-room-action"
        type="button"
        onClick={() => {
          preparation.cancel();
          onOpenRoomLifecycle();
        }}
        aria-label={isOwner ? "房间操作" : "退出房间"}
        title={isOwner ? "房间操作" : "退出房间"}
      >
        <Icon name={isOwner ? "users" : "leave"} size={18} />
        <span class="sr-only">{isOwner ? "房间操作" : "退出房间"}</span>
      </button>
      {preparation.preparation !== null ? (
        <section
          class="inline-status inline-status--info page-tool-preparation"
          aria-label={`准备${preparation.preparation.label}`}
          aria-live="polite"
        >
          <div>
            <strong>
              {preparation.preparation.stage === "CONFIRM"
                ? "先分享当前页面"
                : preparation.preparation.stage === "SHARING"
                  ? "正在分享当前页面…"
                  : preparation.preparation.stage === "WAITING_PAGE"
                    ? "正在确认房间页面…"
                    : `正在启用${preparation.preparation.label}…`}
            </strong>
            <p>
              {preparation.preparation.stage === "CONFIRM"
                ? `分享 ${new URL(preparation.preparation.origin).host} 的当前页面后，继续启用${preparation.preparation.label}。`
                : preparation.preparation.stage === "ACTIVATING"
                  ? "已发送启用操作，请在当前页面查看结果。"
                  : "页面与房间准备好后继续；切换页面或房间会停止本次启用。"}
            </p>
          </div>
          <div class="page-tool-preparation__actions">
            {preparation.preparation.stage === "CONFIRM" ? (
              <button
                class="primary-button"
                type="button"
                onClick={() => void preparation.confirm()}
              >
                分享当前页并启用{preparation.preparation.label}
              </button>
            ) : null}
            <button class="text-button" type="button" onClick={preparation.cancel}>
              {preparation.preparation.stage === "CONFIRM"
                ? "取消"
                : preparation.preparation.stage === "ACTIVATING"
                  ? "停止等待"
                  : "取消启用"}
            </button>
          </div>
        </section>
      ) : null}
      {(showCommandFeedback ? feedback.message : preparation.message) !== null ? (
        <p class="command-feedback" role="status">
          <Icon name="check" size={16} />
          {showCommandFeedback ? feedback.message : preparation.message}
        </p>
      ) : null}
      <ActionableStatus
        errorCode={showCommandFeedback ? feedback.errorCode : preparation.errorCode}
      />
      {pendingPublication &&
      (feedback.errorCode === "PAGE_PUBLICATION_STALE" ||
        preparation.errorCode === "PAGE_PUBLICATION_STALE") ? (
        <button
          class="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => void shareAsNew()}
        >
          作为新页面分享
        </button>
      ) : null}
    </footer>
  );
}
