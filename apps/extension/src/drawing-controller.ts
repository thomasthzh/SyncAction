import {
  AnnotationAckV2Schema,
  AnnotationCommittedOperationV2Schema,
  AnnotationDeltaV2MessageSchema,
  AnnotationErrorCodeSchema,
  AnnotationOperationV2Schema,
  AnnotationSnapshotV2MessageSchema,
  AnnotationStrokeDraftSchema,
  AnnotationStrokeDraftV2Schema,
  ContentSignatureSchema,
  CollaborationFrameKeySchema,
  CanonicalUuidSchema,
  ClientOpIdSchema,
  RoomIdSchema,
  StrokePreviewClearMessageSchema,
  StrokePreviewClearSchema,
  StrokePreviewEventMessageSchema,
  StrokePreviewUpdateSchema,
  serializedAnnotationStrokeBytes,
  type AnnotationAckV2,
  type AnnotationBatchItemResult,
  type AnnotationCommittedOperationV2,
  type AnnotationItemErrorCode,
  type AnnotationOperationV2,
  type AnnotationSnapshotV2Message,
  type AnnotationStrokeV2,
  type AnnotationStrokeDraftV2,
  type ContentSignature,
  type PointerPathSegment,
  type RoomId,
  type StrokePreviewClearMessage,
  type StrokePreviewEventMessage,
} from "@syncaction/protocol";
import type { DurableReplica } from "@syncaction/replica";
import { z } from "zod";
import { type AnnotationReplica, type AnnotationReplicaRecord } from "./annotation-replica.js";
import {
  CollaborationPageContextSchema,
  DrawingDraftControlMessageSchema,
  DrawingSelectionMessageSchema,
  PageCapabilityReportSchema,
  StrokeFinalMessageSchema,
  StrokeSampleMessageSchema,
  type CollaborationPageContext,
  type DrawingDraftControlMessage,
  type DrawingSelectionMessage,
  type PageCapabilityReport,
  type StrokeFinalMessage,
  type StrokeSampleMessage,
} from "./page-collaboration/messages.js";
import type {
  AnnotationMessage,
  AnnotationMessageHandler,
  CollaborationTransport,
  StrokePreviewMessage,
  StrokePreviewMessageHandler,
} from "./socket-transport.js";

const LocalTabIdSchema = z.number().int().nonnegative().safe();
const FrameIdSchema = z.number().int().nonnegative().safe();
const BrowserSessionIdSchema = z.string().uuid();
const RoomRoleSchema = z.enum(["OWNER", "MEMBER"]);
const MAX_LIVE_STROKES = 2_000;
const MAX_LIVE_BYTES = 5 * 1024 * 1024;
const NEAR_CAPACITY_RATIO = 0.9;

export interface DrawingControllerPagePort {
  setDrawingViewer(
    tabId: number,
    context: CollaborationPageContext,
    viewer: { userId: string; role: "OWNER" | "MEMBER" },
  ): Promise<void>;
  renderAnnotationSnapshot(
    tabId: number,
    context: CollaborationPageContext,
    snapshot: AnnotationSnapshotV2Message,
  ): Promise<void>;
  renderAnnotationCommitted(
    tabId: number,
    context: CollaborationPageContext,
    committed: AnnotationCommittedOperationV2,
  ): Promise<void>;
  renderAnnotationAcknowledgement(
    tabId: number,
    context: CollaborationPageContext,
    acknowledgement: AnnotationAckV2,
  ): Promise<void>;
  renderLocalDraft(
    tabId: number,
    context: CollaborationPageContext,
    draft: AnnotationStrokeDraftV2,
    status: "PENDING" | "ERROR",
    retryable: boolean,
  ): Promise<void>;
  renderStrokePreview(
    tabId: number,
    context: CollaborationPageContext,
    preview: StrokePreviewEventMessage,
  ): Promise<void>;
  clearStrokePreview(
    tabId: number,
    context: CollaborationPageContext,
    clear: StrokePreviewClearMessage,
  ): Promise<void>;
  clearDrawing(tabId: number, context: CollaborationPageContext): Promise<void>;
  resolveElementAnchorSignature(
    tabId: number,
    context: CollaborationPageContext,
    path: readonly PointerPathSegment[],
  ): Promise<ContentSignature | null>;
}

export interface DrawingContentSignaturePort {
  getLocalContentSignature(context: CollaborationPageContext): ContentSignature | null;
}

export interface DrawingControllerOptions {
  roomId: unknown;
  userId: unknown;
  roomRole: unknown;
  browserSessionId: unknown;
  replica: Pick<DurableReplica, "getRecord">;
  annotations: AnnotationReplica;
  contentSignatures: DrawingContentSignaturePort;
  transport: Pick<
    CollaborationTransport,
    | "setAnnotationHandler"
    | "setStrokePreviewHandler"
    | "synchronizeAnnotations"
    | "submitAnnotation"
    | "publishStrokePreview"
    | "clearStrokePreview"
  >;
  page: DrawingControllerPagePort;
  createId?: () => string;
}

export interface DrawingPageReport {
  context: CollaborationPageContext;
  active: boolean;
  tool: "PEN" | "ERASER" | "SELECT";
  rgb: { r: number; g: number; b: number };
  width: number;
  selectedCount: number;
  selectedLockedCount: number;
  unlocatableCount: number;
}

export interface DrawingControllerStatus {
  state: "OFFLINE" | "SYNCING" | "ONLINE" | "DEGRADED";
  errorCode: string | null;
  pageKey: string | null;
  used: number;
  capacity: number;
  lockedCount: number;
  capacityState: "AVAILABLE" | "NEAR_LIMIT" | "FULL";
  canCreate: boolean;
  pendingDraftCount: number;
  errorDraftCount: number;
  unlocatableCount: number;
  ready: boolean;
  canRetry: boolean;
  active: boolean;
  tool: "PEN" | "ERASER" | "SELECT";
  rgb: { r: number; g: number; b: number };
  width: number;
  selectedCount: number;
  selectedLockedCount: number;
}

interface DrawingRoute {
  tabId: number;
  frameId: number;
  context: CollaborationPageContext;
  pageKey: string | undefined;
  generation: number;
}

interface QueuedPreview {
  route: DrawingRoute;
  update: ReturnType<typeof StrokePreviewUpdateSchema.parse>;
  generation: number;
}

type DrawingPageDeliveryResult = "APPLIED" | "REACHABLE_DEGRADED" | "UNREACHABLE" | "STALE";

export class DrawingController {
  readonly #roomId: RoomId;
  readonly #userId: string;
  readonly #roomRole: "OWNER" | "MEMBER";
  readonly #browserSessionId: string;
  readonly #replica: Pick<DurableReplica, "getRecord">;
  readonly #annotations: AnnotationReplica;
  readonly #contentSignatures: DrawingContentSignaturePort;
  readonly #transport: DrawingControllerOptions["transport"];
  readonly #page: DrawingControllerPagePort;
  readonly #createId: () => string;
  #synchronized = false;
  #syncing = false;
  #permissionBlocked = false;
  #activeTabId: number | undefined;
  #route: DrawingRoute | undefined;
  readonly #routes = new Map<number, DrawingRoute>();
  readonly #knownFramesByTab = new Map<number, Map<number, string>>();
  readonly #rootGenerationByTab = new Map<number, number>();
  readonly #capabilityFailures = new Map<string, string>();
  readonly #unavailableFrames = new Map<string, string>();
  #generation = 0;
  #pageTail: Promise<void> = Promise.resolve();
  #operationDrain: Promise<void> = Promise.resolve();
  #operationDraining = false;
  #operationDrainRequested = false;
  #activeSubmission: { clientOpId: string; pageKey: string } | undefined;
  #previewDrain: Promise<void> = Promise.resolve();
  #previewDraining = false;
  #queuedPreview: QueuedPreview | undefined;
  #errorCode: DrawingControllerStatus["errorCode"] = null;
  #used = 0;
  #lockedCount = 0;
  #capacityState: DrawingControllerStatus["capacityState"] = "AVAILABLE";
  #pendingDraftCount = 0;
  #errorDraftCount = 0;
  #unlocatableCount = 0;
  readonly #unlocatableByFrame = new Map<number, number>();
  #active = false;
  #tool: DrawingControllerStatus["tool"] = "PEN";
  #rgb = { r: 0, g: 122, b: 255 };
  #width = 6;
  #selectedCount = 0;
  #selectedLockedCount = 0;

