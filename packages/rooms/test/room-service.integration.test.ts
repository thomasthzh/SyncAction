import { createDatabase, migrateToLatest } from "@syncaction/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotificationService } from "../src/notification-service.js";
import { RoomProductEventBus, type ProductRealtimeEvent } from "../src/room-product-events.js";
import { RoomService } from "../src/room-service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-26T12:00:00.000Z");
let db: ReturnType<typeof createDatabase>;
let rooms: RoomService;
let events: ProductRealtimeEvent[];

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("notifications").execute();
  await db.deleteFrom("roomJoinRequests").execute();
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  events = [];
  const eventBus = new RoomProductEventBus();
  eventBus.subscribe((event) => events.push(event));
  const notifications = new NotificationService({ db, events: eventBus, now: () => now });
  rooms = new RoomService({
    db,
    events: eventBus,
    notifications,
    now: () => now,
  });
});

async function createUser(
  id: string,
  username: string,
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED" = "ACTIVE",
): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id,
      username,
      usernameNormalized: username.toLowerCase(),
      displayName: `${username} Display`,
      passwordHash: "hash",
      status,
    })
    .execute();
}

const ownerId = "018f8f8e-4b5c-7d6e-8f90-123456789b00";
const memberId = "018f8f8e-4b5c-7d6e-8f90-123456789b01";
const outsiderId = "018f8f8e-4b5c-7d6e-8f90-123456789b02";
const administratorId = "018f8f8e-4b5c-7d6e-8f90-123456789b09";

async function createAdministrator(): Promise<void> {
  await db
    .insertInto("administrators")
    .values({
      id: administratorId,
      username: "administrator",
      usernameNormalized: "administrator",
      passwordHash: "hash",
      totpSecretCiphertext: "ciphertext",
      linkedUserId: null,
    })
    .execute();
}

