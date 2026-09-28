import {
  PointerPathSegmentSchema,
  PointerFrameEventSchema,
  PointerLeaseRecordSchema,
  PointerRecordSchema,
  type PointerAnchor,
  type PointerFrameEvent,
  type PointerLeaseRecord,
  type PointerPathSegment,
  type PointerRecord,
} from "@syncaction/protocol";
import {
  PointerLocalSampleSchema,
  type PointerIdentity,
  type PointerLocalSample,
  type PointerPageContext,
} from "./pointer-controller.js";
import { realtimeMetrics, type RealtimeMetrics } from "./realtime-metrics.js";

const POINTER_STALE_MS = 3_000;
const POINTER_SNAP_GAP_MS = 250;
const POINTER_INTERPOLATION_MAX_MS = 80;

export interface PointerPosition {
  x: number;
  y: number;
  source: "anchor" | "viewport";
}

export interface PointerMoveSample {
  clientX: number;
  clientY: number;
  composedPath(): EventTarget[];
}

export interface PointerPageScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  requestAnimationFrame(callback: () => void): unknown;
  cancelAnimationFrame(handle: unknown): void;
}

export interface PointerPageRuntimeOptions {
  document: Document;
  window: Window;
  surface: HTMLElement;
  emitSample: (sample: PointerLocalSample) => void | Promise<void>;
  now?: () => number;
  scheduler?: PointerPageScheduler;
  metrics?: Pick<RealtimeMetrics, "observePointerDomNodes">;
}

interface RemotePointerVisual {
  lease: PointerLeaseRecord | null;
  legacyRecord: PointerRecord | null;
  leaseId: string;
  element: HTMLDivElement;
  currentX: number;
  currentY: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  previousServerMs: number;
  targetServerMs: number;
  interpolationDurationMs: number;
  frameReceivedLocalAt: number;
  lastFrameAt: number;
  expiresAt: number;
  lastSequence: number;
  hasPosition: boolean;
  source: PointerPosition["source"];
}

export function buildPointerPath(document: Document, target: Element): PointerPathSegment[] | null {
  if (target.getRootNode() !== document) {
    return null;
  }
  const path: PointerPathSegment[] = [];
  let current: Element | null = target;
  while (current !== null) {
    const tagName = current.localName.toLowerCase();
    const parent: Element | null = current.parentElement;
    const nthOfType =
      parent === null
        ? 1
        : [...parent.children]
            .filter((candidate) => candidate.localName.toLowerCase() === tagName)
            .indexOf(current) + 1;
    const parsed = PointerPathSegmentSchema.safeParse({ tagName, nthOfType });
    if (!parsed.success) {
      return null;
    }
    path.unshift(parsed.data);
    if (current === document.documentElement) {
      break;
    }
    current = parent;
  }
  return path.length > 0 &&
    path.length <= 12 &&
    path[0]?.tagName === document.documentElement.localName.toLowerCase()
    ? path
    : null;
}

export function resolvePointerPath(
  document: Document,
  pathInput: readonly PointerPathSegment[],
): Element | null {
  const parsed = PointerPathSegmentSchema.array().min(1).max(12).safeParse(pathInput);
  if (!parsed.success) {
    return null;
  }
  let parent: Document | Element = document;
  for (const segment of parsed.data) {
    const matches: Element[] = [...parent.children].filter(
      (candidate) => candidate.localName.toLowerCase() === segment.tagName,
    );
    const match: Element | undefined = matches[segment.nthOfType - 1];
    if (match === undefined) {
      return null;
    }
    parent = match;
  }
  return parent instanceof Element && parent.getRootNode() === document ? parent : null;
}

export function buildPointerAnchor(
  document: Document,
  target: Element,
  clientX: number,
  clientY: number,
): PointerAnchor | null {
  const path = buildPointerPath(document, target);
  const rectangle = target.getBoundingClientRect();
  if (
    path === null ||
    rectangle.width <= 0 ||
    rectangle.height <= 0 ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY)
  ) {
    return null;
  }
  return {
    path,
    x: clamp((clientX - rectangle.left) / rectangle.width),
    y: clamp((clientY - rectangle.top) / rectangle.height),
  };
}

