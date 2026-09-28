import { randomUUID } from "node:crypto";
import type { createDatabase, Database } from "@syncaction/database";
import {
  CanonicalUuidSchema,
  DirectoryUserSchema,
  PublicRoomsInvalidatedSchema,
  PublicRoomSummarySchema,
  RoomEventMessageSchema,
  RoomJoinDecisionInputSchema,
  RoomJoinRequestSchema,
  type DirectoryUser,
  type NotificationActorSummary,
  type NotificationType,
  type PublicRoomSummary,
  type RoomJoinRequest,
} from "@syncaction/protocol";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { RoomError } from "./errors.js";
import { NotificationService } from "./notification-service.js";
import { parseRoomId } from "./policy.js";
import {
  NULL_ROOM_PRODUCT_EVENT_SINK,
  type ProductRealtimeEvent,
  type RoomProductEventSink,
} from "./room-product-events.js";
import type { GetRoomInput, PublicRoom } from "./room-service.js";

type DiscoveryDatabase = ReturnType<typeof createDatabase>;
type RoomState = {
  id: string;
  name: string;
  ownerUserId: string;
  roomEpoch: number;
  visibility: "PRIVATE" | "PUBLIC";
  joinPolicy: "OPEN" | "APPROVAL" | "INVITE_ONLY";
  roomRevision: number;
  createdAt: Date;
  updatedAt: Date;
};
type BatchInvitationStatus =
  "CREATED" | "ALREADY_MEMBER" | "ALREADY_PENDING" | "NOT_FOUND" | "FORBIDDEN";

export interface BatchInvitationResult {
  userId: string;
  status: BatchInvitationStatus;
  invitationId: string | null;
}

export interface RoomDiscoveryServiceOptions {
  db: DiscoveryDatabase;
  notifications?: NotificationService;
  events?: RoomProductEventSink;
  onlineUserIdsForRoom?: (roomId: string) => ReadonlySet<string>;
  onlineUserIds?: () => ReadonlySet<string>;
  hasActivePlayback?: (roomId: string) => boolean;
  now?: () => Date;
}

const LimitSchema = z.number().int().min(1).max(50).safe();
const PublicCursorSchema = z.tuple([z.string().datetime({ offset: true }), CanonicalUuidSchema]);
const DirectoryCursorSchema = z.tuple([
  z.union([z.literal(0), z.literal(1)]),
  z.string().datetime({ offset: true }),
  CanonicalUuidSchema,
]);
const BatchUserIdsSchema = z
  .array(CanonicalUuidSchema)
  .min(1)
  .max(20)
  .superRefine((userIds, context) => {
    if (new Set(userIds).size !== userIds.length) {
      context.addIssue({
        code: "custom",
        message: "batch user ids must be unique",
      });
    }
  });
const roomStateColumns = [
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

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RoomError("INVALID_ROOM_INPUT", { cause: result.error });
  }
  return result.data;
}

function parseQuery(input: unknown): string {
  if (typeof input !== "string") {
    throw new RoomError("INVALID_ROOM_INPUT");
  }
  const normalized = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (Array.from(normalized).length > 100) {
    throw new RoomError("INVALID_ROOM_INPUT");
  }
  return normalized;
}

function parseCursor<T>(input: unknown, schema: z.ZodType<T>): T | null {
  if (input === null) {
    return null;
  }
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 1_024 ||
    !/^[A-Za-z0-9_-]+$/u.test(input)
  ) {
    throw new RoomError("INVALID_ROOM_INPUT");
  }
  try {
    const decoded = Buffer.from(input, "base64url");
    if (decoded.toString("base64url") !== input) {
      throw new Error("non-canonical cursor");
    }
    return parseInput(schema, JSON.parse(decoded.toString("utf8")));
  } catch (cause) {
    if (cause instanceof RoomError) {
      throw cause;
    }
    throw new RoomError("INVALID_ROOM_INPUT", { cause });
  }
}

function encodeCursor(tuple: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(tuple), "utf8").toString("base64url");
}

