import { z } from "zod";
import { ProtocolVersionSchema, SequenceSchema } from "./envelopes.js";
import {
  CanonicalUuidSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
} from "./identifiers.js";
import { isCanonicalBilibiliMediaKey, YOUTUBE_MEDIA_KEY_PATTERN } from "./media-identity.js";
import { DocumentRevisionSchema } from "./sync.js";

const UserIdSchema = CanonicalUuidSchema;
const PlaybackGroupIdSchema = CanonicalUuidSchema;
const MediaCommandIdSchema = CanonicalUuidSchema;
const PlaybackProposalIdSchema = CanonicalUuidSchema;
const ServerTimestampSchema = z.number().int().nonnegative().safe();
const ClientTimestampSchema = z.number().int().nonnegative().safe();
const DurationMsSchema = z.number().finite().positive().max(604_800_000);
const PositionMsSchema = z.number().finite().nonnegative().max(604_800_000);
const PlaybackRateSchema = z.number().finite().min(0.25).max(4);
const PROPOSAL_TTL_MS = 30_000;
const LEADER_GRACE_MS = 10_000;
const MediaFrameKeySchema = z
  .string()
  .max(103)
  .regex(/^(?:top|frame:[A-Za-z0-9._~-]{1,96})$/u);

export const MediaProviderSchema = z.enum(["YOUTUBE", "BILIBILI", "HTML5"]);

function validateMediaIdentity(
  identity: { provider: z.infer<typeof MediaProviderSchema>; mediaKey: string },
  context: z.RefinementCtx,
): void {
  const matchesProvider =
    (identity.provider === "YOUTUBE" && YOUTUBE_MEDIA_KEY_PATTERN.test(identity.mediaKey)) ||
    (identity.provider === "BILIBILI" && isCanonicalBilibiliMediaKey(identity.mediaKey)) ||
    (identity.provider === "HTML5" && /^html5:[A-Za-z0-9._~-]{1,192}$/u.test(identity.mediaKey));

  if (!matchesProvider) {
    context.addIssue({
      code: "custom",
      message: "mediaKey does not match provider",
      path: ["mediaKey"],
    });
  }
}

export const MediaIdentitySchema = z
  .object({
    provider: MediaProviderSchema,
    mediaKey: z.string().min(1).max(256),
  })
  .strict()
  .superRefine(validateMediaIdentity);

export const MediaTargetSchema = z
  .object({
    logicalTabId: LogicalTabIdSchema,
    documentRevision: DocumentRevisionSchema,
    frameKey: MediaFrameKeySchema,
    provider: MediaProviderSchema,
    mediaKey: z.string().min(1).max(256),
    durationMs: DurationMsSchema,
  })
  .strict()
  .superRefine(validateMediaIdentity);

export const MediaObservedStateSchema = z
  .object({
    observedAtClientMs: ClientTimestampSchema,
    positionMs: PositionMsSchema,
    paused: z.boolean(),
    playbackRate: PlaybackRateSchema,
    ended: z.boolean(),
    buffering: z.boolean(),
  })
  .strict();

function validateObservedPosition(
  target: z.infer<typeof MediaTargetSchema> | null,
  observed: z.infer<typeof MediaObservedStateSchema> | null,
  context: z.RefinementCtx,
): void {
  if ((target === null) !== (observed === null)) {
    context.addIssue({
      code: "custom",
      message: "target and observed state must both be present or absent",
      path: ["observed"],
    });
    return;
  }
  if (target !== null && observed !== null && observed.positionMs > target.durationMs) {
    context.addIssue({
      code: "custom",
      message: "observed position exceeds target duration",
      path: ["observed", "positionMs"],
    });
  }
}

export const PlaybackActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PLAY") }).strict(),
  z.object({ type: z.literal("PAUSE") }).strict(),
  z.object({ type: z.literal("SEEK"), positionMs: PositionMsSchema }).strict(),
  z.object({ type: z.literal("SET_RATE"), playbackRate: PlaybackRateSchema }).strict(),
  z
    .object({
      type: z.literal("SWITCH_TARGET"),
      target: MediaTargetSchema,
      observed: MediaObservedStateSchema,
    })
    .strict()
    .superRefine((action, context) => {
      validateObservedPosition(action.target, action.observed, context);
    }),
]);