  public constructor(options: DrawingControllerOptions) {
    this.#roomId = RoomIdSchema.parse(options.roomId);
    this.#userId = CanonicalUuidSchema.parse(options.userId);
    this.#roomRole = RoomRoleSchema.parse(options.roomRole);
    this.#browserSessionId = BrowserSessionIdSchema.parse(options.browserSessionId);
    this.#replica = options.replica;
    this.#annotations = options.annotations;
    this.#contentSignatures = options.contentSignatures;
    this.#transport = options.transport;
    this.#page = options.page;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  public setSynchronized(synchronized: boolean): Promise<void> {
    if (synchronized === this.#synchronized) {
      return this.whenIdle();
    }
    this.#synchronized = synchronized;
    this.#generation += 1;
    const generation = this.#generation;
    if (!synchronized) {
      this.#transport.setAnnotationHandler(undefined);
      this.#transport.setStrokePreviewHandler(undefined);
      this.#queuedPreview = undefined;
      this.#syncing = false;
      return this.whenIdle();
    }
    if (!this.#permissionBlocked) {
      this.#errorCode = null;
    }
    const annotationHandler: AnnotationMessageHandler = (message) => {
      this.#enqueuePage(() => this.#handleAnnotationMessage(message, generation));
    };
    const previewHandler: StrokePreviewMessageHandler = (message) => {
      this.#enqueuePage(() => this.#handlePreviewMessage(message, generation));
    };
    this.#transport.setAnnotationHandler(annotationHandler);
    this.#transport.setStrokePreviewHandler(previewHandler);
    if (this.#activeTabId !== undefined && !this.#permissionBlocked) {
      this.#enqueuePage(() => this.#refreshRoute(this.#activeTabId!, generation));
    }
    return this.whenIdle();
  }

