import { randomUUID } from "node:crypto";
import type { createDatabase, Database } from "@syncaction/database";
import {
  PublicRoomsInvalidatedSchema,
  RoomEventMessageSchema,
  type NotificationActorSummary,
  type NotificationRoomSummary,
  type NotificationType,
  type RoomJoinPolicy,
  type RoomVisibility,
} from "@syncaction/protocol";
import type { Transaction } from "kysely";
import { type CapacityDecision, classifyOwner, lockCapacityPolicy } from "./capacity-policy.js";
import { RoomError } from "./errors.js";
import { NotificationService } from "./notification-service.js";
import {
  parseInvitationUsername,
  parseRoomId,
  parseRoomJoinPolicy,
  parseRoomName,
  parseRoomVisibility,
} from "./policy.js";
import {
  NULL_ROOM_PRODUCT_EVENT_SINK,
  type ProductRealtimeEvent,
  type RoomProductEventSink,
} from "./room-product-events.js";

type RoomDatabase = ReturnType<typeof createDatabase>;
type RoomRole = "OWNER" | "MEMBER";
type RoomProductState = {
  id: string;
  name: string;
  ownerUserId: string;
  roomEpoch: number;
  visibility: RoomVisibility;
  joinPolicy: RoomJoinPolicy;
  roomRevision: number;
  createdAt: Date;
  updatedAt: Date;
};
type CapacityRejectionCode = "ORDINARY_ROOM_LIMIT_REACHED" | "ROOM_TAB_LIMIT_REACHED";
type CapacityRejectedOutcome = { kind: "CAPACITY_REJECTED"; code: CapacityRejectionCode };
type CapacityCommittedOutcome<T> = { kind: "COMMITTED"; value: T };
type CapacityMutationOutcome<T> = CapacityCommittedOutcome<T> | CapacityRejectedOutcome;
type CapacityAuditActor =
  | { actorUserId: string; actorAdministratorId: null }
  | { actorUserId: null; actorAdministratorId: string };
type CapacityAuditInput = {
  actor: CapacityAuditActor;
  eventType:
    | "room.create_capacity_rejected"
    | "room.ownership_transfer_capacity_rejected"
    | "room.restore_capacity_rejected";
  targetId: string;
  details: Record<string, string | number>;
  createdAt: Date;
};
type OwnershipTransferCapacityCheck = {
  actor: CapacityAuditActor;
  roomId: string;
  previousOwnerUserId: string;
  newOwnerUserId: string;
  capacity: CapacityDecision;
  createdAt: Date;
};
type RestoreCapacityCheck = {
  actor: CapacityAuditActor;
  roomId: string;
  ownerUserId: string;
  capacity: CapacityDecision;
  createdAt: Date;
};

const roomProductStateColumns = [
  "id",
  "name",
  "ownerUserId",
  "roomEpoch",
  "visibility",
  "joinPolicy",
  "roomRevision",
  "createdAt",
  "updatedAt",
] as const;

function assertValidRoomAccess(visibility: RoomVisibility, joinPolicy: RoomJoinPolicy): void {
  if (visibility === "PRIVATE" && joinPolicy !== "INVITE_ONLY") {
    throw new RoomError("INVALID_ROOM_INPUT");
  }
}

function publicRoomFromState(
  room: RoomProductState,
  role: RoomRole,
  roomRevision = room.roomRevision,
  updatedAt = room.updatedAt,
): PublicRoom {
  return {
    id: room.id,
    name: room.name,
    role,
    roomEpoch: room.roomEpoch,
    visibility: room.visibility,
    joinPolicy: room.joinPolicy,
    roomRevision,
    createdAt: room.createdAt,
    updatedAt,
  };
}

function notificationContext(input: {
  actor?: NotificationActorSummary | null;
  room?: Pick<RoomProductState, "id" | "name"> | NotificationRoomSummary | null;
  requestId?: string | null;
  invitationId?: string | null;
  decision?: "APPROVED" | "REJECTED" | "CANCELLED" | null;
  title?: string | null;
  body?: string | null;
  version?: string | null;
}): Record<string, unknown> {
  const room =
    input.room === undefined || input.room === null
      ? null
      : "roomId" in input.room
        ? input.room
        : { roomId: input.room.id, name: input.room.name };
  return {
    actor: input.actor ?? null,
    room,
    requestId: input.requestId ?? null,
    invitationId: input.invitationId ?? null,
    decision: input.decision ?? null,
    title: input.title ?? null,
    body: input.body ?? null,
    version: input.version ?? null,
  };
}

async function bumpRoomRevision(
  transaction: Transaction<Database>,
  roomId: string,
  changedAt: Date,
): Promise<number> {
  const row = await transaction
    .updateTable("rooms")
    .set((expression) => ({
      roomRevision: expression("roomRevision", "+", 1),
      updatedAt: changedAt,
    }))
    .where("id", "=", roomId)
    .where("deletedAt", "is", null)
    .returning("roomRevision")
    .executeTakeFirstOrThrow();
  return Number(row.roomRevision);
}

function unwrapCapacityOutcome<T>(outcome: CapacityMutationOutcome<T>): T {
  if (outcome.kind === "CAPACITY_REJECTED") {
    throw new RoomError(outcome.code);
  }
  return outcome.value;
}

function rejectCapacity(code: CapacityRejectionCode): CapacityRejectedOutcome {
  return { kind: "CAPACITY_REJECTED", code };
}

function commitCapacity<T>(value: T): CapacityCommittedOutcome<T> {
  return { kind: "COMMITTED", value };
}

function parseAdministratorReasonCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) {
    throw new RoomError("INVALID_ROOM_INPUT");
  }
  return value;
}

export interface RoomServiceOptions {
  db: RoomDatabase;
  notifications?: NotificationService;
  events?: RoomProductEventSink;
  now?: () => Date;
}

export interface CreateRoomInput {
  actorUserId: unknown;
  name: unknown;
  visibility?: unknown;
  joinPolicy?: unknown;
}

export interface GetRoomInput {
  actorUserId: unknown;
  roomId: unknown;
}

export interface InviteByUsernameInput extends GetRoomInput {
  username: unknown;
}

export interface InvitationActionInput extends GetRoomInput {
  invitationId: unknown;
}

export interface RenameRoomInput extends GetRoomInput {
  name: unknown;
}

export interface UpdateRoomAccessInput extends GetRoomInput {
  visibility: unknown;
  joinPolicy: unknown;
}

export interface UpdateRoomInput extends UpdateRoomAccessInput {
  name: unknown;
}

export interface MemberActionInput extends GetRoomInput {
  memberUserId: unknown;
}

export interface TransferOwnershipInput extends GetRoomInput {
  newOwnerUserId: unknown;
}

export interface AdministratorTransferOwnershipInput {
  administratorId: unknown;
  roomId: unknown;
  newOwnerUserId: unknown;
  reasonCode: unknown;
}

export interface AdministratorRoomInput {
  administratorId: unknown;
  roomId: unknown;
  reasonCode: unknown;
}

export interface AcceptInvitationInput {
  actorUserId: unknown;
  invitationId: unknown;
}

export interface PublicRoom {
  id: string;
  name: string;
  role: RoomRole;
  roomEpoch: number;
  visibility: RoomVisibility;
  joinPolicy: RoomJoinPolicy;
  roomRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicRoomMember {
  userId: string;
  username: string;
  displayName: string;
  role: RoomRole;
  joinedAt: Date;
}

export interface PublicPendingInvitation {
  id: string;
  invitedUserId: string;
  username: string;
  displayName: string;
  status: "PENDING";
  expiresAt: Date;
  createdAt: Date;
}

export interface PublicRoomInvitation {
  id: string;
  roomId: string;
  invitedUserId: string;
  invitedByUserId: string;
  status: "PENDING";
  expiresAt: Date;
  createdAt: Date;
}

export interface PublicReceivedInvitation {
  id: string;
  roomId: string;
  roomName: string;
  invitedByUserId: string;
  invitedByUsername: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface PublicRoomDetail extends PublicRoom {
  members: PublicRoomMember[];
  pendingInvitations: PublicPendingInvitation[] | null;
}

export class RoomService {
  readonly #db: RoomDatabase;
  readonly #notifications: NotificationService;
  readonly #events: RoomProductEventSink;
  readonly #now: () => Date;

