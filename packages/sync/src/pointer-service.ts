import { randomUUID } from "node:crypto";
import {
  CanonicalUuidSchema,
  PointerAckSchema,
  PointerClearMessageSchema,
  PointerEventMessageSchema,
  PointerFrameSchema,
  PointerLeaseAckSchema,
  PointerLeaseClearSchema,
  PointerLeaseEventSchema,
  PointerLeaseSnapshotSchema,
  PointerLeaseUpdateSchema,
  PointerSnapshotMessageSchema,
  PointerUpdateSchema,
  RoomIdSchema,
  type PointerAck,
  type PointerClearMessage,
  type PointerEventMessage,
  type PointerFrame,
  type PointerLeaseAck,
  type PointerLeaseClear,
  type PointerLeaseEvent,
  type PointerLeaseRecord,
  type PointerLeaseSnapshot,
  type PointerLeaseUpdate,
  type PointerRecord,
  type PointerSnapshotMessage,
  type PointerUpdate,
  type PresenceRecord,
} from "@syncaction/protocol";
import { SyncError } from "./errors.js";
import type { PresencePrincipal } from "./presence-service.js";

export const POINTER_LEASE_TTL_MS = 3_000;
export const POINTER_LEASE_RENEW_MS = 2_000;

interface StoredPointer extends PointerRecord {
  roomId: string;
  socketId: string;
  leaseId: string;
}

interface StoredLease extends PointerLeaseRecord {
  roomId: string;
  socketId: string;
  legacy: boolean;
}

export interface PointerAuthorizationPort {
  authorizePointer(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
  }): PresenceRecord;
}

export interface RoomPointerServiceOptions {
  authorization: PointerAuthorizationPort;
  now?: () => Date;
  leaseMs?: number;
  minimumIntervalMs?: number;
  maxRoomEntries?: number;
}

export interface PointerLeaseResult {
  ack: PointerLeaseAck;
  event: PointerLeaseEvent;
  replaced: PointerLeaseClear | null;
  legacyClear: PointerClearMessage | null;
}

export interface PointerUpdateResult {
  ack: PointerAck;
  event: PointerEventMessage | null;
  leaseEvent?: PointerLeaseEvent;
  replacedLease?: PointerLeaseClear | null;
  legacyClear?: PointerClearMessage | null;
  frame?: PointerFrame;
}

export class RoomPointerService {
  readonly #authorization: PointerAuthorizationPort;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #minimumIntervalMs: number;
  readonly #maxRoomEntries: number;
  readonly #legacyPointers = new Map<string, StoredPointer>();
  readonly #leasesByIdentity = new Map<string, StoredLease>();
  readonly #leaseIdentityById = new Map<string, string>();
  readonly #lastAcceptedAtBySocket = new Map<string, number>();
  readonly #legacyFrameSequenceByLease = new Map<string, number>();

