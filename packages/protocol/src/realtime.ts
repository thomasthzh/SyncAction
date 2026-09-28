import { z } from "zod";
import {
  CanonicalUuidSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
} from "./identifiers.js";
import { MediaIdentitySchema } from "./media.js";
import { DocumentRevisionSchema, PointerAnchorSchema, PresenceRecordSchema } from "./sync.js";

const RealtimeProtocolVersionSchema = z.literal(1);
const PointerExpirySchema = z.number().int().positive().safe();
const PointerColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

export const RealtimeSequenceSchema = z.number().int().nonnegative().safe();
export const CONTENT_SIGNATURE_VERSION = 1;
export const ContentDigestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const ContentSignatureSchema = z
  .object({
    signatureVersion: z.number().int().positive().safe(),
    digest: ContentDigestSchema,
  })
  .strict();

export const PresenceContentContextSchema = z
  .object({
    documentRevision: DocumentRevisionSchema,
    canonicalPageIdentity: z.string().min(1).max(4_096),
    contentSignature: ContentSignatureSchema.nullable(),
    media: MediaIdentitySchema.nullable(),
  })
  .strict();

export const PresenceUpdateV2Schema = z
  .object({
    type: z.literal("presence.update.v2"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    logicalTabId: LogicalTabIdSchema.nullable(),
    contentContext: PresenceContentContextSchema.nullable(),
  })
  .strict()
  .superRefine((update, context) => {
    if ((update.logicalTabId === null) !== (update.contentContext === null)) {
      context.addIssue({
        code: "custom",
        message: "content context must match active tab",
        path: ["contentContext"],
      });
    }
  });

export const PresenceRecordV2Schema = PresenceRecordSchema.extend({
  contentContext: PresenceContentContextSchema.nullable(),
}).strict();

export const PresenceDeltaChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("UPSERT"),
      presence: PresenceRecordV2Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("REMOVE"),
      userId: CanonicalUuidSchema,
      deviceId: DeviceIdSchema,
    })
    .strict(),
]);

export const PresenceDeltaMessageSchema = z
  .object({
    type: z.literal("presence.delta.v2"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    fromPresenceSeq: RealtimeSequenceSchema,
    toPresenceSeq: RealtimeSequenceSchema,
    changes: z.array(PresenceDeltaChangeSchema).min(1).max(256),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.toPresenceSeq < message.fromPresenceSeq) {
      context.addIssue({
        code: "custom",
        message: "presence delta bounds are reversed",
        path: ["toPresenceSeq"],
      });
    }
    if (message.toPresenceSeq - message.fromPresenceSeq !== message.changes.length) {
      context.addIssue({
        code: "custom",
        message: "presence delta bounds do not match change count",
        path: ["changes"],
      });
    }
  });

