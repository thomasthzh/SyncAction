import { createDatabase, migrateToLatest } from "@syncaction/database";
import { RoomPresenceService } from "../src/presence-service.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const ownerId = "018f8f8e-4b5c-7d6e-8f90-123456789a01";
const outsiderId = "018f8f8e-4b5c-7d6e-8f90-123456789a02";
const ownerDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789a03";
const outsiderDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789a04";
const ownerSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789a05";
const outsiderSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789a06";
const ownerSecondDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789a14";
const ownerSecondSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789a15";
const ownerFamilyId = "018f8f8e-4b5c-7d6e-8f90-123456789a10";
const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789a07";
const activeTabId = "018f8f8e-4b5c-7d6e-8f90-123456789a08";
const closedTabId = "018f8f8e-4b5c-7d6e-8f90-123456789a09";
const secondRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789a16";
const secondRoomTabId = "018f8f8e-4b5c-7d6e-8f90-123456789a17";
let now = new Date("2026-07-27T00:00:00.000Z");
let db: ReturnType<typeof createDatabase>;
let presence: RoomPresenceService;

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  now = new Date("2026-07-27T00:00:00.000Z");
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await db
    .insertInto("users")
    .values([
      {
        id: ownerId,
        username: "owner",
        usernameNormalized: "owner",
        displayName: "Owner",
        passwordHash: "hash",
        status: "ACTIVE",
      },
      {
        id: outsiderId,
        username: "outsider",
        usernameNormalized: "outsider",
        displayName: "Outsider",
        passwordHash: "hash",
        status: "ACTIVE",
      },
    ])
    .execute();
  await db
    .insertInto("deviceSessions")
    .values([
      {
        id: ownerSessionId,
        userId: ownerId,
        deviceId: ownerDeviceId,
        refreshTokenHash: "a".repeat(64),
        tokenFamilyId: ownerFamilyId,
        expiresAt: new Date(now.getTime() + 86_400_000),
        usedAt: null,
        revokedAt: null,
        replacedBySessionId: null,
      },
      {
        id: outsiderSessionId,
        userId: outsiderId,
        deviceId: outsiderDeviceId,
        refreshTokenHash: "b".repeat(64),
        tokenFamilyId: "00000000-0000-7000-8000-000000000011",
        expiresAt: new Date(now.getTime() + 86_400_000),
        usedAt: null,
        revokedAt: null,
        replacedBySessionId: null,
      },
      {
        id: ownerSecondSessionId,
        userId: ownerId,
        deviceId: ownerSecondDeviceId,
        refreshTokenHash: "d".repeat(64),
        tokenFamilyId: "00000000-0000-7000-8000-000000000018",
        expiresAt: new Date(now.getTime() + 86_400_000),
        usedAt: null,
        revokedAt: null,
        replacedBySessionId: null,
      },
    ])
    .execute();
  await db
    .insertInto("rooms")
    .values([
      { id: roomId, name: "Presence", ownerUserId: ownerId, deletedAt: null },
      { id: secondRoomId, name: "Second Presence", ownerUserId: ownerId, deletedAt: null },
    ])
    .execute();
  await db
    .insertInto("roomMemberships")
    .values([
      { roomId, userId: ownerId, role: "OWNER" },
      { roomId: secondRoomId, userId: ownerId, role: "OWNER" },
    ])
    .execute();
  await db
    .insertInto("roomTabs")
    .values([
      {
        roomId,
        logicalTabId: activeTabId,
        url: "https://example.com/active",
        title: "Active",
        favIconUrl: null,
        position: 0,
        createdAtSeq: 1,
        updatedAtSeq: 1,
        closedAtSeq: null,
      },
      {
        roomId,
        logicalTabId: closedTabId,
        url: "https://example.com/closed",
        title: "Closed",
        favIconUrl: null,
        position: 1,
        createdAtSeq: 2,
        updatedAtSeq: 3,
        closedAtSeq: 3,
      },
      {
        roomId: secondRoomId,
        logicalTabId: secondRoomTabId,
        url: "https://example.com/second",
        title: "Second",
        favIconUrl: null,
        position: 0,
        createdAtSeq: 1,
        updatedAtSeq: 1,
        closedAtSeq: null,
      },
    ])
    .execute();
  presence = new RoomPresenceService({ db, now: () => now });
});

function ownerPrincipal() {
  return {
    userId: ownerId,
    deviceId: ownerDeviceId,
    sessionId: ownerSessionId,
  };
}

