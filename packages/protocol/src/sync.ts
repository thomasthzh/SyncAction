import { z } from "zod";
import { CommittedOperationSchema, ProtocolVersionSchema, SequenceSchema } from "./envelopes.js";
import {
  CanonicalUuidSchema,
  ClientOpIdSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  SupportedUrlSchema,
} from "./identifiers.js";

const OperationSequenceSchema = z.number().int().positive().safe();

export const LogicalTabSnapshotSchema = z
  .object({
    id: LogicalTabIdSchema,
    url: SupportedUrlSchema,
    title: z.string().max(512).optional(),
    favIconUrl: z.string().url().nullable().optional(),
    createdAtSeq: OperationSequenceSchema,
    updatedAtSeq: OperationSequenceSchema,
    closedAtSeq: OperationSequenceSchema.nullable(),
  })
  .strict()
  .superRefine((tab, context) => {
    if (tab.updatedAtSeq < tab.createdAtSeq) {
      context.addIssue({
        code: "custom",
        message: "updatedAtSeq cannot precede createdAtSeq",
        path: ["updatedAtSeq"],
      });
    }
    if (tab.closedAtSeq !== null && tab.closedAtSeq !== tab.updatedAtSeq) {
      context.addIssue({
        code: "custom",
        message: "a tombstone must close at its last update sequence",
        path: ["closedAtSeq"],
      });
    }
  });

export const RoomSnapshotStateSchema = z
  .object({
    roomId: RoomIdSchema,
    roomEpoch: SequenceSchema,
    serverSeq: SequenceSchema,
    order: z.array(LogicalTabIdSchema),
    tabs: z.array(LogicalTabSnapshotSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]));
    if (tabsById.size !== state.tabs.length) {
      context.addIssue({
        code: "custom",
        message: "snapshot contains duplicate logical tab IDs",
        path: ["tabs"],
      });
    }

    const orderIds = new Set(state.order);
    if (orderIds.size !== state.order.length) {
      context.addIssue({
        code: "custom",
        message: "snapshot order contains duplicate logical tab IDs",
        path: ["order"],
      });
    }

    for (const [index, logicalTabId] of state.order.entries()) {
      const tab = tabsById.get(logicalTabId);
      if (tab === undefined || tab.closedAtSeq !== null) {
        context.addIssue({
          code: "custom",
          message: "snapshot order must reference an active logical tab",
          path: ["order", index],
        });
      }
    }

    for (const [index, tab] of state.tabs.entries()) {
      if (
        tab.createdAtSeq > state.serverSeq ||
        tab.updatedAtSeq > state.serverSeq ||
        (tab.closedAtSeq !== null && tab.closedAtSeq > state.serverSeq)
      ) {
        context.addIssue({
          code: "custom",
          message: "tab sequence cannot exceed room serverSeq",
          path: ["tabs", index],
        });
      }
      const isOrdered = orderIds.has(tab.id);
      if ((tab.closedAtSeq === null) !== isOrdered) {
        context.addIssue({
          code: "custom",
          message: "active tabs and order must contain the same logical IDs",
          path: ["tabs", index],
        });
      }
    }
  });

export const RoomSyncRequestSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    roomEpoch: SequenceSchema,
    lastServerSeq: SequenceSchema,
    hasConfirmedSnapshot: z.boolean(),
  })
  .strict();

export const RoomSnapshotMessageSchema = z
  .object({
    type: z.literal("room.snapshot"),
    protocolVersion: ProtocolVersionSchema,
    state: RoomSnapshotStateSchema,
  })
  .strict();

