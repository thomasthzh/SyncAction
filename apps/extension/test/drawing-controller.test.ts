import {
  AnnotationAckV2Schema as AnnotationAckSchema,
  AnnotationCommittedOperationV2Schema as AnnotationCommittedOperationSchema,
  AnnotationDeltaV2MessageSchema as AnnotationDeltaMessageSchema,
  AnnotationSnapshotV2MessageSchema as AnnotationSnapshotMessageSchema,
  ClientOpIdSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  RoomSnapshotStateSchema,
  StrokePreviewEventMessageSchema,
  type AnnotationAckV2 as AnnotationAck,
  type AnnotationCommittedOperationV2 as AnnotationCommittedOperation,
  type AnnotationDeltaV2Message as AnnotationDeltaMessage,
  type AnnotationSnapshotV2Message as AnnotationSnapshotMessage,
  type AnnotationSubmitV2 as AnnotationSubmit,
  type ContentSignature,
  type AnnotationSyncRequest,
  type StrokePreviewClear,
  type StrokePreviewEventMessage,
  type StrokePreviewUpdate,
} from "@syncaction/protocol";
import { ReplicaRecordSchema, type ReplicaRecord } from "@syncaction/replica";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnnotationReplica,
  annotationReplicaStorageKey,
  type AnnotationReplicaStorageArea,
} from "../src/annotation-replica.js";
import { DEFAULT_SERVER_PROFILE_ID } from "../src/server-profile.js";
import { DrawingController, type DrawingControllerPagePort } from "../src/drawing-controller.js";
import {
  SocketReplicaTransportError,
  type AnnotationMessageHandler,
  type CollaborationTransport,
  type StrokePreviewMessageHandler,
} from "../src/socket-transport.js";
import type {
  CollaborationPageContext,
  DrawingDraftControlMessage,
  DrawingSelectionMessage,
  StrokeFinalMessage,
  StrokeSampleMessage,
} from "../src/page-collaboration/messages.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789f01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789f02");
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789f03";
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789f04";
const otherUserId = "018f8f8e-4b5c-7d6e-8f90-123456789f05";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789f06");
const strokeId = ClientOpIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789f07");
const otherStrokeId = "018f8f8e-4b5c-7d6e-8f90-123456789f08";
const mutationOpId = ClientOpIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789f09");
const previewId = "018f8f8e-4b5c-7d6e-8f90-123456789f10";
const pageKey = "C".repeat(43);
const now = 1_785_140_000_000;
const contentSignature: ContentSignature = {
  signatureVersion: 1,
  digest: "S".repeat(43),
};

const context: CollaborationPageContext = {
  roomId,
  logicalTabId,
  documentRevision: {
    roomEpoch: 4,
    tabUpdatedAtSeq: 6,
  },
  frameKey: "top",
};
const childFrameKey = "frame:sha256-0123456789abcdef0123456789abcdef" as const;
const childContext: CollaborationPageContext = {
  ...context,
  frameKey: childFrameKey,
};

const unsignedDraft = {
  strokeId,
  frameKey: "top" as const,
  anchor: {
    type: "document" as const,
    layoutSignature: {
      widthCssPx: 1440,
      heightCssPx: 2400,
    },
  },
  points: [
    { x: 0.1, y: 0.2, pressure: 0.5 },
    { x: 0.2, y: 0.3, pressure: 0.7 },
  ],
  rgb: { r: 12, g: 34, b: 56 },
  width: 6,
};
const draft = {
  ...unsignedDraft,
  contentSignature,
};
const unsignedChildDraft = {
  ...unsignedDraft,
  frameKey: childFrameKey,
};
const childDraft = {
  ...draft,
  frameKey: childFrameKey,
};

function durableRecord(
  overrides: { mode?: ReplicaRecord["mode"]; tabUpdatedAtSeq?: number } = {},
): ReplicaRecord {
  const snapshot = RoomSnapshotStateSchema.parse({
    roomId,
    roomEpoch: 4,
    serverSeq: 10,
    order: [logicalTabId],
    tabs: [
      {
        id: logicalTabId,
        url: "https://example.com/canvas",
        title: "Canvas",
        favIconUrl: null,
        createdAtSeq: 1,
        updatedAtSeq: overrides.tabUpdatedAtSeq ?? 6,
        closedAtSeq: null,
      },
    ],
  });
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId,
    mode: overrides.mode ?? "SYNCED",
    confirmedSnapshot: snapshot,
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: [
      {
        logicalTabId,
        tabId: 12,
        windowId: 1,
        groupId: 2,
        browserSessionId,
        validatedAtServerSeq: 10,
      },
    ],
    quarantineReason: null,
    updatedAtMs: now,
  });
}

function snapshot(
  input: {
    sequence?: number;
    strokes?: AnnotationSnapshotMessage["strokes"];
  } = {},
): AnnotationSnapshotMessage {
  return AnnotationSnapshotMessageSchema.parse({
    type: "annotation.snapshot.v2",
    protocolVersion: 1,
    ...context,
    pageKey,
    annotationSeq: input.sequence ?? 0,
    strokes: input.strokes ?? [],
  });
}

function finalMessage(pageContext: CollaborationPageContext = context): StrokeFinalMessage {
  return {
    type: "syncaction.stroke.final",
    controller: "drawing",
    context: pageContext,
    stroke: unsignedDraft,
  };
}

function previewMessage(points = draft.points): StrokeSampleMessage {
  return {
    type: "syncaction.stroke.sample",
    controller: "drawing",
    context,
    preview: {
      type: "stroke.preview.update",
      protocolVersion: 1,
      previewId,
      ...context,
      anchor: draft.anchor,
      points,
      rgb: draft.rgb,
      width: draft.width,
    },
  };
}

class MemoryArea implements AnnotationReplicaStorageArea {
  public readonly values = new Map<string, unknown>();
  public failNextSet = false;

  public async get(key: string): Promise<Record<string, unknown>> {
    return this.values.has(key) ? { [key]: structuredClone(this.values.get(key)) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("storage quota");
    }
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }
}

class FakeTransport implements Pick<
  CollaborationTransport,
  | "setAnnotationHandler"
  | "setStrokePreviewHandler"
  | "synchronizeAnnotations"
  | "submitAnnotation"
  | "publishStrokePreview"
  | "clearStrokePreview"
> {
  public annotationHandler: AnnotationMessageHandler | undefined;
  public previewHandler: StrokePreviewMessageHandler | undefined;
  public readonly syncRequests: AnnotationSyncRequest[] = [];
  public readonly submissions: AnnotationSubmit[] = [];
  public readonly previews: StrokePreviewUpdate[] = [];
  public readonly clears: StrokePreviewClear[] = [];
  public synchronizeImplementation:
    | ((
        request: AnnotationSyncRequest,
      ) => Promise<AnnotationSnapshotMessage | AnnotationDeltaMessage>)
    | undefined;
  public submitImplementation:
    ((submission: AnnotationSubmit) => Promise<AnnotationAck>) | undefined;
  public previewImplementation: ((preview: StrokePreviewUpdate) => Promise<void>) | undefined;

  public setAnnotationHandler(handler: AnnotationMessageHandler | undefined): void {
    this.annotationHandler = handler;
  }

  public setStrokePreviewHandler(handler: StrokePreviewMessageHandler | undefined): void {
    this.previewHandler = handler;
  }

  public async synchronizeAnnotations(
    request: AnnotationSyncRequest,
  ): Promise<AnnotationSnapshotMessage | AnnotationDeltaMessage> {
    this.syncRequests.push(structuredClone(request));
    return this.synchronizeImplementation?.(request) ?? snapshot();
  }

  public async submitAnnotation(submission: AnnotationSubmit): Promise<AnnotationAck> {
    this.submissions.push(structuredClone(submission));
    if (this.submitImplementation !== undefined) {
      return this.submitImplementation(submission);
    }
    const committed = committedFor(submission, 1);
    const acknowledgement = acceptedAckFor(committed);
    queueMicrotask(() => this.annotationHandler?.(committed));
    return acknowledgement;
  }

  public async publishStrokePreview(preview: StrokePreviewUpdate): Promise<void> {
    this.previews.push(structuredClone(preview));
    await this.previewImplementation?.(preview);
  }

  public async clearStrokePreview(clear: StrokePreviewClear): Promise<void> {
    this.clears.push(structuredClone(clear));
  }

  public emitPreview(message: StrokePreviewEventMessage): void {
    this.previewHandler?.(message);
  }
}

