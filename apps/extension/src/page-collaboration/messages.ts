import {
  AnnotationAckV2Schema,
  AnnotationCommittedOperationV2Schema,
  AnnotationDeltaV2MessageSchema,
  AnnotationMutationTargetSchema,
  AnnotationRgbSchema,
  AnnotationSnapshotV2MessageSchema,
  AnnotationStrokeDraftSchema,
  AnnotationStrokeDraftV2Schema,
  CanonicalUuidSchema,
  ContentSignatureSchema,
  DanmakuErrorCodeSchema,
  DanmakuEventMessageSchema,
  DanmakuTextSchema,
  DeviceIdSchema,
  DocumentRevisionSchema,
  ExactDocumentIdentitySchema,
  LogicalTabIdSchema,
  MediaObservedStateSchema,
  MediaTargetSchema,
  PageCompatibilityReportSchema,
  PointerFrameEventSchema,
  PointerLeaseRecordSchema,
  PointerPathSegmentSchema,
  PointerRecordSchema,
  RoomIdSchema,
  StrokePreviewClearMessageSchema,
  StrokePreviewEventMessageSchema,
  StrokePreviewUpdateSchema,
} from "@syncaction/protocol";
import { z } from "zod";
import {
  MEDIA_APPLY_RESULT_CODES,
  MEDIA_DISCOVERY_RESULT_CODES,
  MEDIA_PAGE_RESULT_CODES,
} from "../media-adapters/types.js";
import { PointerLocalSampleSchema, PointerPageContextSchema } from "../pointer-controller.js";
import { PageCapabilityMessageSchema } from "./capability.js";

export {
  PageCapabilityMessageSchema,
  PageCapabilityNameSchema,
  PageCapabilityReportSchema,
} from "./capability.js";
export type { PageCapabilityMessage, PageCapabilityReport } from "./capability.js";

export const PAGE_COLLABORATION_MESSAGE_TYPES = [
  "syncaction.page.announce",
  "syncaction.page.ready",
  "syncaction.page.capability",
  "page.compatibility.report",
  "syncaction.command.ready",
  "syncaction.pointer.context",
  "syncaction.pointer.lease",
  "syncaction.pointer.frame",
  "syncaction.pointer.render",
  "syncaction.pointer.clear",
  "syncaction.pointer.sample",
  "syncaction.media.command",
  "syncaction.media.observed",
  "syncaction.media.prompt",
  "syncaction.danmaku.command",
  "syncaction.danmaku.render",
  "syncaction.danmaku.status",
  "syncaction.danmaku.clear",
  "syncaction.danmaku.submit",
  "syncaction.danmaku.report",
  "syncaction.drawing.command",
  "syncaction.drawing.state",
  "syncaction.drawing.viewer",
  "syncaction.drawing.clear",
  "syncaction.drawing.report",
  "syncaction.annotation.snapshot",
  "syncaction.annotation.delta",
  "syncaction.annotation.committed",
  "syncaction.annotation.ack",
  "syncaction.annotation.draft",
  "syncaction.annotation.draft.control",
  "syncaction.annotation.anchor-signature.request",
  "syncaction.annotation.anchor-signature.response",
  "syncaction.stroke.preview.render",
  "syncaction.stroke.preview.clear",
  "syncaction.stroke.sample",
  "syncaction.stroke.final",
  "syncaction.drawing.selection",
  "syncaction.page.dispose",
] as const;

export const PageAnnounceMessageSchema = z
  .object({
    type: z.literal("syncaction.page.announce"),
  })
  .strict();

export const PageReadyMessageSchema = z
  .object({
    type: z.literal("syncaction.page.ready"),
  })
  .strict();

export const PointerPageIdentitySchema = z
  .object({
    userId: CanonicalUuidSchema,
    deviceId: DeviceIdSchema,
  })
  .strict();

export const PointerContextMessageSchema = z
  .object({
    type: z.literal("syncaction.pointer.context"),
    context: PointerPageContextSchema,
  })
  .strict();

export const PointerRenderMessageSchema = z
  .object({
    type: z.literal("syncaction.pointer.render"),
    pointer: PointerRecordSchema,
  })
  .strict();

export const PointerLeaseRenderMessageSchema = z
  .object({
    type: z.literal("syncaction.pointer.lease"),
    lease: PointerLeaseRecordSchema,
  })
  .strict();