function publicRoom(room: RoomState, role: "OWNER" | "MEMBER"): PublicRoom {
  return {
    id: room.id,
    name: room.name,
    role,
    roomEpoch: room.roomEpoch,
    visibility: room.visibility,
    joinPolicy: room.joinPolicy,
    roomRevision: room.roomRevision,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function notificationContext(input: {
  actor?: NotificationActorSummary | null;
  room: Pick<RoomState, "id" | "name">;
  requestId?: string | null;
  invitationId?: string | null;
  decision?: "APPROVED" | "REJECTED" | "CANCELLED" | null;
}): Record<string, unknown> {
  return {
    actor:
      input.actor === undefined || input.actor === null
        ? null
        : {
            userId: input.actor.userId,
            displayName: input.actor.displayName,
          },
    room: { roomId: input.room.id, name: input.room.name },
    requestId: input.requestId ?? null,
    invitationId: input.invitationId ?? null,
    decision: input.decision ?? null,
    title: null,
    body: null,
    version: null,
  };
}

function isConstraintViolation(cause: unknown, constraint: string): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  const candidate = cause as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === constraint;
}

export class RoomDiscoveryService {
  readonly #db: DiscoveryDatabase;
  readonly #notifications: NotificationService;
  readonly #events: RoomProductEventSink;
  readonly #onlineUserIdsForRoom: (roomId: string) => ReadonlySet<string>;
  readonly #onlineUserIds: () => ReadonlySet<string>;
  readonly #hasActivePlayback: (roomId: string) => boolean;
  readonly #now: () => Date;

  public constructor(options: RoomDiscoveryServiceOptions) {
    this.#db = options.db;
    this.#events = options.events ?? NULL_ROOM_PRODUCT_EVENT_SINK;
    this.#now = options.now ?? (() => new Date());
    this.#notifications =
      options.notifications ?? new NotificationService({ db: options.db, now: this.#now });
    this.#onlineUserIdsForRoom = options.onlineUserIdsForRoom ?? (() => new Set());
    this.#onlineUserIds = options.onlineUserIds ?? (() => new Set());
    this.#hasActivePlayback = options.hasActivePlayback ?? (() => false);
  }

  public async listPublicRooms(input: {
    query: unknown;
    cursor: unknown;
    limit: unknown;
  }): Promise<{ items: PublicRoomSummary[]; nextCursor: string | null }> {
    const query = parseQuery(input.query).toLocaleLowerCase("en-US");
    const cursor = parseCursor(input.cursor, PublicCursorSchema);
    const limit = parseInput(LimitSchema, input.limit);
    let statement = this.#db
      .selectFrom("rooms")
      .leftJoin("roomMemberships", "roomMemberships.roomId", "rooms.id")
      .leftJoin("roomTabs", (join) =>
        join.onRef("roomTabs.roomId", "=", "rooms.id").on("roomTabs.closedAtSeq", "is", null),
      )
      .select(["rooms.id as roomId", "rooms.name", "rooms.joinPolicy", "rooms.updatedAt"])
      .select((expression) => [
        expression.fn.count("roomMemberships.userId").distinct().as("memberCount"),
        expression.fn.count("roomTabs.logicalTabId").distinct().as("openTabCount"),
      ])
      .where("rooms.visibility", "=", "PUBLIC")
      .where("rooms.deletedAt", "is", null)
      .groupBy(["rooms.id", "rooms.name", "rooms.joinPolicy", "rooms.updatedAt"]);
    if (query.length > 0) {
      statement = statement.where(
        sql<boolean>`position(${query} in lower(${sql.ref("rooms.name")})) > 0`,
      );
    }
    if (cursor !== null) {
      const [updatedAt, roomId] = cursor;
      statement = statement.where((expression) =>
        expression.or([
          expression("rooms.updatedAt", "<", new Date(updatedAt)),
          expression.and([
            expression("rooms.updatedAt", "=", new Date(updatedAt)),
            expression("rooms.id", "<", roomId),
          ]),
        ]),
      );
    }
    const rows = await statement
      .orderBy("rooms.updatedAt", "desc")
      .orderBy("rooms.id", "desc")
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const items = visibleRows.map((row) => {
      const memberCount = Number(row.memberCount);
      return PublicRoomSummarySchema.parse({
        roomId: row.roomId,
        name: row.name,
        joinPolicy: row.joinPolicy,
        onlineCount: Math.min(this.#safeOnlineRoomIds(row.roomId).size, memberCount),
        memberCount,
        openTabCount: Number(row.openTabCount),
        hasActivePlayback: this.#hasActivePlayback(row.roomId),
        updatedAt: row.updatedAt.toISOString(),
      });
    });
    const last = visibleRows.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor([last.updatedAt.toISOString(), last.roomId])
          : null,
    };
  }

  public async searchUsers(input: {
    actorUserId: unknown;
    roomId: unknown;
    query: unknown;
    cursor: unknown;
    limit: unknown;
  }): Promise<{ items: DirectoryUser[]; nextCursor: string | null }> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const query = parseQuery(input.query).toLocaleLowerCase("en-US");
    const cursor = parseCursor(input.cursor, DirectoryCursorSchema);
    const limit = parseInput(LimitSchema, input.limit);
    await this.#requireOwnerForRead(actorUserId, roomId);
    const onlineIds = [...this.#safeOnlineUserIds()];

    let candidates = this.#db
      .selectFrom("users")
      .leftJoin("deviceSessions", "deviceSessions.userId", "users.id")
      .select(["users.id as userId", "users.username", "users.displayName", "users.updatedAt"])
      .select(
        sql<Date>`greatest(
          coalesce(max(${sql.ref("deviceSessions.usedAt")}), ${sql.ref("users.updatedAt")}),
          ${sql.ref("users.updatedAt")}
        )`.as("activityAt"),
      )
      .where("users.status", "=", "ACTIVE")
      .where("users.id", "!=", actorUserId)
      .where((expression) =>
        expression.not(
          expression.exists(
            expression
              .selectFrom("roomMemberships")
              .select("roomMemberships.userId")
              .where("roomMemberships.roomId", "=", roomId)
              .whereRef("roomMemberships.userId", "=", "users.id"),
          ),
        ),
      )
      .where((expression) =>
        expression.not(
          expression.exists(
            expression
              .selectFrom("roomInvitations")
              .select("roomInvitations.invitedUserId")
              .where("roomInvitations.roomId", "=", roomId)
              .whereRef("roomInvitations.invitedUserId", "=", "users.id")
              .where("roomInvitations.status", "=", "PENDING")
              .where("roomInvitations.expiresAt", ">", this.#now()),
          ),
        ),
      )
      .groupBy(["users.id", "users.username", "users.displayName", "users.updatedAt"]);
    if (query.length > 0) {
      candidates = candidates.where(
        sql<boolean>`position(${query} in ${sql.ref(
          "users.usernameNormalized",
        )}) > 0 or position(${query} in lower(${sql.ref("users.displayName")})) > 0`,
      );
    }
    const candidateSubquery = candidates.as("candidate");
    const rankedSubquery = this.#db
      .selectFrom(candidateSubquery)
      .selectAll()
      .select((expression) =>
        (onlineIds.length === 0
          ? expression.val(0)
          : expression
              .case()
              .when(sql<boolean>`${sql.ref("candidate.userId")} = any(${onlineIds}::uuid[])`)
              .then(1)
              .else(0)
              .end()
        ).as("onlineRank"),
      )
      .as("ranked");
    let statement = this.#db.selectFrom(rankedSubquery).selectAll();
    if (cursor !== null) {
      const [onlineRank, activityAt, userId] = cursor;
      const activityDate = new Date(activityAt);
      statement = statement.where((expression) =>
        expression.or([
          expression("ranked.onlineRank", "<", onlineRank),
          expression.and([
            expression("ranked.onlineRank", "=", onlineRank),
            expression("ranked.activityAt", "<", activityDate),
          ]),
          expression.and([
            expression("ranked.onlineRank", "=", onlineRank),
            expression("ranked.activityAt", "=", activityDate),
            expression("ranked.userId", "<", userId),
          ]),
        ]),
      );
    }
    const rows = await statement
      .orderBy("ranked.onlineRank", "desc")
      .orderBy("ranked.activityAt", "desc")
      .orderBy("ranked.userId", "desc")
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const items = visibleRows.map((row) =>
      DirectoryUserSchema.parse({
        userId: row.userId,
        username: row.username,
        displayName: row.displayName,
        online: row.onlineRank === 1,
      }),
    );
    const last = visibleRows.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor([last.onlineRank, (last.activityAt as Date).toISOString(), last.userId])
          : null,
    };
  }

  public async joinOpen(input: GetRoomInput): Promise<PublicRoom> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const changedAt = this.#now();
    try {
      const committed = await this.#db.transaction().execute(async (transaction) => {
        const applicant = await this.#getActiveUserForUpdate(transaction, actorUserId);
        const room = await this.#getRoomForJoin(transaction, roomId, "OPEN");
        await this.#requireNoMembership(transaction, roomId, actorUserId);
        await transaction
          .insertInto("roomMemberships")
          .values({
            roomId,
            userId: actorUserId,
            role: "MEMBER",
            createdAt: changedAt,
          })
          .execute();
        const pendingRequest = await transaction
          .selectFrom("roomJoinRequests")
          .select("id")
          .where("roomId", "=", roomId)
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
        await transaction
          .updateTable("roomInvitations")
          .set({ status: "REVOKED", updatedAt: changedAt })
          .where("roomId", "=", roomId)
          .where("invitedUserId", "=", actorUserId)
          .where("status", "=", "PENDING")
          .execute();
        const updatedRoom = await this.#bumpRoomRevision(transaction, roomId, changedAt);
        const events: ProductRealtimeEvent[] = [
          this.#memberJoinedEvent(updatedRoom, applicant, changedAt),
        ];
        if (pendingRequest !== undefined) {
          await this.#stageRequestResultPair(transaction, events, {
            room: updatedRoom,
            requestId: pendingRequest.id,
            applicant,
            owner: await this.#getActor(transaction, room.ownerUserId),
            type: "ROOM_JOIN_REQUEST_APPROVED",
            decision: "APPROVED",
            applicantInitiallyRead: true,
            ownerInitiallyRead: false,
          });
        }
        this.#stagePublicInvalidation(events, updatedRoom);
        return { value: publicRoom(updatedRoom, "MEMBER"), events };
      });
      this.#publish(committed.events);
      return committed.value;
    } catch (cause) {
      if (isConstraintViolation(cause, "room_memberships_primary")) {
        throw new RoomError("MEMBERSHIP_CONFLICT", { cause });
      }
      throw cause;
    }
  }

  public async requestJoin(input: GetRoomInput): Promise<RoomJoinRequest> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const createdAt = this.#now();
    try {
      const committed = await this.#db.transaction().execute(async (transaction) => {
        const applicant = await this.#getActiveUserForUpdate(transaction, actorUserId);
        const room = await this.#getRoomForJoin(transaction, roomId, "APPROVAL");
        await this.#requireNoMembership(transaction, roomId, actorUserId);
        const request = await transaction
          .insertInto("roomJoinRequests")
          .values({
            id: randomUUID(),
            roomId,
            applicantUserId: actorUserId,
            status: "PENDING",
            decidedByUserId: null,
            decisionClientOpId: null,
            createdAt,
            updatedAt: createdAt,
            decidedAt: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const events: ProductRealtimeEvent[] = [];
        await this.#stageNotification(transaction, events, {
          recipientUserId: room.ownerUserId,
          type: "ROOM_JOIN_REQUEST_CREATED",
          context: notificationContext({
            actor: applicant,
            room,
            requestId: request.id,
          }),
        });
        return {
          value: this.#requestFromRow(request, applicant),
          events,
        };
      });
      this.#publish(committed.events);
      return committed.value;
    } catch (cause) {
      if (isConstraintViolation(cause, "room_join_requests_single_pending_index")) {
        throw new RoomError("JOIN_REQUEST_CONFLICT", { cause });
      }
      throw cause;
    }
  }

  public async cancelJoinRequest(input: {
    actorUserId: unknown;
    requestId: unknown;
  }): Promise<void> {
    const actorUserId = parseRoomId(input.actorUserId);
    const requestId = parseRoomId(input.requestId);
    const changedAt = this.#now();
    const events = await this.#db.transaction().execute(async (transaction) => {
      await this.#getActiveUserForUpdate(transaction, actorUserId);
      const request = await transaction
        .selectFrom("roomJoinRequests")
        .innerJoin("rooms", "rooms.id", "roomJoinRequests.roomId")
        .select([
          "roomJoinRequests.id",
          "roomJoinRequests.status",
          "rooms.id as roomId",
          "rooms.name",
          "rooms.ownerUserId",
          "rooms.roomEpoch",
          "rooms.visibility",
          "rooms.joinPolicy",
          "rooms.roomRevision",
          "rooms.createdAt",
          "rooms.updatedAt",
        ])
        .where("roomJoinRequests.id", "=", requestId)
        .where("roomJoinRequests.applicantUserId", "=", actorUserId)
        .where("rooms.deletedAt", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (request === undefined) {
        throw new RoomError("JOIN_REQUEST_NOT_FOUND");
      }
      if (request.status === "CANCELLED") {
        return [] as ProductRealtimeEvent[];
      }
      if (request.status !== "PENDING") {
        throw new RoomError("JOIN_REQUEST_CONFLICT");
      }
      await transaction
        .updateTable("roomJoinRequests")
        .set({
          status: "CANCELLED",
          decidedByUserId: actorUserId,
          updatedAt: changedAt,
          decidedAt: changedAt,
        })
        .where("id", "=", request.id)
        .where("status", "=", "PENDING")
        .executeTakeFirstOrThrow();
      const room = roomStateFromJoinedRequest(request);
      const applicant = await this.#getActor(transaction, actorUserId);
      const staged: ProductRealtimeEvent[] = [];
      await this.#stageRequestResultPair(transaction, staged, {
        room,
        requestId,
        applicant,
        owner: await this.#getActor(transaction, room.ownerUserId),
        type: "ROOM_JOIN_REQUEST_CANCELLED",
        decision: "CANCELLED",
        applicantInitiallyRead: true,
        ownerInitiallyRead: false,
      });
      return staged;
    });
    this.#publish(events);
  }

  public async decideJoinRequest(input: {
    actorUserId: unknown;
    requestId: unknown;
    decision: unknown;
    clientOpId: unknown;
  }): Promise<RoomJoinRequest> {
    const actorUserId = parseRoomId(input.actorUserId);
    const requestId = parseRoomId(input.requestId);
    const decisionInput = parseInput(RoomJoinDecisionInputSchema, {
      decision: input.decision,
      clientOpId: input.clientOpId,
    });
    const finalStatus = decisionInput.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const notificationType =
      decisionInput.decision === "APPROVE"
        ? "ROOM_JOIN_REQUEST_APPROVED"
        : "ROOM_JOIN_REQUEST_REJECTED";
    const changedAt = this.#now();
    try {
      const committed = await this.#db.transaction().execute(async (transaction) => {
        await this.#getActiveUserForUpdate(transaction, actorUserId);
        const locked = await transaction
          .selectFrom("roomJoinRequests")
          .innerJoin("rooms", "rooms.id", "roomJoinRequests.roomId")
          .innerJoin("users as applicants", "applicants.id", "roomJoinRequests.applicantUserId")
          .select([
            "roomJoinRequests.id",
            "roomJoinRequests.applicantUserId",
            "roomJoinRequests.status",
            "roomJoinRequests.decisionClientOpId",
            "roomJoinRequests.createdAt as requestCreatedAt",
            "roomJoinRequests.decidedAt",
            "rooms.id as roomId",
            "rooms.name",
            "rooms.ownerUserId",
            "rooms.roomEpoch",
            "rooms.visibility",
            "rooms.joinPolicy",
            "rooms.roomRevision",
            "rooms.createdAt",
            "rooms.updatedAt",
            "applicants.username",
            "applicants.displayName",
            "applicants.status as applicantStatus",
          ])
          .where("roomJoinRequests.id", "=", requestId)
          .where("rooms.deletedAt", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (locked === undefined || locked.ownerUserId !== actorUserId) {
          throw new RoomError("JOIN_REQUEST_NOT_FOUND");
        }
        await this.#requireOwnerMembership(transaction, actorUserId, locked.roomId);
        const existingRequest = requestFromJoinedRow(locked);
        if (locked.status !== "PENDING") {
          if (locked.status === finalStatus) {
            return {
              value: existingRequest,
              events: [] as ProductRealtimeEvent[],
            };
          }
          throw new RoomError("JOIN_REQUEST_CONFLICT");
        }
        if (locked.applicantStatus !== "ACTIVE") {
          throw new RoomError("INVALID_ROOM_TRANSITION");
        }
        const room = roomStateFromJoinedRequest(locked);
        const applicant = {
          userId: locked.applicantUserId,
          username: locked.username,
          displayName: locked.displayName,
        };
        if (decisionInput.decision === "APPROVE") {
          await this.#requireNoMembership(transaction, locked.roomId, locked.applicantUserId);
          await transaction
            .insertInto("roomMemberships")
            .values({
              roomId: locked.roomId,
              userId: locked.applicantUserId,
              role: "MEMBER",
              createdAt: changedAt,
            })
            .execute();
          await transaction
            .updateTable("roomInvitations")
            .set({ status: "REVOKED", updatedAt: changedAt })
            .where("roomId", "=", locked.roomId)
            .where("invitedUserId", "=", locked.applicantUserId)
            .where("status", "=", "PENDING")
            .execute();
        }
        const updatedRequest = await transaction
          .updateTable("roomJoinRequests")
          .set({
            status: finalStatus,
            decidedByUserId: actorUserId,
            decisionClientOpId: decisionInput.clientOpId,
            updatedAt: changedAt,
            decidedAt: changedAt,
          })
          .where("id", "=", requestId)
          .where("status", "=", "PENDING")
          .returningAll()
          .executeTakeFirstOrThrow();
        const events: ProductRealtimeEvent[] = [];
        let resultRoom = room;
        if (decisionInput.decision === "APPROVE") {
          resultRoom = await this.#bumpRoomRevision(transaction, room.id, changedAt);
          events.push(this.#memberJoinedEvent(resultRoom, applicant, changedAt));
        }
        await this.#stageRequestResultPair(transaction, events, {
          room: resultRoom,
          requestId,
          applicant,
          owner: await this.#getActor(transaction, actorUserId),
          type: notificationType,
          decision: finalStatus,
          applicantInitiallyRead: false,
          ownerInitiallyRead: true,
        });
        if (decisionInput.decision === "APPROVE") {
          this.#stagePublicInvalidation(events, resultRoom);
        }
        return {
          value: this.#requestFromRow(updatedRequest, applicant),
          events,
        };
      });
      this.#publish(committed.events);
      return committed.value;
    } catch (cause) {
      if (
        isConstraintViolation(cause, "room_join_requests_decision_client_op_index") ||
        isConstraintViolation(cause, "room_memberships_primary")
      ) {
        throw new RoomError("JOIN_REQUEST_CONFLICT", { cause });
      }
      throw cause;
    }
  }

  public async batchInvite(input: {
    actorUserId: unknown;
    roomId: unknown;
    userIds: unknown;
  }): Promise<BatchInvitationResult[]> {
    const actorUserId = parseRoomId(input.actorUserId);
    const roomId = parseRoomId(input.roomId);
    const userIds = parseInput(BatchUserIdsSchema, input.userIds);
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
    const committed = await this.#db.transaction().execute(async (transaction) => {
      await this.#getOwnedRoomForUpdate(transaction, actorUserId, roomId);
      const actor = await this.#getActor(transaction, actorUserId);
      await transaction
        .updateTable("roomInvitations")
        .set({ status: "EXPIRED", updatedAt: createdAt })
        .where("roomId", "=", roomId)
        .where("status", "=", "PENDING")
        .where("expiresAt", "<=", createdAt)
        .execute();
      const users = await transaction
        .selectFrom("users")
        .select(["id", "status"])
        .where("id", "in", userIds)
        .orderBy("id", "asc")
        .forUpdate()
        .execute();
      const usersById = new Map(users.map((user) => [user.id, user]));
      const memberships = await transaction
        .selectFrom("roomMemberships")
        .select("userId")
        .where("roomId", "=", roomId)
        .where("userId", "in", userIds)
        .execute();
      const memberIds = new Set(memberships.map((membership) => membership.userId));
      const pendingInvitations = await transaction
        .selectFrom("roomInvitations")
        .select("invitedUserId")
        .where("roomId", "=", roomId)
        .where("invitedUserId", "in", userIds)
        .where("status", "=", "PENDING")
        .execute();
      const pendingIds = new Set(pendingInvitations.map((invitation) => invitation.invitedUserId));
      const results: BatchInvitationResult[] = [];
      const created: Array<{ userId: string; invitationId: string }> = [];
      for (const userId of userIds) {
        let status: BatchInvitationStatus;
        if (userId === actorUserId) {
          status = "FORBIDDEN";
        } else if (usersById.get(userId)?.status !== "ACTIVE") {
          status = "NOT_FOUND";
        } else if (memberIds.has(userId)) {
          status = "ALREADY_MEMBER";
        } else if (pendingIds.has(userId)) {
          status = "ALREADY_PENDING";
        } else {
          status = "CREATED";
        }
        if (status !== "CREATED") {
          results.push({ userId, status, invitationId: null });
          continue;
        }
        const invitationId = randomUUID();
        await transaction
          .insertInto("roomInvitations")
          .values({
            id: invitationId,
            roomId,
            invitedUserId: userId,
            invitedByUserId: actorUserId,
            status: "PENDING",
            expiresAt,
            createdAt,
            updatedAt: createdAt,
          })
          .execute();
        created.push({ userId, invitationId });
        results.push({ userId, status, invitationId });
      }
      if (created.length === 0) {
        return { value: results, events: [] as ProductRealtimeEvent[] };
      }
      const updatedRoom = await this.#bumpRoomRevision(transaction, roomId, createdAt);
      const events: ProductRealtimeEvent[] = [this.#roomUpdatedEvent(updatedRoom, createdAt)];
      for (const invitation of created) {
        await this.#stageNotification(transaction, events, {
          recipientUserId: invitation.userId,
          type: "ROOM_INVITATION_CREATED",
          context: notificationContext({
            actor,
            room: updatedRoom,
            invitationId: invitation.invitationId,
          }),
        });
      }
      this.#stagePublicInvalidation(events, updatedRoom);
      return { value: results, events };
    });
    this.#publish(committed.events);
    return committed.value;
  }

  async #requireOwnerForRead(actorUserId: string, roomId: string): Promise<void> {
    const authorization = await this.#db
      .selectFrom("roomMemberships")
      .innerJoin("rooms", "rooms.id", "roomMemberships.roomId")
      .innerJoin("users", "users.id", "roomMemberships.userId")
      .select(["roomMemberships.role", "users.status"])
      .where("rooms.id", "=", roomId)
      .where("roomMemberships.userId", "=", actorUserId)
      .where("rooms.deletedAt", "is", null)
      .executeTakeFirst();
    if (authorization === undefined) {
      throw new RoomError("ROOM_NOT_FOUND");
    }
    if (authorization.status !== "ACTIVE") {
      throw new RoomError("INVALID_ROOM_TRANSITION");
    }
    if (authorization.role !== "OWNER") {
      throw new RoomError("ROOM_OWNER_REQUIRED");
    }
  }

  async #getOwnedRoomForUpdate(
    transaction: Transaction<Database>,
    actorUserId: string,
    roomId: string,
  ): Promise<RoomState> {
    await this.#getActiveUserForUpdate(transaction, actorUserId);
    const room = await transaction
      .selectFrom("rooms")
      .select(roomStateColumns)
      .where("id", "=", roomId)
      .where("deletedAt", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (room === undefined) {
      throw new RoomError("ROOM_NOT_FOUND");
    }
    if (room.ownerUserId !== actorUserId) {
      throw new RoomError("ROOM_OWNER_REQUIRED");
    }
    await this.#requireOwnerMembership(transaction, actorUserId, roomId);
    return room;
  }

  async #getRoomForJoin(
    transaction: Transaction<Database>,
    roomId: string,
    policy: "OPEN" | "APPROVAL",
  ): Promise<RoomState> {
    const room = await transaction
      .selectFrom("rooms")
      .select(roomStateColumns)
      .where("id", "=", roomId)
      .where("deletedAt", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (room === undefined) {
      throw new RoomError("ROOM_NOT_FOUND");
    }
    if (room.visibility !== "PUBLIC") {
      throw new RoomError("ROOM_NOT_PUBLIC");
    }
    if (room.joinPolicy !== policy) {
      throw new RoomError("ROOM_JOIN_POLICY_MISMATCH");
    }
    return room;
  }

  async #getActiveUserForUpdate(
    transaction: Transaction<Database>,
    userId: string,
  ): Promise<{ userId: string; username: string; displayName: string }> {
    const user = await transaction
      .selectFrom("users")
      .select(["id as userId", "username", "displayName", "status"])
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirst();
    if (user?.status !== "ACTIVE") {
      throw new RoomError("INVALID_ROOM_TRANSITION");
    }
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
    };
  }

  async #getActor(
    transaction: Transaction<Database>,
    userId: string,
  ): Promise<NotificationActorSummary> {
    const actor = await transaction
      .selectFrom("users")
      .select(["id as userId", "displayName"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (actor === undefined) {
      throw new RoomError("INVALID_ROOM_TRANSITION");
    }
    return actor;
  }

  async #requireNoMembership(
    transaction: Transaction<Database>,
    roomId: string,
    userId: string,
  ): Promise<void> {
    const membership = await transaction
      .selectFrom("roomMemberships")
      .select("userId")
      .where("roomId", "=", roomId)
      .where("userId", "=", userId)
      .executeTakeFirst();
    if (membership !== undefined) {
      throw new RoomError("MEMBERSHIP_CONFLICT");
    }
  }

  async #requireOwnerMembership(
    transaction: Transaction<Database>,
    actorUserId: string,
    roomId: string,
  ): Promise<void> {
    const membership = await transaction
      .selectFrom("roomMemberships")
      .select("role")
      .where("roomId", "=", roomId)
      .where("userId", "=", actorUserId)
      .executeTakeFirst();
    if (membership?.role !== "OWNER") {
      throw new RoomError("JOIN_REQUEST_NOT_FOUND");
    }
  }

  async #bumpRoomRevision(
    transaction: Transaction<Database>,
    roomId: string,
    changedAt: Date,
  ): Promise<RoomState> {
    return transaction
      .updateTable("rooms")
      .set((expression) => ({
        roomRevision: expression("roomRevision", "+", 1),
        updatedAt: changedAt,
      }))
      .where("id", "=", roomId)
      .where("deletedAt", "is", null)
      .returning(roomStateColumns)
      .executeTakeFirstOrThrow();
  }

  #memberJoinedEvent(
    room: RoomState,
    applicant: { userId: string; username: string; displayName: string },
    occurredAt: Date,
  ): ProductRealtimeEvent {
    return this.#roomEvent(room, occurredAt, {
      kind: "ROOM_MEMBER_JOINED",
      member: {
        ...applicant,
        role: "MEMBER",
        joinedAt: occurredAt.toISOString(),
      },
    });
  }

  #roomUpdatedEvent(room: RoomState, occurredAt: Date): ProductRealtimeEvent {
    return this.#roomEvent(room, occurredAt, {
      kind: "ROOM_UPDATED",
      name: room.name,
      visibility: room.visibility,
      joinPolicy: room.joinPolicy,
    });
  }

  #roomEvent(
    room: Pick<RoomState, "id" | "roomRevision">,
    occurredAt: Date,
    payload: Record<string, unknown>,
  ): ProductRealtimeEvent {
    return {
      type: "ROOM_EVENT",
      event: RoomEventMessageSchema.parse({
        type: "room.event",
        protocolVersion: 1,
        eventId: randomUUID(),
        roomId: room.id,
        roomRevision: room.roomRevision,
        occurredAt: occurredAt.toISOString(),
        ...payload,
      }),
    };
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

  async #stageRequestResultPair(
    transaction: Transaction<Database>,
    events: ProductRealtimeEvent[],
    input: {
      room: RoomState;
      requestId: string;
      applicant: { userId: string; displayName: string };
      owner: NotificationActorSummary;
      type:
        "ROOM_JOIN_REQUEST_APPROVED" | "ROOM_JOIN_REQUEST_REJECTED" | "ROOM_JOIN_REQUEST_CANCELLED";
      decision: "APPROVED" | "REJECTED" | "CANCELLED";
      applicantInitiallyRead: boolean;
      ownerInitiallyRead: boolean;
    },
  ): Promise<void> {
    await this.#stageNotification(transaction, events, {
      recipientUserId: input.applicant.userId,
      type: input.type,
      initiallyRead: input.applicantInitiallyRead,
      context: notificationContext({
        actor: input.owner,
        room: input.room,
        requestId: input.requestId,
        decision: input.decision,
      }),
    });
    await this.#stageNotification(transaction, events, {
      recipientUserId: input.room.ownerUserId,
      type: input.type,
      initiallyRead: input.ownerInitiallyRead,
      context: notificationContext({
        actor: {
          userId: input.applicant.userId,
          displayName: input.applicant.displayName,
        },
        room: input.room,
        requestId: input.requestId,
        decision: input.decision,
      }),
    });
  }

  #stagePublicInvalidation(events: ProductRealtimeEvent[], room: RoomState): void {
    events.push({
      type: "PUBLIC_ROOMS_INVALIDATED",
      message: PublicRoomsInvalidatedSchema.parse({
        type: "public-rooms.invalidated",
        roomId: room.id,
        reason: "ROOM",
        roomRevision: room.roomRevision,
      }),
    });
  }

  #requestFromRow(
    request: {
      id: string;
      roomId: string;
      status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
      createdAt: Date;
      decidedAt: Date | null;
    },
    applicant: { userId: string; username: string; displayName: string },
  ): RoomJoinRequest {
    return RoomJoinRequestSchema.parse({
      requestId: request.id,
      roomId: request.roomId,
      applicant,
      status: request.status,
      createdAt: request.createdAt.toISOString(),
      decidedAt: request.decidedAt?.toISOString() ?? null,
    });
  }

  #safeOnlineRoomIds(roomId: string): ReadonlySet<string> {
    return sanitizeUserIds(this.#onlineUserIdsForRoom(roomId));
  }

  #safeOnlineUserIds(): ReadonlySet<string> {
    return sanitizeUserIds(this.#onlineUserIds());
  }

  #publish(events: readonly ProductRealtimeEvent[]): void {
    for (const event of events) {
      this.#events.publish(event);
    }
  }
}