export function locatePointer(
  document: Document,
  window: Window,
  pointerInput: PointerRecord,
): PointerPosition | null {
  const parsed = PointerRecordSchema.safeParse(pointerInput);
  if (!parsed.success) {
    return null;
  }
  const pointer = parsed.data;
  if (pointer.anchor !== null) {
    const target = resolvePointerPath(document, pointer.anchor.path);
    if (target !== null) {
      const rectangle = target.getBoundingClientRect();
      if (rectangle.width > 0 && rectangle.height > 0) {
        const x = rectangle.left + rectangle.width * pointer.anchor.x;
        const y = rectangle.top + rectangle.height * pointer.anchor.y;
        return isInsideViewport(window, x, y) ? { x, y, source: "anchor" } : null;
      }
    }
  }
  return {
    x: pointer.viewport.x * window.innerWidth,
    y: pointer.viewport.y * window.innerHeight,
    source: "viewport",
  };
}

export class PointerPageRuntime {
  readonly #document: Document;
  readonly #window: Window;
  readonly #emitSample: (sample: PointerLocalSample) => void | Promise<void>;
  readonly #now: () => number;
  readonly #scheduler: PointerPageScheduler;
  readonly #metrics: Pick<RealtimeMetrics, "observePointerDomNodes">;
  readonly #surface: HTMLElement;
  readonly #style: HTMLStyleElement;
  readonly #overlay: HTMLDivElement;
  readonly #rendered = new Map<string, RemotePointerVisual>();
  readonly #positions = new Map<string, PointerPosition>();
  readonly #pointerMoveListener: (event: Event) => void;
  readonly #visibilityListener: () => void;
  readonly #repositionListener: () => void;
  #context: PointerPageContext | null = null;
  #frameHandle: unknown;
  #expiryTimer: unknown;
  #disposed = false;

