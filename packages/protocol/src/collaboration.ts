import { z } from "zod";
import { ProtocolVersionSchema, SequenceSchema } from "./envelopes.js";
import {
  CanonicalUuidSchema,
  ClientOpIdSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
} from "./identifiers.js";
import { isCanonicalBilibiliMediaKey, YOUTUBE_MEDIA_KEY_PATTERN } from "./media-identity.js";
import { MediaProviderSchema } from "./media.js";
import {
  DocumentRevisionSchema,
  NormalizedCoordinateSchema,
  PointerPathSegmentSchema,
} from "./sync.js";

export const AnnotationOperationSequenceSchema = z.number().int().positive().safe();
export const AnnotationServerTimestampSchema = z.number().int().nonnegative().safe();
export const AnnotationStrokeVersionSchema = z.number().int().positive().safe();
export const MAX_ANNOTATION_STROKE_POINTS = 2_048;
export const MAX_ANNOTATION_STROKE_BYTES = 64 * 1_024;
const DANMAKU_LIFETIME_MS = 9_000;

export const CollaborationFrameKeySchema = z.string().regex(/^(?:top|frame:sha256-[0-9a-f]{32})$/u);
export const AnnotationPageKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const ExactDocumentIdentityFields = {
  roomId: RoomIdSchema,
  logicalTabId: LogicalTabIdSchema,
  documentRevision: DocumentRevisionSchema,
  frameKey: CollaborationFrameKeySchema,
};

export const ExactDocumentIdentitySchema = z.object(ExactDocumentIdentityFields).strict();

const mediaKeyMatchesProvider = (provider: z.infer<typeof MediaProviderSchema>, mediaKey: string) =>
  (provider === "YOUTUBE" && YOUTUBE_MEDIA_KEY_PATTERN.test(mediaKey)) ||
  (provider === "BILIBILI" && isCanonicalBilibiliMediaKey(mediaKey)) ||
  (provider === "HTML5" && /^html5:[A-Za-z0-9._~-]{1,192}$/u.test(mediaKey));

export const AnnotationLayoutSignatureSchema = z
  .object({
    widthCssPx: z.number().finite().positive().max(10_000_000),
    heightCssPx: z.number().finite().positive().max(10_000_000),
  })
  .strict();

export const AnnotationMediaAnchorSchema = z
  .object({
    type: z.literal("media"),
    provider: MediaProviderSchema,
    mediaKey: z.string().min(1).max(256),
  })
  .strict()
  .superRefine((anchor, context) => {
    if (!mediaKeyMatchesProvider(anchor.provider, anchor.mediaKey)) {
      context.addIssue({
        code: "custom",
        message: "mediaKey does not match provider",
        path: ["mediaKey"],
      });
    }
  });

export const AnnotationElementAnchorSchema = z
  .object({
    type: z.literal("element"),
    path: z.array(PointerPathSegmentSchema).min(1).max(12),
  })
  .strict();

export const AnnotationDocumentAnchorSchema = z
  .object({
    type: z.literal("document"),
    layoutSignature: AnnotationLayoutSignatureSchema,
  })
  .strict();

export const AnnotationAnchorSchema = z.discriminatedUnion("type", [
  AnnotationMediaAnchorSchema,
  AnnotationElementAnchorSchema,
  AnnotationDocumentAnchorSchema,
]);

export const NormalizedPointSchema = z
  .object({
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
    pressure: NormalizedCoordinateSchema,
  })
  .strict();

export const AnnotationRgbSchema = z
  .object({
    r: z.number().int().min(0).max(255),
    g: z.number().int().min(0).max(255),
    b: z.number().int().min(0).max(255),
  })
  .strict();

export const AnnotationStrokeDraftFields = {
  strokeId: CanonicalUuidSchema,
  frameKey: CollaborationFrameKeySchema,
  anchor: AnnotationAnchorSchema,
  points: z.array(NormalizedPointSchema).min(1).max(MAX_ANNOTATION_STROKE_POINTS),
  rgb: AnnotationRgbSchema,
  width: z.number().finite().min(1).max(32),
};

export type AnnotationGeometryCandidate = {
  strokeId: string;
  frameKey: string;
  anchor: unknown;
  points: readonly unknown[];
  rgb: unknown;
  width: number;
  contentSignature?: unknown;
};