function ownerSecondPrincipal() {
  return {
    userId: ownerId,
    deviceId: ownerSecondDeviceId,
    sessionId: ownerSecondSessionId,
  };
}

function update(logicalTabId: string | null = activeTabId, targetRoomId: string = roomId) {
  return {
    type: "presence.update",
    protocolVersion: 1,
    roomId: targetRoomId,
    logicalTabId,
  };
}

function updateV2(
  options: {
    logicalTabId?: string | null;
    targetRoomId?: string;
    media?: { provider: "YOUTUBE"; mediaKey: string } | null;
    contentSignature?: { signatureVersion: 1; digest: string } | null;
  } = {},
) {
  const logicalTabId = options.logicalTabId === undefined ? activeTabId : options.logicalTabId;
  const targetRoomId = options.targetRoomId ?? roomId;
  return {
    type: "presence.update.v2",
    protocolVersion: 1,
    roomId: targetRoomId,
    logicalTabId,
    contentContext:
      logicalTabId === null
        ? null
        : {
            documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
            canonicalPageIdentity: `page:${logicalTabId}`,
            contentSignature:
              options.contentSignature === undefined
                ? { signatureVersion: 1 as const, digest: "A".repeat(43) }
                : options.contentSignature,
            media:
              options.media === undefined
                ? {
                    provider: "YOUTUBE" as const,
                    mediaKey: "youtube:dQw4w9WgXcQ",
                  }
                : options.media,
          },
  };
}