export const PointerFrameRenderMessageSchema = z
  .object({
    type: z.literal("syncaction.pointer.frame"),
    frame: PointerFrameEventSchema,
  })
  .strict();

export const PointerClearMessageSchema = z
  .object({
    type: z.literal("syncaction.pointer.clear"),
    identity: PointerPageIdentitySchema.nullable(),
  })
  .strict();

export const PointerSampleMessageSchema = z
  .object({
    type: z.literal("syncaction.pointer.sample"),
    sample: PointerLocalSampleSchema,
  })
  .strict();

export const MediaPageContextSchema = z
  .object({
    roomId: RoomIdSchema,
    logicalTabId: LogicalTabIdSchema,
    documentRevision: DocumentRevisionSchema,
    frameKey: z
      .string()
      .max(103)
      .regex(/^(?:top|frame:[A-Za-z0-9._~-]{1,96})$/u),
  })
  .strict();

export const MediaPageApplyActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PLAY") }).strict(),
  z.object({ type: z.literal("PAUSE") }).strict(),
  z
    .object({
      type: z.literal("SEEK"),
      positionMs: z.number().finite().nonnegative().max(604_800_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("SET_RATE"),
      playbackRate: z.number().finite().min(0.25).max(4),
    })
    .strict(),
  z
    .object({
      type: z.literal("SET_RATE_TEMPORARY"),
      playbackRate: z.number().finite().min(0.25).max(4),
      restoreRate: z.number().finite().min(0.25).max(4),
      durationMs: z.number().int().positive().max(10_000),
    })
    .strict(),
]);

export const MediaPageOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("OBSERVE"),
      target: MediaTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("SET_FOLLOWER_LOCK"),
      locked: z.boolean(),
      target: MediaTargetSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("APPLY"),
      applyToken: CanonicalUuidSchema,
      target: MediaTargetSchema,
      action: MediaPageApplyActionSchema,
    })
    .strict(),
]);

export const MediaCommandMessageSchema = z
  .object({
    type: z.literal("syncaction.media.command"),
    context: MediaPageContextSchema,
    operation: MediaPageOperationSchema,
  })
  .strict()
  .superRefine((message, validation) => {
    if (message.operation.type === "OBSERVE") {
      if (message.operation.target !== undefined) {
        validateTargetContext(message.context, message.operation.target, validation, [
          "operation",
          "target",
        ]);
      }
    } else {
      validateTargetContext(message.context, message.operation.target, validation, [
        "operation",
        "target",
      ]);
    }
    if (
      message.operation.type === "APPLY" &&
      message.operation.action.type === "SEEK" &&
      message.operation.action.positionMs > message.operation.target.durationMs
    ) {
      validation.addIssue({
        code: "custom",
        message: "seek position exceeds target duration",
        path: ["operation", "action", "positionMs"],
      });
    }
  });

export const MediaObservedEventSchema = z.enum([
  "DISCOVERED",
  "TARGET_CHANGED",
  "STATE_CHANGED",
  "APPLY_RESULT",
  "UNSUPPORTED",
]);
export const MediaObservedTriggerSchema = z.enum([
  "PLAYED",
  "PAUSED",
  "SEEKED",
  "RATE_CHANGED",
  "ENDED",
  "BUFFERING",
  "READY",
]);

export const MediaPageResultCodeSchema = z.enum(MEDIA_PAGE_RESULT_CODES);
export const MediaDiscoveryResultCodeSchema = z.enum(MEDIA_DISCOVERY_RESULT_CODES);
export const MediaApplyPageResultCodeSchema = z.enum([
  ...MEDIA_APPLY_RESULT_CODES,
  "TARGET_MISMATCH",
]);

const MediaObservedTargetStateShape = {
  context: MediaPageContextSchema,
  target: MediaTargetSchema,
  observed: MediaObservedStateSchema,
};

const MediaDiscoveredMessageSchema = z
  .object({
    type: z.literal("syncaction.media.observed"),
    event: z.literal("DISCOVERED"),
    ...MediaObservedTargetStateShape,
    applyToken: z.null(),
    resultCode: z.null(),
  })
  .strict();