export const PlaybackGroupMemberSchema = z
  .object({
    userId: UserIdSchema,
    username: z.string().min(1).max(32),
    displayName: z.string().min(1).max(64),
    activeDeviceId: DeviceIdSchema,
    joinedAtServerMs: ServerTimestampSchema,
    online: z.boolean(),
  })
  .strict();

export const PlaybackProposalSchema = z
  .object({
    proposalId: PlaybackProposalIdSchema,
    proposedByUserId: UserIdSchema,
    proposedByDeviceId: DeviceIdSchema,
    baseGroupRevision: SequenceSchema,
    action: PlaybackActionSchema,
    createdAtServerMs: ServerTimestampSchema,
    expiresAtServerMs: ServerTimestampSchema,
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.expiresAtServerMs - proposal.createdAtServerMs !== PROPOSAL_TTL_MS) {
      context.addIssue({
        code: "custom",
        message: "proposal expiry must use the fixed lifetime",
        path: ["expiresAtServerMs"],
      });
    }
  });

export const PlaybackGroupStatusSchema = z.enum([
  "IDLE",
  "LOADING",
  "PLAYING",
  "PAUSED",
  "ENDED_WAITING",
  "LEADER_GRACE",
]);

function statusForObservation(
  target: z.infer<typeof MediaTargetSchema> | null,
  observed: z.infer<typeof MediaObservedStateSchema> | null,
): Exclude<z.infer<typeof PlaybackGroupStatusSchema>, "LEADER_GRACE"> | undefined {
  if (target === null || observed === null) {
    return target === null && observed === null ? "IDLE" : undefined;
  }
  if (observed.ended) {
    return "ENDED_WAITING";
  }
  if (observed.buffering) {
    return "LOADING";
  }
  return observed.paused ? "PAUSED" : "PLAYING";
}

export const PlaybackGroupSnapshotSchema = z
  .object({
    playbackGroupId: PlaybackGroupIdSchema,
    roomId: RoomIdSchema,
    groupRevision: SequenceSchema,
    status: PlaybackGroupStatusSchema,
    leaderUserId: UserIdSchema,
    leaderDeviceId: DeviceIdSchema,
    members: z.array(PlaybackGroupMemberSchema).min(1).max(256),
    target: MediaTargetSchema.nullable(),
    observed: MediaObservedStateSchema.nullable(),
    observedAtServerMs: ServerTimestampSchema.nullable(),
    proposals: z.array(PlaybackProposalSchema).max(256),
    leaderGraceExpiresAtServerMs: ServerTimestampSchema.nullable(),
    updatedAtServerMs: ServerTimestampSchema,
  })
  .strict()
  .superRefine((group, context) => {
    validateObservedPosition(group.target, group.observed, context);
    if ((group.observed === null) !== (group.observedAtServerMs === null)) {
      context.addIssue({
        code: "custom",
        message: "observed state and server receive time must agree",
        path: ["observedAtServerMs"],
      });
    }

    const memberUsers = new Set<string>();
    const memberDevices = new Set<string>();
    for (const [index, member] of group.members.entries()) {
      if (memberUsers.has(member.userId)) {
        context.addIssue({
          code: "custom",
          message: "playback group contains a duplicate account",
          path: ["members", index, "userId"],
        });
      }
      if (memberDevices.has(member.activeDeviceId)) {
        context.addIssue({
          code: "custom",
          message: "playback group contains a duplicate active device",
          path: ["members", index, "activeDeviceId"],
        });
      }
      memberUsers.add(member.userId);
      memberDevices.add(member.activeDeviceId);
    }

    const leader = group.members.find((member) => member.userId === group.leaderUserId);
    if (leader?.activeDeviceId !== group.leaderDeviceId) {
      context.addIssue({
        code: "custom",
        message: "leader must match an active group member device",
        path: ["leaderDeviceId"],
      });
    }

    const proposalIds = new Set<string>();
    const proposerUsers = new Set<string>();
    for (const [index, proposal] of group.proposals.entries()) {
      const proposer = group.members.find((member) => member.userId === proposal.proposedByUserId);
      if (proposer?.activeDeviceId !== proposal.proposedByDeviceId) {
        context.addIssue({
          code: "custom",
          message: "proposal must belong to an active group member device",
          path: ["proposals", index, "proposedByDeviceId"],
        });
      }
      if (proposalIds.has(proposal.proposalId)) {
        context.addIssue({
          code: "custom",
          message: "playback group contains a duplicate proposal",
          path: ["proposals", index, "proposalId"],
        });
      }
      if (proposerUsers.has(proposal.proposedByUserId)) {
        context.addIssue({
          code: "custom",
          message: "a member may have only one pending proposal",
          path: ["proposals", index, "proposedByUserId"],
        });
      }
      if (proposal.baseGroupRevision !== group.groupRevision) {
        context.addIssue({
          code: "custom",
          message: "pending proposal must match the current group revision",
          path: ["proposals", index, "baseGroupRevision"],
        });
      }
      proposalIds.add(proposal.proposalId);
      proposerUsers.add(proposal.proposedByUserId);
    }

    const inLeaderGrace = group.status === "LEADER_GRACE";
    if (inLeaderGrace) {
      const remainingGraceMs =
        group.leaderGraceExpiresAtServerMs === null
          ? null
          : group.leaderGraceExpiresAtServerMs - group.updatedAtServerMs;
      if (
        remainingGraceMs === null ||
        remainingGraceMs <= 0 ||
        remainingGraceMs > LEADER_GRACE_MS
      ) {
        context.addIssue({
          code: "custom",
          message: "leader grace must have at most the fixed lifetime remaining",
          path: ["leaderGraceExpiresAtServerMs"],
        });
      }
      if (leader?.online !== false) {
        context.addIssue({
          code: "custom",
          message: "leader grace requires the leader device to be offline",
          path: ["status"],
        });
      }
    } else {
      if (group.leaderGraceExpiresAtServerMs !== null) {
        context.addIssue({
          code: "custom",
          message: "only leader grace may carry an expiry",
          path: ["leaderGraceExpiresAtServerMs"],
        });
      }
      if (leader?.online !== true) {
        context.addIssue({
          code: "custom",
          message: "an active playback status requires an online leader",
          path: ["status"],
        });
      }
      const expectedStatus = statusForObservation(group.target, group.observed);
      if (expectedStatus !== group.status) {
        context.addIssue({
          code: "custom",
          message: "playback status must exactly match its authoritative observation",
          path: ["status"],
        });
      }
    }
  });

