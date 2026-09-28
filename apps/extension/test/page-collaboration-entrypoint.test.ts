// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_OVERLAY_HOST_ATTRIBUTE } from "../src/page-collaboration/page-overlay-host.js";

const browserHarness = vi.hoisted(() => {
  const listeners = new Set<(message: unknown) => unknown | Promise<unknown>>();
  return {
    listeners,
    sendMessage: vi.fn(async (message: unknown) => {
      void message;
    }),
    addListener: vi.fn((listener: (message: unknown) => unknown | Promise<unknown>) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (message: unknown) => unknown | Promise<unknown>) => {
      listeners.delete(listener);
    }),
  };
});

const renderingDependencies = vi.hoisted(() => ({
  loadDanmaku: vi.fn<() => Promise<unknown>>(() => new Promise<never>(() => undefined)),
  loadDrawing: vi.fn<() => Promise<unknown>>(() => new Promise<never>(() => undefined)),
}));

const compatibilityReporterHarness = vi.hoisted(() => ({
  computeElement: vi.fn(),
  instances: [] as Array<{
    emit: (report: unknown) => void | Promise<void>;
    setContext: ReturnType<typeof vi.fn>;
    setMedia: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: browserHarness.sendMessage,
      onMessage: {
        addListener: browserHarness.addListener,
        removeListener: browserHarness.removeListener,
      },
    },
  },
}));

vi.mock("wxt/utils/define-unlisted-script", () => ({
  defineUnlistedScript: (main: () => void) => main,
}));

vi.mock("../src/page-collaboration/rendering-dependencies.js", () => ({
  loadDanmakuRenderingDependency: renderingDependencies.loadDanmaku,
  loadDrawingRenderingDependency: renderingDependencies.loadDrawing,
}));

vi.mock("../src/page-collaboration/content-signature.js", () => ({
  computeElementContentSignature: compatibilityReporterHarness.computeElement,
  PageContentCompatibilityReporter: class {
    public readonly setContext = vi.fn(async () => undefined);
    public readonly setMedia = vi.fn(async () => undefined);
    public readonly dispose = vi.fn();

    public constructor(options: { emit: (report: unknown) => void | Promise<void> }) {
      compatibilityReporterHarness.instances.push({
        emit: options.emit,
        setContext: this.setContext,
        setMedia: this.setMedia,
        dispose: this.dispose,
      });
    }
  },
}));

import pageCollaborationEntrypoint from "../entrypoints/page-collaboration.js";

const context = {
  roomId: "018f8f8e-4b5c-4d6e-8f90-123456789a01",
  logicalTabId: "018f8f8e-4b5c-4d6e-8f90-123456789a02",
  documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 4 },
  frameKey: "top" as const,
};

beforeEach(() => {
  browserHarness.sendMessage.mockReset();
  browserHarness.sendMessage.mockResolvedValue(undefined);
  browserHarness.addListener.mockClear();
  browserHarness.removeListener.mockClear();
  renderingDependencies.loadDanmaku.mockClear();
  renderingDependencies.loadDrawing.mockClear();
  compatibilityReporterHarness.instances.length = 0;
  compatibilityReporterHarness.computeElement.mockReset();
  compatibilityReporterHarness.computeElement.mockResolvedValue({
    signatureVersion: 1,
    digest: "E".repeat(43),
  });
  document.body.replaceChildren();
  document.querySelectorAll(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`).forEach((node) => node.remove());
});

afterEach(() => {
  dispatch({
    type: "syncaction.page.dispose",
    reason: "BACKGROUND_STOPPED",
  });
  browserHarness.listeners.clear();
  document.querySelectorAll(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`).forEach((node) => node.remove());
});