const MediaTargetChangedMessageSchema = z
  .object({
    type: z.literal("syncaction.media.observed"),
    event: z.literal("TARGET_CHANGED"),
    ...MediaObservedTargetStateShape,
    applyToken: z.null(),
    resultCode: z.null(),
  })
  .strict();

const MediaStateChangedMessageSchema = z
  .object({
    type: z.literal("syncaction.media.observed"),
    event: z.literal("STATE_CHANGED"),
    ...MediaObservedTargetStateShape,
    applyToken: CanonicalUuidSchema.nullable(),
    trigger: MediaObservedTriggerSchema.nullable().optional(),
    resultCode: z.null(),
  })
  .strict();

const MediaVisibilityChangedMessageSchema = z
  .object({
    type: z.literal("syncaction.media.observed"),
    event: z.literal("VISIBILITY_CHANGED"),
    ...MediaObservedTargetStateShape,
    visibilityState: z.enum(["visible", "hidden"]),
    applyToken: z.null(),
    resultCode: z.null(),
  })
  .strict();

const MediaUnsupportedMessageSchema = z
  .object({
    type: z.literal("syncaction.media.observed"),
    event: z.literal("UNSUPPORTED"),
    context: MediaPageContextSchema,
    target: z.null(),
    observed: z.null(),
    applyToken: z.null(),
    resultCode: MediaDiscoveryResultCodeSchema,
  })
  .strict();

const MediaApplyResultMessageSchema = z
  .object({
    type: z.literal("syncaction.media.observed"),
    event: z.literal("APPLY_RESULT"),
    context: MediaPageContextSchema,
    target: MediaTargetSchema.nullable(),
    observed: MediaObservedStateSchema.nullable(),
    applyToken: CanonicalUuidSchema,
    resultCode: z.union([z.null(), MediaApplyPageResultCodeSchema]),
  })
  .strict()
  .superRefine((message, validation) => {
    if ((message.target === null) !== (message.observed === null)) {
      validation.addIssue({
        code: "custom",
        message: "target and observed state must both be present or absent",
        path: ["observed"],
      });
      return;
    }
    if (message.resultCode === null && message.target === null) {
      validation.addIssue({
        code: "custom",
        message: "successful apply result requires target and observed state",
        path: ["target"],
      });
      return;
    }
    if (message.target === null && message.resultCode !== "TARGET_MISMATCH") {
      validation.addIssue({
        code: "custom",
        message: "apply failure without an observation must be a target mismatch",
        path: ["resultCode"],
      });
    }
  });

export const MediaObservedMessageSchema = z
  .discriminatedUnion("event", [
    MediaDiscoveredMessageSchema,
    MediaTargetChangedMessageSchema,
    MediaStateChangedMessageSchema,
    MediaVisibilityChangedMessageSchema,
    MediaUnsupportedMessageSchema,
    MediaApplyResultMessageSchema,
  ])
  .superRefine((message, validation) => {
    if (message.target === null || message.observed === null) {
      return;
    }
    validateTargetContext(message.context, message.target, validation, ["target"]);
    if (message.observed.positionMs > message.target.durationMs) {
      validation.addIssue({
        code: "custom",
        message: "observed position exceeds target duration",
        path: ["observed", "positionMs"],
      });
    }
  });

function validateTargetContext(
  context: z.infer<typeof MediaPageContextSchema>,
  target: z.infer<typeof MediaTargetSchema>,
  validation: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (target.logicalTabId !== context.logicalTabId) {
    validation.addIssue({
      code: "custom",
      message: "target logical tab does not match context",
      path: [...path, "logicalTabId"],
    });
  }
  if (
    target.documentRevision.roomEpoch !== context.documentRevision.roomEpoch ||
    target.documentRevision.tabUpdatedAtSeq !== context.documentRevision.tabUpdatedAtSeq
  ) {
    validation.addIssue({
      code: "custom",
      message: "target document revision does not match context",
      path: [...path, "documentRevision"],
    });
  }
  if (target.frameKey !== context.frameKey) {
    validation.addIssue({
      code: "custom",
      message: "target frame does not match context",
      path: [...path, "frameKey"],
    });
  }
}

