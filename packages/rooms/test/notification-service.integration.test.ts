import { createDatabase, migrateToLatest } from "@syncaction/database";
import { NotificationSchema, RoomEventMessageSchema } from "@syncaction/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotificationService } from "../src/notification-service.js";
import { RoomProductEventBus, type ProductRealtimeEvent } from "../src/room-product-events.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-30T04:00:00.000Z");
const firstUserId = "018f8f8e-4b5c-4d6e-8f90-123456789d01";
const secondUserId = "018f8f8e-4b5c-4d6e-8f90-123456789d02";
const roomId = "018f8f8e-4b5c-4d6e-8f90-123456789d03";
let db: ReturnType<typeof createDatabase>;
let bus: RoomProductEventBus;
let notifications: NotificationService;
let events: ProductRealtimeEvent[];

const systemContext = {
  actor: null,
  room: null,
  requestId: null,
  invitationId: null,
  decision: null,
  title: "SyncAction vNext",
  body: "New collaboration UI",
  version: "0.9.0",
};

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("notifications").execute();
  await db.deleteFrom("policyAcceptances").execute();
  await db.deleteFrom("roomJoinRequests").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await db
    .insertInto("users")
    .values([
      {
        id: firstUserId,
        username: "first-user",
        usernameNormalized: "first-user",
        displayName: "First User",
        passwordHash: "hash",
        status: "ACTIVE",
      },
      {
        id: secondUserId,
        username: "second-user",
        usernameNormalized: "second-user",
        displayName: "Second User",
        passwordHash: "hash",
        status: "ACTIVE",
      },
    ])
    .execute();
  events = [];
  bus = new RoomProductEventBus();
  bus.subscribe((event) => events.push(event));
  notifications = new NotificationService({
    db,
    events: bus,
    now: () => now,
  });
});

describe("post-commit product event bus", () => {
  it("delivers cloned events synchronously in subscriber order and supports unsubscribe", () => {
    const event = {
      type: "ROOM_EVENT",
      event: RoomEventMessageSchema.parse({
        type: "room.event",
        protocolVersion: 1,
        eventId: "018f8f8e-4b5c-4d6e-8f90-123456789d04",
        roomId,
        roomRevision: 1,
        occurredAt: now.toISOString(),
        kind: "ROOM_DISSOLVED",
      }),
    } satisfies ProductRealtimeEvent;
    const seen: string[] = [];
    const first = (received: ProductRealtimeEvent): void => {
      seen.push("first");
      if (received.type === "ROOM_EVENT") {
        (received.event as { roomRevision: number }).roomRevision = 99;
      }
    };
    const second = (received: ProductRealtimeEvent): void => {
      seen.push(`second:${received.type === "ROOM_EVENT" ? received.event.roomRevision : -1}`);
    };
    const unsubscribeFirst = bus.subscribe(first);
    bus.subscribe(second);

    bus.publish(event);
    unsubscribeFirst();
    bus.publish(event);

    expect(seen).toEqual(["first", "second:1", "second:1"]);
    expect(event.event.roomRevision).toBe(1);
  });

  it("isolates subscriber and error-reporter failures without leaking the event payload", () => {
    const reported: unknown[] = [];
    const isolatedBus = new RoomProductEventBus({
      onSubscriberError: (cause) => {
        reported.push(cause);
        throw new Error("reporter failed");
      },
    });
    const healthy: ProductRealtimeEvent[] = [];
    isolatedBus.subscribe(() => {
      throw new Error("subscriber failed");
    });
    isolatedBus.subscribe((event) => healthy.push(event));
    const notification = NotificationSchema.parse({
      notificationId: "018f8f8e-4b5c-4d6e-8f90-123456789d05",
      cursor: 1,
      type: "SYSTEM_UPDATE",
      ...systemContext,
      createdAt: now.toISOString(),
      readAt: null,
    });
    const event = {
      type: "NOTIFICATION_CREATED",
      recipientUserId: firstUserId,
      notification,
    } satisfies ProductRealtimeEvent;

    expect(() => isolatedBus.publish(event)).not.toThrow();
    expect(reported).toEqual([expect.objectContaining({ message: "subscriber failed" })]);
    expect(healthy).toEqual([event]);
  });
});

