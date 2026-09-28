import { createDatabase, migrateToLatest } from "@syncaction/database";
import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  MediaTargetSchema,
  RoomIdSchema,
  type PresenceRecord,
} from "@syncaction/protocol";
import {
  DocumentAuthorizationService,
  type PresencePrincipal,
  type RecentPresenceAuthorizationPort,
} from "../src/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const ownerId = "018f8f8e-4b5c-4d6e-8f90-423456789a01";
const outsiderId = "018f8f8e-4b5c-4d6e-8f90-423456789a02";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-423456789a03");
const sessionId = "018f8f8e-4b5c-4d6e-8f90-423456789a04";
const roomId = RoomIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-423456789a05");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-423456789a06");
const ordinaryTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-423456789a07");
const closedTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-423456789a08");
const memberId = "018f8f8e-4b5c-4d6e-8f90-423456789a09";
const memberDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-423456789a0a");
const memberSessionId = "018f8f8e-4b5c-4d6e-8f90-423456789a0b";
const stableFrameKey = "frame:sha256-0123456789abcdef0123456789abcdef";
const nowMs = new Date("2026-07-27T00:00:00.000Z").getTime();
let db: ReturnType<typeof createDatabase>;

class FakeRecentPresence implements RecentPresenceAuthorizationPort {
  public lastInput: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId?: unknown;
    frameKey?: unknown;
    maxValidationAgeMs?: number;
  } | null = null;

  public authorizeRecent(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId?: unknown;
    frameKey?: unknown;
    maxValidationAgeMs?: number;
  }): PresenceRecord {
    this.lastInput = input;
    const isOwner =
      input.principal.userId === ownerId &&
      input.principal.deviceId === deviceId &&
      input.principal.sessionId === sessionId &&
      input.socketId === "socket-owner";
    const isMember =
      input.principal.userId === memberId &&
      input.principal.deviceId === memberDeviceId &&
      input.principal.sessionId === memberSessionId &&
      input.socketId === "socket-member";
    if (
      (!isOwner && !isMember) ||
      input.roomId !== roomId ||
      (input.logicalTabId !== undefined &&
        input.logicalTabId !== logicalTabId &&
        input.logicalTabId !== ordinaryTabId &&
        input.logicalTabId !== closedTabId)
    ) {
      throw Object.assign(new Error("ROOM_NOT_FOUND"), { code: "ROOM_NOT_FOUND" });
    }
    return {
      userId: isOwner ? ownerId : memberId,
      username: isOwner ? "owner" : "member",
      displayName: isOwner ? "Owner" : "Member",
      deviceId: isOwner ? deviceId : memberDeviceId,
      logicalTabId:
        input.logicalTabId === undefined
          ? logicalTabId
          : LogicalTabIdSchema.parse(input.logicalTabId),
      expiresAt: nowMs + 30_000,
    };
  }

  public hasRoomEntries(roomIdInput: unknown): boolean {
    return roomIdInput === roomId;
  }
}

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
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
      {
        id: memberId,
        username: "member",
        usernameNormalized: "member",
        displayName: "Member",
        passwordHash: "hash",
        status: "ACTIVE",
      },
    ])
    .execute();
  await db
    .insertInto("rooms")
    .values({
      id: roomId,
      name: "Document authorization",
      ownerUserId: ownerId,
      roomEpoch: 4,
      serverSeq: 12,
      deletedAt: null,
    })
    .execute();
  await db
    .insertInto("roomMemberships")
    .values([
      { roomId, userId: ownerId, role: "OWNER" },
      { roomId, userId: memberId, role: "MEMBER" },
    ])
    .execute();
  await db
    .insertInto("roomTabs")
    .values([
      {
        roomId,
        logicalTabId,
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=40#comments",
        title: "Never return this title",
        favIconUrl: null,
        position: 0,
        createdAtSeq: 1,
        updatedAtSeq: 12,
        closedAtSeq: null,
      },
      {
        roomId,
        logicalTabId: ordinaryTabId,
        url: "https://example.com/a?b=1#private",
        title: "Private ordinary title",
        favIconUrl: null,
        position: 1,
        createdAtSeq: 2,
        updatedAtSeq: 11,
        closedAtSeq: null,
      },
      {
        roomId,
        logicalTabId: closedTabId,
        url: "https://example.com/closed",
        title: "Closed",
        favIconUrl: null,
        position: 2,
        createdAtSeq: 3,
        updatedAtSeq: 10,
        closedAtSeq: 10,
      },
    ])
    .execute();
});

