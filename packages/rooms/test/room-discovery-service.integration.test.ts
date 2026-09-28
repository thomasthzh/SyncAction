import { createDatabase, migrateToLatest } from "@syncaction/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotificationService } from "../src/notification-service.js";
import { RoomDiscoveryService } from "../src/room-discovery-service.js";
import { RoomProductEventBus, type ProductRealtimeEvent } from "../src/room-product-events.js";
import { RoomService } from "../src/room-service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-30T05:00:00.000Z");
const ownerId = stableId(1);
const memberId = stableId(2);
const applicantId = stableId(3);
const candidateId = stableId(4);
const inviteeId = stableId(5);
const absentId = stableId(99);
const requestId = stableId(20);
const decisionId = stableId(30);
const laterDecisionId = stableId(31);
let db: ReturnType<typeof createDatabase>;
let rooms: RoomService;
let discovery: RoomDiscoveryService;
let events: ProductRealtimeEvent[];
let onlineByRoom: Map<string, ReadonlySet<string>>;
let onlineServerWide: ReadonlySet<string>;
let activePlaybackRooms: Set<string>;

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
  await db.deleteFrom("deviceSessions").execute();
  await db.deleteFrom("users").execute();
  events = [];
  onlineByRoom = new Map();
  onlineServerWide = new Set();
  activePlaybackRooms = new Set();
  const eventBus = new RoomProductEventBus();
  eventBus.subscribe((event) => events.push(event));
  const notifications = new NotificationService({ db, events: eventBus, now: () => now });
  rooms = new RoomService({ db, events: eventBus, notifications, now: () => now });
  discovery = new RoomDiscoveryService({
    db,
    events: eventBus,
    notifications,
    onlineUserIdsForRoom: (roomId) => onlineByRoom.get(roomId) ?? new Set(),
    onlineUserIds: () => onlineServerWide,
    hasActivePlayback: (roomId) => activePlaybackRooms.has(roomId),
    now: () => now,
  });
  await Promise.all([
    createUser(ownerId, "owner", "Room Owner"),
    createUser(memberId, "member", "Existing Member"),
    createUser(applicantId, "applicant", "Pending Applicant"),
    createUser(candidateId, "online.candidate", "Online Candidate"),
    createUser(inviteeId, "offline.candidate", "Offline Candidate"),
  ]);
});

function stableId(value: number): string {
  return `018f8f8e-4b5c-7d6e-8f90-${value.toString(16).padStart(12, "0")}`;
}

async function createUser(
  id: string,
  username: string,
  displayName: string,
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED" = "ACTIVE",
): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id,
      username,
      usernameNormalized: username.toLowerCase(),
      displayName,
      passwordHash: "hash",
      status,
      updatedAt: now,
    })
    .execute();
}

async function createPublicRoom(
  name: string,
  joinPolicy: "OPEN" | "APPROVAL" | "INVITE_ONLY",
): Promise<Awaited<ReturnType<RoomService["createRoom"]>>> {
  return rooms.createRoom({
    actorUserId: ownerId,
    name,
    visibility: "PUBLIC",
    joinPolicy,
  });
}

async function insertPendingRequest(roomId: string, id = requestId): Promise<void> {
  await db
    .insertInto("roomJoinRequests")
    .values({
      id,
      roomId,
      applicantUserId: applicantId,
      status: "PENDING",
      decidedByUserId: null,
      decisionClientOpId: null,
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
    })
    .execute();
}

