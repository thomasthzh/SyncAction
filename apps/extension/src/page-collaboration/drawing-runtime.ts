import {
  AnnotationCommittedOperationSchema,
  AnnotationRgbSchema,
  AnnotationStrokeDraftSchema,
  AnnotationStrokeSchema,
  CanonicalUuidSchema,
  NormalizedPointSchema,
  StrokePreviewEventMessageSchema,
  StrokePreviewUpdateSchema,
  type AnnotationAnchor,
  type AnnotationCommittedOperation,
  type AnnotationMutationTarget,
  type AnnotationRgb,
  type AnnotationStroke,
  type AnnotationStrokeDraft,
  type NormalizedPoint,
  type StrokePreviewEventMessage,
  type StrokePreviewUpdate,
} from "@syncaction/protocol";
import type { getStroke } from "perfect-freehand";
import {
  captureAnnotationAnchor,
  normalizeAnnotationPoint,
  projectAnnotationPoint,
  resolveAnnotationAnchor,
  type AnnotationAnchorEnvironment,
} from "./anchors.js";
import {
  CollaborationPageContextSchema,
  DrawingCommandActionSchema,
  type CollaborationPageContext,
} from "./messages.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_FINAL_POINTS = 2_048;
const MAX_PREVIEW_POINTS = 512;

export type DrawingTool = "PEN" | "ERASER" | "SELECT";
export type DrawingRole = "OWNER" | "MEMBER";
export type DrawingDraftStatus = "PENDING" | "ERROR";
export type DrawingSelectionAction = "DELETE" | "LOCK" | "UNLOCK";

export interface DrawingSelectionIntent {
  action: DrawingSelectionAction;
  items: AnnotationMutationTarget[];
}

export interface DrawingPointerSample {
  pointerId: number;
  clientX: number;
  clientY: number;
  pressure: number;
  pointerType?: string;
  target?: Element;
}

export interface DrawingPageScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  requestAnimationFrame(callback: () => void): unknown;
  cancelAnimationFrame(handle: unknown): void;
}

export interface DrawingPageRuntimeOptions {
  document: Document;
  window: Window;
  surface: HTMLElement;
  context: CollaborationPageContext;
  currentUserId?: string;
  role?: DrawingRole;
  getStroke: typeof getStroke;
  emitPreview: (preview: StrokePreviewUpdate) => void | Promise<void>;
  emitFinal: (draft: AnnotationStrokeDraft) => void | Promise<void>;
  emitSelection: (selection: DrawingSelectionIntent) => void | Promise<void>;
  discardDraft?: (strokeId: string) => void | Promise<void>;
  retryDraft?: (strokeId: string) => void | Promise<void>;
  createId?: () => string;
  scheduler?: DrawingPageScheduler;
  now?: () => number;
  elementAtPoint?: (clientX: number, clientY: number) => Element | null;
  identifyMedia?: AnnotationAnchorEnvironment["identifyMedia"];
  resolveMedia?: AnnotationAnchorEnvironment["resolveMedia"];
  setInteraction?: (interaction: { active: boolean; capturesInput: boolean }) => void;
  reportState?: (state: {
    active: boolean;
    tool: DrawingTool;
    rgb: AnnotationRgb;
    width: number;
    selectedCount: number;
    selectedLockedCount: number;
    unlocatableCount: number;
    pendingDraftCount: number;
    errorDraftCount: number;
  }) => void | Promise<void>;
}

interface LocalDraft {
  draft: AnnotationStrokeDraft;
  status: DrawingDraftStatus;
  retryable: boolean;
  durability: "UNPERSISTED" | "DURABLE";
}

interface ActivePenStroke {
  pointerId: number;
  previewId: string;
  anchor: AnnotationAnchor;
  points: NormalizedPoint[];
}

interface ActiveSelection {
  pointerId: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface RenderedGeometry {
  path: SVGPathElement;
  screenPoints: Array<{ x: number; y: number }>;
  bounds: DrawingRectangle | null;
  located: boolean;
}

interface DrawingRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class DrawingPageRuntime {
  readonly #document: Document;
  readonly #window: Window;
  readonly #surface: HTMLElement;
  #currentUserId: string | null;
  #role: DrawingRole;
  readonly #getStroke: typeof getStroke;
  readonly #emitPreview: (preview: StrokePreviewUpdate) => void | Promise<void>;
  readonly #emitFinal: (draft: AnnotationStrokeDraft) => void | Promise<void>;
  readonly #emitSelection: (selection: DrawingSelectionIntent) => void | Promise<void>;
  readonly #discardDraft: ((strokeId: string) => void | Promise<void>) | undefined;
  readonly #retryDraft: ((strokeId: string) => void | Promise<void>) | undefined;
  readonly #createId: () => string;
  readonly #scheduler: DrawingPageScheduler;
  readonly #now: () => number;
  readonly #elementAtPoint: (clientX: number, clientY: number) => Element | null;
  readonly #setInteraction: (interaction: { active: boolean; capturesInput: boolean }) => void;
  readonly #reportState:
    | ((state: {
        active: boolean;
        tool: DrawingTool;
        rgb: AnnotationRgb;
        width: number;
        selectedCount: number;
        selectedLockedCount: number;
        unlocatableCount: number;
        pendingDraftCount: number;
        errorDraftCount: number;
      }) => void | Promise<void>)
    | undefined;
  readonly #anchorEnvironment: AnnotationAnchorEnvironment;
  readonly #style: HTMLStyleElement;
  readonly #root: HTMLDivElement;
  readonly #svg: SVGSVGElement;
  readonly #confirmedLayer: SVGGElement;
  readonly #draftLayer: SVGGElement;
  readonly #previewLayer: SVGGElement;
  readonly #selectionLayer: SVGGElement;
  readonly #notice: HTMLParagraphElement;
  readonly #confirmed = new Map<string, AnnotationStroke>();
  readonly #drafts = new Map<string, LocalDraft>();
  readonly #previews = new Map<string, StrokePreviewEventMessage>();
  readonly #previewTimers = new Map<string, unknown>();
  readonly #renderedConfirmed = new Map<string, RenderedGeometry>();
  readonly #renderedDrafts = new Map<string, RenderedGeometry>();
  readonly #renderedPreviews = new Map<string, RenderedGeometry>();
  readonly #selected = new Set<string>();
  readonly #pointerDownListener: (event: Event) => void;
  readonly #pointerMoveListener: (event: Event) => void;
  readonly #pointerUpListener: (event: Event) => void;
  readonly #pointerCancelListener: (event: Event) => void;
  readonly #repositionListener: () => void;
  #context: CollaborationPageContext;
  #tool: DrawingTool = "PEN";
  #rgb: AnnotationRgb = { r: 0, g: 122, b: 255 };
  #width = 6;
  #active = false;
  #activePen: ActivePenStroke | null = null;
  #activeSelection: ActiveSelection | null = null;
  #toolbar: HTMLDivElement | null = null;
  #lasso: SVGRectElement | null = null;
  #frameHandle: unknown;
  #framePending = false;
  #previewFrameHandle: unknown;
  #previewFramePending = false;
  #unlocatableCount = 0;
  #lastReportSignature = "";
  #disposed = false;