  public constructor(options: RoomServiceOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    this.#events = options.events ?? NULL_ROOM_PRODUCT_EVENT_SINK;
    this.#notifications =
      options.notifications ?? new NotificationService({ db: options.db, now: this.#now });
  }

  public async createRoom(input: CreateRoomInput): Promise<PublicRoom> {
    const actorUserId = parseRoomId(input.actorUserId);
    const name = parseRoomName(input.name);
    const visibility =
      input.visibility === undefined ? "PRIVATE" : parseRoomVisibility(input.visibility);
    const joinPolicy =
      input.joinPolicy === undefined ? "INVITE_ONLY" : parseRoomJoinPolicy(input.joinPolicy);
    assertValidRoomAccess(visibility, joinPolicy);
    const roomId = randomUUID();
    const createdAt = this.#now();

    const outcome = await this.#db.transaction().execute(async (transaction) => {
      const policy = await lockCapacityPolicy(transaction);
      const actor = await transaction
        .selectFrom("users")
        .select(["id", "status"])
        .where("id", "=", actorUserId)
        .forUpdate()
        .executeTakeFirst();
      if (actor?.status !== "ACTIVE") {
        throw new RoomError("INVALID_ROOM_TRANSITION");
      }
      const capacity = await this.#capacityDecision(transaction, actor.id, policy);
      if (capacity.quotaClass === "ORDINARY") {
        const activeOrdinaryRoomCount = await this.#countActiveOrdinaryRooms(transaction);
        if (activeOrdinaryRoomCount >= capacity.ordinaryActiveRoomLimit) {
          await this.#auditCapacityRejection(transaction, {
            actor: {
              actorUserId: actor.id,
              actorAdministratorId: null,
            },
            eventType: "room.create_capacity_rejected",
            targetId: roomId,
            details: {
              ownerUserId: actor.id,
              quotaClass: "ORDINARY",
              reasonCode: "ORDINARY_ROOM_LIMIT_REACHED",
              activeOrdinaryRoomCount,
              ordinaryActiveRoomLimit: capacity.ordinaryActiveRoomLimit,
            },
            createdAt,
          });
          return rejectCapacity("ORDINARY_ROOM_LIMIT_REACHED");
        }
      }

      const room = await transaction
        .insertInto("rooms")
        .values({
          id: roomId,
          name,
          ownerUserId: actor.id,
          visibility,
          joinPolicy,
          deletedAt: null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning([
          "id",
          "name",
          "roomEpoch",
          "visibility",
          "joinPolicy",
          "roomRevision",
          "createdAt",
          "updatedAt",
        ])
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("roomMemberships")
        .values({
          roomId: room.id,
          userId: actor.id,
          role: "OWNER",
          createdAt,
        })
        .execute();
      return commitCapacity({ ...room, role: "OWNER" as const });
    });
    const room = unwrapCapacityOutcome(outcome);
    const events: ProductRealtimeEvent[] = [];
    this.#stagePublicInvalidation(events, room, room.roomRevision);
    this.#publish(events);
    return room;
  }

  public async listRooms(actorUserIdInput: unknown): Promise<PublicRoom[]> {
    const actorUserId = parseRoomId(actorUserIdInput);
    await this.#requireActiveUser(actorUserId);
    return this.#db
      .selectFrom("roomMemberships")
      .innerJoin("rooms", "rooms.id", "roomMemberships.roomId")
      .select([
        "rooms.id",
        "rooms.name",
        "roomMemberships.role",
        "rooms.roomEpoch",
        "rooms.visibility",
        "rooms.joinPolicy",
        "rooms.roomRevision",
        "rooms.createdAt",
        "rooms.updatedAt",
      ])
      .where("roomMemberships.userId", "=", actorUserId)
      .where("rooms.deletedAt", "is", null)
      .orderBy("rooms.name", "asc")
      .orderBy("rooms.id", "asc")
      .execute();
  }

  public async getRoom(input: GetRoomInput): Promise<PublicRoomDetail> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    await this.#requireActiveUser(actorUserId);
    const room = await this.#db
      .selectFrom("roomMemberships")
      .innerJoin("rooms", "rooms.id", "roomMemberships.roomId")
      .select([
        "rooms.id",
        "rooms.name",
        "roomMemberships.role",
        "rooms.roomEpoch",
        "rooms.visibility",
        "rooms.joinPolicy",
        "rooms.roomRevision",
        "rooms.createdAt",
        "rooms.updatedAt",
      ])
      .where("roomMemberships.roomId", "=", roomId)
      .where("roomMemberships.userId", "=", actorUserId)
      .where("rooms.deletedAt", "is", null)
      .executeTakeFirst();
    if (room === undefined) {
      throw new RoomError("ROOM_NOT_FOUND");
    }

    const members = await this.#db
      .selectFrom("roomMemberships")
      .innerJoin("users", "users.id", "roomMemberships.userId")
      .select([
        "users.id as userId",
        "users.username",
        "users.displayName",
        "roomMemberships.role",
        "roomMemberships.createdAt as joinedAt",
      ])
      .where("roomMemberships.roomId", "=", room.id)
      .orderBy("roomMemberships.role", "desc")
      .orderBy("roomMemberships.createdAt", "asc")
      .orderBy("users.id", "asc")
      .execute();

    let pendingInvitations: PublicPendingInvitation[] | null = null;
    if (room.role === "OWNER") {
      const invitationRows = await this.#db
        .selectFrom("roomInvitations")
        .innerJoin("users", "users.id", "roomInvitations.invitedUserId")
        .select([
          "roomInvitations.id",
          "roomInvitations.invitedUserId",
          "users.username",
          "users.displayName",
          "roomInvitations.expiresAt",
          "roomInvitations.createdAt",
        ])
        .where("roomInvitations.roomId", "=", room.id)
        .where("roomInvitations.status", "=", "PENDING")
        .where("roomInvitations.expiresAt", ">", this.#now())
        .orderBy("roomInvitations.createdAt", "asc")
        .execute();
      pendingInvitations = invitationRows.map((invitation) => ({
        ...invitation,
        status: "PENDING",
      }));
    }
    return { ...room, members, pendingInvitations };
  }

  public async inviteByUsername(input: InviteByUsernameInput): Promise<PublicRoomInvitation> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const usernameNormalized = parseInvitationUsername(input.username);
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1_000);