describe("room creation and membership authorization", () => {
  it("atomically creates a room and its sole owner membership", async () => {
    await createUser(ownerId, "owner");

    const created = await rooms.createRoom({ actorUserId: ownerId, name: "  Product   Room " });

    expect(created).toMatchObject({
      name: "Product Room",
      role: "OWNER",
      roomEpoch: 0,
      createdAt: now,
      updatedAt: now,
    });
    const room = await db
      .selectFrom("rooms")
      .selectAll()
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    const memberships = await db
      .selectFrom("roomMemberships")
      .selectAll()
      .where("roomId", "=", created.id)
      .execute();
    expect(room.ownerUserId).toBe(ownerId);
    expect(memberships).toMatchObject([{ userId: ownerId, role: "OWNER" }]);
  });

  it.each(["PENDING", "SUSPENDED", "REVOKED"] as const)(
    "rejects room creation by a %s account",
    async (status) => {
      await createUser(ownerId, "owner", status);

      await expect(
        rooms.createRoom({ actorUserId: ownerId, name: "Denied" }),
      ).rejects.toMatchObject({ code: "INVALID_ROOM_TRANSITION" });
      const count = await db
        .selectFrom("rooms")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      expect(Number(count.count)).toBe(0);
    },
  );

  it("lists only non-deleted rooms with an accepted membership", async () => {
    await createUser(ownerId, "owner");
    await createUser(memberId, "member");
    await createUser(outsiderId, "outsider");
    const owned = await rooms.createRoom({ actorUserId: ownerId, name: "Owned" });
    const joined = await rooms.createRoom({ actorUserId: memberId, name: "Joined" });
    const hidden = await rooms.createRoom({ actorUserId: outsiderId, name: "Hidden" });
    await db
      .insertInto("roomMemberships")
      .values({ roomId: joined.id, userId: ownerId, role: "MEMBER", createdAt: now })
      .execute();
    await db.updateTable("rooms").set({ deletedAt: now }).where("id", "=", hidden.id).execute();

    const result = await rooms.listRooms(ownerId);

    expect(result.map((room) => [room.id, room.role])).toEqual([
      [joined.id, "MEMBER"],
      [owned.id, "OWNER"],
    ]);
  });

  it("returns accepted members and pending invitations only to the owner", async () => {
    await createUser(ownerId, "owner");
    await createUser(memberId, "member");
    await createUser(outsiderId, "outsider");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Visible" });
    await db
      .insertInto("roomMemberships")
      .values({ roomId: room.id, userId: memberId, role: "MEMBER", createdAt: now })
      .execute();
    await db
      .insertInto("roomInvitations")
      .values({
        id: "018f8f8e-4b5c-7d6e-8f90-123456789b03",
        roomId: room.id,
        invitedUserId: outsiderId,
        invitedByUserId: ownerId,
        status: "PENDING",
        expiresAt: new Date("2026-08-02T12:00:00.000Z"),
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const ownerView = await rooms.getRoom({ actorUserId: ownerId, roomId: room.id });
    const memberView = await rooms.getRoom({ actorUserId: memberId, roomId: room.id });

    expect(ownerView.members).toEqual([
      expect.objectContaining({ userId: ownerId, username: "owner", role: "OWNER" }),
      expect.objectContaining({ userId: memberId, username: "member", role: "MEMBER" }),
    ]);
    expect(ownerView.pendingInvitations).toEqual([
      expect.objectContaining({
        invitedUserId: outsiderId,
        username: "outsider",
        status: "PENDING",
      }),
    ]);
    expect(memberView.pendingInvitations).toBeNull();
  });

  it("uses ROOM_NOT_FOUND for both missing and unauthorized room reads", async () => {
    await createUser(ownerId, "owner");
    await createUser(outsiderId, "outsider");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Private" });
    const missingId = "018f8f8e-4b5c-7d6e-8f90-123456789b04";

    await expect(rooms.getRoom({ actorUserId: outsiderId, roomId: room.id })).rejects.toMatchObject(
      { code: "ROOM_NOT_FOUND" },
    );
    await expect(
      rooms.getRoom({ actorUserId: outsiderId, roomId: missingId }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
  });
});

describe("room invitations", () => {
  async function createInvitationFixture(): Promise<{ roomId: string }> {
    await createUser(ownerId, "owner");
    await createUser(memberId, "Target.User");
    await createUser(outsiderId, "outsider");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Invitations" });
    return { roomId: room.id };
  }

  it("invites an active user by exact normalized username for seven days", async () => {
    const { roomId } = await createInvitationFixture();

    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId,
      username: "  Ｔarget.User ",
    });

    expect(invitation).toMatchObject({
      roomId,
      invitedUserId: memberId,
      invitedByUserId: ownerId,
      status: "PENDING",
      expiresAt: new Date("2026-08-02T12:00:00.000Z"),
      createdAt: now,
    });
    const inviteeView = await rooms.listInvitations(memberId);
    const otherView = await rooms.listInvitations(outsiderId);
    expect(inviteeView).toEqual([
      expect.objectContaining({
        id: invitation.id,
        roomId,
        roomName: "Invitations",
        invitedByUsername: "owner",
      }),
    ]);
    expect(otherView).toEqual([]);
  });

  it("allows only the owner to invite or revoke", async () => {
    const { roomId } = await createInvitationFixture();
    await db
      .insertInto("roomMemberships")
      .values({ roomId, userId: outsiderId, role: "MEMBER", createdAt: now })
      .execute();

    await expect(
      rooms.inviteByUsername({
        actorUserId: outsiderId,
        roomId,
        username: "Target.User",
      }),
    ).rejects.toMatchObject({ code: "ROOM_OWNER_REQUIRED" });

    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId,
      username: "Target.User",
    });
    await expect(
      rooms.revokeInvitation({
        actorUserId: outsiderId,
        roomId,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ code: "ROOM_OWNER_REQUIRED" });
  });

  it("rejects self, inactive, and existing-member targets", async () => {
    const { roomId } = await createInvitationFixture();

    await expect(
      rooms.inviteByUsername({ actorUserId: ownerId, roomId, username: "owner" }),
    ).rejects.toMatchObject({ code: "USER_NOT_INVITABLE" });
    await db.updateTable("users").set({ status: "SUSPENDED" }).where("id", "=", memberId).execute();
    await expect(
      rooms.inviteByUsername({
        actorUserId: ownerId,
        roomId,
        username: "Target.User",
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_INVITABLE" });
    await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", memberId).execute();
    await db
      .insertInto("roomMemberships")
      .values({ roomId, userId: memberId, role: "MEMBER", createdAt: now })
      .execute();
    await expect(
      rooms.inviteByUsername({
        actorUserId: ownerId,
        roomId,
        username: "Target.User",
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_INVITABLE" });
  });

  it("allows one concurrent pending invitation and permits reinviting after revocation", async () => {
    const { roomId } = await createInvitationFixture();
    const attempts = await Promise.allSettled([
      rooms.inviteByUsername({
        actorUserId: ownerId,
        roomId,
        username: "Target.User",
      }),
      rooms.inviteByUsername({
        actorUserId: ownerId,
        roomId,
        username: "Target.User",
      }),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["fulfilled", "rejected"]);
    const fulfilled = attempts.find(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof rooms.inviteByUsername>>> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(fulfilled).toBeDefined();
    expect(rejected?.reason).toMatchObject({ code: "INVITATION_CONFLICT" });
    const first = fulfilled!.value;

    await rooms.revokeInvitation({
      actorUserId: ownerId,
      roomId,
      invitationId: first.id,
    });
    const second = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId,
      username: "Target.User",
    });
    expect(second.id).not.toBe(first.id);
    const storedFirst = await db
      .selectFrom("roomInvitations")
      .select("status")
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(storedFirst.status).toBe("REVOKED");
  });

  it("accepts an invitation once and atomically creates membership", async () => {
    const { roomId } = await createInvitationFixture();
    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId,
      username: "Target.User",
    });

    const acceptedRoom = await rooms.acceptInvitation({
      actorUserId: memberId,
      invitationId: invitation.id,
    });

    expect(acceptedRoom).toMatchObject({ id: roomId, role: "MEMBER" });
    const stored = await db
      .selectFrom("roomInvitations")
      .select("status")
      .where("id", "=", invitation.id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe("ACCEPTED");
    await expect(
      rooms.acceptInvitation({
        actorUserId: memberId,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  });

  it("does not reveal an invitation to a different active user", async () => {
    const { roomId } = await createInvitationFixture();
    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId,
      username: "Target.User",
    });

    await expect(
      rooms.acceptInvitation({
        actorUserId: outsiderId,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  });

  it("persists expiration when an expired invitation is accepted", async () => {
    const { roomId } = await createInvitationFixture();
    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId,
      username: "Target.User",
    });
    await db
      .updateTable("roomInvitations")
      .set({ expiresAt: new Date("2026-07-26T11:59:59.000Z") })
      .where("id", "=", invitation.id)
      .execute();

    await expect(
      rooms.acceptInvitation({
        actorUserId: memberId,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
    const stored = await db
      .selectFrom("roomInvitations")
      .select("status")
      .where("id", "=", invitation.id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe("EXPIRED");
    await expect(rooms.listInvitations(memberId)).resolves.toEqual([]);
  });

  it("keeps the invitation pending when membership already exists at acceptance", async () => {
    const { roomId } = await createInvitationFixture();
    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId,
      username: "Target.User",
    });
    await db
      .insertInto("roomMemberships")
      .values({ roomId, userId: memberId, role: "MEMBER", createdAt: now })
      .execute();

    await expect(
      rooms.acceptInvitation({
        actorUserId: memberId,
        invitationId: invitation.id,
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_CONFLICT" });
    const stored = await db
      .selectFrom("roomInvitations")
      .select("status")
      .where("id", "=", invitation.id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe("PENDING");
  });
});

describe("room and membership lifecycle", () => {
  async function createMembershipFixture(includeOutsider = false): Promise<{ roomId: string }> {
    await createUser(ownerId, "owner");
    await createUser(memberId, "member");
    await createUser(outsiderId, "outsider");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Lifecycle" });
    await db
      .insertInto("roomMemberships")
      .values([
        { roomId: room.id, userId: memberId, role: "MEMBER", createdAt: now },
        ...(includeOutsider
          ? [{ roomId: room.id, userId: outsiderId, role: "MEMBER" as const, createdAt: now }]
          : []),
      ])
      .execute();
    return { roomId: room.id };
  }

  it("lets only the owner rename a room", async () => {
    const { roomId } = await createMembershipFixture();

    const renamed = await rooms.renameRoom({
      actorUserId: ownerId,
      roomId,
      name: "  Renamed   Room ",
    });

    expect(renamed).toMatchObject({ id: roomId, name: "Renamed Room", role: "OWNER" });
    await expect(
      rooms.renameRoom({ actorUserId: memberId, roomId, name: "Denied" }),
    ).rejects.toMatchObject({ code: "ROOM_OWNER_REQUIRED" });
  });

  it("lets the owner remove a member but not the owner", async () => {
    const { roomId } = await createMembershipFixture();

    await rooms.removeMember({
      actorUserId: ownerId,
      roomId,
      memberUserId: memberId,
    });

    await expect(rooms.getRoom({ actorUserId: memberId, roomId })).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });
    await expect(
      rooms.removeMember({
        actorUserId: ownerId,
        roomId,
        memberUserId: ownerId,
      }),
    ).rejects.toMatchObject({ code: "OWNER_MUST_TRANSFER" });
  });

  it("lets a member leave but requires the owner to transfer first", async () => {
    const { roomId } = await createMembershipFixture();

    await rooms.leaveRoom({ actorUserId: memberId, roomId });

    await expect(rooms.getRoom({ actorUserId: memberId, roomId })).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });
    await expect(rooms.leaveRoom({ actorUserId: ownerId, roomId })).rejects.toMatchObject({
      code: "OWNER_MUST_TRANSFER",
    });
  });

  it("atomically transfers ownership to an active accepted member", async () => {
    const { roomId } = await createMembershipFixture();

    const transferred = await rooms.transferOwnership({
      actorUserId: ownerId,
      roomId,
      newOwnerUserId: memberId,
    });

    expect(transferred).toMatchObject({ id: roomId, role: "OWNER" });
    const storedRoom = await db
      .selectFrom("rooms")
      .select("ownerUserId")
      .where("id", "=", roomId)
      .executeTakeFirstOrThrow();
    const memberships = await db
      .selectFrom("roomMemberships")
      .select(["userId", "role"])
      .where("roomId", "=", roomId)
      .orderBy("userId")
      .execute();
    expect(storedRoom.ownerUserId).toBe(memberId);
    expect(memberships).toEqual([
      { userId: ownerId, role: "MEMBER" },
      { userId: memberId, role: "OWNER" },
    ]);
    await expect(
      rooms.renameRoom({ actorUserId: ownerId, roomId, name: "Former owner" }),
    ).rejects.toMatchObject({ code: "ROOM_OWNER_REQUIRED" });
    await expect(
      rooms.renameRoom({ actorUserId: memberId, roomId, name: "Current owner" }),
    ).resolves.toMatchObject({ name: "Current owner" });
  });

  it("rejects ownership transfer to a non-member or inactive member", async () => {
    const { roomId } = await createMembershipFixture();

    await expect(
      rooms.transferOwnership({
        actorUserId: ownerId,
        roomId,
        newOwnerUserId: outsiderId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_TRANSITION" });
    await db.updateTable("users").set({ status: "SUSPENDED" }).where("id", "=", memberId).execute();
    await expect(
      rooms.transferOwnership({
        actorUserId: ownerId,
        roomId,
        newOwnerUserId: memberId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_TRANSITION" });
  });

  it("serializes competing ownership transfers and preserves one owner", async () => {
    const { roomId } = await createMembershipFixture(true);

    const attempts = await Promise.allSettled([
      rooms.transferOwnership({
        actorUserId: ownerId,
        roomId,
        newOwnerUserId: memberId,
      }),
      rooms.transferOwnership({
        actorUserId: ownerId,
        roomId,
        newOwnerUserId: outsiderId,
      }),
    ]);

    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["fulfilled", "rejected"]);
    const ownerMemberships = await db
      .selectFrom("roomMemberships")
      .select("userId")
      .where("roomId", "=", roomId)
      .where("role", "=", "OWNER")
      .execute();
    const storedRoom = await db
      .selectFrom("rooms")
      .select("ownerUserId")
      .where("id", "=", roomId)
      .executeTakeFirstOrThrow();
    expect(ownerMemberships).toEqual([{ userId: storedRoom.ownerUserId }]);
  });

  it("soft-deletes the room, increments its epoch, and denies stale access", async () => {
    const { roomId } = await createMembershipFixture();
    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId,
      username: "outsider",
    });

    await rooms.softDeleteRoom({ actorUserId: ownerId, roomId });

    const storedRoom = await db
      .selectFrom("rooms")
      .select(["roomEpoch", "deletedAt"])
      .where("id", "=", roomId)
      .executeTakeFirstOrThrow();
    const storedInvitation = await db
      .selectFrom("roomInvitations")
      .select("status")
      .where("id", "=", invitation.id)
      .executeTakeFirstOrThrow();
    expect(storedRoom).toEqual({ roomEpoch: 1, deletedAt: now });
    expect(storedInvitation.status).toBe("REVOKED");
    await expect(rooms.listRooms(ownerId)).resolves.toEqual([]);
    await expect(rooms.getRoom({ actorUserId: ownerId, roomId })).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });
    await expect(rooms.getRoom({ actorUserId: memberId, roomId })).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });
    await expect(rooms.listInvitations(outsiderId)).resolves.toEqual([]);
    await expect(
      rooms.inviteByUsername({ actorUserId: ownerId, roomId, username: "outsider" }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
  });
});

describe("room product lifecycle", () => {
  const requestId = "018f8f8e-4b5c-7d6e-8f90-123456789b10";

  it("defaults to private invite-only and validates explicit access combinations", async () => {
    await createUser(ownerId, "owner");

    const privateRoom = await rooms.createRoom({ actorUserId: ownerId, name: "Private" });
    expect(privateRoom).toMatchObject({
      visibility: "PRIVATE",
      joinPolicy: "INVITE_ONLY",
      roomRevision: 0,
    });

    const publicRoom = await rooms.createRoom({
      actorUserId: ownerId,
      name: "Public study",
      visibility: "PUBLIC",
      joinPolicy: "APPROVAL",
    });
    expect(publicRoom).toMatchObject({
      visibility: "PUBLIC",
      joinPolicy: "APPROVAL",
      roomRevision: 0,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "PUBLIC_ROOMS_INVALIDATED",
        message: expect.objectContaining({
          roomId: publicRoom.id,
          roomRevision: 0,
        }),
      }),
    ]);

    await expect(
      rooms.createRoom({
        actorUserId: ownerId,
        name: "Invalid",
        visibility: "PRIVATE",
        joinPolicy: "OPEN",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_INPUT" });
  });

  it("publishes monotonic invitation and member lifecycle events only after commit", async () => {
    await createUser(ownerId, "owner");
    await createUser(memberId, "Target.User");
    const room = await rooms.createRoom({
      actorUserId: ownerId,
      name: "Public study",
      visibility: "PUBLIC",
      joinPolicy: "APPROVAL",
    });

    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId: room.id,
      username: "Target.User",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ROOM_EVENT",
          event: expect.objectContaining({
            kind: "ROOM_UPDATED",
            roomId: room.id,
            roomRevision: 1,
          }),
        }),
        expect.objectContaining({
          type: "NOTIFICATION_CREATED",
          recipientUserId: memberId,
          notification: expect.objectContaining({
            type: "ROOM_INVITATION_CREATED",
            invitationId: invitation.id,
          }),
        }),
        expect.objectContaining({
          type: "PUBLIC_ROOMS_INVALIDATED",
          message: expect.objectContaining({ roomId: room.id, roomRevision: 1 }),
        }),
      ]),
    );

    events.length = 0;
    const accepted = await rooms.acceptInvitation({
      actorUserId: memberId,
      invitationId: invitation.id,
    });
    expect(accepted.roomRevision).toBe(2);
    expect(events).toEqual([
      expect.objectContaining({
        type: "ROOM_EVENT",
        event: expect.objectContaining({
          kind: "ROOM_MEMBER_JOINED",
          roomId: room.id,
          roomRevision: 2,
          member: expect.objectContaining({ userId: memberId, role: "MEMBER" }),
        }),
      }),
      expect.objectContaining({
        type: "PUBLIC_ROOMS_INVALIDATED",
        message: expect.objectContaining({ roomId: room.id, roomRevision: 2 }),
      }),
    ]);

    events.length = 0;
    await rooms.removeMember({
      actorUserId: ownerId,
      roomId: room.id,
      memberUserId: memberId,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "ROOM_EVENT",
        event: expect.objectContaining({
          kind: "ROOM_MEMBER_REMOVED",
          roomId: room.id,
          roomRevision: 3,
          userId: memberId,
        }),
      }),
      expect.objectContaining({
        type: "NOTIFICATION_CREATED",
        recipientUserId: memberId,
        notification: expect.objectContaining({ type: "ROOM_MEMBER_REMOVED" }),
      }),
      expect.objectContaining({
        type: "PUBLIC_ROOMS_INVALIDATED",
        message: expect.objectContaining({ roomId: room.id, roomRevision: 3 }),
      }),
    ]);
    await expect(
      db
        .selectFrom("rooms")
        .select("roomRevision")
        .where("id", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ roomRevision: 3 });
  });

  it("publishes nothing and does not increment revision when a mutation rolls back", async () => {
    await createUser(ownerId, "owner");
    await createUser(memberId, "member");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Safe" });

    await expect(
      rooms.removeMember({
        actorUserId: ownerId,
        roomId: room.id,
        memberUserId: memberId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_TRANSITION" });
    expect(events).toEqual([]);
    await expect(
      db
        .selectFrom("rooms")
        .select("roomRevision")
        .where("id", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ roomRevision: 0 });
  });

  it("increments once for rename, access, invite, revoke, transfer, leave, and dissolve", async () => {
    const inviteeId = "018f8f8e-4b5c-7d6e-8f90-123456789b12";
    await createUser(ownerId, "owner");
    await createUser(memberId, "member");
    await createUser(outsiderId, "outsider");
    await createUser(inviteeId, "invitee");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Revision room" });
    await db
      .insertInto("roomMemberships")
      .values([
        { roomId: room.id, userId: memberId, role: "MEMBER", createdAt: now },
        { roomId: room.id, userId: outsiderId, role: "MEMBER", createdAt: now },
      ])
      .execute();

    await rooms.renameRoom({
      actorUserId: ownerId,
      roomId: room.id,
      name: "Revision room renamed",
    });
    await rooms.updateRoomAccess({
      actorUserId: ownerId,
      roomId: room.id,
      visibility: "PUBLIC",
      joinPolicy: "OPEN",
    });
    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId: room.id,
      username: "invitee",
    });
    await rooms.revokeInvitation({
      actorUserId: ownerId,
      roomId: room.id,
      invitationId: invitation.id,
    });
    await rooms.transferOwnership({
      actorUserId: ownerId,
      roomId: room.id,
      newOwnerUserId: memberId,
    });
    await rooms.leaveRoom({ actorUserId: outsiderId, roomId: room.id });
    await rooms.softDeleteRoom({ actorUserId: memberId, roomId: room.id });

    const roomEvents = events
      .filter((event) => event.type === "ROOM_EVENT")
      .map((event) => ({
        kind: event.event.kind,
        roomRevision: event.event.roomRevision,
      }));
    expect(roomEvents).toEqual([
      { kind: "ROOM_UPDATED", roomRevision: 1 },
      { kind: "ROOM_UPDATED", roomRevision: 2 },
      { kind: "ROOM_UPDATED", roomRevision: 3 },
      { kind: "ROOM_UPDATED", roomRevision: 4 },
      { kind: "ROOM_OWNER_TRANSFERRED", roomRevision: 5 },
      { kind: "ROOM_MEMBER_LEFT", roomRevision: 6 },
      { kind: "ROOM_DISSOLVED", roomRevision: 7 },
    ]);
    await expect(
      db
        .selectFrom("rooms")
        .select(["roomRevision", "roomEpoch", "deletedAt"])
        .where("id", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ roomRevision: 7, roomEpoch: 1, deletedAt: now });
    expect(
      events.some(
        (event) =>
          event.type === "NOTIFICATION_CREATED" &&
          event.recipientUserId === ownerId &&
          event.notification.type === "ROOM_DISSOLVED",
      ),
    ).toBe(true);
  });

  it("cancels pending join requests atomically when a public room becomes private", async () => {
    await createUser(ownerId, "owner");
    await createUser(memberId, "applicant");
    const room = await rooms.createRoom({
      actorUserId: ownerId,
      name: "Public study",
      visibility: "PUBLIC",
      joinPolicy: "APPROVAL",
    });
    await db
      .insertInto("roomJoinRequests")
      .values({
        id: requestId,
        roomId: room.id,
        applicantUserId: memberId,
        status: "PENDING",
        decidedByUserId: null,
        decisionClientOpId: null,
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
      })
      .execute();

    const updated = await rooms.updateRoomAccess({
      actorUserId: ownerId,
      roomId: room.id,
      visibility: "PRIVATE",
      joinPolicy: "INVITE_ONLY",
    });

    expect(updated).toMatchObject({
      visibility: "PRIVATE",
      joinPolicy: "INVITE_ONLY",
      roomRevision: 1,
    });
    await expect(
      db
        .selectFrom("roomJoinRequests")
        .select(["status", "decidedByUserId", "decidedAt"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "CANCELLED",
      decidedByUserId: ownerId,
      decidedAt: now,
    });
    const cancellationEvents = events.filter(
      (event) =>
        event.type === "NOTIFICATION_CREATED" &&
        event.notification.type === "ROOM_JOIN_REQUEST_CANCELLED",
    );
    expect(cancellationEvents).toHaveLength(2);
    expect(cancellationEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipientUserId: memberId }),
        expect.objectContaining({ recipientUserId: ownerId }),
      ]),
    );
    expect(
      events.some(
        (event) => event.type === "PUBLIC_ROOMS_INVALIDATED" && event.message.roomRevision === 1,
      ),
    ).toBe(true);
  });

  it("resolves a superseded request and carries pending requests to a new owner", async () => {
    await createUser(ownerId, "owner");
    await createUser(memberId, "Target.User");
    await createUser(outsiderId, "outsider");
    const room = await rooms.createRoom({
      actorUserId: ownerId,
      name: "Approval room",
      visibility: "PUBLIC",
      joinPolicy: "APPROVAL",
    });
    await db
      .insertInto("roomMemberships")
      .values({ roomId: room.id, userId: outsiderId, role: "MEMBER", createdAt: now })
      .execute();
    await db
      .insertInto("roomJoinRequests")
      .values({
        id: requestId,
        roomId: room.id,
        applicantUserId: memberId,
        status: "PENDING",
        decidedByUserId: null,
        decisionClientOpId: null,
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
      })
      .execute();
    const invitation = await rooms.inviteByUsername({
      actorUserId: ownerId,
      roomId: room.id,
      username: "Target.User",
    });

    events.length = 0;
    await rooms.acceptInvitation({ actorUserId: memberId, invitationId: invitation.id });
    await expect(
      db
        .selectFrom("roomJoinRequests")
        .select(["status", "decidedByUserId", "decidedAt"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "APPROVED",
      decidedByUserId: ownerId,
      decidedAt: now,
    });
    const approvals = events.filter(
      (event) =>
        event.type === "NOTIFICATION_CREATED" &&
        event.notification.type === "ROOM_JOIN_REQUEST_APPROVED",
    );
    expect(approvals).toHaveLength(2);
    expect(approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientUserId: memberId,
          notification: expect.objectContaining({ readAt: now.toISOString() }),
        }),
        expect.objectContaining({
          recipientUserId: ownerId,
          notification: expect.objectContaining({ readAt: null }),
        }),
      ]),
    );

    const pendingId = "018f8f8e-4b5c-7d6e-8f90-123456789b11";
    await db
      .insertInto("roomJoinRequests")
      .values({
        id: pendingId,
        roomId: room.id,
        applicantUserId: ownerId,
        status: "PENDING",
        decidedByUserId: null,
        decisionClientOpId: null,
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
      })
      .execute();
    events.length = 0;
    const transferred = await rooms.transferOwnership({
      actorUserId: ownerId,
      roomId: room.id,
      newOwnerUserId: outsiderId,
    });
    expect(transferred.roomRevision).toBe(3);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ROOM_EVENT",
          event: expect.objectContaining({
            kind: "ROOM_OWNER_TRANSFERRED",
            roomRevision: 3,
          }),
        }),
        expect.objectContaining({
          type: "NOTIFICATION_CREATED",
          recipientUserId: outsiderId,
          notification: expect.objectContaining({
            type: "ROOM_JOIN_REQUEST_CREATED",
            requestId: pendingId,
          }),
        }),
      ]),
    );
    await expect(
      db
        .selectFrom("roomJoinRequests")
        .select("status")
        .where("id", "=", pendingId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "PENDING" });
  });
});