export function serializedAnnotationStrokeBytes(stroke: AnnotationGeometryCandidate): number {
  return new TextEncoder().encode(
    JSON.stringify({
      strokeId: stroke.strokeId,
      frameKey: stroke.frameKey,
      anchor: stroke.anchor,
      points: stroke.points,
      rgb: stroke.rgb,
      width: stroke.width,
      ...("contentSignature" in stroke ? { contentSignature: stroke.contentSignature } : {}),
    }),
  ).byteLength;
}

export function validateSerializedAnnotationGeometry(
  stroke: AnnotationGeometryCandidate,
  context: z.RefinementCtx,
): void {
  if (serializedAnnotationStrokeBytes(stroke) > MAX_ANNOTATION_STROKE_BYTES) {
    context.addIssue({
      code: "custom",
      message: "serialized stroke geometry exceeds 64 KiB",
      path: ["points"],
    });
  }
}

export const AnnotationStrokeDraftSchema = z
  .object(AnnotationStrokeDraftFields)
  .strict()
  .superRefine(validateSerializedAnnotationGeometry);

export const AnnotationStrokeSchema = z
  .object({
    ...AnnotationStrokeDraftFields,
    authorUserId: CanonicalUuidSchema,
    lockedAtServerMs: AnnotationServerTimestampSchema.nullable(),
    version: AnnotationStrokeVersionSchema,
    createdAtServerMs: AnnotationServerTimestampSchema,
    deletedAtServerMs: AnnotationServerTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((stroke, context) => {
    validateSerializedAnnotationGeometry(stroke, context);
    if (stroke.lockedAtServerMs !== null && stroke.lockedAtServerMs < stroke.createdAtServerMs) {
      context.addIssue({
        code: "custom",
        message: "stroke cannot be locked before it is created",
        path: ["lockedAtServerMs"],
      });
    }
    if (stroke.deletedAtServerMs !== null && stroke.deletedAtServerMs < stroke.createdAtServerMs) {
      context.addIssue({
        code: "custom",
        message: "stroke cannot be deleted before it is created",
        path: ["deletedAtServerMs"],
      });
    }
  });

export const AnnotationMutationTargetSchema = z
  .object({
    strokeId: CanonicalUuidSchema,
    expectedVersion: AnnotationStrokeVersionSchema,
  })
  .strict();

export const AnnotationMutationItemsSchema = z
  .array(AnnotationMutationTargetSchema)
  .min(1)
  .max(256)
  .superRefine((items, context) => {
    const strokeIds = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (strokeIds.has(item.strokeId)) {
        context.addIssue({
          code: "custom",
          message: "annotation operation contains a duplicate stroke ID",
          path: [index, "strokeId"],
        });
      }
      strokeIds.add(item.strokeId);
    }
  });

const StrokeCreateOperationSchema = z
  .object({
    type: z.literal("stroke.create"),
    stroke: AnnotationStrokeDraftSchema,
  })
  .strict();
const StrokeDeleteOperationSchema = z
  .object({
    type: z.literal("stroke.delete"),
    items: AnnotationMutationItemsSchema,
  })
  .strict();
const StrokeLockOperationSchema = z
  .object({
    type: z.literal("stroke.lock"),
    items: AnnotationMutationItemsSchema,
  })
  .strict();
const StrokeUnlockOperationSchema = z
  .object({
    type: z.literal("stroke.unlock"),
    items: AnnotationMutationItemsSchema,
  })
  .strict();

export const AnnotationOperationSchema = z.discriminatedUnion("type", [
  StrokeCreateOperationSchema,
  StrokeDeleteOperationSchema,
  StrokeLockOperationSchema,
  StrokeUnlockOperationSchema,
]);

export const AnnotationItemErrorCodeSchema = z.enum([
  "STROKE_NOT_FOUND",
  "STROKE_DELETED",
  "STROKE_VERSION_CONFLICT",
  "STROKE_LOCKED",
  "STROKE_NOT_LOCKED",
  "NOT_STROKE_AUTHOR",
  "STROKE_PERMISSION_DENIED",
]);

export const AnnotationBatchItemResultSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      strokeId: CanonicalUuidSchema,
      accepted: z.literal(true),
      code: z.null(),
      version: AnnotationStrokeVersionSchema,
    })
    .strict(),
  z
    .object({
      strokeId: CanonicalUuidSchema,
      accepted: z.literal(false),
      code: AnnotationItemErrorCodeSchema,
      version: AnnotationStrokeVersionSchema.nullable(),
    })
    .strict(),
]);

