import type { createDatabase } from "@syncaction/database";

type AdminDatabase = ReturnType<typeof createDatabase>;

export type UserStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
export type RoomLifecycle = "ACTIVE" | "DELETED";
export type RoomQuotaClass = "ORDINARY" | "EXEMPT";

export interface AdminUserSummary {
  id: string;
  username: string;
  displayName: string;
  status: UserStatus;
  passwordResetRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminDeviceSummary {
  deviceId: string;
  activeSessionCount: number;
  lastRotatedAt: Date;
}

export interface AdminRoomSummary {
  roomId: string;
  name: string;
  ownerUserId: string;
  ownerUsername: string;
  memberCount: number;
  openTabCount: number;
  roomEpoch: number;
  serverSeq: number;
  lifecycle: RoomLifecycle;
  quotaClass: RoomQuotaClass;
}

export interface AdminRoomMember {
  userId: string;
  username: string;
  displayName: string;
  status: UserStatus;
  role: "OWNER" | "MEMBER";
  createdAt: Date;
}

export interface AdminDiagnostics {
  database: "ready";
  counts: {
    users: number;
    pendingUsers: number;
    activeUsers: number;
    suspendedUsers: number;
    revokedUsers: number;
    rooms: number;
    activeDeviceSessions: number;
  };
}

export class AdminReadError extends Error {
  public readonly code = "ADMIN_READ_NOT_FOUND";

  public constructor() {
    super("ADMIN_READ_NOT_FOUND");
    this.name = "AdminReadError";
  }
}

export interface AdminReadServiceOptions {
  db: AdminDatabase;
  now?: () => Date;
}

export class AdminReadService {
  readonly #db: AdminDatabase;
  readonly #now: () => Date;

  public constructor(options: AdminReadServiceOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
  }

  public async listUsers(input: {
    status?: UserStatus;
    limit: number;
  }): Promise<{ users: AdminUserSummary[]; total: number }> {
    const status = input.status;
    const usersQuery = this.#db
      .selectFrom("users")
      .select([
        "id",
        "username",
        "displayName",
        "status",
        "passwordResetRequired",
        "createdAt",
        "updatedAt",
      ])
      .$if(status !== undefined, (query) => query.where("status", "=", status!))
      .orderBy("createdAt", status === "PENDING" ? "asc" : "desc")
      .limit(input.limit);
    const totalQuery = this.#db
      .selectFrom("users")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .$if(status !== undefined, (query) => query.where("status", "=", status!));
    const [users, total] = await Promise.all([
      usersQuery.execute(),
      totalQuery.executeTakeFirstOrThrow(),
    ]);
    return {
      users,
      total: Number(total.count),
    };
  }

