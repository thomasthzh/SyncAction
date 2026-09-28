import { browser } from "wxt/browser";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import {
  AnnotationCommittedOperationSchema,
  AnnotationStrokeDraftSchema,
  AnnotationStrokeSchema,
  PageCompatibilityReportSchema,
  type AnnotationCommittedOperation,
  type AnnotationCommittedOperationV2,
  type AnnotationStroke,
  type AnnotationStrokeDraft,
  type AnnotationStrokeDraftV2,
  type AnnotationStrokeV2,
} from "@syncaction/protocol";
import {
  DanmakuReportMessageSchema,
  DanmakuSubmitMessageSchema,
  DrawingDraftControlMessageSchema,
  DrawingReportMessageSchema,
  DrawingSelectionMessageSchema,
  ElementAnchorSignatureResponseSchema,
  MediaObservedMessageSchema,
  PageCollaborationInboundMessageSchema,
  PageCapabilityMessageSchema,
  PageReadyMessageSchema,
  PointerSampleMessageSchema,
  StrokeFinalMessageSchema,
  StrokeSampleMessageSchema,
  type CollaborationPageContext,
  type ElementAnchorSignatureRequest,
  type ElementAnchorSignatureResponse,
  type PageCapabilityMessage,
  type PageDisposeReason,
} from "../src/page-collaboration/messages.js";
import {
  createDanmakuRenderingEngine,
  DanmakuPageRuntime,
} from "../src/page-collaboration/danmaku-runtime.js";
import { DrawingPageRuntime } from "../src/page-collaboration/drawing-runtime.js";
import {
  PageOverlayHost,
  installPageCollaborationRuntime,
  type PageOverlayContext,
} from "../src/page-collaboration/page-overlay-host.js";
import { MediaPageRuntime } from "../src/page-collaboration/media-page-runtime.js";
import {
  loadDanmakuRenderingDependency,
  loadDrawingRenderingDependency,
} from "../src/page-collaboration/rendering-dependencies.js";
import {
  computeElementContentSignature,
  PageContentCompatibilityReporter,
} from "../src/page-collaboration/content-signature.js";
import { PointerPageRuntime, resolvePointerPath } from "../src/pointer-page.js";

