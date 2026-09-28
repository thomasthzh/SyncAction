import type {
  ExtensionCollaborationMemberSummary,
  ExtensionCollaborationAnnotationSummary,
  ExtensionCollaborationPageSummary,
  ExtensionCollaborationToolSummary,
} from "../app-controller.js";
import type { PageToolCommandBindings } from "../command-bindings.js";
import type { DanmakuControllerStatus } from "../danmaku-controller.js";
import type { DrawingControllerStatus } from "../drawing-controller.js";

export type CollaborationToolAction =
  "ENABLE_POINTER" | "TOGGLE_DANMAKU" | "SHOW_DANMAKU" | "HIDE_DANMAKU" | "TOGGLE_DRAWING";

export interface CollaborationViewModelInput {
  tools: readonly ExtensionCollaborationToolSummary[];
  annotation: ExtensionCollaborationAnnotationSummary;
  danmaku: DanmakuControllerStatus | null;
  drawing: DrawingControllerStatus | null;
  bindings: PageToolCommandBindings | null;
}

export interface CollaborationToolView {
  toolId: string;
  title: string;
  shortcutText: string;
  detail: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  primaryAction: CollaborationToolAction;
  primaryLabel: string;
  primaryDisabled: boolean;
  secondaryAction: CollaborationToolAction | null;
  secondaryLabel: string | null;
  disabledReason: string | null;
  canOpenShortcutSettings: boolean;
}

export interface CollaborationViewModel {
  tools: CollaborationToolView[];
  annotation: {
    title: string;
    detail: string;
    tone: "neutral" | "info" | "success" | "warning" | "danger";
    canCreate: boolean;
    disabledReason: string | null;
  };
  scope: {
    text: string;
    tone: "info";
  };
}

export type PageCompatibility = "EXACT" | "MISMATCH" | "UNKNOWN";
export type AvatarPaletteToken =
  "avatar-1" | "avatar-2" | "avatar-3" | "avatar-4" | "avatar-5" | "avatar-6";

export interface MemberAvatarModel {
  readonly initials: string;
  readonly paletteToken: AvatarPaletteToken;
}

export interface MediaRowModel {
  readonly groupId: string;
  readonly provider: string;
  readonly title: string;
  readonly leaderAccountId: string;
  readonly progressText: string;
  readonly memberCount: number;
}

export interface SharedTabRowModel {
  readonly pageKey: string;
  readonly title: string;
  readonly domain: string;
  readonly url: string;
  readonly viewerAccountIds: readonly string[];
  readonly compatibility: PageCompatibility;
  readonly media: MediaRowModel | null;
}

export interface SharedTabRowsInput {
  readonly pages: readonly ExtensionCollaborationPageSummary[];
  readonly members: readonly ExtensionCollaborationMemberSummary[];
  readonly currentUserId: string | null;
  readonly compatibilityByPage?: Readonly<Record<string, PageCompatibility>>;
  readonly mediaByPage?: Readonly<Record<string, MediaRowModel>>;
}

const avatarPalette: readonly AvatarPaletteToken[] = [
  "avatar-1",
  "avatar-2",
  "avatar-3",
  "avatar-4",
  "avatar-5",
  "avatar-6",
];

