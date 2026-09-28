import { z } from "zod";
import { ClientOpIdSchema, CanonicalUuidSchema, RoomIdSchema } from "./identifiers.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });

export const RoomVisibilitySchema = z.enum(["PRIVATE", "PUBLIC"]);
export const RoomJoinPolicySchema = z.enum(["OPEN", "APPROVAL", "INVITE_ONLY"]);
export const RoomRevisionSchema = z.number().int().nonnegative().safe();
export const NotificationCursorSchema = z.number().int().positive().safe();
export const NotificationAfterCursorSchema = z.number().int().nonnegative().safe();

export const ServerCapabilitySchema = z.enum([
  "public-rooms",
  "join-requests",
  "notifications",
  "volatile-pointer-v2",
  "content-compatibility-v1",
  "account-activation-v1",
  "account-key-login-v1",
]);
export const ServerCapabilityTokenSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

export const ServerMetaSchema = z
  .object({
    serverId: CanonicalUuidSchema,
    displayName: z.string().trim().min(1).max(128),
    softwareVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .nullable()
      .default(null),
    protocolVersion: z.string().regex(/^[1-9]\d*$/u),
    minimumClientVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    termsVersion: z.string().min(1).max(64),
    capabilities: z.array(ServerCapabilityTokenSchema).max(32),
    limits: z
      .object({
        ordinaryActiveRooms: z.number().int().positive().safe(),
        ordinaryOpenTabs: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (new Set(metadata.capabilities).size !== metadata.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "duplicate server capability",
      });
    }
  });

export const PublicRoomSummarySchema = z
  .object({
    roomId: RoomIdSchema,
    name: z.string().min(1).max(100),
    joinPolicy: RoomJoinPolicySchema,
    onlineCount: z.number().int().nonnegative().safe(),
    memberCount: z.number().int().positive().safe(),
    openTabCount: z.number().int().nonnegative().safe(),
    hasActivePlayback: z.boolean(),
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((room, context) => {
    if (room.onlineCount > room.memberCount) {
      context.addIssue({
        code: "custom",
        path: ["onlineCount"],
        message: "online count cannot exceed member count",
      });
    }
  });

export const DirectoryUserSchema = z
  .object({
    userId: CanonicalUuidSchema,
    username: z.string().min(1).max(32),
    displayName: z.string().min(1).max(64),
    online: z.boolean(),
  })
  .strict();

export const RoomJoinRequestStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);

export const RoomJoinRequestSchema = z
  .object({
    requestId: CanonicalUuidSchema,
    roomId: RoomIdSchema,
    applicant: DirectoryUserSchema.omit({ online: true }),
    status: RoomJoinRequestStatusSchema,
    createdAt: IsoTimestampSchema,
    decidedAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.status === "PENDING") !== (request.decidedAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "pending status and decision timestamp are inconsistent",
      });
    }
  });

export const PublicRoomMemberSchema = z
  .object({
    userId: CanonicalUuidSchema,
    username: z.string().min(1).max(32),
    displayName: z.string().min(1).max(64),
    role: z.enum(["OWNER", "MEMBER"]),
    joinedAt: IsoTimestampSchema,
  })
  .strict();

const RoomEventBaseFields = {
  type: z.literal("room.event"),
  protocolVersion: z.literal(1),
  eventId: CanonicalUuidSchema,
  roomId: RoomIdSchema,
  roomRevision: RoomRevisionSchema,
  occurredAt: IsoTimestampSchema,
} as const;

export const RoomEventMessageSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...RoomEventBaseFields,
        kind: z.literal("ROOM_MEMBER_JOINED"),
        member: PublicRoomMemberSchema,
      })
      .strict(),
    z
      .object({
        ...RoomEventBaseFields,
        kind: z.literal("ROOM_MEMBER_LEFT"),
        userId: CanonicalUuidSchema,
      })
      .strict(),
    z
      .object({
        ...RoomEventBaseFields,
        kind: z.literal("ROOM_MEMBER_REMOVED"),
        userId: CanonicalUuidSchema,
      })
      .strict(),
    z
      .object({
        ...RoomEventBaseFields,
        kind: z.literal("ROOM_OWNER_TRANSFERRED"),
        previousOwnerUserId: CanonicalUuidSchema,
        newOwnerUserId: CanonicalUuidSchema,
      })
      .strict(),
    z
      .object({
        ...RoomEventBaseFields,
        kind: z.literal("ROOM_UPDATED"),
        name: z.string().min(1).max(100),
        visibility: RoomVisibilitySchema,
        joinPolicy: RoomJoinPolicySchema,
      })
      .strict(),
    z
      .object({
        ...RoomEventBaseFields,
        kind: z.literal("ROOM_DISSOLVED"),
      })
      .strict(),
  ])
  .superRefine((message, context) => {
    if (
      message.kind === "ROOM_UPDATED" &&
      message.visibility === "PRIVATE" &&
      message.joinPolicy !== "INVITE_ONLY"
    ) {
      context.addIssue({
        code: "custom",
        path: ["joinPolicy"],
        message: "private rooms must be invite-only",
      });
    }
  });