function sanitizeUserIds(input: ReadonlySet<string>): ReadonlySet<string> {
  const result = new Set<string>();
  for (const userId of input) {
    if (CanonicalUuidSchema.safeParse(userId).success) {
      result.add(userId);
    }
  }
  return result;
}

function roomStateFromJoinedRequest(input: {
  roomId: string;
  name: string;
  ownerUserId: string;
  roomEpoch: number;
  visibility: "PRIVATE" | "PUBLIC";
  joinPolicy: "OPEN" | "APPROVAL" | "INVITE_ONLY";
  roomRevision: number;
  createdAt: Date;
  updatedAt: Date;
}): RoomState {
  return {
    id: input.roomId,
    name: input.name,
    ownerUserId: input.ownerUserId,
    roomEpoch: input.roomEpoch,
    visibility: input.visibility,
    joinPolicy: input.joinPolicy,
    roomRevision: input.roomRevision,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function requestFromJoinedRow(input: {
  id: string;
  roomId: string;
  applicantUserId: string;
  username: string;
  displayName: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
  requestCreatedAt: Date;
  decidedAt: Date | null;
}): RoomJoinRequest {
  return RoomJoinRequestSchema.parse({
    requestId: input.id,
    roomId: input.roomId,
    applicant: {
      userId: input.applicantUserId,
      username: input.username,
      displayName: input.displayName,
    },
    status: input.status,
    createdAt: input.requestCreatedAt.toISOString(),
    decidedAt: input.decidedAt?.toISOString() ?? null,
  });
}