function validateEmbeddedDocument(
  context: z.infer<typeof ExactDocumentIdentitySchema>,
  embedded: z.infer<typeof ExactDocumentIdentitySchema>,
  validation: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (
    embedded.roomId !== context.roomId ||
    embedded.logicalTabId !== context.logicalTabId ||
    embedded.documentRevision.roomEpoch !== context.documentRevision.roomEpoch ||
    embedded.documentRevision.tabUpdatedAtSeq !== context.documentRevision.tabUpdatedAtSeq ||
    embedded.frameKey !== context.frameKey
  ) {
    validation.addIssue({
      code: "custom",
      message: "embedded document identity does not match page context",
      path,
    });
  }
}

export const CollaborationPageContextSchema = ExactDocumentIdentitySchema;

const DanmakuControllerFields = {
  controller: z.literal("danmaku"),
  context: CollaborationPageContextSchema,
};
const DrawingControllerFields = {
  controller: z.literal("drawing"),
  context: CollaborationPageContextSchema,
};

export const PageCommandReadyMessageSchema = z
  .object({
    type: z.literal("syncaction.command.ready"),
    controller: z.enum(["danmaku", "drawing"]),
    context: CollaborationPageContextSchema,
    command: z.enum(["toggle-danmaku-input", "toggle-page-pen"]),
  })
  .strict()
  .superRefine((message, validation) => {
    if (
      (message.controller === "danmaku" && message.command !== "toggle-danmaku-input") ||
      (message.controller === "drawing" && message.command !== "toggle-page-pen")
    ) {
      validation.addIssue({
        code: "custom",
        message: "page command does not match controller",
        path: ["command"],
      });
    }
  });

export const MediaPromptMessageSchema = z
  .object({
    type: z.literal("syncaction.media.prompt"),
    controller: z.literal("media"),
    context: CollaborationPageContextSchema,
    prompt: z.enum(["ALIGN_AVAILABLE", "JOIN_AVAILABLE", "PROPOSAL_REQUIRED"]),
    playbackGroupId: CanonicalUuidSchema.nullable(),
  })
  .strict();

export const DanmakuCommandMessageSchema = z
  .object({
    type: z.literal("syncaction.danmaku.command"),
    ...DanmakuControllerFields,
    action: z.enum(["TOGGLE_INPUT", "OPEN_INPUT", "CLOSE_INPUT", "SHOW", "HIDE"]),
  })
  .strict();

export const DanmakuRenderMessageSchema = z
  .object({
    type: z.literal("syncaction.danmaku.render"),
    ...DanmakuControllerFields,
    event: DanmakuEventMessageSchema,
  })
  .strict()
  .superRefine((message, validation) => {
    validateEmbeddedDocument(message.context, message.event, validation, ["event"]);
  });

const DanmakuStatusBase = {
  type: z.literal("syncaction.danmaku.status"),
  ...DanmakuControllerFields,
};

export const DanmakuStatusMessageSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...DanmakuStatusBase,
      status: z.literal("IDLE"),
      messageId: z.null(),
      errorCode: z.null(),
    })
    .strict(),
  z
    .object({
      ...DanmakuStatusBase,
      status: z.enum(["SENDING", "SENT"]),
      messageId: CanonicalUuidSchema,
      errorCode: z.null(),
    })
    .strict(),
  z
    .object({
      ...DanmakuStatusBase,
      status: z.literal("FAILED"),
      messageId: CanonicalUuidSchema,
      errorCode: DanmakuErrorCodeSchema,
    })
    .strict(),
]);

export const DanmakuSubmitMessageSchema = z
  .object({
    type: z.literal("syncaction.danmaku.submit"),
    ...DanmakuControllerFields,
    messageId: CanonicalUuidSchema,
    text: DanmakuTextSchema,
  })
  .strict();

export const DanmakuClearMessageSchema = z
  .object({
    type: z.literal("syncaction.danmaku.clear"),
    ...DanmakuControllerFields,
  })
  .strict();

export const DanmakuReportMessageSchema = z
  .object({
    type: z.literal("syncaction.danmaku.report"),
    ...DanmakuControllerFields,
    hidden: z.boolean(),
    inputOpen: z.boolean(),
  })
  .strict();

export const DrawingCommandActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TOGGLE_PEN") }).strict(),
  z.object({ type: z.literal("EXIT") }).strict(),
  z
    .object({
      type: z.literal("SET_TOOL"),
      tool: z.enum(["PEN", "ERASER", "SELECT"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("SET_STYLE"),
      rgb: AnnotationRgbSchema,
      width: z.number().finite().min(1).max(32),
    })
    .strict(),
]);

