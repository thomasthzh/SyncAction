import type { createDatabase } from "@syncaction/database";
import {
  CollaborationFrameKeySchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  PresenceAckSchema,
  PresenceDeltaMessageSchema,
  PresenceSnapshotV2MessageSchema,
  PresenceSnapshotMessageSchema,
  PresenceUpdateV2Schema,
  PresenceUpdateSchema,
  RoomIdSchema,
  type PresenceAck,
  type PresenceContentContext,
  type PresenceDeltaChange,
  type PresenceDeltaMessage,
  type PresenceRecord,
  type PresenceRecordV2,
  type PresenceSnapshotV2Message,
  type PresenceSnapshotMessage,
  type PresenceUpdate,
  type PresenceUpdateV2,
} from "@syncaction/protocol";
import { SyncError } from "./errors.js";

type PresenceDatabase = ReturnType<typeof createDatabase>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PresencePrincipal {
  userId: string;
  deviceId: string;
  sessionId: string;
}

interface StoredPresence extends PresenceRecordV2 {
  socketId: string;
  validatedAt: number;
}

export interface RoomPresenceServiceOptions {
  db: PresenceDatabase;
  now?: () => Date;
  leaseMs?: number;
  maxRoomEntries?: number;
}

export interface PresenceMutationResult {
  ack: PresenceAck;
  delta: PresenceDeltaMessage | null;
  onlineUserSetChanged: boolean;
}

export interface PresenceRoomMutationResult {
  delta: PresenceDeltaMessage;
  onlineUserSetChanged: boolean;
}

export interface RecentPresenceAuthorizationPort {
  authorizeRecent(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId?: unknown;
    frameKey?: unknown;
    maxValidationAgeMs?: number;
  }): PresenceRecord;
  hasRoomEntries(roomId: unknown): boolean;
}

export class RoomPresenceService {
  readonly #db: PresenceDatabase;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #maxRoomEntries: number;
  readonly #entries = new Map<string, StoredPresence>();
  readonly #sequenceByRoom = new Map<string, number>();

