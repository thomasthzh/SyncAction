import { randomUUID } from "node:crypto";
import type { createDatabase, Database } from "@syncaction/database";
import {
  CanonicalUuidSchema,
  NotificationAfterCursorSchema,
  NotificationContextSchema,
  NotificationCursorSchema,
  NotificationReadEventSchema,
  NotificationSchema,
  NotificationTypeSchema,
  type Notification,
  type NotificationContext,
  type NotificationReadEvent,
  type NotificationType,
} from "@syncaction/protocol";
import type { Selectable, Transaction } from "kysely";
import { z } from "zod";
import { RoomError } from "./errors.js";
import { NULL_ROOM_PRODUCT_EVENT_SINK, type RoomProductEventSink } from "./room-product-events.js";

type NotificationDatabase = ReturnType<typeof createDatabase>;
type NotificationRow = Selectable<Database["notifications"]>;

const NotificationListLimitSchema = z.number().int().min(1).max(100).safe();

export interface CreateNotificationInput {
  recipientUserId: unknown;
  type: unknown;
  context: unknown;
  initiallyRead?: boolean;
}

export interface NotificationServiceOptions {
  db: NotificationDatabase;
  events?: RoomProductEventSink;
  now?: () => Date;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RoomError("INVALID_ROOM_INPUT", { cause: result.error });
  }
  return result.data;
}

function notificationFromRow(row: NotificationRow): Notification {
  const context = NotificationContextSchema.parse(row.payload);
  return NotificationSchema.parse({
    notificationId: row.id,
    cursor: Number(row.sequence),
    type: row.type,
    ...context,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  });
}

interface ParsedCreateNotificationInput {
  recipientUserId: string;
  type: NotificationType;
  context: NotificationContext;
  initiallyRead: boolean;
}

function parseCreateInput(input: CreateNotificationInput): ParsedCreateNotificationInput {
  const recipientUserId = parseInput(CanonicalUuidSchema, input.recipientUserId);
  const type = parseInput(NotificationTypeSchema, input.type);
  const context = parseInput(NotificationContextSchema, input.context);
  const initiallyRead = input.initiallyRead ?? false;
  if (typeof initiallyRead !== "boolean") {
    throw new RoomError("INVALID_ROOM_INPUT");
  }

  return {
    recipientUserId,
    type,
    context,
    initiallyRead,
  };
}

export class NotificationService {
  readonly #db: NotificationDatabase;
  readonly #events: RoomProductEventSink;
  readonly #now: () => Date;

  public constructor(options: NotificationServiceOptions) {
    this.#db = options.db;
    this.#events = options.events ?? NULL_ROOM_PRODUCT_EVENT_SINK;
    this.#now = options.now ?? (() => new Date());
  }