export const DrawingCommandMessageSchema = z
  .object({
    type: z.literal("syncaction.drawing.command"),
    ...DrawingControllerFields,
    action: DrawingCommandActionSchema,
  })
  .strict();

export const DrawingStateMessageSchema = z
  .object({
    type: z.literal("syncaction.drawing.state"),
    ...DrawingControllerFields,
    active: z.boolean(),
    tool: z.enum(["PEN", "ERASER", "SELECT"]),
    rgb: AnnotationRgbSchema,
    width: z.number().finite().min(1).max(32),
  })
  .strict();

export const DrawingViewerMessageSchema = z
  .object({
    type: z.literal("syncaction.drawing.viewer"),
    ...DrawingControllerFields,
    viewer: z
      .object({
        userId: CanonicalUuidSchema,
        role: z.enum(["OWNER", "MEMBER"]),
      })
      .strict(),
  })
  .strict();

export const DrawingClearMessageSchema = z
  .object({
    type: z.literal("syncaction.drawing.clear"),
    ...DrawingControllerFields,
  })
  .strict();

export const DrawingReportMessageSchema = z
  .object({
    type: z.literal("syncaction.drawing.report"),
    ...DrawingControllerFields,
    active: z.boolean(),
    tool: z.enum(["PEN", "ERASER", "SELECT"]),
    rgb: AnnotationRgbSchema,
    width: z.number().finite().min(1).max(32),
    selectedCount: z.number().int().nonnegative().safe().max(2_000),
    selectedLockedCount: z.number().int().nonnegative().safe().max(2_000),
    unlocatableCount: z.number().int().nonnegative().safe().max(2_000),
  })
  .strict()
  .superRefine((report, validation) => {
    if (report.selectedLockedCount > report.selectedCount) {
      validation.addIssue({
        code: "custom",
        path: ["selectedLockedCount"],
        message: "locked selection count cannot exceed the total selection count",
      });
    }
  });

export const AnnotationSnapshotPageMessageSchema = z
  .object({
    type: z.literal("syncaction.annotation.snapshot"),
    ...DrawingControllerFields,
    snapshot: AnnotationSnapshotV2MessageSchema,
  })
  .strict()
  .superRefine((message, validation) => {
    validateEmbeddedDocument(message.context, message.snapshot, validation, ["snapshot"]);
  });

export const AnnotationDeltaPageMessageSchema = z
  .object({
    type: z.literal("syncaction.annotation.delta"),
    ...DrawingControllerFields,
    delta: AnnotationDeltaV2MessageSchema,
  })
  .strict()
  .superRefine((message, validation) => {
    validateEmbeddedDocument(message.context, message.delta, validation, ["delta"]);
  });

export const AnnotationCommittedPageMessageSchema = z
  .object({
    type: z.literal("syncaction.annotation.committed"),
    ...DrawingControllerFields,
    committed: AnnotationCommittedOperationV2Schema,
  })
  .strict()
  .superRefine((message, validation) => {
    if (message.committed.roomId !== message.context.roomId) {
      validation.addIssue({
        code: "custom",
        message: "committed annotation room does not match context",
        path: ["committed", "roomId"],
      });
    }
  });

export const AnnotationAckPageMessageSchema = z
  .object({
    type: z.literal("syncaction.annotation.ack"),
    ...DrawingControllerFields,
    acknowledgement: AnnotationAckV2Schema,
  })
  .strict()
  .superRefine((message, validation) => {
    if (message.acknowledgement.roomId !== message.context.roomId) {
      validation.addIssue({
        code: "custom",
        message: "annotation acknowledgement room does not match context",
        path: ["acknowledgement", "roomId"],
      });
    }
  });

export const AnnotationDraftPageMessageSchema = z
  .object({
    type: z.literal("syncaction.annotation.draft"),
    ...DrawingControllerFields,
    draft: AnnotationStrokeDraftV2Schema,
    status: z.enum(["PENDING", "ERROR"]),
    retryable: z.boolean(),
  })
  .strict()
  .superRefine((message, validation) => {
    if (message.draft.frameKey !== message.context.frameKey) {
      validation.addIssue({
        code: "custom",
        message: "annotation draft frame does not match context",
        path: ["draft", "frameKey"],
      });
    }
    if (message.status === "PENDING" && message.retryable) {
      validation.addIssue({
        code: "custom",
        message: "pending annotation draft cannot be retryable",
        path: ["retryable"],
      });
    }
  });