describe("privacy-safe administrator room controls", () => {
  it("records only identifiers, lifecycle transitions, and the supplied reason code", async () => {
    await createAdministrator();
    await createUser(ownerId, "owner");
    await createUser(memberId, "member");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Sensitive project" });
    await db
      .insertInto("roomMemberships")
      .values({ roomId: room.id, userId: memberId, role: "MEMBER", createdAt: now })
      .execute();

    await rooms.administratorSoftDeleteRoom({
      administratorId,
      roomId: room.id,
      reasonCode: "ADMIN_CLEANUP",
    });
    await rooms.administratorRestoreRoom({
      administratorId,
      roomId: room.id,
      reasonCode: "ADMIN_RECOVERY",
    });
    await rooms.administratorTransferOwnership({
      administratorId,
      roomId: room.id,
      newOwnerUserId: memberId,
      reasonCode: "OWNER_RECOVERY",
    });

    await expect(
      db
        .selectFrom("rooms")
        .select(["roomRevision", "roomEpoch", "ownerUserId"])
        .where("id", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ roomRevision: 3, roomEpoch: 2, ownerUserId: memberId });
    expect(
      events
        .filter((event) => event.type === "ROOM_EVENT")
        .map((event) => [event.event.kind, event.event.roomRevision]),
    ).toEqual([
      ["ROOM_DISSOLVED", 1],
      ["ROOM_UPDATED", 2],
      ["ROOM_OWNER_TRANSFERRED", 3],
    ]);

    const auditEvents = await db
      .selectFrom("auditEvents")
      .select(["eventType", "targetId", "details"])
      .where("actorAdministratorId", "=", administratorId)
      .execute();
    expect(auditEvents).toHaveLength(3);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        {
          eventType: "administrator.room_soft_deleted",
          targetId: room.id,
          details: {
            ownerUserId: ownerId,
            previousLifecycle: "ACTIVE",
            lifecycle: "DELETED",
            reasonCode: "ADMIN_CLEANUP",
          },
        },
        {
          eventType: "administrator.room_restored",
          targetId: room.id,
          details: {
            ownerUserId: ownerId,
            previousLifecycle: "DELETED",
            lifecycle: "ACTIVE",
            reasonCode: "ADMIN_RECOVERY",
          },
        },
        {
          eventType: "ADMIN_ROOM_OWNERSHIP_TRANSFERRED",
          targetId: room.id,
          details: {
            previousOwnerUserId: ownerId,
            newOwnerUserId: memberId,
            reasonCode: "OWNER_RECOVERY",
          },
        },
      ]),
    );
    expect(JSON.stringify(auditEvents)).not.toMatch(
      /(?:url|title|favIconUrl|media|pointer|danmaku|anchor|points|stroke)/u,
    );
  });

  it("rejects an unsafe administrator reason without changing room lifecycle", async () => {
    await createAdministrator();
    await createUser(ownerId, "owner");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Protected" });

    await expect(
      rooms.administratorSoftDeleteRoom({
        administratorId,
        roomId: room.id,
        reasonCode: "https://private.example/path",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_INPUT" });

    const storedRoom = await db
      .selectFrom("rooms")
      .select(["deletedAt", "roomEpoch"])
      .where("id", "=", room.id)
      .executeTakeFirstOrThrow();
    expect(storedRoom).toEqual({ deletedAt: null, roomEpoch: 0 });
    const auditCount = await db
      .selectFrom("auditEvents")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(auditCount.count)).toBe(0);
  });

  it("requires a reason at the domain service boundary", async () => {
    await createAdministrator();
    await createUser(ownerId, "owner");
    const room = await rooms.createRoom({ actorUserId: ownerId, name: "Reason required" });

    await expect(
      rooms.administratorSoftDeleteRoom({
        administratorId,
        roomId: room.id,
        reasonCode: undefined,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_INPUT" });

    const storedRoom = await db
      .selectFrom("rooms")
      .select(["deletedAt", "roomEpoch"])
      .where("id", "=", room.id)
      .executeTakeFirstOrThrow();
    expect(storedRoom).toEqual({ deletedAt: null, roomEpoch: 0 });
  });
});