  public constructor(options: DrawingPageRuntimeOptions) {
    this.#document = options.document;
    this.#window = options.window;
    this.#surface = options.surface;
    if (this.#surface.ownerDocument !== this.#document) {
      throw new Error("DRAWING_SURFACE_DOCUMENT_MISMATCH");
    }
    this.#context = CollaborationPageContextSchema.parse(options.context);
    this.#currentUserId =
      options.currentUserId === undefined ? null : CanonicalUuidSchema.parse(options.currentUserId);
    this.#role = options.role ?? "MEMBER";
    this.#getStroke = options.getStroke;
    this.#emitPreview = options.emitPreview;
    this.#emitFinal = options.emitFinal;
    this.#emitSelection = options.emitSelection;
    this.#discardDraft = options.discardDraft;
    this.#retryDraft = options.retryDraft;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#scheduler = options.scheduler ?? browserScheduler(this.#window);
    this.#now = options.now ?? Date.now;
    this.#elementAtPoint =
      options.elementAtPoint ??
      ((clientX, clientY) => this.#readUnderlyingElement(clientX, clientY));
    this.#setInteraction =
      options.setInteraction ??
      ((interaction) => {
        this.#surface.dataset.active = interaction.active ? "true" : "false";
        this.#surface.style.pointerEvents =
          interaction.active && interaction.capturesInput ? "auto" : "none";
      });
    this.#reportState = options.reportState;
    this.#anchorEnvironment = {
      document: this.#document,
      window: this.#window,
      frameKey: this.#context.frameKey,
      ...(options.identifyMedia === undefined ? {} : { identifyMedia: options.identifyMedia }),
      ...(options.resolveMedia === undefined ? {} : { resolveMedia: options.resolveMedia }),
    };

    this.#style = this.#document.createElement("style");
    this.#style.textContent = DRAWING_STYLES;
    this.#root = this.#document.createElement("div");
    this.#root.className = "syncaction-drawing-root";
    this.#svg = this.#document.createElementNS(SVG_NAMESPACE, "svg");
    this.#svg.classList.add("syncaction-drawing-canvas");
    this.#svg.setAttribute("aria-label", "页面涂鸦");
    this.#confirmedLayer = createSvgGroup(this.#document, "confirmed");
    this.#draftLayer = createSvgGroup(this.#document, "draft");
    this.#previewLayer = createSvgGroup(this.#document, "preview");
    this.#selectionLayer = createSvgGroup(this.#document, "selection");
    this.#svg.append(
      this.#confirmedLayer,
      this.#draftLayer,
      this.#previewLayer,
      this.#selectionLayer,
    );
    this.#notice = this.#document.createElement("p");
    this.#notice.className = "syncaction-drawing-notice";
    this.#notice.setAttribute("role", "status");
    this.#notice.setAttribute("aria-live", "polite");
    this.#root.append(this.#svg, this.#notice);
    this.#surface.append(this.#style, this.#root);