export const ElementAnchorSignatureRequestSchema = z
  .object({
    type: z.literal("syncaction.annotation.anchor-signature.request"),
    ...DrawingControllerFields,
    path: z.array(PointerPathSegmentSchema).min(1).max(12),
  })
  .strict();

export const ElementAnchorSignatureResponseSchema = z
  .object({
    type: z.literal("syncaction.annotation.anchor-signature.response"),
    signature: ContentSignatureSchema.nullable(),
  })
  .strict();

export const StrokePreviewRenderPageMessageSchema = z
  .object({
    type: z.literal("syncaction.stroke.preview.render"),
    ...DrawingControllerFields,
    preview: StrokePreviewEventMessageSchema,
  })
  .strict()
  .superRefine((message, validation) => {
    validateEmbeddedDocument(message.context, message.preview, validation, ["preview"]);
  });

export const StrokePreviewClearPageMessageSchema = z
  .object({
    type: z.literal("syncaction.stroke.preview.clear"),
    ...DrawingControllerFields,
    clear: StrokePreviewClearMessageSchema,
  })
  .strict()
  .superRefine((message, validation) => {
    validateEmbeddedDocument(message.context, message.clear, validation, ["clear"]);
  });

export const StrokeSampleMessageSchema = z
  .object({
    type: z.literal("syncaction.stroke.sample"),
    ...DrawingControllerFields,
    preview: StrokePreviewUpdateSchema,
  })
  .strict()
  .superRefine((message, validation) => {
    validateEmbeddedDocument(message.context, message.preview, validation, ["preview"]);
  });

export const StrokeFinalMessageSchema = z
  .object({
    type: z.literal("syncaction.stroke.final"),
    ...DrawingControllerFields,
    stroke: AnnotationStrokeDraftSchema,
  })
  .strict()
  .superRefine((message, validation) => {
    if (message.stroke.frameKey !== message.context.frameKey) {
      validation.addIssue({
        code: "custom",
        message: "final stroke frame does not match context",
        path: ["stroke", "frameKey"],
      });
    }
  });

export const DrawingSelectionMessageSchema = z
  .object({
    type: z.literal("syncaction.drawing.selection"),
    ...DrawingControllerFields,
    action: z.enum(["DELETE", "LOCK", "UNLOCK"]),
    items: z.array(AnnotationMutationTargetSchema).min(1).max(256),
  })
  .strict()
  .superRefine((message, validation) => {
    const strokeIds = new Set<string>();
    for (const [index, item] of message.items.entries()) {
      if (strokeIds.has(item.strokeId)) {
        validation.addIssue({
          code: "custom",
          message: "selection contains a duplicate stroke",
          path: ["items", index, "strokeId"],
        });
      }
      strokeIds.add(item.strokeId);
    }
  });

export const DrawingDraftControlMessageSchema = z
  .object({
    type: z.literal("syncaction.annotation.draft.control"),
    ...DrawingControllerFields,
    action: z.enum(["DISCARD", "RETRY"]),
    strokeId: CanonicalUuidSchema,
  })
  .strict();

export const PageDisposeMessageSchema = z
  .object({
    type: z.literal("syncaction.page.dispose"),
    reason: z.enum(["ORIGIN_REVOKED", "ROOM_SWITCHED", "REVISION_CHANGED", "BACKGROUND_STOPPED"]),
  })
  .strict();

export const PageCollaborationInboundMessageSchema = z.discriminatedUnion("type", [
  PageAnnounceMessageSchema,
  PointerContextMessageSchema,
  PointerLeaseRenderMessageSchema,
  PointerFrameRenderMessageSchema,
  PointerRenderMessageSchema,
  PointerClearMessageSchema,
  MediaCommandMessageSchema,
  MediaPromptMessageSchema,
  DanmakuCommandMessageSchema,
  DanmakuRenderMessageSchema,
  DanmakuStatusMessageSchema,
  DanmakuClearMessageSchema,
  DrawingCommandMessageSchema,
  DrawingStateMessageSchema,
  DrawingViewerMessageSchema,
  DrawingClearMessageSchema,
  AnnotationSnapshotPageMessageSchema,
  AnnotationDeltaPageMessageSchema,
  AnnotationCommittedPageMessageSchema,
  AnnotationAckPageMessageSchema,
  AnnotationDraftPageMessageSchema,
  ElementAnchorSignatureRequestSchema,
  StrokePreviewRenderPageMessageSchema,
  StrokePreviewClearPageMessageSchema,
  PageDisposeMessageSchema,
]);