function operationStrokeIds(operation: z.infer<typeof AnnotationOperationSchema>): string[] {
  return operation.type === "stroke.create"
    ? [operation.stroke.strokeId]
    : operation.items.map((item) => item.strokeId);
}

function validateOperationResults(
  operation: z.infer<typeof AnnotationOperationSchema>,
  results: z.infer<typeof AnnotationBatchItemResultSchema>[],
  context: z.RefinementCtx,
): void {
  const expectedIds = operationStrokeIds(operation);
  const actualIds = results.map((result) => result.strokeId);
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((strokeId, index) => strokeId !== actualIds[index])
  ) {
    context.addIssue({
      code: "custom",
      message: "annotation results must exactly match operation targets",
      path: ["results"],
    });
  }
}

export const AnnotationCommittedOperationSchema = z
  .object({
    type: z.literal("annotation.committed"),
    protocolVersion: ProtocolVersionSchema,
    clientOpId: ClientOpIdSchema,
    roomId: RoomIdSchema,
    pageKey: AnnotationPageKeySchema,
    annotationSeq: AnnotationOperationSequenceSchema,
    actorUserId: CanonicalUuidSchema,
    operation: AnnotationOperationSchema,
    results: z.array(AnnotationBatchItemResultSchema).min(1).max(256),
    createdAtServerMs: AnnotationServerTimestampSchema,
  })
  .strict()
  .superRefine((message, context) => {
    validateOperationResults(message.operation, message.results, context);
  });

export const AnnotationSyncRequestSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    ...ExactDocumentIdentityFields,
    lastAnnotationSeq: SequenceSchema,
    hasConfirmedSnapshot: z.boolean(),
  })
  .strict();

export const AnnotationSnapshotMessageSchema = z
  .object({
    type: z.literal("annotation.snapshot"),
    protocolVersion: ProtocolVersionSchema,
    ...ExactDocumentIdentityFields,
    pageKey: AnnotationPageKeySchema,
    annotationSeq: SequenceSchema,
    strokes: z.array(AnnotationStrokeSchema).max(2_000),
  })
  .strict()
  .superRefine((message, context) => {
    const strokeIds = new Set<string>();
    for (const [index, stroke] of message.strokes.entries()) {
      if (strokeIds.has(stroke.strokeId)) {
        context.addIssue({
          code: "custom",
          message: "annotation snapshot contains a duplicate stroke ID",
          path: ["strokes", index, "strokeId"],
        });
      }
      strokeIds.add(stroke.strokeId);
    }
  });

export const AnnotationDeltaMessageSchema = z
  .object({
    type: z.literal("annotation.delta"),
    protocolVersion: ProtocolVersionSchema,
    ...ExactDocumentIdentityFields,
    pageKey: AnnotationPageKeySchema,
    fromAnnotationSeq: SequenceSchema,
    toAnnotationSeq: SequenceSchema,
    operations: z.array(AnnotationCommittedOperationSchema).max(1_000),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.toAnnotationSeq < message.fromAnnotationSeq) {
      context.addIssue({
        code: "custom",
        message: "annotation delta bounds are reversed",
        path: ["toAnnotationSeq"],
      });
    }
    if (message.toAnnotationSeq - message.fromAnnotationSeq !== message.operations.length) {
      context.addIssue({
        code: "custom",
        message: "annotation delta bounds do not match operation count",
        path: ["operations"],
      });
    }

    const clientOpIds = new Set<string>();
    for (const [index, operation] of message.operations.entries()) {
      if (
        operation.roomId !== message.roomId ||
        operation.pageKey !== message.pageKey ||
        operation.annotationSeq !== message.fromAnnotationSeq + index + 1
      ) {
        context.addIssue({
          code: "custom",
          message: "annotation delta operation identity or sequence is not contiguous",
          path: ["operations", index],
        });
      }
      if (clientOpIds.has(operation.clientOpId)) {
        context.addIssue({
          code: "custom",
          message: "annotation delta contains a duplicate client operation ID",
          path: ["operations", index, "clientOpId"],
        });
      }
      clientOpIds.add(operation.clientOpId);
    }
  });

