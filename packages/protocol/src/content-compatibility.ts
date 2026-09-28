import { z } from "zod";
import {
  AnnotationAnchorSchema,
  AnnotationBatchItemResultSchema,
  AnnotationDocumentAnchorSchema,
  AnnotationErrorCodeSchema,
  AnnotationMediaAnchorSchema,
  AnnotationMutationItemsSchema,
  AnnotationOperationSequenceSchema,
  AnnotationPageKeySchema,
  AnnotationServerTimestampSchema,
  AnnotationStrokeDraftFields,
  AnnotationStrokeVersionSchema,
  ExactDocumentIdentityFields,
  validateSerializedAnnotationGeometry,
} from "./collaboration.js";
import { ProtocolVersionSchema, SequenceSchema } from "./envelopes.js";
import {
  CanonicalUuidSchema,
  ClientOpIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
} from "./identifiers.js";
import { ContentSignatureSchema, PresenceContentContextSchema } from "./realtime.js";
import { PointerPathSegmentSchema } from "./sync.js";

export const ContentCompatibilitySchema = z.enum(["EXACT", "MISMATCH", "UNKNOWN"]);

export const PageCompatibilityReportSchema = z
  .object({
    type: z.literal("page.compatibility.report"),
    protocolVersion: ProtocolVersionSchema,
    logicalTabId: LogicalTabIdSchema,
    contentContext: PresenceContentContextSchema,
  })
  .strict();

export const AnnotationElementAnchorV2Schema = z
  .object({
    type: z.literal("element"),
    path: z.array(PointerPathSegmentSchema).min(1).max(12),
    anchorSignature: ContentSignatureSchema,
  })
  .strict();

export const AnnotationAnchorV2Schema = z.discriminatedUnion("type", [
  AnnotationMediaAnchorSchema,
  AnnotationElementAnchorV2Schema,
  AnnotationDocumentAnchorSchema,
]);

const AnnotationStrokeDraftV2Fields = {
  ...AnnotationStrokeDraftFields,
  anchor: AnnotationAnchorV2Schema,
  contentSignature: ContentSignatureSchema,
};

export const AnnotationStrokeDraftV2Schema = z
  .object(AnnotationStrokeDraftV2Fields)
  .strict()
  .superRefine(validateSerializedAnnotationGeometry);

const AnnotationReadableAnchorV2Schema = z.union([
  AnnotationAnchorV2Schema,
  AnnotationAnchorSchema,
]);

const AnnotationReadableStrokeDraftV2Schema = z
  .object({
    ...AnnotationStrokeDraftFields,
    anchor: AnnotationReadableAnchorV2Schema,
    contentSignature: ContentSignatureSchema.nullable(),
  })
  .strict()
  .superRefine((stroke, context) => {
    validateSerializedAnnotationGeometry(stroke, context);
    if (
      stroke.contentSignature !== null &&
      !AnnotationAnchorV2Schema.safeParse(stroke.anchor).success
    ) {
      context.addIssue({
        code: "custom",
        message: "signed v2 strokes require a v2 anchor",
        path: ["anchor"],
      });
    }
  });