class FakePage implements DrawingControllerPagePort {
  public readonly snapshots: Array<{
    tabId: number;
    context: CollaborationPageContext;
    snapshot: AnnotationSnapshotMessage;
  }> = [];
  public readonly committed: AnnotationCommittedOperation[] = [];
  public readonly acknowledgements: AnnotationAck[] = [];
  public readonly drafts: Array<{
    strokeId: string;
    status: "PENDING" | "ERROR";
    retryable: boolean;
  }> = [];
  public readonly previews: StrokePreviewEventMessage[] = [];
  public readonly clears: unknown[] = [];
  public readonly disposed: Array<{ tabId: number; context: CollaborationPageContext }> = [];
  public readonly viewers: Array<{ userId: string; role: "OWNER" | "MEMBER" }> = [];
  public snapshotImplementation: (() => void | Promise<void>) | undefined;
  public elementAnchorSignature: ContentSignature | null = contentSignature;

  public async setDrawingViewer(
    _tabId: number,
    _context: CollaborationPageContext,
    viewer: { userId: string; role: "OWNER" | "MEMBER" },
  ): Promise<void> {
    this.viewers.push(viewer);
  }

  public async renderAnnotationSnapshot(
    tabId: number,
    pageContext: CollaborationPageContext,
    value: AnnotationSnapshotMessage,
  ): Promise<void> {
    await this.snapshotImplementation?.();
    this.snapshots.push({
      tabId,
      context: structuredClone(pageContext),
      snapshot: structuredClone(value),
    });
  }

  public async renderAnnotationCommitted(
    _tabId: number,
    _context: CollaborationPageContext,
    value: AnnotationCommittedOperation,
  ): Promise<void> {
    this.committed.push(structuredClone(value));
  }

  public async renderAnnotationAcknowledgement(
    _tabId: number,
    _context: CollaborationPageContext,
    value: AnnotationAck,
  ): Promise<void> {
    this.acknowledgements.push(structuredClone(value));
  }

  public async renderLocalDraft(
    _tabId: number,
    _context: CollaborationPageContext,
    value: typeof draft,
    status: "PENDING" | "ERROR",
    retryable: boolean,
  ): Promise<void> {
    this.drafts.push({ strokeId: value.strokeId, status, retryable });
  }

  public async renderStrokePreview(
    _tabId: number,
    _context: CollaborationPageContext,
    value: StrokePreviewEventMessage,
  ): Promise<void> {
    this.previews.push(structuredClone(value));
  }

  public async clearStrokePreview(
    _tabId: number,
    _context: CollaborationPageContext,
    value: unknown,
  ): Promise<void> {
    this.clears.push(structuredClone(value));
  }

  public async clearDrawing(tabId: number, pageContext: CollaborationPageContext): Promise<void> {
    this.disposed.push({ tabId, context: structuredClone(pageContext) });
  }

  public async resolveElementAnchorSignature(): Promise<ContentSignature | null> {
    return this.elementAnchorSignature === null
      ? null
      : structuredClone(this.elementAnchorSignature);
  }
}

function committedFor(
  submission: AnnotationSubmit,
  annotationSeq: number,
): AnnotationCommittedOperation {
  const stroke =
    submission.operation.type === "stroke.create"
      ? submission.operation.stroke.strokeId
      : submission.operation.items[0]!.strokeId;
  return AnnotationCommittedOperationSchema.parse({
    type: "annotation.committed.v2",
    protocolVersion: 1,
    clientOpId: submission.clientOpId,
    roomId,
    pageKey,
    annotationSeq,
    actorUserId: userId,
    operation: submission.operation,
    results: [
      {
        strokeId: stroke,
        accepted: true,
        code: null,
        version: 1,
      },
    ],
    createdAtServerMs: now,
  });
}

function acceptedAckFor(committed: AnnotationCommittedOperation): AnnotationAck {
  return AnnotationAckSchema.parse({
    type: "annotation.ack.v2",
    protocolVersion: 1,
    clientOpId: committed.clientOpId,
    roomId,
    accepted: true,
    code: null,
    pageKey,
    annotationSeq: committed.annotationSeq,
    results: committed.results,
  });
}

let currentRecord: ReplicaRecord;
let area: MemoryArea;
let annotations: AnnotationReplica;
let transport: FakeTransport;
let page: FakePage;
let controller: DrawingController;
let currentContentSignature: ContentSignature | null;

function createController(role: "OWNER" | "MEMBER" = "MEMBER"): DrawingController {
  return new DrawingController({
    roomId,
    userId,
    roomRole: role,
    browserSessionId,
    replica: {
      getRecord: vi.fn(async () => currentRecord),
    },
    annotations,
    contentSignatures: {
      getLocalContentSignature: () =>
        currentContentSignature === null ? null : structuredClone(currentContentSignature),
    },
    transport,
    page,
    createId: () => mutationOpId,
  });
}

beforeEach(() => {
  currentRecord = durableRecord();
  area = new MemoryArea();
  annotations = new AnnotationReplica({
    area,
    profileId: DEFAULT_SERVER_PROFILE_ID,
    userId,
    now: () => now,
  });
  transport = new FakeTransport();
  page = new FakePage();
  currentContentSignature = contentSignature;
  controller = createController();
});

async function activate(): Promise<void> {
  await controller.handlePageReady(12, 0, "top");
  await controller.handleActiveTabChanged(12);
  await controller.setSynchronized(true);
  await controller.whenIdle();
}

