import { describe, expect, it } from "vitest";
import {
  DirectoryUserSchema,
  NotificationAfterCursorSchema,
  NotificationCursorSchema,
  NotificationReadEventSchema,
  NotificationSchema,
  PublicRoomsInvalidatedSchema,
  PublicRoomSummarySchema,
  RoomEventMessageSchema,
  RoomJoinDecisionInputSchema,
  RoomJoinRequestSchema,
  ServerCapabilitySchema,
  ServerMetaSchema,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-4d6e-8f90-123456789c01";
const eventId = "018f8f8e-4b5c-4d6e-8f90-123456789c02";
const ownerUserId = "018f8f8e-4b5c-4d6e-8f90-123456789c03";
const memberUserId = "018f8f8e-4b5c-4d6e-8f90-123456789c04";
const requestId = "018f8f8e-4b5c-4d6e-8f90-123456789c05";
const invitationId = "018f8f8e-4b5c-4d6e-8f90-123456789c06";
const notificationId = "018f8f8e-4b5c-4d6e-8f90-123456789c07";
const clientOpId = "018f8f8e-4b5c-4d6e-8f90-123456789c08";
const occurredAt = "2026-07-30T03:00:00.000Z";

const actor = {
  userId: ownerUserId,
  displayName: "Owner",
};
const room = {
  roomId,
  name: "Public study",
};
const member = {
  userId: memberUserId,
  username: "member",
  displayName: "Member",
  role: "MEMBER",
  joinedAt: occurredAt,
};

const notificationBase = {
  notificationId,
  cursor: 1,
  actor: null,
  room: null,
  requestId: null,
  invitationId: null,
  decision: null,
  title: null,
  body: null,
  version: null,
  createdAt: occurredAt,
  readAt: null,
};

describe("server product metadata", () => {
  it("publishes a software version while normalizing legacy metadata to unknown", () => {
    const metadata = {
      serverId: "018f8f8e-4b5c-4d6e-8f90-123456789c09",
      displayName: "SyncAction",
      protocolVersion: "1",
      minimumClientVersion: "0.8.1",
      termsVersion: "2026-07-30",
      capabilities: ["public-rooms"],
      limits: {
        ordinaryActiveRooms: 5,
        ordinaryOpenTabs: 20,
      },
    };

    expect(ServerMetaSchema.parse({ ...metadata, softwareVersion: "0.9.2" }).softwareVersion).toBe(
      "0.9.2",
    );
    expect(ServerMetaSchema.parse(metadata).softwareVersion).toBeNull();
  });

  it("accepts known capabilities and one syntactically valid future capability", () => {
    const metadata = {
      serverId: "018f8f8e-4b5c-4d6e-8f90-123456789c09",
      displayName: "SyncAction",
      protocolVersion: "1",
      minimumClientVersion: "0.8.1",
      termsVersion: "2026-07-30",
      capabilities: ["public-rooms", "join-requests", "notifications", "future-room-tool"],
      limits: {
        ordinaryActiveRooms: 5,
        ordinaryOpenTabs: 20,
      },
    };

    expect(ServerMetaSchema.parse(metadata)).toEqual({ ...metadata, softwareVersion: null });
    expect(ServerCapabilitySchema.safeParse("future-room-tool").success).toBe(false);
  });

  it("recognizes account activation as a negotiated server capability", () => {
    expect(ServerCapabilitySchema.parse("account-activation-v1")).toBe("account-activation-v1");
  });

  it("recognizes account key login as a negotiated server capability", () => {
    expect(ServerCapabilitySchema.parse("account-key-login-v1")).toBe("account-key-login-v1");
  });

  it.each([
    ["duplicate capability", ["public-rooms", "public-rooms"]],
    ["uppercase capability", ["Public-Rooms"]],
    ["empty capability", [""]],
    ["oversized capability", [`a${"b".repeat(64)}`]],
  ])("rejects %s", (_name, capabilities) => {
    expect(() =>
      ServerMetaSchema.parse({
        serverId: "018f8f8e-4b5c-4d6e-8f90-123456789c09",
        displayName: "SyncAction",
        protocolVersion: "1",
        minimumClientVersion: "0.8.1",
        termsVersion: "2026-07-30",
        capabilities,
        limits: {
          ordinaryActiveRooms: 5,
          ordinaryOpenTabs: 20,
        },
      }),
    ).toThrow();
  });

  it("rejects unknown metadata keys", () => {
    expect(() =>
      ServerMetaSchema.parse({
        serverId: "018f8f8e-4b5c-4d6e-8f90-123456789c09",
        displayName: "SyncAction",
        protocolVersion: "1",
        minimumClientVersion: "0.8.1",
        termsVersion: "2026-07-30",
        capabilities: ["public-rooms"],
        limits: {
          ordinaryActiveRooms: 5,
          ordinaryOpenTabs: 20,
        },
        administratorOrigin: "https://private.invalid",
      }),
    ).toThrow();
  });
});

describe("privacy-safe discovery contracts", () => {
  const publicRoom = {
    roomId,
    name: "Public study",
    joinPolicy: "APPROVAL",
    onlineCount: 1,
    memberCount: 2,
    openTabCount: 3,
    hasActivePlayback: false,
    updatedAt: occurredAt,
  };

  it("accepts a sanitized public room summary", () => {
    expect(PublicRoomSummarySchema.parse(publicRoom)).toEqual(publicRoom);
  });

  it.each([
    ["member names", { ...publicRoom, memberNames: ["private-user"] }],
    ["private URL", { ...publicRoom, url: "https://private.invalid/path" }],
    ["tab title", { ...publicRoom, tabTitle: "Private document" }],
    ["negative online count", { ...publicRoom, onlineCount: -1 }],
    ["online count above member count", { ...publicRoom, onlineCount: 3 }],
    ["zero members", { ...publicRoom, memberCount: 0 }],
  ])("rejects a public summary containing %s", (_name, value) => {
    expect(() => PublicRoomSummarySchema.parse(value)).toThrow();
  });

  it("accepts only the public directory identity projection", () => {
    const directoryUser = {
      userId: memberUserId,
      username: "member",
      displayName: "Member",
      online: true,
    };
    expect(DirectoryUserSchema.parse(directoryUser)).toEqual(directoryUser);
    expect(() =>
      DirectoryUserSchema.parse({
        ...directoryUser,
        email: "private@example.invalid",
      }),
    ).toThrow();
  });

  it("parses a strict join request without online or device state", () => {
    const joinRequest = {
      requestId,
      roomId,
      applicant: {
        userId: memberUserId,
        username: "member",
        displayName: "Member",
      },
      status: "PENDING",
      createdAt: occurredAt,
      decidedAt: null,
    };
    expect(RoomJoinRequestSchema.parse(joinRequest)).toEqual(joinRequest);
    expect(() =>
      RoomJoinRequestSchema.parse({
        ...joinRequest,
        applicant: {
          ...joinRequest.applicant,
          online: true,
        },
      }),
    ).toThrow();
    expect(() =>
      RoomJoinRequestSchema.parse({
        ...joinRequest,
        decidedAt: occurredAt,
      }),
    ).toThrow();
    expect(() =>
      RoomJoinRequestSchema.parse({
        ...joinRequest,
        status: "APPROVED",
      }),
    ).toThrow();
  });
});

describe("strict room lifecycle messages", () => {
  const base = {
    type: "room.event",
    protocolVersion: 1,
    eventId,
    roomId,
    roomRevision: 4,
    occurredAt,
  };

  it.each([
    {
      ...base,
      kind: "ROOM_MEMBER_JOINED",
      member,
    },
    {
      ...base,
      kind: "ROOM_MEMBER_LEFT",
      userId: memberUserId,
    },
    {
      ...base,
      kind: "ROOM_MEMBER_REMOVED",
      userId: memberUserId,
    },
    {
      ...base,
      kind: "ROOM_OWNER_TRANSFERRED",
      previousOwnerUserId: ownerUserId,
      newOwnerUserId: memberUserId,
    },
    {
      ...base,
      kind: "ROOM_UPDATED",
      name: "Renamed room",
      visibility: "PUBLIC",
      joinPolicy: "OPEN",
    },
    {
      ...base,
      kind: "ROOM_DISSOLVED",
    },
  ])("accepts $kind", (message) => {
    expect(RoomEventMessageSchema.parse(message)).toEqual(message);
  });

  it.each([
    ["missing variant payload", { ...base, kind: "ROOM_MEMBER_LEFT" }],
    [
      "extra payload",
      {
        ...base,
        kind: "ROOM_DISSOLVED",
        member,
      },
    ],
    [
      "invalid private join policy",
      {
        ...base,
        kind: "ROOM_UPDATED",
        name: "Private room",
        visibility: "PRIVATE",
        joinPolicy: "OPEN",
      },
    ],
    [
      "missing envelope field",
      {
        type: "room.event",
        protocolVersion: 1,
        eventId,
        roomId,
        roomRevision: 4,
        kind: "ROOM_DISSOLVED",
      },
    ],
  ])("rejects %s", (_name, message) => {
    expect(() => RoomEventMessageSchema.parse(message)).toThrow();
  });
});

describe("durable notification contracts", () => {
  it.each([
    {
      ...notificationBase,
      type: "ROOM_INVITATION_CREATED",
      actor,
      room,
      invitationId,
    },
    {
      ...notificationBase,
      type: "ROOM_JOIN_REQUEST_CREATED",
      actor: {
        userId: memberUserId,
        displayName: "Member",
      },
      room,
      requestId,
    },
    {
      ...notificationBase,
      type: "ROOM_JOIN_REQUEST_APPROVED",
      actor,
      room,
      requestId,
      decision: "APPROVED",
    },
    {
      ...notificationBase,
      type: "ROOM_MEMBER_REMOVED",
      actor,
      room,
    },
    {
      ...notificationBase,
      type: "SYSTEM_UPDATE",
      title: "SyncAction v0.9.0",
      body: "A new collaboration interface is available.",
      version: "0.9.0",
    },
  ])("accepts $type", (notification) => {
    expect(NotificationSchema.parse(notification)).toEqual(notification);
  });

  it.each([
    [
      "invitation without invitationId",
      {
        ...notificationBase,
        type: "ROOM_INVITATION_CREATED",
        actor,
        room,
      },
    ],
    [
      "request result without requestId",
      {
        ...notificationBase,
        type: "ROOM_JOIN_REQUEST_APPROVED",
        actor,
        room,
        decision: "APPROVED",
      },
    ],
    [
      "approved type with rejected decision",
      {
        ...notificationBase,
        type: "ROOM_JOIN_REQUEST_APPROVED",
        actor,
        room,
        requestId,
        decision: "REJECTED",
      },
    ],
    [
      "room event without room",
      {
        ...notificationBase,
        type: "ROOM_DISSOLVED",
        actor,
      },
    ],
    [
      "system update without body",
      {
        ...notificationBase,
        type: "SYSTEM_UPDATE",
        title: "SyncAction v0.9.0",
        version: "0.9.0",
      },
    ],
    [
      "unknown payload key",
      {
        ...notificationBase,
        type: "ROOM_MEMBER_REMOVED",
        actor,
        room,
        privateUrl: "https://private.invalid",
      },
    ],
  ])("rejects %s", (_name, notification) => {
    expect(() => NotificationSchema.parse(notification)).toThrow();
  });

  it("distinguishes the start cursor from returned notification cursors", () => {
    expect(NotificationAfterCursorSchema.parse(0)).toBe(0);
    expect(NotificationCursorSchema.parse(1)).toBe(1);
    expect(() => NotificationCursorSchema.parse(0)).toThrow();
    expect(() => NotificationAfterCursorSchema.parse(-1)).toThrow();
    expect(() => NotificationCursorSchema.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("parses strict one-item and through-cursor read events", () => {
    const one = {
      kind: "ONE",
      notificationId,
      readAt: occurredAt,
    };
    const through = {
      kind: "THROUGH",
      throughCursor: 42,
      readAt: occurredAt,
    };
    expect(NotificationReadEventSchema.parse(one)).toEqual(one);
    expect(NotificationReadEventSchema.parse(through)).toEqual(through);
    expect(() => NotificationReadEventSchema.parse({ ...through, extra: true })).toThrow();
  });
});

describe("strict product mutations and public invalidations", () => {
  it("parses a join decision with an idempotency key", () => {
    const input = {
      decision: "APPROVE",
      clientOpId,
    };
    expect(RoomJoinDecisionInputSchema.parse(input)).toEqual(input);
    expect(() => RoomJoinDecisionInputSchema.parse({ ...input, roomId })).toThrow();
  });

  it.each([
    {
      type: "public-rooms.invalidated",
      roomId,
      reason: "ROOM",
      roomRevision: 7,
    },
    {
      type: "public-rooms.invalidated",
      roomId,
      reason: "TAB_STATE",
      roomRevision: null,
    },
    {
      type: "public-rooms.invalidated",
      roomId,
      reason: "PRESENCE",
      roomRevision: null,
    },
    {
      type: "public-rooms.invalidated",
      roomId,
      reason: "PLAYBACK",
      roomRevision: null,
    },
  ])("accepts $reason invalidation", (message) => {
    expect(PublicRoomsInvalidatedSchema.parse(message)).toEqual(message);
  });

  it.each([
    {
      type: "public-rooms.invalidated",
      roomId,
      reason: "ROOM",
      roomRevision: null,
    },
    {
      type: "public-rooms.invalidated",
      roomId,
      reason: "PRESENCE",
      roomRevision: 7,
    },
    {
      type: "public-rooms.invalidated",
      roomId,
      reason: "TAB_STATE",
      roomRevision: null,
      memberNames: ["private-user"],
    },
  ])("rejects an inconsistent or leaky invalidation", (message) => {
    expect(() => PublicRoomsInvalidatedSchema.parse(message)).toThrow();
  });
});