  public handleActiveTabChanged(tabIdInput: unknown): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    this.#activeTabId = tabId;
    if (this.#synchronized && !this.#permissionBlocked) {
      const generation = this.#generation;
      this.#enqueuePage(() => this.#refreshRoute(tabId, generation));
    } else if (this.#route !== undefined && this.#route.tabId !== tabId) {
      this.#enqueuePage(() => this.#clearRoute());
    }
    return this.whenIdle();
  }

  public handleBindingsChanged(): Promise<void> {
    if (this.#synchronized && this.#activeTabId !== undefined && !this.#permissionBlocked) {
      this.#generation += 1;
      const generation = this.#generation;
      this.#transport.setAnnotationHandler((message) => {
        this.#enqueuePage(() => this.#handleAnnotationMessage(message, generation));
      });
      this.#transport.setStrokePreviewHandler((message) => {
        this.#enqueuePage(() => this.#handlePreviewMessage(message, generation));
      });
      this.#enqueuePage(() => this.#refreshRoute(this.#activeTabId!, generation));
    }
    return this.whenIdle();
  }

  public handlePageReady(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
    rootGenerationInput?: unknown,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const frameKey = CollaborationFrameKeySchema.parse(frameKeyInput);
    const rootGeneration =
      rootGenerationInput === undefined
        ? (this.#rootGenerationByTab.get(tabId) ?? 1)
        : z.number().int().positive().safe().parse(rootGenerationInput);
    const existingFrames = this.#knownFramesByTab.get(tabId);
    const sameRoot = this.#rootGenerationByTab.get(tabId) === rootGeneration;
    const sameKnownFrame = sameRoot && existingFrames?.get(frameId) === frameKey;
    if (!sameRoot) {
      this.#clearTabUnavailableFrames(tabId);
    }
    this.#unavailableFrames.delete(pageFrameKey(tabId, frameId));
    const frames = sameRoot
      ? (existingFrames ?? new Map<number, string>())
      : new Map<number, string>();
    frames.set(frameId, frameKey);
    if (!sameKnownFrame) {
      this.#clearFrameCapabilityFailures(tabId, frameId);
    } else {
      this.#capabilityFailures.delete(pageCapabilityKey(tabId, frameId, "DRAWING"));
    }
    this.#knownFramesByTab.set(tabId, frames);
    this.#rootGenerationByTab.set(tabId, rootGeneration);
    if (frameId === 0) {
      this.#permissionBlocked = false;
      if (this.#errorCode === "PAGE_TOOL_PERMISSION_REQUIRED") {
        this.#errorCode = null;
      }
    }
    if (this.#synchronized && this.#activeTabId === tabId && !this.#permissionBlocked) {
      const generation = this.#generation;
      this.#enqueuePage(() => this.#refreshRoute(tabId, generation));
    }
    return this.whenIdle();
  }

  public handlePageUnavailable(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const frameKey = CollaborationFrameKeySchema.parse(frameKeyInput);
    const frames = this.#knownFramesByTab.get(tabId);
    if (frames?.get(frameId) !== frameKey) {
      return this.whenIdle();
    }
    const routes =
      frameId === 0
        ? [...this.#routes.values()].filter((route) => route.tabId === tabId)
        : [this.#routes.get(frameId)].filter(
            (route): route is DrawingRoute =>
              route !== undefined && route.tabId === tabId && route.context.frameKey === frameKey,
          );
    if (frameId === 0) {
      this.#knownFramesByTab.delete(tabId);
      this.#rootGenerationByTab.delete(tabId);
      this.#clearTabCapabilityFailures(tabId);
      this.#clearTabUnavailableFrames(tabId);
      this.#permissionBlocked = this.#activeTabId === tabId;
      this.#route = this.#route?.tabId === tabId ? undefined : this.#route;
      for (const route of routes) {
        this.#routes.delete(route.frameId);
      }
      this.#unlocatableByFrame.clear();
    } else {
      this.#unavailableFrames.set(pageFrameKey(tabId, frameId), frameKey);
      frames.delete(frameId);
      this.#clearFrameCapabilityFailures(tabId, frameId);
      if (frames.size === 0) {
        this.#knownFramesByTab.delete(tabId);
      }
      for (const route of routes) {
        this.#routes.delete(route.frameId);
      }
      this.#unlocatableByFrame.delete(frameId);
    }
    this.#unlocatableCount = [...this.#unlocatableByFrame.values()].reduce(
      (total, count) => total + count,
      0,
    );
    this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
    return this.#enqueuePage(async () => {
      await Promise.all(routes.map((route) => this.#clearOneRoute(route)));
    });
  }

  public handleStrokeSample(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: StrokeSampleMessage,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const message = StrokeSampleMessageSchema.parse(messageInput);
    const generation = this.#generation;
    return this.#enqueuePage(async () => {
      const route = this.#matchingRoute(tabId, frameId, message.context, generation);
      if (route === undefined) {
        return;
      }
      this.#queuedPreview = {
        route,
        update: StrokePreviewUpdateSchema.parse(message.preview),
        generation,
      };
      this.#startPreviewDrain();
    });
  }

  public handleStrokeFinal(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: StrokeFinalMessage,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const message = StrokeFinalMessageSchema.parse(messageInput);
    const generation = this.#generation;
    return this.#enqueuePageResult(async () => {
      const route = this.#matchingLocalRoute(tabId, frameId, message.context, generation);
      if (route?.pageKey === undefined || this.#permissionBlocked) {
        throw new Error("ANNOTATION_FINAL_ROUTE_STALE");
      }
      const capacityFull = this.#capacityState === "FULL";
      const unsignedDraft = AnnotationStrokeDraftSchema.parse(message.stroke);
      const contentSignature = this.#contentSignatures.getLocalContentSignature(route.context);
      if (contentSignature === null) {
        throw new Error("CONTENT_UNKNOWN");
      }
      const anchor =
        unsignedDraft.anchor.type === "element"
          ? {
              ...unsignedDraft.anchor,
              anchorSignature: await this.#page.resolveElementAnchorSignature(
                route.tabId,
                route.context,
                unsignedDraft.anchor.path,
              ),
            }
          : unsignedDraft.anchor;
      if (anchor.type === "element" && anchor.anchorSignature === null) {
        throw new Error("CONTENT_UNKNOWN");
      }
      const draft = AnnotationStrokeDraftV2Schema.parse({
        ...unsignedDraft,
        anchor,
        contentSignature,
      });
      const clientOpId = ClientOpIdSchema.parse(draft.strokeId);
      const record = await this.#annotations.enqueueFinalOperation({
        roomId: this.#roomId,
        pageKey: route.pageKey,
        clientOpId,
        operation: {
          type: "stroke.create",
          stroke: draft,
        },
        localDraft: draft,
      });
      this.#refreshStatus(record);
      await this.#safePage(() =>
        this.#page.renderLocalDraft(route.tabId, route.context, draft, "PENDING", false),
      );
      void this.#transport
        .clearStrokePreview(
          StrokePreviewClearSchema.parse({
            type: "stroke.preview.clear",
            protocolVersion: 1,
            previewId: draft.strokeId,
            ...route.context,
          }),
        )
        .catch(() => {
          // Preview loss is expected; the final operation remains durable.
        });
      if (capacityFull) {
        const acknowledgement = AnnotationAckV2Schema.parse({
          type: "annotation.ack.v2",
          protocolVersion: 1,
          clientOpId,
          roomId: this.#roomId,
          accepted: false,
          code: "ANNOTATION_PAGE_CAPACITY_REACHED",
          pageKey: route.pageKey,
          annotationSeq: null,
          results: [],
        });
        const failed = await this.#annotations.applyAcknowledgement(route.pageKey, acknowledgement);
        this.#refreshStatus(failed);
        this.#capacityState = "FULL";
        this.#errorCode = "ANNOTATION_PAGE_CAPACITY_REACHED";
        await this.#safePage(async () => {
          await this.#page.renderAnnotationAcknowledgement(
            route.tabId,
            route.context,
            acknowledgement,
          );
          await this.#page.renderLocalDraft(route.tabId, route.context, draft, "ERROR", true);
        });
        return;
      }
      if (!this.#synchronized) {
        const failed = await this.#annotations.markTransportFailure(
          this.#roomId,
          route.pageKey,
          clientOpId,
        );
        this.#refreshStatus(failed);
        await this.#safePage(() =>
          this.#page.renderLocalDraft(route.tabId, route.context, draft, "ERROR", true),
        );
        this.#errorCode = "ANNOTATION_OFFLINE";
        return;
      }
      const primary = this.#route;
      if (primary !== undefined) {
        this.#startOperationDrain(primary, generation);
      }
    });
  }

  public handleSelection(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingSelectionMessage,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const message = DrawingSelectionMessageSchema.parse(messageInput);
    const generation = this.#generation;
    return this.#enqueuePageResult(async () => {
      const route = this.#matchingLocalRoute(tabId, frameId, message.context, generation);
      if (route?.pageKey === undefined) {
        throw new Error("ANNOTATION_SELECTION_ROUTE_STALE");
      }
      const record = await this.#annotations.load(this.#roomId, route.pageKey);
      if (record.confirmedSnapshot === null) {
        return;
      }
      const strokes = new Map(
        record.confirmedSnapshot.strokes.map((stroke) => [stroke.strokeId, stroke]),
      );
      let localRejection: AnnotationItemErrorCode | null = null;
      const items = message.items.filter((item) => {
        const stroke = strokes.get(item.strokeId);
        if (stroke === undefined) {
          localRejection ??= "STROKE_NOT_FOUND";
          return false;
        }
        if (stroke.version !== item.expectedVersion) {
          localRejection ??= "STROKE_VERSION_CONFLICT";
          return false;
        }
        if (message.action === "DELETE") {
          const allowed =
            stroke.lockedAtServerMs === null ||
            stroke.authorUserId === this.#userId ||
            this.#roomRole === "OWNER";
          if (!allowed) {
            localRejection ??= "STROKE_PERMISSION_DENIED";
          }
          return allowed;
        }
        if (message.action === "LOCK") {
          if (stroke.authorUserId !== this.#userId) {
            localRejection ??= "NOT_STROKE_AUTHOR";
            return false;
          }
          if (stroke.lockedAtServerMs !== null) {
            localRejection ??= "STROKE_LOCKED";
            return false;
          }
          return true;
        }
        if (stroke.authorUserId !== this.#userId) {
          localRejection ??= "NOT_STROKE_AUTHOR";
          return false;
        }
        if (stroke.lockedAtServerMs === null) {
          localRejection ??= "STROKE_NOT_LOCKED";
          return false;
        }
        return true;
      });
      if (localRejection !== null) {
        this.#errorCode = localRejection;
      }
      if (items.length === 0) {
        return;
      }
      const operation = AnnotationOperationV2Schema.parse({
        type:
          message.action === "DELETE"
            ? "stroke.delete"
            : message.action === "LOCK"
              ? "stroke.lock"
              : "stroke.unlock",
        items,
      });
      const queued = await this.#annotations.enqueueFinalOperation({
        roomId: this.#roomId,
        pageKey: route.pageKey,
        clientOpId: ClientOpIdSchema.parse(this.#createId()),
        operation,
        frameKey: route.context.frameKey,
      });
      this.#refreshStatus(queued);
      if (this.#synchronized) {
        const primary = this.#route;
        if (primary !== undefined) {
          this.#startOperationDrain(primary, generation);
        }
      }
    });
  }

  public handleDraftControl(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingDraftControlMessage,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const message = DrawingDraftControlMessageSchema.parse(messageInput);
    const generation = this.#generation;
    return this.#enqueuePageResult(async () => {
      const route = this.#matchingLocalRoute(tabId, frameId, message.context, generation);
      if (route?.pageKey === undefined) {
        throw new Error("ANNOTATION_DRAFT_ROUTE_STALE");
      }
      if (message.action === "DISCARD") {
        if (
          this.#operationDraining ||
          (this.#activeSubmission?.clientOpId === message.strokeId &&
            this.#activeSubmission.pageKey === route.pageKey)
        ) {
          throw new Error("ANNOTATION_DRAFT_SUBMITTING");
        }
        const record = await this.#annotations.discardLocalDraft(
          this.#roomId,
          route.pageKey,
          message.strokeId,
        );
        this.#refreshStatus(record);
        return;
      }
      const record = await this.#annotations.retryLocalDraft(
        this.#roomId,
        route.pageKey,
        message.strokeId,
      );
      this.#refreshStatus(record);
      const local = record.localDrafts.find((draft) => draft.draft.strokeId === message.strokeId);
      if (local !== undefined) {
        await this.#page.renderLocalDraft(
          route.tabId,
          route.context,
          local.draft,
          "PENDING",
          false,
        );
      }
      if (this.#synchronized) {
        const primary = this.#route;
        if (primary !== undefined) {
          this.#startOperationDrain(primary, generation);
        }
      }
    });
  }

  public handlePageReport(
    tabIdInput: unknown,
    frameIdInput: unknown,
    reportInput: DrawingPageReport,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const report = z
      .object({
        context: CollaborationPageContextSchema,
        active: z.boolean(),
        tool: z.enum(["PEN", "ERASER", "SELECT"]),
        rgb: z
          .object({
            r: z.number().int().min(0).max(255),
            g: z.number().int().min(0).max(255),
            b: z.number().int().min(0).max(255),
          })
          .strict(),
        width: z.number().finite().min(1).max(32),
        selectedCount: z.number().int().nonnegative().safe().max(2_000),
        selectedLockedCount: z.number().int().nonnegative().safe().max(2_000),
        unlocatableCount: z.number().int().nonnegative().safe().max(2_000),
      })
      .strict()
      .superRefine((value, validation) => {
        if (value.selectedLockedCount > value.selectedCount) {
          validation.addIssue({
            code: "custom",
            path: ["selectedLockedCount"],
            message: "locked selection count cannot exceed the total selection count",
          });
        }
      })
      .parse(reportInput);
    const generation = this.#generation;
    return this.#enqueuePage(async () => {
      if (this.#matchingLocalRoute(tabId, frameId, report.context, generation) !== undefined) {
        this.#unlocatableByFrame.set(frameId, report.unlocatableCount);
        this.#unlocatableCount = [...this.#unlocatableByFrame.values()].reduce(
          (total, count) => total + count,
          0,
        );
        if (frameId === 0) {
          this.#active = report.active;
          this.#tool = report.tool;
          this.#rgb = { ...report.rgb };
          this.#width = report.width;
          this.#selectedCount = report.selectedCount;
          this.#selectedLockedCount = report.selectedLockedCount;
        }
      }
    });
  }

  public handlePermissionBoundaryChanged(): Promise<void> {
    this.#generation += 1;
    this.#permissionBlocked = true;
    this.#knownFramesByTab.clear();
    this.#rootGenerationByTab.clear();
    this.#capabilityFailures.clear();
    this.#unavailableFrames.clear();
    this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
    this.#queuedPreview = undefined;
    this.#enqueuePage(() => this.#clearRoute());
    return this.whenIdle();
  }

  public getStatus(): DrawingControllerStatus {
    const ready =
      this.#synchronized &&
      !this.#permissionBlocked &&
      this.#route?.generation === this.#generation &&
      this.#route.pageKey !== undefined &&
      this.#capabilityErrorForRoute(this.#route) === null;
    const canCreate =
      ready &&
      this.#capacityState !== "FULL" &&
      this.#route !== undefined &&
      this.#contentSignatures.getLocalContentSignature(this.#route.context) !== null;
    const errorCode =
      this.#currentCapabilityError() ?? this.#currentUnavailableFrameError() ?? this.#errorCode;
    return {
      state: !this.#synchronized
        ? "OFFLINE"
        : this.#syncing
          ? "SYNCING"
          : errorCode === null
            ? "ONLINE"
            : "DEGRADED",
      errorCode,
      pageKey: this.#route?.pageKey ?? null,
      used: this.#used,
      capacity: MAX_LIVE_STROKES,
      lockedCount: this.#lockedCount,
      capacityState: this.#capacityState,
      canCreate,
      pendingDraftCount: this.#pendingDraftCount,
      errorDraftCount: this.#errorDraftCount,
      unlocatableCount: this.#unlocatableCount,
      ready,
      canRetry: this.#routeCanRetry(this.#route),
      active: this.#active,
      tool: this.#tool,
      rgb: { ...this.#rgb },
      width: this.#width,
      selectedCount: this.#selectedCount,
      selectedLockedCount: this.#selectedLockedCount,
    };
  }

  public isReadyFor(tabIdInput: unknown, contextInput: CollaborationPageContext): boolean {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const context = CollaborationPageContextSchema.parse(contextInput);
    const route = this.#route;
    return (
      this.getStatus().ready &&
      route !== undefined &&
      route.tabId === tabId &&
      route.context.frameKey === "top" &&
      sameContext(route.context, context)
    );
  }

  public handleContentCompatibilityChanged(
    tabIdInput: unknown,
    logicalTabIdInput: unknown,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const logicalTabId = z.string().uuid().parse(logicalTabIdInput);
    const generation = this.#generation;
    return this.#enqueuePage(async () => {
      const route = this.#route;
      if (
        route === undefined ||
        route.tabId !== tabId ||
        route.context.logicalTabId !== logicalTabId ||
        route.pageKey === undefined ||
        !this.#routeStillCurrent(route, generation)
      ) {
        return;
      }
      const record = await this.#annotations.load(this.#roomId, route.pageKey);
      if (this.#routeStillCurrent(route, generation)) {
        await this.#renderReplicaToAll(record, generation);
      }
    });
  }

  public canRetryFor(tabIdInput: unknown, contextInput: CollaborationPageContext): boolean {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const context = CollaborationPageContextSchema.parse(contextInput);
    const route = this.#route;
    return (
      this.#routeCanRetry(route) &&
      route !== undefined &&
      route.tabId === tabId &&
      sameContext(route.context, context)
    );
  }

  public handlePageCapability(reportInput: PageCapabilityReport): Promise<void> {
    const report = PageCapabilityReportSchema.parse(reportInput);
    if (report.message.capability !== "PAGE_HOST" && report.message.capability !== "DRAWING") {
      return this.whenIdle();
    }
    const key = pageCapabilityKey(report.tabId, report.frameId, report.message.capability);
    if (report.message.state === "DEGRADED") {
      this.#capabilityFailures.set(key, report.message.errorCode);
      return Promise.resolve();
    }
    this.#capabilityFailures.delete(key);
    if (this.#synchronized && this.#activeTabId === report.tabId && !this.#permissionBlocked) {
      const generation = this.#generation;
      return this.#enqueuePage(() => this.#refreshRoute(report.tabId, generation));
    }
    return Promise.resolve();
  }

  public async dispose(): Promise<void> {
    if (this.#synchronized) {
      await this.setSynchronized(false);
    } else {
      this.#transport.setAnnotationHandler(undefined);
      this.#transport.setStrokePreviewHandler(undefined);
    }
    await this.#clearRoute();
    await this.whenIdle();
  }

  public async whenIdle(): Promise<void> {
    let observedPage: Promise<void>;
    let observedOperation: Promise<void>;
    let observedPreview: Promise<void>;
    do {
      observedPage = this.#pageTail;
      observedOperation = this.#operationDrain;
      observedPreview = this.#previewDrain;
      await Promise.all([observedPage, observedOperation, observedPreview]);
    } while (
      observedPage !== this.#pageTail ||
      observedOperation !== this.#operationDrain ||
      observedPreview !== this.#previewDrain ||
      this.#operationDraining ||
      this.#previewDraining
    );
  }

  async #refreshRoute(tabId: number, generation: number): Promise<void> {
    if (
      !this.#synchronized ||
      this.#permissionBlocked ||
      generation !== this.#generation ||
      this.#activeTabId !== tabId
    ) {
      return;
    }
    let retainedRoute: DrawingRoute | undefined;
    if ([...this.#routes.values()].some((route) => route.generation !== generation)) {
      retainedRoute = this.#route;
      await this.#clearRoute();
      if (
        !this.#synchronized ||
        this.#permissionBlocked ||
        generation !== this.#generation ||
        this.#activeTabId !== tabId
      ) {
        return;
      }
    }
    const context = await this.#resolveContext(tabId);
    if (
      !this.#synchronized ||
      this.#permissionBlocked ||
      generation !== this.#generation ||
      this.#activeTabId !== tabId
    ) {
      return;
    }
    if (context === null) {
      await this.#clearRoute();
      return;
    }
    const desiredFrames = new Map(this.#knownFramesByTab.get(tabId) ?? []);
    if (desiredFrames.get(0) !== "top") {
      await this.#clearRoute();
      this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
      return;
    }
    const pageKeyCandidate = this.#route ?? retainedRoute;
    const inheritedPageKey =
      pageKeyCandidate !== undefined &&
      pageKeyCandidate.tabId === tabId &&
      sameContext(pageKeyCandidate.context, context)
        ? pageKeyCandidate.pageKey
        : undefined;
    const nextRoutes = new Map<number, DrawingRoute>();
    for (const [frameId, frameKey] of desiredFrames) {
      const frameContext = CollaborationPageContextSchema.parse({
        ...context,
        frameKey,
      });
      const prior = this.#routes.get(frameId);
      nextRoutes.set(
        frameId,
        prior !== undefined &&
          prior.tabId === tabId &&
          prior.generation === generation &&
          sameContext(prior.context, frameContext)
          ? prior
          : {
              tabId,
              frameId,
              context: frameContext,
              pageKey: inheritedPageKey,
              generation,
            },
      );
    }
    for (const prior of this.#routes.values()) {
      if (nextRoutes.get(prior.frameId) !== prior) {
        await this.#clearOneRoute(prior);
        this.#unlocatableByFrame.delete(prior.frameId);
      }
    }
    this.#unlocatableCount = [...this.#unlocatableByFrame.values()].reduce(
      (total, count) => total + count,
      0,
    );
    this.#routes.clear();
    for (const [frameId, route] of nextRoutes) {
      this.#routes.set(frameId, route);
    }
    const route = this.#routes.get(0);
    if (route === undefined) {
      await this.#clearRoute();
      return;
    }
    this.#route = route;
    await this.#synchronizeRoute(route, generation, route.pageKey !== undefined);
  }

  async #synchronizeRoute(
    route: DrawingRoute,
    generation: number,
    preferDelta: boolean,
    startDrain = true,
  ): Promise<boolean> {
    if (!this.#routeStillCurrent(route, generation)) {
      return false;
    }
    this.#syncing = true;
    try {
      let lastAnnotationSeq = 0;
      let hasConfirmedSnapshot = false;
      if (preferDelta && route.pageKey !== undefined) {
        const local = await this.#annotations.load(this.#roomId, route.pageKey);
        if (!this.#routeStillCurrent(route, generation)) {
          return false;
        }
        if (local.confirmedSnapshot !== null) {
          hasConfirmedSnapshot = true;
          lastAnnotationSeq = local.confirmedSnapshot.annotationSeq;
        }
      }
      const response = await this.#transport.synchronizeAnnotations({
        protocolVersion: 1,
        ...route.context,
        lastAnnotationSeq,
        hasConfirmedSnapshot,
      });
      if (!this.#routeStillCurrent(route, generation)) {
        return false;
      }
      if (!messageMatchesContext(response, route.context)) {
        throw new Error("ANNOTATION_PROTOCOL_FAILURE");
      }
      if (!hasConfirmedSnapshot && response.type === "annotation.delta.v2") {
        throw new Error("ANNOTATION_PROTOCOL_FAILURE");
      }
      const result =
        response.type === "annotation.snapshot.v2"
          ? {
              kind: "APPLIED" as const,
              record: await this.#annotations.applySnapshot(
                AnnotationSnapshotV2MessageSchema.parse(response),
              ),
            }
          : await this.#annotations.applyDelta(AnnotationDeltaV2MessageSchema.parse(response));
      if (result.kind === "SNAPSHOT_REQUIRED") {
        if (!hasConfirmedSnapshot) {
          throw new Error("ANNOTATION_PROTOCOL_FAILURE");
        }
        return this.#synchronizeRoute(route, generation, false, startDrain);
      }
      if (!this.#routeStillCurrent(route, generation)) {
        return false;
      }
      this.#setCurrentPageKey(response.pageKey, generation);
      const primaryRendered = await this.#renderReplicaToAll(result.record, generation);
      if (!this.#routeStillCurrent(route, generation)) {
        return false;
      }
      if (startDrain && primaryRendered) {
        this.#startOperationDrain(route, generation);
      }
      return primaryRendered;
    } catch (cause) {
      if (this.#routeStillCurrent(route, generation)) {
        this.#errorCode = annotationControllerFailureCode(cause);
      }
      return false;
    } finally {
      if (this.#route === route) {
        this.#syncing = false;
      }
    }
  }

  async #renderReplica(
    route: DrawingRoute,
    record: AnnotationReplicaRecord,
    generation: number,
  ): Promise<DrawingPageDeliveryResult> {
    if (
      route.pageKey === undefined ||
      record.confirmedSnapshot === null ||
      !this.#frameRouteStillCurrent(route, generation)
    ) {
      return "STALE";
    }
    const compatibleStrokes = await this.#compatibleStrokesForRoute(
      route,
      record.confirmedSnapshot.strokes,
      generation,
    );
    if (compatibleStrokes === null) {
      return "STALE";
    }
    const snapshot = AnnotationSnapshotV2MessageSchema.parse({
      type: "annotation.snapshot.v2",
      protocolVersion: 1,
      ...route.context,
      pageKey: route.pageKey,
      annotationSeq: record.confirmedSnapshot.annotationSeq,
      strokes: compatibleStrokes,
    });
    const viewerRendered = await this.#safePage(() =>
      this.#page.setDrawingViewer(route.tabId, route.context, {
        userId: this.#userId,
        role: this.#roomRole,
      }),
    );
    if (viewerRendered !== "APPLIED") {
      return viewerRendered;
    }
    if (!this.#frameRouteStillCurrent(route, generation)) {
      return "STALE";
    }
    const snapshotRendered = await this.#safePage(() =>
      this.#page.renderAnnotationSnapshot(route.tabId, route.context, snapshot),
    );
    if (snapshotRendered !== "APPLIED") {
      return snapshotRendered;
    }
    if (!this.#frameRouteStillCurrent(route, generation)) {
      return "STALE";
    }
    for (const local of record.localDrafts) {
      if (local.draft.frameKey === route.context.frameKey) {
        const draftRendered = await this.#safePage(() =>
          this.#page.renderLocalDraft(
            route.tabId,
            route.context,
            local.draft,
            local.status,
            isRetryableDraftError(local.errorCode),
          ),
        );
        if (draftRendered !== "APPLIED") {
          return draftRendered;
        }
        if (!this.#frameRouteStillCurrent(route, generation)) {
          return "STALE";
        }
      }
    }
    return "APPLIED";
  }

  async #renderReplicaToAll(record: AnnotationReplicaRecord, generation: number): Promise<boolean> {
    let primaryRendered = false;
    let renderFailed = false;
    for (const route of [...this.#routes.values()]) {
      if (!this.#frameRouteStillCurrent(route, generation)) {
        continue;
      }
      const rendered = await this.#renderReplica(route, record, generation);
      if (route === this.#route) {
        primaryRendered = rendered === "APPLIED";
      }
      if (rendered !== "APPLIED") {
        renderFailed = true;
      }
      if (rendered === "UNREACHABLE") {
        this.#detachUnavailableRoute(route);
      }
    }
    if (primaryRendered && !renderFailed) {
      this.#errorCode = null;
    }
    this.#refreshStatus(record);
    return primaryRendered;
  }

  #detachUnavailableRoute(route: DrawingRoute): void {
    if (this.#routes.get(route.frameId) !== route) {
      return;
    }
    const frames = this.#knownFramesByTab.get(route.tabId);
    if (route.frameId === 0) {
      this.#knownFramesByTab.delete(route.tabId);
      this.#rootGenerationByTab.delete(route.tabId);
      for (const candidate of [...this.#routes.values()]) {
        if (candidate.tabId === route.tabId) {
          this.#routes.delete(candidate.frameId);
        }
      }
      if (this.#route?.tabId === route.tabId) {
        this.#route = undefined;
      }
      this.#permissionBlocked = this.#activeTabId === route.tabId;
      this.#unlocatableByFrame.clear();
    } else {
      if (frames?.get(route.frameId) === route.context.frameKey) {
        frames.delete(route.frameId);
      }
      this.#routes.delete(route.frameId);
      this.#unlocatableByFrame.delete(route.frameId);
    }
    this.#unlocatableCount = [...this.#unlocatableByFrame.values()].reduce(
      (total, count) => total + count,
      0,
    );
    this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
  }

  async #handleAnnotationMessage(
    messageInput: AnnotationMessage,
    generation: number,
  ): Promise<void> {
    const route = this.#route;
    if (!this.#routeStillCurrent(route, generation) || route === undefined) {
      return;
    }
    if (messageInput.type === "annotation.snapshot.v2") {
      const message = AnnotationSnapshotV2MessageSchema.parse(messageInput);
      const messageRoute = this.#routeForContext(message);
      if (messageRoute === undefined || !this.#frameRouteStillCurrent(messageRoute, generation)) {
        return;
      }
      const record = await this.#annotations.applySnapshot(message);
      if (!this.#routeStillCurrent(route, generation)) {
        return;
      }
      this.#setCurrentPageKey(message.pageKey, generation);
      await this.#renderReplicaToAll(record, generation);
      if (!this.#routeStillCurrent(route, generation)) {
        return;
      }
      this.#startOperationDrain(route, generation);
      return;
    }
    if (messageInput.type === "annotation.delta.v2") {
      const message = AnnotationDeltaV2MessageSchema.parse(messageInput);
      const messageRoute = this.#routeForContext(message);
      if (
        messageRoute === undefined ||
        !this.#frameRouteStillCurrent(messageRoute, generation) ||
        (route.pageKey !== undefined && route.pageKey !== message.pageKey)
      ) {
        return;
      }
      const result = await this.#annotations.applyDelta(message);
      if (!this.#routeStillCurrent(route, generation)) {
        return;
      }
      this.#setCurrentPageKey(message.pageKey, generation);
      if (result.kind === "SNAPSHOT_REQUIRED") {
        await this.#synchronizeRoute(route, generation, false);
        return;
      }
      const itemFailure = annotationItemFailureCode(
        message.operations.flatMap((operation) => operation.results),
      );
      await this.#renderReplicaToAll(result.record, generation);
      if (itemFailure !== null) {
        this.#errorCode = itemFailure;
      }
      this.#startOperationDrain(route, generation);
      return;
    }
    const committed = AnnotationCommittedOperationV2Schema.parse(messageInput);
    if (route.pageKey === undefined || committed.pageKey !== route.pageKey) {
      return;
    }
    const result = await this.#annotations.applyCommitted(committed);
    if (!this.#routeStillCurrent(route, generation)) {
      return;
    }
    if (result.kind === "SNAPSHOT_REQUIRED") {
      await this.#synchronizeRoute(route, generation, false);
      return;
    }
    const itemFailure = annotationItemFailureCode(committed.results);
    await this.#renderReplicaToAll(result.record, generation);
    if (itemFailure !== null) {
      this.#errorCode = itemFailure;
    }
    if (!this.#routeStillCurrent(route, generation)) {
      return;
    }
    this.#refreshStatus(result.record);
    this.#startOperationDrain(route, generation);
  }

  async #handlePreviewMessage(
    messageInput: StrokePreviewMessage,
    generation: number,
  ): Promise<void> {
    if (messageInput.type === "stroke.preview.event") {
      const message = StrokePreviewEventMessageSchema.parse(messageInput);
      const route = this.#routeForContext(message);
      if (route === undefined || !this.#frameRouteStillCurrent(route, generation)) {
        return;
      }
      await this.#safePage(() =>
        this.#page.renderStrokePreview(route.tabId, route.context, message),
      );
      return;
    }
    const message = StrokePreviewClearMessageSchema.parse(messageInput);
    const route = this.#routeForContext(message);
    if (route === undefined || !this.#frameRouteStillCurrent(route, generation)) {
      return;
    }
    await this.#safePage(() => this.#page.clearStrokePreview(route.tabId, route.context, message));
  }

  #startPreviewDrain(): void {
    if (this.#previewDraining) {
      return;
    }
    this.#previewDraining = true;
    this.#previewDrain = (async () => {
      while (this.#queuedPreview !== undefined) {
        const queued = this.#queuedPreview;
        this.#queuedPreview = undefined;
        if (!this.#frameRouteStillCurrent(queued.route, queued.generation)) {
          continue;
        }
        try {
          await this.#transport.publishStrokePreview(queued.update);
        } catch {
          this.#errorCode = "ANNOTATION_OFFLINE";
          this.#queuedPreview = undefined;
          break;
        }
      }
    })().finally(() => {
      this.#previewDraining = false;
      if (this.#queuedPreview !== undefined) {
        this.#startPreviewDrain();
      }
    });
  }

  #startOperationDrain(route: DrawingRoute, generation: number): void {
    if (!this.#synchronized || route.pageKey === undefined) {
      return;
    }
    if (this.#operationDraining) {
      this.#operationDrainRequested = true;
      return;
    }
    this.#operationDrainRequested = false;
    this.#operationDraining = true;
    this.#operationDrain = this.#drainOperations(route, generation).finally(() => {
      this.#operationDraining = false;
      if (this.#operationDrainRequested) {
        this.#operationDrainRequested = false;
        const currentRoute = this.#route;
        if (currentRoute !== undefined) {
          this.#startOperationDrain(currentRoute, this.#generation);
        }
      }
    });
  }

  async #drainOperations(route: DrawingRoute, generation: number): Promise<void> {
    while (this.#routeStillCurrent(route, generation) && route.pageKey !== undefined) {
      const pending = await this.#annotations.getRetryableOperations(this.#roomId, route.pageKey);
      if (!this.#routeStillCurrent(route, generation)) {
        return;
      }
      const blockedFrameKeys = new Set<string>();
      const item = pending.find((candidate) => {
        const frameKey =
          candidate.operation.type === "stroke.create"
            ? candidate.operation.stroke.frameKey
            : candidate.frameKey;
        if (blockedFrameKeys.has(frameKey)) {
          return false;
        }
        const candidateRoute = this.#routeForOperation(candidate.operation, candidate.frameKey);
        if (
          candidateRoute === undefined ||
          !this.#frameRouteStillCurrent(candidateRoute, generation)
        ) {
          blockedFrameKeys.add(frameKey);
          return false;
        }
        return true;
      });
      if (item === undefined) {
        if (pending.length > 0) {
          this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
        }
        return;
      }
      const operationRoute = this.#routeForOperation(item.operation, item.frameKey);
      if (
        operationRoute === undefined ||
        !this.#frameRouteStillCurrent(operationRoute, generation)
      ) {
        this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
        return;
      }
      const activeSubmission = {
        clientOpId: item.clientOpId,
        pageKey: route.pageKey,
      };
      this.#activeSubmission = activeSubmission;
      try {
        const submittedPageKey = route.pageKey;
        const acknowledgement = AnnotationAckV2Schema.parse(
          await this.#transport.submitAnnotation({
            type: "annotation.submit.v2",
            protocolVersion: 1,
            clientOpId: ClientOpIdSchema.parse(item.clientOpId),
            ...operationRoute.context,
            pageKey: route.pageKey,
            baseAnnotationSeq: item.baseAnnotationSeq,
            operation: item.operation,
          }),
        );
        const pageMismatch =
          !acknowledgement.accepted &&
          acknowledgement.code === "PAGE_MISMATCH" &&
          acknowledgement.pageKey !== null &&
          acknowledgement.pageKey !== submittedPageKey;
        if (
          acknowledgement.clientOpId !== item.clientOpId ||
          acknowledgement.roomId !== this.#roomId ||
          (acknowledgement.pageKey !== null &&
            acknowledgement.pageKey !== submittedPageKey &&
            !pageMismatch) ||
          !acknowledgementMatchesOperation(acknowledgement, item.operation)
        ) {
          throw new Error("ANNOTATION_PROTOCOL_FAILURE");
        }
        if (pageMismatch) {
          this.#errorCode = "PAGE_MISMATCH";
          await this.#safePage(() =>
            this.#page.renderAnnotationAcknowledgement(
              operationRoute.tabId,
              operationRoute.context,
              acknowledgement,
            ),
          );
          if (
            !this.#routeStillCurrent(route, generation) ||
            !this.#frameRouteStillCurrent(operationRoute, generation)
          ) {
            return;
          }
          await this.#synchronizeRoute(route, generation, false, false);
          if (
            !this.#routeStillCurrent(route, generation) ||
            route.pageKey !== acknowledgement.pageKey
          ) {
            return;
          }
          // A page mismatch can represent a real navigation, not merely a key
          // rotation. Keep the rejected draft isolated under the old page key;
          // synchronizing the route clears the old rendering and adopts the
          // authoritative current page without replaying old-page content.
          continue;
        }
        const record = await this.#annotations.applyAcknowledgement(route.pageKey, acknowledgement);
        if (!this.#routeStillCurrent(route, generation)) {
          return;
        }
        const itemFailure =
          acknowledgement.accepted === true
            ? acknowledgement.results.find((result) => !result.accepted)
            : undefined;
        this.#errorCode = itemFailure?.code ?? null;
        await this.#safePage(() =>
          this.#page.renderAnnotationAcknowledgement(
            operationRoute.tabId,
            operationRoute.context,
            acknowledgement,
          ),
        );
        if (
          !this.#routeStillCurrent(route, generation) ||
          !this.#frameRouteStillCurrent(operationRoute, generation)
        ) {
          return;
        }
        this.#refreshStatus(record);
        if (!acknowledgement.accepted) {
          this.#errorCode = acknowledgement.code;
          if (acknowledgement.code === "ANNOTATION_PAGE_CAPACITY_REACHED") {
            this.#capacityState = "FULL";
            continue;
          }
          if (acknowledgement.code === "ANNOTATION_SEQUENCE_CONFLICT") {
            const synchronized = await this.#synchronizeRoute(route, generation, false);
            if (!synchronized || !this.#routeStillCurrent(route, generation)) {
              return;
            }
            const rebased = await this.#annotations.rebaseSequenceConflicts(
              this.#roomId,
              route.pageKey,
            );
            this.#refreshStatus(rebased);
            continue;
          }
          return;
        }
      } catch (cause) {
        const failureCode = annotationControllerFailureCode(cause);
        if (failureCode !== "ANNOTATION_OFFLINE") {
          if (this.#routeStillCurrent(route, generation)) {
            this.#errorCode = failureCode;
          }
          return;
        }
        let failed: AnnotationReplicaRecord;
        try {
          failed = await this.#annotations.markTransportFailure(
            this.#roomId,
            route.pageKey,
            item.clientOpId,
          );
        } catch (storageCause) {
          if (this.#routeStillCurrent(route, generation)) {
            this.#errorCode = annotationControllerFailureCode(storageCause);
          }
          return;
        }
        if (!this.#routeStillCurrent(route, generation)) {
          return;
        }
        const local = failed.localDrafts.find((draft) => draft.clientOpId === item.clientOpId);
        if (local !== undefined) {
          const localRoute = this.#routeForFrameKey(local.draft.frameKey) ?? operationRoute;
          await this.#safePage(() =>
            this.#page.renderLocalDraft(
              localRoute.tabId,
              localRoute.context,
              local.draft,
              "ERROR",
              true,
            ),
          );
        }
        if (!this.#routeStillCurrent(route, generation)) {
          return;
        }
        this.#refreshStatus(failed);
        this.#errorCode = failureCode;
        return;
      } finally {
        if (this.#activeSubmission === activeSubmission) {
          this.#activeSubmission = undefined;
        }
      }
    }
  }

  async #resolveContext(tabId: number): Promise<CollaborationPageContext | null> {
    const record = await this.#replica.getRecord();
    const snapshot = record.confirmedSnapshot;
    if (record.mode !== "SYNCED" || snapshot === null || snapshot.roomId !== this.#roomId) {
      return null;
    }
    const binding = record.bindings.find(
      (candidate) =>
        candidate.browserSessionId === this.#browserSessionId &&
        candidate.tabId === tabId &&
        candidate.validatedAtServerSeq === snapshot.serverSeq,
    );
    const tab = snapshot.tabs.find(
      (candidate) =>
        candidate.id === binding?.logicalTabId &&
        candidate.closedAtSeq === null &&
        snapshot.order.includes(candidate.id),
    );
    if (binding === undefined || tab === undefined) {
      return null;
    }
    return CollaborationPageContextSchema.parse({
      roomId: this.#roomId,
      logicalTabId: binding.logicalTabId,
      documentRevision: {
        roomEpoch: snapshot.roomEpoch,
        tabUpdatedAtSeq: tab.updatedAtSeq,
      },
      frameKey: "top",
    });
  }

  #setCurrentPageKey(pageKey: string, generation: number): void {
    for (const route of this.#routes.values()) {
      if (this.#frameRouteStillCurrent(route, generation)) {
        route.pageKey = pageKey;
      }
    }
  }

  #routeForContext(context: {
    roomId: string;
    logicalTabId: string;
    documentRevision: { roomEpoch: number; tabUpdatedAtSeq: number };
    frameKey: string;
  }): DrawingRoute | undefined {
    return [...this.#routes.values()].find((route) =>
      messageMatchesContext(context, route.context),
    );
  }

  #routeForFrameKey(frameKey: string): DrawingRoute | undefined {
    const matches = [...this.#routes.values()].filter(
      (route) => route.context.frameKey === frameKey,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  #routeForOperation(operation: AnnotationOperationV2, frameKey: string): DrawingRoute | undefined {
    if (operation.type === "stroke.create") {
      return this.#routeForFrameKey(operation.stroke.frameKey);
    }
    return this.#routeForFrameKey(frameKey);
  }

  async #compatibleStrokesForRoute(
    route: DrawingRoute,
    strokes: readonly AnnotationStrokeV2[],
    generation: number,
  ): Promise<AnnotationStrokeV2[] | null> {
    const localSignature = this.#contentSignatures.getLocalContentSignature(route.context);
    if (localSignature === null) {
      return [];
    }
    const compatible: AnnotationStrokeV2[] = [];
    for (const stroke of strokes) {
      if (!this.#frameRouteStillCurrent(route, generation)) {
        return null;
      }
      const remoteSignature = stroke.contentSignature;
      if (remoteSignature === null) {
        continue;
      }
      if (sameContentSignature(localSignature, remoteSignature)) {
        compatible.push(stroke);
        continue;
      }
      if (stroke.anchor.type !== "element") {
        continue;
      }
      if (!("anchorSignature" in stroke.anchor)) {
        continue;
      }
      const localAnchorSignature = await this.#page.resolveElementAnchorSignature(
        route.tabId,
        route.context,
        stroke.anchor.path,
      );
      if (
        localAnchorSignature !== null &&
        sameContentSignature(localAnchorSignature, stroke.anchor.anchorSignature)
      ) {
        compatible.push(stroke);
      }
    }
    return compatible;
  }

  #matchingRoute(
    tabId: number,
    frameId: number,
    context: CollaborationPageContext,
    generation: number,
  ): DrawingRoute | undefined {
    const route = this.#routes.get(frameId);
    return this.#frameRouteStillCurrent(route, generation) &&
      route !== undefined &&
      route.tabId === tabId &&
      sameContext(route.context, context)
      ? route
      : undefined;
  }

  #matchingLocalRoute(
    tabId: number,
    frameId: number,
    context: CollaborationPageContext,
    generation: number,
  ): DrawingRoute | undefined {
    const route = this.#routes.get(frameId);
    return this.#retainedLocalRouteIsCurrent(route) &&
      route !== undefined &&
      (!this.#synchronized ||
        (generation === this.#generation && route.generation === generation)) &&
      route.tabId === tabId &&
      sameContext(route.context, context)
      ? route
      : undefined;
  }

  #routeStillCurrent(route: DrawingRoute | undefined, generation: number): boolean {
    return (
      this.#synchronized && this.#localRouteStillCurrent(route, generation) && this.#route === route
    );
  }

  #localRouteStillCurrent(route: DrawingRoute | undefined, generation: number): boolean {
    return (
      this.#retainedLocalRouteIsCurrent(route) &&
      route !== undefined &&
      generation === this.#generation &&
      route.generation === generation &&
      this.#routes.get(route.frameId) === route
    );
  }

  #frameRouteStillCurrent(route: DrawingRoute | undefined, generation: number): boolean {
    return this.#synchronized && this.#localRouteStillCurrent(route, generation);
  }

  #retainedLocalRouteIsCurrent(route: DrawingRoute | undefined): boolean {
    return (
      route !== undefined &&
      !this.#permissionBlocked &&
      this.#capabilityErrorForRoute(route) === null &&
      this.#routes.get(route.frameId) === route &&
      this.#activeTabId === route.tabId
    );
  }

  #routeCanRetry(route: DrawingRoute | undefined): boolean {
    if (
      route === undefined ||
      !this.#synchronized ||
      this.#permissionBlocked ||
      route.frameId !== 0 ||
      route.context.frameKey !== "top" ||
      route.pageKey === undefined ||
      route.generation !== this.#generation ||
      this.#routes.get(route.frameId) !== route ||
      this.#activeTabId !== route.tabId
    ) {
      return false;
    }
    return (
      !this.#capabilityFailures.has(pageCapabilityKey(route.tabId, route.frameId, "PAGE_HOST")) &&
      this.#capabilityFailures.has(pageCapabilityKey(route.tabId, route.frameId, "DRAWING"))
    );
  }

  async #clearRoute(): Promise<void> {
    const routes = [...this.#routes.values()];
    this.#route = undefined;
    this.#routes.clear();
    this.#syncing = false;
    this.#queuedPreview = undefined;
    this.#unlocatableCount = 0;
    this.#unlocatableByFrame.clear();
    this.#used = 0;
    this.#lockedCount = 0;
    this.#pendingDraftCount = 0;
    this.#errorDraftCount = 0;
    this.#capacityState = "AVAILABLE";
    this.#active = false;
    this.#tool = "PEN";
    this.#rgb = { r: 0, g: 122, b: 255 };
    this.#width = 6;
    this.#selectedCount = 0;
    this.#selectedLockedCount = 0;
    await Promise.all(routes.map((route) => this.#clearOneRoute(route)));
  }

  #capabilityErrorForRoute(route: DrawingRoute | undefined): string | null {
    if (route === undefined) {
      return null;
    }
    return (
      this.#capabilityFailures.get(pageCapabilityKey(route.tabId, route.frameId, "PAGE_HOST")) ??
      this.#capabilityFailures.get(pageCapabilityKey(route.tabId, route.frameId, "DRAWING")) ??
      null
    );
  }

  #currentCapabilityError(): string | null {
    for (const route of [...this.#routes.values()].sort(
      (left, right) => left.frameId - right.frameId,
    )) {
      const error = this.#capabilityErrorForRoute(route);
      if (error !== null) {
        return error;
      }
    }
    return null;
  }

  #clearFrameCapabilityFailures(tabId: number, frameId: number): void {
    this.#capabilityFailures.delete(pageCapabilityKey(tabId, frameId, "PAGE_HOST"));
    this.#capabilityFailures.delete(pageCapabilityKey(tabId, frameId, "DRAWING"));
  }

  #clearTabCapabilityFailures(tabId: number): void {
    const prefix = `${String(tabId)}:`;
    for (const key of this.#capabilityFailures.keys()) {
      if (key.startsWith(prefix)) {
        this.#capabilityFailures.delete(key);
      }
    }
  }

  #currentUnavailableFrameError(): string | null {
    const tabId = this.#activeTabId;
    if (tabId === undefined) {
      return null;
    }
    const prefix = `${String(tabId)}:`;
    return [...this.#unavailableFrames.keys()].some((key) => key.startsWith(prefix))
      ? "PAGE_TOOL_PERMISSION_REQUIRED"
      : null;
  }

  #clearTabUnavailableFrames(tabId: number): void {
    const prefix = `${String(tabId)}:`;
    for (const key of this.#unavailableFrames.keys()) {
      if (key.startsWith(prefix)) {
        this.#unavailableFrames.delete(key);
      }
    }
  }

  async #clearOneRoute(route: DrawingRoute): Promise<void> {
    await this.#safePage(() => this.#page.clearDrawing(route.tabId, route.context));
  }

  #refreshStatus(record: AnnotationReplicaRecord): void {
    const snapshot = record.confirmedSnapshot;
    const confirmedStrokeIds = new Set(snapshot?.strokes.map((stroke) => stroke.strokeId) ?? []);
    const outboxById = new Map(record.outbox.map((item) => [item.clientOpId, item]));
    const pendingCreates = record.localDrafts.filter((local) => {
      if (confirmedStrokeIds.has(local.draft.strokeId)) {
        return false;
      }
      const operation = outboxById.get(local.clientOpId);
      return (
        operation?.operation.type === "stroke.create" &&
        (operation.state === "QUEUED" ||
          operation.state === "ACKNOWLEDGED" ||
          (operation.state === "FAILED" && isRetryableDraftError(operation.errorCode)))
      );
    });
    this.#used = (snapshot?.strokes.length ?? 0) + pendingCreates.length;
    this.#lockedCount =
      snapshot?.strokes.filter((stroke) => stroke.lockedAtServerMs !== null).length ?? 0;
    this.#pendingDraftCount = record.localDrafts.filter(
      (draft) => draft.status === "PENDING",
    ).length;
    this.#errorDraftCount = record.localDrafts.filter((draft) => draft.status === "ERROR").length;
    const liveBytes =
      (snapshot?.strokes.reduce(
        (total, stroke) => total + serializedAnnotationStrokeBytes(stroke),
        0,
      ) ?? 0) +
      pendingCreates.reduce(
        (total, local) => total + serializedAnnotationStrokeBytes(local.draft),
        0,
      );
    const full = this.#used >= MAX_LIVE_STROKES || liveBytes >= MAX_LIVE_BYTES;
    const near =
      this.#used >= MAX_LIVE_STROKES * NEAR_CAPACITY_RATIO ||
      liveBytes >= MAX_LIVE_BYTES * NEAR_CAPACITY_RATIO;
    this.#capacityState = full ? "FULL" : near ? "NEAR_LIMIT" : "AVAILABLE";
  }

  async #safePage(work: () => Promise<void>): Promise<DrawingPageDeliveryResult> {
    try {
      await work();
      return "APPLIED";
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause as Error & { code?: unknown }).code === "PAGE_TOOL_REACHABLE_DEGRADED"
      ) {
        this.#errorCode = cause.message;
        return "REACHABLE_DEGRADED";
      }
      this.#errorCode =
        cause instanceof Error && cause.message === "PAGE_TOOL_PERMISSION_REQUIRED"
          ? "PAGE_TOOL_PERMISSION_REQUIRED"
          : "DRAWING_PAGE_UNAVAILABLE";
      return "UNREACHABLE";
    }
  }

  #enqueuePage(work: () => Promise<void>): Promise<void> {
    this.#pageTail = this.#pageTail.then(work, work).catch((cause: unknown) => {
      this.#errorCode = annotationControllerFailureCode(cause);
    });
    return this.#pageTail;
  }

  #enqueuePageResult(work: () => Promise<void>): Promise<void> {
    const result = this.#pageTail.then(work, work);
    this.#pageTail = result.then(
      () => undefined,
      (cause: unknown) => {
        this.#errorCode = annotationControllerFailureCode(cause);
      },
    );
    return result;
  }
}