describe("DrawingController content-bound annotations", () => {
  it("rejects a final stroke while the local page signature is unknown", async () => {
    currentContentSignature = null;
    await activate();

    expect(controller.getStatus()).toMatchObject({ ready: true, canCreate: false });
    await expect(controller.handleStrokeFinal(12, 0, finalMessage())).rejects.toThrow(
      "CONTENT_UNKNOWN",
    );
    expect(transport.submissions).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).outbox).toEqual([]);
  });

  it("retains a mismatched root stroke and renders it after the local signature matches", async () => {
    const remoteSignature: ContentSignature = {
      signatureVersion: 1,
      digest: "R".repeat(43),
    };
    const remoteStroke = {
      ...draft,
      contentSignature: remoteSignature,
      authorUserId: otherUserId,
      lockedAtServerMs: null,
      version: 1,
      createdAtServerMs: now,
      deletedAtServerMs: null,
    };
    transport.synchronizeImplementation = async () =>
      snapshot({ sequence: 1, strokes: [remoteStroke] });

    await activate();

    expect(page.snapshots.at(-1)?.snapshot.strokes).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).confirmedSnapshot?.strokes).toEqual([
      remoteStroke,
    ]);

    currentContentSignature = remoteSignature;
    await controller.handleContentCompatibilityChanged(12, logicalTabId);

    expect(page.snapshots.at(-1)?.snapshot.strokes).toEqual([remoteStroke]);
  });

  it("renders a mismatched element stroke only while its local anchor signature matches", async () => {
    const remotePageSignature: ContentSignature = {
      signatureVersion: 1,
      digest: "P".repeat(43),
    };
    const anchorSignature: ContentSignature = {
      signatureVersion: 1,
      digest: "E".repeat(43),
    };
    const elementStroke = {
      ...draft,
      anchor: {
        type: "element" as const,
        path: [{ tagName: "html", nthOfType: 1 }],
        anchorSignature,
      },
      contentSignature: remotePageSignature,
      authorUserId: otherUserId,
      lockedAtServerMs: null,
      version: 1,
      createdAtServerMs: now,
      deletedAtServerMs: null,
    };
    page.elementAnchorSignature = anchorSignature;
    transport.synchronizeImplementation = async () =>
      snapshot({ sequence: 1, strokes: [elementStroke] });

    await activate();
    expect(page.snapshots.at(-1)?.snapshot.strokes).toEqual([elementStroke]);

    page.elementAnchorSignature = {
      signatureVersion: 1,
      digest: "D".repeat(43),
    };
    await controller.handleContentCompatibilityChanged(12, logicalTabId);
    expect(page.snapshots.at(-1)?.snapshot.strokes).toEqual([]);
  });

  it("requires and persists a local element anchor signature for a new element stroke", async () => {
    const elementFinal: StrokeFinalMessage = {
      ...finalMessage(),
      stroke: {
        ...unsignedDraft,
        anchor: {
          type: "element",
          path: [{ tagName: "html", nthOfType: 1 }],
        },
      },
    };
    page.elementAnchorSignature = null;
    await activate();

    await expect(controller.handleStrokeFinal(12, 0, elementFinal)).rejects.toThrow(
      "CONTENT_UNKNOWN",
    );
    page.elementAnchorSignature = {
      signatureVersion: 1,
      digest: "E".repeat(43),
    };
    await controller.handleStrokeFinal(12, 0, elementFinal);
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0]?.operation).toMatchObject({
      type: "stroke.create",
      stroke: {
        contentSignature,
        anchor: {
          type: "element",
          anchorSignature: page.elementAnchorSignature,
        },
      },
    });
  });
});

