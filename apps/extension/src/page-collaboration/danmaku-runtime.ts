import {
  DanmakuEventMessageSchema,
  DanmakuTextSchema,
  type DanmakuErrorCode,
  type DanmakuEventMessage,
} from "@syncaction/protocol";
import type Danmaku from "danmaku";
import { CollaborationPageContextSchema, type CollaborationPageContext } from "./messages.js";

const MAX_VISIBLE_DANMAKU = 30;

export interface DanmakuRenderingComment {
  mode: "rtl";
  render(): HTMLElement;
}

export interface DanmakuRenderingEngine {
  emit(comment: DanmakuRenderingComment): void;
  clear(): void;
  resize(): void;
  show(): void;
  hide(): void;
  destroy(): void;
}

export interface DanmakuPageScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DanmakuSubmission {
  context: CollaborationPageContext;
  messageId: string;
  text: string;
}

export interface DanmakuRuntimeStatus {
  status: "IDLE" | "SENDING" | "SENT" | "FAILED";
  messageId: string | null;
  errorCode: DanmakuErrorCode | null;
}

export interface DanmakuPageRuntimeOptions {
  document: Document;
  window: Window;
  surface: HTMLElement;
  context: CollaborationPageContext;
  emitSubmit: (submission: DanmakuSubmission) => void | Promise<void>;
  createMessageId?: () => string;
  createEngine: (container: HTMLElement) => DanmakuRenderingEngine;
  reducedMotion?: () => boolean;
  now?: () => number;
  scheduler?: DanmakuPageScheduler;
  setInteraction?: (interaction: { active: boolean; capturesInput: boolean }) => void;
  reportState?: (state: { hidden: boolean; inputOpen: boolean }) => void | Promise<void>;
}

interface VisibleDanmaku {
  event: DanmakuEventMessage;
  expiryTimer: unknown;
}

export class DanmakuPageRuntime {
  readonly #document: Document;
  readonly #window: Window;
  readonly #surface: HTMLElement;
  readonly #emitSubmit: (submission: DanmakuSubmission) => void | Promise<void>;
  readonly #createMessageId: () => string;
  readonly #reducedMotion: () => boolean;
  readonly #now: () => number;
  readonly #scheduler: DanmakuPageScheduler;
  readonly #setInteraction: (interaction: { active: boolean; capturesInput: boolean }) => void;
  readonly #reportState:
    ((state: { hidden: boolean; inputOpen: boolean }) => void | Promise<void>) | undefined;
  readonly #style: HTMLStyleElement;
  readonly #root: HTMLDivElement;
  readonly #movingStage: HTMLDivElement;
  readonly #staticList: HTMLOListElement;
  readonly #engine: DanmakuRenderingEngine;
  readonly #messages = new Map<string, VisibleDanmaku>();
  readonly #resizeListener: () => void;
  #context: CollaborationPageContext;
  #inputBar: HTMLDivElement | null = null;
  #input: HTMLInputElement | null = null;
  #status: HTMLParagraphElement | null = null;
  #pendingMessageId: string | null = null;
  #pendingText: string | null = null;
  #hidden = false;
  #lastReportSignature = "";
  #disposed = false;