  public async create(input: CreateNotificationInput): Promise<Notification> {
    const parsed = parseCreateInput(input);
    const notification = await this.#db
      .transaction()
      .execute((transaction) => this.#createParsedInTransaction(transaction, parsed));
    this.#events.publish({
      type: "NOTIFICATION_CREATED",
      recipientUserId: parsed.recipientUserId,
      notification,
    });
    return notification;
  }

  public async createInTransaction(
    transaction: Transaction<Database>,
    input: CreateNotificationInput,
  ): Promise<Notification> {
    return this.#createParsedInTransaction(transaction, parseCreateInput(input));
  }

  async #createParsedInTransaction(
    transaction: Transaction<Database>,
    parsed: ParsedCreateNotificationInput,
  ): Promise<Notification> {
    const notificationId = randomUUID();
    const createdAt = this.#now();
    NotificationSchema.parse({
      notificationId,
      cursor: 1,
      type: parsed.type,
      ...parsed.context,
      createdAt: createdAt.toISOString(),
      readAt: parsed.initiallyRead ? createdAt.toISOString() : null,
    });
    const payload: Record<string, unknown> = { ...parsed.context };
    const row = await transaction
      .insertInto("notifications")
      .values({
        id: notificationId,
        recipientUserId: parsed.recipientUserId,
        type: parsed.type,
        payload,
        createdAt,
        readAt: parsed.initiallyRead ? createdAt : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return notificationFromRow(row);
  }

  public async list(input: { recipientUserId: unknown; after: unknown; limit: unknown }): Promise<{
    items: Notification[];
    nextCursor: number | null;
    unreadCount: number;
  }> {
    const recipientUserId = parseInput(CanonicalUuidSchema, input.recipientUserId);
    const after = parseInput(NotificationAfterCursorSchema, input.after);
    const limit = parseInput(NotificationListLimitSchema, input.limit);
    const rows = await this.#db
      .selectFrom("notifications")
      .selectAll()
      .where("recipientUserId", "=", recipientUserId)
      .where("sequence", ">", after)
      .orderBy("sequence", "asc")
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(notificationFromRow);
    const unread = await this.#db
      .selectFrom("notifications")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("recipientUserId", "=", recipientUserId)
      .where("readAt", "is", null)
      .executeTakeFirstOrThrow();

    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.cursor ?? null) : null,
      unreadCount: Number(unread.count),
    };
  }

  public async markRead(input: {
    recipientUserId: unknown;
    notificationId: unknown;
  }): Promise<Notification> {
    const recipientUserId = parseInput(CanonicalUuidSchema, input.recipientUserId);
    const notificationId = parseInput(CanonicalUuidSchema, input.notificationId);
    const result = await this.#db.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("notifications")
        .selectAll()
        .where("recipientUserId", "=", recipientUserId)
        .where("id", "=", notificationId)
        .forUpdate()
        .executeTakeFirst();
      if (existing === undefined) {
        throw new RoomError("NOTIFICATION_NOT_FOUND");
      }
      if (existing.readAt !== null) {
        return {
          notification: notificationFromRow(existing),
          read: null,
        };
      }

      const readAt = this.#now();
      const updated = await transaction
        .updateTable("notifications")
        .set({ readAt })
        .where("recipientUserId", "=", recipientUserId)
        .where("id", "=", notificationId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        notification: notificationFromRow(updated),
        read: NotificationReadEventSchema.parse({
          kind: "ONE",
          notificationId,
          readAt: readAt.toISOString(),
        }),
      };
    });

    if (result.read !== null) {
      this.#publishRead(recipientUserId, result.read);
    }
    return result.notification;
  }

  public async markAllRead(input: {
    recipientUserId: unknown;
    through: unknown;
  }): Promise<{ readAt: string; throughCursor: number }> {
    const recipientUserId = parseInput(CanonicalUuidSchema, input.recipientUserId);
    const through = parseInput(NotificationCursorSchema, input.through);
    const result = await this.#db.transaction().execute(async (transaction) => {
      const seenCursor = await transaction
        .selectFrom("notifications")
        .select("sequence")
        .where("recipientUserId", "=", recipientUserId)
        .where("sequence", "=", through)
        .forUpdate()
        .executeTakeFirst();
      if (seenCursor === undefined) {
        throw new RoomError("NOTIFICATION_NOT_FOUND");
      }

      const readAt = this.#now();
      const updated = await transaction
        .updateTable("notifications")
        .set({ readAt })
        .where("recipientUserId", "=", recipientUserId)
        .where("sequence", "<=", through)
        .where("readAt", "is", null)
        .executeTakeFirst();
      return {
        readAt: readAt.toISOString(),
        changed: updated.numUpdatedRows > 0n,
      };
    });
    const read = NotificationReadEventSchema.parse({
      kind: "THROUGH",
      throughCursor: through,
      readAt: result.readAt,
    });
    if (result.changed) {
      this.#publishRead(recipientUserId, read);
    }
    return {
      readAt: result.readAt,
      throughCursor: through,
    };
  }

  #publishRead(recipientUserId: string, read: NotificationReadEvent): void {
    this.#events.publish({
      type: "NOTIFICATION_READ",
      recipientUserId,
      read,
    });
  }
}