describe("DrawingController page synchronization and previews", () => {
  it("blocks only relevant page capability failures and preserves child degradation", async () => {
    await activate();
    await controller.handlePageCapability({
      tabId: 12,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DANMAKU",
        state: "DEGRADED",
        errorCode: "DANMAKU_RUNTIME_FAILED",
      },
    });
    expect(controller.getStatus().ready).toBe(true);

    await controller.handlePageCapability({
      tabId: 12,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DRAWING",
        state: "DEGRADED",
        errorCode: "DRAWING_RUNTIME_FAILED",
      },
    });
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      ready: false,
      errorCode: "DRAWING_RUNTIME_FAILED",
    });
    await expect(controller.handleStrokeFinal(12, 0, finalMessage())).rejects.toThrow(
      "ANNOTATION_FINAL_ROUTE_STALE",
    );
    expect(transport.submissions).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).outbox).toEqual([]);

    await controller.handlePageReady(12, 0, "top", 1);
    expect(controller.getStatus().ready).toBe(true);
    await controller.handlePageCapability({
      tabId: 12,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      },
    });
    await controller.handlePageReady(12, 0, "top", 1);
    expect(controller.getStatus().ready).toBe(false);
    await controller.handlePageCapability({
      tabId: 12,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "AVAILABLE",
        errorCode: null,
      },
    });
    expect(controller.getStatus()).toMatchObject({
      state: "ONLINE",
      ready: true,
      errorCode: null,
    });

    await controller.handlePageReady(12, 3, childFrameKey);
    await controller.handlePageCapability({
      tabId: 12,
      frameId: 3,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      },
    });
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      ready: true,
      errorCode: "PAGE_HOST_CONFLICT",
    });
    expect(controller.isReadyFor(12, context)).toBe(true);
  });

  it("preserves a reachable route when only the drawing runtime is degraded", async () => {
    page.snapshotImplementation = async () => {
      throw Object.assign(new Error("DRAWING_RUNTIME_LOAD_FAILED"), {
        code: "PAGE_TOOL_REACHABLE_DEGRADED",
      });
    };

    await activate();
    await controller.handlePageCapability({
      tabId: 12,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DRAWING",
        state: "DEGRADED",
        errorCode: "DRAWING_RUNTIME_LOAD_FAILED",
      },
    });

    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      ready: false,
      canRetry: true,
      errorCode: "DRAWING_RUNTIME_LOAD_FAILED",
    });
    expect(controller.canRetryFor(12, context)).toBe(true);
    page.snapshotImplementation = undefined;
    await controller.handlePageCapability({
      tabId: 12,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DRAWING",
        state: "AVAILABLE",
        errorCode: null,
      },
    });

    expect(controller.getStatus()).toMatchObject({
      state: "ONLINE",
      ready: true,
      canRetry: false,
      errorCode: null,
    });
  });

  it("marks the old page route not ready synchronously while a binding refresh is deferred", async () => {
    let resolveRefresh: ((value: ReplicaRecord) => void) | undefined;
    const deferred = new Promise<ReplicaRecord>((resolve) => {
      resolveRefresh = resolve;
    });
    let reads = 0;
    transport.synchronizeImplementation = async (request) =>
      AnnotationSnapshotMessageSchema.parse({
        ...snapshot(),
        documentRevision: request.documentRevision,
        frameKey: request.frameKey,
      });
    controller = new DrawingController({
      roomId,
      userId,
      roomRole: "MEMBER",
      browserSessionId,
      replica: {
        getRecord: async () => {
          reads += 1;
          return reads === 1 ? currentRecord : deferred;
        },
      },
      annotations,
      contentSignatures: {
        getLocalContentSignature: () =>
          currentContentSignature === null ? null : structuredClone(currentContentSignature),
      },
      transport,
      page,
      createId: () => mutationOpId,
    });
    await activate();
    expect(controller.getStatus().ready).toBe(true);

    const refreshing = controller.handleBindingsChanged();
    expect(controller.getStatus().ready).toBe(false);
    expect(controller.isReadyFor(12, context)).toBe(false);
    await vi.waitFor(() => expect(page.disposed).toContainEqual({ tabId: 12, context }));
    const staleFinal = controller.handleStrokeFinal(12, 0, finalMessage());
    const staleFinalRejection = expect(staleFinal).rejects.toThrow("ANNOTATION_FINAL_ROUTE_STALE");
    resolveRefresh?.(durableRecord({ tabUpdatedAtSeq: 7 }));
    await Promise.all([refreshing, staleFinalRejection]);

    expect(controller.getStatus().ready).toBe(true);
    expect(
      controller.isReadyFor(12, {
        ...context,
        documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 7 },
      }),
    ).toBe(true);
    expect(transport.submissions).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).outbox).toEqual([]);
  });

  it("synchronizes the exact binding, installs the authenticated viewer, and ignores wrong-frame data", async () => {
    await activate();

    expect(transport.syncRequests).toEqual([
      {
        protocolVersion: 1,
        ...context,
        lastAnnotationSeq: 0,
        hasConfirmedSnapshot: false,
      },
    ]);
    expect(page.snapshots).toHaveLength(1);
    expect(page.viewers).toEqual([{ userId, role: "MEMBER" }]);

    const frameContext = {
      ...context,
      frameKey: "frame:sha256-0123456789abcdef0123456789abcdef" as const,
    };
    await controller.handleStrokeSample(12, 1, {
      ...previewMessage(),
      context: frameContext,
      preview: {
        ...previewMessage().preview,
        ...frameContext,
      },
    });
    expect(transport.previews).toEqual([]);
  });

  it("persists and submits a child-frame stroke through its exact frame context", async () => {
    await activate();
    await controller.handlePageReady(12, 3, childFrameKey);

    await controller.handleStrokeFinal(12, 3, {
      type: "syncaction.stroke.final",
      controller: "drawing",
      context: childContext,
      stroke: unsignedChildDraft,
    });
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0]).toMatchObject({
      ...childContext,
      operation: {
        type: "stroke.create",
        stroke: childDraft,
      },
    });
    expect(page.snapshots.some((rendered) => rendered.context.frameKey === childFrameKey)).toBe(
      true,
    );
    expect(controller.getStatus()).toMatchObject({
      active: false,
      tool: "PEN",
      selectedCount: 0,
      selectedLockedCount: 0,
    });
  });

  it("drops old child routes when a replacement top document becomes ready", async () => {
    await activate();
    await controller.handlePageReady(12, 3, childFrameKey);
    await controller.handlePageReport(12, 3, {
      context: childContext,
      active: false,
      tool: "PEN",
      rgb: { r: 0, g: 122, b: 255 },
      width: 6,
      selectedCount: 0,
      selectedLockedCount: 0,
      unlocatableCount: 4,
    });
    expect(controller.getStatus().unlocatableCount).toBe(4);

    await controller.handlePageReady(12, 0, "top", 2);
    await expect(
      controller.handleStrokeFinal(12, 3, {
        type: "syncaction.stroke.final",
        controller: "drawing",
        context: childContext,
        stroke: unsignedChildDraft,
      }),
    ).rejects.toThrow("ANNOTATION_FINAL_ROUTE_STALE");

    expect(page.disposed.some((entry) => entry.context.frameKey === childFrameKey)).toBe(true);
    expect(controller.getStatus().unlocatableCount).toBe(0);
    expect(transport.submissions).toEqual([]);
  });

  it("preserves child-frame degradation after a successful top commit", async () => {
    await activate();
    await controller.handlePageReady(12, 3, childFrameKey);
    await controller.handlePageUnavailable(12, 3, childFrameKey);

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      ready: true,
      errorCode: "PAGE_TOOL_PERMISSION_REQUIRED",
    });

    transport.synchronizeImplementation = async () =>
      snapshot({
        sequence: 1,
        strokes: [
          {
            ...draft,
            authorUserId: userId,
            lockedAtServerMs: null,
            version: 1,
            createdAtServerMs: now,
            deletedAtServerMs: null,
          },
        ],
      });
    await controller.handlePageReady(12, 3, childFrameKey);
    expect(controller.getStatus().errorCode).toBeNull();
  });

  it("keeps a new child that reports before the replacement top document", async () => {
    await activate();
    await controller.handlePageReady(12, 3, childFrameKey, 1);

    await controller.handlePageReady(12, 3, childFrameKey, 2);
    await controller.handlePageReady(12, 0, "top", 2);
    await controller.handleStrokeFinal(12, 3, {
      type: "syncaction.stroke.final",
      controller: "drawing",
      context: childContext,
      stroke: unsignedChildDraft,
    });
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0]).toMatchObject(childContext);
    expect(page.disposed.some((entry) => entry.context.frameKey === childFrameKey)).toBe(true);
  });

  it("replays a child-frame mutation with its persisted origin after restart", async () => {
    const childStroke = {
      ...childDraft,
      authorUserId: userId,
      lockedAtServerMs: null,
      version: 1,
      createdAtServerMs: now,
      deletedAtServerMs: null,
    };
    transport.synchronizeImplementation = async () =>
      snapshot({ sequence: 1, strokes: [childStroke] });
    await activate();
    await controller.handlePageReady(12, 3, childFrameKey);
    await controller.setSynchronized(false);

    await controller.handleSelection(12, 3, {
      type: "syncaction.drawing.selection",
      controller: "drawing",
      context: childContext,
      action: "LOCK",
      items: [{ strokeId, expectedVersion: 1 }],
    });
    expect((await annotations.load(roomId, pageKey)).outbox).toMatchObject([
      {
        frameKey: childFrameKey,
        operation: { type: "stroke.lock" },
      },
    ]);

    transport.submitImplementation = async (submission) => {
      const committed = committedFor(submission, 2);
      queueMicrotask(() => transport.annotationHandler?.(committed));
      return acceptedAckFor(committed);
    };
    await controller.setSynchronized(true);
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0]).toMatchObject(childContext);
  });

  it("coalesces moving previews to the latest sample while one publish is blocked", async () => {
    let releaseFirst: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    transport.previewImplementation = vi
      .fn()
      .mockImplementationOnce(async () => blocked)
      .mockResolvedValue(undefined);
    await activate();

    const first = previewMessage([{ x: 0.1, y: 0.2, pressure: 0.5 }]);
    const second = previewMessage([{ x: 0.3, y: 0.4, pressure: 0.6 }]);
    const third = previewMessage([{ x: 0.7, y: 0.8, pressure: 0.9 }]);
    const firstPublish = controller.handleStrokeSample(12, 0, first);
    await vi.waitFor(() => expect(transport.previews).toHaveLength(1));
    await expect(firstPublish).resolves.toBeUndefined();
    await controller.handleStrokeSample(12, 0, second);
    await controller.handleStrokeSample(12, 0, third);
    await Promise.resolve();
    await Promise.resolve();
    releaseFirst?.();
    await controller.whenIdle();

    expect(transport.previews.map((preview) => preview.points)).toEqual([
      first.preview.points,
      third.preview.points,
    ]);
  });

  it("renders only exact live previews and reports the page's unlocatable count", async () => {
    await activate();
    const remote = StrokePreviewEventMessageSchema.parse({
      type: "stroke.preview.event",
      protocolVersion: 1,
      previewId,
      ...context,
      sender: {
        userId: otherUserId,
        username: "other",
        displayName: "Other",
        deviceId,
      },
      anchor: draft.anchor,
      points: draft.points,
      rgb: draft.rgb,
      width: draft.width,
      expiresAtServerMs: now + 3_000,
    });

    transport.emitPreview(remote);
    await controller.handlePageReport(12, 0, {
      context,
      active: true,
      tool: "SELECT",
      rgb: { r: 0, g: 122, b: 255 },
      width: 6,
      selectedCount: 1,
      selectedLockedCount: 0,
      unlocatableCount: 3,
    });
    await controller.whenIdle();

    expect(page.previews).toEqual([remote]);
    expect(controller.getStatus()).toMatchObject({
      unlocatableCount: 3,
      active: true,
      tool: "SELECT",
      selectedCount: 1,
      selectedLockedCount: 0,
    });
  });

  it("reports corrupt local annotation storage without blaming the server or tab replica", async () => {
    area.values.set(
      annotationReplicaStorageKey(DEFAULT_SERVER_PROFILE_ID, userId, roomId, pageKey),
      {
        schemaVersion: 1,
        roomId,
        pageKey,
        confirmedSnapshot: "corrupt",
      },
    );

    await activate();

    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "CORRUPT_ANNOTATION_REPLICA",
    });
    expect(currentRecord.mode).toBe("SYNCED");
    expect(transport.syncRequests).toHaveLength(1);
  });

  it("stops after one invalid delta when a full snapshot was requested", async () => {
    await annotations.applySnapshot(snapshot({ sequence: 2 }));
    let attempts = 0;
    transport.synchronizeImplementation = async () => {
      attempts += 1;
      if (attempts > 1) {
        throw new Error("unexpected repeated full synchronization");
      }
      return AnnotationDeltaMessageSchema.parse({
        type: "annotation.delta.v2",
        protocolVersion: 1,
        ...context,
        pageKey,
        fromAnnotationSeq: 4,
        toAnnotationSeq: 4,
        operations: [],
      });
    };

    await activate();

    expect(transport.syncRequests).toHaveLength(1);
    expect(transport.syncRequests[0]).toMatchObject({
      lastAnnotationSeq: 0,
      hasConfirmedSnapshot: false,
    });
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ANNOTATION_PROTOCOL_FAILURE",
    });
  });

  it("rejects a schema-valid synchronization response for another exact document", async () => {
    transport.synchronizeImplementation = async () =>
      AnnotationSnapshotMessageSchema.parse({
        ...snapshot(),
        frameKey: "frame:sha256-0123456789abcdef0123456789abcdef",
      });

    await activate();

    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ANNOTATION_PROTOCOL_FAILURE",
      pageKey: null,
    });
  });

  it("recovers an initial snapshot storage failure without claiming a nonexistent local snapshot", async () => {
    area.failNextSet = true;
    transport.synchronizeImplementation = async (request) =>
      request.hasConfirmedSnapshot
        ? AnnotationDeltaMessageSchema.parse({
            type: "annotation.delta.v2",
            protocolVersion: 1,
            ...context,
            pageKey,
            fromAnnotationSeq: 0,
            toAnnotationSeq: 0,
            operations: [],
          })
        : snapshot();

    await activate();
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ANNOTATION_STORAGE_FAILURE",
      pageKey: null,
    });

    await controller.setSynchronized(false);
    await controller.setSynchronized(true);
    await controller.whenIdle();

    expect(transport.syncRequests.map((request) => request.hasConfirmedSnapshot)).toEqual([
      false,
      false,
    ]);
    expect(controller.getStatus()).toMatchObject({
      state: "ONLINE",
      errorCode: null,
      pageKey,
    });
  });
});