    this.#pointerDownListener = (event) => {
      if (
        this.#toolbar !== null &&
        (event as PointerEvent).composedPath().includes(this.#toolbar)
      ) {
        return;
      }
      this.beginStroke(pointerSample(event as PointerEvent));
    };
    this.#pointerMoveListener = (event) =>
      this.continueStroke(pointerSample(event as PointerEvent));
    this.#pointerUpListener = (event) => this.endStroke(pointerSample(event as PointerEvent));
    this.#pointerCancelListener = () => this.#cancelGesture();
    this.#repositionListener = () => this.#scheduleReproject();
    this.#surface.addEventListener("pointerdown", this.#pointerDownListener);
    this.#surface.addEventListener("pointermove", this.#pointerMoveListener);
    this.#surface.addEventListener("pointerup", this.#pointerUpListener);
    this.#surface.addEventListener("pointercancel", this.#pointerCancelListener);
    this.#window.addEventListener("scroll", this.#repositionListener, {
      passive: true,
      capture: true,
    });
    this.#window.addEventListener("resize", this.#repositionListener, { passive: true });
    this.#refreshInteraction();
  }

  public setContext(contextInput: CollaborationPageContext): void {
    if (this.#disposed) {
      return;
    }
    const context = CollaborationPageContextSchema.parse(contextInput);
    if (!sameContext(context, this.#context)) {
      this.clear();
      this.#exit();
    }
    this.#context = context;
    this.#anchorEnvironment.frameKey = context.frameKey;
  }

  public handleCommand(actionInput: unknown): void {
    if (this.#disposed) {
      return;
    }
    const action = DrawingCommandActionSchema.parse(actionInput);
    switch (action.type) {
      case "TOGGLE_PEN":
        if (this.#active) {
          this.#exit();
        } else {
          this.#active = true;
          this.#mountToolbar();
          this.#refreshInteraction();
        }
        break;
      case "EXIT":
        this.#exit();
        break;
      case "SET_TOOL":
        this.#tool = action.tool;
        this.#cancelGesture();
        this.#syncToolbar();
        break;
      case "SET_STYLE":
        this.#rgb = AnnotationRgbSchema.parse(action.rgb);
        this.#width = action.width;
        this.#syncToolbar();
        break;
    }
    this.#emitStateReport();
  }

  public applyState(state: {
    active: boolean;
    tool: DrawingTool;
    rgb: AnnotationRgb;
    width: number;
  }): void {
    if (this.#disposed) {
      return;
    }
    this.#tool = state.tool;
    this.#rgb = AnnotationRgbSchema.parse(state.rgb);
    const style = DrawingCommandActionSchema.parse({
      type: "SET_STYLE",
      rgb: state.rgb,
      width: state.width,
    });
    if (style.type !== "SET_STYLE") {
      throw new Error("INVALID_DRAWING_STATE");
    }
    this.#width = style.width;
    if (state.active) {
      this.#active = true;
      this.#mountToolbar();
      this.#syncToolbar();
      this.#refreshInteraction();
      this.#emitStateReport();
      return;
    }
    this.#exit();
  }

  public setViewer(userIdInput: string, role: DrawingRole): void {
    this.#currentUserId = CanonicalUuidSchema.parse(userIdInput);
    this.#role = role;
    this.#renderAll();
  }

  public beginStroke(sampleInput: DrawingPointerSample): void {
    if (this.#disposed || !this.#active || !validPointerSample(sampleInput)) {
      return;
    }
    const sample = normalizePointerPressure(sampleInput);
    if (this.#tool === "ERASER") {
      const target = this.hitTest(sample.clientX, sample.clientY);
      if (target !== null && canDelete(target, this.#currentUserId, this.#role)) {
        this.#emitSelectionIntent("DELETE", [target]);
      }
      return;
    }
    if (this.#tool === "SELECT") {
      this.#activeSelection = {
        pointerId: sample.pointerId,
        startX: sample.clientX,
        startY: sample.clientY,
        endX: sample.clientX,
        endY: sample.clientY,
      };
      this.#renderLasso();
      return;
    }

    const target = sample.target ?? this.#elementAtPoint(sample.clientX, sample.clientY);
    if (target instanceof HTMLIFrameElement) {
      this.#notice.textContent = "此框架未授权，无法绘制";
      return;
    }
    const anchor = captureAnnotationAnchor(this.#anchorEnvironment, target);
    if (anchor === null) {
      this.#notice.textContent = "当前区域无法建立安全锚点";
      return;
    }
    const resolution = resolveAnnotationAnchor(this.#anchorEnvironment, {
      anchor,
      frameKey: this.#context.frameKey,
    });
    if (resolution.state !== "LOCATED") {
      this.#notice.textContent = "当前区域无法定位";
      return;
    }
    const previewId = this.#createId();
    this.#activePen = {
      pointerId: sample.pointerId,
      previewId,
      anchor,
      points: [
        normalizeAnnotationPoint(
          resolution.rectangle,
          sample.clientX,
          sample.clientY,
          sample.pressure,
        ),
      ],
    };
    this.#scheduleActivePreview();
  }

  public continueStroke(sampleInput: DrawingPointerSample): void {
    if (this.#disposed || !this.#active || !validPointerSample(sampleInput)) {
      return;
    }
    const sample = normalizePointerPressure(sampleInput);
    if (this.#activeSelection !== null && this.#activeSelection.pointerId === sample.pointerId) {
      this.#activeSelection.endX = sample.clientX;
      this.#activeSelection.endY = sample.clientY;
      this.#renderLasso();
      return;
    }
    const active = this.#activePen;
    if (active === null || active.pointerId !== sample.pointerId) {
      return;
    }
    const resolution = resolveAnnotationAnchor(this.#anchorEnvironment, {
      anchor: active.anchor,
      frameKey: this.#context.frameKey,
    });
    if (resolution.state !== "LOCATED") {
      return;
    }
    active.points.push(
      normalizeAnnotationPoint(
        resolution.rectangle,
        sample.clientX,
        sample.clientY,
        sample.pressure,
      ),
    );
    this.#scheduleActivePreview();
  }

  public endStroke(sampleInput: DrawingPointerSample): void {
    if (this.#disposed || !validPointerSample(sampleInput)) {
      return;
    }
    const sample = normalizePointerPressure(sampleInput);
    if (this.#activeSelection !== null && this.#activeSelection.pointerId === sample.pointerId) {
      this.#activeSelection.endX = sample.clientX;
      this.#activeSelection.endY = sample.clientY;
      const rectangle = selectionRectangle(this.#activeSelection);
      this.#activeSelection = null;
      this.#lasso?.remove();
      this.#lasso = null;
      this.selectRectangle(rectangle);
      return;
    }
    const active = this.#activePen;
    if (active === null || active.pointerId !== sample.pointerId) {
      return;
    }
    const resolution = resolveAnnotationAnchor(this.#anchorEnvironment, {
      anchor: active.anchor,
      frameKey: this.#context.frameKey,
    });
    if (resolution.state === "LOCATED") {
      active.points.push(
        normalizeAnnotationPoint(
          resolution.rectangle,
          sample.clientX,
          sample.clientY,
          sample.pressure,
        ),
      );
    }
    this.#emitActivePreview();
    const draft = createProtocolSafeDraft({
      strokeId: active.previewId,
      frameKey: this.#context.frameKey,
      anchor: active.anchor,
      points: active.points,
      rgb: this.#rgb,
      width: this.#width,
    });
    this.#activePen = null;
    const local: LocalDraft = {
      draft,
      status: "PENDING",
      retryable: false,
      durability: "UNPERSISTED",
    };
    this.#drafts.set(draft.strokeId, local);
    this.#renderAll();
    void Promise.resolve(this.#emitFinal(structuredClone(draft))).then(
      () => {
        if (this.#drafts.get(draft.strokeId) === local) {
          local.durability = "DURABLE";
        }
      },
      () => {
        if (this.#drafts.get(draft.strokeId) === local) {
          local.status = "ERROR";
          local.retryable = true;
          this.#renderAll();
        }
      },
    );
  }

  public renderConfirmed(strokesInput: readonly AnnotationStroke[]): void {
    if (this.#disposed) {
      return;
    }
    const unpersistedDrafts = new Map(
      [...this.#drafts].filter(([, local]) => local.durability === "UNPERSISTED"),
    );
    this.#confirmed.clear();
    this.#drafts.clear();
    for (const strokeInput of strokesInput) {
      const parsed = AnnotationStrokeSchema.safeParse(strokeInput);
      if (
        parsed.success &&
        parsed.data.deletedAtServerMs === null &&
        parsed.data.frameKey === this.#context.frameKey
      ) {
        this.#confirmed.set(parsed.data.strokeId, parsed.data);
        unpersistedDrafts.delete(parsed.data.strokeId);
      }
    }
    for (const [strokeId, local] of unpersistedDrafts) {
      this.#drafts.set(strokeId, local);
    }
    this.#selected.forEach((strokeId) => {
      if (!this.#confirmed.has(strokeId)) {
        this.#selected.delete(strokeId);
      }
    });
    this.#renderAll();
  }

  public applyCommitted(operationsInput: readonly AnnotationCommittedOperation[]): void {
    if (this.#disposed) {
      return;
    }
    for (const operationInput of operationsInput) {
      const parsed = AnnotationCommittedOperationSchema.safeParse(operationInput);
      if (!parsed.success || parsed.data.roomId !== this.#context.roomId) {
        continue;
      }
      const committed = parsed.data;
      const acceptedVersions = new Map(
        committed.results
          .filter((result) => result.accepted)
          .map((result) => [result.strokeId, result.version] as const),
      );
      if (committed.operation.type === "stroke.create") {
        const draft = committed.operation.stroke;
        const version = acceptedVersions.get(draft.strokeId);
        if (version === undefined || draft.frameKey !== this.#context.frameKey) {
          continue;
        }
        const stroke = AnnotationStrokeSchema.safeParse({
          ...draft,
          authorUserId: committed.actorUserId,
          lockedAtServerMs: null,
          version,
          createdAtServerMs: committed.createdAtServerMs,
          deletedAtServerMs: null,
        });
        if (stroke.success) {
          this.#confirmed.set(stroke.data.strokeId, stroke.data);
          this.#drafts.delete(stroke.data.strokeId);
        }
        continue;
      }
      for (const target of committed.operation.items) {
        const version = acceptedVersions.get(target.strokeId);
        if (version === undefined) {
          continue;
        }
        const stroke = this.#confirmed.get(target.strokeId);
        if (committed.operation.type === "stroke.delete") {
          this.#confirmed.delete(target.strokeId);
          this.#drafts.delete(target.strokeId);
          this.#selected.delete(target.strokeId);
          continue;
        }
        if (stroke === undefined) {
          continue;
        }
        this.#confirmed.set(target.strokeId, {
          ...stroke,
          version,
          lockedAtServerMs:
            committed.operation.type === "stroke.lock" ? committed.createdAtServerMs : null,
        });
      }
    }
    this.#renderAll();
  }

  public renderDraft(
    draftInput: AnnotationStrokeDraft,
    status: DrawingDraftStatus,
    retryable = false,
  ): void {
    if (this.#disposed) {
      return;
    }
    const draft = AnnotationStrokeDraftSchema.parse(draftInput);
    if (draft.frameKey !== this.#context.frameKey) {
      return;
    }
    this.#drafts.set(draft.strokeId, {
      draft,
      status,
      retryable: status === "ERROR" && retryable,
      durability: "DURABLE",
    });
    this.#renderAll();
  }

  public setDraftStatus(strokeId: string, status: DrawingDraftStatus, retryable = false): void {
    const local = this.#drafts.get(strokeId);
    if (local === undefined) {
      return;
    }
    local.status = status;
    local.retryable = status === "ERROR" && retryable;
    this.#renderAll();
  }

  public renderPreview(previewInput: StrokePreviewEventMessage): void {
    if (this.#disposed) {
      return;
    }
    const parsed = StrokePreviewEventMessageSchema.safeParse(previewInput);
    if (
      !parsed.success ||
      !previewMatchesContext(parsed.data, this.#context) ||
      parsed.data.expiresAtServerMs <= this.#now()
    ) {
      return;
    }
    const key = previewKey(parsed.data);
    this.#clearPreviewKey(key);
    this.#previews.set(key, parsed.data);
    this.#previewTimers.set(
      key,
      this.#scheduler.setTimeout(
        () => this.#expirePreview(key),
        Math.max(0, parsed.data.expiresAtServerMs - this.#now()),
      ),
    );
    this.#renderAll();
  }

  public clearPreview(input: {
    previewId: string;
    sender: { userId: string; deviceId: string };
  }): void {
    this.#clearPreviewKey(`${input.sender.userId}:${input.sender.deviceId}:${input.previewId}`);
    this.#renderAll();
  }

  public hitTest(clientX: number, clientY: number): AnnotationStroke | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return null;
    }
    const strokes = [...this.#confirmed.values()].reverse();
    for (const stroke of strokes) {
      const rendered = this.#renderedConfirmed.get(stroke.strokeId);
      if (
        rendered?.located === true &&
        polylineDistance(rendered.screenPoints, clientX, clientY) <= stroke.width / 2 + 10
      ) {
        return stroke;
      }
    }
    return null;
  }

  public selectRectangle(rectangleInput: DrawingRectangle): string[] {
    const rectangle = normalizeRectangle(rectangleInput);
    this.#selected.clear();
    for (const stroke of this.#confirmed.values()) {
      const rendered = this.#renderedConfirmed.get(stroke.strokeId);
      if (
        rendered?.located === true &&
        rendered.bounds !== null &&
        rectanglesIntersect(rectangle, rendered.bounds)
      ) {
        this.#selected.add(stroke.strokeId);
      }
    }
    this.#renderAll();
    return [...this.#selected];
  }

  public requestSelectionAction(action: DrawingSelectionAction): void {
    const targets = [...this.#selected]
      .map((strokeId) => this.#confirmed.get(strokeId))
      .filter((stroke): stroke is AnnotationStroke => stroke !== undefined)
      .filter((stroke) => {
        if (action === "DELETE") {
          return canDelete(stroke, this.#currentUserId, this.#role);
        }
        if (action === "LOCK") {
          return stroke.authorUserId === this.#currentUserId && stroke.lockedAtServerMs === null;
        }
        return stroke.authorUserId === this.#currentUserId && stroke.lockedAtServerMs !== null;
      });
    this.#emitSelectionIntent(action, targets);
  }

  public async undoUnsubmitted(): Promise<string | null> {
    const local = [...this.#drafts.values()].at(-1);
    if (local === undefined) {
      return null;
    }
    if (this.#discardDraft === undefined) {
      throw new Error("ANNOTATION_DRAFT_CONTROL_UNAVAILABLE");
    }
    await this.#discardDraft(local.draft.strokeId);
    if (this.#drafts.get(local.draft.strokeId) === local) {
      this.#drafts.delete(local.draft.strokeId);
      this.#renderAll();
    }
    return local.draft.strokeId;
  }

  public async retryFailed(): Promise<string | null> {
    const local = [...this.#drafts.values()]
      .reverse()
      .find((candidate) => candidate.status === "ERROR" && candidate.retryable);
    if (local === undefined) {
      return null;
    }
    if (local.durability === "UNPERSISTED") {
      local.status = "PENDING";
      local.retryable = false;
      this.#renderAll();
      try {
        await this.#emitFinal(structuredClone(local.draft));
      } catch (cause) {
        if (this.#drafts.get(local.draft.strokeId) === local) {
          local.status = "ERROR";
          local.retryable = true;
          this.#renderAll();
        }
        throw cause;
      }
      if (this.#drafts.get(local.draft.strokeId) === local) {
        local.durability = "DURABLE";
      }
      return local.draft.strokeId;
    }
    if (this.#retryDraft === undefined) {
      throw new Error("ANNOTATION_DRAFT_CONTROL_UNAVAILABLE");
    }
    await this.#retryDraft(local.draft.strokeId);
    if (this.#drafts.get(local.draft.strokeId) === local) {
      local.status = "PENDING";
      local.retryable = false;
      this.#renderAll();
    }
    return local.draft.strokeId;
  }

  public getState(): {
    active: boolean;
    tool: DrawingTool;
    rgb: AnnotationRgb;
    width: number;
    selectedStrokeIds: string[];
    selectedLockedCount: number;
    unlocatableCount: number;
    pendingDraftCount: number;
    errorDraftCount: number;
  } {
    return {
      active: this.#active,
      tool: this.#tool,
      rgb: { ...this.#rgb },
      width: this.#width,
      selectedStrokeIds: [...this.#selected],
      selectedLockedCount: this.#selectedLockedCount(),
      unlocatableCount: this.#unlocatableCount,
      pendingDraftCount: [...this.#drafts.values()].filter((draft) => draft.status === "PENDING")
        .length,
      errorDraftCount: [...this.#drafts.values()].filter((draft) => draft.status === "ERROR")
        .length,
    };
  }

  public clear(): void {
    this.#confirmed.clear();
    this.#drafts.clear();
    for (const timer of this.#previewTimers.values()) {
      this.#scheduler.clearTimeout(timer);
    }
    this.#previewTimers.clear();
    this.#previews.clear();
    this.#selected.clear();
    this.#cancelGesture();
    this.#renderAll();
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#surface.removeEventListener("pointerdown", this.#pointerDownListener);
    this.#surface.removeEventListener("pointermove", this.#pointerMoveListener);
    this.#surface.removeEventListener("pointerup", this.#pointerUpListener);
    this.#surface.removeEventListener("pointercancel", this.#pointerCancelListener);
    this.#window.removeEventListener("scroll", this.#repositionListener, true);
    this.#window.removeEventListener("resize", this.#repositionListener);
    if (this.#frameHandle !== undefined) {
      this.#scheduler.cancelAnimationFrame(this.#frameHandle);
    }
    if (this.#previewFrameHandle !== undefined) {
      this.#scheduler.cancelAnimationFrame(this.#previewFrameHandle);
    }
    this.#exit();
    this.clear();
    this.#style.remove();
    this.#root.remove();
    this.#setInteraction({ active: false, capturesInput: false });
  }

  #renderAll(): void {
    this.#confirmedLayer.replaceChildren();
    this.#draftLayer.replaceChildren();
    this.#previewLayer.replaceChildren();
    this.#renderedConfirmed.clear();
    this.#renderedDrafts.clear();
    this.#renderedPreviews.clear();
    this.#unlocatableCount = 0;

    for (const stroke of this.#confirmed.values()) {
      const rendered = this.#renderGeometry({
        id: stroke.strokeId,
        anchor: stroke.anchor,
        frameKey: stroke.frameKey,
        points: stroke.points,
        rgb: stroke.rgb,
        width: stroke.width,
        status: "confirmed",
        locked: stroke.lockedAtServerMs !== null,
        ownerOverride:
          this.#role === "OWNER" &&
          stroke.lockedAtServerMs !== null &&
          stroke.authorUserId !== this.#currentUserId,
        selected: this.#selected.has(stroke.strokeId),
        attribute: "data-stroke-id",
      });
      this.#confirmedLayer.append(rendered.path);
      this.#renderedConfirmed.set(stroke.strokeId, rendered);
    }
    for (const local of this.#drafts.values()) {
      const rendered = this.#renderGeometry({
        id: local.draft.strokeId,
        anchor: local.draft.anchor,
        frameKey: local.draft.frameKey,
        points: local.draft.points,
        rgb: local.draft.rgb,
        width: local.draft.width,
        status: local.status === "PENDING" ? "pending" : "error",
        locked: false,
        ownerOverride: false,
        selected: false,
        attribute: "data-stroke-id",
      });
      this.#draftLayer.append(rendered.path);
      this.#renderedDrafts.set(local.draft.strokeId, rendered);
    }
    for (const [key, preview] of this.#previews) {
      const rendered = this.#renderGeometry({
        id: preview.previewId,
        anchor: preview.anchor,
        frameKey: preview.frameKey,
        points: preview.points,
        rgb: preview.rgb,
        width: preview.width,
        status: "preview",
        locked: false,
        ownerOverride: false,
        selected: false,
        attribute: "data-preview-id",
      });
      this.#previewLayer.append(rendered.path);
      this.#renderedPreviews.set(key, rendered);
    }
    const errors = [...this.#drafts.values()].filter((draft) => draft.status === "ERROR").length;
    this.#notice.textContent =
      errors > 0
        ? `${String(errors)} 条涂鸦未发送`
        : this.#unlocatableCount > 0
          ? `${String(this.#unlocatableCount)} 条涂鸦无法定位`
          : "";
    this.#syncToolbar();
    this.#refreshInteraction();
    const pendingDraftCount = [...this.#drafts.values()].filter(
      (draft) => draft.status === "PENDING",
    ).length;
    this.#emitStateReport(pendingDraftCount, errors);
  }

  #emitStateReport(
    pendingDraftCount = [...this.#drafts.values()].filter((draft) => draft.status === "PENDING")
      .length,
    errorDraftCount = [...this.#drafts.values()].filter((draft) => draft.status === "ERROR").length,
  ): void {
    if (this.#disposed) {
      return;
    }
    const report = {
      active: this.#active,
      tool: this.#tool,
      rgb: { ...this.#rgb },
      width: this.#width,
      selectedCount: this.#selected.size,
      selectedLockedCount: this.#selectedLockedCount(),
      unlocatableCount: this.#unlocatableCount,
      pendingDraftCount,
      errorDraftCount,
    };
    const signature = JSON.stringify(report);
    if (signature !== this.#lastReportSignature) {
      this.#lastReportSignature = signature;
      void Promise.resolve(this.#reportState?.(report)).catch(() => undefined);
    }
  }

  #selectedLockedCount(): number {
    let count = 0;
    for (const strokeId of this.#selected) {
      const stroke = this.#confirmed.get(strokeId);
      if (stroke !== undefined && stroke.lockedAtServerMs !== null) {
        count += 1;
      }
    }
    return count;
  }

  #renderGeometry(input: {
    id: string;
    anchor: AnnotationAnchor;
    frameKey: string;
    points: readonly NormalizedPoint[];
    rgb: AnnotationRgb;
    width: number;
    status: "confirmed" | "pending" | "error" | "preview";
    locked: boolean;
    ownerOverride: boolean;
    selected: boolean;
    attribute: "data-stroke-id" | "data-preview-id";
  }): RenderedGeometry {
    const path = this.#document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute(input.attribute, input.id);
    path.dataset.status = input.status;
    path.dataset.locked = input.locked ? "true" : "false";
    path.dataset.width = String(input.width);
    if (input.ownerOverride) {
      path.dataset.ownerOverride = "true";
    }
    if (input.selected) {
      path.dataset.selected = "true";
    }
    const color = rgbCss(input.rgb);
    path.setAttribute("fill", color);
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "1");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    path.setAttribute(
      "aria-label",
      input.locked ? "已锁定涂鸦" : input.status === "error" ? "未发送涂鸦" : "页面涂鸦",
    );
    const resolution = resolveAnnotationAnchor(this.#anchorEnvironment, {
      anchor: input.anchor,
      frameKey: input.frameKey,
    });
    if (resolution.state !== "LOCATED") {
      path.setAttribute("hidden", "");
      this.#unlocatableCount += 1;
      return { path, screenPoints: [], bounds: null, located: false };
    }
    const screenPoints = input.points.map((point) =>
      projectAnnotationPoint(resolution, NormalizedPointSchema.parse(point)),
    );
    const outline = this.#getStroke(
      screenPoints.map((point) => [point.x, point.y, point.pressure]),
      {
        size: input.width,
        thinning: 0.45,
        smoothing: 0.65,
        streamline: 0.5,
        simulatePressure: false,
        last: input.status !== "preview",
      },
    );
    path.setAttribute("d", outlinePath(outline));
    return {
      path,
      screenPoints,
      bounds: pointBounds(screenPoints, input.width / 2),
      located: true,
    };
  }

  #emitActivePreview(): void {
    const active = this.#activePen;
    if (active === null || active.points.length === 0) {
      return;
    }
    const preview = StrokePreviewUpdateSchema.parse({
      type: "stroke.preview.update",
      protocolVersion: 1,
      previewId: active.previewId,
      ...this.#context,
      anchor: active.anchor,
      points: resampleDrawingPoints(active.points, MAX_PREVIEW_POINTS).map(quantizePoint),
      rgb: this.#rgb,
      width: this.#width,
    });
    void Promise.resolve(this.#emitPreview(preview)).catch(() => undefined);
  }

  #expirePreview(key: string): void {
    const preview = this.#previews.get(key);
    if (preview === undefined) {
      return;
    }
    const remaining = preview.expiresAtServerMs - this.#now();
    if (remaining > 0) {
      this.#previewTimers.set(
        key,
        this.#scheduler.setTimeout(() => this.#expirePreview(key), remaining),
      );
      return;
    }
    this.#clearPreviewKey(key);
    this.#renderAll();
  }

  #clearPreviewKey(key: string): void {
    const timer = this.#previewTimers.get(key);
    if (timer !== undefined) {
      this.#scheduler.clearTimeout(timer);
      this.#previewTimers.delete(key);
    }
    this.#previews.delete(key);
  }

  #scheduleActivePreview(): void {
    if (this.#previewFramePending || this.#disposed) {
      return;
    }
    this.#previewFramePending = true;
    this.#previewFrameHandle = this.#scheduler.requestAnimationFrame(() => {
      this.#previewFramePending = false;
      this.#previewFrameHandle = undefined;
      this.#emitActivePreview();
    });
  }

  #scheduleReproject(): void {
    if (this.#framePending || this.#disposed) {
      return;
    }
    this.#framePending = true;
    this.#frameHandle = this.#scheduler.requestAnimationFrame(() => {
      this.#framePending = false;
      this.#frameHandle = undefined;
      this.#renderAll();
    });
  }

  #emitSelectionIntent(action: DrawingSelectionAction, strokes: AnnotationStroke[]): void {
    if (strokes.length === 0) {
      return;
    }
    const intent: DrawingSelectionIntent = {
      action,
      items: strokes.map((stroke) => ({
        strokeId: stroke.strokeId,
        expectedVersion: stroke.version,
      })),
    };
    void Promise.resolve(this.#emitSelection(intent)).catch(() => undefined);
  }

  #renderLasso(): void {
    const active = this.#activeSelection;
    if (active === null) {
      return;
    }
    if (this.#lasso === null) {
      this.#lasso = this.#document.createElementNS(SVG_NAMESPACE, "rect");
      this.#lasso.classList.add("syncaction-selection-lasso");
      this.#selectionLayer.append(this.#lasso);
    }
    const rectangle = selectionRectangle(active);
    this.#lasso.setAttribute("x", String(rectangle.left));
    this.#lasso.setAttribute("y", String(rectangle.top));
    this.#lasso.setAttribute("width", String(rectangle.right - rectangle.left));
    this.#lasso.setAttribute("height", String(rectangle.bottom - rectangle.top));
  }

  #mountToolbar(): void {
    if (this.#toolbar !== null) {
      return;
    }
    const toolbar = this.#document.createElement("div");
    toolbar.className = "syncaction-drawing-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "页面画笔工具");
    for (const [tool, label] of [
      ["PEN", "画笔"],
      ["ERASER", "橡皮擦"],
      ["SELECT", "框选"],
    ] as const) {
      const button = toolbarButton(this.#document, label);
      button.dataset.tool = tool;
      button.addEventListener("click", () => this.handleCommand({ type: "SET_TOOL", tool }));
      toolbar.append(button);
    }
    const color = this.#document.createElement("input");
    color.type = "color";
    color.setAttribute("aria-label", "画笔颜色");
    color.addEventListener("input", () => {
      const rgb = parseHexColor(color.value);
      if (rgb !== null) {
        this.handleCommand({ type: "SET_STYLE", rgb, width: this.#width });
      }
    });
    const width = this.#document.createElement("input");
    width.type = "range";
    width.min = "1";
    width.max = "32";
    width.step = "1";
    width.setAttribute("aria-label", "画笔粗细");
    width.addEventListener("input", () => {
      this.handleCommand({
        type: "SET_STYLE",
        rgb: this.#rgb,
        width: Number(width.value),
      });
    });
    const lock = toolbarButton(this.#document, "锁定选中");
    lock.addEventListener("click", () => this.requestSelectionAction("LOCK"));
    const unlock = toolbarButton(this.#document, "解锁选中");
    unlock.addEventListener("click", () => this.requestSelectionAction("UNLOCK"));
    const remove = toolbarButton(this.#document, "删除选中");
    remove.addEventListener("click", () => this.requestSelectionAction("DELETE"));
    const undo = toolbarButton(this.#document, "撤销未提交");
    undo.addEventListener("click", () => {
      void this.undoUnsubmitted().catch(() => {
        this.#notice.textContent = "无法撤销：本地草稿尚未安全删除";
      });
    });
    const retry = toolbarButton(this.#document, "重试未发送");
    retry.addEventListener("click", () => {
      void this.retryFailed().catch(() => {
        this.#notice.textContent = "重试失败：本地草稿仍已保留";
      });
    });
    const exit = toolbarButton(this.#document, "退出画笔");
    exit.addEventListener("click", () => this.handleCommand({ type: "EXIT" }));
    toolbar.append(color, width, lock, unlock, remove, undo, retry, exit);
    this.#root.append(toolbar);
    this.#toolbar = toolbar;
    this.#syncToolbar();
  }

  #syncToolbar(): void {
    const toolbar = this.#toolbar;
    if (toolbar === null) {
      return;
    }
    toolbar.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.tool === this.#tool ? "true" : "false");
    });
    const color = toolbar.querySelector<HTMLInputElement>('input[type="color"]');
    if (color !== null) {
      color.value = rgbHex(this.#rgb);
    }
    const width = toolbar.querySelector<HTMLInputElement>('input[type="range"]');
    if (width !== null) {
      width.value = String(this.#width);
    }
    const hasSelection = this.#selected.size > 0;
    for (const label of ["锁定选中", "解锁选中", "删除选中"]) {
      const button = toolbar.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
      if (button !== null) {
        button.disabled = !hasSelection;
      }
    }
    const undo = toolbar.querySelector<HTMLButtonElement>('[aria-label="撤销未提交"]');
    if (undo !== null) {
      undo.disabled = this.#drafts.size === 0;
    }
    const retry = toolbar.querySelector<HTMLButtonElement>('[aria-label="重试未发送"]');
    if (retry !== null) {
      retry.disabled = ![...this.#drafts.values()].some(
        (draft) => draft.status === "ERROR" && draft.retryable,
      );
    }
  }

  #cancelGesture(): void {
    this.#activePen = null;
    this.#activeSelection = null;
    this.#lasso?.remove();
    this.#lasso = null;
  }

  #exit(): void {
    this.#active = false;
    this.#cancelGesture();
    this.#toolbar?.remove();
    this.#toolbar = null;
    this.#refreshInteraction();
    this.#emitStateReport();
  }

  #refreshInteraction(): void {
    const hasContent = this.#confirmed.size > 0 || this.#drafts.size > 0 || this.#previews.size > 0;
    this.#setInteraction({
      active: this.#active || hasContent,
      capturesInput: this.#active,
    });
    this.#svg.style.pointerEvents = this.#active ? "auto" : "none";
  }

  #readUnderlyingElement(clientX: number, clientY: number): Element | null {
    const previous = this.#surface.style.pointerEvents;
    this.#surface.style.pointerEvents = "none";
    try {
      const target = this.#document.elementFromPoint(clientX, clientY);
      return target === this.#document.documentElement || target === this.#document.body
        ? null
        : target;
    } finally {
      this.#surface.style.pointerEvents = previous;
    }
  }
}

