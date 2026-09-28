import { createDatabase, migrateToLatest } from "@syncaction/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RoomService } from "../src/room-service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-27T12:00:00.000Z");
const administratorId = stableId(9_000);
let db: ReturnType<typeof createDatabase>;
let rooms: RoomService;

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  rooms = new RoomService({ db, now: () => now });
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(resetFixtures);
afterEach(resetFixtures);

function stableId(value: number): string {
  return `018f8f8e-4b5c-7d6e-8f90-${value.toString(16).padStart(12, "0")}`;
}

async function resetFixtures(): Promise<void> {
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("deviceSessions").execute();
  await db.deleteFrom("users").execute();
  await db
    .updateTable("serverPolicies")
    .set({ ordinaryActiveRoomLimit: 5, ordinaryOpenTabLimit: 20 })
    .where("id", "=", "GLOBAL")
    .execute();
}

async function createUser(value: number, label = `user-${value}`): Promise<string> {
  const id = stableId(value);
  await db
    .insertInto("users")
    .values({
      id,
      username: label,
      usernameNormalized: label.toLowerCase(),
      displayName: `${label} Display`,
      passwordHash: "hash",
      status: "ACTIVE",
    })
    .execute();
  return id;
}

async function createAdministrator(linkedUserId: string | null): Promise<void> {
  await db
    .insertInto("administrators")
    .values({
      id: administratorId,
      username: "root",
      usernameNormalized: "root",
      passwordHash: "hash",
      totpSecretCiphertext: "ciphertext",
      linkedUserId,
    })
    .execute();
}

async function createOrdinaryRoom(value: number): Promise<{ ownerId: string; roomId: string }> {
  const ownerId = await createUser(value);
  const room = await rooms.createRoom({ actorUserId: ownerId, name: `Room ${value}` });
  return { ownerId, roomId: room.id };
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await db
    .insertInto("roomMemberships")
    .values({ roomId, userId, role: "MEMBER", createdAt: now })
    .execute();
}

async function insertOpenTabs(roomId: string, count: number): Promise<void> {
  await db
    .insertInto("roomTabs")
    .values(
      Array.from({ length: count }, (_, index) => ({
        roomId,
        logicalTabId: stableId(20_000 + index),
        url: `https://example.test/private/${index}`,
        title: `Private title ${index}`,
        favIconUrl: null,
        position: index,
        createdAtSeq: index + 1,
        updatedAtSeq: index + 1,
        closedAtSeq: null,
      })),
    )
    .execute();
}