  public constructor(options: RoomPresenceServiceOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#maxRoomEntries = options.maxRoomEntries ?? 256;
    if (
      !Number.isSafeInteger(this.#leaseMs) ||
      this.#leaseMs < 1_000 ||
      this.#leaseMs > 30_000 ||
      !Number.isSafeInteger(this.#maxRoomEntries) ||
      this.#maxRoomEntries < 1 ||
      this.#maxRoomEntries > 256
    ) {
      throw new SyncError("INVALID_SYNC_MESSAGE");
    }
  }

  public async update(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    update: unknown;
  }): Promise<PresenceMutationResult> {
    const principal = parsePrincipal(input.principal);
    const socketId = parseSocketId(input.socketId);
    const update = parseUpdate(input.update);
    const now = this.#now();
    const nowMs = now.getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
      throw new SyncError("RECOVERY_REQUIRED");
    }

    const session = await this.#db
      .selectFrom("deviceSessions")
      .innerJoin("users", "users.id", "deviceSessions.userId")
      .select([
        "users.username",
        "users.displayName",
        "users.status",
        "deviceSessions.tokenFamilyId",
        "deviceSessions.expiresAt",
        "deviceSessions.usedAt",
        "deviceSessions.revokedAt",
        "deviceSessions.replacedBySessionId",
      ])
      .where("deviceSessions.id", "=", principal.sessionId)
      .where("users.id", "=", principal.userId)
      .where("deviceSessions.userId", "=", principal.userId)
      .where("deviceSessions.deviceId", "=", principal.deviceId)
      .executeTakeFirst();
    if (session === undefined || session.status !== "ACTIVE") {
      throw new SyncError("SYNC_AUTH_REQUIRED");
    }
    const originalIsActive =
      session.usedAt === null && session.revokedAt === null && session.expiresAt.getTime() > nowMs;
    let rotatedSuccessorIsActive = false;
    if (
      !originalIsActive &&
      session.usedAt !== null &&
      session.revokedAt === null &&
      session.replacedBySessionId !== null
    ) {
      const successor = await this.#db
        .selectFrom("deviceSessions")
        .select("id")
        .where("userId", "=", principal.userId)
        .where("deviceId", "=", principal.deviceId)
        .where("tokenFamilyId", "=", session.tokenFamilyId)
        .where("usedAt", "is", null)
        .where("revokedAt", "is", null)
        .where("expiresAt", ">", now)
        .executeTakeFirst();
      rotatedSuccessorIsActive = successor !== undefined;
    }
    if (!originalIsActive && !rotatedSuccessorIsActive) {
      throw new SyncError("SYNC_AUTH_REQUIRED");
    }

    const membership = await this.#db
      .selectFrom("roomMemberships")
      .innerJoin("rooms", "rooms.id", "roomMemberships.roomId")
      .select("roomMemberships.roomId")
      .where("roomMemberships.userId", "=", principal.userId)
      .where("roomMemberships.roomId", "=", update.roomId)
      .where("rooms.deletedAt", "is", null)
      .executeTakeFirst();
    if (membership === undefined) {
      throw new SyncError("ROOM_NOT_FOUND");
    }

    if (update.logicalTabId !== null) {
      const tab = await this.#db
        .selectFrom("roomTabs")
        .select("logicalTabId")
        .where("roomId", "=", update.roomId)
        .where("logicalTabId", "=", update.logicalTabId)
        .where("closedAtSeq", "is", null)
        .executeTakeFirst();
      if (tab === undefined) {
        throw new SyncError("ROOM_NOT_FOUND");
      }
    }

    const onlineUsersBefore = this.#storedUserIds(update.roomId, nowMs);
    const key = presenceKey(update.roomId, principal.userId, principal.deviceId);
    if (
      !this.#entries.has(key) &&
      this.#roomEntries(update.roomId, nowMs).length >= this.#maxRoomEntries
    ) {
      throw new SyncError("OPERATION_RATE_LIMITED");
    }
    const removedExpired = this.#takeExpired(nowMs, update.roomId);
    const expiresAt = nowMs + this.#leaseMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new SyncError("RECOVERY_REQUIRED");
    }
    const nextPresence: StoredPresence = {
      userId: principal.userId,
      username: session.username,
      displayName: session.displayName,
      deviceId: principal.deviceId,
      logicalTabId: update.logicalTabId,
      contentContext: update.type === "presence.update.v2" ? update.contentContext : null,
      expiresAt,
      socketId,
      validatedAt: nowMs,
    };
    const previousPresence = this.#entries.get(key);
    this.#entries.set(key, nextPresence);
    const changes: PresenceDeltaChange[] = removedExpired.map((presence) => ({
      kind: "REMOVE",
      userId: presence.userId,
      deviceId: presence.deviceId,
    }));
    if (previousPresence === undefined || !samePublicPresence(previousPresence, nextPresence)) {
      changes.push({
        kind: "UPSERT",
        presence: toPublicPresenceV2(nextPresence),
      });
    }
    const delta = changes.length === 0 ? null : this.#createDelta(update.roomId, changes);
    return {
      ack: PresenceAckSchema.parse({
        type: "presence.ack",
        protocolVersion: 1,
        roomId: update.roomId,
        expiresAt,
      }),
      delta,
      onlineUserSetChanged: !sameStringSet(
        onlineUsersBefore,
        this.#storedUserIds(update.roomId, nowMs),
      ),
    };
  }

  public snapshot(roomIdInput: unknown): PresenceSnapshotMessage {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const nowMs = this.#validatedNowMs();
    return PresenceSnapshotMessageSchema.parse({
      type: "presence.snapshot",
      protocolVersion: 1,
      roomId,
      presences: this.#roomEntries(roomId, nowMs).map(toPublicPresence).sort(comparePresence),
    });
  }

  public snapshotV2(roomIdInput: unknown): PresenceSnapshotV2Message {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const nowMs = this.#validatedNowMs();
    return PresenceSnapshotV2MessageSchema.parse({
      type: "presence.snapshot.v2",
      protocolVersion: 1,
      roomId,
      presenceSeq: this.#sequenceByRoom.get(roomId) ?? 0,
      presences: this.#roomEntries(roomId, nowMs).map(toPublicPresenceV2).sort(comparePresence),
    });
  }

  public authorizePointer(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    maxValidationAgeMs?: number;
  }): PresenceRecord {
    return this.authorizeRecent(input);
  }

  public authorizeRecent(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId?: unknown;
    frameKey?: unknown;
    maxValidationAgeMs?: number;
  }): PresenceRecord {
    const principal = parsePrincipal(input.principal);
    const socketId = parseSocketId(input.socketId);
    const roomId = RoomIdSchema.parse(input.roomId);
    const logicalTabId =
      input.logicalTabId === undefined ? undefined : LogicalTabIdSchema.parse(input.logicalTabId);
    if (
      input.frameKey !== undefined &&
      !CollaborationFrameKeySchema.safeParse(input.frameKey).success
    ) {
      throw new SyncError("INVALID_SYNC_MESSAGE");
    }
    const maxValidationAgeMs = input.maxValidationAgeMs ?? 12_000;
    if (
      !Number.isSafeInteger(maxValidationAgeMs) ||
      maxValidationAgeMs < 1_000 ||
      maxValidationAgeMs > 30_000
    ) {
      throw new SyncError("INVALID_SYNC_MESSAGE");
    }
    const nowMs = this.#now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
      throw new SyncError("RECOVERY_REQUIRED");
    }
    const presence = this.#entries.get(presenceKey(roomId, principal.userId, principal.deviceId));
    if (
      presence === undefined ||
      presence.expiresAt <= nowMs ||
      presence.socketId !== socketId ||
      (logicalTabId !== undefined && presence.logicalTabId !== logicalTabId) ||
      presence.validatedAt > nowMs ||
      nowMs - presence.validatedAt > maxValidationAgeMs
    ) {
      throw new SyncError("ROOM_NOT_FOUND");
    }
    return toPublicPresence(presence);
  }

  public hasRoomEntries(roomIdInput: unknown): boolean {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#roomEntries(roomId, this.#validatedNowMs()).length > 0;
  }

  public onlineUserIds(roomIdInput?: unknown): ReadonlySet<string> {
    const roomId = roomIdInput === undefined ? undefined : RoomIdSchema.parse(roomIdInput);
    const nowMs = this.#validatedNowMs();
    const users = new Set<string>();
    for (const [key, presence] of this.#entries) {
      if (presence.expiresAt > nowMs && (roomId === undefined || roomIdFromKey(key) === roomId)) {
        users.add(presence.userId);
      }
    }
    return users;
  }

  public removeSocket(socketIdInput: unknown): PresenceRoomMutationResult[] {
    const socketId = parseSocketId(socketIdInput);
    const removedByRoom = new Map<string, StoredPresence[]>();
    for (const [key, presence] of this.#entries) {
      if (presence.socketId === socketId) {
        this.#entries.delete(key);
        const roomId = roomIdFromKey(key);
        const removed = removedByRoom.get(roomId) ?? [];
        removed.push(presence);
        removedByRoom.set(roomId, removed);
      }
    }
    return [...removedByRoom.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([roomId, removed]) => {
        const onlineUsersBefore = new Set([
          ...this.#storedUserIds(roomId),
          ...removed.map(({ userId }) => userId),
        ]);
        return {
          delta: this.#createDelta(roomId, removalChanges(removed)),
          onlineUserSetChanged: !sameStringSet(onlineUsersBefore, this.#storedUserIds(roomId)),
        };
      });
  }

  public removeSocketFromRoom(
    socketIdInput: unknown,
    roomIdInput: unknown,
  ): PresenceRoomMutationResult | null {
    const socketId = parseSocketId(socketIdInput);
    const roomId = RoomIdSchema.parse(roomIdInput);
    const onlineUsersBefore = this.#storedUserIds(roomId);
    const removed: StoredPresence[] = [];
    for (const [key, presence] of this.#entries) {
      if (presence.socketId === socketId && roomIdFromKey(key) === roomId) {
        this.#entries.delete(key);
        removed.push(presence);
      }
    }
    return removed.length === 0
      ? null
      : {
          delta: this.#createDelta(roomId, removalChanges(removed)),
          onlineUserSetChanged: !sameStringSet(onlineUsersBefore, this.#storedUserIds(roomId)),
        };
  }

  public sweep(): PresenceRoomMutationResult[] {
    const nowMs = this.#validatedNowMs();
    const removedByRoom = new Map<string, StoredPresence[]>();
    for (const [key, presence] of this.#entries) {
      if (presence.expiresAt <= nowMs) {
        this.#entries.delete(key);
        const roomId = roomIdFromKey(key);
        const removed = removedByRoom.get(roomId) ?? [];
        removed.push(presence);
        removedByRoom.set(roomId, removed);
      }
    }
    return [...removedByRoom.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([roomId, removed]) => {
        const onlineUsersBefore = new Set([
          ...this.#storedUserIds(roomId),
          ...removed.map(({ userId }) => userId),
        ]);
        return {
          delta: this.#createDelta(roomId, removalChanges(removed)),
          onlineUserSetChanged: !sameStringSet(onlineUsersBefore, this.#storedUserIds(roomId)),
        };
      });
  }

  #roomEntries(roomId: string, nowMs?: number): StoredPresence[] {
    const prefix = `${roomId}:`;
    return [...this.#entries.entries()]
      .filter(
        ([key, presence]) =>
          key.startsWith(prefix) && (nowMs === undefined || presence.expiresAt > nowMs),
      )
      .map(([, presence]) => presence);
  }

  #takeExpired(nowMs: number, roomId: string): StoredPresence[] {
    const removed: StoredPresence[] = [];
    for (const [key, presence] of this.#entries) {
      if (roomIdFromKey(key) === roomId && presence.expiresAt <= nowMs) {
        this.#entries.delete(key);
        removed.push(presence);
      }
    }
    return removed;
  }

  #storedUserIds(roomId: string, nowMs?: number): Set<string> {
    return new Set(this.#roomEntries(roomId, nowMs).map(({ userId }) => userId));
  }

  #createDelta(roomId: string, changes: PresenceDeltaChange[]): PresenceDeltaMessage {
    const fromPresenceSeq = this.#sequenceByRoom.get(roomId) ?? 0;
    const toPresenceSeq = fromPresenceSeq + changes.length;
    if (!Number.isSafeInteger(toPresenceSeq)) {
      throw new SyncError("RECOVERY_REQUIRED");
    }
    const delta = PresenceDeltaMessageSchema.parse({
      type: "presence.delta.v2",
      protocolVersion: 1,
      roomId,
      fromPresenceSeq,
      toPresenceSeq,
      changes,
    });
    this.#sequenceByRoom.set(roomId, toPresenceSeq);
    return delta;
  }

  #validatedNowMs(): number {
    const nowMs = this.#now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
      throw new SyncError("RECOVERY_REQUIRED");
    }
    return nowMs;
  }
}

