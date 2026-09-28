// @vitest-environment happy-dom

import {
  AnnotationCommittedOperationSchema,
  AnnotationStrokeSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  StrokePreviewEventMessageSchema,
  type AnnotationStroke,
  type AnnotationStrokeDraft,
  type StrokePreviewUpdate,
} from "@syncaction/protocol";
import { getStroke } from "perfect-freehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DrawingPageRuntime,
  resampleDrawingPoints,
  type DrawingPageScheduler,
  type DrawingPointerSample,
  type DrawingSelectionIntent,
} from "../src/page-collaboration/drawing-runtime.js";
import type { CollaborationPageContext } from "../src/page-collaboration/messages.js";
import {
  PAGE_OVERLAY_HOST_ATTRIBUTE,
  PageOverlayHost,
} from "../src/page-collaboration/page-overlay-host.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-823456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-823456789a02");
const currentUserId = "018f8f8e-4b5c-7d6e-8f90-823456789a03";
const otherUserId = "018f8f8e-4b5c-7d6e-8f90-823456789a04";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-823456789a05");
const context: CollaborationPageContext = {
  roomId,
  logicalTabId,
  documentRevision: { roomEpoch: 3, tabUpdatedAtSeq: 7 },
  frameKey: "top",
};
const mountedHosts: PageOverlayHost[] = [];