const ReliableCommandBase = {
  protocolVersion: ProtocolVersionSchema,
  commandId: MediaCommandIdSchema,
  roomId: RoomIdSchema,
};
const ExistingGroupCommandBase = {
  ...ReliableCommandBase,
  playbackGroupId: PlaybackGroupIdSchema,
  expectedGroupRevision: SequenceSchema,
};

const GroupCreateCommandSchema = z
  .object({
    type: z.literal("group.create"),
    ...ReliableCommandBase,
    target: MediaTargetSchema.nullable(),
    observed: MediaObservedStateSchema.nullable(),
  })
  .strict();
const GroupJoinCommandSchema = z
  .object({ type: z.literal("group.join"), ...ExistingGroupCommandBase })
  .strict();
const GroupLeaveCommandSchema = z
  .object({ type: z.literal("group.leave"), ...ExistingGroupCommandBase })
  .strict();
const GroupTakeoverCommandSchema = z
  .object({ type: z.literal("group.takeover"), ...ExistingGroupCommandBase })
  .strict();
const GroupTransferLeaderCommandSchema = z
  .object({
    type: z.literal("group.transfer-leader"),
    ...ExistingGroupCommandBase,
    targetUserId: UserIdSchema,
    targetDeviceId: DeviceIdSchema,
  })
  .strict();
const GroupSwitchTargetCommandSchema = z
  .object({
    type: z.literal("group.switch-target"),
    ...ExistingGroupCommandBase,
    target: MediaTargetSchema,
    observed: MediaObservedStateSchema,
  })
  .strict();
const GroupCloseCommandSchema = z
  .object({ type: z.literal("group.close"), ...ExistingGroupCommandBase })
  .strict();
const ProposalCreateCommandSchema = z
  .object({
    type: z.literal("proposal.create"),
    ...ExistingGroupCommandBase,
    action: PlaybackActionSchema,
  })
  .strict();
const ProposalDecideCommandSchema = z
  .object({
    type: z.literal("proposal.decide"),
    ...ExistingGroupCommandBase,
    proposalId: PlaybackProposalIdSchema,
    decision: z.enum(["APPROVE", "REJECT"]),
  })
  .strict();

export const MediaCommandSchema = z
  .discriminatedUnion("type", [
    GroupCreateCommandSchema,
    GroupJoinCommandSchema,
    GroupLeaveCommandSchema,
    GroupTakeoverCommandSchema,
    GroupTransferLeaderCommandSchema,
    GroupSwitchTargetCommandSchema,
    GroupCloseCommandSchema,
    ProposalCreateCommandSchema,
    ProposalDecideCommandSchema,
  ])
  .superRefine((command, context) => {
    if (command.type === "group.create" || command.type === "group.switch-target") {
      validateObservedPosition(command.target, command.observed, context);
    }
  });