export const RoomDeltaMessageSchema = z
  .object({
    type: z.literal("room.delta"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    roomEpoch: SequenceSchema,
    fromServerSeq: SequenceSchema,
    toServerSeq: SequenceSchema,
    operations: z.array(CommittedOperationSchema).max(1_000),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.toServerSeq < message.fromServerSeq) {
      context.addIssue({
        code: "custom",
        message: "delta bounds are reversed",
        path: ["toServerSeq"],
      });
    }
    if (message.toServerSeq - message.fromServerSeq !== message.operations.length) {
      context.addIssue({
        code: "custom",
        message: "delta bounds do not match operation count",
        path: ["operations"],
      });
    }
    for (const [index, operation] of message.operations.entries()) {
      if (
        operation.roomId !== message.roomId ||
        operation.roomEpoch !== message.roomEpoch ||
        operation.serverSeq !== message.fromServerSeq + index + 1
      ) {
        context.addIssue({
          code: "custom",
          message: "delta operation identity or sequence is not contiguous",
          path: ["operations", index],
        });
      }
    }
  });

export const SyncErrorCodeSchema = z.enum([
  "INVALID_SYNC_MESSAGE",
  "SYNC_AUTH_REQUIRED",
  "ROOM_NOT_FOUND",
  "ROOM_EPOCH_MISMATCH",
  "DEVICE_MISMATCH",
  "BASE_SEQUENCE_AHEAD",
  "OPERATION_REJECTED",
  "CLIENT_OP_REUSE",
  "RECOVERY_REQUIRED",
  "OPERATION_RATE_LIMITED",
  "ROOM_TAB_LIMIT_REACHED",
]);

export const SyncErrorMessageSchema = z
  .object({
    type: z.literal("sync.error"),
    protocolVersion: ProtocolVersionSchema,
    code: SyncErrorCodeSchema,
    roomId: RoomIdSchema.optional(),
    clientOpId: ClientOpIdSchema.optional(),
  })
  .strict();

const UserIdSchema = CanonicalUuidSchema;
const PresenceExpirySchema = z.number().int().positive().safe();

export const PresenceUpdateSchema = z
  .object({
    type: z.literal("presence.update"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    logicalTabId: LogicalTabIdSchema.nullable(),
  })
  .strict();

export const PresenceAckSchema = z
  .object({
    type: z.literal("presence.ack"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    expiresAt: PresenceExpirySchema,
  })
  .strict();

export const PresenceRecordSchema = z
  .object({
    userId: UserIdSchema,
    username: z.string().min(1).max(32),
    displayName: z.string().min(1).max(64),
    deviceId: DeviceIdSchema,
    logicalTabId: LogicalTabIdSchema.nullable(),
    expiresAt: PresenceExpirySchema,
  })
  .strict();

export const PresenceSnapshotMessageSchema = z
  .object({
    type: z.literal("presence.snapshot"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    presences: z.array(PresenceRecordSchema).max(256),
  })
  .strict()
  .superRefine((message, context) => {
    const identities = new Set<string>();
    for (const [index, presence] of message.presences.entries()) {
      const identity = `${presence.userId}:${presence.deviceId}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "presence snapshot contains a duplicate account/device identity",
          path: ["presences", index],
        });
      }
      identities.add(identity);
    }
  });

export const NormalizedCoordinateSchema = z.number().finite().min(0).max(1);
const PointerExpirySchema = z.number().int().positive().safe();
const PointerColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

export const DocumentRevisionSchema = z
  .object({
    roomEpoch: SequenceSchema,
    tabUpdatedAtSeq: OperationSequenceSchema,
  })
  .strict();
export const PointerDocumentRevisionSchema = DocumentRevisionSchema;

export const PointerPathSegmentSchema = z
  .object({
    tagName: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
    nthOfType: z.number().int().min(1).max(4_096),
  })
  .strict();

export const PointerAnchorSchema = z
  .object({
    path: z.array(PointerPathSegmentSchema).min(1).max(12),
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
  })
  .strict();

export const PointerCoordinatesSchema = z
  .object({
    x: NormalizedCoordinateSchema,
    y: NormalizedCoordinateSchema,
  })
  .strict();

export const PointerUpdateSchema = z
  .object({
    type: z.literal("pointer.update"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    logicalTabId: LogicalTabIdSchema,
    documentRevision: PointerDocumentRevisionSchema,
    anchor: PointerAnchorSchema.nullable(),
    viewport: PointerCoordinatesSchema,
  })
  .strict();

export const PointerAckSchema = z
  .object({
    type: z.literal("pointer.ack"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    accepted: z.boolean(),
    expiresAt: PointerExpirySchema.nullable(),
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (acknowledgement.accepted !== (acknowledgement.expiresAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "accepted pointer acknowledgement requires an expiry",
        path: ["expiresAt"],
      });
    }
  });

export const PointerRecordSchema = z
  .object({
    userId: UserIdSchema,
    username: z.string().min(1).max(32),
    displayName: z.string().min(1).max(64),
    deviceId: DeviceIdSchema,
    color: PointerColorSchema,
    logicalTabId: LogicalTabIdSchema,
    documentRevision: PointerDocumentRevisionSchema,
    anchor: PointerAnchorSchema.nullable(),
    viewport: PointerCoordinatesSchema,
    expiresAt: PointerExpirySchema,
  })
  .strict();

export const PointerEventMessageSchema = z
  .object({
    type: z.literal("pointer.event"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    pointer: PointerRecordSchema,
  })
  .strict();

export const PointerClearMessageSchema = z
  .object({
    type: z.literal("pointer.clear"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    userId: UserIdSchema,
    deviceId: DeviceIdSchema,
  })
  .strict();

export const PointerSnapshotMessageSchema = z
  .object({
    type: z.literal("pointer.snapshot"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    pointers: z.array(PointerRecordSchema).max(256),
  })
  .strict()
  .superRefine((message, context) => {
    const identities = new Set<string>();
    for (const [index, pointer] of message.pointers.entries()) {
      const identity = `${pointer.userId}:${pointer.deviceId}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "pointer snapshot contains a duplicate account/device identity",
          path: ["pointers", index],
        });
      }
      identities.add(identity);
    }
  });