beforeEach(() => {
  document.querySelectorAll(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`).forEach((node) => node.remove());
  document.body.replaceChildren();
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

afterEach(() => {
  for (const host of mountedHosts.splice(0)) {
    host.dispose("BACKGROUND_STOPPED");
  }
});

describe("drawing geometry", () => {
  it("resamples deterministically within protocol bounds while preserving endpoints and pressure", () => {
    const points = Array.from({ length: 4_096 }, (_, index) => ({
      x: index / 4_095,
      y: (index % 31) / 30,
      pressure: index / 4_095,
    }));

    const resampled = resampleDrawingPoints(points, 2_048);

    expect(resampled).toHaveLength(2_048);
    expect(resampled[0]).toEqual(points[0]);
    expect(resampled.at(-1)).toEqual(points.at(-1));
    expect(resampled.every((point) => point.pressure >= 0 && point.pressure <= 1)).toBe(true);
  });
});

describe("DrawingPageRuntime", () => {
  it("samples a stroke, emits bounded previews/final geometry, and renders pending/error outlines", () => {
    const harness = createHarness();
    harness.runtime.handleCommand({
      type: "SET_STYLE",
      rgb: { r: 12, g: 34, b: 56 },
      width: 32,
    });
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });
    expect(harness.runtime.getState()).toMatchObject({
      active: true,
      tool: "PEN",
      rgb: { r: 12, g: 34, b: 56 },
      width: 32,
    });
    expect(harness.surface.style.pointerEvents).toBe("auto");

    harness.runtime.beginStroke(pointer(1, 100, 100, 0.2, harness.target));
    for (let index = 1; index < 2_600; index += 1) {
      harness.runtime.continueStroke(
        pointer(1, 100 + (700 * index) / 2_599, 100 + (300 * index) / 2_599, 0.7),
      );
    }
    harness.runtime.endStroke(pointer(1, 800, 400, 0.8));

    expect(harness.previews.length).toBeGreaterThan(0);
    expect(harness.previews.every((preview) => preview.points.length <= 512)).toBe(true);
    expect(harness.finals).toHaveLength(1);
    expect(harness.finals[0]).toMatchObject({
      strokeId: strokeId(0),
      frameKey: "top",
      rgb: { r: 12, g: 34, b: 56 },
      width: 32,
      anchor: {
        type: "element",
        path: [
          { tagName: "html", nthOfType: 1 },
          { tagName: "body", nthOfType: 1 },
          { tagName: "main", nthOfType: 1 },
        ],
      },
    });
    expect(harness.finals[0]!.points.length).toBeLessThanOrEqual(2_048);
    expect(
      new TextEncoder().encode(
        JSON.stringify({
          strokeId: harness.finals[0]!.strokeId,
          frameKey: harness.finals[0]!.frameKey,
          anchor: harness.finals[0]!.anchor,
          points: harness.finals[0]!.points,
          rgb: harness.finals[0]!.rgb,
          width: harness.finals[0]!.width,
        }),
      ).byteLength,
    ).toBeLessThanOrEqual(64 * 1_024);
    const path = requireStrokePath(harness.surface, strokeId(0));
    expect(path.getAttribute("d")).toMatch(/^M/u);
    expect(path.dataset.status).toBe("pending");
    expect(path.getAttribute("stroke")).toBe("rgb(12 34 56)");
    expect(path.dataset.width).toBe("32");

    harness.runtime.setDraftStatus(strokeId(0), "ERROR", true);
    expect(requireStrokePath(harness.surface, strokeId(0)).dataset.status).toBe("error");
    expect(harness.surface.textContent).toContain("未发送");
    harness.dispose();
  });

  it("re-emits the same unpersisted stroke when durable storage recovers", async () => {
    const attempts: AnnotationStrokeDraft[] = [];
    const harness = createHarness({
      emitFinal: async (draft) => {
        attempts.push(structuredClone(draft));
        if (attempts.length === 1) {
          throw new Error("ANNOTATION_STORAGE_FAILURE");
        }
      },
    });
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });

    harness.runtime.beginStroke(pointer(1, 100, 100, 0.5, harness.target));
    harness.runtime.endStroke(pointer(1, 180, 140, 0.7));
    await vi.waitFor(() =>
      expect(requireStrokePath(harness.surface, strokeId(0)).dataset.status).toBe("error"),
    );

    expect(harness.surface.textContent).toContain("未发送");
    await expect(harness.runtime.retryFailed()).resolves.toBe(strokeId(0));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(requireStrokePath(harness.surface, strokeId(0)).dataset.status).toBe("pending");
    harness.dispose();
  });

  it("retains an unpersisted stroke when a replacement snapshot races its storage failure", async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const attempts: AnnotationStrokeDraft[] = [];
    const harness = createHarness({
      emitFinal: (draft) => {
        attempts.push(structuredClone(draft));
        return attempts.length === 1 ? firstAttempt : Promise.resolve();
      },
    });
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });

    harness.runtime.beginStroke(pointer(1, 100, 100, 0.5, harness.target));
    harness.runtime.endStroke(pointer(1, 180, 140, 0.7));
    harness.runtime.renderConfirmed([]);

    expect(requireStrokePath(harness.surface, strokeId(0)).dataset.status).toBe("pending");
    rejectFirst?.(new Error("ANNOTATION_STORAGE_FAILURE"));
    await vi.waitFor(() =>
      expect(requireStrokePath(harness.surface, strokeId(0)).dataset.status).toBe("error"),
    );

    await expect(harness.runtime.retryFailed()).resolves.toBe(strokeId(0));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(requireStrokePath(harness.surface, strokeId(0)).dataset.status).toBe("pending");
    harness.dispose();
  });

  it("replaces previews, reprojects on scroll/resize, and counts anchors it cannot locate", () => {
    const harness = createHarness();
    let rectangle = domRect(100, 100, 700, 300);
    harness.target.getBoundingClientRect = () => rectangle;
    const preview = previewEvent(0, [
      { x: 0.1, y: 0.2, pressure: 0.4 },
      { x: 0.6, y: 0.7, pressure: 0.8 },
    ]);
    harness.runtime.renderPreview(preview);
    const firstPath = requirePreviewPath(harness.surface, preview.previewId);
    const firstData = firstPath.getAttribute("d");

    harness.runtime.renderPreview({
      ...preview,
      points: [
        { x: 0.2, y: 0.2, pressure: 0.4 },
        { x: 0.9, y: 0.8, pressure: 0.8 },
      ],
    });
    expect(
      harness.surface.querySelectorAll(`[data-preview-id="${preview.previewId}"]`),
    ).toHaveLength(1);
    expect(requirePreviewPath(harness.surface, preview.previewId).getAttribute("d")).not.toBe(
      firstData,
    );

    rectangle = domRect(20, 40, 1_000, 500);
    window.dispatchEvent(new Event("scroll"));
    harness.scheduler.flushAnimationFrames();
    const afterScroll = requirePreviewPath(harness.surface, preview.previewId).getAttribute("d");
    expect(afterScroll).not.toBe(firstData);

    harness.target.remove();
    window.dispatchEvent(new Event("resize"));
    harness.scheduler.flushAnimationFrames();
    expect(harness.runtime.getState().unlocatableCount).toBe(1);
    expect(requirePreviewPath(harness.surface, preview.previewId).hasAttribute("hidden")).toBe(
      true,
    );
    harness.scheduler.advanceTo(1_785_160_003_000);
    expect(harness.surface.querySelector(`[data-preview-id="${preview.previewId}"]`)).toBeNull();
    harness.dispose();
  });

  it("erases whole eligible objects, protects locks, and exposes owner override without client-side authority claims", () => {
    const member = createHarness({ role: "MEMBER" });
    const unlocked = stroke(1, otherUserId, false);
    const locked = stroke(2, otherUserId, true);
    member.runtime.renderConfirmed([unlocked, locked]);
    member.runtime.handleCommand({ type: "SET_TOOL", tool: "ERASER" });
    member.runtime.handleCommand({ type: "TOGGLE_PEN" });

    member.runtime.beginStroke(pointer(8, 240, 190, 0.5, member.target));
    expect(member.selections).toEqual([
      {
        action: "DELETE",
        items: [{ strokeId: unlocked.strokeId, expectedVersion: unlocked.version }],
      },
    ]);
    member.runtime.beginStroke(pointer(9, 590, 310, 0.5, member.target));
    expect(member.selections).toHaveLength(1);
    expect(requireStrokePath(member.surface, locked.strokeId).dataset.locked).toBe("true");
    member.dispose();

    const owner = createHarness({ role: "OWNER" });
    owner.runtime.renderConfirmed([locked]);
    owner.runtime.handleCommand({ type: "SET_TOOL", tool: "ERASER" });
    owner.runtime.handleCommand({ type: "TOGGLE_PEN" });
    owner.runtime.beginStroke(pointer(10, 590, 310, 0.5, owner.target));
    expect(owner.selections).toEqual([
      {
        action: "DELETE",
        items: [{ strokeId: locked.strokeId, expectedVersion: locked.version }],
      },
    ]);
    expect(owner.surface.querySelector("[data-owner-override]")).not.toBeNull();
    owner.dispose();
  });

  it("lasso-selects objects and filters lock/unlock intents to the current author", () => {
    const harness = createHarness();
    const ownUnlocked = stroke(3, currentUserId, false);
    const ownLocked = stroke(4, currentUserId, true);
    const otherUnlocked = stroke(5, otherUserId, false);
    harness.runtime.renderConfirmed([ownUnlocked, ownLocked, otherUnlocked]);
    harness.runtime.handleCommand({ type: "SET_TOOL", tool: "SELECT" });
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });
    harness.runtime.beginStroke(pointer(11, 120, 120, 0.5, harness.target));
    harness.runtime.continueStroke(pointer(11, 820, 420, 0.5));
    harness.runtime.endStroke(pointer(11, 820, 420, 0.5));

    expect(harness.runtime.getState().selectedStrokeIds.sort()).toEqual(
      [ownUnlocked.strokeId, ownLocked.strokeId, otherUnlocked.strokeId].sort(),
    );
    harness.runtime.requestSelectionAction("LOCK");
    harness.runtime.requestSelectionAction("UNLOCK");
    harness.runtime.requestSelectionAction("DELETE");

    expect(harness.selections).toEqual([
      intent("LOCK", ownUnlocked),
      intent("UNLOCK", ownLocked),
      {
        action: "DELETE",
        items: [ownUnlocked, ownLocked, otherUnlocked].map((item) => ({
          strokeId: item.strokeId,
          expectedVersion: item.version,
        })),
      },
    ]);
    harness.dispose();
  });

  it("reports active tool, style, selection, lock, and draft diagnostics for the side panel", () => {
    const harness = createHarness();
    const ownUnlocked = stroke(3, currentUserId, false);
    const ownLocked = stroke(4, currentUserId, true);
    harness.runtime.renderConfirmed([ownUnlocked, ownLocked]);
    harness.runtime.handleCommand({ type: "SET_TOOL", tool: "SELECT" });
    harness.runtime.handleCommand({
      type: "SET_STYLE",
      rgb: { r: 16, g: 128, b: 240 },
      width: 9,
    });
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });
    harness.runtime.beginStroke(pointer(11, 120, 120, 0.5, harness.target));
    harness.runtime.continueStroke(pointer(11, 820, 420, 0.5));
    harness.runtime.endStroke(pointer(11, 820, 420, 0.5));

    expect(harness.reports.at(-1)).toMatchObject({
      active: true,
      tool: "SELECT",
      rgb: { r: 16, g: 128, b: 240 },
      width: 9,
      selectedCount: 2,
      selectedLockedCount: 1,
      pendingDraftCount: 0,
      errorDraftCount: 0,
      unlocatableCount: 0,
    });
    harness.dispose();
  });

  it("undoes only durably discarded drafts and exits immediately without trapping page input", async () => {
    const harness = createHarness();
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });
    harness.runtime.beginStroke(pointer(1, 150, 150, 0.5, harness.target));
    harness.runtime.endStroke(pointer(1, 300, 250, 0.5));
    expect(requireStrokePath(harness.surface, strokeId(0))).toBeInstanceOf(SVGPathElement);

    await expect(harness.runtime.undoUnsubmitted()).resolves.toBe(strokeId(0));
    expect(harness.discarded).toEqual([strokeId(0)]);
    expect(harness.surface.querySelector(`[data-stroke-id="${strokeId(0)}"]`)).toBeNull();

    harness.runtime.handleCommand({ type: "EXIT" });
    expect(harness.runtime.getState().active).toBe(false);
    expect(harness.surface.style.pointerEvents).toBe("none");
    expect(harness.surface.querySelector('[aria-label="退出画笔"]')).toBeNull();
    harness.dispose();
  });

  it("retains a draft when durable discard fails and retries an error only after persistence succeeds", async () => {
    const retried: string[] = [];
    const harness = createHarness({
      discardDraft: async () => {
        throw new Error("ANNOTATION_STORAGE_FAILURE");
      },
      retryDraft: async (id) => {
        retried.push(id);
      },
    });
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });
    harness.runtime.beginStroke(pointer(1, 150, 150, 0.5, harness.target));
    harness.runtime.endStroke(pointer(1, 300, 250, 0.5));
    harness.runtime.setDraftStatus(strokeId(0), "ERROR", true);

    await expect(harness.runtime.undoUnsubmitted()).rejects.toThrow("ANNOTATION_STORAGE_FAILURE");
    expect(requireStrokePath(harness.surface, strokeId(0)).dataset.status).toBe("error");

    await expect(harness.runtime.retryFailed()).resolves.toBe(strokeId(0));
    expect(retried).toEqual([strokeId(0)]);
    expect(requireStrokePath(harness.surface, strokeId(0)).dataset.status).toBe("pending");
    harness.dispose();
  });

  it("does not offer retry for a terminal draft error but still permits durable discard", async () => {
    const retried: string[] = [];
    const harness = createHarness({
      retryDraft: async (id) => {
        retried.push(id);
      },
    });
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });
    harness.runtime.beginStroke(pointer(1, 150, 150, 0.5, harness.target));
    harness.runtime.endStroke(pointer(1, 300, 250, 0.5));
    harness.runtime.setDraftStatus(strokeId(0), "ERROR", false);

    const retry = harness.surface.querySelector<HTMLButtonElement>('[aria-label="重试未发送"]');
    expect(retry?.disabled).toBe(true);
    await expect(harness.runtime.retryFailed()).resolves.toBeNull();
    expect(retried).toEqual([]);
    await expect(harness.runtime.undoUnsubmitted()).resolves.toBe(strokeId(0));
    expect(harness.discarded).toEqual([strokeId(0)]);
    harness.dispose();
  });

  it("does not turn toolbar pointer gestures into page strokes", () => {
    const harness = createHarness();
    harness.runtime.handleCommand({ type: "TOGGLE_PEN" });
    const button = harness.surface.querySelector('[aria-label="橡皮擦"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("DRAWING_TOOLBAR_BUTTON_NOT_FOUND");
    }

    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 17,
        clientX: 180,
        clientY: 180,
        pressure: 0.5,
      }),
    );
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 17,
        clientX: 240,
        clientY: 220,
        pressure: 0.5,
      }),
    );

    expect(harness.finals).toEqual([]);
    expect(harness.previews).toEqual([]);
    harness.dispose();
  });

  it("materializes accepted create, lock, and delete commits without applying rejected items", () => {
    const harness = createHarness();
    const created = stroke(6, otherUserId, false);
    const draft: AnnotationStrokeDraft = {
      strokeId: created.strokeId,
      frameKey: created.frameKey,
      anchor: created.anchor,
      points: created.points,
      rgb: created.rgb,
      width: created.width,
    };

    harness.runtime.applyCommitted([committed(1, { type: "stroke.create", stroke: draft })]);
    expect(requireStrokePath(harness.surface, created.strokeId).dataset.status).toBe("confirmed");

    harness.runtime.applyCommitted([
      committed(
        2,
        {
          type: "stroke.lock",
          items: [{ strokeId: created.strokeId, expectedVersion: 1 }],
        },
        2,
      ),
    ]);
    expect(requireStrokePath(harness.surface, created.strokeId).dataset.locked).toBe("true");

    harness.runtime.applyCommitted([
      committed(
        3,
        {
          type: "stroke.delete",
          items: [{ strokeId: created.strokeId, expectedVersion: 2 }],
        },
        3,
        false,
      ),
    ]);
    expect(requireStrokePath(harness.surface, created.strokeId).dataset.locked).toBe("true");

    harness.runtime.applyCommitted([
      committed(
        4,
        {
          type: "stroke.delete",
          items: [{ strokeId: created.strokeId, expectedVersion: 2 }],
        },
        3,
      ),
    ]);
    expect(harness.surface.querySelector(`[data-stroke-id="${created.strokeId}"]`)).toBeNull();
    harness.dispose();
  });

  it("treats a full snapshot as a replacement before the controller replays retained drafts", () => {
    const harness = createHarness();
    const local = stroke(7, currentUserId, false);
    const draft: AnnotationStrokeDraft = {
      strokeId: local.strokeId,
      frameKey: local.frameKey,
      anchor: local.anchor,
      points: local.points,
      rgb: local.rgb,
      width: local.width,
    };
    harness.runtime.renderDraft(draft, "PENDING");
    expect(requireStrokePath(harness.surface, draft.strokeId).dataset.status).toBe("pending");

    harness.runtime.renderConfirmed([]);

    expect(harness.surface.querySelector(`[data-stroke-id="${draft.strokeId}"]`)).toBeNull();
    harness.dispose();
  });
});

function createHarness(
  options: {
    role?: "OWNER" | "MEMBER";
    emitFinal?: (draft: AnnotationStrokeDraft) => void | Promise<void>;
    discardDraft?: (strokeId: string) => void | Promise<void>;
    retryDraft?: (strokeId: string) => void | Promise<void>;
  } = {},
) {
  const host = new PageOverlayHost({ document });
  mountedHosts.push(host);
  const surface = host.getSurface("drawing");
  const target = document.createElement("main");
  target.getBoundingClientRect = () => domRect(100, 100, 700, 300);
  document.body.append(target);
  const scheduler = new FakeDrawingScheduler();
  const previews: StrokePreviewUpdate[] = [];
  const finals: AnnotationStrokeDraft[] = [];
  const selections: DrawingSelectionIntent[] = [];
  const discarded: string[] = [];
  const reports: Array<{
    active: boolean;
    tool: "PEN" | "ERASER" | "SELECT";
    rgb: { r: number; g: number; b: number };
    width: number;
    selectedCount: number;
    selectedLockedCount: number;
    unlocatableCount: number;
    pendingDraftCount: number;
    errorDraftCount: number;
  }> = [];
  let nextId = 0;
  const runtime = new DrawingPageRuntime({
    document,
    window,
    surface,
    context,
    currentUserId,
    role: options.role ?? "MEMBER",
    scheduler,
    getStroke,
    createId: () => strokeId(nextId++),
    elementAtPoint: () => target,
    now: () => scheduler.now,
    emitPreview: (preview) => {
      previews.push(structuredClone(preview));
    },
    emitFinal:
      options.emitFinal ??
      ((draft) => {
        finals.push(structuredClone(draft));
      }),
    emitSelection: (selection) => {
      selections.push(structuredClone(selection));
    },
    discardDraft:
      options.discardDraft ??
      ((id) => {
        discarded.push(id);
      }),
    ...(options.retryDraft === undefined ? {} : { retryDraft: options.retryDraft }),
    reportState: (state) => {
      reports.push(structuredClone(state));
    },
  });
  return {
    host,
    surface,
    target,
    scheduler,
    previews,
    finals,
    selections,
    discarded,
    reports,
    runtime,
    dispose: () => {
      runtime.dispose();
      host.dispose("BACKGROUND_STOPPED");
    },
  };
}

class FakeDrawingScheduler implements DrawingPageScheduler {
  public now = 1_785_160_000_000;
  readonly #frames: Array<() => void> = [];
  readonly #timers = new Map<number, { callback: () => void; at: number }>();
  #nextTimerId = 1;

  public setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextTimerId++;
    this.#timers.set(id, { callback, at: this.now + delayMs });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  public requestAnimationFrame(callback: () => void): unknown {
    this.#frames.push(callback);
    return this.#frames.length;
  }

  public cancelAnimationFrame(): void {}

  public flushAnimationFrames(): void {
    for (const callback of this.#frames.splice(0)) {
      callback();
    }
  }

  public advanceTo(now: number): void {
    this.now = now;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= now) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
}

function pointer(
  pointerId: number,
  clientX: number,
  clientY: number,
  pressure: number,
  target?: Element,
): DrawingPointerSample {
  return {
    pointerId,
    clientX,
    clientY,
    pressure,
    pointerType: "pen",
    ...(target === undefined ? {} : { target }),
  };
}

function stroke(index: number, authorUserId: string, locked: boolean): AnnotationStroke {
  return AnnotationStrokeSchema.parse({
    strokeId: strokeId(index),
    frameKey: "top",
    anchor: {
      type: "element",
      path: [
        { tagName: "html", nthOfType: 1 },
        { tagName: "body", nthOfType: 1 },
        { tagName: "main", nthOfType: 1 },
      ],
    },
    points: [
      { x: index % 2 === 0 ? 0.6 : 0.1, y: index % 2 === 0 ? 0.7 : 0.2, pressure: 0.5 },
      { x: index % 2 === 0 ? 0.8 : 0.3, y: index % 2 === 0 ? 0.8 : 0.4, pressure: 0.6 },
    ],
    rgb: { r: 30, g: 120, b: 240 },
    width: 12,
    authorUserId,
    lockedAtServerMs: locked ? 1_785_160_001_000 : null,
    version: locked ? 2 : 1,
    createdAtServerMs: 1_785_160_000_000,
    deletedAtServerMs: null,
  });
}

function previewEvent(index: number, points: Array<{ x: number; y: number; pressure: number }>) {
  return StrokePreviewEventMessageSchema.parse({
    type: "stroke.preview.event",
    protocolVersion: 1,
    previewId: strokeId(index),
    ...context,
    sender: {
      userId: otherUserId,
      username: "remote",
      displayName: "Remote",
      deviceId,
    },
    anchor: {
      type: "element",
      path: [
        { tagName: "html", nthOfType: 1 },
        { tagName: "body", nthOfType: 1 },
        { tagName: "main", nthOfType: 1 },
      ],
    },
    points,
    rgb: { r: 255, g: 60, b: 80 },
    width: 8,
    expiresAtServerMs: 1_785_160_003_000,
  });
}

function committed(
  sequence: number,
  operation:
    | { type: "stroke.create"; stroke: AnnotationStrokeDraft }
    | {
        type: "stroke.lock" | "stroke.unlock" | "stroke.delete";
        items: Array<{ strokeId: string; expectedVersion: number }>;
      },
  resultVersion = 1,
  accepted = true,
) {
  const targetId =
    operation.type === "stroke.create" ? operation.stroke.strokeId : operation.items[0]!.strokeId;
  return AnnotationCommittedOperationSchema.parse({
    type: "annotation.committed",
    protocolVersion: 1,
    clientOpId: `018f8f8e-4b5c-7d6e-8f90-823456789b${sequence.toString(16).padStart(2, "0")}`,
    roomId,
    pageKey: "a".repeat(43),
    annotationSeq: sequence,
    actorUserId: otherUserId,
    operation,
    results: [
      accepted
        ? {
            strokeId: targetId,
            accepted: true,
            code: null,
            version: resultVersion,
          }
        : {
            strokeId: targetId,
            accepted: false,
            code: "STROKE_VERSION_CONFLICT",
            version: resultVersion,
          },
    ],
    createdAtServerMs: 1_785_160_000_000 + sequence,
  });
}

function intent(
  action: DrawingSelectionIntent["action"],
  target: AnnotationStroke,
): DrawingSelectionIntent {
  return {
    action,
    items: [{ strokeId: target.strokeId, expectedVersion: target.version }],
  };
}

function strokeId(index: number): string {
  return `018f8f8e-4b5c-7d6e-8f90-823456789a${index.toString(16).padStart(2, "0")}`;
}

function requireStrokePath(surface: HTMLElement, id: string): SVGPathElement {
  const path = surface.querySelector(`[data-stroke-id="${id}"]`);
  if (!(path instanceof SVGPathElement)) {
    throw new Error(`STROKE_PATH_NOT_FOUND:${id}`);
  }
  return path;
}

function requirePreviewPath(surface: HTMLElement, id: string): SVGPathElement {
  const path = surface.querySelector(`[data-preview-id="${id}"]`);
  if (!(path instanceof SVGPathElement)) {
    throw new Error(`PREVIEW_PATH_NOT_FOUND:${id}`);
  }
  return path;
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