  public constructor(options: PointerPageRuntimeOptions) {
    this.#document = options.document;
    this.#window = options.window;
    this.#emitSample = options.emitSample;
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? browserScheduler(options.window);
    this.#metrics = options.metrics ?? realtimeMetrics;
    this.#surface = options.surface;
    if (this.#surface.ownerDocument !== this.#document) {
      throw new Error("POINTER_SURFACE_DOCUMENT_MISMATCH");
    }
    this.#style = this.#document.createElement("style");
    this.#style.textContent = POINTER_STYLES;
    this.#overlay = this.#document.createElement("div");
    this.#overlay.className = "syncaction-pointer-overlay";
    this.#surface.append(this.#style, this.#overlay);
    this.#surface.dataset.active = "true";
    this.#pointerMoveListener = (event) => {
      this.handlePointerMove(event as PointerEvent);
    };
    this.#visibilityListener = () => {
      const context = this.#context;
      if (
        this.#disposed ||
        context === null ||
        this.#document.visibilityState !== "hidden" ||
        this.#window.innerWidth <= 0 ||
        this.#window.innerHeight <= 0
      ) {
        return;
      }
      const sample = PointerLocalSampleSchema.parse({
        type: "pointer.sample",
        documentRevision: context.documentRevision,
        anchor: null,
        viewport: { x: 0, y: 0 },
        viewportDimensions: {
          widthCssPx: this.#window.innerWidth,
          heightCssPx: this.#window.innerHeight,
        },
        documentVisible: false,
      });
      void Promise.resolve(this.#emitSample(sample)).catch(() => undefined);
    };
    this.#repositionListener = () => this.#scheduleReposition();
    this.#document.addEventListener("pointermove", this.#pointerMoveListener, {
      passive: true,
    });
    this.#document.addEventListener("visibilitychange", this.#visibilityListener);
    this.#window.addEventListener("scroll", this.#repositionListener, {
      passive: true,
      capture: true,
    });
    this.#window.addEventListener("resize", this.#repositionListener, {
      passive: true,
    });
  }

  public setContext(context: PointerPageContext): void {
    if (this.#disposed) {
      return;
    }
    this.#context = structuredClone(context);
    for (const [key, rendered] of this.#rendered) {
      const documentIdentity = rendered.lease ?? rendered.legacyRecord;
      if (
        documentIdentity === null ||
        documentIdentity.logicalTabId !== context.logicalTabId ||
        !sameRevision(documentIdentity.documentRevision, context.documentRevision)
      ) {
        this.#remove(key);
      }
    }
  }

  public render(pointerInput: PointerRecord): void {
    if (this.#disposed || this.#context === null) {
      return;
    }
    const parsed = PointerRecordSchema.safeParse(pointerInput);
    if (!parsed.success) {
      return;
    }
    const pointer = parsed.data;
    const key = pointerKey(pointer);
    if (
      pointer.expiresAt <= this.#now() ||
      pointer.logicalTabId !== this.#context.logicalTabId ||
      !sameRevision(pointer.documentRevision, this.#context.documentRevision)
    ) {
      this.#remove(key);
      return;
    }
    const visual = this.#getOrCreateVisual(
      key,
      `legacy:${pointer.userId}:${pointer.deviceId}`,
      pointer,
    );
    visual.legacyRecord = structuredClone(pointer);
    visual.expiresAt = pointer.expiresAt;
    const position = locatePointer(this.#document, this.#window, pointer);
    if (position === null) {
      visual.element.hidden = true;
      visual.hasPosition = false;
      this.#positions.delete(key);
    } else {
      this.#setTarget(visual, position.x, position.y, this.#now(), true, position.source);
    }
    this.#scheduleExpiry();
    this.#ensureAnimationLoop();
  }

  public renderLease(leaseInput: PointerLeaseRecord): void {
    if (this.#disposed || this.#context === null) {
      return;
    }
    const parsed = PointerLeaseRecordSchema.safeParse(leaseInput);
    if (!parsed.success) {
      return;
    }
    const lease = parsed.data;
    const key = pointerKey(lease);
    if (
      lease.expiresAt <= this.#now() ||
      lease.logicalTabId !== this.#context.logicalTabId ||
      !sameRevision(lease.documentRevision, this.#context.documentRevision)
    ) {
      this.#remove(key);
      return;
    }
    const visual = this.#getOrCreateVisual(key, lease.leaseId, lease);
    if (visual.leaseId !== lease.leaseId) {
      visual.leaseId = lease.leaseId;
      visual.lastSequence = 0;
      visual.previousServerMs = 0;
      visual.targetServerMs = 0;
      visual.interpolationDurationMs = 0;
    }
    visual.lease = structuredClone(lease);
    visual.legacyRecord = null;
    visual.expiresAt = lease.expiresAt;
    const anchored = locateLeaseAnchor(this.#document, this.#window, lease);
    if (!visual.hasPosition && anchored !== null) {
      this.#setTarget(visual, anchored.x, anchored.y, this.#now(), true, anchored.source);
    }
    this.#scheduleExpiry();
    this.#ensureAnimationLoop();
  }

  public renderFrame(frameInput: PointerFrameEvent): void {
    if (this.#disposed || this.#context === null) {
      return;
    }
    const parsed = PointerFrameEventSchema.safeParse(frameInput);
    if (!parsed.success) {
      return;
    }
    const frame = parsed.data;
    const key = pointerKey(frame);
    const visual = this.#rendered.get(key);
    if (
      visual === undefined ||
      visual.lease === null ||
      visual.leaseId !== frame.leaseId ||
      visual.lease.expiresAt <= this.#now() ||
      frame.seq <= visual.lastSequence
    ) {
      return;
    }
    visual.lastSequence = frame.seq;
    visual.previousServerMs = visual.targetServerMs;
    visual.targetServerMs = frame.receivedAtServerMs;
    const serverIntervalMs =
      visual.previousServerMs === 0
        ? Number.POSITIVE_INFINITY
        : visual.targetServerMs - visual.previousServerMs;
    const snap =
      !visual.hasPosition || serverIntervalMs >= POINTER_SNAP_GAP_MS || serverIntervalMs <= 0;
    visual.interpolationDurationMs = snap
      ? 0
      : Math.min(POINTER_INTERPOLATION_MAX_MS, serverIntervalMs);
    visual.lastFrameAt = this.#now();
    this.#setTarget(
      visual,
      (frame.xQuantized / 4_095) * this.#window.innerWidth,
      (frame.yQuantized / 4_095) * this.#window.innerHeight,
      visual.lastFrameAt,
      snap,
      "viewport",
    );
    this.#scheduleExpiry();
    this.#ensureAnimationLoop();
  }

  public clear(identity?: PointerIdentity): void {
    if (identity === undefined) {
      for (const key of [...this.#rendered.keys()]) {
        this.#remove(key);
      }
      this.#scheduleExpiry();
      return;
    }
    this.#remove(pointerKey(identity));
    this.#scheduleExpiry();
  }

  public handlePointerMove(event: PointerMoveSample): void {
    const context = this.#context;
    if (
      this.#disposed ||
      context === null ||
      this.#document.visibilityState === "hidden" ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY) ||
      this.#window.innerWidth <= 0 ||
      this.#window.innerHeight <= 0
    ) {
      return;
    }
    const target = event
      .composedPath()
      .find(
        (candidate): candidate is Element =>
          candidate instanceof Element && candidate.getRootNode() === this.#document,
      );
    const sample = PointerLocalSampleSchema.parse({
      type: "pointer.sample",
      documentRevision: context.documentRevision,
      anchor:
        target === undefined
          ? null
          : buildPointerAnchor(this.#document, target, event.clientX, event.clientY),
      viewport: {
        x: clamp(event.clientX / this.#window.innerWidth),
        y: clamp(event.clientY / this.#window.innerHeight),
      },
      viewportDimensions: {
        widthCssPx: this.#window.innerWidth,
        heightCssPx: this.#window.innerHeight,
      },
      documentVisible: true,
    });
    void Promise.resolve(this.#emitSample(sample)).catch(() => undefined);
  }

  public getPointerPosition(userId: string, deviceId: string): PointerPosition | null {
    const position = this.#positions.get(`${userId}:${deviceId}`);
    return position === undefined ? null : { ...position };
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#context = null;
    this.clear();
    this.#document.removeEventListener("pointermove", this.#pointerMoveListener);
    this.#document.removeEventListener("visibilitychange", this.#visibilityListener);
    this.#window.removeEventListener("scroll", this.#repositionListener, true);
    this.#window.removeEventListener("resize", this.#repositionListener);
    if (this.#frameHandle !== undefined) {
      this.#scheduler.cancelAnimationFrame(this.#frameHandle);
      this.#frameHandle = undefined;
    }
    if (this.#expiryTimer !== undefined) {
      this.#scheduler.clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    this.#style.remove();
    this.#overlay.remove();
    this.#surface.dataset.active = "false";
  }

  #remove(key: string): void {
    const visual = this.#rendered.get(key);
    if (visual === undefined) {
      return;
    }
    visual.element.remove();
    this.#rendered.delete(key);
    this.#positions.delete(key);
  }

  #scheduleReposition(): void {
    if (this.#disposed) {
      return;
    }
    for (const visual of this.#rendered.values()) {
      if (visual.legacyRecord !== null) {
        const position = locatePointer(this.#document, this.#window, visual.legacyRecord);
        if (position !== null) {
          this.#setTarget(visual, position.x, position.y, this.#now(), true, position.source);
        }
      } else if (visual.lease !== null && visual.lastFrameAt === 0) {
        const position = locateLeaseAnchor(this.#document, this.#window, visual.lease);
        if (position !== null) {
          this.#setTarget(visual, position.x, position.y, this.#now(), true, position.source);
        }
      }
    }
    this.#ensureAnimationLoop();
  }

  #getOrCreateVisual(
    key: string,
    leaseId: string,
    metadata: Pick<PointerRecord, "color" | "displayName" | "expiresAt">,
  ): RemotePointerVisual {
    const existing = this.#rendered.get(key);
    if (existing !== undefined) {
      this.#updateElementMetadata(existing.element, metadata);
      return existing;
    }
    const element = this.#document.createElement("div");
    element.className = "syncaction-pointer";
    element.hidden = true;
    const cursor = this.#document.createElement("span");
    cursor.className = "syncaction-pointer-cursor";
    const label = this.#document.createElement("span");
    label.className = "syncaction-pointer-label";
    element.append(cursor, label);
    this.#updateElementMetadata(element, metadata);
    this.#overlay.append(element);
    const visual: RemotePointerVisual = {
      lease: null,
      legacyRecord: null,
      leaseId,
      element,
      currentX: 0,
      currentY: 0,
      startX: 0,
      startY: 0,
      targetX: 0,
      targetY: 0,
      previousServerMs: 0,
      targetServerMs: 0,
      interpolationDurationMs: 0,
      frameReceivedLocalAt: this.#now(),
      lastFrameAt: 0,
      expiresAt: metadata.expiresAt,
      lastSequence: 0,
      hasPosition: false,
      source: "viewport",
    };
    this.#rendered.set(key, visual);
    this.#metrics.observePointerDomNodes(this.#rendered.size);
    return visual;
  }

  #updateElementMetadata(
    element: HTMLDivElement,
    metadata: Pick<PointerRecord, "color" | "displayName">,
  ): void {
    if (element.dataset.color !== metadata.color) {
      element.dataset.color = metadata.color;
      element.style.setProperty("--syncaction-pointer-color", metadata.color);
    }
    const label = element.querySelector<HTMLElement>(".syncaction-pointer-label");
    if (label !== null && label.textContent !== metadata.displayName) {
      label.textContent = metadata.displayName;
    }
  }

  #setTarget(
    visual: RemotePointerVisual,
    x: number,
    y: number,
    receivedAt: number,
    snap: boolean,
    source: PointerPosition["source"],
  ): void {
    visual.startX = visual.currentX;
    visual.startY = visual.currentY;
    visual.targetX = x;
    visual.targetY = y;
    visual.frameReceivedLocalAt = receivedAt;
    visual.source = source;
    if (snap || !visual.hasPosition) {
      visual.currentX = x;
      visual.currentY = y;
      visual.startX = x;
      visual.startY = y;
    }
    visual.hasPosition = true;
    this.#applyPosition(visual);
  }

  #ensureAnimationLoop(): void {
    if (this.#disposed || this.#frameHandle !== undefined || this.#rendered.size === 0) {
      return;
    }
    const scheduling = {};
    this.#frameHandle = scheduling;
    const handle = this.#scheduler.requestAnimationFrame(() => {
      const mayScheduleAnotherFrame = this.#frameHandle !== scheduling;
      this.#frameHandle = undefined;
      this.#animate(mayScheduleAnotherFrame);
    });
    if (this.#frameHandle === scheduling) {
      this.#frameHandle = handle;
    }
  }

  #animate(mayScheduleAnotherFrame: boolean): void {
    if (this.#disposed) {
      return;
    }
    const now = this.#now();
    let needsNextFrame = false;
    for (const [key, visual] of this.#rendered) {
      if (
        visual.expiresAt <= now ||
        (visual.lastFrameAt > 0 && now - visual.lastFrameAt >= POINTER_STALE_MS)
      ) {
        this.#remove(key);
        continue;
      }
      if (visual.hasPosition) {
        const factor =
          visual.interpolationDurationMs <= 0
            ? 1
            : Math.min(
                1,
                Math.max(0, (now - visual.frameReceivedLocalAt) / visual.interpolationDurationMs),
              );
        visual.currentX = visual.startX + (visual.targetX - visual.startX) * factor;
        visual.currentY = visual.startY + (visual.targetY - visual.startY) * factor;
        this.#applyPosition(visual);
        needsNextFrame ||=
          factor < 1 && (visual.startX !== visual.targetX || visual.startY !== visual.targetY);
      }
    }
    if (needsNextFrame && mayScheduleAnotherFrame) {
      this.#ensureAnimationLoop();
    }
  }

  #scheduleExpiry(): void {
    if (this.#expiryTimer !== undefined) {
      this.#scheduler.clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    if (this.#disposed || this.#rendered.size === 0) {
      return;
    }
    const now = this.#now();
    let deadline = Number.POSITIVE_INFINITY;
    for (const visual of this.#rendered.values()) {
      deadline = Math.min(
        deadline,
        visual.expiresAt,
        visual.lastFrameAt > 0 ? visual.lastFrameAt + POINTER_STALE_MS : Number.POSITIVE_INFINITY,
      );
    }
    if (!Number.isFinite(deadline)) {
      return;
    }
    this.#expiryTimer = this.#scheduler.setTimeout(
      () => {
        this.#expiryTimer = undefined;
        const observedAt = this.#now();
        for (const [key, visual] of this.#rendered) {
          if (
            visual.expiresAt <= observedAt ||
            (visual.lastFrameAt > 0 && observedAt - visual.lastFrameAt >= POINTER_STALE_MS)
          ) {
            this.#remove(key);
          }
        }
        this.#scheduleExpiry();
      },
      Math.max(0, deadline - now),
    );
  }

  #applyPosition(visual: RemotePointerVisual): void {
    if (!visual.hasPosition) {
      visual.element.hidden = true;
      return;
    }
    visual.element.hidden = false;
    visual.element.style.transform = `translate3d(${String(visual.currentX)}px, ${String(visual.currentY)}px, 0)`;
    const identity = visual.lease ?? visual.legacyRecord;
    if (identity !== null) {
      this.#positions.set(pointerKey(identity), {
        x: visual.currentX,
        y: visual.currentY,
        source: visual.source,
      });
    }
  }
}