function parsePrincipal(input: PresencePrincipal): {
  userId: string;
  deviceId: ReturnType<typeof DeviceIdSchema.parse>;
  sessionId: string;
} {
  if (
    typeof input !== "object" ||
    input === null ||
    !isUuid(input.userId) ||
    !isUuid(input.sessionId)
  ) {
    throw new SyncError("SYNC_AUTH_REQUIRED");
  }
  const deviceId = DeviceIdSchema.safeParse(input.deviceId);
  if (!deviceId.success) {
    throw new SyncError("SYNC_AUTH_REQUIRED", { cause: deviceId.error });
  }
  return {
    userId: input.userId,
    deviceId: deviceId.data,
    sessionId: input.sessionId,
  };
}

function parseSocketId(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 256) {
    throw new SyncError("INVALID_SYNC_MESSAGE");
  }
  return input;
}

function parseUpdate(input: unknown): PresenceUpdate | PresenceUpdateV2 {
  const v2 = PresenceUpdateV2Schema.safeParse(input);
  if (v2.success) {
    return v2.data;
  }
  const legacy = PresenceUpdateSchema.safeParse(input);
  if (legacy.success) {
    return legacy.data;
  }
  throw new SyncError("INVALID_SYNC_MESSAGE", { cause: v2.error });
}