export function avatarForMember(displayName: string, userId: string): MemberAvatarModel {
  const normalizedName = displayName.normalize("NFKC").trim();
  const segments = normalizedName.split(/\s+/u).filter((segment) => segment.length > 0);
  const initials =
    segments.length > 1
      ? `${firstGrapheme(segments[0]!)}${firstGrapheme(segments.at(-1)!)}`
      : [...normalizedName].slice(0, 2).join("");
  let hash = 2_166_136_261;
  for (const character of userId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return {
    initials: initials.length > 0 ? initials : "·",
    paletteToken: avatarPalette[(hash >>> 0) % avatarPalette.length]!,
  };
}

export function createSharedTabRows(input: SharedTabRowsInput): SharedTabRowModel[] {
  const uniquePages = uniqueBy(input.pages, ({ pageId }) => pageId);
  const uniqueMembers = uniqueBy(input.members, ({ userId }) => userId);
  const viewerIdsByPage = new Map<string, string[]>();
  for (const member of uniqueMembers) {
    for (const pageId of new Set(member.activePageIds)) {
      const viewers = viewerIdsByPage.get(pageId) ?? [];
      viewers.push(member.userId);
      viewerIdsByPage.set(pageId, viewers);
    }
  }
  return uniquePages
    .map((page): SharedTabRowModel => {
      const viewerAccountIds = viewerIdsByPage.get(page.pageId) ?? [];
      return {
        pageKey: page.pageId,
        title: page.title,
        domain: page.domain,
        url: page.domain.length > 0 ? `https://${page.domain}` : "",
        viewerAccountIds,
        compatibility: input.compatibilityByPage?.[page.pageId] ?? "UNKNOWN",
        media: input.mediaByPage?.[page.pageId] ?? null,
      };
    })
    .sort((left, right) => {
      const currentOnLeft =
        input.currentUserId !== null && left.viewerAccountIds.includes(input.currentUserId);
      const currentOnRight =
        input.currentUserId !== null && right.viewerAccountIds.includes(input.currentUserId);
      if (currentOnLeft !== currentOnRight) {
        return currentOnLeft ? -1 : 1;
      }
      return (
        right.viewerAccountIds.length - left.viewerAccountIds.length ||
        normalizedTitle(left.title).localeCompare(normalizedTitle(right.title), "zh-CN") ||
        left.pageKey.localeCompare(right.pageKey)
      );
    });
}

export function createCollaborationViewModel(
  input: CollaborationViewModelInput,
): CollaborationViewModel {
  return {
    tools: input.tools.map((tool) => toolView(tool, input)),
    annotation: annotationView(input.annotation, input.drawing),
    scope: {
      text: "页面协作仅在共享文档的顶层与已授权 frame 中生效；浏览器保护页与未授权来源不会注入。",
      tone: "info",
    },
  };
}

function toolView(
  tool: ExtensionCollaborationToolSummary,
  input: CollaborationViewModelInput,
): CollaborationToolView {
  const disabledReason = tool.canActivate
    ? null
    : (tool.disabledReason ?? `${toolTitle(tool.kind)}当前不可用`);
  const base = {
    toolId: tool.toolId,
    title: toolTitle(tool.kind),
    tone: toolTone(tool),
    primaryDisabled: !tool.canActivate,
    disabledReason,
  } as const;

  if (tool.kind === "POINTER") {
    return {
      ...base,
      shortcutText: "无需快捷键",
      detail: appendReason(tool.statusText, disabledReason),
      primaryAction: "ENABLE_POINTER",
      primaryLabel: tool.errorCode === "POINTER_PERMISSION_REQUIRED" ? "授予权限" : "刷新",
      secondaryAction: null,
      secondaryLabel: null,
      canOpenShortcutSettings: false,
    };
  }

  if (tool.kind === "DANMAKU") {
    const runtime = input.danmaku;
    return {
      ...base,
      shortcutText: shortcutText(input.bindings?.danmaku ?? null, "Alt+T", input.bindings),
      detail: appendReason(
        runtime === null
          ? tool.statusText
          : `${runtime.hidden ? "已隐藏" : "显示中"} · ${
              runtime.inputOpen ? "输入栏已打开" : "输入栏关闭"
            }`,
        disabledReason,
      ),
      primaryAction: "TOGGLE_DANMAKU",
      primaryLabel: runtime?.inputOpen === true ? "关闭输入" : "输入",
      secondaryAction: runtime?.hidden === true ? "SHOW_DANMAKU" : "HIDE_DANMAKU",
      secondaryLabel: runtime?.hidden === true ? "显示" : "隐藏",
      canOpenShortcutSettings: input.bindings?.danmaku.state === "UNBOUND",
    };
  }

  const runtime = input.drawing;
  return {
    ...base,
    shortcutText: shortcutText(input.bindings?.pen ?? null, "Alt+P", input.bindings),
    detail: appendReason(
      runtime === null
        ? tool.statusText
        : `${drawingToolLabel(runtime.tool)} · ${rgbHex(runtime.rgb)} · ${formatWidth(
            runtime.width,
          )} px`,
      disabledReason,
    ),
    primaryAction: "TOGGLE_DRAWING",
    primaryLabel: runtime?.active === true ? "关闭" : "打开",
    secondaryAction: null,
    secondaryLabel: null,
    canOpenShortcutSettings: input.bindings?.pen.state === "UNBOUND",
  };
}

function annotationView(
  annotation: ExtensionCollaborationAnnotationSummary,
  drawing: DrawingControllerStatus | null,
): CollaborationViewModel["annotation"] {
  const capacity = annotation.capacity === null ? "—" : String(annotation.capacity);
  const details: string[] = [];
  if (annotation.lockedCount > 0) {
    details.push(`${String(annotation.lockedCount)} 锁定`);
  }
  if (drawing !== null && drawing.selectedCount > 0) {
    details.push(
      `${String(drawing.selectedCount)} 选中${
        drawing.selectedLockedCount > 0 ? `（${String(drawing.selectedLockedCount)} 锁定）` : ""
      }`,
    );
  }
  if (drawing !== null && drawing.pendingDraftCount > 0) {
    details.push(`${String(drawing.pendingDraftCount)} 待确认`);
  }
  if (drawing !== null && drawing.errorDraftCount > 0) {
    details.push(`${String(drawing.errorDraftCount)} 未发送`);
  }
  if (drawing !== null && drawing.unlocatableCount > 0) {
    details.push(`${String(drawing.unlocatableCount)} 无法定位`);
  }
  return {
    title: `涂鸦 ${String(annotation.used)} / ${capacity}`,
    detail: details.length === 0 ? "暂无待处理涂鸦" : details.join(" · "),
    tone:
      annotation.state === "FULL"
        ? "danger"
        : annotation.state === "NEAR_LIMIT"
          ? "warning"
          : annotation.state === "AVAILABLE"
            ? "neutral"
            : "info",
    canCreate: annotation.canCreate,
    disabledReason: annotation.disabledReason,
  };
}

function shortcutText(
  binding: PageToolCommandBindings["danmaku"] | PageToolCommandBindings["pen"] | null,
  suggested: "Alt+T" | "Alt+P",
  bindings: PageToolCommandBindings | null,
): string {
  if (bindings === null) {
    return "快捷键状态读取中";
  }
  if (binding?.actualShortcut !== null && binding?.actualShortcut !== undefined) {
    return binding.actualShortcut;
  }
  return `未绑定 · 建议 ${suggested}`;
}

function toolTitle(kind: ExtensionCollaborationToolSummary["kind"]): string {
  return kind === "POINTER" ? "同页光标" : kind === "DANMAKU" ? "弹幕" : "画笔";
}

function toolTone(tool: ExtensionCollaborationToolSummary): CollaborationToolView["tone"] {
  return tool.state === "DEGRADED"
    ? "warning"
    : tool.state === "ACTIVE"
      ? "success"
      : tool.state === "AVAILABLE"
        ? "info"
        : "neutral";
}

function drawingToolLabel(tool: DrawingControllerStatus["tool"]): string {
  return tool === "PEN" ? "画笔" : tool === "ERASER" ? "橡皮擦" : "框选";
}

function rgbHex(rgb: DrawingControllerStatus["rgb"]): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function formatWidth(width: number): string {
  return Number.isInteger(width) ? String(width) : width.toFixed(1);
}

function appendReason(detail: string, reason: string | null): string {
  return reason === null ? detail : `${detail} · ${reason}`;
}

function firstGrapheme(value: string): string {
  return [...value][0] ?? "";
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}