  public constructor(options: DanmakuPageRuntimeOptions) {
    this.#document = options.document;
    this.#window = options.window;
    this.#surface = options.surface;
    if (this.#surface.ownerDocument !== this.#document) {
      throw new Error("DANMAKU_SURFACE_DOCUMENT_MISMATCH");
    }
    this.#context = CollaborationPageContextSchema.parse(options.context);
    this.#emitSubmit = options.emitSubmit;
    this.#createMessageId = options.createMessageId ?? (() => crypto.randomUUID());
    this.#reducedMotion =
      options.reducedMotion ??
      (() => this.#window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? browserScheduler(this.#window);
    this.#setInteraction =
      options.setInteraction ??
      ((interaction) => {
        this.#surface.dataset.active = interaction.active ? "true" : "false";
        this.#surface.style.pointerEvents =
          interaction.active && interaction.capturesInput ? "auto" : "none";
      });
    this.#reportState = options.reportState;

    this.#style = this.#document.createElement("style");
    this.#style.textContent = DANMAKU_STYLES;
    this.#root = this.#document.createElement("div");
    this.#root.className = "syncaction-danmaku-root";
    this.#movingStage = this.#document.createElement("div");
    this.#movingStage.className = "syncaction-danmaku-moving";
    this.#movingStage.setAttribute("aria-hidden", "true");
    this.#staticList = this.#document.createElement("ol");
    this.#staticList.className = "syncaction-danmaku-static";
    this.#staticList.setAttribute("role", "log");
    this.#staticList.setAttribute("aria-live", "polite");
    this.#staticList.setAttribute("aria-label", "页面弹幕");
    this.#root.append(this.#movingStage, this.#staticList);
    this.#surface.append(this.#style, this.#root);
    this.#engine = options.createEngine(this.#movingStage);
    this.#engine.hide();
    this.#resizeListener = () => this.handleResize();
    this.#window.addEventListener("resize", this.#resizeListener, { passive: true });
    this.#refreshSurface();
    this.#emitStateReport();
  }

  public setContext(contextInput: CollaborationPageContext): void {
    if (this.#disposed) {
      return;
    }
    const context = CollaborationPageContextSchema.parse(contextInput);
    if (!sameContext(context, this.#context)) {
      this.clear();
      this.closeInput();
    }
    this.#context = context;
  }

  public handleCommand(
    action: "TOGGLE_INPUT" | "OPEN_INPUT" | "CLOSE_INPUT" | "SHOW" | "HIDE",
  ): void {
    if (this.#disposed) {
      return;
    }
    if (action === "SHOW" || action === "HIDE") {
      this.setHidden(action === "HIDE");
      return;
    }
    if (action === "CLOSE_INPUT" || (action === "TOGGLE_INPUT" && this.#input !== null)) {
      this.closeInput();
      return;
    }
    this.openInput();
  }

  public openInput(): void {
    if (this.#disposed) {
      return;
    }
    if (this.#input !== null) {
      this.#input.focus();
      return;
    }
    const bar = this.#document.createElement("div");
    bar.className = "syncaction-danmaku-input-bar";
    const input = this.#document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "输入弹幕，Enter 发送，Esc 关闭";
    input.setAttribute("aria-label", "发送页面弹幕");
    input.dataset.status = "idle";
    const status = this.#document.createElement("p");
    status.className = "syncaction-danmaku-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeInput();
        return;
      }
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.#submitInput();
      }
    });
    bar.append(input, status);
    this.#root.append(bar);
    this.#inputBar = bar;
    this.#input = input;
    this.#status = status;
    this.#refreshSurface();
    this.#emitStateReport();
    input.focus();
  }

  public closeInput(): void {
    this.#inputBar?.remove();
    this.#inputBar = null;
    this.#input = null;
    this.#status = null;
    this.#pendingMessageId = null;
    this.#pendingText = null;
    this.#refreshSurface();
    this.#emitStateReport();
  }

  public setStatus(status: DanmakuRuntimeStatus): void {
    if (this.#disposed || status.status === "IDLE" || status.messageId === null) {
      return;
    }
    if (status.messageId !== this.#pendingMessageId || this.#input === null) {
      return;
    }
    if (status.status === "SENDING") {
      this.#input.dataset.status = "sending";
      this.#setStatusText("发送中");
      return;
    }
    if (status.status === "FAILED") {
      if (status.errorCode === null) {
        return;
      }
      this.#input.dataset.status = "failed";
      this.#setStatusText(status.errorCode);
      this.#pendingMessageId = null;
      this.#pendingText = null;
      return;
    }
    if (this.#input.value === this.#pendingText) {
      this.#input.value = "";
    }
    this.#input.dataset.status = "sent";
    this.#setStatusText("已发送");
    this.#pendingMessageId = null;
    this.#pendingText = null;
  }

  public render(eventInput: DanmakuEventMessage): void {
    if (this.#disposed) {
      return;
    }
    const parsed = DanmakuEventMessageSchema.safeParse(eventInput);
    if (
      !parsed.success ||
      !eventMatchesContext(parsed.data, this.#context) ||
      parsed.data.expiresAtServerMs <= this.#now() ||
      this.#messages.has(parsed.data.messageId)
    ) {
      return;
    }
    const event = parsed.data;
    const expiryTimer = this.#scheduler.setTimeout(
      () => this.#expire(event.messageId),
      Math.max(0, event.expiresAtServerMs - this.#now()),
    );
    this.#messages.set(event.messageId, { event, expiryTimer });

    let evicted = false;
    while (this.#messages.size > MAX_VISIBLE_DANMAKU) {
      const oldestId = this.#messages.keys().next().value as string | undefined;
      if (oldestId === undefined) {
        break;
      }
      this.#deleteRecord(oldestId);
      evicted = true;
    }
    if (evicted) {
      this.#renderAll();
    } else {
      this.#renderOne(event);
    }
    this.#refreshSurface();
  }

  public setHidden(hidden: boolean): void {
    if (this.#disposed || this.#hidden === hidden) {
      return;
    }
    this.#hidden = hidden;
    this.#renderAll();
    this.#refreshSurface();
    this.#emitStateReport();
  }

  public handleResize(): void {
    if (!this.#disposed) {
      this.#engine.resize();
    }
  }

  public getVisibleMessageIds(): string[] {
    return [...this.#messages.keys()];
  }

  public getState(): {
    hidden: boolean;
    inputOpen: boolean;
    visibleCount: number;
    reducedMotion: boolean;
  } {
    return {
      hidden: this.#hidden,
      inputOpen: this.#input !== null,
      visibleCount: this.#messages.size,
      reducedMotion: this.#reducedMotion(),
    };
  }

  public clear(): void {
    for (const message of this.#messages.values()) {
      this.#scheduler.clearTimeout(message.expiryTimer);
    }
    this.#messages.clear();
    this.#engine.clear();
    this.#engine.hide();
    this.#staticList.replaceChildren();
    this.#refreshSurface();
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#window.removeEventListener("resize", this.#resizeListener);
    this.closeInput();
    this.clear();
    this.#engine.destroy();
    this.#style.remove();
    this.#root.remove();
    this.#setInteraction({ active: false, capturesInput: false });
  }

  #emitStateReport(): void {
    if (this.#disposed) {
      return;
    }
    const report = {
      hidden: this.#hidden,
      inputOpen: this.#input !== null,
    };
    const signature = JSON.stringify(report);
    if (signature === this.#lastReportSignature) {
      return;
    }
    this.#lastReportSignature = signature;
    void Promise.resolve(this.#reportState?.(report)).catch(() => undefined);
  }

  #submitInput(): void {
    const input = this.#input;
    if (input === null || this.#pendingMessageId !== null) {
      return;
    }
    const text = DanmakuTextSchema.safeParse(input.value);
    if (!text.success) {
      input.dataset.status = "failed";
      this.#setStatusText("弹幕不能为空且最多 120 个字符");
      return;
    }
    const messageId = this.#createMessageId();
    const submission: DanmakuSubmission = {
      context: structuredClone(this.#context),
      messageId,
      text: text.data,
    };
    this.#pendingMessageId = messageId;
    this.#pendingText = input.value;
    input.dataset.status = "sending";
    this.#setStatusText("发送中");
    void Promise.resolve(this.#emitSubmit(submission)).catch(() => {
      this.setStatus({
        status: "FAILED",
        messageId,
        errorCode: "DANMAKU_OFFLINE",
      });
    });
  }

  #expire(messageId: string): void {
    const message = this.#messages.get(messageId);
    if (message === undefined) {
      return;
    }
    const remaining = message.event.expiresAtServerMs - this.#now();
    if (remaining > 0) {
      message.expiryTimer = this.#scheduler.setTimeout(() => this.#expire(messageId), remaining);
      return;
    }
    this.#deleteRecord(messageId);
    this.#renderAll();
    this.#refreshSurface();
  }

  #deleteRecord(messageId: string): void {
    const message = this.#messages.get(messageId);
    if (message === undefined) {
      return;
    }
    this.#scheduler.clearTimeout(message.expiryTimer);
    this.#messages.delete(messageId);
  }

  #renderAll(): void {
    this.#engine.clear();
    this.#staticList.replaceChildren();
    if (this.#hidden || this.#messages.size === 0) {
      this.#engine.hide();
      return;
    }
    for (const message of this.#messages.values()) {
      this.#renderOne(message.event);
    }
  }

  #renderOne(event: DanmakuEventMessage): void {
    if (this.#hidden) {
      this.#engine.hide();
      return;
    }
    if (this.#reducedMotion()) {
      this.#engine.hide();
      const item = this.#document.createElement("li");
      item.dataset.syncactionDanmakuMessage = event.messageId;
      item.textContent = `${event.sender.displayName}：${event.text}`;
      this.#staticList.append(item);
      return;
    }
    this.#engine.show();
    this.#engine.emit({
      mode: "rtl",
      render: () => {
        const message = this.#document.createElement("span");
        message.dataset.syncactionDanmakuMessage = event.messageId;
        message.textContent = event.text;
        message.setAttribute("aria-label", `${event.sender.displayName}：${event.text}`);
        return message;
      },
    });
  }

  #setStatusText(text: string): void {
    if (this.#status !== null) {
      this.#status.textContent = text;
    }
  }

  #refreshSurface(): void {
    const hasVisibleMessages = !this.#hidden && this.#messages.size > 0;
    const active = hasVisibleMessages || this.#input !== null;
    this.#setInteraction({
      active,
      capturesInput: this.#input !== null,
    });
  }
}