  public constructor(options: RoomPointerServiceOptions) {
    this.#authorization = options.authorization;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = options.leaseMs ?? POINTER_LEASE_TTL_MS;
    this.#minimumIntervalMs = options.minimumIntervalMs ?? 80;
    this.#maxRoomEntries = options.maxRoomEntries ?? 256;
    if (
      this.#leaseMs !== POINTER_LEASE_TTL_MS ||
      !Number.isSafeInteger(this.#minimumIntervalMs) ||
      this.#minimumIntervalMs < 1 ||
      this.#minimumIntervalMs > 1_000 ||
      !Number.isSafeInteger(this.#maxRoomEntries) ||
      this.#maxRoomEntries < 1 ||
      this.#maxRoomEntries > 256
    ) {
      throw new SyncError("INVALID_SYNC_MESSAGE");
    }
  }

  public lease(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    update: unknown;
  }): PointerLeaseResult {
    const socketId = parseSocketId(input.socketId);
    const update = parseLeaseUpdate(input.update);
    if (update.deviceId !== input.principal.deviceId) {
      throw new SyncError("SYNC_AUTH_REQUIRED");
    }
    const nowMs = this.#validatedNowMs();
    const identity = this.#authorization.authorizePointer({
      principal: input.principal,
      socketId,
      roomId: update.roomId,
      logicalTabId: update.logicalTabId,
    });
    if (identity.deviceId !== update.deviceId || identity.userId !== input.principal.userId) {
      throw new SyncError("SYNC_AUTH_REQUIRED");
    }
    return this.#upsertLease({
      identity,
      socketId,
      update,
      nowMs,
      legacy: false,
    });
  }

  public update(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    update: unknown;
  }): PointerUpdateResult {
    const socketId = parseSocketId(input.socketId);
    const update = parseUpdate(input.update);
    const nowMs = this.#validatedNowMs();
    const identity = this.#authorization.authorizePointer({
      principal: input.principal,
      socketId,
      roomId: update.roomId,
      logicalTabId: update.logicalTabId,
    });
    const lastAcceptedAt = this.#lastAcceptedAtBySocket.get(socketId);
    if (
      lastAcceptedAt !== undefined &&
      nowMs >= lastAcceptedAt &&
      nowMs - lastAcceptedAt < this.#minimumIntervalMs
    ) {
      return {
        ack: droppedAck(update.roomId),
        event: null,
      };
    }
    if (lastAcceptedAt !== undefined && nowMs < lastAcceptedAt) {
      throw new SyncError("RECOVERY_REQUIRED");
    }

    this.#removeExpiredLegacyPointers(nowMs, update.roomId);
    const key = pointerKey(update.roomId, identity.userId, identity.deviceId);
    const existingLease = this.#leasesByIdentity.get(key);
    const reuseLegacyLease =
      existingLease !== undefined &&
      existingLease.legacy &&
      existingLease.socketId === socketId &&
      existingLease.logicalTabId === update.logicalTabId &&
      sameDocumentRevision(existingLease.documentRevision, update.documentRevision);
    const leaseId = reuseLegacyLease ? existingLease.leaseId : randomUUID();
    const leaseUpdate = PointerLeaseUpdateSchema.parse({
      type: "pointer.lease",
      protocolVersion: 1,
      roomId: update.roomId,
      deviceId: identity.deviceId,
      leaseId,
      logicalTabId: update.logicalTabId,
      documentRevision: update.documentRevision,
      anchor: update.anchor,
    });
    const leaseResult = this.#upsertLease({
      identity,
      socketId,
      update: leaseUpdate,
      nowMs,
      legacy: true,
    });
    const pointer: StoredPointer = {
      roomId: update.roomId,
      userId: identity.userId,
      username: identity.username,
      displayName: identity.displayName,
      deviceId: identity.deviceId,
      color: pointerColor(identity.userId),
      logicalTabId: update.logicalTabId,
      documentRevision: update.documentRevision,
      anchor: update.anchor,
      viewport: update.viewport,
      expiresAt: leaseResult.ack.expiresAt!,
      socketId,
      leaseId,
    };
    this.#legacyPointers.set(key, pointer);
    this.#lastAcceptedAtBySocket.set(socketId, nowMs);
    const frameSequence = (this.#legacyFrameSequenceByLease.get(leaseId) ?? 0) + 1;
    if (!Number.isSafeInteger(frameSequence)) {
      throw new SyncError("RECOVERY_REQUIRED");
    }
    this.#legacyFrameSequenceByLease.set(leaseId, frameSequence);
    return {
      ack: PointerAckSchema.parse({
        type: "pointer.ack",
        protocolVersion: 1,
        roomId: update.roomId,
        accepted: true,
        expiresAt: leaseResult.ack.expiresAt,
      }),
      event: PointerEventMessageSchema.parse({
        type: "pointer.event",
        protocolVersion: 1,
        roomId: update.roomId,
        pointer: toPublicPointer(pointer),
      }),
      leaseEvent: leaseResult.event,
      replacedLease: leaseResult.replaced,
      legacyClear: leaseResult.legacyClear,
      frame: PointerFrameSchema.parse({
        type: "pointer.frame",
        protocolVersion: 1,
        roomId: update.roomId,
        leaseId,
        seq: frameSequence,
        xQuantized: quantizeCoordinate(update.viewport.x),
        yQuantized: quantizeCoordinate(update.viewport.y),
        viewport: { widthBucket: 1, heightBucket: 1 },
        sentAtClientMs: nowMs,
      }),
    };
  }

  public snapshot(roomIdInput: unknown): PointerSnapshotMessage {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const nowMs = this.#validatedNowMs();
    this.#removeExpiredLegacyPointers(nowMs, roomId);
    return PointerSnapshotMessageSchema.parse({
      type: "pointer.snapshot",
      protocolVersion: 1,
      roomId,
      pointers: this.#roomLegacyPointers(roomId).map(toPublicPointer).sort(comparePointers),
    });
  }

  public leaseSnapshot(roomIdInput: unknown): PointerLeaseSnapshot {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const nowMs = this.#validatedNowMs();
    return PointerLeaseSnapshotSchema.parse({
      type: "pointer.lease.snapshot",
      protocolVersion: 1,
      roomId,
      leases: this.#roomLeases(roomId, nowMs).map(toPublicLease).sort(compareLeases),
    });
  }

  public findActiveLease(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    leaseId: unknown;
  }): PointerLeaseRecord | null {
    const socketId = parseSocketId(input.socketId);
    const roomId = RoomIdSchema.parse(input.roomId);
    const leaseId = CanonicalUuidSchema.parse(input.leaseId);
    const identityKey = this.#leaseIdentityById.get(leaseId);
    if (identityKey === undefined) {
      return null;
    }
    const lease = this.#leasesByIdentity.get(identityKey);
    const nowMs = this.#validatedNowMs();
    if (
      lease === undefined ||
      lease.roomId !== roomId ||
      lease.leaseId !== leaseId ||
      lease.userId !== input.principal.userId ||
      lease.deviceId !== input.principal.deviceId ||
      lease.socketId !== socketId ||
      lease.expiresAt <= nowMs
    ) {
      return null;
    }
    return toPublicLease(lease);
  }

  public removeSocket(socketIdInput: unknown): PointerClearMessage[] {
    const socketId = parseSocketId(socketIdInput);
    const removed: StoredPointer[] = [];
    for (const [key, pointer] of this.#legacyPointers) {
      if (pointer.socketId === socketId) {
        this.#legacyPointers.delete(key);
        removed.push(pointer);
      }
    }
    this.#lastAcceptedAtBySocket.delete(socketId);
    return removed.map(toClearMessage).sort(compareClearMessages);
  }

  public removeSocketLeases(socketIdInput: unknown): PointerLeaseClear[] {
    const socketId = parseSocketId(socketIdInput);
    const removed: StoredLease[] = [];
    for (const [key, lease] of this.#leasesByIdentity) {
      if (lease.socketId === socketId) {
        this.#deleteLease(key, lease);
        removed.push(lease);
      }
    }
    return removed.map(toLeaseClear).sort(compareLeaseClears);
  }

  public sweep(): PointerClearMessage[] {
    const nowMs = this.#validatedNowMs();
    return this.#removeExpiredLegacyPointers(nowMs).map(toClearMessage).sort(compareClearMessages);
  }

  public sweepLeases(): PointerLeaseClear[] {
    const nowMs = this.#validatedNowMs();
    return this.#removeExpiredLeases(nowMs).map(toLeaseClear).sort(compareLeaseClears);
  }

  #upsertLease(input: {
    identity: PresenceRecord;
    socketId: string;
    update: PointerLeaseUpdate;
    nowMs: number;
    legacy: boolean;
  }): PointerLeaseResult {
    const key = pointerKey(input.update.roomId, input.identity.userId, input.identity.deviceId);
    const existing = this.#leasesByIdentity.get(key);
    const collidingIdentity = this.#leaseIdentityById.get(input.update.leaseId);
    if (collidingIdentity !== undefined && collidingIdentity !== key) {
      throw new SyncError("INVALID_SYNC_MESSAGE");
    }
    if (
      existing !== undefined &&
      existing.leaseId === input.update.leaseId &&
      (existing.logicalTabId !== input.update.logicalTabId ||
        !sameDocumentRevision(existing.documentRevision, input.update.documentRevision))
    ) {
      throw new SyncError("INVALID_SYNC_MESSAGE");
    }
    if (
      existing === undefined &&
      this.#roomLeases(input.update.roomId, input.nowMs).length >= this.#maxRoomEntries
    ) {
      throw new SyncError("OPERATION_RATE_LIMITED");
    }
    const expiresAt = input.nowMs + this.#leaseMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new SyncError("RECOVERY_REQUIRED");
    }

    let replaced: PointerLeaseClear | null = null;
    let legacyClear: PointerClearMessage | null = null;
    if (existing !== undefined && existing.leaseId !== input.update.leaseId) {
      replaced = toLeaseClear(existing);
      this.#deleteLease(key, existing);
      const legacyPointer = this.#legacyPointers.get(key);
      if (legacyPointer?.leaseId === existing.leaseId) {
        this.#legacyPointers.delete(key);
        legacyClear = toClearMessage(legacyPointer);
      }
    }
    const lease: StoredLease = {
      roomId: input.update.roomId,
      userId: input.identity.userId,
      username: input.identity.username,
      displayName: input.identity.displayName,
      deviceId: input.identity.deviceId,
      leaseId: input.update.leaseId,
      color: pointerColor(input.identity.userId),
      logicalTabId: input.update.logicalTabId,
      documentRevision: input.update.documentRevision,
      anchor: input.update.anchor,
      expiresAt,
      socketId: input.socketId,
      legacy: input.legacy,
    };
    this.#leasesByIdentity.set(key, lease);
    this.#leaseIdentityById.set(lease.leaseId, key);
    return {
      ack: PointerLeaseAckSchema.parse({
        type: "pointer.lease.ack",
        protocolVersion: 1,
        roomId: lease.roomId,
        leaseId: lease.leaseId,
        accepted: true,
        expiresAt,
      }),
      event: PointerLeaseEventSchema.parse({
        type: "pointer.lease.event",
        protocolVersion: 1,
        roomId: lease.roomId,
        lease: toPublicLease(lease),
      }),
      replaced,
      legacyClear,
    };
  }

  #roomLegacyPointers(roomId: string): StoredPointer[] {
    const prefix = `${roomId}:`;
    return [...this.#legacyPointers.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, pointer]) => pointer);
  }

  #roomLeases(roomId: string, nowMs?: number): StoredLease[] {
    const prefix = `${roomId}:`;
    return [...this.#leasesByIdentity.entries()]
      .filter(
        ([key, lease]) =>
          key.startsWith(prefix) && (nowMs === undefined || lease.expiresAt > nowMs),
      )
      .map(([, lease]) => lease);
  }

  #removeExpiredLegacyPointers(nowMs: number, onlyRoomId?: string): StoredPointer[] {
    const removed: StoredPointer[] = [];
    for (const [key, pointer] of this.#legacyPointers) {
      if (
        (onlyRoomId === undefined || key.startsWith(`${onlyRoomId}:`)) &&
        pointer.expiresAt <= nowMs
      ) {
        this.#legacyPointers.delete(key);
        removed.push(pointer);
      }
    }
    return removed;
  }

  #removeExpiredLeases(nowMs: number, onlyRoomId?: string): StoredLease[] {
    const removed: StoredLease[] = [];
    for (const [key, lease] of this.#leasesByIdentity) {
      if (
        (onlyRoomId === undefined || key.startsWith(`${onlyRoomId}:`)) &&
        lease.expiresAt <= nowMs
      ) {
        this.#deleteLease(key, lease);
        removed.push(lease);
      }
    }
    return removed;
  }

  #deleteLease(key: string, lease: StoredLease): void {
    this.#leasesByIdentity.delete(key);
    if (this.#leaseIdentityById.get(lease.leaseId) === key) {
      this.#leaseIdentityById.delete(lease.leaseId);
    }
    this.#legacyFrameSequenceByLease.delete(lease.leaseId);
  }

  #validatedNowMs(): number {
    const nowMs = this.#now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
      throw new SyncError("RECOVERY_REQUIRED");
    }
    return nowMs;
  }
}