export function resampleDrawingPoints(
  pointsInput: readonly NormalizedPoint[],
  maximumPoints: number,
): NormalizedPoint[] {
  if (!Number.isSafeInteger(maximumPoints) || maximumPoints < 1) {
    throw new Error("INVALID_DRAWING_POINT_LIMIT");
  }
  const points = pointsInput.map((point) => NormalizedPointSchema.parse(point));
  if (points.length <= maximumPoints) {
    return points.map((point) => ({ ...point }));
  }
  if (maximumPoints === 1) {
    return [{ ...points[0]! }];
  }
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    cumulative.push(
      cumulative[index - 1]! + Math.hypot(current.x - previous.x, current.y - previous.y),
    );
  }
  const total = cumulative.at(-1)!;
  if (total === 0) {
    return Array.from({ length: maximumPoints }, (_, index) => ({
      ...(index === maximumPoints - 1 ? points.at(-1)! : points[0]!),
    }));
  }
  const result: NormalizedPoint[] = [{ ...points[0]! }];
  let segment = 1;
  for (let index = 1; index < maximumPoints - 1; index += 1) {
    const distance = (total * index) / (maximumPoints - 1);
    while (segment < cumulative.length - 1 && cumulative[segment]! < distance) {
      segment += 1;
    }
    const beforeDistance = cumulative[segment - 1]!;
    const afterDistance = cumulative[segment]!;
    const ratio =
      afterDistance === beforeDistance
        ? 0
        : (distance - beforeDistance) / (afterDistance - beforeDistance);
    const before = points[segment - 1]!;
    const after = points[segment]!;
    result.push(
      NormalizedPointSchema.parse({
        x: interpolate(before.x, after.x, ratio),
        y: interpolate(before.y, after.y, ratio),
        pressure: interpolate(before.pressure, after.pressure, ratio),
      }),
    );
  }
  result.push({ ...points.at(-1)! });
  return result;
}