export const AnnotationStrokeV2Schema = z
  .object({
    ...AnnotationStrokeDraftFields,
    anchor: AnnotationReadableAnchorV2Schema,
    contentSignature: ContentSignatureSchema.nullable(),
    authorUserId: CanonicalUuidSchema,
    lockedAtServerMs: AnnotationServerTimestampSchema.nullable(),
    version: AnnotationStrokeVersionSchema,
    createdAtServerMs: AnnotationServerTimestampSchema,
    deletedAtServerMs: AnnotationServerTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((stroke, context) => {
    validateSerializedAnnotationGeometry(stroke, context);
    if (
      stroke.contentSignature !== null &&
      !AnnotationAnchorV2Schema.safeParse(stroke.anchor).success
    ) {
      context.addIssue({
        code: "custom",
        message: "signed v2 strokes require a v2 anchor",
        path: ["anchor"],
      });
    }
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

const StrokeCreateOperationV2Schema = z
  .object({
    type: z.literal("stroke.create"),
    stroke: AnnotationStrokeDraftV2Schema,
  })
  .strict();

const ReadableStrokeCreateOperationV2Schema = z
  .object({
    type: z.literal("stroke.create"),
    stroke: AnnotationReadableStrokeDraftV2Schema,
  })
  .strict();

const StrokeDeleteOperationV2Schema = z
  .object({
    type: z.literal("stroke.delete"),
    items: AnnotationMutationItemsSchema,
  })
  .strict();

const StrokeLockOperationV2Schema = z
  .object({
    type: z.literal("stroke.lock"),
    items: AnnotationMutationItemsSchema,
  })
  .strict();

const StrokeUnlockOperationV2Schema = z
  .object({
    type: z.literal("stroke.unlock"),
    items: AnnotationMutationItemsSchema,
  })
  .strict();

export const AnnotationOperationV2Schema = z.discriminatedUnion("type", [
  StrokeCreateOperationV2Schema,
  StrokeDeleteOperationV2Schema,
  StrokeLockOperationV2Schema,
  StrokeUnlockOperationV2Schema,
]);

const AnnotationReadableOperationV2Schema = z.discriminatedUnion("type", [
  ReadableStrokeCreateOperationV2Schema,
  StrokeDeleteOperationV2Schema,
  StrokeLockOperationV2Schema,
  StrokeUnlockOperationV2Schema,
]);

export const AnnotationSubmitV2Schema = z
  .object({
    type: z.literal("annotation.submit.v2"),
    protocolVersion: ProtocolVersionSchema,
    clientOpId: ClientOpIdSchema,
    ...ExactDocumentIdentityFields,
    pageKey: AnnotationPageKeySchema,
    baseAnnotationSeq: SequenceSchema,
    operation: AnnotationOperationV2Schema,
  })
  .strict();

const AnnotationAckV2Base = {
  type: z.literal("annotation.ack.v2"),
  protocolVersion: ProtocolVersionSchema,
  clientOpId: ClientOpIdSchema,
  roomId: RoomIdSchema,
};

export const AnnotationAckV2Schema = z.discriminatedUnion("accepted", [
  z
    .object({
      ...AnnotationAckV2Base,
      accepted: z.literal(true),
      code: z.null(),
      pageKey: AnnotationPageKeySchema,
      annotationSeq: AnnotationOperationSequenceSchema,
      results: z.array(AnnotationBatchItemResultSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...AnnotationAckV2Base,
      accepted: z.literal(false),
      code: AnnotationErrorCodeSchema,
      pageKey: AnnotationPageKeySchema.nullable(),
      annotationSeq: z.null(),
      results: z.array(z.never()).max(0),
    })
    .strict(),
]);

export const AnnotationCommittedOperationV2Schema = z
  .object({
    type: z.literal("annotation.committed.v2"),
    protocolVersion: ProtocolVersionSchema,
    clientOpId: ClientOpIdSchema,
    roomId: RoomIdSchema,
    pageKey: AnnotationPageKeySchema,
    annotationSeq: AnnotationOperationSequenceSchema,
    actorUserId: CanonicalUuidSchema,
    operation: AnnotationReadableOperationV2Schema,
    results: z.array(AnnotationBatchItemResultSchema).min(1).max(256),
    createdAtServerMs: AnnotationServerTimestampSchema,
  })
  .strict()
  .superRefine((message, context) => {
    validateOperationResults(message.operation, message.results, context);
  });

export const AnnotationSnapshotV2MessageSchema = z
  .object({
    type: z.literal("annotation.snapshot.v2"),
    protocolVersion: ProtocolVersionSchema,
    ...ExactDocumentIdentityFields,
    pageKey: AnnotationPageKeySchema,
    annotationSeq: SequenceSchema,
    strokes: z.array(AnnotationStrokeV2Schema).max(2_000),
  })
  .strict()
  .superRefine((message, context) => {
    validateUniqueStrokeIds(message.strokes, context);
  });

export const AnnotationDeltaV2MessageSchema = z
  .object({
    type: z.literal("annotation.delta.v2"),
    protocolVersion: ProtocolVersionSchema,
    ...ExactDocumentIdentityFields,
    pageKey: AnnotationPageKeySchema,
    fromAnnotationSeq: SequenceSchema,
    toAnnotationSeq: SequenceSchema,
    operations: z.array(AnnotationCommittedOperationV2Schema).max(1_000),
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

export type ContentCompatibility = z.infer<typeof ContentCompatibilitySchema>;
export type PageCompatibilityReport = z.infer<typeof PageCompatibilityReportSchema>;
export type AnnotationElementAnchorV2 = z.infer<typeof AnnotationElementAnchorV2Schema>;
export type AnnotationAnchorV2 = z.infer<typeof AnnotationAnchorV2Schema>;
export type AnnotationStrokeDraftV2 = z.infer<typeof AnnotationStrokeDraftV2Schema>;
export type AnnotationStrokeV2 = z.infer<typeof AnnotationStrokeV2Schema>;
export type AnnotationOperationV2 = z.infer<typeof AnnotationOperationV2Schema>;
export type AnnotationSubmitV2 = z.infer<typeof AnnotationSubmitV2Schema>;
export type AnnotationAckV2 = z.infer<typeof AnnotationAckV2Schema>;
export type AnnotationCommittedOperationV2 = z.infer<typeof AnnotationCommittedOperationV2Schema>;
export type AnnotationSnapshotV2Message = z.infer<typeof AnnotationSnapshotV2MessageSchema>;
export type AnnotationDeltaV2Message = z.infer<typeof AnnotationDeltaV2MessageSchema>;

function validateOperationResults(
  operation: z.infer<typeof AnnotationReadableOperationV2Schema>,
  results: z.infer<typeof AnnotationBatchItemResultSchema>[],
  context: z.RefinementCtx,
): void {
  const expectedIds =
    operation.type === "stroke.create"
      ? [operation.stroke.strokeId]
      : operation.items.map((item) => item.strokeId);
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

function validateUniqueStrokeIds(
  strokes: readonly z.infer<typeof AnnotationStrokeV2Schema>[],
  context: z.RefinementCtx,
): void {
  const strokeIds = new Set<string>();
  for (const [index, stroke] of strokes.entries()) {
    if (strokeIds.has(stroke.strokeId)) {
      context.addIssue({
        code: "custom",
        message: "annotation snapshot contains a duplicate stroke ID",
        path: ["strokes", index, "strokeId"],
      });
    }
    strokeIds.add(stroke.strokeId);
  }
}
