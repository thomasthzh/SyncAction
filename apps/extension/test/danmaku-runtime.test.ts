// @vitest-environment happy-dom

import {
  DanmakuEventMessageSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type DanmakuEventMessage,
} from "@syncaction/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDanmakuRenderingEngine,
  DanmakuPageRuntime,
  type DanmakuPageScheduler,
  type DanmakuRenderingComment,
  type DanmakuRenderingEngine,
} from "../src/page-collaboration/danmaku-runtime.js";
import type { CollaborationPageContext } from "../src/page-collaboration/messages.js";
import {
  PAGE_OVERLAY_HOST_ATTRIBUTE,
  PageOverlayHost,
} from "../src/page-collaboration/page-overlay-host.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a02");
const userId = "018f8f8e-4b5c-7d6e-8f90-723456789a03";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a04");
const context: CollaborationPageContext = {
  roomId,
  logicalTabId,
  documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 8 },
  frameKey: "top",
};
const mountedHosts: PageOverlayHost[] = [];

beforeEach(() => {
  document.querySelectorAll(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`).forEach((node) => node.remove());
  document.body.replaceChildren();
});

afterEach(() => {
  for (const host of mountedHosts.splice(0)) {
    host.dispose("BACKGROUND_STOPPED");
  }
  vi.restoreAllMocks();
});

describe("DanmakuPageRuntime", () => {
  it("adapts the pinned local Danmaku constructor without exposing library authority", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const library = new FakeDanmakuLibrary();
    const Constructor = class {
      public constructor(options: { container: HTMLElement; speed?: number }) {
        library.options = options;
      }

      public emit() {
        library.calls.push("emit");
        return this;
      }

      public clear() {
        library.calls.push("clear");
        return this;
      }

      public resize() {
        library.calls.push("resize");
        return this;
      }

      public show() {
        library.calls.push("show");
        return this;
      }

      public hide() {
        library.calls.push("hide");
        return this;
      }

      public destroy() {
        library.calls.push("destroy");
        return this;
      }
    };
    const engine = createDanmakuRenderingEngine(
      container,
      Constructor as unknown as Parameters<typeof createDanmakuRenderingEngine>[1],
    );

    engine.emit({ mode: "rtl", render: () => document.createElement("span") });
    engine.clear();
    engine.resize();
    engine.show();
    engine.hide();
    engine.destroy();

    expect(library.options?.container).toBe(container);
    expect(library.options?.speed).toBeGreaterThanOrEqual(48);
    expect(library.calls).toEqual(["emit", "clear", "resize", "show", "hide", "destroy"]);
  });

  it("owns one bottom input, sends on Enter, closes on Escape, and preserves failed text", async () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, "focus");
    const harness = createHarness();
    harness.runtime.handleCommand("OPEN_INPUT");
    harness.runtime.handleCommand("OPEN_INPUT");
    const input = requireInput(harness.surface);

    expect(harness.surface.querySelectorAll("input")).toHaveLength(1);
    expect(focus).toHaveBeenCalled();
    input.value = "发送失败后保留";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();

    expect(harness.submissions).toEqual([
      {
        context,
        messageId: "018f8f8e-4b5c-7d6e-8f90-723456789a10",
        text: "发送失败后保留",
      },
    ]);
    expect(input.value).toBe("发送失败后保留");
    expect(input.dataset.status).toBe("sending");

    harness.runtime.setStatus({
      status: "FAILED",
      messageId: "018f8f8e-4b5c-7d6e-8f90-723456789a10",
      errorCode: "DANMAKU_OFFLINE",
    });
    expect(input.value).toBe("发送失败后保留");
    expect(input.dataset.status).toBe("failed");
    expect(harness.surface.textContent).toContain("DANMAKU_OFFLINE");

    expect(harness.submissions).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(harness.submissions).toEqual([
      {
        context,
        messageId: "018f8f8e-4b5c-7d6e-8f90-723456789a10",
        text: "发送失败后保留",
      },
      {
        context,
        messageId: "018f8f8e-4b5c-7d6e-8f90-723456789a11",
        text: "发送失败后保留",
      },
    ]);
    expect(input.dataset.status).toBe("sending");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(harness.runtime.getState().inputOpen).toBe(false);
    expect(harness.surface.querySelector("input")).toBeNull();
    harness.dispose();
    focus.mockRestore();
  });

  it("renders text literally, caps visible messages at 30, removes at nine seconds, and reuses one lane engine", () => {
    const harness = createHarness();
    for (let index = 0; index < 31; index += 1) {
      harness.runtime.render(
        event(index, index === 30 ? "<img src=x onerror=alert(1)>" : `消息${index}`),
      );
    }

    expect(harness.runtime.getVisibleMessageIds()).toHaveLength(30);
    expect(harness.runtime.getVisibleMessageIds()).not.toContain(messageId(0));
    expect(harness.surface.querySelector("img")).toBeNull();
    expect(harness.surface.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(harness.engines).toHaveLength(1);
    expect(harness.engines[0]!.comments).toHaveLength(30);

    harness.runtime.handleResize();
    expect(harness.engines[0]!.resizeCalls).toBe(1);
    expect(harness.engines).toHaveLength(1);

    harness.scheduler.advanceTo(1_785_160_009_000);
    expect(harness.runtime.getVisibleMessageIds()).toEqual([]);
    expect(harness.engines[0]!.comments).toEqual([]);
    harness.dispose();
  });

  it("supports a room-scoped hidden state without disabling the input", () => {
    const harness = createHarness();
    harness.runtime.setHidden(true);
    harness.runtime.render(event(0));

    expect(harness.runtime.getState()).toMatchObject({ hidden: true, visibleCount: 1 });
    expect(harness.engines[0]!.hideCalls).toBeGreaterThan(0);
    expect(harness.surface.querySelector("[data-syncaction-danmaku-message]")).toBeNull();

    harness.runtime.handleCommand("TOGGLE_INPUT");
    expect(requireInput(harness.surface)).toBeInstanceOf(HTMLInputElement);
    harness.runtime.setHidden(false);
    expect(harness.engines[0]!.showCalls).toBeGreaterThan(0);
    expect(harness.surface.textContent).toContain("消息0");
    harness.dispose();
  });

  it("reports hidden and input state changes for the side panel", () => {
    const harness = createHarness();

    harness.runtime.setHidden(true);
    harness.runtime.handleCommand("OPEN_INPUT");
    harness.runtime.handleCommand("CLOSE_INPUT");

    expect(harness.reports).toEqual([
      { hidden: false, inputOpen: false },
      { hidden: true, inputOpen: false },
      { hidden: true, inputOpen: true },
      { hidden: true, inputOpen: false },
    ]);
    harness.dispose();
  });

  it("uses a static accessible list under reduced motion and remains isolated from host-page CSS", () => {
    const pageStyle = document.createElement("style");
    pageStyle.textContent = "input, li { display:none !important; color: transparent !important; }";
    document.head.append(pageStyle);
    const host = new PageOverlayHost({ document });
    mountedHosts.push(host);
    const scheduler = new FakeScheduler();
    const engine = new FakeDanmakuEngine(document);
    const runtime = new DanmakuPageRuntime({
      document,
      window,
      surface: host.getSurface("danmaku"),
      context,
      scheduler,
      now: () => scheduler.now,
      reducedMotion: () => true,
      createMessageId: () => "018f8f8e-4b5c-7d6e-8f90-723456789a11",
      createEngine: (container) => {
        engine.attach(container);
        return engine;
      },
      emitSubmit: vi.fn(),
    });

    runtime.render(event(0));
    runtime.render(event(1));
    runtime.handleCommand("OPEN_INPUT");

    const list = host.getSurface("danmaku").querySelector('[role="log"]');
    expect(list?.children).toHaveLength(2);
    expect(list?.textContent).toContain("消息0");
    expect(engine.comments).toEqual([]);
    expect(requireInput(host.getSurface("danmaku")).hidden).toBe(false);
    expect(host.getSurface("danmaku").querySelector("style")?.textContent).toContain(
      ":focus-visible",
    );
    runtime.dispose();
    host.dispose("BACKGROUND_STOPPED");
    pageStyle.remove();
  });

  it("clears old-document messages and ignores expired or mismatched events", () => {
    const harness = createHarness();
    harness.runtime.render(event(0));
    harness.runtime.render({
      ...event(1),
      logicalTabId: LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789aff"),
    });
    harness.runtime.render({ ...event(2), expiresAtServerMs: harness.scheduler.now - 1 });
    expect(harness.runtime.getVisibleMessageIds()).toEqual([messageId(0)]);

    harness.runtime.setContext({
      ...context,
      documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 9 },
    });
    expect(harness.runtime.getVisibleMessageIds()).toEqual([]);
    harness.dispose();
  });
});

function createHarness() {
  const host = new PageOverlayHost({ document });
  mountedHosts.push(host);
  const surface = host.getSurface("danmaku");
  const scheduler = new FakeScheduler();
  const engines: FakeDanmakuEngine[] = [];
  const submissions: Array<{
    context: CollaborationPageContext;
    messageId: string;
    text: string;
  }> = [];
  const reports: Array<{ hidden: boolean; inputOpen: boolean }> = [];
  let nextId = 0x10;
  const runtime = new DanmakuPageRuntime({
    document,
    window,
    surface,
    context,
    scheduler,
    now: () => scheduler.now,
    reducedMotion: () => false,
    createMessageId: () => messageId(nextId++),
    createEngine: (container) => {
      const engine = new FakeDanmakuEngine(container.ownerDocument);
      engine.attach(container);
      engines.push(engine);
      return engine;
    },
    emitSubmit: (submission) => {
      submissions.push(structuredClone(submission));
    },
    reportState: (state) => {
      reports.push(structuredClone(state));
    },
  });
  return {
    host,
    surface,
    scheduler,
    engines,
    submissions,
    reports,
    runtime,
    dispose: () => {
      runtime.dispose();
      host.dispose("BACKGROUND_STOPPED");
    },
  };
}

class FakeScheduler implements DanmakuPageScheduler {
  public now = 1_785_160_000_000;
  readonly #timers = new Map<number, { callback: () => void; at: number }>();
  #nextId = 1;

  public setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { callback, at: this.now + delayMs });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  public advanceTo(now: number): void {
    this.now = now;
    let due = [...this.#timers.entries()]
      .filter(([, timer]) => timer.at <= now)
      .sort((left, right) => left[1].at - right[1].at);
    while (due.length > 0) {
      for (const [id, timer] of due) {
        this.#timers.delete(id);
        timer.callback();
      }
      due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
    }
  }
}

class FakeDanmakuEngine implements DanmakuRenderingEngine {
  public comments: DanmakuRenderingComment[] = [];
  public resizeCalls = 0;
  public showCalls = 0;
  public hideCalls = 0;
  public destroyed = false;
  readonly #document: Document;
  readonly #stage: HTMLDivElement;

  public constructor(document: Document) {
    this.#document = document;
    this.#stage = document.createElement("div");
    this.#stage.dataset.fakeDanmakuStage = "";
  }

  public attach(container: HTMLElement): void {
    if (!this.#stage.isConnected) {
      container.append(this.#stage);
    }
  }

  public emit(comment: DanmakuRenderingComment): void {
    this.comments.push(comment);
    const wrapper = this.#document.createElement("div");
    wrapper.append(comment.render());
    this.#stage.append(wrapper);
  }

  public clear(): void {
    this.comments = [];
    this.#stage.replaceChildren();
  }

  public resize(): void {
    this.resizeCalls += 1;
  }

  public show(): void {
    this.showCalls += 1;
    this.#stage.hidden = false;
  }

  public hide(): void {
    this.hideCalls += 1;
    this.#stage.hidden = true;
  }

  public destroy(): void {
    this.destroyed = true;
    this.#stage.remove();
  }
}

class FakeDanmakuLibrary {
  public options: { container: HTMLElement; speed?: number } | undefined;
  public readonly calls: string[] = [];
}

function event(index: number, text = `消息${index}`): DanmakuEventMessage {
  return DanmakuEventMessageSchema.parse({
    type: "danmaku.event",
    protocolVersion: 1,
    messageId: messageId(index),
    ...context,
    sender: {
      userId,
      username: "remote",
      displayName: "Remote",
      deviceId,
    },
    text,
    sentAtServerMs: 1_785_160_000_000,
    expiresAtServerMs: 1_785_160_009_000,
  });
}

function messageId(index: number): string {
  return `018f8f8e-4b5c-7d6e-8f90-723456789a${index.toString(16).padStart(2, "0")}`;
}

function requireInput(surface: HTMLElement): HTMLInputElement {
  const input = surface.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("DANMAKU_INPUT_NOT_FOUND");
  }
  return input;
}