describe("durable notification stream", () => {
  it("creates, publishes, lists, and reads one notification", async () => {
    const created = await notifications.create({
      recipientUserId: firstUserId,
      type: "SYSTEM_UPDATE",
      context: systemContext,
    });

    expect(created).toMatchObject({
      cursor: expect.any(Number),
      type: "SYSTEM_UPDATE",
      title: "SyncAction vNext",
      readAt: null,
    });
    expect(created.cursor).toBeGreaterThan(0);
    expect(events).toEqual([
      {
        type: "NOTIFICATION_CREATED",
        recipientUserId: firstUserId,
        notification: created,
      },
    ]);
    await expect(
      notifications.list({
        recipientUserId: firstUserId,
        after: 0,
        limit: 20,
      }),
    ).resolves.toEqual({
      items: [created],
      nextCursor: null,
      unreadCount: 1,
    });

    const read = await notifications.markRead({
      recipientUserId: firstUserId,
      notificationId: created.notificationId,
    });
    expect(read.readAt).toBe(now.toISOString());
    expect(events.at(-1)).toEqual({
      type: "NOTIFICATION_READ",
      recipientUserId: firstUserId,
      read: {
        kind: "ONE",
        notificationId: created.notificationId,
        readAt: now.toISOString(),
      },
    });
    expect(
      (
        await notifications.list({
          recipientUserId: firstUserId,
          after: 0,
          limit: 20,
        })
      ).unreadCount,
    ).toBe(0);
  });

  it("persists initially-read actor results without incrementing unread count", async () => {
    const created = await notifications.create({
      recipientUserId: firstUserId,
      type: "ROOM_JOIN_REQUEST_APPROVED",
      context: {
        actor: {
          userId: firstUserId,
          displayName: "First User",
        },
        room: {
          roomId,
          name: "Room",
        },
        requestId: "018f8f8e-4b5c-4d6e-8f90-123456789d06",
        invitationId: null,
        decision: "APPROVED",
        title: null,
        body: null,
        version: null,
      },
      initiallyRead: true,
    });

    expect(created.readAt).toBe(now.toISOString());
    expect(events).toEqual([
      {
        type: "NOTIFICATION_CREATED",
        recipientUserId: firstUserId,
        notification: created,
      },
    ]);
    await expect(
      notifications.list({
        recipientUserId: firstUserId,
        after: 0,
        limit: 20,
      }),
    ).resolves.toMatchObject({
      items: [created],
      unreadCount: 0,
    });
  });

  it("snapshots create input before commit and never reparses mutable caller state afterward", async () => {
    let recipientReads = 0;
    const input = {
      get recipientUserId(): string {
        recipientReads += 1;
        return recipientReads === 1 ? firstUserId : "changed-after-commit";
      },
      type: "SYSTEM_UPDATE",
      context: systemContext,
    };

    const created = await notifications.create(input);

    expect(recipientReads).toBe(1);
    expect(events).toEqual([
      {
        type: "NOTIFICATION_CREATED",
        recipientUserId: firstUserId,
        notification: created,
      },
    ]);
  });

  it("paginates forward by global cursor without crossing recipient boundaries", async () => {
    const first = await notifications.create({
      recipientUserId: firstUserId,
      type: "SYSTEM_UPDATE",
      context: systemContext,
    });
    await notifications.create({
      recipientUserId: secondUserId,
      type: "SYSTEM_UPDATE",
      context: systemContext,
    });
    const second = await notifications.create({
      recipientUserId: firstUserId,
      type: "SYSTEM_ANNOUNCEMENT",
      context: {
        ...systemContext,
        version: null,
      },
    });
    const third = await notifications.create({
      recipientUserId: firstUserId,
      type: "SYSTEM_UPDATE",
      context: systemContext,
    });

    const page = await notifications.list({
      recipientUserId: firstUserId,
      after: 0,
      limit: 2,
    });
    expect(page.items.map((item) => item.cursor)).toEqual([first.cursor, second.cursor]);
    expect(page.nextCursor).toBe(second.cursor);

    await expect(
      notifications.list({
        recipientUserId: firstUserId,
        after: page.nextCursor,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      items: [third],
      nextCursor: null,
      unreadCount: 3,
    });
  });

  it("marks only already-seen cursors and leaves later notifications unread", async () => {
    const first = await notifications.create({
      recipientUserId: firstUserId,
      type: "SYSTEM_UPDATE",
      context: systemContext,
    });
    const second = await notifications.create({
      recipientUserId: firstUserId,
      type: "SYSTEM_UPDATE",
      context: systemContext,
    });

    await expect(
      notifications.markAllRead({
        recipientUserId: firstUserId,
        through: first.cursor,
      }),
    ).resolves.toEqual({
      readAt: now.toISOString(),
      throughCursor: first.cursor,
    });
    let listed = await notifications.list({
      recipientUserId: firstUserId,
      after: 0,
      limit: 20,
    });
    expect(listed.items.map((item) => item.readAt)).toEqual([now.toISOString(), null]);
    expect(listed.unreadCount).toBe(1);

    const third = await notifications.create({
      recipientUserId: firstUserId,
      type: "SYSTEM_UPDATE",
      context: systemContext,
    });
    await notifications.markAllRead({
      recipientUserId: firstUserId,
      through: second.cursor,
    });
    listed = await notifications.list({
      recipientUserId: firstUserId,
      after: 0,
      limit: 20,
    });
    expect(listed.items.find((item) => item.cursor === third.cursor)?.readAt).toBeNull();
    expect(listed.unreadCount).toBe(1);
    expect(events.at(-1)).toEqual({
      type: "NOTIFICATION_READ",
      recipientUserId: firstUserId,
      read: {
        kind: "THROUGH",
        throughCursor: second.cursor,
        readAt: now.toISOString(),
      },
    });
  });

  it("does not expose or modify another recipient's notification", async () => {
    const created = await notifications.create({
      recipientUserId: firstUserId,
      type: "SYSTEM_UPDATE",
      context: systemContext,
    });

    await expect(
      notifications.markRead({
        recipientUserId: secondUserId,
        notificationId: created.notificationId,
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
    await expect(
      notifications.markAllRead({
        recipientUserId: secondUserId,
        through: created.cursor,
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
    await expect(
      notifications.list({
        recipientUserId: secondUserId,
        after: 0,
        limit: 20,
      }),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
  });

  it("keeps createInTransaction silent and rolls back invalid notification contexts", async () => {
    const created = await db.transaction().execute((transaction) =>
      notifications.createInTransaction(transaction, {
        recipientUserId: firstUserId,
        type: "SYSTEM_UPDATE",
        context: systemContext,
      }),
    );
    expect(events).toEqual([]);
    expect(
      (
        await notifications.list({
          recipientUserId: firstUserId,
          after: 0,
          limit: 20,
        })
      ).items,
    ).toEqual([created]);

    await expect(
      notifications.create({
        recipientUserId: firstUserId,
        type: "SYSTEM_UPDATE",
        context: {
          ...systemContext,
          body: null,
        },
      }),
    ).rejects.toThrow();
    expect(
      (
        await notifications.list({
          recipientUserId: firstUserId,
          after: created.cursor,
          limit: 20,
        })
      ).items,
    ).toEqual([]);
  });
});