class PageCollaborationRuntime {
  readonly #host: PageOverlayHost;
  readonly #listener: (
    message: unknown,
  ) => void | Promise<PageCapabilityMessage | ElementAnchorSignatureResponse>;
  readonly #onDispose: () => void;
  #pointer: PointerPageRuntime | undefined;
  #media: MediaPageRuntime | undefined;
  #danmaku: DanmakuPageRuntime | undefined;
  #danmakuPromise: Promise<DanmakuPageRuntime | undefined> | undefined;
  #drawing: DrawingPageRuntime | undefined;
  #drawingPromise: Promise<DrawingPageRuntime | undefined> | undefined;
  #hostContext: PageOverlayContext | undefined;
  #toolContext: CollaborationPageContext | undefined;
  #compatibilityReporter: PageContentCompatibilityReporter | undefined;
  #compatibilityReporterRoomId: string | undefined;
  #toolGeneration = 0;
  #danmakuGeneration = 0;
  #drawingGeneration = 0;
  #disposed = false;

  public constructor(onDispose: () => void) {
    this.#onDispose = onDispose;
    this.#host = new PageOverlayHost({
      document,
      onCapability: (message) => {
        void browser.runtime.sendMessage(PageCapabilityMessageSchema.parse(message));
      },
    });
    this.#listener = (messageInput) => {
      const parsed = PageCollaborationInboundMessageSchema.safeParse(messageInput);
      if (!parsed.success) {
        return;
      }
      const message = parsed.data;
      switch (message.type) {
        case "syncaction.page.announce":
          this.announce();
          break;
        case "syncaction.pointer.context": {
          if (
            !this.#updatePageContext({
              roomId: message.context.roomId,
              logicalTabId: message.context.logicalTabId,
              documentRevision: message.context.documentRevision,
              frameKey: "top",
            })
          ) {
            break;
          }
          this.#pointerRuntime()?.setContext(message.context);
          break;
        }
        case "syncaction.pointer.render":
          this.#pointerRuntime()?.render(message.pointer);
          break;
        case "syncaction.pointer.lease":
          this.#pointerRuntime()?.renderLease(message.lease);
          break;
        case "syncaction.pointer.frame":
          this.#pointerRuntime()?.renderFrame(message.frame);
          break;
        case "syncaction.pointer.clear":
          this.#pointerRuntime()?.clear(message.identity ?? undefined);
          break;
        case "syncaction.media.command": {
          if (
            !this.#updatePageContext({
              roomId: message.context.roomId,
              logicalTabId: message.context.logicalTabId,
              documentRevision: message.context.documentRevision,
              frameKey: message.context.frameKey,
            })
          ) {
            break;
          }
          void this.#mediaRuntime()?.handle(message);
          break;
        }
        case "syncaction.danmaku.command":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDanmaku(message.context, (runtime) => {
            runtime.handleCommand(message.action);
          });
        case "syncaction.danmaku.render":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDanmaku(message.context, (runtime) => {
            runtime.render(message.event);
          });
        case "syncaction.danmaku.status":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDanmaku(message.context, (runtime) => {
            runtime.setStatus({
              status: message.status,
              messageId: message.messageId,
              errorCode: message.errorCode,
            });
          });
        case "syncaction.danmaku.clear":
          this.#clearDanmaku(message.context);
          break;
        case "syncaction.drawing.command":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            if (
              message.action.type === "TOGGLE_PEN" &&
              !runtime.getState().active &&
              !documentOwnsDirectFocus(document)
            ) {
              return;
            }
            runtime.handleCommand(message.action);
          });
        case "syncaction.drawing.state":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            runtime.applyState(message);
          });
        case "syncaction.drawing.viewer":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            runtime.setViewer(message.viewer.userId, message.viewer.role);
          });
        case "syncaction.drawing.clear":
          this.#clearDrawing(message.context);
          break;
        case "syncaction.annotation.snapshot":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            runtime.renderConfirmed(message.snapshot.strokes.map(toLegacyStroke));
          });
        case "syncaction.annotation.delta":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            runtime.applyCommitted(message.delta.operations.map(toLegacyCommitted));
          });
        case "syncaction.annotation.committed":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            runtime.applyCommitted([toLegacyCommitted(message.committed)]);
          });
        case "syncaction.annotation.ack":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            if (
              !message.acknowledgement.accepted ||
              message.acknowledgement.results.some((result) => !result.accepted)
            ) {
              runtime.setDraftStatus(
                message.acknowledgement.clientOpId,
                "ERROR",
                !message.acknowledgement.accepted &&
                  message.acknowledgement.code === "ANNOTATION_PAGE_CAPACITY_REACHED",
              );
            }
          });
        case "syncaction.annotation.draft":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            runtime.renderDraft(toLegacyDraft(message.draft), message.status, message.retryable);
          });
        case "syncaction.annotation.anchor-signature.request":
          return this.#resolveElementAnchorSignature(message);
        case "syncaction.stroke.preview.render":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            runtime.renderPreview(message.preview);
          });
        case "syncaction.stroke.preview.clear":
          if (!this.#updateToolContext(message.context)) {
            break;
          }
          return this.#withDrawing(message.context, (runtime) => {
            runtime.clearPreview(message.clear);
          });
        case "syncaction.media.prompt":
          // The media prompt surface is implemented with the follow-group controller.
          break;
        case "syncaction.page.dispose":
          this.dispose(message.reason);
          break;
      }
    };
    browser.runtime.onMessage.addListener(this.#listener);
  }

  public dispose(reason: PageDisposeReason): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#toolGeneration += 1;
    this.#danmakuGeneration += 1;
    this.#drawingGeneration += 1;
    browser.runtime.onMessage.removeListener(this.#listener);
    this.#compatibilityReporter?.dispose();
    this.#compatibilityReporter = undefined;
    this.#compatibilityReporterRoomId = undefined;
    this.#host.dispose(reason);
    this.#pointer = undefined;
    this.#media = undefined;
    this.#danmaku = undefined;
    this.#danmakuPromise = undefined;
    this.#drawing = undefined;
    this.#drawingPromise = undefined;
    this.#hostContext = undefined;
    this.#toolContext = undefined;
    this.#onDispose();
  }

  public getPageHostCapability(): PageCapabilityMessage {
    return this.#host.getPageHostCapability();
  }

  public announce(): void {
    void browser.runtime
      .sendMessage(
        PageReadyMessageSchema.parse({
          type: "syncaction.page.ready",
        }),
      )
      .catch(() => undefined);
    void browser.runtime.sendMessage(this.getPageHostCapability()).catch(() => undefined);
  }

  #updateToolContext(context: CollaborationPageContext): boolean {
    if (!this.#updatePageContext(context)) {
      return false;
    }
    this.#toolContext = cloneToolContext(context);
    return true;
  }

  #clearDanmaku(context: CollaborationPageContext): void {
    if (
      this.#hostContext === undefined ||
      !sameHostContext(this.#hostContext, context) ||
      (this.#toolContext !== undefined && !sameToolContext(this.#toolContext, context))
    ) {
      return;
    }
    this.#danmakuGeneration += 1;
    this.#danmakuPromise = undefined;
    this.#danmaku?.handleCommand("CLOSE_INPUT");
    this.#danmaku?.clear();
  }

  #clearDrawing(context: CollaborationPageContext): void {
    if (
      this.#hostContext === undefined ||
      !sameHostContext(this.#hostContext, context) ||
      (this.#toolContext !== undefined && !sameToolContext(this.#toolContext, context))
    ) {
      return;
    }
    this.#drawingGeneration += 1;
    this.#drawingPromise = undefined;
    this.#drawing?.handleCommand({ type: "EXIT" });
    this.#drawing?.clear();
  }

  #updatePageContext(context: PageOverlayContext): boolean {
    if (
      this.#hostContext !== undefined &&
      sameLogicalDocument(this.#hostContext, context) &&
      compareDocumentRevision(context, this.#hostContext) < 0
    ) {
      return false;
    }
    if (this.#hostContext !== undefined && !sameHostContext(this.#hostContext, context)) {
      this.#toolGeneration += 1;
      this.#danmakuPromise = undefined;
      this.#drawingPromise = undefined;
    }
    this.#hostContext = cloneHostContext(context);
    this.#host.updateContext({
      roomId: context.roomId,
      logicalTabId: context.logicalTabId,
      documentRevision: context.documentRevision,
      ...(context.frameKey === undefined ? {} : { frameKey: context.frameKey }),
    });
    if ((context.frameKey ?? "top") === "top" && isTopLevelWindow(window)) {
      const reporter = this.#compatibilityReporterFor(context.roomId);
      void reporter
        .setContext({
          logicalTabId: context.logicalTabId,
          documentRevision: context.documentRevision,
        })
        .catch(() => undefined);
    }
    return true;
  }

  async #withDanmaku(
    context: CollaborationPageContext,
    use: (runtime: DanmakuPageRuntime) => void,
  ): Promise<PageCapabilityMessage> {
    const requestGeneration = this.#danmakuGeneration;
    try {
      const runtime = await this.#danmakuRuntime(context);
      if (
        runtime !== undefined &&
        requestGeneration === this.#danmakuGeneration &&
        this.#toolContext !== undefined &&
        sameToolContext(this.#toolContext, context)
      ) {
        runtime.setContext(context);
        use(runtime);
        return this.#toolAvailable("DANMAKU");
      }
      return this.#toolDegraded("DANMAKU", "DANMAKU_RUNTIME_UNAVAILABLE");
    } catch (cause) {
      return this.#toolDegraded(
        "DANMAKU",
        cause instanceof Error && cause.message === "DANMAKU_RUNTIME_LOAD_FAILED"
          ? "DANMAKU_RUNTIME_LOAD_FAILED"
          : "DANMAKU_RUNTIME_FAILED",
      );
    }
  }

  #danmakuRuntime(context: CollaborationPageContext): Promise<DanmakuPageRuntime | undefined> {
    if (this.#host.state !== "ACTIVE" || this.#disposed) {
      return Promise.resolve(undefined);
    }
    if (this.#danmaku !== undefined) {
      return Promise.resolve(this.#danmaku);
    }
    if (this.#danmakuPromise !== undefined) {
      return this.#danmakuPromise;
    }
    const generation = this.#toolGeneration;
    const requestGeneration = this.#danmakuGeneration;
    const pending = loadDanmakuRenderingDependency()
      .then(async (DanmakuConstructor) => {
        if (
          this.#disposed ||
          this.#host.state !== "ACTIVE" ||
          generation !== this.#toolGeneration ||
          requestGeneration !== this.#danmakuGeneration ||
          this.#toolContext === undefined ||
          !sameToolContext(this.#toolContext, context)
        ) {
          return undefined;
        }
        const runtime = new DanmakuPageRuntime({
          document,
          window,
          surface: this.#host.getSurface("danmaku"),
          context,
          createEngine: (container) => createDanmakuRenderingEngine(container, DanmakuConstructor),
          setInteraction: (interaction) => this.#host.setSurfaceInteraction("danmaku", interaction),
          reportState: async (state) => {
            const reportContext = this.#toolContext;
            if (reportContext === undefined || !sameToolContext(reportContext, context)) {
              return;
            }
            await browser.runtime.sendMessage(
              DanmakuReportMessageSchema.parse({
                type: "syncaction.danmaku.report",
                controller: "danmaku",
                context: cloneToolContext(reportContext),
                hidden: state.hidden,
                inputOpen: state.inputOpen,
              }),
            );
          },
          emitSubmit: async (submission) => {
            await browser.runtime.sendMessage(
              DanmakuSubmitMessageSchema.parse({
                type: "syncaction.danmaku.submit",
                controller: "danmaku",
                context: submission.context,
                messageId: submission.messageId,
                text: submission.text,
              }),
            );
          },
        });
        this.#danmaku = runtime;
        this.#host.registerSurfaceController("danmaku", () => {
          runtime.dispose();
          if (this.#danmaku === runtime) {
            this.#danmaku = undefined;
            this.#danmakuPromise = undefined;
          }
        });
        return runtime;
      })
      .catch((cause: unknown) => {
        if (generation === this.#toolGeneration && requestGeneration === this.#danmakuGeneration) {
          this.#danmakuPromise = undefined;
          throw new Error("DANMAKU_RUNTIME_LOAD_FAILED", { cause });
        }
        return undefined;
      });
    this.#danmakuPromise = pending;
    return pending;
  }

  async #withDrawing(
    context: CollaborationPageContext,
    use: (runtime: DrawingPageRuntime) => void,
  ): Promise<PageCapabilityMessage> {
    const requestGeneration = this.#drawingGeneration;
    try {
      const runtime = await this.#drawingRuntime(context);
      if (
        runtime !== undefined &&
        requestGeneration === this.#drawingGeneration &&
        this.#toolContext !== undefined &&
        sameToolContext(this.#toolContext, context)
      ) {
        runtime.setContext(context);
        use(runtime);
        return this.#toolAvailable("DRAWING");
      }
      return this.#toolDegraded("DRAWING", "DRAWING_RUNTIME_UNAVAILABLE");
    } catch (cause) {
      return this.#toolDegraded(
        "DRAWING",
        cause instanceof Error && cause.message === "DRAWING_RUNTIME_LOAD_FAILED"
          ? "DRAWING_RUNTIME_LOAD_FAILED"
          : "DRAWING_RUNTIME_FAILED",
      );
    }
  }

  #drawingRuntime(context: CollaborationPageContext): Promise<DrawingPageRuntime | undefined> {
    if (this.#host.state !== "ACTIVE" || this.#disposed) {
      return Promise.resolve(undefined);
    }
    if (this.#drawing !== undefined) {
      return Promise.resolve(this.#drawing);
    }
    if (this.#drawingPromise !== undefined) {
      return this.#drawingPromise;
    }
    const generation = this.#toolGeneration;
    const requestGeneration = this.#drawingGeneration;
    const pending = loadDrawingRenderingDependency()
      .then(async (getStroke) => {
        if (
          this.#disposed ||
          this.#host.state !== "ACTIVE" ||
          generation !== this.#toolGeneration ||
          requestGeneration !== this.#drawingGeneration ||
          this.#toolContext === undefined ||
          !sameToolContext(this.#toolContext, context)
        ) {
          return undefined;
        }
        const runtime = new DrawingPageRuntime({
          document,
          window,
          surface: this.#host.getSurface("drawing"),
          context,
          getStroke,
          setInteraction: (interaction) => this.#host.setSurfaceInteraction("drawing", interaction),
          reportState: async (state) => {
            const reportContext = this.#toolContext;
            if (reportContext === undefined || !sameToolContext(reportContext, context)) {
              return;
            }
            await browser.runtime.sendMessage(
              DrawingReportMessageSchema.parse({
                type: "syncaction.drawing.report",
                controller: "drawing",
                context: cloneToolContext(reportContext),
                active: state.active,
                tool: state.tool,
                rgb: state.rgb,
                width: state.width,
                selectedCount: state.selectedCount,
                selectedLockedCount: state.selectedLockedCount,
                unlocatableCount: Math.min(2_000, state.unlocatableCount),
              }),
            );
          },
          emitPreview: async (preview) => {
            await browser.runtime.sendMessage(
              StrokeSampleMessageSchema.parse({
                type: "syncaction.stroke.sample",
                controller: "drawing",
                context: cloneToolContext(context),
                preview,
              }),
            );
          },
          emitFinal: async (stroke) => {
            await browser.runtime.sendMessage(
              StrokeFinalMessageSchema.parse({
                type: "syncaction.stroke.final",
                controller: "drawing",
                context: cloneToolContext(context),
                stroke,
              }),
            );
          },
          emitSelection: async (selection) => {
            await browser.runtime.sendMessage(
              DrawingSelectionMessageSchema.parse({
                type: "syncaction.drawing.selection",
                controller: "drawing",
                context: cloneToolContext(context),
                action: selection.action,
                items: selection.items,
              }),
            );
          },
          discardDraft: async (strokeId) => {
            await browser.runtime.sendMessage(
              DrawingDraftControlMessageSchema.parse({
                type: "syncaction.annotation.draft.control",
                controller: "drawing",
                context: cloneToolContext(context),
                action: "DISCARD",
                strokeId,
              }),
            );
          },
          retryDraft: async (strokeId) => {
            await browser.runtime.sendMessage(
              DrawingDraftControlMessageSchema.parse({
                type: "syncaction.annotation.draft.control",
                controller: "drawing",
                context: cloneToolContext(context),
                action: "RETRY",
                strokeId,
              }),
            );
          },
        });
        this.#drawing = runtime;
        this.#host.registerSurfaceController("drawing", () => {
          runtime.dispose();
          if (this.#drawing === runtime) {
            this.#drawing = undefined;
            this.#drawingPromise = undefined;
          }
        });
        return runtime;
      })
      .catch((cause: unknown) => {
        if (generation === this.#toolGeneration && requestGeneration === this.#drawingGeneration) {
          this.#drawingPromise = undefined;
          throw new Error("DRAWING_RUNTIME_LOAD_FAILED", { cause });
        }
        return undefined;
      });
    this.#drawingPromise = pending;
    return pending;
  }

  #toolAvailable(capability: "DANMAKU" | "DRAWING"): PageCapabilityMessage {
    return PageCapabilityMessageSchema.parse({
      type: "syncaction.page.capability",
      capability,
      state: "AVAILABLE",
      errorCode: null,
    });
  }

  #toolDegraded(capability: "DANMAKU" | "DRAWING", errorCode: string): PageCapabilityMessage {
    return PageCapabilityMessageSchema.parse({
      type: "syncaction.page.capability",
      capability,
      state: "DEGRADED",
      errorCode,
    });
  }

  #pointerRuntime(): PointerPageRuntime | undefined {
    if (this.#host.state !== "ACTIVE") {
      return undefined;
    }
    if (this.#pointer !== undefined) {
      return this.#pointer;
    }
    const pointer = new PointerPageRuntime({
      document,
      window,
      surface: this.#host.getSurface("pointer"),
      emitSample: (sample) =>
        browser.runtime.sendMessage(
          PointerSampleMessageSchema.parse({
            type: "syncaction.pointer.sample",
            sample,
          }),
        ),
    });
    this.#pointer = pointer;
    this.#host.registerSurfaceController("pointer", () => {
      pointer.dispose();
      if (this.#pointer === pointer) {
        this.#pointer = undefined;
      }
    });
    return pointer;
  }

  #mediaRuntime(): MediaPageRuntime | undefined {
    if (this.#host.state !== "ACTIVE") {
      return undefined;
    }
    if (this.#media !== undefined) {
      return this.#media;
    }
    const media = new MediaPageRuntime({
      document,
      window,
      surface: this.#host.getSurface("media"),
      readPageUrl: () => window.location.href,
      emitObserved: (message) => {
        void this.#compatibilityReporter
          ?.setMedia(
            message.target === null
              ? null
              : {
                  provider: message.target.provider,
                  mediaKey: message.target.mediaKey,
                },
          )
          .catch(() => undefined);
        void browser.runtime.sendMessage(MediaObservedMessageSchema.parse(message));
      },
      emitCapability: (message) => {
        void browser.runtime.sendMessage(PageCapabilityMessageSchema.parse(message));
      },
    });
    this.#media = media;
    this.#host.registerSurfaceController("media", () => {
      media.dispose();
      if (this.#media === media) {
        this.#media = undefined;
      }
    });
    return media;
  }

  #compatibilityReporterFor(roomId: string): PageContentCompatibilityReporter {
    if (this.#compatibilityReporter !== undefined && this.#compatibilityReporterRoomId === roomId) {
      return this.#compatibilityReporter;
    }
    this.#compatibilityReporter?.dispose();
    const reporter = new PageContentCompatibilityReporter({
      document,
      roomId,
      readPageUrl: () => window.location.href,
      readViewport: () => ({
        widthCssPx: window.innerWidth,
        heightCssPx: window.innerHeight,
      }),
      emit: async (report) => {
        await browser.runtime.sendMessage(PageCompatibilityReportSchema.parse(report));
      },
    });
    this.#compatibilityReporter = reporter;
    this.#compatibilityReporterRoomId = roomId;
    return reporter;
  }

  async #resolveElementAnchorSignature(
    message: ElementAnchorSignatureRequest,
  ): Promise<ElementAnchorSignatureResponse> {
    if (!this.#updateToolContext(message.context)) {
      return ElementAnchorSignatureResponseSchema.parse({
        type: "syncaction.annotation.anchor-signature.response",
        signature: null,
      });
    }
    const element = resolvePointerPath(document, message.path);
    const signature =
      element === null
        ? null
        : await computeElementContentSignature({
            element,
            roomId: message.context.roomId,
            viewport: {
              widthCssPx: window.innerWidth,
              heightCssPx: window.innerHeight,
            },
          });
    return ElementAnchorSignatureResponseSchema.parse({
      type: "syncaction.annotation.anchor-signature.response",
      signature,
    });
  }
}