export const AnnotationErrorCodeSchema = z.enum([
  "INVALID_ANNOTATION_MESSAGE",
  "ANNOTATION_OFFLINE",
  "ROOM_MISMATCH",
  "DOCUMENT_UNAUTHORIZED",
  "PAGE_MISMATCH",
  "ANNOTATION_SEQUENCE_CONFLICT",
  "ANNOTATION_CLIENT_OP_REUSE",
  "ANNOTATION_PAGE_CAPACITY_REACHED",
  "ANNOTATION_STROKE_TOO_LARGE",
  "ANNOTATION_OPERATION_REJECTED",
]);

const AnnotationAckBase = {
  type: z.literal("annotation.ack"),
  protocolVersion: ProtocolVersionSchema,
  clientOpId: ClientOpIdSchema,
  roomId: RoomIdSchema,
};

export const AnnotationAckSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      ...AnnotationAckBase,
      accepted: z.literal(true),
      code: z.null(),
      pageKey: AnnotationPageKeySchema,
      annotationSeq: AnnotationOperationSequenceSchema,
      results: z.array(AnnotationBatchItemResultSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...AnnotationAckBase,
      accepted: z.literal(false),
      code: AnnotationErrorCodeSchema,
      pageKey: AnnotationPageKeySchema.nullable(),
      annotationSeq: z.null(),
      results: z.array(z.never()).max(0),
    })
    .strict(),
]);

export const AnnotationSubmitSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    clientOpId: ClientOpIdSchema,
    ...ExactDocumentIdentityFields,
    pageKey: AnnotationPageKeySchema,
    baseAnnotationSeq: SequenceSchema,
    operation: AnnotationOperationSchema,
  })
  .strict();

const CollaborationSenderSchema = z
  .object({
    userId: CanonicalUuidSchema,
    username: z.string().min(1).max(32),
    displayName: z.string().min(1).max(64),
    deviceId: DeviceIdSchema,
  })
  .strict();

const StrokePreviewFields = {
  previewId: CanonicalUuidSchema,
  ...ExactDocumentIdentityFields,
};
const StrokePreviewGeometryFields = {
  anchor: AnnotationAnchorSchema,
  points: z.array(NormalizedPointSchema).min(1).max(512),
  rgb: AnnotationRgbSchema,
  width: z.number().finite().min(1).max(32),
};

export const StrokePreviewUpdateSchema = z
  .object({
    type: z.literal("stroke.preview.update"),
    protocolVersion: ProtocolVersionSchema,
    ...StrokePreviewFields,
    ...StrokePreviewGeometryFields,
  })
  .strict();

export const StrokePreviewClearSchema = z
  .object({
    type: z.literal("stroke.preview.clear"),
    protocolVersion: ProtocolVersionSchema,
    ...StrokePreviewFields,
  })
  .strict();

export const StrokePreviewEventMessageSchema = z
  .object({
    type: z.literal("stroke.preview.event"),
    protocolVersion: ProtocolVersionSchema,
    ...StrokePreviewFields,
    sender: CollaborationSenderSchema,
    ...StrokePreviewGeometryFields,
    expiresAtServerMs: z.number().int().positive().safe(),
  })
  .strict();

export const StrokePreviewClearMessageSchema = z
  .object({
    type: z.literal("stroke.preview.clear"),
    protocolVersion: ProtocolVersionSchema,
    ...StrokePreviewFields,
    sender: z
      .object({
        userId: CanonicalUuidSchema,
        deviceId: DeviceIdSchema,
      })
      .strict(),
  })
  .strict();

export const DanmakuTextSchema = z
  .string()
  .refine((text) => text.trim().length > 0, "danmaku text cannot be blank")
  .refine((text) => [...text].length <= 120, "danmaku text exceeds 120 Unicode code points");

export const DanmakuSendSchema = z
  .object({
    type: z.literal("danmaku.send"),
    protocolVersion: ProtocolVersionSchema,
    messageId: CanonicalUuidSchema,
    ...ExactDocumentIdentityFields,
    text: DanmakuTextSchema,
  })
  .strict();

export const DanmakuErrorCodeSchema = z.enum([
  "INVALID_DANMAKU_MESSAGE",
  "DANMAKU_OFFLINE",
  "ROOM_MISMATCH",
  "DOCUMENT_UNAUTHORIZED",
  "DANMAKU_RATE_LIMITED",
]);

const DanmakuAckBase = {
  type: z.literal("danmaku.ack"),
  protocolVersion: ProtocolVersionSchema,
  messageId: CanonicalUuidSchema,
  roomId: RoomIdSchema,
};