export const PageCollaborationOutboundMessageSchema = z.discriminatedUnion("type", [
  PageReadyMessageSchema,
  PageCapabilityMessageSchema,
  PageCompatibilityReportSchema,
  PageCommandReadyMessageSchema,
  PointerSampleMessageSchema,
  MediaObservedMessageSchema,
  DanmakuSubmitMessageSchema,
  DanmakuReportMessageSchema,
  DrawingReportMessageSchema,
  StrokeSampleMessageSchema,
  StrokeFinalMessageSchema,
  DrawingSelectionMessageSchema,
  DrawingDraftControlMessageSchema,
]);

export const PageCollaborationMessageSchema = z.discriminatedUnion("type", [
  PageAnnounceMessageSchema,
  PageReadyMessageSchema,
  PageCapabilityMessageSchema,
  PageCompatibilityReportSchema,
  PageCommandReadyMessageSchema,
  PointerContextMessageSchema,
  PointerLeaseRenderMessageSchema,
  PointerFrameRenderMessageSchema,
  PointerRenderMessageSchema,
  PointerClearMessageSchema,
  PointerSampleMessageSchema,
  MediaCommandMessageSchema,
  MediaObservedMessageSchema,
  MediaPromptMessageSchema,
  DanmakuCommandMessageSchema,
  DanmakuRenderMessageSchema,
  DanmakuStatusMessageSchema,
  DanmakuClearMessageSchema,
  DanmakuSubmitMessageSchema,
  DanmakuReportMessageSchema,
  DrawingCommandMessageSchema,
  DrawingStateMessageSchema,
  DrawingViewerMessageSchema,
  DrawingClearMessageSchema,
  DrawingReportMessageSchema,
  AnnotationSnapshotPageMessageSchema,
  AnnotationDeltaPageMessageSchema,
  AnnotationCommittedPageMessageSchema,
  AnnotationAckPageMessageSchema,
  AnnotationDraftPageMessageSchema,
  ElementAnchorSignatureRequestSchema,
  ElementAnchorSignatureResponseSchema,
  StrokePreviewRenderPageMessageSchema,
  StrokePreviewClearPageMessageSchema,
  StrokeSampleMessageSchema,
  StrokeFinalMessageSchema,
  DrawingSelectionMessageSchema,
  DrawingDraftControlMessageSchema,
  PageDisposeMessageSchema,
]);

export type PageCollaborationInboundMessage = z.infer<typeof PageCollaborationInboundMessageSchema>;
export type PageCollaborationOutboundMessage = z.infer<
  typeof PageCollaborationOutboundMessageSchema
>;
export type PageCollaborationMessage = z.infer<typeof PageCollaborationMessageSchema>;
export type PageAnnounceMessage = z.infer<typeof PageAnnounceMessageSchema>;
export type MediaPageContext = z.infer<typeof MediaPageContextSchema>;
export type MediaPageApplyAction = z.infer<typeof MediaPageApplyActionSchema>;
export type MediaCommandMessage = z.infer<typeof MediaCommandMessageSchema>;
export type MediaObservedMessage = z.infer<typeof MediaObservedMessageSchema>;
export type MediaObservedTrigger = z.infer<typeof MediaObservedTriggerSchema>;
export type CollaborationPageContext = z.infer<typeof CollaborationPageContextSchema>;
export type PageCommandReadyMessage = z.infer<typeof PageCommandReadyMessageSchema>;
export type DanmakuSubmitMessage = z.infer<typeof DanmakuSubmitMessageSchema>;
export type DanmakuReportMessage = z.infer<typeof DanmakuReportMessageSchema>;
export type DrawingReportMessage = z.infer<typeof DrawingReportMessageSchema>;
export type StrokeSampleMessage = z.infer<typeof StrokeSampleMessageSchema>;
export type StrokeFinalMessage = z.infer<typeof StrokeFinalMessageSchema>;
export type DrawingSelectionMessage = z.infer<typeof DrawingSelectionMessageSchema>;
export type DrawingDraftControlMessage = z.infer<typeof DrawingDraftControlMessageSchema>;
export type ElementAnchorSignatureRequest = z.infer<typeof ElementAnchorSignatureRequestSchema>;
export type ElementAnchorSignatureResponse = z.infer<typeof ElementAnchorSignatureResponseSchema>;
export type PageDisposeReason = z.infer<typeof PageDisposeMessageSchema>["reason"];
export type PageControllerNamespace = "pointer" | "media" | "danmaku" | "drawing";

