import type { JSX } from "preact";
import type { UiCommandInput, UiStore } from "../store.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import { Icon, type IconName } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";
import { GlassMaterial } from "./glass-material.js";
import { shareResult } from "../share-result.js";

export interface BottomActionDockProps {
  readonly store: UiStore;
  readonly isOwner: boolean;
  readonly onOpenInvite: () => void;
  readonly onOpenRoomLifecycle: () => void;
  readonly onRequestPagePermission: (intentKey: string) => void;
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

  async function run(tool: DockTool): Promise<void> {
    if (tool.label === "邀请") {
      onOpenInvite();
      return;
    }
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
    const command = tool.command;
    let successMessage =
      command.name === "CURRENT_TAB_SHARE" ? "当前页面已提交分享" : `${tool.label}操作已完成`;
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
  }

  return (
    <footer class="bottom-action-dock" data-bottom-action-dock>
      <GlassMaterial />
      <div class="bottom-action-dock__tools">
        {tools.map((tool) => (
          <span class="dock-tool" key={tool.label}>
            <button
              class={`dock-tool__button${tool.command?.name === "CURRENT_TAB_SHARE" ? " dock-tool__button--primary" : ""}`}
              type="button"
              aria-label={tool.label}
              title={tool.label}
              disabled={feedback.pending !== null}
              aria-busy={feedback.pending === tool.label}
              onClick={() => void run(tool)}
            >
              <Icon
                name={feedback.pending === tool.label ? "sync" : tool.icon}
                className={feedback.pending === tool.label ? "is-spinning" : ""}
              />
              <span class="dock-tool__label">
                {feedback.pending === tool.label ? "处理中…" : tool.label}
              </span>
            </button>
            <span class="dock-tool__tooltip" role="tooltip">
              {tool.label}
            </span>
          </span>
        ))}
      </div>
      <button
        class="dock-room-action"
        type="button"
        onClick={onOpenRoomLifecycle}
        aria-label={isOwner ? "房间操作" : "退出房间"}
        title={isOwner ? "房间操作" : "退出房间"}
      >
        <Icon name={isOwner ? "users" : "leave"} size={18} />
        <span class="sr-only">{isOwner ? "房间操作" : "退出房间"}</span>
      </button>
      {feedback.message !== null ? (
        <p class="command-feedback" role="status">
          <Icon name="check" size={16} />
          {feedback.message}
        </p>
      ) : null}
      <ActionableStatus errorCode={feedback.errorCode} />
    </footer>
  );
}
