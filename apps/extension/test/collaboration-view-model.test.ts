import { describe, expect, it } from "vitest";
import type {
  ExtensionCollaborationAnnotationSummary,
  ExtensionCollaborationToolSummary,
} from "../src/app-controller.js";
import type { DanmakuControllerStatus } from "../src/danmaku-controller.js";
import type { DrawingControllerStatus } from "../src/drawing-controller.js";
import {
  createCollaborationViewModel,
  type CollaborationViewModelInput,
} from "../src/ui/collaboration-view-model.js";

const tools: ExtensionCollaborationToolSummary[] = [
  {
    toolId: "pointer",
    kind: "POINTER",
    state: "DEGRADED",
    statusText: "当前站点未授权同页光标",
    errorCode: "POINTER_PERMISSION_REQUIRED",
    canActivate: true,
    disabledReason: null,
  },
  {
    toolId: "danmaku",
    kind: "DANMAKU",
    state: "AVAILABLE",
    statusText: "页面弹幕可用",
    errorCode: null,
    canActivate: true,
    disabledReason: null,
  },
  {
    toolId: "drawing",
    kind: "DRAWING",
    state: "AVAILABLE",
    statusText: "页面画笔可用",
    errorCode: null,
    canActivate: true,
    disabledReason: null,
  },
];

const annotation: ExtensionCollaborationAnnotationSummary = {
  used: 1_824,
  capacity: 2_000,
  lockedCount: 17,
  state: "NEAR_LIMIT",
  canCreate: true,
  disabledReason: null,
};

const danmaku: DanmakuControllerStatus = {
  state: "ONLINE",
  errorCode: null,
  lastMessageId: null,
  ready: true,
  canRetry: false,
  hidden: true,
  inputOpen: false,
};

const drawing: DrawingControllerStatus = {
  state: "ONLINE",
  errorCode: null,
  pageKey: "A".repeat(43),
  used: 1_824,
  capacity: 2_000,
  lockedCount: 17,
  capacityState: "NEAR_LIMIT",
  canCreate: true,
  pendingDraftCount: 2,
  errorDraftCount: 1,
  unlocatableCount: 4,
  ready: true,
  canRetry: false,
  active: true,
  tool: "ERASER",
  rgb: { r: 16, g: 128, b: 240 },
  width: 9,
  selectedCount: 3,
  selectedLockedCount: 1,
};

function input(overrides: Partial<CollaborationViewModelInput> = {}): CollaborationViewModelInput {
  return {
    tools,
    annotation,
    danmaku,
    drawing,
    bindings: {
      danmaku: {
        command: "toggle-danmaku-input",
        suggestedShortcut: "Alt+T",
        actualShortcut: "Alt+Shift+T",
        state: "BOUND",
      },
      pen: {
        command: "toggle-page-pen",
        suggestedShortcut: "Alt+P",
        actualShortcut: null,
        state: "UNBOUND",
      },
    },
    ...overrides,
  };
}

describe("collaboration tool view model", () => {
  it("shows actual shortcuts, equivalent actions, and dense runtime state", () => {
    const view = createCollaborationViewModel(input());

    expect(view.tools).toEqual([
      expect.objectContaining({
        toolId: "pointer",
        title: "同页光标",
        primaryAction: "ENABLE_POINTER",
        primaryLabel: "授予权限",
      }),
      expect.objectContaining({
        toolId: "danmaku",
        title: "弹幕",
        shortcutText: "Alt+Shift+T",
        detail: "已隐藏 · 输入栏关闭",
        primaryAction: "TOGGLE_DANMAKU",
        secondaryAction: "SHOW_DANMAKU",
        secondaryLabel: "显示",
      }),
      expect.objectContaining({
        toolId: "drawing",
        title: "画笔",
        shortcutText: "未绑定 · 建议 Alt+P",
        detail: "橡皮擦 · #1080F0 · 9 px",
        primaryAction: "TOGGLE_DRAWING",
        primaryLabel: "关闭",
        canOpenShortcutSettings: true,
      }),
    ]);
    expect(view.annotation).toMatchObject({
      title: "涂鸦 1824 / 2000",
      detail: "17 锁定 · 3 选中（1 锁定） · 2 待确认 · 1 未发送 · 4 无法定位",
      tone: "warning",
    });
    expect(view.scope.text).toContain("顶层与已授权 frame");
  });

  it("keeps visible reasons on disabled actions and handles unavailable runtime details", () => {
    const unavailableTools = tools.map((tool) =>
      tool.kind === "DRAWING"
        ? {
            ...tool,
            state: "UNAVAILABLE" as const,
            canActivate: false,
            disabledReason: "当前页面是浏览器保护页",
          }
        : tool,
    );
    const view = createCollaborationViewModel(
      input({
        tools: unavailableTools,
        drawing: null,
        danmaku: null,
        bindings: null,
      }),
    );

    expect(view.tools.find((tool) => tool.toolId === "drawing")).toMatchObject({
      primaryDisabled: true,
      disabledReason: "当前页面是浏览器保护页",
      shortcutText: "快捷键状态读取中",
    });
    expect(view.annotation.detail).toBe("17 锁定");
  });
});