function isUuid(input: unknown): input is string {
  return typeof input === "string" && UUID_PATTERN.test(input);
}

function presenceKey(roomId: string, userId: string, deviceId: string): string {
  return `${roomId}:${userId}:${deviceId}`;
}

function roomIdFromKey(key: string): string {
  return key.slice(0, 36);
}

function comparePresence(
  left: PresenceRecord | PresenceRecordV2,
  right: PresenceRecord | PresenceRecordV2,
): number {
  if (left.username !== right.username) {
    return left.username < right.username ? -1 : 1;
  }
  if (left.userId !== right.userId) {
    return left.userId < right.userId ? -1 : 1;
  }
  if (left.deviceId !== right.deviceId) {
    return left.deviceId < right.deviceId ? -1 : 1;
  }
  return 0;
}

function toPublicPresence(presence: StoredPresence): PresenceRecord {
  return {
    userId: presence.userId,
    username: presence.username,
    displayName: presence.displayName,
    deviceId: presence.deviceId,
    logicalTabId: presence.logicalTabId,
    expiresAt: presence.expiresAt,
  };
}

function toPublicPresenceV2(presence: StoredPresence): PresenceRecordV2 {
  return {
    ...toPublicPresence(presence),
    contentContext:
      presence.contentContext === null ? null : structuredClone(presence.contentContext),
  };
}

function samePublicPresence(left: StoredPresence, right: StoredPresence): boolean {
  return (
    left.userId === right.userId &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.deviceId === right.deviceId &&
    left.logicalTabId === right.logicalTabId &&
    sameContentContext(left.contentContext, right.contentContext)
  );
}

function sameContentContext(
  left: PresenceContentContext | null,
  right: PresenceContentContext | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function removalChanges(removed: StoredPresence[]): PresenceDeltaChange[] {
  return [...removed]
    .sort(comparePresence)
    .map(({ userId, deviceId }) => ({ kind: "REMOVE", userId, deviceId }));
}