function pageCapabilityKey(
  tabId: number,
  frameId: number,
  capability: "PAGE_HOST" | "DRAWING",
): string {
  return `${String(tabId)}:${String(frameId)}:${capability}`;
}

function pageFrameKey(tabId: number, frameId: number): string {
  return `${String(tabId)}:${String(frameId)}`;
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

function sameContentSignature(left: ContentSignature, right: ContentSignature): boolean {
  const parsedLeft = ContentSignatureSchema.parse(left);
  const parsedRight = ContentSignatureSchema.parse(right);
  return (
    parsedLeft.signatureVersion === parsedRight.signatureVersion &&
    parsedLeft.digest === parsedRight.digest
  );
}

function messageMatchesContext(
  message: {
    roomId: string;
    logicalTabId: string;
    documentRevision: { roomEpoch: number; tabUpdatedAtSeq: number };
    frameKey: string;
  },
  context: CollaborationPageContext,
): boolean {
  return sameContext(
    CollaborationPageContextSchema.parse({
      roomId: message.roomId,
      logicalTabId: message.logicalTabId,
      documentRevision: message.documentRevision,
      frameKey: message.frameKey,
    }),
    context,
  );
}

function acknowledgementMatchesOperation(
  acknowledgement: AnnotationAckV2,
  operation: AnnotationOperationV2,
): boolean {
  if (!acknowledgement.accepted) {
    return true;
  }
  const expectedStrokeIds =
    operation.type === "stroke.create"
      ? [operation.stroke.strokeId]
      : operation.items.map((item) => item.strokeId);
  return (
    acknowledgement.results.length === expectedStrokeIds.length &&
    acknowledgement.results.every((result, index) => result.strokeId === expectedStrokeIds[index])
  );
}

function annotationItemFailureCode(
  results: readonly AnnotationBatchItemResult[],
): AnnotationItemErrorCode | null {
  return results.find((result) => !result.accepted)?.code ?? null;
}

function isRetryableDraftError(
  errorCode: AnnotationReplicaRecord["localDrafts"][number]["errorCode"] | null,
): boolean {
  return (
    errorCode === "ANNOTATION_OFFLINE" ||
    errorCode === "ANNOTATION_SEQUENCE_CONFLICT" ||
    errorCode === "ANNOTATION_PAGE_CAPACITY_REACHED"
  );
}

function annotationControllerFailureCode(
  cause: unknown,
): NonNullable<DrawingControllerStatus["errorCode"]> {
  if (cause instanceof Error) {
    if (cause.message === "CORRUPT_ANNOTATION_REPLICA" || cause.message === "STORAGE_FAILURE") {
      return cause.message === "STORAGE_FAILURE" ? "ANNOTATION_STORAGE_FAILURE" : cause.message;
    }
    if (
      cause.message === "ANNOTATION_STORAGE_FAILURE" ||
      cause.message === "ANNOTATION_SNAPSHOT_REQUIRED"
    ) {
      return cause.message === "ANNOTATION_SNAPSHOT_REQUIRED"
        ? "ANNOTATION_PROTOCOL_FAILURE"
        : cause.message;
    }
    if (
      cause.name === "ZodError" ||
      cause.message === "ANNOTATION_CLIENT_OP_REUSE" ||
      cause.message === "ANNOTATION_DRAFT_OPERATION_MISMATCH"
    ) {
      return "ANNOTATION_PROTOCOL_FAILURE";
    }
    const transportCode = (cause as Error & { code?: unknown }).code;
    if (typeof transportCode === "string") {
      if (transportCode === "TRANSPORT_FAILURE") {
        return "ANNOTATION_OFFLINE";
      }
      const annotationCode = AnnotationErrorCodeSchema.safeParse(transportCode);
      return annotationCode.success ? annotationCode.data : "ANNOTATION_PROTOCOL_FAILURE";
    }
  }
  return "ANNOTATION_PROTOCOL_FAILURE";
}