export const NotificationTypeSchema = z.enum([
  "ROOM_INVITATION_CREATED",
  "ROOM_INVITATION_REVOKED",
  "ROOM_JOIN_REQUEST_CREATED",
  "ROOM_JOIN_REQUEST_APPROVED",
  "ROOM_JOIN_REQUEST_REJECTED",
  "ROOM_JOIN_REQUEST_CANCELLED",
  "ROOM_MEMBER_REMOVED",
  "ROOM_OWNERSHIP_TRANSFERRED",
  "ROOM_DISSOLVED",
  "SYSTEM_ANNOUNCEMENT",
  "SYSTEM_UPDATE",
]);

export const NotificationActorSummarySchema = z
  .object({
    userId: CanonicalUuidSchema,
    displayName: z.string().min(1).max(64),
  })
  .strict();

export const NotificationRoomSummarySchema = z
  .object({
    roomId: RoomIdSchema,
    name: z.string().min(1).max(100),
  })
  .strict();

const NotificationContextFields = {
  actor: NotificationActorSummarySchema.nullable(),
  room: NotificationRoomSummarySchema.nullable(),
  requestId: CanonicalUuidSchema.nullable(),
  invitationId: CanonicalUuidSchema.nullable(),
  decision: z.enum(["APPROVED", "REJECTED", "CANCELLED"]).nullable(),
  title: z.string().min(1).max(160).nullable(),
  body: z.string().min(1).max(2_000).nullable(),
  version: z.string().min(1).max(64).nullable(),
} as const;

export const NotificationContextSchema = z.object(NotificationContextFields).strict();

function addNotificationIssue(
  context: z.core.$RefinementCtx,
  path: keyof z.infer<typeof NotificationContextSchema>,
  message: string,
): void {
  context.addIssue({
    code: "custom",
    path: [path],
    message,
  });
}

export const NotificationSchema = z
  .object({
    notificationId: CanonicalUuidSchema,
    cursor: NotificationCursorSchema,
    type: NotificationTypeSchema,
    ...NotificationContextFields,
    createdAt: IsoTimestampSchema,
    readAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((notification, context) => {
    const requireRoom = (): void => {
      if (notification.room === null) {
        addNotificationIssue(context, "room", "room notification requires a room summary");
      }
    };
    const requireRequest = (decision: "APPROVED" | "REJECTED" | "CANCELLED" | null): void => {
      requireRoom();
      if (notification.requestId === null) {
        addNotificationIssue(context, "requestId", "request notification requires a request id");
      }
      if (notification.decision !== decision) {
        addNotificationIssue(context, "decision", "request decision does not match type");
      }
      if (notification.invitationId !== null) {
        addNotificationIssue(
          context,
          "invitationId",
          "request notification cannot carry an invitation id",
        );
      }
    };

    switch (notification.type) {
      case "ROOM_INVITATION_CREATED":
      case "ROOM_INVITATION_REVOKED":
        requireRoom();
        if (notification.invitationId === null) {
          addNotificationIssue(
            context,
            "invitationId",
            "invitation notification requires an invitation id",
          );
        }
        if (notification.requestId !== null || notification.decision !== null) {
          addNotificationIssue(
            context,
            "requestId",
            "invitation notification cannot carry request state",
          );
        }
        break;
      case "ROOM_JOIN_REQUEST_CREATED":
        requireRequest(null);
        break;
      case "ROOM_JOIN_REQUEST_APPROVED":
        requireRequest("APPROVED");
        break;
      case "ROOM_JOIN_REQUEST_REJECTED":
        requireRequest("REJECTED");
        break;
      case "ROOM_JOIN_REQUEST_CANCELLED":
        requireRequest("CANCELLED");
        break;
      case "ROOM_MEMBER_REMOVED":
      case "ROOM_OWNERSHIP_TRANSFERRED":
      case "ROOM_DISSOLVED":
        requireRoom();
        if (
          notification.requestId !== null ||
          notification.invitationId !== null ||
          notification.decision !== null
        ) {
          addNotificationIssue(
            context,
            "requestId",
            "room lifecycle notification cannot carry request or invitation state",
          );
        }
        break;
      case "SYSTEM_ANNOUNCEMENT":
      case "SYSTEM_UPDATE":
        if (notification.title === null) {
          addNotificationIssue(context, "title", "system notification requires a title");
        }
        if (notification.body === null) {
          addNotificationIssue(context, "body", "system notification requires a body");
        }
        if (
          notification.actor !== null ||
          notification.room !== null ||
          notification.requestId !== null ||
          notification.invitationId !== null ||
          notification.decision !== null
        ) {
          addNotificationIssue(
            context,
            "room",
            "system notification cannot carry room or actor state",
          );
        }
        break;
    }

    if (
      notification.type !== "SYSTEM_ANNOUNCEMENT" &&
      notification.type !== "SYSTEM_UPDATE" &&
      (notification.title !== null || notification.body !== null || notification.version !== null)
    ) {
      addNotificationIssue(
        context,
        "title",
        "non-system notification cannot carry system message fields",
      );
    }
  });

export const RoomJoinDecisionInputSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    clientOpId: ClientOpIdSchema,
  })
  .strict();