export const PresenceSnapshotV2MessageSchema = z
  .object({
    type: z.literal("presence.snapshot.v2"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    presenceSeq: RealtimeSequenceSchema,
    presences: z.array(PresenceRecordV2Schema).max(256),
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

export const PointerLeaseIdentitySchema = z
  .object({
    userId: CanonicalUuidSchema,
    deviceId: DeviceIdSchema,
    leaseId: CanonicalUuidSchema,
  })
  .strict();

export const PointerLeaseUpdateSchema = z
  .object({
    type: z.literal("pointer.lease"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    deviceId: DeviceIdSchema,
    leaseId: CanonicalUuidSchema,
    logicalTabId: LogicalTabIdSchema,
    documentRevision: DocumentRevisionSchema,
    anchor: PointerAnchorSchema.nullable(),
  })
  .strict();

export const PointerLeaseRecordSchema = PointerLeaseIdentitySchema.extend({
  username: z.string().min(1).max(32),
  displayName: z.string().min(1).max(64),
  color: PointerColorSchema,
  logicalTabId: LogicalTabIdSchema,
  documentRevision: DocumentRevisionSchema,
  anchor: PointerAnchorSchema.nullable(),
  expiresAt: PointerExpirySchema,
}).strict();

export const QuantizedPointerCoordinateSchema = z.number().int().min(0).max(4_095);
export const PointerViewportBucketSchema = z
  .object({
    widthBucket: z.number().int().min(1).max(64),
    heightBucket: z.number().int().min(1).max(64),
  })
  .strict();

export const PointerFrameSchema = z
  .object({
    type: z.literal("pointer.frame"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    leaseId: CanonicalUuidSchema,
    seq: z.number().int().positive().safe(),
    xQuantized: QuantizedPointerCoordinateSchema,
    yQuantized: QuantizedPointerCoordinateSchema,
    viewport: PointerViewportBucketSchema,
    sentAtClientMs: z.number().int().nonnegative().safe(),
  })
  .strict();

export const PointerFrameEventSchema = z
  .object({
    type: z.literal("pointer.frame"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    userId: CanonicalUuidSchema,
    deviceId: DeviceIdSchema,
    leaseId: CanonicalUuidSchema,
    seq: z.number().int().positive().safe(),
    xQuantized: QuantizedPointerCoordinateSchema,
    yQuantized: QuantizedPointerCoordinateSchema,
    viewport: PointerViewportBucketSchema,
    receivedAtServerMs: z.number().int().positive().safe(),
  })
  .strict();

export const PointerLeaseAckSchema = z
  .object({
    type: z.literal("pointer.lease.ack"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    leaseId: CanonicalUuidSchema,
    accepted: z.boolean(),
    expiresAt: PointerExpirySchema.nullable(),
  })
  .strict()
  .superRefine((acknowledgement, context) => {
    if (acknowledgement.accepted !== (acknowledgement.expiresAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "accepted pointer lease acknowledgement requires an expiry",
        path: ["expiresAt"],
      });
    }
  });

export const PointerLeaseEventSchema = z
  .object({
    type: z.literal("pointer.lease.event"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    lease: PointerLeaseRecordSchema,
  })
  .strict();

export const PointerLeaseClearSchema = z
  .object({
    type: z.literal("pointer.lease.clear"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    userId: CanonicalUuidSchema,
    deviceId: DeviceIdSchema,
    leaseId: CanonicalUuidSchema,
  })
  .strict();

export const PointerLeaseSnapshotSchema = z
  .object({
    type: z.literal("pointer.lease.snapshot"),
    protocolVersion: RealtimeProtocolVersionSchema,
    roomId: RoomIdSchema,
    leases: z.array(PointerLeaseRecordSchema).max(256),
  })
  .strict()
  .superRefine((message, context) => {
    const identities = new Set<string>();
    const leaseIds = new Set<string>();
    for (const [index, lease] of message.leases.entries()) {
      const identity = `${lease.userId}:${lease.deviceId}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "pointer lease snapshot contains a duplicate account/device identity",
          path: ["leases", index],
        });
      }
      if (leaseIds.has(lease.leaseId)) {
        context.addIssue({
          code: "custom",
          message: "pointer lease snapshot contains a duplicate lease identity",
          path: ["leases", index, "leaseId"],
        });
      }
      identities.add(identity);
      leaseIds.add(lease.leaseId);
    }
  });

export type RealtimeSequence = z.infer<typeof RealtimeSequenceSchema>;
export type ContentDigest = z.infer<typeof ContentDigestSchema>;
export type ContentSignature = z.infer<typeof ContentSignatureSchema>;
export type PresenceContentContext = z.infer<typeof PresenceContentContextSchema>;
export type PresenceUpdateV2 = z.infer<typeof PresenceUpdateV2Schema>;
export type PresenceRecordV2 = z.infer<typeof PresenceRecordV2Schema>;
export type PresenceDeltaChange = z.infer<typeof PresenceDeltaChangeSchema>;
export type PresenceDeltaMessage = z.infer<typeof PresenceDeltaMessageSchema>;
export type PresenceSnapshotV2Message = z.infer<typeof PresenceSnapshotV2MessageSchema>;
export type PointerLeaseIdentity = z.infer<typeof PointerLeaseIdentitySchema>;
export type PointerLeaseUpdate = z.infer<typeof PointerLeaseUpdateSchema>;
export type PointerLeaseRecord = z.infer<typeof PointerLeaseRecordSchema>;
export type QuantizedPointerCoordinate = z.infer<typeof QuantizedPointerCoordinateSchema>;
export type PointerViewportBucket = z.infer<typeof PointerViewportBucketSchema>;
export type PointerFrame = z.infer<typeof PointerFrameSchema>;
export type PointerFrameEvent = z.infer<typeof PointerFrameEventSchema>;
export type PointerLeaseAck = z.infer<typeof PointerLeaseAckSchema>;
export type PointerLeaseEvent = z.infer<typeof PointerLeaseEventSchema>;
export type PointerLeaseClear = z.infer<typeof PointerLeaseClearSchema>;
export type PointerLeaseSnapshot = z.infer<typeof PointerLeaseSnapshotSchema>;