export type LogicalTabSnapshot = z.infer<typeof LogicalTabSnapshotSchema>;
export type RoomSnapshotState = z.infer<typeof RoomSnapshotStateSchema>;
export type RoomSyncRequest = z.infer<typeof RoomSyncRequestSchema>;
export type RoomSnapshotMessage = z.infer<typeof RoomSnapshotMessageSchema>;
export type RoomDeltaMessage = z.infer<typeof RoomDeltaMessageSchema>;
export type SyncErrorCode = z.infer<typeof SyncErrorCodeSchema>;
export type SyncErrorMessage = z.infer<typeof SyncErrorMessageSchema>;
export type PresenceUpdate = z.infer<typeof PresenceUpdateSchema>;
export type PresenceAck = z.infer<typeof PresenceAckSchema>;
export type PresenceRecord = z.infer<typeof PresenceRecordSchema>;
export type PresenceSnapshotMessage = z.infer<typeof PresenceSnapshotMessageSchema>;
export type DocumentRevision = z.infer<typeof DocumentRevisionSchema>;
export type PointerDocumentRevision = z.infer<typeof PointerDocumentRevisionSchema>;
export type PointerPathSegment = z.infer<typeof PointerPathSegmentSchema>;
export type PointerAnchor = z.infer<typeof PointerAnchorSchema>;
export type PointerCoordinates = z.infer<typeof PointerCoordinatesSchema>;
export type PointerUpdate = z.infer<typeof PointerUpdateSchema>;
export type PointerAck = z.infer<typeof PointerAckSchema>;
export type PointerRecord = z.infer<typeof PointerRecordSchema>;
export type PointerEventMessage = z.infer<typeof PointerEventMessageSchema>;
export type PointerClearMessage = z.infer<typeof PointerClearMessageSchema>;
export type PointerSnapshotMessage = z.infer<typeof PointerSnapshotMessageSchema>;