    let committed: { value: PublicRoomInvitation; events: ProductRealtimeEvent[] };
    try {
      committed = await this.#db.transaction().execute(async (transaction) => {
        await this.#requireActiveUserInTransaction(transaction, actorUserId);
        await this.#requireOwner(transaction, actorUserId, roomId);
        const room = await this.#getActiveRoomForUpdate(transaction, roomId);
        const actor = await this.#getNotificationActor(transaction, actorUserId);
        const invitedUser = await transaction
          .selectFrom("users")
          .select(["id", "status"])
          .where("usernameNormalized", "=", usernameNormalized)
          .forUpdate()
          .executeTakeFirst();
        if (invitedUser?.status !== "ACTIVE" || invitedUser.id === actorUserId) {
          throw new RoomError("USER_NOT_INVITABLE");
        }
        const membership = await transaction
          .selectFrom("roomMemberships")
          .select("userId")
          .where("roomId", "=", roomId)
          .where("userId", "=", invitedUser.id)
          .executeTakeFirst();
        if (membership !== undefined) {
          throw new RoomError("USER_NOT_INVITABLE");
        }
        const invitation = await transaction
          .insertInto("roomInvitations")
          .values({
            id: randomUUID(),
            roomId,
            invitedUserId: invitedUser.id,
            invitedByUserId: actorUserId,
            status: "PENDING",
            expiresAt,
            createdAt,
            updatedAt: createdAt,
          })
          .returning([
            "id",
            "roomId",
            "invitedUserId",
            "invitedByUserId",
            "status",
            "expiresAt",
            "createdAt",
          ])
          .$narrowType<{ status: "PENDING" }>()
          .executeTakeFirstOrThrow();
        const roomRevision = await bumpRoomRevision(transaction, roomId, createdAt);
        const events: ProductRealtimeEvent[] = [
          this.#roomUpdatedEvent(room, roomRevision, createdAt),
        ];
        await this.#stageNotification(transaction, events, {
          recipientUserId: invitedUser.id,
          type: "ROOM_INVITATION_CREATED",
          context: notificationContext({
            actor,
            room,
            invitationId: invitation.id,
          }),
        });
        this.#stagePublicInvalidation(events, room, roomRevision);
        return { value: invitation, events };
      });
    } catch (cause) {
      if (isConstraintViolation(cause, "room_invitations_single_pending_index")) {
        throw new RoomError("INVITATION_CONFLICT", { cause });
      }
      throw cause;
    }
    this.#publish(committed.events);
    return committed.value;
  }

  public async listInvitations(actorUserIdInput: unknown): Promise<PublicReceivedInvitation[]> {
    const actorUserId = parseRoomId(actorUserIdInput);
    const checkedAt = this.#now();
    return this.#db.transaction().execute(async (transaction) => {
      await this.#requireActiveUserInTransaction(transaction, actorUserId);
      await transaction
        .updateTable("roomInvitations")
        .set({ status: "EXPIRED", updatedAt: checkedAt })
        .where("invitedUserId", "=", actorUserId)
        .where("status", "=", "PENDING")
        .where("expiresAt", "<=", checkedAt)
        .execute();
      return transaction
        .selectFrom("roomInvitations")
        .innerJoin("rooms", "rooms.id", "roomInvitations.roomId")
        .innerJoin("users as inviters", "inviters.id", "roomInvitations.invitedByUserId")
        .select([
          "roomInvitations.id",
          "rooms.id as roomId",
          "rooms.name as roomName",
          "inviters.id as invitedByUserId",
          "inviters.username as invitedByUsername",
          "roomInvitations.expiresAt",
          "roomInvitations.createdAt",
        ])
        .where("roomInvitations.invitedUserId", "=", actorUserId)
        .where("roomInvitations.status", "=", "PENDING")
        .where("rooms.deletedAt", "is", null)
        .orderBy("roomInvitations.createdAt", "asc")
        .execute();
    });
  }

  public async revokeInvitation(input: InvitationActionInput): Promise<void> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const invitationId = parseRoomId(input.invitationId);
    const changedAt = this.#now();
    const result = await this.#db.transaction().execute(async (transaction) => {
      await this.#requireActiveUserInTransaction(transaction, actorUserId);
      await this.#requireOwner(transaction, actorUserId, roomId);
      const room = await this.#getActiveRoomForUpdate(transaction, roomId);
      const actor = await this.#getNotificationActor(transaction, actorUserId);
      const invitation = await transaction
        .selectFrom("roomInvitations")
        .select(["id", "invitedUserId", "status", "expiresAt"])
        .where("id", "=", invitationId)
        .where("roomId", "=", roomId)
        .forUpdate()
        .executeTakeFirst();
      if (invitation?.status !== "PENDING") {
        return { outcome: "NOT_FOUND" as const, events: [] };
      }
      const expired = invitation.expiresAt.getTime() <= changedAt.getTime();
      await transaction
        .updateTable("roomInvitations")
        .set({
          status: expired ? "EXPIRED" : "REVOKED",
          updatedAt: changedAt,
        })
        .where("id", "=", invitation.id)
        .execute();
      if (expired) {
        return { outcome: "EXPIRED" as const, events: [] };
      }
      const roomRevision = await bumpRoomRevision(transaction, roomId, changedAt);
      const events: ProductRealtimeEvent[] = [
        this.#roomUpdatedEvent(room, roomRevision, changedAt),
      ];
      await this.#stageNotification(transaction, events, {
        recipientUserId: invitation.invitedUserId,
        type: "ROOM_INVITATION_REVOKED",
        context: notificationContext({
          actor,
          room,
          invitationId: invitation.id,
        }),
      });
      this.#stagePublicInvalidation(events, room, roomRevision);
      return { outcome: "REVOKED" as const, events };
    });
    if (result.outcome === "NOT_FOUND") {
      throw new RoomError("INVITATION_NOT_FOUND");
    }
    if (result.outcome === "EXPIRED") {
      throw new RoomError("INVITATION_EXPIRED");
    }
    this.#publish(result.events);
  }

  public async acceptInvitation(input: AcceptInvitationInput): Promise<PublicRoom> {
    const actorUserId = parseRoomId(input.actorUserId);
    const invitationId = parseRoomId(input.invitationId);
    const changedAt = this.#now();
    let result:
      | { outcome: "ACCEPTED"; room: PublicRoom; events: ProductRealtimeEvent[] }
      | { outcome: "EXPIRED" }
      | { outcome: "NOT_FOUND" };
    try {
      result = await this.#db.transaction().execute(async (transaction) => {
        await this.#requireActiveUserInTransaction(transaction, actorUserId);
        const invitation = await transaction
          .selectFrom("roomInvitations")
          .innerJoin("rooms", "rooms.id", "roomInvitations.roomId")
          .select([
            "roomInvitations.id",
            "roomInvitations.status",
            "roomInvitations.expiresAt",
            "rooms.id as roomId",
          ])
          .where("roomInvitations.id", "=", invitationId)
          .where("roomInvitations.invitedUserId", "=", actorUserId)
          .where("rooms.deletedAt", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (invitation?.status !== "PENDING") {
          return { outcome: "NOT_FOUND" } as const;
        }
        if (invitation.expiresAt.getTime() <= changedAt.getTime()) {
          await transaction
            .updateTable("roomInvitations")
            .set({ status: "EXPIRED", updatedAt: changedAt })
            .where("id", "=", invitation.id)
            .execute();
          return { outcome: "EXPIRED" } as const;
        }
        const room = await this.#getActiveRoomForUpdate(transaction, invitation.roomId);
        const member = await this.#getRoomMemberSummary(
          transaction,
          actorUserId,
          "MEMBER",
          changedAt,
        );
        const owner = await this.#getNotificationActor(transaction, room.ownerUserId);
        const applicant = await this.#getNotificationActor(transaction, actorUserId);
        await transaction
          .insertInto("roomMemberships")
          .values({
            roomId: invitation.roomId,
            userId: actorUserId,
            role: "MEMBER",
            createdAt: changedAt,
          })
          .execute();
        await transaction
          .updateTable("roomInvitations")
          .set({ status: "ACCEPTED", updatedAt: changedAt })
          .where("id", "=", invitation.id)
          .execute();
        const pendingRequest = await transaction
          .selectFrom("roomJoinRequests")
          .select("id")
          .where("roomId", "=", room.id)
          .where("applicantUserId", "=", actorUserId)
          .where("status", "=", "PENDING")
          .forUpdate()
          .executeTakeFirst();
        if (pendingRequest !== undefined) {
          await transaction
            .updateTable("roomJoinRequests")
            .set({
              status: "APPROVED",
              decidedByUserId: room.ownerUserId,
              updatedAt: changedAt,
              decidedAt: changedAt,
            })
            .where("id", "=", pendingRequest.id)
            .where("status", "=", "PENDING")
            .executeTakeFirstOrThrow();
        }
        const roomRevision = await bumpRoomRevision(transaction, room.id, changedAt);
        const events: ProductRealtimeEvent[] = [
          this.#roomEvent(room.id, roomRevision, changedAt, {
            kind: "ROOM_MEMBER_JOINED",
            member,
          }),
        ];
        if (pendingRequest !== undefined) {
          await this.#stageNotification(transaction, events, {
            recipientUserId: actorUserId,
            type: "ROOM_JOIN_REQUEST_APPROVED",
            initiallyRead: true,
            context: notificationContext({
              actor: owner,
              room,
              requestId: pendingRequest.id,
              decision: "APPROVED",
            }),
          });
          await this.#stageNotification(transaction, events, {
            recipientUserId: room.ownerUserId,
            type: "ROOM_JOIN_REQUEST_APPROVED",
            context: notificationContext({
              actor: applicant,
              room,
              requestId: pendingRequest.id,
              decision: "APPROVED",
            }),
          });
        }
        this.#stagePublicInvalidation(events, room, roomRevision);
        return {
          outcome: "ACCEPTED",
          room: publicRoomFromState(room, "MEMBER", roomRevision, changedAt),
          events,
        } as const;
      });
    } catch (cause) {
      if (isConstraintViolation(cause, "room_memberships_primary")) {
        throw new RoomError("MEMBERSHIP_CONFLICT", { cause });
      }
      throw cause;
    }
    if (result.outcome === "NOT_FOUND") {
      throw new RoomError("INVITATION_NOT_FOUND");
    }
    if (result.outcome === "EXPIRED") {
      throw new RoomError("INVITATION_EXPIRED");
    }
    this.#publish(result.events);
    return result.room;
  }

  public async renameRoom(input: RenameRoomInput): Promise<PublicRoom> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const name = parseRoomName(input.name);
    return this.#updateRoomProduct({
      actorUserId,
      roomId,
      name,
    });
  }

  public async updateRoomAccess(input: UpdateRoomAccessInput): Promise<PublicRoom> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const visibility = parseRoomVisibility(input.visibility);
    const joinPolicy = parseRoomJoinPolicy(input.joinPolicy);
    assertValidRoomAccess(visibility, joinPolicy);
    return this.#updateRoomProduct({
      actorUserId,
      roomId,
      visibility,
      joinPolicy,
    });
  }

  public async updateRoom(input: UpdateRoomInput): Promise<PublicRoom> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const name = parseRoomName(input.name);
    const visibility = parseRoomVisibility(input.visibility);
    const joinPolicy = parseRoomJoinPolicy(input.joinPolicy);
    assertValidRoomAccess(visibility, joinPolicy);
    return this.#updateRoomProduct({
      actorUserId,
      roomId,
      name,
      visibility,
      joinPolicy,
    });
  }

  public async removeMember(input: MemberActionInput): Promise<void> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const memberUserId = parseRoomId(input.memberUserId);
    const changedAt = this.#now();
    const events = await this.#db.transaction().execute(async (transaction) => {
      await this.#requireActiveUserInTransaction(transaction, actorUserId);
      await this.#requireOwner(transaction, actorUserId, roomId);
      const room = await this.#getActiveRoomForUpdate(transaction, roomId);
      if (memberUserId === actorUserId) {
        throw new RoomError("OWNER_MUST_TRANSFER");
      }
      const membership = await transaction
        .selectFrom("roomMemberships")
        .select("role")
        .where("roomId", "=", roomId)
        .where("userId", "=", memberUserId)
        .forUpdate()
        .executeTakeFirst();
      if (membership === undefined) {
        throw new RoomError("INVALID_ROOM_TRANSITION");
      }
      if (membership.role === "OWNER") {
        throw new RoomError("OWNER_MUST_TRANSFER");
      }
      await transaction
        .deleteFrom("roomMemberships")
        .where("roomId", "=", roomId)
        .where("userId", "=", memberUserId)
        .execute();
      const roomRevision = await bumpRoomRevision(transaction, roomId, changedAt);
      const staged: ProductRealtimeEvent[] = [
        this.#roomEvent(roomId, roomRevision, changedAt, {
          kind: "ROOM_MEMBER_REMOVED",
          userId: memberUserId,
        }),
      ];
      await this.#stageNotification(transaction, staged, {
        recipientUserId: memberUserId,
        type: "ROOM_MEMBER_REMOVED",
        context: notificationContext({
          actor: await this.#getNotificationActor(transaction, actorUserId),
          room,
        }),
      });
      this.#stagePublicInvalidation(staged, room, roomRevision);
      return staged;
    });
    this.#publish(events);
  }

  public async leaveRoom(input: GetRoomInput): Promise<void> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const changedAt = this.#now();
    const events = await this.#db.transaction().execute(async (transaction) => {
      await this.#requireActiveUserInTransaction(transaction, actorUserId);
      const membership = await transaction
        .selectFrom("roomMemberships")
        .innerJoin("rooms", "rooms.id", "roomMemberships.roomId")
        .select([
          "roomMemberships.role",
          "rooms.id",
          "rooms.name",
          "rooms.ownerUserId",
          "rooms.roomEpoch",
          "rooms.visibility",
          "rooms.joinPolicy",
          "rooms.roomRevision",
          "rooms.createdAt",
          "rooms.updatedAt",
        ])
        .where("rooms.id", "=", roomId)
        .where("roomMemberships.userId", "=", actorUserId)
        .where("rooms.deletedAt", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (membership === undefined) {
        throw new RoomError("ROOM_NOT_FOUND");
      }
      if (membership.role === "OWNER") {
        throw new RoomError("OWNER_MUST_TRANSFER");
      }
      await transaction
        .deleteFrom("roomMemberships")
        .where("roomId", "=", roomId)
        .where("userId", "=", actorUserId)
        .execute();
      const roomRevision = await bumpRoomRevision(transaction, roomId, changedAt);
      const staged: ProductRealtimeEvent[] = [
        this.#roomEvent(roomId, roomRevision, changedAt, {
          kind: "ROOM_MEMBER_LEFT",
          userId: actorUserId,
        }),
      ];
      this.#stagePublicInvalidation(staged, membership, roomRevision);
      return staged;
    });
    this.#publish(events);
  }

  public async transferOwnership(input: TransferOwnershipInput): Promise<PublicRoom> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const newOwnerUserId = parseRoomId(input.newOwnerUserId);
    const changedAt = this.#now();
    const outcome = await this.#db.transaction().execute(async (transaction) => {
      const policy = await lockCapacityPolicy(transaction);
      await this.#requireActiveUserInTransaction(transaction, actorUserId);
      await this.#requireOwner(transaction, actorUserId, roomId);
      const before = await this.#getActiveRoomForUpdate(transaction, roomId);
      if (newOwnerUserId === actorUserId) {
        throw new RoomError("INVALID_ROOM_TRANSITION");
      }
      const target = await transaction
        .selectFrom("roomMemberships")
        .innerJoin("users", "users.id", "roomMemberships.userId")
        .select(["roomMemberships.role", "users.status"])
        .where("roomMemberships.roomId", "=", roomId)
        .where("roomMemberships.userId", "=", newOwnerUserId)
        .forUpdate()
        .executeTakeFirst();
      if (target?.role !== "MEMBER" || target.status !== "ACTIVE") {
        throw new RoomError("INVALID_ROOM_TRANSITION");
      }
      const currentQuotaClass = await classifyOwner(transaction, actorUserId);
      const targetCapacity = await this.#capacityDecision(transaction, newOwnerUserId, policy);
      if (currentQuotaClass === "EXEMPT" && targetCapacity.quotaClass === "ORDINARY") {
        const rejectionCode = await this.#capacityRejectionForOwnershipTransfer(transaction, {
          actor: {
            actorUserId,
            actorAdministratorId: null,
          },
          roomId,
          previousOwnerUserId: actorUserId,
          newOwnerUserId,
          capacity: targetCapacity,
          createdAt: changedAt,
        });
        if (rejectionCode !== null) {
          return rejectCapacity(rejectionCode);
        }
      }
      await transaction
        .updateTable("roomMemberships")
        .set({ role: "MEMBER" })
        .where("roomId", "=", roomId)
        .where("userId", "=", actorUserId)
        .where("role", "=", "OWNER")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("roomMemberships")
        .set({ role: "OWNER" })
        .where("roomId", "=", roomId)
        .where("userId", "=", newOwnerUserId)
        .where("role", "=", "MEMBER")
        .executeTakeFirstOrThrow();
      const room = await transaction
        .updateTable("rooms")
        .set((expression) => ({
          ownerUserId: newOwnerUserId,
          roomRevision: expression("roomRevision", "+", 1),
          updatedAt: changedAt,
        }))
        .where("id", "=", roomId)
        .where("ownerUserId", "=", actorUserId)
        .where("deletedAt", "is", null)
        .returning(roomProductStateColumns)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId,
          actorAdministratorId: null,
          eventType: "room.ownership_transferred",
          targetType: "room",
          targetId: room.id,
          details: {
            previousOwnerUserId: actorUserId,
            newOwnerUserId,
          },
          createdAt: changedAt,
        })
        .execute();
      const previousOwner = await this.#getNotificationActor(transaction, actorUserId);
      const newOwner = await this.#getNotificationActor(transaction, newOwnerUserId);
      const events: ProductRealtimeEvent[] = [
        this.#roomEvent(roomId, room.roomRevision, changedAt, {
          kind: "ROOM_OWNER_TRANSFERRED",
          previousOwnerUserId: actorUserId,
          newOwnerUserId,
        }),
      ];
      await this.#stageNotification(transaction, events, {
        recipientUserId: actorUserId,
        type: "ROOM_OWNERSHIP_TRANSFERRED",
        context: notificationContext({ actor: newOwner, room }),
      });
      await this.#stageNotification(transaction, events, {
        recipientUserId: newOwnerUserId,
        type: "ROOM_OWNERSHIP_TRANSFERRED",
        context: notificationContext({ actor: previousOwner, room }),
      });
      const pendingRequests = await transaction
        .selectFrom("roomJoinRequests")
        .innerJoin("users", "users.id", "roomJoinRequests.applicantUserId")
        .select(["roomJoinRequests.id", "roomJoinRequests.applicantUserId", "users.displayName"])
        .where("roomJoinRequests.roomId", "=", roomId)
        .where("roomJoinRequests.status", "=", "PENDING")
        .orderBy("roomJoinRequests.createdAt", "asc")
        .orderBy("roomJoinRequests.id", "asc")
        .execute();
      for (const request of pendingRequests) {
        await this.#stageNotification(transaction, events, {
          recipientUserId: newOwnerUserId,
          type: "ROOM_JOIN_REQUEST_CREATED",
          context: notificationContext({
            actor: {
              userId: request.applicantUserId,
              displayName: request.displayName,
            },
            room,
            requestId: request.id,
          }),
        });
      }
      this.#stagePublicInvalidation(events, before, room.roomRevision, room.visibility);
      return commitCapacity({
        value: publicRoomFromState(room, "OWNER"),
        events,
      });
    });
    const committed = unwrapCapacityOutcome(outcome);
    this.#publish(committed.events);
    return committed.value;
  }

  public async softDeleteRoom(input: GetRoomInput): Promise<void> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const deletedAt = this.#now();
    const events = await this.#db.transaction().execute(async (transaction) => {
      await lockCapacityPolicy(transaction);
      await this.#requireActiveUserInTransaction(transaction, actorUserId);
      await this.#requireOwner(transaction, actorUserId, roomId);
      const room = await this.#getActiveRoomForUpdate(transaction, roomId);
      const recipients = await transaction
        .selectFrom("roomMemberships")
        .select("userId")
        .where("roomId", "=", roomId)
        .where("userId", "!=", actorUserId)
        .orderBy("createdAt", "asc")
        .orderBy("userId", "asc")
        .execute();
      await transaction
        .updateTable("roomInvitations")
        .set({ status: "REVOKED", updatedAt: deletedAt })
        .where("roomId", "=", roomId)
        .where("status", "=", "PENDING")
        .execute();
      const deletedRoom = await transaction
        .updateTable("rooms")
        .set((expression) => ({
          deletedAt,
          roomEpoch: expression("roomEpoch", "+", 1),
          roomRevision: expression("roomRevision", "+", 1),
          updatedAt: deletedAt,
        }))
        .where("id", "=", roomId)
        .where("deletedAt", "is", null)
        .returning("roomRevision")
        .executeTakeFirstOrThrow();
      const staged: ProductRealtimeEvent[] = [
        this.#roomEvent(roomId, deletedRoom.roomRevision, deletedAt, {
          kind: "ROOM_DISSOLVED",
        }),
      ];
      const actor = await this.#getNotificationActor(transaction, actorUserId);
      for (const recipient of recipients) {
        await this.#stageNotification(transaction, staged, {
          recipientUserId: recipient.userId,
          type: "ROOM_DISSOLVED",
          context: notificationContext({ actor, room }),
        });
      }
      this.#stagePublicInvalidation(staged, room, deletedRoom.roomRevision);
      return staged;
    });
    this.#publish(events);
  }

  public async administratorSoftDeleteRoom(input: AdministratorRoomInput): Promise<void> {
    const administratorId = parseRoomId(input.administratorId);
    const roomId = parseRoomId(input.roomId);
    const reasonCode = parseAdministratorReasonCode(input.reasonCode);
    const deletedAt = this.#now();
    const events = await this.#db.transaction().execute(async (transaction) => {
      await lockCapacityPolicy(transaction);
      const administrator = await this.#requireAdministrator(transaction, administratorId);
      const room = await transaction
        .selectFrom("rooms")
        .select(roomProductStateColumns)
        .where("id", "=", roomId)
        .where("deletedAt", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (room === undefined) {
        throw new RoomError("ROOM_NOT_FOUND");
      }
      const recipients = await transaction
        .selectFrom("roomMemberships")
        .select("userId")
        .where("roomId", "=", room.id)
        .orderBy("createdAt", "asc")
        .orderBy("userId", "asc")
        .execute();
      await transaction
        .updateTable("roomInvitations")
        .set({ status: "REVOKED", updatedAt: deletedAt })
        .where("roomId", "=", room.id)
        .where("status", "=", "PENDING")
        .execute();
      const deletedRoom = await transaction
        .updateTable("rooms")
        .set((expression) => ({
          deletedAt,
          roomEpoch: expression("roomEpoch", "+", 1),
          roomRevision: expression("roomRevision", "+", 1),
          updatedAt: deletedAt,
        }))
        .where("id", "=", room.id)
        .where("deletedAt", "is", null)
        .returning("roomRevision")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: administrator.id,
          eventType: "administrator.room_soft_deleted",
          targetType: "room",
          targetId: room.id,
          details: {
            ownerUserId: room.ownerUserId,
            previousLifecycle: "ACTIVE",
            lifecycle: "DELETED",
            reasonCode,
          },
          createdAt: deletedAt,
        })
        .execute();
      const staged: ProductRealtimeEvent[] = [
        this.#roomEvent(room.id, deletedRoom.roomRevision, deletedAt, {
          kind: "ROOM_DISSOLVED",
        }),
      ];
      for (const recipient of recipients) {
        await this.#stageNotification(transaction, staged, {
          recipientUserId: recipient.userId,
          type: "ROOM_DISSOLVED",
          context: notificationContext({ actor: null, room }),
        });
      }
      this.#stagePublicInvalidation(staged, room, deletedRoom.roomRevision);
      return staged;
    });
    this.#publish(events);
  }

  public async administratorRestoreRoom(input: AdministratorRoomInput): Promise<void> {
    const administratorId = parseRoomId(input.administratorId);
    const roomId = parseRoomId(input.roomId);
    const reasonCode = parseAdministratorReasonCode(input.reasonCode);
    const restoredAt = this.#now();
    const outcome = await this.#db.transaction().execute(async (transaction) => {
      const policy = await lockCapacityPolicy(transaction);
      const administrator = await this.#requireAdministrator(transaction, administratorId);
      const room = await transaction
        .selectFrom("rooms")
        .select([...roomProductStateColumns, "deletedAt"])
        .where("id", "=", roomId)
        .forUpdate()
        .executeTakeFirst();
      if (room === undefined) {
        throw new RoomError("ROOM_NOT_FOUND");
      }
      if (room.deletedAt === null) {
        throw new RoomError("INVALID_ROOM_TRANSITION");
      }
      const capacity = await this.#capacityDecision(transaction, room.ownerUserId, policy);
      if (capacity.quotaClass === "ORDINARY") {
        const rejectionCode = await this.#capacityRejectionForRestore(transaction, {
          actor: {
            actorUserId: null,
            actorAdministratorId: administrator.id,
          },
          roomId: room.id,
          ownerUserId: room.ownerUserId,
          capacity,
          createdAt: restoredAt,
        });
        if (rejectionCode !== null) {
          return rejectCapacity(rejectionCode);
        }
      }
      const restoredRoom = await transaction
        .updateTable("rooms")
        .set((expression) => ({
          deletedAt: null,
          roomEpoch: expression("roomEpoch", "+", 1),
          roomRevision: expression("roomRevision", "+", 1),
          updatedAt: restoredAt,
        }))
        .where("id", "=", room.id)
        .where("deletedAt", "is not", null)
        .returning(roomProductStateColumns)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: administrator.id,
          eventType: "administrator.room_restored",
          targetType: "room",
          targetId: room.id,
          details: {
            ownerUserId: room.ownerUserId,
            previousLifecycle: "DELETED",
            lifecycle: "ACTIVE",
            reasonCode,
          },
          createdAt: restoredAt,
        })
        .execute();
      const events: ProductRealtimeEvent[] = [
        this.#roomUpdatedEvent(restoredRoom, restoredRoom.roomRevision, restoredAt),
      ];
      this.#stagePublicInvalidation(
        events,
        room,
        restoredRoom.roomRevision,
        restoredRoom.visibility,
      );
      return commitCapacity(events);
    });
    this.#publish(unwrapCapacityOutcome(outcome));
  }

  public async administratorTransferOwnership(
    input: AdministratorTransferOwnershipInput,
  ): Promise<PublicRoom> {
    const administratorId = parseRoomId(input.administratorId);
    const roomId = parseRoomId(input.roomId);
    const newOwnerUserId = parseRoomId(input.newOwnerUserId);
    const reasonCode = parseAdministratorReasonCode(input.reasonCode);
    const changedAt = this.#now();
    const outcome = await this.#db.transaction().execute(async (transaction) => {
      const policy = await lockCapacityPolicy(transaction);
      const administrator = await this.#requireAdministrator(transaction, administratorId);
      const room = await transaction
        .selectFrom("rooms")
        .select(roomProductStateColumns)
        .where("id", "=", roomId)
        .where("deletedAt", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (room === undefined) {
        throw new RoomError("ROOM_NOT_FOUND");
      }
      if (room.ownerUserId === newOwnerUserId) {
        throw new RoomError("INVALID_ROOM_TRANSITION");
      }
      const target = await transaction
        .selectFrom("roomMemberships")
        .innerJoin("users", "users.id", "roomMemberships.userId")
        .select(["roomMemberships.role", "users.status"])
        .where("roomMemberships.roomId", "=", room.id)
        .where("roomMemberships.userId", "=", newOwnerUserId)
        .forUpdate()
        .executeTakeFirst();
      if (target?.role !== "MEMBER" || target.status !== "ACTIVE") {
        throw new RoomError("INVALID_ROOM_TRANSITION");
      }
      const previousOwnerMembership = await transaction
        .selectFrom("roomMemberships")
        .select("role")
        .where("roomId", "=", room.id)
        .where("userId", "=", room.ownerUserId)
        .forUpdate()
        .executeTakeFirst();
      if (previousOwnerMembership?.role !== "OWNER") {
        throw new RoomError("INVALID_ROOM_TRANSITION");
      }
      const currentQuotaClass = await classifyOwner(transaction, room.ownerUserId);
      const targetCapacity = await this.#capacityDecision(transaction, newOwnerUserId, policy);
      if (currentQuotaClass === "EXEMPT" && targetCapacity.quotaClass === "ORDINARY") {
        const rejectionCode = await this.#capacityRejectionForOwnershipTransfer(transaction, {
          actor: {
            actorUserId: null,
            actorAdministratorId: administrator.id,
          },
          roomId: room.id,
          previousOwnerUserId: room.ownerUserId,
          newOwnerUserId,
          capacity: targetCapacity,
          createdAt: changedAt,
        });
        if (rejectionCode !== null) {
          return rejectCapacity(rejectionCode);
        }
      }
      await transaction
        .updateTable("roomMemberships")
        .set({ role: "MEMBER" })
        .where("roomId", "=", room.id)
        .where("userId", "=", room.ownerUserId)
        .execute();
      await transaction
        .updateTable("roomMemberships")
        .set({ role: "OWNER" })
        .where("roomId", "=", room.id)
        .where("userId", "=", newOwnerUserId)
        .execute();
      const updatedRoom = await transaction
        .updateTable("rooms")
        .set((expression) => ({
          ownerUserId: newOwnerUserId,
          roomRevision: expression("roomRevision", "+", 1),
          updatedAt: changedAt,
        }))
        .where("id", "=", room.id)
        .returning(roomProductStateColumns)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: administrator.id,
          eventType: "ADMIN_ROOM_OWNERSHIP_TRANSFERRED",
          targetType: "room",
          targetId: room.id,
          details: {
            previousOwnerUserId: room.ownerUserId,
            newOwnerUserId,
            reasonCode,
          },
          createdAt: changedAt,
        })
        .execute();
      const events: ProductRealtimeEvent[] = [
        this.#roomEvent(room.id, updatedRoom.roomRevision, changedAt, {
          kind: "ROOM_OWNER_TRANSFERRED",
          previousOwnerUserId: room.ownerUserId,
          newOwnerUserId,
        }),
      ];
      await this.#stageNotification(transaction, events, {
        recipientUserId: room.ownerUserId,
        type: "ROOM_OWNERSHIP_TRANSFERRED",
        context: notificationContext({ actor: null, room: updatedRoom }),
      });
      await this.#stageNotification(transaction, events, {
        recipientUserId: newOwnerUserId,
        type: "ROOM_OWNERSHIP_TRANSFERRED",
        context: notificationContext({ actor: null, room: updatedRoom }),
      });
      const pendingRequests = await transaction
        .selectFrom("roomJoinRequests")
        .innerJoin("users", "users.id", "roomJoinRequests.applicantUserId")
        .select(["roomJoinRequests.id", "roomJoinRequests.applicantUserId", "users.displayName"])
        .where("roomJoinRequests.roomId", "=", room.id)
        .where("roomJoinRequests.status", "=", "PENDING")
        .orderBy("roomJoinRequests.createdAt", "asc")
        .orderBy("roomJoinRequests.id", "asc")
        .execute();
      for (const request of pendingRequests) {
        await this.#stageNotification(transaction, events, {
          recipientUserId: newOwnerUserId,
          type: "ROOM_JOIN_REQUEST_CREATED",
          context: notificationContext({
            actor: {
              userId: request.applicantUserId,
              displayName: request.displayName,
            },
            room: updatedRoom,
            requestId: request.id,
          }),
        });
      }
      this.#stagePublicInvalidation(events, room, updatedRoom.roomRevision);
      return commitCapacity({
        value: publicRoomFromState(updatedRoom, "OWNER"),
        events,
      });
    });
    const committed = unwrapCapacityOutcome(outcome);
    this.#publish(committed.events);
    return committed.value;
  }

  async #updateRoomProduct(input: {
    actorUserId: string;
    roomId: string;
    name?: string;
    visibility?: RoomVisibility;
    joinPolicy?: RoomJoinPolicy;
  }): Promise<PublicRoom> {
    const changedAt = this.#now();
    const result = await this.#db.transaction().execute(async (transaction) => {
      await this.#requireActiveUserInTransaction(transaction, input.actorUserId);
      await this.#requireOwner(transaction, input.actorUserId, input.roomId);
      const before = await this.#getActiveRoomForUpdate(transaction, input.roomId);
      const name = input.name ?? before.name;
      const visibility = input.visibility ?? before.visibility;
      const joinPolicy = input.joinPolicy ?? before.joinPolicy;
      if (
        before.name === name &&
        before.visibility === visibility &&
        before.joinPolicy === joinPolicy
      ) {
        return {
          value: publicRoomFromState(before, "OWNER"),
          events: [] as ProductRealtimeEvent[],
        };
      }

      const cancelledRequests =
        before.visibility === "PUBLIC" && visibility === "PRIVATE"
          ? await transaction
              .selectFrom("roomJoinRequests")
              .innerJoin("users", "users.id", "roomJoinRequests.applicantUserId")
              .select([
                "roomJoinRequests.id",
                "roomJoinRequests.applicantUserId",
                "users.displayName",
              ])
              .where("roomJoinRequests.roomId", "=", input.roomId)
              .where("roomJoinRequests.status", "=", "PENDING")
              .orderBy("roomJoinRequests.createdAt", "asc")
              .orderBy("roomJoinRequests.id", "asc")
              .forUpdate()
              .execute()
          : [];
      if (cancelledRequests.length > 0) {
        await transaction
          .updateTable("roomJoinRequests")
          .set({
            status: "CANCELLED",
            decidedByUserId: input.actorUserId,
            updatedAt: changedAt,
            decidedAt: changedAt,
          })
          .where(
            "id",
            "in",
            cancelledRequests.map((request) => request.id),
          )
          .where("status", "=", "PENDING")
          .execute();
      }

      const room = await transaction
        .updateTable("rooms")
        .set((expression) => ({
          name,
          visibility,
          joinPolicy,
          roomRevision: expression("roomRevision", "+", 1),
          updatedAt: changedAt,
        }))
        .where("id", "=", input.roomId)
        .where("deletedAt", "is", null)
        .returning(roomProductStateColumns)
        .executeTakeFirstOrThrow();
      const owner = await this.#getNotificationActor(transaction, input.actorUserId);
      const events: ProductRealtimeEvent[] = [
        this.#roomUpdatedEvent(room, room.roomRevision, changedAt),
      ];
      for (const request of cancelledRequests) {
        const applicant = {
          userId: request.applicantUserId,
          displayName: request.displayName,
        };
        await this.#stageNotification(transaction, events, {
          recipientUserId: request.applicantUserId,
          type: "ROOM_JOIN_REQUEST_CANCELLED",
          context: notificationContext({
            actor: owner,
            room,
            requestId: request.id,
            decision: "CANCELLED",
          }),
        });
        await this.#stageNotification(transaction, events, {
          recipientUserId: input.actorUserId,
          type: "ROOM_JOIN_REQUEST_CANCELLED",
          initiallyRead: true,
          context: notificationContext({
            actor: applicant,
            room,
            requestId: request.id,
            decision: "CANCELLED",
          }),
        });
      }
      this.#stagePublicInvalidation(events, before, room.roomRevision, room.visibility);
      return { value: publicRoomFromState(room, "OWNER"), events };
    });
    this.#publish(result.events);
    return result.value;
  }

  async #getActiveRoomForUpdate(
    transaction: Transaction<Database>,
    roomId: string,
  ): Promise<RoomProductState> {
    const room = await transaction
      .selectFrom("rooms")
      .select(roomProductStateColumns)
      .where("id", "=", roomId)
      .where("deletedAt", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (room === undefined) {
      throw new RoomError("ROOM_NOT_FOUND");
    }
    return room;
  }

  async #getNotificationActor(
    transaction: Transaction<Database>,
    userId: string,
  ): Promise<NotificationActorSummary> {
    const user = await transaction
      .selectFrom("users")
      .select(["id as userId", "displayName"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (user === undefined) {
      throw new RoomError("INVALID_ROOM_TRANSITION");
    }
    return user;
  }

  async #getRoomMemberSummary(
    transaction: Transaction<Database>,
    userId: string,
    role: RoomRole,
    joinedAt: Date,
  ): Promise<{
    userId: string;
    username: string;
    displayName: string;
    role: RoomRole;
    joinedAt: string;
  }> {
    const user = await transaction
      .selectFrom("users")
      .select(["id as userId", "username", "displayName"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (user === undefined) {
      throw new RoomError("INVALID_ROOM_TRANSITION");
    }
    return {
      ...user,
      role,
      joinedAt: joinedAt.toISOString(),
    };
  }

  #roomEvent(
    roomId: string,
    roomRevision: number,
    occurredAt: Date,
    payload: Record<string, unknown>,
  ): ProductRealtimeEvent {
    return {
      type: "ROOM_EVENT",
      event: RoomEventMessageSchema.parse({
        type: "room.event",
        protocolVersion: 1,
        eventId: randomUUID(),
        roomId,
        roomRevision,
        occurredAt: occurredAt.toISOString(),
        ...payload,
      }),
    };
  }

  #roomUpdatedEvent(
    room: Pick<RoomProductState, "id" | "name" | "visibility" | "joinPolicy">,
    roomRevision: number,
    occurredAt: Date,
  ): ProductRealtimeEvent {
    return this.#roomEvent(room.id, roomRevision, occurredAt, {
      kind: "ROOM_UPDATED",
      name: room.name,
      visibility: room.visibility,
      joinPolicy: room.joinPolicy,
    });
  }

  async #stageNotification(
    transaction: Transaction<Database>,
    events: ProductRealtimeEvent[],
    input: {
      recipientUserId: string;
      type: NotificationType;
      context: unknown;
      initiallyRead?: boolean;
    },
  ): Promise<void> {
    const notification = await this.#notifications.createInTransaction(transaction, input);
    events.push({
      type: "NOTIFICATION_CREATED",
      recipientUserId: input.recipientUserId,
      notification,
    });
  }

  #stagePublicInvalidation(
    events: ProductRealtimeEvent[],
    before: Pick<RoomProductState, "id" | "visibility">,
    roomRevision: number,
    afterVisibility: RoomVisibility = before.visibility,
  ): void {
    if (before.visibility !== "PUBLIC" && afterVisibility !== "PUBLIC") {
      return;
    }
    events.push({
      type: "PUBLIC_ROOMS_INVALIDATED",
      message: PublicRoomsInvalidatedSchema.parse({
        type: "public-rooms.invalidated",
        roomId: before.id,
        reason: "ROOM",
        roomRevision,
      }),
    });
  }

  #publish(events: readonly ProductRealtimeEvent[]): void {
    for (const event of events) {
      this.#events.publish(event);
    }
  }

  async #capacityDecision(
    transaction: Transaction<Database>,
    ownerUserId: string,
    policy: Awaited<ReturnType<typeof lockCapacityPolicy>>,
  ): Promise<CapacityDecision> {
    return {
      quotaClass: await classifyOwner(transaction, ownerUserId),
      ordinaryActiveRoomLimit: policy.ordinaryActiveRoomLimit,
      ordinaryOpenTabLimit: policy.ordinaryOpenTabLimit,
    };
  }

  async #countActiveOrdinaryRooms(transaction: Transaction<Database>): Promise<number> {
    const linkedAdministrator = await transaction
      .selectFrom("administrators")
      .select("linkedUserId")
      .where("linkedUserId", "is not", null)
      .executeTakeFirst();
    const activeRooms = transaction
      .selectFrom("rooms")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("deletedAt", "is", null);
    const result =
      linkedAdministrator?.linkedUserId === undefined
        ? await activeRooms.executeTakeFirstOrThrow()
        : await activeRooms
            .where("ownerUserId", "!=", linkedAdministrator.linkedUserId)
            .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async #countOpenRoomTabs(transaction: Transaction<Database>, roomId: string): Promise<number> {
    const result = await transaction
      .selectFrom("roomTabs")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .where("closedAtSeq", "is", null)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async #capacityRejectionForOwnershipTransfer(
    transaction: Transaction<Database>,
    input: OwnershipTransferCapacityCheck,
  ): Promise<CapacityRejectionCode | null> {
    const activeOrdinaryRoomCount = await this.#countActiveOrdinaryRooms(transaction);
    if (activeOrdinaryRoomCount >= input.capacity.ordinaryActiveRoomLimit) {
      await this.#auditCapacityRejection(transaction, {
        actor: input.actor,
        eventType: "room.ownership_transfer_capacity_rejected",
        targetId: input.roomId,
        details: {
          previousOwnerUserId: input.previousOwnerUserId,
          newOwnerUserId: input.newOwnerUserId,
          quotaClass: "ORDINARY",
          reasonCode: "ORDINARY_ROOM_LIMIT_REACHED",
          activeOrdinaryRoomCount,
          ordinaryActiveRoomLimit: input.capacity.ordinaryActiveRoomLimit,
        },
        createdAt: input.createdAt,
      });
      return "ORDINARY_ROOM_LIMIT_REACHED";
    }
    const openTabCount = await this.#countOpenRoomTabs(transaction, input.roomId);
    if (openTabCount > input.capacity.ordinaryOpenTabLimit) {
      await this.#auditCapacityRejection(transaction, {
        actor: input.actor,
        eventType: "room.ownership_transfer_capacity_rejected",
        targetId: input.roomId,
        details: {
          previousOwnerUserId: input.previousOwnerUserId,
          newOwnerUserId: input.newOwnerUserId,
          quotaClass: "ORDINARY",
          reasonCode: "ROOM_TAB_LIMIT_REACHED",
          openTabCount,
          ordinaryOpenTabLimit: input.capacity.ordinaryOpenTabLimit,
        },
        createdAt: input.createdAt,
      });
      return "ROOM_TAB_LIMIT_REACHED";
    }
    return null;
  }

  async #capacityRejectionForRestore(
    transaction: Transaction<Database>,
    input: RestoreCapacityCheck,
  ): Promise<CapacityRejectionCode | null> {
    const activeOrdinaryRoomCount = await this.#countActiveOrdinaryRooms(transaction);
    if (activeOrdinaryRoomCount >= input.capacity.ordinaryActiveRoomLimit) {
      await this.#auditCapacityRejection(transaction, {
        actor: input.actor,
        eventType: "room.restore_capacity_rejected",
        targetId: input.roomId,
        details: {
          ownerUserId: input.ownerUserId,
          quotaClass: "ORDINARY",
          reasonCode: "ORDINARY_ROOM_LIMIT_REACHED",
          activeOrdinaryRoomCount,
          ordinaryActiveRoomLimit: input.capacity.ordinaryActiveRoomLimit,
        },
        createdAt: input.createdAt,
      });
      return "ORDINARY_ROOM_LIMIT_REACHED";
    }
    const openTabCount = await this.#countOpenRoomTabs(transaction, input.roomId);
    if (openTabCount > input.capacity.ordinaryOpenTabLimit) {
      await this.#auditCapacityRejection(transaction, {
        actor: input.actor,
        eventType: "room.restore_capacity_rejected",
        targetId: input.roomId,
        details: {
          ownerUserId: input.ownerUserId,
          quotaClass: "ORDINARY",
          reasonCode: "ROOM_TAB_LIMIT_REACHED",
          openTabCount,
          ordinaryOpenTabLimit: input.capacity.ordinaryOpenTabLimit,
        },
        createdAt: input.createdAt,
      });
      return "ROOM_TAB_LIMIT_REACHED";
    }
    return null;
  }

  async #auditCapacityRejection(
    transaction: Transaction<Database>,
    input: CapacityAuditInput,
  ): Promise<void> {
    await transaction
      .insertInto("auditEvents")
      .values({
        actorUserId: input.actor.actorUserId,
        actorAdministratorId: input.actor.actorAdministratorId,
        eventType: input.eventType,
        targetType: "room",
        targetId: input.targetId,
        details: input.details,
        createdAt: input.createdAt,
      })
      .execute();
  }

  async #requireAdministrator(
    transaction: Transaction<Database>,
    administratorId: string,
  ): Promise<{ id: string }> {
    const administrator = await transaction
      .selectFrom("administrators")
      .select("id")
      .where("id", "=", administratorId)
      .forUpdate()
      .executeTakeFirst();
    if (administrator === undefined) {
      throw new RoomError("INVALID_ROOM_TRANSITION");
    }
    return administrator;
  }

  async #requireActiveUser(userId: string): Promise<void> {
    const user = await this.#db
      .selectFrom("users")
      .select("status")
      .where("id", "=", userId)
      .executeTakeFirst();
    if (user?.status !== "ACTIVE") {
      throw new RoomError("INVALID_ROOM_TRANSITION");
    }
  }

  async #requireActiveUserInTransaction(
    transaction: Transaction<Database>,
    userId: string,
  ): Promise<void> {
    const user = await transaction
      .selectFrom("users")
      .select("status")
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirst();
    if (user?.status !== "ACTIVE") {
      throw new RoomError("INVALID_ROOM_TRANSITION");
    }
  }

  async #requireOwner(
    transaction: Transaction<Database>,
    actorUserId: string,
    roomId: string,
  ): Promise<void> {
    const membership = await transaction
      .selectFrom("roomMemberships")
      .innerJoin("rooms", "rooms.id", "roomMemberships.roomId")
      .select("roomMemberships.role")
      .where("rooms.id", "=", roomId)
      .where("roomMemberships.userId", "=", actorUserId)
      .where("rooms.deletedAt", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (membership === undefined) {
      throw new RoomError("ROOM_NOT_FOUND");
    }
    if (membership.role !== "OWNER") {
      throw new RoomError("ROOM_OWNER_REQUIRED");
    }
  }
}

interface DatabaseError {
  code?: unknown;
  constraint?: unknown;
}

function isConstraintViolation(cause: unknown, constraint: string): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  const error = cause as DatabaseError;
  return error.code === "23505" && error.constraint === constraint;
}