function toLegacyAnchor<T extends AnnotationStrokeV2["anchor"] | AnnotationStrokeDraftV2["anchor"]>(
  anchor: T,
): T extends { type: "element" } ? { type: "element"; path: T["path"] } : T {
  if (anchor.type !== "element") {
    return structuredClone(anchor) as T extends { type: "element" }
      ? { type: "element"; path: T["path"] }
      : T;
  }
  return {
    type: "element",
    path: structuredClone(anchor.path),
  } as T extends { type: "element" } ? { type: "element"; path: T["path"] } : T;
}

function toLegacyDraft(stroke: AnnotationStrokeDraftV2): AnnotationStrokeDraft {
  const legacy: Record<string, unknown> = structuredClone(stroke);
  Reflect.deleteProperty(legacy, "contentSignature");
  return AnnotationStrokeDraftSchema.parse({
    ...legacy,
    anchor: toLegacyAnchor(stroke.anchor),
  });
}

function toLegacyStroke(stroke: AnnotationStrokeV2): AnnotationStroke {
  const legacy: Record<string, unknown> = structuredClone(stroke);
  Reflect.deleteProperty(legacy, "contentSignature");
  return AnnotationStrokeSchema.parse({
    ...legacy,
    anchor: toLegacyAnchor(stroke.anchor),
  });
}