describe("RoomPresenceService", () => {
  it("starts sequence one with an upsert without writing durable synchronization tables", async () => {
    const before = await durableCounts();

    const result = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });

    expect(result).toMatchObject({
      ack: { roomId, expiresAt: now.getTime() + 30_000 },
      delta: {
        type: "presence.delta.v2",
        roomId,
        fromPresenceSeq: 0,
        toPresenceSeq: 1,
        changes: [
          {
            kind: "UPSERT",
            presence: {
              userId: ownerId,
              username: "owner",
              displayName: "Owner",
              deviceId: ownerDeviceId,
              logicalTabId: activeTabId,
              contentContext: null,
            },
          },
        ],
      },
      onlineUserSetChanged: true,
    });
    expect(presence.snapshotV2(roomId)).toMatchObject({
      presenceSeq: 1,
      presences: [expect.objectContaining({ userId: ownerId, contentContext: null })],
    });
    expect(presence.snapshot(roomId).presences[0]).not.toHaveProperty("contentContext");
    await expect(durableCounts()).resolves.toEqual(before);
  });

  it("renews byte-identical context without a delta and sequences real context changes", async () => {
    const first = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: updateV2(),
    });
    now = new Date(now.getTime() + 1_000);
    const renewal = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: updateV2(),
    });
    const changed = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: updateV2({ media: null, contentSignature: null }),
    });
    const legacyChanged = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });
    const legacyRenewal = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });

    expect(first.delta).toMatchObject({ fromPresenceSeq: 0, toPresenceSeq: 1 });
    expect(renewal).toMatchObject({
      ack: { expiresAt: now.getTime() + 30_000 },
      delta: null,
      onlineUserSetChanged: false,
    });
    expect(changed.delta).toMatchObject({
      fromPresenceSeq: 1,
      toPresenceSeq: 2,
      changes: [{ kind: "UPSERT", presence: { contentContext: { media: null } } }],
    });
    expect(legacyChanged.delta).toMatchObject({
      fromPresenceSeq: 2,
      toPresenceSeq: 3,
      changes: [{ kind: "UPSERT", presence: { contentContext: null } }],
    });
    expect(legacyRenewal.delta).toBeNull();
    expect(presence.snapshotV2(roomId).presenceSeq).toBe(3);
  });

  it("reports online outside shared tabs and emits a remove delta at the lease boundary", async () => {
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(null),
    });
    expect(presence.snapshot(roomId).presences[0]?.logicalTabId).toBeNull();

    now = new Date(now.getTime() + 29_999);
    expect(presence.sweep()).toEqual([]);
    now = new Date(now.getTime() + 1);
    expect(presence.sweep()).toEqual([
      {
        delta: expect.objectContaining({
          roomId,
          fromPresenceSeq: 1,
          toPresenceSeq: 2,
          changes: [{ kind: "REMOVE", userId: ownerId, deviceId: ownerDeviceId }],
        }),
        onlineUserSetChanged: true,
      },
    ]);
    expect(presence.snapshotV2(roomId)).toMatchObject({ presenceSeq: 2, presences: [] });
  });

  it("returns fresh distinct online-user sets without consuming the required sweep delta", async () => {
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(null),
    });
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner-replacement",
      update: update(),
    });

    const global = presence.onlineUserIds();
    const inRoom = presence.onlineUserIds(roomId);
    expect(global).toEqual(new Set([ownerId]));
    expect(inRoom).toEqual(new Set([ownerId]));
    expect(global).not.toBe(presence.onlineUserIds());
    expect(inRoom).not.toBe(presence.onlineUserIds(roomId));

    now = new Date(now.getTime() + 30_000);
    expect(presence.onlineUserIds()).toEqual(new Set());
    expect(presence.onlineUserIds(roomId)).toEqual(new Set());
    expect(presence.snapshotV2(roomId).presenceSeq).toBe(2);
    expect(presence.sweep()[0]?.delta).toMatchObject({
      fromPresenceSeq: 2,
      toPresenceSeq: 3,
      changes: [{ kind: "REMOVE", userId: ownerId, deviceId: ownerDeviceId }],
    });
  });

  it("reports a returning user online when an expired lease is renewed before sweep", async () => {
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });
    now = new Date(now.getTime() + 30_000);
    expect(presence.onlineUserIds(roomId)).toEqual(new Set());

    const renewal = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });

    expect(renewal).toMatchObject({
      delta: {
        fromPresenceSeq: 1,
        toPresenceSeq: 3,
        changes: [
          { kind: "REMOVE", userId: ownerId, deviceId: ownerDeviceId },
          {
            kind: "UPSERT",
            presence: { userId: ownerId, deviceId: ownerDeviceId },
          },
        ],
      },
      onlineUserSetChanged: true,
    });
  });

  it("does not let a stale socket disconnect remove a replacement lease", async () => {
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-old",
      update: update(),
    });
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-new",
      update: update(null),
    });

    expect(presence.removeSocket("socket-old")).toEqual([]);
    expect(presence.snapshot(roomId).presences).toHaveLength(1);
    expect(presence.removeSocket("socket-new")).toEqual([
      {
        delta: expect.objectContaining({
          roomId,
          fromPresenceSeq: 2,
          toPresenceSeq: 3,
          changes: [{ kind: "REMOVE", userId: ownerId, deviceId: ownerDeviceId }],
        }),
        onlineUserSetChanged: true,
      },
    ]);
  });

  it("changes public online membership only for the first and last device", async () => {
    const firstDevice = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });
    const secondDevice = await presence.update({
      principal: ownerSecondPrincipal(),
      socketId: "socket-owner-second",
      update: update(),
    });
    const firstRemoval = presence.removeSocket("socket-owner");
    const lastRemoval = presence.removeSocket("socket-owner-second");

    expect(firstDevice.onlineUserSetChanged).toBe(true);
    expect(secondDevice).toMatchObject({
      delta: { fromPresenceSeq: 1, toPresenceSeq: 2 },
      onlineUserSetChanged: false,
    });
    expect(firstRemoval).toEqual([
      {
        delta: expect.objectContaining({ fromPresenceSeq: 2, toPresenceSeq: 3 }),
        onlineUserSetChanged: false,
      },
    ]);
    expect(lastRemoval).toEqual([
      {
        delta: expect.objectContaining({ fromPresenceSeq: 3, toPresenceSeq: 4 }),
        onlineUserSetChanged: true,
      },
    ]);
  });

  it("keeps sequences independent per room and never advances after failed authorization", async () => {
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });
    const secondRoom = await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(secondRoomTabId, secondRoomId),
    });

    await expect(
      presence.update({
        principal: {
          userId: outsiderId,
          deviceId: outsiderDeviceId,
          sessionId: outsiderSessionId,
        },
        socketId: "socket-outsider",
        update: update(),
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });

    expect(secondRoom.delta).toMatchObject({ fromPresenceSeq: 0, toPresenceSeq: 1 });
    expect(presence.snapshotV2(roomId).presenceSeq).toBe(1);
    expect(presence.snapshotV2(secondRoomId).presenceSeq).toBe(1);
  });

  it("authorizes pointers only through a recent exact socket and logical-tab lease", async () => {
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });

    expect(
      presence.authorizePointer({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId: activeTabId,
      }),
    ).toEqual({
      userId: ownerId,
      username: "owner",
      displayName: "Owner",
      deviceId: ownerDeviceId,
      logicalTabId: activeTabId,
      expiresAt: now.getTime() + 30_000,
    });

    for (const mismatch of [
      { socketId: "socket-stale" },
      { logicalTabId: closedTabId },
      { roomId: "018f8f8e-4b5c-7d6e-8f90-123456789a13" },
      {
        principal: {
          ...ownerPrincipal(),
          deviceId: outsiderDeviceId,
        },
      },
    ]) {
      expect(() =>
        presence.authorizePointer({
          principal: ownerPrincipal(),
          socketId: "socket-owner",
          roomId,
          logicalTabId: activeTabId,
          ...mismatch,
        }),
      ).toThrow(expect.objectContaining({ code: "ROOM_NOT_FOUND" }));
    }

    now = new Date(now.getTime() + 12_001);
    expect(() =>
      presence.authorizePointer({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId: activeTabId,
      }),
    ).toThrow(expect.objectContaining({ code: "ROOM_NOT_FOUND" }));
  });

  it("reuses recent presence for room and exact-document authorization", async () => {
    await presence.update({
      principal: ownerPrincipal(),
      socketId: "socket-owner",
      update: update(),
    });

    expect(
      presence.authorizeRecent({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        roomId,
      }),
    ).toMatchObject({
      userId: ownerId,
      deviceId: ownerDeviceId,
      logicalTabId: activeTabId,
    });
    expect(
      presence.authorizeRecent({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId: activeTabId,
        frameKey: "frame:sha256-0123456789abcdef0123456789abcdef",
        maxValidationAgeMs: 12_000,
      }),
    ).toMatchObject({ logicalTabId: activeTabId });
    expect(presence.hasRoomEntries(roomId)).toBe(true);

    expect(() =>
      presence.authorizeRecent({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId: closedTabId,
      }),
    ).toThrow(expect.objectContaining({ code: "ROOM_NOT_FOUND" }));
    expect(() =>
      presence.authorizeRecent({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId: activeTabId,
        frameKey: "frame:2",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_SYNC_MESSAGE" }));

    now = new Date(now.getTime() + 30_000);
    expect(presence.hasRoomEntries(roomId)).toBe(false);
  });

  it("accepts a normal refresh successor but rejects a revoked original session lineage", async () => {
    const successorId = "018f8f8e-4b5c-7d6e-8f90-123456789a12";
    await db
      .insertInto("deviceSessions")
      .values({
        id: successorId,
        userId: ownerId,
        deviceId: ownerDeviceId,
        refreshTokenHash: "c".repeat(64),
        tokenFamilyId: ownerFamilyId,
        generation: 1,
        expiresAt: new Date(now.getTime() + 86_400_000),
        usedAt: null,
        revokedAt: null,
        replacedBySessionId: null,
      })
      .execute();
    await db
      .updateTable("deviceSessions")
      .set({ usedAt: now, replacedBySessionId: successorId })
      .where("id", "=", ownerSessionId)
      .execute();

    await expect(
      presence.update({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        update: update(),
      }),
    ).resolves.toMatchObject({ ack: { roomId } });

    await db
      .updateTable("deviceSessions")
      .set({ revokedAt: now })
      .where("id", "=", ownerSessionId)
      .execute();
    await expect(
      presence.update({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        update: update(),
      }),
    ).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
  });

  it("rejects outsiders, closed tabs, revoked devices, and spoofed identity fields", async () => {
    await expect(
      presence.update({
        principal: {
          userId: outsiderId,
          deviceId: outsiderDeviceId,
          sessionId: outsiderSessionId,
        },
        socketId: "socket-outsider",
        update: update(),
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    await expect(
      presence.update({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        update: update(closedTabId),
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    await expect(
      presence.update({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        update: { ...update(), username: "spoofed" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_SYNC_MESSAGE" });
    await db
      .updateTable("deviceSessions")
      .set({ revokedAt: now })
      .where("id", "=", ownerSessionId)
      .execute();
    await expect(
      presence.update({
        principal: ownerPrincipal(),
        socketId: "socket-owner",
        update: update(),
      }),
    ).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
    expect(presence.snapshot(roomId).presences).toEqual([]);
  });
});

async function durableCounts(): Promise<{
  operations: number;
  snapshots: number;
  tabs: number;
}> {
  const [operations, snapshots, tabs] = await Promise.all([
    db
      .selectFrom("roomOperations")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .execute(),
    db
      .selectFrom("roomSnapshots")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .execute(),
    db
      .selectFrom("roomTabs")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .execute(),
  ]);
  return {
    operations: Number(operations[0]?.count ?? 0),
    snapshots: Number(snapshots[0]?.count ?? 0),
    tabs: Number(tabs[0]?.count ?? 0),
  };
}