  public async listUserDevices(userId: string): Promise<{
    devices: AdminDeviceSummary[];
  }> {
    const user = await this.#db
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .executeTakeFirst();
    if (user === undefined) {
      throw new AdminReadError();
    }

    const sessions = await this.#db
      .selectFrom("deviceSessions")
      .select(["deviceId", "updatedAt"])
      .where("userId", "=", userId)
      .where("revokedAt", "is", null)
      .where("usedAt", "is", null)
      .where("expiresAt", ">", this.#now())
      .orderBy("deviceId", "asc")
      .orderBy("updatedAt", "desc")
      .execute();
    const byDevice = new Map<string, AdminDeviceSummary>();
    for (const session of sessions) {
      const current = byDevice.get(session.deviceId);
      if (current === undefined) {
        byDevice.set(session.deviceId, {
          deviceId: session.deviceId,
          activeSessionCount: 1,
          lastRotatedAt: session.updatedAt,
        });
      } else {
        current.activeSessionCount += 1;
        if (session.updatedAt.getTime() > current.lastRotatedAt.getTime()) {
          current.lastRotatedAt = session.updatedAt;
        }
      }
    }
    return { devices: [...byDevice.values()] };
  }

  public async listRooms(input: {
    lifecycle?: RoomLifecycle;
    quotaClass?: RoomQuotaClass;
    limit: number;
  }): Promise<{ rooms: AdminRoomSummary[] }> {
    const rooms = await this.#db
      .selectFrom("rooms")
      .innerJoin("users as owners", "owners.id", "rooms.ownerUserId")
      .select([
        "rooms.id as roomId",
        "rooms.name",
        "rooms.ownerUserId",
        "owners.username as ownerUsername",
        "rooms.roomEpoch",
        "rooms.serverSeq",
        "rooms.deletedAt",
      ])
      .select((expression) => [
        expression
          .selectFrom("roomMemberships")
          .select((aggregate) => aggregate.fn.countAll<number>().as("count"))
          .whereRef("roomMemberships.roomId", "=", "rooms.id")
          .as("memberCount"),
        expression
          .selectFrom("roomTabs")
          .select((aggregate) => aggregate.fn.countAll<number>().as("count"))
          .whereRef("roomTabs.roomId", "=", "rooms.id")
          .where("roomTabs.closedAtSeq", "is", null)
          .as("openTabCount"),
        expression
          .exists(
            expression
              .selectFrom("administrators")
              .select("administrators.id")
              .whereRef("administrators.linkedUserId", "=", "rooms.ownerUserId"),
          )
          .as("isExempt"),
      ])
      .$if(input.lifecycle === "ACTIVE", (query) => query.where("rooms.deletedAt", "is", null))
      .$if(input.lifecycle === "DELETED", (query) => query.where("rooms.deletedAt", "is not", null))
      .$if(input.quotaClass === "EXEMPT", (query) =>
        query.where((expression) =>
          expression.exists(
            expression
              .selectFrom("administrators")
              .select("administrators.id")
              .whereRef("administrators.linkedUserId", "=", "rooms.ownerUserId"),
          ),
        ),
      )
      .$if(input.quotaClass === "ORDINARY", (query) =>
        query.where((expression) =>
          expression.not(
            expression.exists(
              expression
                .selectFrom("administrators")
                .select("administrators.id")
                .whereRef("administrators.linkedUserId", "=", "rooms.ownerUserId"),
            ),
          ),
        ),
      )
      .orderBy("rooms.updatedAt", "desc")
      .orderBy("rooms.id", "asc")
      .limit(Math.min(Math.max(input.limit, 1), 200))
      .execute();

    return {
      rooms: rooms.map((room) => ({
        roomId: room.roomId,
        name: room.name,
        ownerUserId: room.ownerUserId,
        ownerUsername: room.ownerUsername,
        memberCount: Number(room.memberCount ?? 0),
        openTabCount: Number(room.openTabCount ?? 0),
        roomEpoch: room.roomEpoch,
        serverSeq: room.serverSeq,
        lifecycle: room.deletedAt === null ? "ACTIVE" : "DELETED",
        quotaClass: room.isExempt ? "EXEMPT" : "ORDINARY",
      })),
    };
  }

  public async listRoomMembers(roomId: string): Promise<{
    members: AdminRoomMember[];
  }> {
    const room = await this.#db
      .selectFrom("rooms")
      .select("id")
      .where("id", "=", roomId)
      .where("deletedAt", "is", null)
      .executeTakeFirst();
    if (room === undefined) {
      throw new AdminReadError();
    }

    const members = await this.#db
      .selectFrom("roomMemberships")
      .innerJoin("users", "users.id", "roomMemberships.userId")
      .select([
        "roomMemberships.userId",
        "users.username",
        "users.displayName",
        "users.status",
        "roomMemberships.role",
        "roomMemberships.createdAt",
      ])
      .where("roomMemberships.roomId", "=", roomId)
      .execute();
    members.sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === "OWNER" ? -1 : 1;
      }
      return (
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.userId.localeCompare(right.userId)
      );
    });
    return { members };
  }

  public async diagnostics(): Promise<AdminDiagnostics> {
    const [userCounts, rooms, deviceSessions] = await Promise.all([
      this.#db
        .selectFrom("users")
        .select(["status", (expression) => expression.fn.countAll<number>().as("count")])
        .groupBy("status")
        .execute(),
      this.#db
        .selectFrom("rooms")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("deletedAt", "is", null)
        .executeTakeFirstOrThrow(),
      this.#db
        .selectFrom("deviceSessions")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("revokedAt", "is", null)
        .where("usedAt", "is", null)
        .where("expiresAt", ">", this.#now())
        .executeTakeFirstOrThrow(),
    ]);
    const countByStatus = new Map(userCounts.map((row) => [row.status, Number(row.count)]));
    const pendingUsers = countByStatus.get("PENDING") ?? 0;
    const activeUsers = countByStatus.get("ACTIVE") ?? 0;
    const suspendedUsers = countByStatus.get("SUSPENDED") ?? 0;
    const revokedUsers = countByStatus.get("REVOKED") ?? 0;
    return {
      database: "ready",
      counts: {
        users: pendingUsers + activeUsers + suspendedUsers + revokedUsers,
        pendingUsers,
        activeUsers,
        suspendedUsers,
        revokedUsers,
        rooms: Number(rooms.count),
        activeDeviceSessions: Number(deviceSessions.count),
      },
    };
  }
}