async function activeRoomCount(): Promise<number> {
  const result = await db
    .selectFrom("rooms")
    .select((expression) => expression.fn.countAll<number>().as("count"))
    .where("deletedAt", "is", null)
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

describe("transactional room capacity", () => {
  it("serializes concurrent creators at the global five-room boundary", async () => {
    for (let value = 1; value <= 4; value += 1) {
      await createOrdinaryRoom(value);
    }
    const firstOwnerId = await createUser(5);
    const secondOwnerId = await createUser(6);

    const attempts = await Promise.allSettled([
      rooms.createRoom({ actorUserId: firstOwnerId, name: "Concurrent A" }),
      rooms.createRoom({ actorUserId: secondOwnerId, name: "Concurrent B" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "ORDINARY_ROOM_LIMIT_REACHED" },
    });
    expect(await activeRoomCount()).toBe(5);
    const membershipCount = await db
      .selectFrom("roomMemberships")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(membershipCount.count)).toBe(5);
    const rejectionEvents = await db
      .selectFrom("auditEvents")
      .select([
        "actorUserId",
        "actorAdministratorId",
        "eventType",
        "targetType",
        "targetId",
        "details",
      ])
      .where("eventType", "=", "room.create_capacity_rejected")
      .execute();
    expect(rejectionEvents).toHaveLength(1);
    const rejectionEvent = rejectionEvents[0]!;
    expect([firstOwnerId, secondOwnerId]).toContain(rejectionEvent.actorUserId);
    expect(rejectionEvent).toEqual({
      actorUserId: rejectionEvent.actorUserId,
      actorAdministratorId: null,
      eventType: "room.create_capacity_rejected",
      targetType: "room",
      targetId: expect.any(String),
      details: {
        ownerUserId: rejectionEvent.actorUserId,
        quotaClass: "ORDINARY",
        reasonCode: "ORDINARY_ROOM_LIMIT_REACHED",
        activeOrdinaryRoomCount: 5,
        ordinaryActiveRoomLimit: 5,
      },
    });
    await expect(
      db
        .selectFrom("rooms")
        .select("id")
        .where("id", "=", rejectionEvent.targetId!)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("does not count soft-deleted rooms toward the ordinary limit", async () => {
    const fixtures = [];
    for (let value = 10; value < 15; value += 1) {
      fixtures.push(await createOrdinaryRoom(value));
    }

    await rooms.softDeleteRoom({
      actorUserId: fixtures[0]!.ownerId,
      roomId: fixtures[0]!.roomId,
    });
    await expect(createOrdinaryRoom(15)).resolves.toBeDefined();

    expect(await activeRoomCount()).toBe(5);
  });

  it("does not count rooms owned by the administrator-linked user", async () => {
    const linkedUserId = await createUser(30, "linked");
    await createAdministrator(linkedUserId);
    for (let index = 0; index < 7; index += 1) {
      await rooms.createRoom({ actorUserId: linkedUserId, name: `Exempt ${index}` });
    }
    for (let value = 31; value <= 35; value += 1) {
      await createOrdinaryRoom(value);
    }

    await expect(createOrdinaryRoom(36)).rejects.toMatchObject({
      code: "ORDINARY_ROOM_LIMIT_REACHED",
    });
    expect(await activeRoomCount()).toBe(12);
  });

  it("frees an ordinary slot when ownership moves to the linked user", async () => {
    const linkedUserId = await createUser(50, "linked");
    await createAdministrator(linkedUserId);
    const transferable = await createOrdinaryRoom(51);
    await addMember(transferable.roomId, linkedUserId);
    for (let value = 52; value <= 55; value += 1) {
      await createOrdinaryRoom(value);
    }

    await rooms.transferOwnership({
      actorUserId: transferable.ownerId,
      roomId: transferable.roomId,
      newOwnerUserId: linkedUserId,
    });
    await expect(
      db
        .selectFrom("auditEvents")
        .select([
          "actorUserId",
          "actorAdministratorId",
          "eventType",
          "targetType",
          "targetId",
          "details",
        ])
        .where("eventType", "=", "room.ownership_transferred")
        .where("targetId", "=", transferable.roomId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      actorUserId: transferable.ownerId,
      actorAdministratorId: null,
      eventType: "room.ownership_transferred",
      targetType: "room",
      targetId: transferable.roomId,
      details: {
        previousOwnerUserId: transferable.ownerId,
        newOwnerUserId: linkedUserId,
      },
    });

    await expect(createOrdinaryRoom(56)).resolves.toBeDefined();
    await expect(createOrdinaryRoom(57)).rejects.toMatchObject({
      code: "ORDINARY_ROOM_LIMIT_REACHED",
    });
  });

  it("atomically rejects linked-to-ordinary transfer without a free slot", async () => {
    const linkedUserId = await createUser(70, "linked");
    const targetUserId = await createUser(71, "target");
    await createAdministrator(linkedUserId);
    const exemptRoom = await rooms.createRoom({ actorUserId: linkedUserId, name: "Exempt" });
    await addMember(exemptRoom.id, targetUserId);
    const ordinaryRooms = [];
    for (let value = 72; value <= 76; value += 1) {
      ordinaryRooms.push(await createOrdinaryRoom(value));
    }

    await expect(
      rooms.transferOwnership({
        actorUserId: linkedUserId,
        roomId: exemptRoom.id,
        newOwnerUserId: targetUserId,
      }),
    ).rejects.toMatchObject({ code: "ORDINARY_ROOM_LIMIT_REACHED" });
    await expect(
      db
        .selectFrom("auditEvents")
        .select(["actorUserId", "actorAdministratorId", "eventType", "targetId", "details"])
        .where("eventType", "=", "room.ownership_transfer_capacity_rejected")
        .where("targetId", "=", exemptRoom.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      actorUserId: linkedUserId,
      actorAdministratorId: null,
      eventType: "room.ownership_transfer_capacity_rejected",
      targetId: exemptRoom.id,
      details: {
        previousOwnerUserId: linkedUserId,
        newOwnerUserId: targetUserId,
        quotaClass: "ORDINARY",
        reasonCode: "ORDINARY_ROOM_LIMIT_REACHED",
        activeOrdinaryRoomCount: 5,
        ordinaryActiveRoomLimit: 5,
      },
    });
    await expect(
      db
        .selectFrom("rooms")
        .select("ownerUserId")
        .where("id", "=", exemptRoom.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ ownerUserId: linkedUserId });
    await expect(
      db
        .selectFrom("roomMemberships")
        .select(["userId", "role"])
        .where("roomId", "=", exemptRoom.id)
        .orderBy("userId")
        .execute(),
    ).resolves.toEqual([
      { userId: linkedUserId, role: "OWNER" },
      { userId: targetUserId, role: "MEMBER" },
    ]);

    await rooms.softDeleteRoom({
      actorUserId: ordinaryRooms[0]!.ownerId,
      roomId: ordinaryRooms[0]!.roomId,
    });
    await expect(
      rooms.transferOwnership({
        actorUserId: linkedUserId,
        roomId: exemptRoom.id,
        newOwnerUserId: targetUserId,
      }),
    ).resolves.toMatchObject({ id: exemptRoom.id });
  });

  it("rejects an administrator transfer that would make 21 open tabs ordinary", async () => {
    const linkedUserId = await createUser(90, "linked");
    const targetUserId = await createUser(91, "target");
    await createAdministrator(linkedUserId);
    const exemptRoom = await rooms.createRoom({ actorUserId: linkedUserId, name: "Large exempt" });
    await addMember(exemptRoom.id, targetUserId);
    await insertOpenTabs(exemptRoom.id, 21);

    await expect(
      rooms.administratorTransferOwnership({
        administratorId,
        roomId: exemptRoom.id,
        newOwnerUserId: targetUserId,
        reasonCode: "OWNER_RECOVERY",
      }),
    ).rejects.toMatchObject({ code: "ROOM_TAB_LIMIT_REACHED" });
    const unchanged = await db
      .selectFrom("rooms")
      .select("ownerUserId")
      .where("id", "=", exemptRoom.id)
      .executeTakeFirstOrThrow();
    expect(unchanged.ownerUserId).toBe(linkedUserId);
    await expect(
      db
        .selectFrom("auditEvents")
        .select(["actorUserId", "actorAdministratorId", "eventType", "targetId", "details"])
        .where("eventType", "=", "room.ownership_transfer_capacity_rejected")
        .where("targetId", "=", exemptRoom.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      actorUserId: null,
      actorAdministratorId: administratorId,
      eventType: "room.ownership_transfer_capacity_rejected",
      targetId: exemptRoom.id,
      details: {
        previousOwnerUserId: linkedUserId,
        newOwnerUserId: targetUserId,
        quotaClass: "ORDINARY",
        reasonCode: "ROOM_TAB_LIMIT_REACHED",
        openTabCount: 21,
        ordinaryOpenTabLimit: 20,
      },
    });

    await db
      .updateTable("roomTabs")
      .set({ closedAtSeq: 22 })
      .where("roomId", "=", exemptRoom.id)
      .where("position", "=", 20)
      .execute();
    await expect(
      rooms.administratorTransferOwnership({
        administratorId,
        roomId: exemptRoom.id,
        newOwnerUserId: targetUserId,
        reasonCode: "OWNER_RECOVERY",
      }),
    ).resolves.toMatchObject({ id: exemptRoom.id });
  });

  it("rejects a public transfer that would make 21 open tabs ordinary", async () => {
    const linkedUserId = await createUser(100, "linked");
    const targetUserId = await createUser(101, "target");
    await createAdministrator(linkedUserId);
    const exemptRoom = await rooms.createRoom({
      actorUserId: linkedUserId,
      name: "Public large exempt",
    });
    await addMember(exemptRoom.id, targetUserId);
    await insertOpenTabs(exemptRoom.id, 21);

    await expect(
      rooms.transferOwnership({
        actorUserId: linkedUserId,
        roomId: exemptRoom.id,
        newOwnerUserId: targetUserId,
      }),
    ).rejects.toMatchObject({ code: "ROOM_TAB_LIMIT_REACHED" });
    await expect(
      db
        .selectFrom("auditEvents")
        .select(["actorUserId", "actorAdministratorId", "eventType", "targetId", "details"])
        .where("eventType", "=", "room.ownership_transfer_capacity_rejected")
        .where("targetId", "=", exemptRoom.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      actorUserId: linkedUserId,
      actorAdministratorId: null,
      eventType: "room.ownership_transfer_capacity_rejected",
      targetId: exemptRoom.id,
      details: {
        previousOwnerUserId: linkedUserId,
        newOwnerUserId: targetUserId,
        quotaClass: "ORDINARY",
        reasonCode: "ROOM_TAB_LIMIT_REACHED",
        openTabCount: 21,
        ordinaryOpenTabLimit: 20,
      },
    });
    await expect(
      db
        .selectFrom("rooms")
        .select("ownerUserId")
        .where("id", "=", exemptRoom.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ ownerUserId: linkedUserId });
  });

  it("rejects an administrator linked-to-ordinary transfer at five ordinary rooms", async () => {
    const linkedUserId = await createUser(102, "linked");
    const targetUserId = await createUser(103, "target");
    await createAdministrator(linkedUserId);
    const exemptRoom = await rooms.createRoom({
      actorUserId: linkedUserId,
      name: "Admin transfer exempt",
    });
    await addMember(exemptRoom.id, targetUserId);
    for (let value = 104; value <= 108; value += 1) {
      await createOrdinaryRoom(value);
    }

    await expect(
      rooms.administratorTransferOwnership({
        administratorId,
        roomId: exemptRoom.id,
        newOwnerUserId: targetUserId,
        reasonCode: "OWNER_RECOVERY",
      }),
    ).rejects.toMatchObject({ code: "ORDINARY_ROOM_LIMIT_REACHED" });
    await expect(
      db
        .selectFrom("rooms")
        .select("ownerUserId")
        .where("id", "=", exemptRoom.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ ownerUserId: linkedUserId });
    await expect(
      db
        .selectFrom("auditEvents")
        .select(["actorUserId", "actorAdministratorId", "eventType", "targetId", "details"])
        .where("eventType", "=", "room.ownership_transfer_capacity_rejected")
        .where("targetId", "=", exemptRoom.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      actorUserId: null,
      actorAdministratorId: administratorId,
      eventType: "room.ownership_transfer_capacity_rejected",
      targetId: exemptRoom.id,
      details: {
        previousOwnerUserId: linkedUserId,
        newOwnerUserId: targetUserId,
        quotaClass: "ORDINARY",
        reasonCode: "ORDINARY_ROOM_LIMIT_REACHED",
        activeOrdinaryRoomCount: 5,
        ordinaryActiveRoomLimit: 5,
      },
    });
  });

  it("enforces capacity on administrator restore and audits lifecycle facts only", async () => {
    await createAdministrator(null);
    const original = await createOrdinaryRoom(110);
    const ordinaryRooms = [];
    for (let value = 111; value <= 114; value += 1) {
      ordinaryRooms.push(await createOrdinaryRoom(value));
    }

    await rooms.administratorSoftDeleteRoom({
      administratorId,
      roomId: original.roomId,
      reasonCode: "ADMIN_CLEANUP",
    });
    await expect(
      db
        .selectFrom("rooms")
        .select(["deletedAt", "roomEpoch"])
        .where("id", "=", original.roomId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deletedAt: now, roomEpoch: 1 });
    const replacement = await createOrdinaryRoom(115);
    await expect(
      rooms.administratorRestoreRoom({
        administratorId,
        roomId: original.roomId,
        reasonCode: "ADMIN_RECOVERY",
      }),
    ).rejects.toMatchObject({ code: "ORDINARY_ROOM_LIMIT_REACHED" });
    await expect(
      db
        .selectFrom("rooms")
        .select("deletedAt")
        .where("id", "=", original.roomId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deletedAt: now });

    await rooms.administratorSoftDeleteRoom({
      administratorId,
      roomId: replacement.roomId,
      reasonCode: "ADMIN_CLEANUP",
    });
    await rooms.administratorRestoreRoom({
      administratorId,
      roomId: original.roomId,
      reasonCode: "ADMIN_RECOVERY",
    });
    expect(await activeRoomCount()).toBe(5);
    await expect(
      db
        .selectFrom("rooms")
        .select(["deletedAt", "roomEpoch"])
        .where("id", "=", original.roomId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deletedAt: null, roomEpoch: 2 });

    const events = await db
      .selectFrom("auditEvents")
      .select(["actorUserId", "actorAdministratorId", "eventType", "targetId", "details"])
      .orderBy("id")
      .execute();
    expect(events).toEqual([
      {
        actorUserId: null,
        actorAdministratorId: administratorId,
        eventType: "administrator.room_soft_deleted",
        targetId: original.roomId,
        details: {
          ownerUserId: original.ownerId,
          previousLifecycle: "ACTIVE",
          lifecycle: "DELETED",
          reasonCode: "ADMIN_CLEANUP",
        },
      },
      {
        actorUserId: null,
        actorAdministratorId: administratorId,
        eventType: "room.restore_capacity_rejected",
        targetId: original.roomId,
        details: {
          ownerUserId: original.ownerId,
          quotaClass: "ORDINARY",
          reasonCode: "ORDINARY_ROOM_LIMIT_REACHED",
          activeOrdinaryRoomCount: 5,
          ordinaryActiveRoomLimit: 5,
        },
      },
      {
        actorUserId: null,
        actorAdministratorId: administratorId,
        eventType: "administrator.room_soft_deleted",
        targetId: replacement.roomId,
        details: {
          ownerUserId: replacement.ownerId,
          previousLifecycle: "ACTIVE",
          lifecycle: "DELETED",
          reasonCode: "ADMIN_CLEANUP",
        },
      },
      {
        actorUserId: null,
        actorAdministratorId: administratorId,
        eventType: "administrator.room_restored",
        targetId: original.roomId,
        details: {
          ownerUserId: original.ownerId,
          previousLifecycle: "DELETED",
          lifecycle: "ACTIVE",
          reasonCode: "ADMIN_RECOVERY",
        },
      },
    ]);

    await expect(
      rooms.administratorSoftDeleteRoom({
        administratorId: stableId(9_001),
        roomId: original.roomId,
        reasonCode: "ADMIN_CLEANUP",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_TRANSITION" });
    await expect(
      rooms.administratorRestoreRoom({
        administratorId: stableId(9_001),
        roomId: replacement.roomId,
        reasonCode: "ADMIN_RECOVERY",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_TRANSITION" });
    await expect(
      db
        .selectFrom("rooms")
        .select("deletedAt")
        .where("id", "=", replacement.roomId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deletedAt: now });
  });

  it("keeps an ordinary 21-tab room deleted when administrator restore is rejected", async () => {
    await createAdministrator(null);
    const ordinaryRoom = await createOrdinaryRoom(120);
    await insertOpenTabs(ordinaryRoom.roomId, 21);
    await rooms.administratorSoftDeleteRoom({
      administratorId,
      roomId: ordinaryRoom.roomId,
      reasonCode: "ADMIN_CLEANUP",
    });

    await expect(
      rooms.administratorRestoreRoom({
        administratorId,
        roomId: ordinaryRoom.roomId,
        reasonCode: "ADMIN_RECOVERY",
      }),
    ).rejects.toMatchObject({ code: "ROOM_TAB_LIMIT_REACHED" });
    await expect(
      db
        .selectFrom("rooms")
        .select("deletedAt")
        .where("id", "=", ordinaryRoom.roomId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deletedAt: now });
    const auditEvents = await db
      .selectFrom("auditEvents")
      .select(["actorUserId", "actorAdministratorId", "eventType", "targetId", "details"])
      .where("targetId", "=", ordinaryRoom.roomId)
      .orderBy("id")
      .execute();
    expect(auditEvents).toEqual([
      {
        actorUserId: null,
        actorAdministratorId: administratorId,
        eventType: "administrator.room_soft_deleted",
        targetId: ordinaryRoom.roomId,
        details: {
          ownerUserId: ordinaryRoom.ownerId,
          previousLifecycle: "ACTIVE",
          lifecycle: "DELETED",
          reasonCode: "ADMIN_CLEANUP",
        },
      },
      {
        actorUserId: null,
        actorAdministratorId: administratorId,
        eventType: "room.restore_capacity_rejected",
        targetId: ordinaryRoom.roomId,
        details: {
          ownerUserId: ordinaryRoom.ownerId,
          quotaClass: "ORDINARY",
          reasonCode: "ROOM_TAB_LIMIT_REACHED",
          openTabCount: 21,
          ordinaryOpenTabLimit: 20,
        },
      },
    ]);
  });

  it("restores an exempt room without consuming an ordinary slot", async () => {
    const linkedUserId = await createUser(130, "linked");
    await createAdministrator(linkedUserId);
    const exemptRoom = await rooms.createRoom({
      actorUserId: linkedUserId,
      name: "Exempt deleted",
    });
    await rooms.administratorSoftDeleteRoom({
      administratorId,
      roomId: exemptRoom.id,
      reasonCode: "ADMIN_CLEANUP",
    });
    for (let value = 131; value <= 135; value += 1) {
      await createOrdinaryRoom(value);
    }

    await expect(
      rooms.administratorRestoreRoom({
        administratorId,
        roomId: exemptRoom.id,
        reasonCode: "ADMIN_RECOVERY",
      }),
    ).resolves.toBeUndefined();
    expect(await activeRoomCount()).toBe(6);
  });

  it("exports the shared locked policy and owner classification contract", async () => {
    const ordinaryUserId = await createUser(150, "ordinary");
    const linkedUserId = await createUser(151, "linked");
    await createAdministrator(linkedUserId);
    const policyModule = await import("../src/capacity-policy.js");

    await db.transaction().execute(async (transaction) => {
      const policy = await policyModule.lockCapacityPolicy(transaction);
      expect(policy).toMatchObject({
        id: "GLOBAL",
        ordinaryActiveRoomLimit: 5,
        ordinaryOpenTabLimit: 20,
      });
      await expect(policyModule.classifyOwner(transaction, ordinaryUserId)).resolves.toBe(
        "ORDINARY",
      );
      await expect(policyModule.classifyOwner(transaction, linkedUserId)).resolves.toBe("EXEMPT");
    });
  });
});