export const DanmakuAckSchema = z.discriminatedUnion("accepted", [
  z
    .object({
      ...DanmakuAckBase,
      accepted: z.literal(true),
      code: z.null(),
      sentAtServerMs: AnnotationServerTimestampSchema,
      expiresAtServerMs: AnnotationServerTimestampSchema,
    })
    .strict()
    .superRefine((acknowledgement, context) => {
      if (
        acknowledgement.expiresAtServerMs - acknowledgement.sentAtServerMs !==
        DANMAKU_LIFETIME_MS
      ) {
        context.addIssue({
          code: "custom",
          message: "accepted danmaku acknowledgement must use the fixed lifetime",
          path: ["expiresAtServerMs"],
        });
      }
    }),
  z
    .object({
      ...DanmakuAckBase,
      accepted: z.literal(false),
      code: DanmakuErrorCodeSchema,
      sentAtServerMs: z.null(),
      expiresAtServerMs: z.null(),
    })
    .strict(),
]);

export const DanmakuEventMessageSchema = z
  .object({
    type: z.literal("danmaku.event"),
    protocolVersion: ProtocolVersionSchema,
    messageId: CanonicalUuidSchema,
    ...ExactDocumentIdentityFields,
    sender: CollaborationSenderSchema,
    text: DanmakuTextSchema,
    sentAtServerMs: AnnotationServerTimestampSchema,
    expiresAtServerMs: AnnotationServerTimestampSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.expiresAtServerMs - event.sentAtServerMs !== DANMAKU_LIFETIME_MS) {
      context.addIssue({
        code: "custom",
        message: "danmaku event must use the fixed lifetime",
        path: ["expiresAtServerMs"],
      });
    }
  });

export type CollaborationFrameKey = z.infer<typeof CollaborationFrameKeySchema>;
export type AnnotationPageKey = z.infer<typeof AnnotationPageKeySchema>;
export type ExactDocumentIdentity = z.infer<typeof ExactDocumentIdentitySchema>;
export type AnnotationLayoutSignature = z.infer<typeof AnnotationLayoutSignatureSchema>;
export type AnnotationAnchor = z.infer<typeof AnnotationAnchorSchema>;
export type NormalizedPoint = z.infer<typeof NormalizedPointSchema>;
export type AnnotationRgb = z.infer<typeof AnnotationRgbSchema>;
export type AnnotationStrokeDraft = z.infer<typeof AnnotationStrokeDraftSchema>;
export type AnnotationStroke = z.infer<typeof AnnotationStrokeSchema>;
export type AnnotationMutationTarget = z.infer<typeof AnnotationMutationTargetSchema>;
export type AnnotationOperation = z.infer<typeof AnnotationOperationSchema>;
export type AnnotationItemErrorCode = z.infer<typeof AnnotationItemErrorCodeSchema>;
export type AnnotationBatchItemResult = z.infer<typeof AnnotationBatchItemResultSchema>;
export type AnnotationCommittedOperation = z.infer<typeof AnnotationCommittedOperationSchema>;
export type AnnotationSyncRequest = z.infer<typeof AnnotationSyncRequestSchema>;
export type AnnotationSnapshotMessage = z.infer<typeof AnnotationSnapshotMessageSchema>;
export type AnnotationDeltaMessage = z.infer<typeof AnnotationDeltaMessageSchema>;
export type AnnotationErrorCode = z.infer<typeof AnnotationErrorCodeSchema>;
export type AnnotationAck = z.infer<typeof AnnotationAckSchema>;
export type AnnotationSubmit = z.infer<typeof AnnotationSubmitSchema>;
export type StrokePreviewUpdate = z.infer<typeof StrokePreviewUpdateSchema>;
export type StrokePreviewClear = z.infer<typeof StrokePreviewClearSchema>;
export type StrokePreviewEventMessage = z.infer<typeof StrokePreviewEventMessageSchema>;
export type StrokePreviewClearMessage = z.infer<typeof StrokePreviewClearMessageSchema>;
export type DanmakuSend = z.infer<typeof DanmakuSendSchema>;
export type DanmakuErrorCode = z.infer<typeof DanmakuErrorCodeSchema>;
export type DanmakuAck = z.infer<typeof DanmakuAckSchema>;
export type DanmakuEventMessage = z.infer<typeof DanmakuEventMessageSchema>;
