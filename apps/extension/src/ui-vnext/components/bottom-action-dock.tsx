import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { UiCommandInput, UiStore } from "../store.js";
import { announce } from "../accessibility.js";
import { Icon, type IconName } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";

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
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

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
        setErrorCode("PROTECTED_PAGE");
      } else if (
        !store.pageAccess.value.browserPermissionGranted ||
        !store.pageAccess.value.termsAccepted
      ) {
        onRequestPagePermission(tool.intentKey);
      } else {
        setErrorCode(store.pageAccess.value.reason ?? "PAGE_FEATURE_UNAVAILABLE");
      }
      return;
    }
    if (tool.command === undefined || pendingLabel !== null) {
      return;
    }
    setPendingLabel(tool.label);
    setErrorCode(null);
    const result = await store.command(tool.command);
    setPendingLabel(null);
    if (result.ok) {
      announce(`${tool.label}已提交`);
    } else {
      setErrorCode(result.errorCode);
    }
  }

  return (
    <footer class="bottom-action-dock" data-bottom-action-dock>
      <div class="bottom-action-dock__tools">
        {tools.map((tool) => (
          <span class="dock-tool" key={tool.label}>
            <button
              class="dock-tool__button"
              type="button"
              aria-label={tool.label}
              title={tool.label}
              disabled={pendingLabel === tool.label}
              onClick={() => void run(tool)}
            >
              <Icon name={tool.icon} />
              <span class="dock-tool__label">{tool.label}</span>
            </button>
            <span class="dock-tool__tooltip" role="tooltip">
              {tool.label}
            </span>
          </span>
        ))}
      </div>
      <button class="dock-room-action" type="button" onClick={onOpenRoomLifecycle}>
        <Icon name={isOwner ? "users" : "leave"} size={18} />
        {isOwner ? "房间操作" : "退出房间"}
      </button>
      <ActionableStatus errorCode={errorCode} />
    </footer>
  );
}