function createProtocolSafeDraft(input: {
  strokeId: string;
  frameKey: string;
  anchor: AnnotationAnchor;
  points: readonly NormalizedPoint[];
  rgb: AnnotationRgb;
  width: number;
}): AnnotationStrokeDraft {
  let maximumPoints = Math.min(MAX_FINAL_POINTS, input.points.length);
  while (maximumPoints >= 1) {
    const candidate = AnnotationStrokeDraftSchema.safeParse({
      ...input,
      points: resampleDrawingPoints(input.points, maximumPoints).map(quantizePoint),
    });
    if (candidate.success) {
      return candidate.data;
    }
    if (maximumPoints === 1) {
      throw candidate.error;
    }
    maximumPoints = Math.max(1, Math.floor(maximumPoints * 0.8));
  }
  throw new Error("DRAWING_STROKE_CANNOT_FIT_PROTOCOL");
}

function quantizePoint(point: NormalizedPoint): NormalizedPoint {
  return NormalizedPointSchema.parse({
    x: quantizeCoordinate(point.x),
    y: quantizeCoordinate(point.y),
    pressure: quantizeCoordinate(point.pressure),
  });
}

function quantizeCoordinate(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function createSvgGroup(document: Document, layer: string): SVGGElement {
  const group = document.createElementNS(SVG_NAMESPACE, "g");
  group.dataset.layer = layer;
  return group;
}

function outlinePath(outline: Array<readonly [number, number]>): string {
  if (outline.length === 0) {
    return "";
  }
  return `${outline
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${roundCoordinate(x)} ${roundCoordinate(y)}`)
    .join(" ")} Z`;
}

function pointBounds(
  points: Array<{ x: number; y: number }>,
  padding: number,
): DrawingRectangle | null {
  if (points.length === 0) {
    return null;
  }
  return {
    left: Math.min(...points.map((point) => point.x)) - padding,
    top: Math.min(...points.map((point) => point.y)) - padding,
    right: Math.max(...points.map((point) => point.x)) + padding,
    bottom: Math.max(...points.map((point) => point.y)) + padding,
  };
}

function polylineDistance(points: Array<{ x: number; y: number }>, x: number, y: number): number {
  if (points.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (points.length === 1) {
    return Math.hypot(x - points[0]!.x, y - points[0]!.y);
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    minimum = Math.min(minimum, pointToSegmentDistance(x, y, points[index - 1]!, points[index]!));
  }
  return minimum;
}

function pointToSegmentDistance(
  x: number,
  y: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(x - start.x, y - start.y);
  }
  const ratio = Math.min(1, Math.max(0, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared));
  return Math.hypot(x - (start.x + ratio * dx), y - (start.y + ratio * dy));
}

function previewKey(preview: StrokePreviewEventMessage): string {
  return `${preview.sender.userId}:${preview.sender.deviceId}:${preview.previewId}`;
}

function previewMatchesContext(
  preview: StrokePreviewEventMessage,
  context: CollaborationPageContext,
): boolean {
  return (
    preview.roomId === context.roomId &&
    preview.logicalTabId === context.logicalTabId &&
    preview.documentRevision.roomEpoch === context.documentRevision.roomEpoch &&
    preview.documentRevision.tabUpdatedAtSeq === context.documentRevision.tabUpdatedAtSeq &&
    preview.frameKey === context.frameKey
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

function canDelete(stroke: AnnotationStroke, userId: string | null, role: DrawingRole): boolean {
  return stroke.lockedAtServerMs === null || stroke.authorUserId === userId || role === "OWNER";
}

function validPointerSample(sample: DrawingPointerSample): boolean {
  return (
    Number.isSafeInteger(sample.pointerId) &&
    sample.pointerId >= 0 &&
    Number.isFinite(sample.clientX) &&
    Number.isFinite(sample.clientY) &&
    Number.isFinite(sample.pressure)
  );
}

function normalizePointerPressure(sample: DrawingPointerSample): DrawingPointerSample {
  return {
    ...sample,
    pressure: Math.min(1, Math.max(0, sample.pressure || 0.5)),
  };
}

function pointerSample(event: PointerEvent): DrawingPointerSample {
  return {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    pressure: event.pressure,
    pointerType: event.pointerType,
  };
}

function selectionRectangle(selection: ActiveSelection): DrawingRectangle {
  return normalizeRectangle({
    left: selection.startX,
    top: selection.startY,
    right: selection.endX,
    bottom: selection.endY,
  });
}

function normalizeRectangle(rectangle: DrawingRectangle): DrawingRectangle {
  return {
    left: Math.min(rectangle.left, rectangle.right),
    top: Math.min(rectangle.top, rectangle.bottom),
    right: Math.max(rectangle.left, rectangle.right),
    bottom: Math.max(rectangle.top, rectangle.bottom),
  };
}

function rectanglesIntersect(left: DrawingRectangle, right: DrawingRectangle): boolean {
  return !(
    left.right < right.left ||
    left.left > right.right ||
    left.bottom < right.top ||
    left.top > right.bottom
  );
}

function toolbarButton(document: Document, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.textContent = label;
  return button;
}

function rgbCss(rgb: AnnotationRgb): string {
  return `rgb(${String(rgb.r)} ${String(rgb.g)} ${String(rgb.b)})`;
}

function rgbHex(rgb: AnnotationRgb): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("")}`;
}