function browserScheduler(window: Window): PointerPageScheduler {
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle as number),
  };
}

function pointerKey(identity: PointerIdentity): string {
  return `${identity.userId}:${identity.deviceId}`;
}

function sameRevision(
  left: PointerPageContext["documentRevision"],
  right: PointerPageContext["documentRevision"],
): boolean {
  return left.roomEpoch === right.roomEpoch && left.tabUpdatedAtSeq === right.tabUpdatedAtSeq;
}

function isInsideViewport(window: Window, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
}

function locateLeaseAnchor(
  document: Document,
  window: Window,
  lease: PointerLeaseRecord,
): PointerPosition | null {
  if (lease.anchor === null) {
    return null;
  }
  const target = resolvePointerPath(document, lease.anchor.path);
  if (target === null) {
    return null;
  }
  const rectangle = target.getBoundingClientRect();
  if (rectangle.width <= 0 || rectangle.height <= 0) {
    return null;
  }
  const x = rectangle.left + rectangle.width * lease.anchor.x;
  const y = rectangle.top + rectangle.height * lease.anchor.y;
  return isInsideViewport(window, x, y) ? { x, y, source: "anchor" } : null;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const POINTER_STYLES = `
  :host { all: initial; }
  .syncaction-pointer-overlay {
    position: fixed;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .syncaction-pointer {
    position: absolute;
    left: 0;
    top: 0;
    display: flex;
    align-items: flex-start;
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 18%));
    will-change: transform;
  }
  .syncaction-pointer[hidden] { display: none; }
  .syncaction-pointer-cursor {
    width: 14px;
    height: 18px;
    display: block;
    border: 2px solid white;
    border-radius: 10px 10px 10px 2px;
    background: var(--syncaction-pointer-color);
    transform: translate(-2px, -2px);
  }
  .syncaction-pointer-label {
    max-width: 160px;
    margin: 13px 0 0 2px;
    overflow: hidden;
    padding: 3px 7px;
    border-radius: 999px;
    color: white;
    background: var(--syncaction-pointer-color);
    font: 600 11px/1.25 system-ui, sans-serif;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;