export const NotificationReadEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ONE"),
      notificationId: CanonicalUuidSchema,
      readAt: IsoTimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("THROUGH"),
      throughCursor: NotificationCursorSchema,
      readAt: IsoTimestampSchema,
    })
    .strict(),
]);

export const PublicRoomsInvalidatedSchema = z
  .object({
    type: z.literal("public-rooms.invalidated"),
    roomId: RoomIdSchema,
    reason: z.enum(["ROOM", "TAB_STATE", "PRESENCE", "PLAYBACK"]),
    roomRevision: RoomRevisionSchema.nullable(),
  })
  .strict()
  .superRefine((message, context) => {
    if ((message.reason === "ROOM") !== (message.roomRevision !== null)) {
      context.addIssue({
        code: "custom",
        path: ["roomRevision"],
        message: "room revision/reason mismatch",
      });
    }
  });

export type RoomVisibility = z.infer<typeof RoomVisibilitySchema>;
export type RoomJoinPolicy = z.infer<typeof RoomJoinPolicySchema>;
export type RoomRevision = z.infer<typeof RoomRevisionSchema>;
export type NotificationCursor = z.infer<typeof NotificationCursorSchema>;
export type NotificationAfterCursor = z.infer<typeof NotificationAfterCursorSchema>;
export type ServerCapability = z.infer<typeof ServerCapabilitySchema>;
export type ServerCapabilityToken = z.infer<typeof ServerCapabilityTokenSchema>;
export type ServerMeta = z.infer<typeof ServerMetaSchema>;
export type PublicRoomSummary = z.infer<typeof PublicRoomSummarySchema>;
export type DirectoryUser = z.infer<typeof DirectoryUserSchema>;
export type RoomJoinRequestStatus = z.infer<typeof RoomJoinRequestStatusSchema>;
export type RoomJoinRequest = z.infer<typeof RoomJoinRequestSchema>;
export type PublicRoomMember = z.infer<typeof PublicRoomMemberSchema>;
export type RoomEventMessage = z.infer<typeof RoomEventMessageSchema>;
export type NotificationType = z.infer<typeof NotificationTypeSchema>;
export type NotificationActorSummary = z.infer<typeof NotificationActorSummarySchema>;
export type NotificationRoomSummary = z.infer<typeof NotificationRoomSummarySchema>;
export type NotificationContext = z.infer<typeof NotificationContextSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type RoomJoinDecisionInput = z.infer<typeof RoomJoinDecisionInputSchema>;
export type NotificationReadEvent = z.infer<typeof NotificationReadEventSchema>;
export type PublicRoomsInvalidated = z.infer<typeof PublicRoomsInvalidatedSchema>;