function parseHexColor(value: string): AnnotationRgb | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  if (match === null) {
    return null;
  }
  return AnnotationRgbSchema.parse({
    r: Number.parseInt(match[1]!, 16),
    g: Number.parseInt(match[2]!, 16),
    b: Number.parseInt(match[3]!, 16),
  });
}

function browserScheduler(window: Window): DrawingPageScheduler {
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle as number),
  };
}

function interpolate(start: number, end: number, ratio: number): number {
  return start + (end - start) * ratio;
}

function roundCoordinate(value: number): string {
  return String(Math.round(value * 100) / 100);
}

const DRAWING_STYLES = `
  :host, .syncaction-drawing-root, .syncaction-drawing-root * {
    box-sizing: border-box;
  }
  .syncaction-drawing-root {
    position: fixed;
    inset: 0;
    overflow: hidden;
    color: white;
    pointer-events: none;
    font: 500 12px/1.35 ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .syncaction-drawing-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    touch-action: none;
  }
  [data-status="pending"] {
    opacity: 0.62;
    stroke-dasharray: 5 4;
  }
  [data-status="error"] {
    opacity: 0.78;
    stroke: rgb(255 79 92);
    stroke-width: 2;
    stroke-dasharray: 3 3;
  }
  [data-status="preview"] {
    opacity: 0.5;
  }
  [data-selected="true"] {
    filter: drop-shadow(0 0 4px rgb(89 166 255));
  }
  [data-locked="true"] {
    filter: drop-shadow(0 0 3px rgb(255 204 64));
  }
  .syncaction-selection-lasso {
    fill: rgb(66 153 255 / 12%);
    stroke: rgb(93 171 255);
    stroke-width: 1.5;
    stroke-dasharray: 5 4;
  }
  .syncaction-drawing-toolbar {
    position: absolute;
    left: 50%;
    bottom: max(20px, env(safe-area-inset-bottom));
    display: flex;
    max-width: calc(100vw - 24px);
    align-items: center;
    gap: 5px;
    overflow-x: auto;
    padding: 8px;
    border: 1px solid rgb(255 255 255 / 18%);
    border-radius: 16px;
    background: rgb(20 24 34 / 88%);
    box-shadow: 0 14px 44px rgb(0 0 0 / 24%);
    pointer-events: auto;
    transform: translateX(-50%);
    backdrop-filter: blur(20px) saturate(1.2);
  }
  .syncaction-drawing-toolbar button,
  .syncaction-drawing-toolbar input {
    min-width: 34px;
    min-height: 34px;
  }
  .syncaction-drawing-toolbar button {
    appearance: none;
    padding: 6px 9px;
    border: 1px solid rgb(255 255 255 / 14%);
    border-radius: 10px;
    color: white;
    background: rgb(255 255 255 / 8%);
    font: inherit;
  }
  .syncaction-drawing-toolbar button[aria-pressed="true"] {
    border-color: rgb(105 174 255 / 75%);
    background: rgb(45 124 226 / 62%);
  }
  .syncaction-drawing-toolbar button:focus-visible,
  .syncaction-drawing-toolbar input:focus-visible {
    outline: 3px solid rgb(91 156 255 / 72%);
    outline-offset: 2px;
  }
  .syncaction-drawing-toolbar button:disabled {
    opacity: 0.45;
  }
  .syncaction-drawing-notice {
    position: absolute;
    top: 12px;
    left: 50%;
    margin: 0;
    padding: 5px 9px;
    border-radius: 999px;
    color: white;
    background: rgb(20 24 34 / 84%);
    pointer-events: none;
    transform: translateX(-50%);
  }
  .syncaction-drawing-notice:empty {
    display: none;
  }
  @media (prefers-reduced-transparency: reduce) {
    .syncaction-drawing-toolbar,
    .syncaction-drawing-notice {
      background: rgb(20 24 34);
      backdrop-filter: none;
    }
  }
  @media (forced-colors: active) {
    .syncaction-drawing-toolbar,
    .syncaction-drawing-toolbar button,
    .syncaction-drawing-notice {
      border: 1px solid CanvasText;
      color: CanvasText;
      background: Canvas;
    }
  }
`;