describe("RoomDiscoveryService", () => {
  it("lists only public summaries with room-scoped presence, opaque pagination, and no identity leakage", async () => {
    const approval = await createPublicRoom("Public approval", "APPROVAL");
    const open = await createPublicRoom("Public open", "OPEN");
    await rooms.createRoom({ actorUserId: ownerId, name: "Private identity" });
    await db
      .insertInto("roomMemberships")
      .values({ roomId: approval.id, userId: memberId, role: "MEMBER", createdAt: now })
      .execute();
    await db
      .insertInto("roomTabs")
      .values({
        roomId: approval.id,
        logicalTabId: stableId(40),
        url: "https://example.com/private-target",
        title: "Private title",
        favIconUrl: null,
        position: 0,
        createdAtSeq: 1,
        updatedAtSeq: 1,
        closedAtSeq: null,
      })
      .execute();
    onlineByRoom.set(approval.id, new Set([ownerId, memberId, applicantId]));
    onlineByRoom.set(open.id, new Set([ownerId]));
    activePlaybackRooms.add(approval.id);

    const first = await discovery.listPublicRooms({ query: "", cursor: null, limit: 1 });
    const second = await discovery.listPublicRooms({
      query: "",
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((room) => room.roomId))).toEqual(
      new Set([approval.id, open.id]),
    );

    const all = await discovery.listPublicRooms({ query: "APPROVAL", cursor: null, limit: 20 });
    expect(all).toEqual({
      items: [
        expect.objectContaining({
          roomId: approval.id,
          name: "Public approval",
          joinPolicy: "APPROVAL",
          onlineCount: 2,
          memberCount: 2,
          openTabCount: 1,
          hasActivePlayback: true,
        }),
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(all)).not.toMatch(
      /(?:owner|Existing Member|Private identity|private-target|Private title)/u,
    );
  });

  it("returns a privacy-filtered user directory ordered by bound online state", async () => {
    const room = await createPublicRoom("Directory", "APPROVAL");
    await db
      .insertInto("roomMemberships")
      .values({ roomId: room.id, userId: memberId, role: "MEMBER", createdAt: now })
      .execute();
    await db
      .insertInto("roomInvitations")
      .values({
        id: stableId(41),
        roomId: room.id,
        invitedUserId: applicantId,
        invitedByUserId: ownerId,
        status: "PENDING",
        expiresAt: new Date(now.getTime() + 86_400_000),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    onlineServerWide = new Set([candidateId, memberId]);

    const first = await discovery.searchUsers({
      actorUserId: ownerId,
      roomId: room.id,
      query: "",
      cursor: null,
      limit: 1,
    });
    const second = await discovery.searchUsers({
      actorUserId: ownerId,
      roomId: room.id,
      query: "",
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(first.items).toEqual([
      {
        userId: candidateId,
        username: "online.candidate",
        displayName: "Online Candidate",
        online: true,
      },
    ]);
    expect(second.items).toEqual([
      {
        userId: inviteeId,
        username: "offline.candidate",
        displayName: "Offline Candidate",
        online: false,
      },
    ]);
    expect(second.nextCursor).toBeNull();

    await expect(
      discovery.searchUsers({
        actorUserId: ownerId,
        roomId: room.id,
        query: "ＯＦＦ",
        cursor: null,
        limit: 20,
      }),
    ).resolves.toEqual({
      items: [
        {
          userId: inviteeId,
          username: "offline.candidate",
          displayName: "Offline Candidate",
          online: false,
        },
      ],
      nextCursor: null,
    });
  });

  it("joins OPEN rooms atomically and settles conflicting request and invitation state", async () => {
    const room = await createPublicRoom("Open room", "OPEN");
    await insertPendingRequest(room.id);
    const invitationId = stableId(42);
    await db
      .insertInto("roomInvitations")
      .values({
        id: invitationId,
        roomId: room.id,
        invitedUserId: applicantId,
        invitedByUserId: ownerId,
        status: "PENDING",
        expiresAt: new Date(now.getTime() + 86_400_000),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    events.length = 0;

    const joined = await discovery.joinOpen({ actorUserId: applicantId, roomId: room.id });

    expect(joined).toMatchObject({ id: room.id, role: "MEMBER", roomRevision: 1 });
    await expect(
      db
        .selectFrom("roomJoinRequests")
        .select(["status", "decidedByUserId"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "APPROVED", decidedByUserId: ownerId });
    await expect(
      db
        .selectFrom("roomInvitations")
        .select("status")
        .where("id", "=", invitationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "REVOKED" });
    const openApprovalResults = events.filter(
      (event) =>
        event.type === "NOTIFICATION_CREATED" &&
        event.notification.type === "ROOM_JOIN_REQUEST_APPROVED",
    );
    expect(openApprovalResults).toHaveLength(2);
    expect(openApprovalResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientUserId: applicantId,
          notification: expect.objectContaining({ readAt: now.toISOString() }),
        }),
        expect.objectContaining({
          recipientUserId: ownerId,
          notification: expect.objectContaining({ readAt: null }),
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ROOM_EVENT",
          event: expect.objectContaining({
            kind: "ROOM_MEMBER_JOINED",
            roomRevision: 1,
          }),
        }),
        expect.objectContaining({
          type: "PUBLIC_ROOMS_INVALIDATED",
          message: expect.objectContaining({ roomRevision: 1 }),
        }),
      ]),
    );
  });

  it("creates APPROVAL requests and makes approval decisions idempotent", async () => {
    const room = await createPublicRoom("Approval room", "APPROVAL");
    events.length = 0;

    const requested = await discovery.requestJoin({
      actorUserId: applicantId,
      roomId: room.id,
    });
    expect(requested).toMatchObject({
      roomId: room.id,
      applicant: { userId: applicantId },
      status: "PENDING",
      decidedAt: null,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "NOTIFICATION_CREATED",
        recipientUserId: ownerId,
        notification: expect.objectContaining({
          type: "ROOM_JOIN_REQUEST_CREATED",
          requestId: requested.requestId,
        }),
      }),
    ]);
    await expect(
      discovery.requestJoin({ actorUserId: applicantId, roomId: room.id }),
    ).rejects.toMatchObject({ code: "JOIN_REQUEST_CONFLICT" });

    events.length = 0;
    const approved = await discovery.decideJoinRequest({
      actorUserId: ownerId,
      requestId: requested.requestId,
      decision: "APPROVE",
      clientOpId: decisionId,
    });
    expect(approved).toMatchObject({
      requestId: requested.requestId,
      status: "APPROVED",
      decidedAt: now.toISOString(),
    });
    const decisionResults = events.filter(
      (event) =>
        event.type === "NOTIFICATION_CREATED" &&
        event.notification.type === "ROOM_JOIN_REQUEST_APPROVED",
    );
    expect(decisionResults).toHaveLength(2);
    expect(decisionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientUserId: applicantId,
          notification: expect.objectContaining({ readAt: null }),
        }),
        expect.objectContaining({
          recipientUserId: ownerId,
          notification: expect.objectContaining({ readAt: now.toISOString() }),
        }),
      ]),
    );
    expect(
      events.some(
        (event) =>
          event.type === "ROOM_EVENT" &&
          event.event.kind === "ROOM_MEMBER_JOINED" &&
          event.event.roomRevision === 1,
      ),
    ).toBe(true);
    const eventCount = events.length;
    const notificationCount = await countNotifications();

    await expect(
      discovery.decideJoinRequest({
        actorUserId: ownerId,
        requestId: requested.requestId,
        decision: "APPROVE",
        clientOpId: decisionId,
      }),
    ).resolves.toEqual(approved);
    await expect(
      discovery.decideJoinRequest({
        actorUserId: ownerId,
        requestId: requested.requestId,
        decision: "APPROVE",
        clientOpId: laterDecisionId,
      }),
    ).resolves.toEqual(approved);
    expect(events).toHaveLength(eventCount);
    await expect(countNotifications()).resolves.toBe(notificationCount);
    await expect(
      db
        .selectFrom("rooms")
        .select("roomRevision")
        .where("id", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ roomRevision: 1 });
    await expect(
      discovery.decideJoinRequest({
        actorUserId: ownerId,
        requestId: requested.requestId,
        decision: "REJECT",
        clientOpId: laterDecisionId,
      }),
    ).rejects.toMatchObject({ code: "JOIN_REQUEST_CONFLICT" });
  });

  it("persists two-sided rejection and cancellation threads without membership changes", async () => {
    const room = await createPublicRoom("Decision room", "APPROVAL");
    const first = await discovery.requestJoin({ actorUserId: applicantId, roomId: room.id });
    events.length = 0;

    const rejected = await discovery.decideJoinRequest({
      actorUserId: ownerId,
      requestId: first.requestId,
      decision: "REJECT",
      clientOpId: decisionId,
    });
    expect(rejected.status).toBe("REJECTED");
    expect(
      events.filter(
        (event) =>
          event.type === "NOTIFICATION_CREATED" &&
          event.notification.type === "ROOM_JOIN_REQUEST_REJECTED",
      ),
    ).toHaveLength(2);
    expect(events.some((event) => event.type === "ROOM_EVENT")).toBe(false);

    const second = await discovery.requestJoin({ actorUserId: candidateId, roomId: room.id });
    events.length = 0;
    await discovery.cancelJoinRequest({
      actorUserId: candidateId,
      requestId: second.requestId,
    });
    const cancellationResults = events.filter(
      (event) =>
        event.type === "NOTIFICATION_CREATED" &&
        event.notification.type === "ROOM_JOIN_REQUEST_CANCELLED",
    );
    expect(cancellationResults).toHaveLength(2);
    expect(cancellationResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientUserId: candidateId,
          notification: expect.objectContaining({ readAt: now.toISOString() }),
        }),
        expect.objectContaining({
          recipientUserId: ownerId,
          notification: expect.objectContaining({ readAt: null }),
        }),
      ]),
    );
    const eventCount = events.length;
    const notificationCount = await countNotifications();
    await discovery.cancelJoinRequest({
      actorUserId: candidateId,
      requestId: second.requestId,
    });
    expect(events).toHaveLength(eventCount);
    await expect(countNotifications()).resolves.toBe(notificationCount);
    await expect(
      db
        .selectFrom("roomMemberships")
        .select("userId")
        .where("roomId", "=", room.id)
        .where("userId", "in", [applicantId, candidateId])
        .execute(),
    ).resolves.toEqual([]);
  });

  it("rejects join methods that do not match public room policy", async () => {
    const inviteOnly = await createPublicRoom("Invite only", "INVITE_ONLY");
    const privateRoom = await rooms.createRoom({ actorUserId: ownerId, name: "Private" });

    await expect(
      discovery.joinOpen({ actorUserId: applicantId, roomId: inviteOnly.id }),
    ).rejects.toMatchObject({ code: "ROOM_JOIN_POLICY_MISMATCH" });
    await expect(
      discovery.requestJoin({ actorUserId: applicantId, roomId: inviteOnly.id }),
    ).rejects.toMatchObject({ code: "ROOM_JOIN_POLICY_MISMATCH" });
    await expect(
      discovery.joinOpen({ actorUserId: applicantId, roomId: privateRoom.id }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_PUBLIC" });
  });

  it("batch-invites valid users while returning ordered privacy-safe per-user results", async () => {
    const room = await createPublicRoom("Batch room", "APPROVAL");
    await db
      .insertInto("roomMemberships")
      .values({ roomId: room.id, userId: memberId, role: "MEMBER", createdAt: now })
      .execute();
    await db
      .insertInto("roomInvitations")
      .values({
        id: stableId(43),
        roomId: room.id,
        invitedUserId: applicantId,
        invitedByUserId: ownerId,
        status: "PENDING",
        expiresAt: new Date(now.getTime() + 86_400_000),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    events.length = 0;

    const result = await discovery.batchInvite({
      actorUserId: ownerId,
      roomId: room.id,
      userIds: [candidateId, memberId, applicantId, absentId, ownerId],
    });

    expect(result).toEqual([
      { userId: candidateId, status: "CREATED", invitationId: expect.any(String) },
      { userId: memberId, status: "ALREADY_MEMBER", invitationId: null },
      { userId: applicantId, status: "ALREADY_PENDING", invitationId: null },
      { userId: absentId, status: "NOT_FOUND", invitationId: null },
      { userId: ownerId, status: "FORBIDDEN", invitationId: null },
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "NOTIFICATION_CREATED" &&
          event.notification.type === "ROOM_INVITATION_CREATED",
      ),
    ).toHaveLength(1);
    expect(
      events
        .filter((event) => event.type === "ROOM_EVENT")
        .map((event) => event.event.roomRevision),
    ).toEqual([1]);

    const eventCount = events.length;
    await expect(
      discovery.batchInvite({
        actorUserId: ownerId,
        roomId: room.id,
        userIds: [candidateId, memberId, applicantId, absentId, ownerId],
      }),
    ).resolves.toEqual([
      { userId: candidateId, status: "ALREADY_PENDING", invitationId: null },
      { userId: memberId, status: "ALREADY_MEMBER", invitationId: null },
      { userId: applicantId, status: "ALREADY_PENDING", invitationId: null },
      { userId: absentId, status: "NOT_FOUND", invitationId: null },
      { userId: ownerId, status: "FORBIDDEN", invitationId: null },
    ]);
    expect(events).toHaveLength(eventCount);
    await expect(
      db
        .selectFrom("rooms")
        .select("roomRevision")
        .where("id", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ roomRevision: 1 });
  });

  it("rejects malformed cursors, oversized queries, and invalid batches before mutation", async () => {
    const room = await createPublicRoom("Validation", "APPROVAL");
    events.length = 0;
    await expect(
      discovery.listPublicRooms({ query: "", cursor: "not+base64", limit: 20 }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_INPUT" });
    await expect(
      discovery.searchUsers({
        actorUserId: ownerId,
        roomId: room.id,
        query: "x".repeat(101),
        cursor: null,
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_INPUT" });
    await expect(
      discovery.batchInvite({
        actorUserId: ownerId,
        roomId: room.id,
        userIds: [candidateId, candidateId],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOM_INPUT" });
    expect(events).toEqual([]);
  });
});

async function countNotifications(): Promise<number> {
  const result = await db
    .selectFrom("notifications")
    .select((expression) => expression.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(result.count);
}