export function createDanmakuRenderingEngine(
  container: HTMLElement,
  DanmakuConstructor: typeof Danmaku,
): DanmakuRenderingEngine {
  const engine = new DanmakuConstructor({
    container,
    speed: Math.max(48, container.clientWidth / 9),
  });
  return {
    emit: (comment) => {
      engine.emit(comment);
    },
    clear: () => {
      engine.clear();
    },
    resize: () => {
      engine.resize();
    },
    show: () => {
      engine.show();
    },
    hide: () => {
      engine.hide();
    },
    destroy: () => {
      engine.destroy();
    },
  };
}

function browserScheduler(window: Window): DanmakuPageScheduler {
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

function eventMatchesContext(
  event: DanmakuEventMessage,
  context: CollaborationPageContext,
): boolean {
  return (
    event.roomId === context.roomId &&
    event.logicalTabId === context.logicalTabId &&
    event.documentRevision.roomEpoch === context.documentRevision.roomEpoch &&
    event.documentRevision.tabUpdatedAtSeq === context.documentRevision.tabUpdatedAtSeq &&
    event.frameKey === context.frameKey
  );
}

function sameContext(left: CollaborationPageContext, right: CollaborationPageContext): boolean {
  return (
    left.roomId === right.roomId &&
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey
  );
}

const DANMAKU_STYLES = `
  :host, .syncaction-danmaku-root, .syncaction-danmaku-root * {
    box-sizing: border-box;
  }
  .syncaction-danmaku-root {
    position: fixed;
    inset: 0;
    overflow: hidden;
    color: white;
    pointer-events: none;
    font: 500 15px/1.4 ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .syncaction-danmaku-moving {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  [data-syncaction-danmaku-message] {
    max-width: min(72vw, 720px);
    overflow: hidden;
    padding: 4px 10px;
    border: 1px solid rgb(255 255 255 / 24%);
    border-radius: 999px;
    color: white;
    background: rgb(10 14 24 / 68%);
    box-shadow: 0 3px 18px rgb(0 0 0 / 20%);
    font: 600 15px/1.35 ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    text-overflow: ellipsis;
    text-shadow: 0 1px 2px rgb(0 0 0 / 72%);
    white-space: nowrap;
  }
  .syncaction-danmaku-static {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    width: min(420px, calc(100vw - 24px));
    max-height: 45vh;
    gap: 6px;
    margin: 0;
    overflow: hidden;
    padding: 0;
    list-style: none;
    pointer-events: none;
  }
  .syncaction-danmaku-static:empty {
    display: none;
  }
  .syncaction-danmaku-static li {
    overflow: hidden;
    padding: 6px 10px;
    border: 1px solid rgb(255 255 255 / 20%);
    border-radius: 10px;
    background: rgb(16 20 30 / 82%);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .syncaction-danmaku-input-bar {
    position: absolute;
    left: 50%;
    bottom: max(20px, env(safe-area-inset-bottom));
    display: grid;
    width: min(720px, calc(100vw - 32px));
    gap: 5px;
    padding: 10px;
    border: 1px solid rgb(255 255 255 / 18%);
    border-radius: 18px;
    background: rgb(20 24 34 / 88%);
    box-shadow: 0 14px 44px rgb(0 0 0 / 24%);
    pointer-events: auto;
    transform: translateX(-50%);
    backdrop-filter: blur(20px) saturate(1.2);
  }
  .syncaction-danmaku-input-bar input {
    all: unset;
    min-height: 24px;
    padding: 7px 10px;
    border: 1px solid rgb(255 255 255 / 22%);
    border-radius: 11px;
    color: white;
    background: rgb(255 255 255 / 9%);
    caret-color: white;
    font: 500 15px/1.4 ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .syncaction-danmaku-input-bar input:focus-visible {
    outline: 3px solid rgb(91 156 255 / 72%);
    outline-offset: 2px;
  }
  .syncaction-danmaku-input-bar input[data-status="failed"] {
    border-color: rgb(255 107 120 / 84%);
  }
  .syncaction-danmaku-status {
    min-height: 16px;
    margin: 0 4px;
    color: rgb(237 241 250 / 82%);
    font: 500 11px/1.35 ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  @media (prefers-reduced-transparency: reduce) {
    .syncaction-danmaku-input-bar,
    .syncaction-danmaku-static li,
    [data-syncaction-danmaku-message] {
      background: rgb(20 24 34);
      backdrop-filter: none;
    }
  }
  @media (forced-colors: active) {
    .syncaction-danmaku-input-bar,
    .syncaction-danmaku-input-bar input,
    .syncaction-danmaku-static li,
    [data-syncaction-danmaku-message] {
      border: 1px solid CanvasText;
      color: CanvasText;
      background: Canvas;
    }
  }
`;