export const MediaHeartbeatSchema = z
  .object({
    type: z.literal("media.heartbeat"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    playbackGroupId: PlaybackGroupIdSchema,
    groupRevision: SequenceSchema,
    target: MediaTargetSchema,
    observedAtClientMs: ClientTimestampSchema,
    positionMs: PositionMsSchema,
    paused: z.boolean(),
    playbackRate: PlaybackRateSchema,
    ended: z.boolean(),
    buffering: z.boolean(),
  })
  .strict()
  .superRefine((heartbeat, context) => {
    if (heartbeat.positionMs > heartbeat.target.durationMs) {
      context.addIssue({
        code: "custom",
        message: "heartbeat position exceeds target duration",
        path: ["positionMs"],
      });
    }
  });

export const MediaErrorCodeSchema = z.enum([
  "INVALID_MEDIA_MESSAGE",
  "MEDIA_OFFLINE",
  "ROOM_MISMATCH",
  "DOCUMENT_UNAUTHORIZED",
  "TARGET_MISMATCH",
  "GROUP_NOT_FOUND",
  "GROUP_LIMIT_REACHED",
  "GROUP_MEMBER_LIMIT_REACHED",
  "GROUP_MEMBERSHIP_CONFLICT",
  "GROUP_REVISION_CONFLICT",
  "NOT_GROUP_MEMBER",
  "NOT_GROUP_LEADER",
  "LEADER_DEVICE_REQUIRED",
  "PROPOSAL_NOT_FOUND",
  "PROPOSAL_EXPIRED",
]);

const MediaCommandExistingGroupErrorCodeSchema = z.enum([
  "TARGET_MISMATCH",
  "GROUP_MEMBER_LIMIT_REACHED",
  "GROUP_MEMBERSHIP_CONFLICT",
  "GROUP_REVISION_CONFLICT",
  "NOT_GROUP_MEMBER",
  "NOT_GROUP_LEADER",
  "LEADER_DEVICE_REQUIRED",
  "PROPOSAL_NOT_FOUND",
  "PROPOSAL_EXPIRED",
]);
const MediaCommandUnavailableErrorCodeSchema = z.enum([
  "INVALID_MEDIA_MESSAGE",
  "MEDIA_OFFLINE",
  "ROOM_MISMATCH",
  "DOCUMENT_UNAUTHORIZED",
  "TARGET_MISMATCH",
  "GROUP_NOT_FOUND",
  "GROUP_LIMIT_REACHED",
  "GROUP_MEMBER_LIMIT_REACHED",
  "GROUP_MEMBERSHIP_CONFLICT",
]);
const MediaCommandAckBase = {
  type: z.literal("media.command.ack"),
  protocolVersion: ProtocolVersionSchema,
  commandId: MediaCommandIdSchema,
  roomId: RoomIdSchema,
  roomMediaRevision: SequenceSchema,
};

export const MediaCommandAckSchema = z.union([
  z
    .object({
      ...MediaCommandAckBase,
      accepted: z.literal(true),
      code: z.null(),
      playbackGroupId: PlaybackGroupIdSchema,
      groupRevision: SequenceSchema,
    })
    .strict(),
  z
    .object({
      ...MediaCommandAckBase,
      accepted: z.literal(false),
      code: MediaCommandExistingGroupErrorCodeSchema,
      playbackGroupId: PlaybackGroupIdSchema,
      groupRevision: SequenceSchema,
    })
    .strict(),
  z
    .object({
      ...MediaCommandAckBase,
      accepted: z.literal(false),
      code: MediaCommandUnavailableErrorCodeSchema,
      playbackGroupId: z.null(),
      groupRevision: z.null(),
    })
    .strict(),
]);

const MediaHeartbeatExistingGroupErrorCodeSchema = z.enum([
  "TARGET_MISMATCH",
  "GROUP_REVISION_CONFLICT",
  "NOT_GROUP_MEMBER",
  "NOT_GROUP_LEADER",
  "LEADER_DEVICE_REQUIRED",
]);
const MediaHeartbeatUnavailableErrorCodeSchema = z.enum([
  "INVALID_MEDIA_MESSAGE",
  "MEDIA_OFFLINE",
  "ROOM_MISMATCH",
  "DOCUMENT_UNAUTHORIZED",
  "TARGET_MISMATCH",
  "GROUP_NOT_FOUND",
]);
const MediaHeartbeatAckBase = {
  type: z.literal("media.heartbeat.ack"),
  protocolVersion: ProtocolVersionSchema,
  roomId: RoomIdSchema,
  playbackGroupId: PlaybackGroupIdSchema,
  roomMediaRevision: SequenceSchema,
};

export const MediaHeartbeatAckSchema = z.union([
  z
    .object({
      ...MediaHeartbeatAckBase,
      accepted: z.literal(true),
      code: z.null(),
      groupRevision: SequenceSchema,
    })
    .strict(),
  z
    .object({
      ...MediaHeartbeatAckBase,
      accepted: z.literal(false),
      code: MediaHeartbeatExistingGroupErrorCodeSchema,
      groupRevision: SequenceSchema,
    })
    .strict(),
  z
    .object({
      ...MediaHeartbeatAckBase,
      accepted: z.literal(false),
      code: MediaHeartbeatUnavailableErrorCodeSchema,
      groupRevision: z.null(),
    })
    .strict(),
]);

export const MediaGroupsSnapshotMessageSchema = z
  .object({
    type: z.literal("media.groups.snapshot"),
    protocolVersion: ProtocolVersionSchema,
    roomId: RoomIdSchema,
    roomMediaRevision: SequenceSchema,
    groups: z.array(PlaybackGroupSnapshotSchema).max(20),
  })
  .strict()
  .superRefine((message, context) => {
    const groupIds = new Set<string>();
    const memberUsers = new Set<string>();
    const memberDevices = new Set<string>();
    let roomMemberCount = 0;
    for (const [index, group] of message.groups.entries()) {
      if (group.roomId !== message.roomId) {
        context.addIssue({
          code: "custom",
          message: "playback group belongs to another room",
          path: ["groups", index, "roomId"],
        });
      }
      if (groupIds.has(group.playbackGroupId)) {
        context.addIssue({
          code: "custom",
          message: "media snapshot contains a duplicate playback group",
          path: ["groups", index, "playbackGroupId"],
        });
      }
      groupIds.add(group.playbackGroupId);

      for (const [memberIndex, member] of group.members.entries()) {
        roomMemberCount += 1;
        if (memberUsers.has(member.userId)) {
          context.addIssue({
            code: "custom",
            message: "media snapshot contains an account in more than one playback group",
            path: ["groups", index, "members", memberIndex, "userId"],
          });
        }
        if (memberDevices.has(member.activeDeviceId)) {
          context.addIssue({
            code: "custom",
            message: "media snapshot contains a device in more than one playback group",
            path: ["groups", index, "members", memberIndex, "activeDeviceId"],
          });
        }
        memberUsers.add(member.userId);
        memberDevices.add(member.activeDeviceId);
      }
    }
    if (roomMemberCount > 256) {
      context.addIssue({
        code: "custom",
        message: "media snapshot exceeds the room device bound",
        path: ["groups"],
      });
    }
  });

export type MediaProvider = z.infer<typeof MediaProviderSchema>;
export type MediaIdentity = z.infer<typeof MediaIdentitySchema>;
export type MediaTarget = z.infer<typeof MediaTargetSchema>;
export type MediaObservedState = z.infer<typeof MediaObservedStateSchema>;
export type PlaybackAction = z.infer<typeof PlaybackActionSchema>;
export type PlaybackGroupMember = z.infer<typeof PlaybackGroupMemberSchema>;
export type PlaybackProposal = z.infer<typeof PlaybackProposalSchema>;
export type PlaybackGroupStatus = z.infer<typeof PlaybackGroupStatusSchema>;
export type PlaybackGroupSnapshot = z.infer<typeof PlaybackGroupSnapshotSchema>;
export type MediaCommand = z.infer<typeof MediaCommandSchema>;
export type MediaHeartbeat = z.infer<typeof MediaHeartbeatSchema>;
export type MediaErrorCode = z.infer<typeof MediaErrorCodeSchema>;
export type MediaCommandAck = z.infer<typeof MediaCommandAckSchema>;
export type MediaHeartbeatAck = z.infer<typeof MediaHeartbeatAckSchema>;
export type MediaGroupsSnapshotMessage = z.infer<typeof MediaGroupsSnapshotMessageSchema>;