function toLegacyCommitted(
  committed: AnnotationCommittedOperationV2,
): AnnotationCommittedOperation {
  return AnnotationCommittedOperationSchema.parse({
    ...committed,
    type: "annotation.committed",
    operation:
      committed.operation.type === "stroke.create"
        ? {
            type: "stroke.create",
            stroke: toLegacyDraft(committed.operation.stroke as AnnotationStrokeDraftV2),
          }
        : committed.operation,
  });
}

function cloneHostContext(context: PageOverlayContext): PageOverlayContext {
  return {
    roomId: context.roomId,
    logicalTabId: context.logicalTabId,
    documentRevision: {
      roomEpoch: context.documentRevision.roomEpoch,
      tabUpdatedAtSeq: context.documentRevision.tabUpdatedAtSeq,
    },
    ...(context.frameKey === undefined ? {} : { frameKey: context.frameKey }),
  };
}

function sameHostContext(left: PageOverlayContext, right: PageOverlayContext): boolean {
  return (
    left.roomId === right.roomId &&
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    (left.frameKey ?? "top") === (right.frameKey ?? "top")
  );
}

function sameLogicalDocument(left: PageOverlayContext, right: PageOverlayContext): boolean {
  return (
    left.roomId === right.roomId &&
    left.logicalTabId === right.logicalTabId &&
    (left.frameKey ?? "top") === (right.frameKey ?? "top")
  );
}