describe("page collaboration media bridge", () => {
  it("binds one top-frame compatibility reporter to page context, media, and cleanup", async () => {
    (pageCollaborationEntrypoint as unknown as () => void)();

    dispatch({
      type: "syncaction.pointer.context",
      context: {
        roomId: context.roomId,
        logicalTabId: context.logicalTabId,
        documentRevision: context.documentRevision,
      },
    });
    const reporter = compatibilityReporterHarness.instances[0];
    expect(reporter).toBeDefined();
    await vi.waitFor(() =>
      expect(reporter?.setContext).toHaveBeenCalledWith({
        logicalTabId: context.logicalTabId,
        documentRevision: context.documentRevision,
      }),
    );

    await reporter?.emit({
      type: "page.compatibility.report",
      protocolVersion: 1,
      logicalTabId: context.logicalTabId,
      contentContext: {
        documentRevision: context.documentRevision,
        canonicalPageIdentity: "url:https://example.com/article",
        contentSignature: {
          signatureVersion: 1,
          digest: "A".repeat(43),
        },
        media: null,
      },
    });
    expect(browserHarness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "page.compatibility.report" }),
    );

    dispatch({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    await vi.waitFor(() => expect(reporter?.setMedia).toHaveBeenCalledWith(null));

    dispatch({
      type: "syncaction.page.dispose",
      reason: "ORIGIN_REVOKED",
    });
    expect(reporter?.dispose).toHaveBeenCalledOnce();
  });

  it("re-announces ready and capability to a restarted background worker", async () => {
    (pageCollaborationEntrypoint as unknown as () => void)();
    browserHarness.sendMessage.mockClear();

    dispatch({ type: "syncaction.page.announce" });

    await vi.waitFor(() =>
      expect(browserHarness.sendMessage.mock.calls.map(([message]) => message)).toEqual([
        { type: "syncaction.page.ready" },
        {
          type: "syncaction.page.capability",
          capability: "PAGE_HOST",
          state: "AVAILABLE",
          errorCode: null,
        },
      ]),
    );
  });

  it("does not load absent tool runtimes merely to clear them", () => {
    (pageCollaborationEntrypoint as unknown as () => void)();

    dispatch({
      type: "syncaction.danmaku.clear",
      controller: "danmaku",
      context,
    });
    dispatch({
      type: "syncaction.drawing.clear",
      controller: "drawing",
      context,
    });

    expect(renderingDependencies.loadDanmaku).not.toHaveBeenCalled();
    expect(renderingDependencies.loadDrawing).not.toHaveBeenCalled();
  });

  it("ignores a stale tool clear after another controller advances the document revision", () => {
    const removeListener = vi.spyOn(document, "removeEventListener");
    (pageCollaborationEntrypoint as unknown as () => void)();
    dispatch({
      type: "syncaction.pointer.context",
      context: {
        roomId: context.roomId,
        logicalTabId: context.logicalTabId,
        documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 5 },
      },
    });
    removeListener.mockClear();

    dispatch({
      type: "syncaction.danmaku.clear",
      controller: "danmaku",
      context,
    });

    expect(removeListener.mock.calls.some(([eventName]) => eventName === "pointermove")).toBe(
      false,
    );
    removeListener.mockRestore();
  });

  it("ignores a stale non-clear tool message after another controller advances the revision", () => {
    const removeListener = vi.spyOn(document, "removeEventListener");
    (pageCollaborationEntrypoint as unknown as () => void)();
    dispatch({
      type: "syncaction.pointer.context",
      context: {
        roomId: context.roomId,
        logicalTabId: context.logicalTabId,
        documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 5 },
      },
    });
    removeListener.mockClear();

    dispatch({
      type: "syncaction.danmaku.status",
      controller: "danmaku",
      context,
      status: "FAILED",
      messageId: null,
      errorCode: "DANMAKU_OFFLINE",
    });

    expect(removeListener.mock.calls.some(([eventName]) => eventName === "pointermove")).toBe(
      false,
    );
    expect(renderingDependencies.loadDanmaku).not.toHaveBeenCalled();
    removeListener.mockRestore();
  });

  it("activates the drawing surface only in the document that directly owns focus", async () => {
    const attachShadow = vi.spyOn(HTMLElement.prototype, "attachShadow");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderingDependencies.loadDrawing.mockImplementationOnce(async () => vi.fn(() => []));
    (pageCollaborationEntrypoint as unknown as () => void)();

    const [firstResult] = await dispatchAndWait({
      type: "syncaction.drawing.command",
      controller: "drawing",
      context,
      action: { type: "TOGGLE_PEN" },
    });
    await vi.waitFor(() => expect(renderingDependencies.loadDrawing).toHaveBeenCalledOnce());
    expect(firstResult).toEqual({
      type: "syncaction.page.capability",
      capability: "DRAWING",
      state: "AVAILABLE",
      errorCode: null,
    });
    expect(
      browserHarness.sendMessage.mock.calls.some(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "capability" in message &&
          message.capability === "DRAWING",
      ),
    ).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const shadow = attachShadow.mock.results[0]?.value as ShadowRoot;
    const drawingSurface = shadow.querySelector<HTMLElement>('[data-surface="drawing"]');
    expect(drawingSurface?.dataset.active).toBe("false");

    hasFocus.mockReturnValue(true);
    dispatch({
      type: "syncaction.drawing.command",
      controller: "drawing",
      context,
      action: { type: "TOGGLE_PEN" },
    });
    await vi.waitFor(() => expect(drawingSurface?.dataset.active).toBe("true"));

    hasFocus.mockRestore();
    attachShadow.mockRestore();
  });

  it("returns a room-scoped signature for an element resolved in the exact document", async () => {
    const target = document.createElement("main");
    document.body.append(target);
    (pageCollaborationEntrypoint as unknown as () => void)();

    const [response] = await dispatchAndWait({
      type: "syncaction.annotation.anchor-signature.request",
      controller: "drawing",
      context,
      path: [
        { tagName: "html", nthOfType: 1 },
        { tagName: "body", nthOfType: 1 },
        { tagName: "main", nthOfType: 1 },
      ],
    });

    expect(response).toEqual({
      type: "syncaction.annotation.anchor-signature.response",
      signature: {
        signatureVersion: 1,
        digest: "E".repeat(43),
      },
    });
    expect(compatibilityReporterHarness.computeElement).toHaveBeenCalledWith({
      element: target,
      roomId: context.roomId,
      viewport: {
        widthCssPx: window.innerWidth,
        heightCssPx: window.innerHeight,
      },
    });
  });

  it("returns runtime-load degradation without a reentrant background message", async () => {
    renderingDependencies.loadDrawing.mockRejectedValueOnce(new Error("chunk unavailable"));
    (pageCollaborationEntrypoint as unknown as () => void)();

    const [result] = await dispatchAndWait({
      type: "syncaction.drawing.state",
      controller: "drawing",
      context,
      active: false,
      tool: "PEN",
      rgb: { r: 0, g: 122, b: 255 },
      width: 6,
    });

    expect(result).toEqual({
      type: "syncaction.page.capability",
      capability: "DRAWING",
      state: "DEGRADED",
      errorCode: "DRAWING_RUNTIME_LOAD_FAILED",
    });
    expect(browserHarness.sendMessage.mock.calls.map(([message]) => message)).not.toContainEqual(
      result,
    );
  });

  it("settles the response-carried tool handshake even when nested capability messages block", async () => {
    renderingDependencies.loadDrawing.mockImplementationOnce(async () => vi.fn(() => []));
    browserHarness.sendMessage.mockImplementation(async (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "capability" in message &&
        message.capability === "DRAWING"
      ) {
        return new Promise<never>(() => undefined);
      }
    });
    (pageCollaborationEntrypoint as unknown as () => void)();

    const result = await Promise.race([
      dispatchAndWait({
        type: "syncaction.drawing.state",
        controller: "drawing",
        context,
        active: false,
        tool: "PEN",
        rgb: { r: 0, g: 122, b: 255 },
        width: 6,
      }),
      new Promise<"DEADLOCK">((resolve) => setTimeout(() => resolve("DEADLOCK"), 50)),
    ]);

    expect(result).toEqual([
      {
        type: "syncaction.page.capability",
        capability: "DRAWING",
        state: "AVAILABLE",
        errorCode: null,
      },
    ]);
  });

  it("routes one strict media command through the existing unified page host", async () => {
    const video = document.createElement("video");
    Object.defineProperties(video, {
      duration: { configurable: true, get: () => 212 },
      currentTime: { configurable: true, writable: true, value: 42 },
      paused: { configurable: true, get: () => true },
      playbackRate: { configurable: true, writable: true, value: 1 },
      readyState: { configurable: true, get: () => 4 },
      ended: { configurable: true, get: () => false },
      mediaKeys: { configurable: true, get: () => null },
      play: { configurable: true, value: vi.fn(async () => undefined) },
      pause: { configurable: true, value: vi.fn() },
    });
    video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    document.body.append(video);

    (pageCollaborationEntrypoint as unknown as () => void)();
    expect(document.querySelectorAll(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`)).toHaveLength(1);

    dispatch({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });

    await vi.waitFor(() => {
      expect(
        browserHarness.sendMessage.mock.calls
          .map(([message]) => message)
          .find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "syncaction.media.observed",
          ),
      ).toMatchObject({
        event: "DISCOVERED",
        context,
        target: {
          logicalTabId: context.logicalTabId,
          documentRevision: context.documentRevision,
          frameKey: "top",
          provider: "HTML5",
          durationMs: 212_000,
        },
        applyToken: null,
        resultCode: null,
      });
    });

    expect(
      browserHarness.sendMessage.mock.calls.some(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "capability" in message &&
          message.capability === "MEDIA",
      ),
    ).toBe(true);
  });

  it("correlates a programmatic media event with the apply token", async () => {
    const video = document.createElement("video");
    let paused = true;
    Object.defineProperties(video, {
      duration: { configurable: true, get: () => 100 },
      currentTime: { configurable: true, writable: true, value: 10 },
      paused: { configurable: true, get: () => paused },
      playbackRate: { configurable: true, writable: true, value: 1 },
      readyState: { configurable: true, get: () => 4 },
      ended: { configurable: true, get: () => false },
      mediaKeys: { configurable: true, get: () => null },
      play: {
        configurable: true,
        value: vi.fn(async () => {
          paused = false;
          video.dispatchEvent(new Event("play"));
        }),
      },
      pause: { configurable: true, value: vi.fn() },
    });
    video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    document.body.append(video);

    (pageCollaborationEntrypoint as unknown as () => void)();
    dispatch({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discovery = browserHarness.sendMessage.mock.calls
      .map(([message]) => message)
      .find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "syncaction.media.observed" &&
          "event" in message &&
          message.event === "DISCOVERED",
      );
    if (
      typeof discovery !== "object" ||
      discovery === null ||
      !("target" in discovery) ||
      discovery.target === null
    ) {
      throw new Error("expected media discovery");
    }

    const applyToken = "00000000-0000-4000-8000-000000000003";
    browserHarness.sendMessage.mockClear();
    dispatch({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discovery.target,
        action: { type: "PLAY" },
      },
    });

    await vi.waitFor(() => {
      expect(
        browserHarness.sendMessage.mock.calls
          .map(([message]) => message)
          .find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "event" in message &&
              message.event === "STATE_CHANGED",
          ),
      ).toMatchObject({
        context,
        applyToken,
        resultCode: null,
      });
    });
  });
});

function dispatch(message: unknown): void {
  for (const listener of [...browserHarness.listeners]) {
    void listener(message);
  }
}

async function dispatchAndWait(message: unknown): Promise<unknown[]> {
  return Promise.all([...browserHarness.listeners].map((listener) => listener(message)));
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  };
}