function parseSocketId(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 256) {
    throw new SyncError("INVALID_SYNC_MESSAGE");
  }
  return input;
}

function parseUpdate(input: unknown): PointerUpdate {
  const parsed = PointerUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new SyncError("INVALID_SYNC_MESSAGE", { cause: parsed.error });
  }
  return parsed.data;
}

function parseLeaseUpdate(input: unknown): PointerLeaseUpdate {
  const parsed = PointerLeaseUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new SyncError("INVALID_SYNC_MESSAGE", { cause: parsed.error });
  }
  return parsed.data;
}

function droppedAck(roomId: string): PointerAck {
  return PointerAckSchema.parse({
    type: "pointer.ack",
    protocolVersion: 1,
    roomId,
    accepted: false,
    expiresAt: null,
  });
}

function pointerKey(roomId: string, userId: string, deviceId: string): string {
  return `${roomId}:${userId}:${deviceId}`;
}

function pointerColor(userId: string): string {
  const palette = ["#155fe8", "#8a3ffc", "#d1495b", "#00856f", "#b65c00", "#006d9c"];
  let hash = 0;
  for (const character of userId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return palette[hash % palette.length]!;
}

function quantizeCoordinate(value: number): number {
  return Math.max(0, Math.min(4_095, Math.round(value * 4_095)));
}

function sameDocumentRevision(
  left: PointerLeaseRecord["documentRevision"],
  right: PointerLeaseRecord["documentRevision"],
): boolean {
  return left.roomEpoch === right.roomEpoch && left.tabUpdatedAtSeq === right.tabUpdatedAtSeq;
}

function toPublicPointer(pointer: StoredPointer): PointerRecord {
  return {
    userId: pointer.userId,
    username: pointer.username,
    displayName: pointer.displayName,
    deviceId: pointer.deviceId,
    color: pointer.color,
    logicalTabId: pointer.logicalTabId,
    documentRevision: pointer.documentRevision,
    anchor: pointer.anchor,
    viewport: pointer.viewport,
    expiresAt: pointer.expiresAt,
  };
}

function toPublicLease(lease: StoredLease): PointerLeaseRecord {
  return {
    userId: lease.userId,
    username: lease.username,
    displayName: lease.displayName,
    deviceId: lease.deviceId,
    leaseId: lease.leaseId,
    color: lease.color,
    logicalTabId: lease.logicalTabId,
    documentRevision: lease.documentRevision,
    anchor: lease.anchor,
    expiresAt: lease.expiresAt,
  };
}

function toClearMessage(pointer: StoredPointer): PointerClearMessage {
  return PointerClearMessageSchema.parse({
    type: "pointer.clear",
    protocolVersion: 1,
    roomId: pointer.roomId,
    userId: pointer.userId,
    deviceId: pointer.deviceId,
  });
}

function toLeaseClear(lease: StoredLease): PointerLeaseClear {
  return PointerLeaseClearSchema.parse({
    type: "pointer.lease.clear",
    protocolVersion: 1,
    roomId: lease.roomId,
    userId: lease.userId,
    deviceId: lease.deviceId,
    leaseId: lease.leaseId,
  });
}

function comparePointers(left: PointerRecord, right: PointerRecord): number {
  return (
    left.username.localeCompare(right.username) ||
    left.userId.localeCompare(right.userId) ||
    left.deviceId.localeCompare(right.deviceId)
  );
}

function compareLeases(left: PointerLeaseRecord, right: PointerLeaseRecord): number {
  return (
    left.username.localeCompare(right.username) ||
    left.userId.localeCompare(right.userId) ||
    left.deviceId.localeCompare(right.deviceId)
  );
}

function compareClearMessages(left: PointerClearMessage, right: PointerClearMessage): number {
  return (
    left.roomId.localeCompare(right.roomId) ||
    left.userId.localeCompare(right.userId) ||
    left.deviceId.localeCompare(right.deviceId)
  );
}

function compareLeaseClears(left: PointerLeaseClear, right: PointerLeaseClear): number {
  return (
    left.roomId.localeCompare(right.roomId) ||
    left.userId.localeCompare(right.userId) ||
    left.deviceId.localeCompare(right.deviceId) ||
    left.leaseId.localeCompare(right.leaseId)
  );
}