export interface PageMessageSender {
  tab?:
    | {
        id?: number | undefined;
      }
    | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
  documentId?: string | undefined;
  documentLifecycle?: string | undefined;
}

export interface ParsedPageOutboundMessage {
  tabId: number;
  frameId: number;
  documentUrl: string | null;
  documentId: string | null;
  documentLifecycle: string | null;
  message: PageCollaborationOutboundMessage;
}

const outboundTypes = new Set<string>([
  "syncaction.page.ready",
  "syncaction.page.capability",
  "page.compatibility.report",
  "syncaction.command.ready",
  "syncaction.pointer.sample",
  "syncaction.media.observed",
  "syncaction.danmaku.submit",
  "syncaction.danmaku.report",
  "syncaction.drawing.report",
  "syncaction.stroke.sample",
  "syncaction.stroke.final",
  "syncaction.drawing.selection",
  "syncaction.annotation.draft.control",
]);

export function parsePageOutboundMessageFromSender(
  messageInput: unknown,
  senderInput: PageMessageSender,
): ParsedPageOutboundMessage | null {
  const type = readMessageType(messageInput);
  if (type === null || !outboundTypes.has(type)) {
    return null;
  }
  const tabId = senderInput.tab?.id;
  const frameId = senderInput.frameId ?? 0;
  if (
    typeof tabId !== "number" ||
    !Number.isSafeInteger(tabId) ||
    tabId < 0 ||
    !Number.isSafeInteger(frameId) ||
    frameId < 0 ||
    (senderInput.url !== undefined &&
      (typeof senderInput.url !== "string" || senderInput.url.length > 8_192)) ||
    (senderInput.documentId !== undefined &&
      (typeof senderInput.documentId !== "string" ||
        senderInput.documentId.length < 1 ||
        senderInput.documentId.length > 256)) ||
    (senderInput.documentLifecycle !== undefined && senderInput.documentLifecycle !== "active")
  ) {
    throw new Error("INVALID_PAGE_MESSAGE_SENDER");
  }
  const message = PageCollaborationOutboundMessageSchema.parse(messageInput);
  return {
    tabId,
    frameId,
    documentUrl: senderInput.url ?? null,
    documentId: senderInput.documentId ?? null,
    documentLifecycle: senderInput.documentLifecycle ?? null,
    message,
  };
}

const controllerOutboundTypes: Record<PageControllerNamespace, ReadonlySet<string>> = {
  pointer: new Set(["syncaction.pointer.sample"]),
  media: new Set(["syncaction.media.observed"]),
  danmaku: new Set([
    "syncaction.command.ready",
    "syncaction.danmaku.submit",
    "syncaction.danmaku.report",
  ]),
  drawing: new Set([
    "syncaction.command.ready",
    "syncaction.drawing.report",
    "syncaction.stroke.sample",
    "syncaction.stroke.final",
    "syncaction.drawing.selection",
    "syncaction.annotation.draft.control",
  ]),
};

export function isPageControllerMessage(
  messageInput: unknown,
  namespace: PageControllerNamespace,
): boolean {
  const parsed = PageCollaborationOutboundMessageSchema.safeParse(messageInput);
  if (!parsed.success || !controllerOutboundTypes[namespace].has(parsed.data.type)) {
    return false;
  }
  return parsed.data.type !== "syncaction.command.ready" || parsed.data.controller === namespace;
}

function readMessageType(input: unknown): string | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("type" in input) ||
    typeof input.type !== "string"
  ) {
    return null;
  }
  return input.type;
}