function compareDocumentRevision(left: PageOverlayContext, right: PageOverlayContext): number {
  if (left.documentRevision.roomEpoch !== right.documentRevision.roomEpoch) {
    return left.documentRevision.roomEpoch - right.documentRevision.roomEpoch;
  }
  return left.documentRevision.tabUpdatedAtSeq - right.documentRevision.tabUpdatedAtSeq;
}

function cloneToolContext(context: CollaborationPageContext): CollaborationPageContext {
  return {
    roomId: context.roomId,
    logicalTabId: context.logicalTabId,
    documentRevision: {
      roomEpoch: context.documentRevision.roomEpoch,
      tabUpdatedAtSeq: context.documentRevision.tabUpdatedAtSeq,
    },
    frameKey: context.frameKey,
  };
}

function sameToolContext(left: CollaborationPageContext, right: CollaborationPageContext): boolean {
  return (
    left.roomId === right.roomId &&
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey
  );
}

function documentOwnsDirectFocus(documentInput: Document): boolean {
  if (!documentInput.hasFocus()) {
    return false;
  }
  return !(documentInput.activeElement instanceof HTMLIFrameElement);
}

function isTopLevelWindow(windowInput: Window): boolean {
  try {
    return windowInput.top === windowInput;
  } catch {
    return false;
  }
}

export default defineUnlistedScript(() => {
  let uninstall = (): void => undefined;
  const installed = installPageCollaborationRuntime(
    globalThis as unknown as Record<string, unknown>,
    () => new PageCollaborationRuntime(() => uninstall()),
  );
  uninstall = installed.uninstall;
  installed.runtime.announce();
});