function principal(userId = ownerId): PresencePrincipal {
  const isMember = userId === memberId;
  return {
    userId,
    deviceId: isMember ? memberDeviceId : deviceId,
    sessionId: isMember ? memberSessionId : sessionId,
  };
}

describe("DocumentAuthorizationService", () => {
  it("authorizes a recent exact committed document and returns only canonical identity", async () => {
    const presence = new FakeRecentPresence();
    const authorization = new DocumentAuthorizationService({ db, presence });
    const result = await authorization.authorize({
      principal: principal(),
      socketId: "socket-owner",
      roomId,
      logicalTabId,
      documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 12 },
      frameKey: "top",
      maxValidationAgeMs: 12_000,
    });

    expect(result).toEqual({
      roomId,
      logicalTabId,
      documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 12 },
      canonicalPageIdentity: "youtube:dQw4w9WgXcQ",
      role: "OWNER",
      frameKey: "top",
      member: {
        userId: ownerId,
        username: "owner",
        displayName: "Owner",
        deviceId,
        logicalTabId,
        expiresAt: nowMs + 30_000,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/watch\?|comments|Never return|https?:/u);
    expect(presence.lastInput).toMatchObject({
      socketId: "socket-owner",
      roomId,
      logicalTabId,
      frameKey: "top",
      maxValidationAgeMs: 12_000,
    });
  });

  it("returns the durable member role and validated stable frame context", async () => {
    const authorization = new DocumentAuthorizationService({
      db,
      presence: new FakeRecentPresence(),
    });

    await expect(
      authorization.authorize({
        principal: principal(memberId),
        socketId: "socket-member",
        roomId,
        logicalTabId,
        documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 12 },
        frameKey: stableFrameKey,
      }),
    ).resolves.toMatchObject({
      roomId,
      logicalTabId,
      canonicalPageIdentity: "youtube:dQw4w9WgXcQ",
      role: "MEMBER",
      frameKey: stableFrameKey,
      member: {
        userId: memberId,
        deviceId: memberDeviceId,
      },
    });
  });

  it("accepts only the provider media key derived from the committed URL", async () => {
    const authorization = new DocumentAuthorizationService({
      db,
      presence: new FakeRecentPresence(),
    });
    const target = MediaTargetSchema.parse({
      logicalTabId,
      documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 12 },
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 212_000,
    });
    await expect(
      authorization.authorize({
        principal: principal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId,
        documentRevision: target.documentRevision,
        target,
      }),
    ).resolves.toMatchObject({ canonicalPageIdentity: target.mediaKey });

    for (const mismatch of [
      { ...target, mediaKey: "youtube:9bZkp7q19f0" },
      {
        ...target,
        provider: "HTML5" as const,
        mediaKey: "html5:forged-fallback",
      },
    ]) {
      await expect(
        authorization.authorize({
          principal: principal(),
          socketId: "socket-owner",
          roomId,
          logicalTabId,
          documentRevision: target.documentRevision,
          target: mismatch,
        }),
      ).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
    }
  });

  it("rejects malformed or target-mismatched frame claims", async () => {
    const authorization = new DocumentAuthorizationService({
      db,
      presence: new FakeRecentPresence(),
    });
    const target = MediaTargetSchema.parse({
      logicalTabId,
      documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 12 },
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 212_000,
    });

    await expect(
      authorization.authorize({
        principal: principal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId,
        documentRevision: target.documentRevision,
        frameKey: "frame:2",
      }),
    ).rejects.toMatchObject({ code: "INVALID_MEDIA_MESSAGE" });
    await expect(
      authorization.authorize({
        principal: principal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId,
        documentRevision: target.documentRevision,
        frameKey: stableFrameKey,
        target,
      }),
    ).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
  });

  it("validates a room member target without requiring presence on that document", async () => {
    const presence = new FakeRecentPresence();
    const authorization = new DocumentAuthorizationService({ db, presence });
    const target = MediaTargetSchema.parse({
      logicalTabId: ordinaryTabId,
      documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 11 },
      frameKey: "frame:hero",
      provider: "HTML5",
      mediaKey: "html5:hero-video",
      durationMs: 42_000,
    });

    await expect(
      authorization.authorizeRoomDocument({
        principal: principal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId: ordinaryTabId,
        documentRevision: target.documentRevision,
        target,
      }),
    ).resolves.toMatchObject({
      logicalTabId: ordinaryTabId,
      canonicalPageIdentity: "url:https://example.com/a?b=1",
      member: {
        logicalTabId,
      },
    });
    expect(presence.lastInput).toMatchObject({
      socketId: "socket-owner",
      roomId,
    });
    expect(presence.lastInput).not.toHaveProperty("logicalTabId");

    await db
      .updateTable("roomTabs")
      .set({ updatedAtSeq: 12 })
      .where("roomId", "=", roomId)
      .where("logicalTabId", "=", ordinaryTabId)
      .execute();
    await expect(
      authorization.authorizeRoomDocument({
        principal: principal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId: ordinaryTabId,
        documentRevision: target.documentRevision,
        target,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_UNAUTHORIZED" });
  });

  it("allows bounded HTML5 identity on an ordinary exact document", async () => {
    const authorization = new DocumentAuthorizationService({
      db,
      presence: new FakeRecentPresence(),
    });
    const target = MediaTargetSchema.parse({
      logicalTabId: ordinaryTabId,
      documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 11 },
      frameKey: "frame:hero",
      provider: "HTML5",
      mediaKey: "html5:hero-video",
      durationMs: 42_000,
    });
    await expect(
      authorization.authorize({
        principal: principal(),
        socketId: "socket-owner",
        roomId,
        logicalTabId: ordinaryTabId,
        documentRevision: target.documentRevision,
        target,
      }),
    ).resolves.toMatchObject({
      canonicalPageIdentity: "url:https://example.com/a?b=1",
    });
  });

  it("rechecks current room membership for room-level controls", async () => {
    const authorization = new DocumentAuthorizationService({
      db,
      presence: new FakeRecentPresence(),
    });
    await expect(
      authorization.authorizeRoom({
        principal: principal(),
        socketId: "socket-owner",
        roomId,
      }),
    ).resolves.toMatchObject({ userId: ownerId, deviceId });

    await db
      .deleteFrom("roomMemberships")
      .where("roomId", "=", roomId)
      .where("userId", "=", ownerId)
      .execute();
    await expect(
      authorization.authorizeRoom({
        principal: principal(),
        socketId: "socket-owner",
        roomId,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_UNAUTHORIZED" });
  });

  it("rejects exact-document access after membership removal or room deletion", async () => {
    const authorization = new DocumentAuthorizationService({
      db,
      presence: new FakeRecentPresence(),
    });
    const request = {
      principal: principal(memberId),
      socketId: "socket-member",
      roomId,
      logicalTabId,
      documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 12 },
      frameKey: "top",
    } as const;

    await db
      .deleteFrom("roomMemberships")
      .where("roomId", "=", roomId)
      .where("userId", "=", memberId)
      .execute();
    await expect(authorization.authorize(request)).rejects.toMatchObject({
      code: "DOCUMENT_UNAUTHORIZED",
    });

    await db
      .insertInto("roomMemberships")
      .values({ roomId, userId: memberId, role: "MEMBER" })
      .execute();
    await db
      .updateTable("rooms")
      .set({ deletedAt: new Date(nowMs) })
      .where("id", "=", roomId)
      .execute();
    await expect(authorization.authorize(request)).rejects.toMatchObject({
      code: "DOCUMENT_UNAUTHORIZED",
    });
  });

  it("reports whether the durable room is still active", async () => {
    const authorization = new DocumentAuthorizationService({
      db,
      presence: new FakeRecentPresence(),
    });

    await expect(authorization.isRoomActive(roomId)).resolves.toBe(true);
    await db
      .updateTable("rooms")
      .set({ deletedAt: new Date(nowMs) })
      .where("id", "=", roomId)
      .execute();
    await expect(authorization.isRoomActive(roomId)).resolves.toBe(false);
  });

  it("rejects stale revisions, closed tabs, outsiders, and presence mismatches", async () => {
    const authorization = new DocumentAuthorizationService({
      db,
      presence: new FakeRecentPresence(),
    });
    for (const mismatch of [
      { documentRevision: { roomEpoch: 3, tabUpdatedAtSeq: 12 } },
      { documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 11 } },
      {
        logicalTabId: closedTabId,
        documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 10 },
      },
      { principal: principal(outsiderId) },
      { socketId: "socket-stale" },
    ]) {
      await expect(
        authorization.authorize({
          principal: principal(),
          socketId: "socket-owner",
          roomId,
          logicalTabId,
          documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 12 },
          ...mismatch,
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/DOCUMENT_UNAUTHORIZED|TARGET_MISMATCH/u),
      });
    }
  });
});