describe("DrawingController durable operations", () => {
  it("rejects a final stroke when durable storage fails before submission", async () => {
    await activate();
    area.failNextSet = true;

    await expect(controller.handleStrokeFinal(12, 0, finalMessage())).rejects.toThrow(
      "ANNOTATION_STORAGE_FAILURE",
    );

    expect(transport.submissions).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      errorCode: "ANNOTATION_STORAGE_FAILURE",
    });
  });

  it("rejects a selection mutation when durable storage fails before submission", async () => {
    transport.synchronizeImplementation = async () =>
      snapshot({
        sequence: 1,
        strokes: [
          {
            ...draft,
            authorUserId: userId,
            lockedAtServerMs: null,
            version: 1,
            createdAtServerMs: now,
            deletedAtServerMs: null,
          },
        ],
      });
    await activate();
    area.failNextSet = true;

    await expect(
      controller.handleSelection(12, 0, {
        type: "syncaction.drawing.selection",
        controller: "drawing",
        context,
        action: "LOCK",
        items: [{ strokeId, expectedVersion: 1 }],
      }),
    ).rejects.toThrow("ANNOTATION_STORAGE_FAILURE");

    expect(transport.submissions).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      errorCode: "ANNOTATION_STORAGE_FAILURE",
    });
  });

  it("persists a pointer-up that was queued immediately before disconnect", async () => {
    await activate();

    const finalizing = controller.handleStrokeFinal(12, 0, finalMessage());
    const disconnecting = controller.setSynchronized(false);
    await Promise.all([finalizing, disconnecting]);

    expect(transport.submissions).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).localDrafts).toMatchObject([
      {
        clientOpId: strokeId,
        status: "ERROR",
        errorCode: "ANNOTATION_OFFLINE",
      },
    ]);
    expect((await annotations.getRetryableOperations(roomId, pageKey))[0]).toMatchObject({
      clientOpId: strokeId,
      operation: { type: "stroke.create" },
    });
  });

  it("discards and retries drafts only through the exact durable page route", async () => {
    transport.submitImplementation = vi
      .fn()
      .mockRejectedValue(new SocketReplicaTransportError("TRANSPORT_FAILURE"));
    await activate();
    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    const control = (action: "DISCARD" | "RETRY"): DrawingDraftControlMessage => ({
      type: "syncaction.annotation.draft.control",
      controller: "drawing",
      context,
      action,
      strokeId,
    });
    await expect(
      controller.handleDraftControl(12, 0, {
        ...control("DISCARD"),
        context: {
          ...context,
          documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 999 },
        },
      }),
    ).rejects.toThrow("ANNOTATION_DRAFT_ROUTE_STALE");
    expect((await annotations.load(roomId, pageKey)).localDrafts).toHaveLength(1);

    await controller.handleDraftControl(12, 0, control("DISCARD"));
    expect((await annotations.load(roomId, pageKey)).localDrafts).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).outbox).toEqual([]);

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();
    transport.submitImplementation = async (submission) => {
      const committed = committedFor(submission, 1);
      queueMicrotask(() => transport.annotationHandler?.(committed));
      return acceptedAckFor(committed);
    };
    await controller.handleDraftControl(12, 0, control("RETRY"));
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(3);
    expect((await annotations.load(roomId, pageKey)).localDrafts).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).outbox).toEqual([]);
  });

  it("does not report an in-flight create as discarded while the server can still commit it", async () => {
    let resolveSubmission: ((acknowledgement: AnnotationAck) => void) | undefined;
    transport.submitImplementation = () =>
      new Promise<AnnotationAck>((resolve) => {
        resolveSubmission = resolve;
      });
    await activate();

    const finalizing = controller.handleStrokeFinal(12, 0, finalMessage());
    await vi.waitFor(() => expect(transport.submissions).toHaveLength(1));
    await expect(finalizing).resolves.toBeUndefined();
    await expect(
      controller.handleDraftControl(12, 0, {
        type: "syncaction.annotation.draft.control",
        controller: "drawing",
        context,
        action: "DISCARD",
        strokeId,
      }),
    ).rejects.toThrow("ANNOTATION_DRAFT_SUBMITTING");
    expect((await annotations.load(roomId, pageKey)).localDrafts).toHaveLength(1);

    const submitted = transport.submissions[0]!;
    const committed = committedFor(submitted, 1);
    resolveSubmission?.(acceptedAckFor(committed));
    transport.annotationHandler?.(committed);
    await controller.whenIdle();

    expect((await annotations.load(roomId, pageKey)).confirmedSnapshot?.strokes).toHaveLength(1);
  });

  it("persists an old-page acknowledgement without rendering it into the newly active page", async () => {
    let resolveSubmission: ((acknowledgement: AnnotationAck) => void) | undefined;
    transport.submitImplementation = () =>
      new Promise<AnnotationAck>((resolve) => {
        resolveSubmission = resolve;
      });
    await activate();

    const finalizing = controller.handleStrokeFinal(12, 0, finalMessage());
    await vi.waitFor(() => expect(transport.submissions).toHaveLength(1));
    const switching = controller.handleActiveTabChanged(99);
    const committed = committedFor(transport.submissions[0]!, 1);
    resolveSubmission?.(acceptedAckFor(committed));
    await Promise.all([finalizing, switching]);
    await controller.whenIdle();

    expect(page.acknowledgements).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).outbox).toMatchObject([
      {
        clientOpId: strokeId,
        state: "ACKNOWLEDGED",
      },
    ]);
    expect(controller.getStatus().pageKey).toBeNull();
  });

  it("invalidates blocked old-revision work synchronously when durable bindings advance", async () => {
    let resolveSubmission: ((acknowledgement: AnnotationAck) => void) | undefined;
    transport.submitImplementation = () =>
      new Promise<AnnotationAck>((resolve) => {
        resolveSubmission = resolve;
      });
    transport.synchronizeImplementation = async (request) =>
      AnnotationSnapshotMessageSchema.parse({
        type: "annotation.snapshot.v2",
        protocolVersion: 1,
        roomId,
        logicalTabId,
        documentRevision: request.documentRevision,
        frameKey: request.frameKey,
        pageKey,
        annotationSeq: 0,
        strokes: [],
      });
    await activate();

    const finalizing = controller.handleStrokeFinal(12, 0, finalMessage());
    await vi.waitFor(() => expect(transport.submissions).toHaveLength(1));
    currentRecord = durableRecord({ tabUpdatedAtSeq: 7 });
    const refreshing = controller.handleBindingsChanged();
    const committed = committedFor(transport.submissions[0]!, 1);
    resolveSubmission?.(acceptedAckFor(committed));
    await Promise.all([finalizing, refreshing]);
    await controller.whenIdle();

    expect(page.acknowledgements).toEqual([]);
    expect(page.snapshots.at(-1)?.context.documentRevision.tabUpdatedAtSeq).toBe(7);
  });

  it("persists a final stroke, retains it across failure, and retries the same operation ID", async () => {
    transport.submitImplementation = vi
      .fn()
      .mockRejectedValueOnce(new SocketReplicaTransportError("TRANSPORT_FAILURE"));
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();
    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0]?.clientOpId).toBe(strokeId);
    expect((await annotations.load(roomId, pageKey)).localDrafts).toMatchObject([
      {
        clientOpId: strokeId,
        status: "ERROR",
        errorCode: "ANNOTATION_OFFLINE",
      },
    ]);

    transport.submitImplementation = async (submission) => {
      const committed = committedFor(submission, 1);
      queueMicrotask(() => transport.annotationHandler?.(committed));
      return acceptedAckFor(committed);
    };
    await controller.setSynchronized(false);
    await controller.setSynchronized(true);
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(2);
    expect(transport.submissions.map((item) => item.clientOpId)).toEqual([strokeId, strokeId]);
    expect((await annotations.load(roomId, pageKey)).localDrafts).toEqual([]);
  });

  it("restarts a requested operation drain after reconnect overlaps an in-flight failure", async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    const blocked = new Promise<AnnotationAck>((_resolve, reject) => {
      rejectFirst = reject;
    });
    transport.submitImplementation = vi
      .fn()
      .mockImplementationOnce(async () => blocked)
      .mockImplementation(async (submission: AnnotationSubmit) => {
        const committed = committedFor(submission, 1);
        queueMicrotask(() => transport.annotationHandler?.(committed));
        return acceptedAckFor(committed);
      });
    await activate();

    const initialSubmit = controller.handleStrokeFinal(12, 0, finalMessage());
    await vi.waitFor(() => expect(transport.submissions).toHaveLength(1));
    const disconnect = controller.setSynchronized(false);
    const reconnect = controller.setSynchronized(true);
    await vi.waitFor(() => expect(transport.syncRequests).toHaveLength(2));
    rejectFirst?.(new SocketReplicaTransportError("TRANSPORT_FAILURE"));
    await Promise.all([initialSubmit, disconnect, reconnect]);
    await controller.whenIdle();

    expect(transport.submissions.map((submission) => submission.clientOpId)).toEqual([
      strokeId,
      strokeId,
    ]);
    expect((await annotations.load(roomId, pageKey)).localDrafts).toEqual([]);
  });

  it("does not report an unknown local annotation failure as a server outage", async () => {
    transport.submitImplementation = vi.fn().mockRejectedValueOnce(new Error("local decode bug"));
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ANNOTATION_PROTOCOL_FAILURE",
    });
  });

  it("rejects a schema-valid acknowledgement that belongs to another operation", async () => {
    transport.submitImplementation = async (submission) => {
      const acknowledgement = acceptedAckFor(committedFor(submission, 1));
      return AnnotationAckSchema.parse({
        ...acknowledgement,
        clientOpId: mutationOpId,
      });
    };
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ANNOTATION_PROTOCOL_FAILURE",
    });
    expect((await annotations.load(roomId, pageKey)).outbox).toMatchObject([
      {
        clientOpId: strokeId,
        state: "QUEUED",
      },
    ]);
  });

  it("rejects accepted acknowledgement results that do not match the submitted stroke IDs", async () => {
    transport.submitImplementation = async (submission) =>
      AnnotationAckSchema.parse({
        ...acceptedAckFor(committedFor(submission, 1)),
        results: [
          {
            strokeId: otherStrokeId,
            accepted: true,
            code: null,
            version: 1,
          },
        ],
      });
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ANNOTATION_PROTOCOL_FAILURE",
    });
    expect((await annotations.load(roomId, pageKey)).outbox).toMatchObject([
      {
        clientOpId: strokeId,
        state: "QUEUED",
      },
    ]);
  });

  it("durably accepts a pointer-up while disconnected and submits it after reconnect", async () => {
    await activate();
    await controller.setSynchronized(false);

    await controller.handleStrokeFinal(12, 0, finalMessage());
    expect(transport.submissions).toEqual([]);
    expect((await annotations.load(roomId, pageKey)).localDrafts).toMatchObject([
      {
        clientOpId: strokeId,
        status: "ERROR",
        errorCode: "ANNOTATION_OFFLINE",
      },
    ]);

    await controller.setSynchronized(true);
    await controller.whenIdle();

    expect(transport.submissions.map((submission) => submission.clientOpId)).toEqual([strokeId]);
    expect(transport.syncRequests.at(-1)).toMatchObject({
      lastAnnotationSeq: 0,
      hasConfirmedSnapshot: true,
    });
    expect((await annotations.load(roomId, pageKey)).localDrafts).toEqual([]);
  });

  it("stays permission-blocked across offline reconnect until a fresh top ready arrives", async () => {
    await activate();
    await controller.setSynchronized(false);
    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.handlePermissionBoundaryChanged();

    await controller.setSynchronized(true);
    await controller.handleActiveTabChanged(12);
    await controller.whenIdle();

    expect(transport.syncRequests).toHaveLength(1);
    expect(transport.submissions).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      ready: false,
      errorCode: "PAGE_TOOL_PERMISSION_REQUIRED",
    });

    await controller.handlePageReady(12, 0, "top");
    await controller.whenIdle();

    expect(transport.syncRequests).toHaveLength(2);
    expect(transport.submissions.map((submission) => submission.clientOpId)).toEqual([strokeId]);
    expect(controller.getStatus().ready).toBe(true);
  });

  it("skips an unavailable child outbox item so a later top cleanup can drain", async () => {
    const existingStroke = {
      ...draft,
      strokeId: otherStrokeId,
      authorUserId: otherUserId,
      lockedAtServerMs: null,
      version: 1,
      createdAtServerMs: now,
      deletedAtServerMs: null,
    };
    transport.synchronizeImplementation = async () =>
      snapshot({ sequence: 1, strokes: [existingStroke] });
    await activate();
    await controller.handlePageReady(12, 3, childFrameKey);
    await controller.setSynchronized(false);

    await controller.handleStrokeFinal(12, 3, {
      type: "syncaction.stroke.final",
      controller: "drawing",
      context: childContext,
      stroke: unsignedChildDraft,
    });
    await controller.handleSelection(12, 0, {
      type: "syncaction.drawing.selection",
      controller: "drawing",
      context,
      action: "DELETE",
      items: [{ strokeId: otherStrokeId, expectedVersion: 1 }],
    });
    await controller.handlePageUnavailable(12, 3, childFrameKey);

    transport.submitImplementation = async (submission) => {
      const committed = committedFor(submission, 2);
      queueMicrotask(() => transport.annotationHandler?.(committed));
      return acceptedAckFor(committed);
    };
    await controller.setSynchronized(true);
    await controller.whenIdle();

    expect(transport.submissions.map((submission) => submission.operation.type)).toEqual([
      "stroke.delete",
    ]);
    expect((await annotations.load(roomId, pageKey)).outbox).toMatchObject([
      {
        clientOpId: strokeId,
        frameKey: childFrameKey,
        state: "QUEUED",
      },
    ]);
  });

  it("surfaces capacity and operation conflicts without retrying permanent failures", async () => {
    transport.submitImplementation = async (submission) =>
      AnnotationAckSchema.parse({
        type: "annotation.ack.v2",
        protocolVersion: 1,
        clientOpId: submission.clientOpId,
        roomId,
        accepted: false,
        code: "ANNOTATION_PAGE_CAPACITY_REACHED",
        pageKey,
        annotationSeq: null,
        results: [],
      });
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(controller.getStatus()).toMatchObject({
      capacityState: "FULL",
      canCreate: false,
      errorCode: "ANNOTATION_PAGE_CAPACITY_REACHED",
    });
    expect(transport.submissions).toHaveLength(1);

    transport.annotationHandler?.(snapshot({ sequence: 1 }));
    await controller.whenIdle();

    expect(controller.getStatus()).toMatchObject({
      state: "ONLINE",
      capacityState: "AVAILABLE",
      canCreate: true,
      errorCode: null,
    });
  });

  it("continues draining cleanup operations after a capacity-rejected create", async () => {
    const existingStroke = {
      ...draft,
      strokeId: otherStrokeId,
      authorUserId: otherUserId,
      lockedAtServerMs: null,
      version: 1,
      createdAtServerMs: now,
      deletedAtServerMs: null,
    };
    transport.synchronizeImplementation = async () =>
      snapshot({ sequence: 1, strokes: [existingStroke] });
    await activate();
    await controller.setSynchronized(false);

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.handleSelection(12, 0, {
      type: "syncaction.drawing.selection",
      controller: "drawing",
      context,
      action: "DELETE",
      items: [{ strokeId: otherStrokeId, expectedVersion: 1 }],
    });

    transport.submitImplementation = async (submission) => {
      if (submission.operation.type === "stroke.create") {
        return AnnotationAckSchema.parse({
          type: "annotation.ack.v2",
          protocolVersion: 1,
          clientOpId: submission.clientOpId,
          roomId,
          accepted: false,
          code: "ANNOTATION_PAGE_CAPACITY_REACHED",
          pageKey,
          annotationSeq: null,
          results: [],
        });
      }
      const committed = committedFor(submission, 2);
      queueMicrotask(() => transport.annotationHandler?.(committed));
      return acceptedAckFor(committed);
    };

    await controller.setSynchronized(true);
    await controller.whenIdle();

    expect(transport.submissions.map((submission) => submission.operation.type)).toEqual([
      "stroke.create",
      "stroke.delete",
    ]);
    const persisted = await annotations.load(roomId, pageKey);
    expect(persisted.confirmedSnapshot?.strokes).toEqual([]);
    expect(persisted.outbox).toMatchObject([
      {
        clientOpId: strokeId,
        state: "FAILED",
        errorCode: "ANNOTATION_PAGE_CAPACITY_REACHED",
      },
    ]);
    expect(controller.getStatus()).toMatchObject({
      state: "ONLINE",
      used: 1,
      capacityState: "AVAILABLE",
      canCreate: true,
      errorCode: null,
    });
  });

  it("keeps terminal drafts visible without consuming capacity or disabling cleanup tools", async () => {
    transport.submitImplementation = async (submission) =>
      AnnotationAckSchema.parse({
        type: "annotation.ack.v2",
        protocolVersion: 1,
        clientOpId: submission.clientOpId,
        roomId,
        accepted: false,
        code: "ANNOTATION_CLIENT_OP_REUSE",
        pageKey,
        annotationSeq: null,
        results: [],
      });
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ANNOTATION_CLIENT_OP_REUSE",
      used: 0,
      capacityState: "AVAILABLE",
      canCreate: true,
      ready: true,
    });
    expect((await annotations.load(roomId, pageKey)).localDrafts).toMatchObject([
      {
        draft: { strokeId },
        status: "ERROR",
        errorCode: "ANNOTATION_CLIENT_OP_REUSE",
      },
    ]);
    await expect(
      controller.handleDraftControl(12, 0, {
        type: "syncaction.annotation.draft.control",
        controller: "drawing",
        context,
        action: "RETRY",
        strokeId,
      }),
    ).rejects.toThrow("ANNOTATION_DRAFT_NOT_RETRYABLE");
  });

  it("counts durable pending creates in offline capacity preflight", async () => {
    const existing = Array.from({ length: 1_999 }, (_, index) => ({
      ...draft,
      strokeId: `018f8f8e-4b5c-7d6e-8f90-${(index + 0x1_000).toString(16).padStart(12, "0")}`,
      authorUserId: userId,
      lockedAtServerMs: null,
      version: 1,
      createdAtServerMs: now,
      deletedAtServerMs: null,
    }));
    transport.synchronizeImplementation = async () =>
      snapshot({ sequence: 1_999, strokes: existing });
    await activate();
    await controller.setSynchronized(false);

    await controller.handleStrokeFinal(12, 0, finalMessage());
    expect(controller.getStatus()).toMatchObject({
      used: 2_000,
      capacityState: "FULL",
      canCreate: false,
      errorCode: "ANNOTATION_OFFLINE",
    });

    await controller.handleStrokeFinal(12, 0, {
      ...finalMessage(),
      stroke: { ...unsignedDraft, strokeId: otherStrokeId },
    });

    expect(transport.submissions).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      used: 2_001,
      capacityState: "FULL",
      canCreate: false,
      errorCode: "ANNOTATION_PAGE_CAPACITY_REACHED",
    });
    expect((await annotations.load(roomId, pageKey)).localDrafts.at(-1)).toMatchObject({
      draft: { strokeId: otherStrokeId },
      status: "ERROR",
      errorCode: "ANNOTATION_PAGE_CAPACITY_REACHED",
    });
  });

  it("resynchronizes a sequence conflict and retries the unchanged operation at the new base", async () => {
    let syncCalls = 0;
    transport.synchronizeImplementation = async () => {
      syncCalls += 1;
      return snapshot({ sequence: syncCalls === 1 ? 0 : 1 });
    };
    let submitCalls = 0;
    transport.submitImplementation = async (submission) => {
      submitCalls += 1;
      if (submitCalls === 1) {
        return AnnotationAckSchema.parse({
          type: "annotation.ack.v2",
          protocolVersion: 1,
          clientOpId: submission.clientOpId,
          roomId,
          accepted: false,
          code: "ANNOTATION_SEQUENCE_CONFLICT",
          pageKey,
          annotationSeq: null,
          results: [],
        });
      }
      const committed = committedFor(submission, 2);
      queueMicrotask(() => transport.annotationHandler?.(committed));
      return acceptedAckFor(committed);
    };
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(transport.submissions).toHaveLength(2);
    expect(
      transport.submissions.map((submission) => ({
        clientOpId: submission.clientOpId,
        baseAnnotationSeq: submission.baseAnnotationSeq,
        operation: submission.operation,
      })),
    ).toEqual([
      {
        clientOpId: strokeId,
        baseAnnotationSeq: 0,
        operation: { type: "stroke.create", stroke: draft },
      },
      {
        clientOpId: strokeId,
        baseAnnotationSeq: 1,
        operation: { type: "stroke.create", stroke: draft },
      },
    ]);
    expect(controller.getStatus()).toMatchObject({
      state: "ONLINE",
      errorCode: null,
    });
  });

  it("stops a sequence-conflict retry when authoritative resynchronization fails", async () => {
    let syncCalls = 0;
    transport.synchronizeImplementation = async () => {
      syncCalls += 1;
      if (syncCalls > 1) {
        throw new Error("malformed annotation sync");
      }
      return snapshot();
    };
    transport.submitImplementation = async (submission) =>
      AnnotationAckSchema.parse({
        type: "annotation.ack.v2",
        protocolVersion: 1,
        clientOpId: submission.clientOpId,
        roomId,
        accepted: false,
        code: "ANNOTATION_SEQUENCE_CONFLICT",
        pageKey,
        annotationSeq: null,
        results: [],
      });
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(syncCalls).toBe(2);
    expect(transport.submissions).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ANNOTATION_PROTOCOL_FAILURE",
    });
    expect((await annotations.load(roomId, pageKey)).outbox).toMatchObject([
      {
        clientOpId: strokeId,
        state: "FAILED",
        errorCode: "ANNOTATION_SEQUENCE_CONFLICT",
      },
    ]);
  });

  it("keeps an old-page draft isolated after an authoritative page mismatch", async () => {
    const authoritativePageKey = "D".repeat(43);
    let syncCalls = 0;
    transport.synchronizeImplementation = async () => {
      syncCalls += 1;
      return AnnotationSnapshotMessageSchema.parse({
        ...snapshot(),
        pageKey: syncCalls === 1 ? pageKey : authoritativePageKey,
      });
    };
    transport.submitImplementation = async (submission) => {
      return AnnotationAckSchema.parse({
        type: "annotation.ack.v2",
        protocolVersion: 1,
        clientOpId: submission.clientOpId,
        roomId,
        accepted: false,
        code: "PAGE_MISMATCH",
        pageKey: authoritativePageKey,
        annotationSeq: null,
        results: [],
      });
    };
    await activate();

    await controller.handleStrokeFinal(12, 0, finalMessage());
    await controller.whenIdle();

    expect(transport.submissions.map((submission) => submission.pageKey)).toEqual([pageKey]);
    expect(transport.submissions.map((submission) => submission.clientOpId)).toEqual([strokeId]);
    expect((await annotations.load(roomId, pageKey)).outbox).toMatchObject([
      {
        clientOpId: strokeId,
        state: "QUEUED",
      },
    ]);
    expect((await annotations.load(roomId, pageKey)).localDrafts).toMatchObject([
      {
        clientOpId: strokeId,
        status: "PENDING",
      },
    ]);
    expect((await annotations.load(roomId, authoritativePageKey)).localDrafts).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      state: "ONLINE",
      errorCode: null,
      pageKey: authoritativePageKey,
    });
  });

  it("filters lock/delete selection by author, lock state, and owner override before server authority", async () => {
    const unlockedOther = {
      ...draft,
      strokeId: otherStrokeId,
      authorUserId: otherUserId,
      lockedAtServerMs: null,
      version: 1,
      createdAtServerMs: now,
      deletedAtServerMs: null,
    };
    const lockedOther = {
      ...unlockedOther,
      strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789f11",
      lockedAtServerMs: now + 1,
    };
    transport.synchronizeImplementation = async () =>
      snapshot({ sequence: 2, strokes: [unlockedOther, lockedOther] });
    await activate();

    const selection: DrawingSelectionMessage = {
      type: "syncaction.drawing.selection",
      controller: "drawing",
      context,
      action: "DELETE",
      items: [
        { strokeId: unlockedOther.strokeId, expectedVersion: 1 },
        { strokeId: lockedOther.strokeId, expectedVersion: 1 },
      ],
    };
    await controller.handleSelection(12, 0, selection);
    await controller.whenIdle();
    expect(transport.submissions.at(-1)?.operation).toEqual({
      type: "stroke.delete",
      items: [{ strokeId: unlockedOther.strokeId, expectedVersion: 1 }],
    });

    await controller.dispose();
    transport = new FakeTransport();
    transport.synchronizeImplementation = async () =>
      snapshot({ sequence: 2, strokes: [unlockedOther, lockedOther] });
    page = new FakePage();
    controller = createController("OWNER");
    await activate();
    await controller.handleSelection(12, 0, selection);
    await controller.whenIdle();
    expect(transport.submissions.at(-1)?.operation).toEqual({
      type: "stroke.delete",
      items: selection.items,
    });
  });

  it("surfaces locally stale selection versions instead of silently dropping the action", async () => {
    transport.synchronizeImplementation = async () =>
      snapshot({
        sequence: 1,
        strokes: [
          {
            ...draft,
            authorUserId: userId,
            lockedAtServerMs: null,
            version: 2,
            createdAtServerMs: now,
            deletedAtServerMs: null,
          },
        ],
      });
    await activate();

    await controller.handleSelection(12, 0, {
      type: "syncaction.drawing.selection",
      controller: "drawing",
      context,
      action: "LOCK",
      items: [{ strokeId, expectedVersion: 1 }],
    });

    expect(transport.submissions).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "STROKE_VERSION_CONFLICT",
    });
  });

  it("surfaces an accepted batch acknowledgement that contains an item rejection", async () => {
    transport.synchronizeImplementation = async () =>
      snapshot({
        sequence: 1,
        strokes: [
          {
            ...draft,
            authorUserId: userId,
            lockedAtServerMs: null,
            version: 1,
            createdAtServerMs: now,
            deletedAtServerMs: null,
          },
        ],
      });
    transport.submitImplementation = async (submission) => {
      const acknowledgement = AnnotationAckSchema.parse({
        type: "annotation.ack.v2",
        protocolVersion: 1,
        clientOpId: submission.clientOpId,
        roomId,
        accepted: true,
        code: null,
        pageKey,
        annotationSeq: 2,
        results: [
          {
            strokeId,
            accepted: false,
            code: "NOT_STROKE_AUTHOR",
            version: 1,
          },
        ],
      });
      queueMicrotask(() =>
        transport.annotationHandler?.(
          AnnotationCommittedOperationSchema.parse({
            type: "annotation.committed.v2",
            protocolVersion: 1,
            clientOpId: submission.clientOpId,
            roomId,
            pageKey,
            annotationSeq: 2,
            actorUserId: userId,
            operation: submission.operation,
            results: acknowledgement.results,
            createdAtServerMs: now,
          }),
        ),
      );
      return acknowledgement;
    };
    await activate();

    await controller.handleSelection(12, 0, {
      type: "syncaction.drawing.selection",
      controller: "drawing",
      context,
      action: "LOCK",
      items: [{ strokeId, expectedVersion: 1 }],
    });
    await controller.whenIdle();

    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "NOT_STROKE_AUTHOR",
    });
  });

  it("clears drawing state on permission revoke without writing to the durable tab actuator", async () => {
    const durableRead = vi.fn(async () => currentRecord);
    controller = new DrawingController({
      roomId,
      userId,
      roomRole: "MEMBER",
      browserSessionId,
      replica: { getRecord: durableRead },
      annotations,
      contentSignatures: {
        getLocalContentSignature: () =>
          currentContentSignature === null ? null : structuredClone(currentContentSignature),
      },
      transport,
      page,
      createId: () => mutationOpId,
    });
    await activate();

    await controller.handlePermissionBoundaryChanged();
    await controller.whenIdle();

    expect(page.disposed).toEqual([{ tabId: 12, context }]);
    expect(durableRead).toHaveBeenCalled();
    expect(Object.keys(controller as unknown as object)).not.toContain("actuator");
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "PAGE_TOOL_PERMISSION_REQUIRED",
      canCreate: false,
    });
  });
});
