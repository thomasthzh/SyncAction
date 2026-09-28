import {
  StrokePreviewClearMessageSchema,
  StrokePreviewClearSchema,
  StrokePreviewEventMessageSchema,
  StrokePreviewUpdateSchema,
  type StrokePreviewClear,
  type StrokePreviewClearMessage,
  type StrokePreviewEventMessage,
  type StrokePreviewUpdate,
} from "@syncaction/protocol";
import type { AuthorizedDocument, DocumentAuthorizationPort } from "./document-authorization.js";
import { AnnotationServiceError, SyncError } from "./errors.js";
import type { PresencePrincipal } from "./presence-service.js";

const PREVIEW_LIFETIME_MS = 3_000;
const MINIMUM_INTERVAL_MS = 50;
const MAX_ROOM_ENTRIES = 256;

interface StoredPreview {
  event: StrokePreviewEventMessage;
  socketId: string;
}

export interface StrokePreviewServiceOptions {
  authorization: Pick<DocumentAuthorizationPort, "authorize">;
  now?: () => Date;
  leaseMs?: number;
  minimumIntervalMs?: number;
  maxRoomEntries?: number;
}

export interface StrokePreviewUpdateResult {
  accepted: boolean;
  event: StrokePreviewEventMessage | null;
}

export class StrokePreviewService {
  readonly #authorization: Pick<DocumentAuthorizationPort, "authorize">;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #minimumIntervalMs: number;
  readonly #maxRoomEntries: number;
  readonly #entries = new Map<string, StoredPreview>();
  readonly #lastAcceptedAtBySocket = new Map<string, number>();

  public constructor(options: StrokePreviewServiceOptions) {
    this.#authorization = options.authorization;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = options.leaseMs ?? PREVIEW_LIFETIME_MS;
    this.#minimumIntervalMs = options.minimumIntervalMs ?? MINIMUM_INTERVAL_MS;
    this.#maxRoomEntries = options.maxRoomEntries ?? MAX_ROOM_ENTRIES;
    if (
      this.#leaseMs !== PREVIEW_LIFETIME_MS ||
      this.#minimumIntervalMs !== MINIMUM_INTERVAL_MS ||
      !Number.isSafeInteger(this.#maxRoomEntries) ||
      this.#maxRoomEntries < 1 ||
      this.#maxRoomEntries > MAX_ROOM_ENTRIES
    ) {
      throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE");
    }
  }

  public async update(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    update: unknown;
  }): Promise<StrokePreviewUpdateResult> {
    const socketId = parseSocketId(input.socketId);
    const parsed = StrokePreviewUpdateSchema.safeParse(input.update);
    if (!parsed.success) {
      throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE", {
        cause: parsed.error,
      });
    }
    const update = parsed.data;
    const authorized = await this.#authorize(input.principal, socketId, update);
    const nowMs = timestampMs(this.#now());
    const lastAcceptedAt = this.#lastAcceptedAtBySocket.get(socketId);
    if (lastAcceptedAt !== undefined && lastAcceptedAt > nowMs) {
      throw new SyncError("RECOVERY_REQUIRED");
    }
    if (lastAcceptedAt !== undefined && nowMs - lastAcceptedAt < this.#minimumIntervalMs) {
      return { accepted: false, event: null };
    }

    this.#removeExpired(nowMs, update.roomId);
    const key = previewKey(
      update.roomId,
      authorized.member.userId,
      authorized.member.deviceId,
      update.previewId,
    );
    if (
      !this.#entries.has(key) &&
      this.#roomEntries(update.roomId).length >= this.#maxRoomEntries
    ) {
      throw new SyncError("OPERATION_RATE_LIMITED");
    }

    const event = StrokePreviewEventMessageSchema.parse({
      type: "stroke.preview.event",
      protocolVersion: 1,
      previewId: update.previewId,
      roomId: update.roomId,
      logicalTabId: update.logicalTabId,
      documentRevision: update.documentRevision,
      frameKey: update.frameKey,
      sender: {
        userId: authorized.member.userId,
        username: authorized.member.username,
        displayName: authorized.member.displayName,
        deviceId: authorized.member.deviceId,
      },
      anchor: update.anchor,
      points: update.points,
      rgb: update.rgb,
      width: update.width,
      expiresAtServerMs: nowMs + this.#leaseMs,
    });
    this.#entries.set(key, { event, socketId });
    this.#lastAcceptedAtBySocket.set(socketId, nowMs);
    return { accepted: true, event };
  }

  public async clear(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    clear: unknown;
  }): Promise<StrokePreviewClearMessage | null> {
    const socketId = parseSocketId(input.socketId);
    const parsed = StrokePreviewClearSchema.safeParse(input.clear);
    if (!parsed.success) {
      throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE", {
        cause: parsed.error,
      });
    }
    const clear = parsed.data;
    const authorized = await this.#authorize(input.principal, socketId, clear);
    this.#removeExpired(timestampMs(this.#now()), clear.roomId);
    const key = previewKey(
      clear.roomId,
      authorized.member.userId,
      authorized.member.deviceId,
      clear.previewId,
    );
    const stored = this.#entries.get(key);
    if (stored === undefined || !sameDocument(stored.event, clear)) {
      return null;
    }
    this.#entries.delete(key);
    return toClearMessage(stored.event);
  }

  public removeSocket(socketIdInput: unknown): StrokePreviewClearMessage[] {
    const socketId = parseSocketId(socketIdInput);
    const removed: StrokePreviewEventMessage[] = [];
    for (const [key, preview] of this.#entries) {
      if (preview.socketId === socketId) {
        this.#entries.delete(key);
        removed.push(preview.event);
      }
    }
    this.#lastAcceptedAtBySocket.delete(socketId);
    return removed.map(toClearMessage).sort(compareClearMessages);
  }

  public sweep(): StrokePreviewClearMessage[] {
    const removed = this.#removeExpired(timestampMs(this.#now()));
    return removed.map(toClearMessage).sort(compareClearMessages);
  }

  async #authorize(
    principal: PresencePrincipal,
    socketId: string,
    document: StrokePreviewUpdate | StrokePreviewClear,
  ): Promise<AuthorizedDocument> {
    let authorized: AuthorizedDocument;
    try {
      authorized = await this.#authorization.authorize({
        principal,
        socketId,
        roomId: document.roomId,
        logicalTabId: document.logicalTabId,
        documentRevision: document.documentRevision,
        frameKey: document.frameKey,
      });
    } catch (cause) {
      throw new AnnotationServiceError("DOCUMENT_UNAUTHORIZED", {
        cause,
      });
    }
    if (!authorizedMatches(document, authorized)) {
      throw new AnnotationServiceError("DOCUMENT_UNAUTHORIZED");
    }
    return authorized;
  }

  #roomEntries(roomId: string): StoredPreview[] {
    const prefix = `${roomId}:`;
    return [...this.#entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, preview]) => preview);
  }

  #removeExpired(nowMs: number, onlyRoomId?: string): StrokePreviewEventMessage[] {
    const removed: StrokePreviewEventMessage[] = [];
    for (const [key, preview] of this.#entries) {
      if (
        (onlyRoomId === undefined || preview.event.roomId === onlyRoomId) &&
        preview.event.expiresAtServerMs <= nowMs
      ) {
        this.#entries.delete(key);
        removed.push(preview.event);
      }
    }
    return removed;
  }
}

function parseSocketId(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 256) {
    throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE");
  }
  return input;
}

function timestampMs(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new SyncError("RECOVERY_REQUIRED");
  }
  return milliseconds;
}

function previewKey(roomId: string, userId: string, deviceId: string, previewId: string): string {
  return `${roomId}:${userId}:${deviceId}:${previewId}`;
}

function authorizedMatches(
  document: StrokePreviewUpdate | StrokePreviewClear,
  authorized: AuthorizedDocument,
): boolean {
  return (
    authorized.roomId === document.roomId &&
    authorized.logicalTabId === document.logicalTabId &&
    authorized.documentRevision.roomEpoch === document.documentRevision.roomEpoch &&
    authorized.documentRevision.tabUpdatedAtSeq === document.documentRevision.tabUpdatedAtSeq &&
    authorized.frameKey === document.frameKey
  );
}

function sameDocument(event: StrokePreviewEventMessage, clear: StrokePreviewClear): boolean {
  return (
    event.roomId === clear.roomId &&
    event.logicalTabId === clear.logicalTabId &&
    event.documentRevision.roomEpoch === clear.documentRevision.roomEpoch &&
    event.documentRevision.tabUpdatedAtSeq === clear.documentRevision.tabUpdatedAtSeq &&
    event.frameKey === clear.frameKey
  );
}

function toClearMessage(event: StrokePreviewEventMessage): StrokePreviewClearMessage {
  return StrokePreviewClearMessageSchema.parse({
    type: "stroke.preview.clear",
    protocolVersion: 1,
    previewId: event.previewId,
    roomId: event.roomId,
    logicalTabId: event.logicalTabId,
    documentRevision: event.documentRevision,
    frameKey: event.frameKey,
    sender: {
      userId: event.sender.userId,
      deviceId: event.sender.deviceId,
    },
  });
}

function compareClearMessages(
  left: StrokePreviewClearMessage,
  right: StrokePreviewClearMessage,
): number {
  return (
    left.roomId.localeCompare(right.roomId) ||
    left.sender.userId.localeCompare(right.sender.userId) ||
    left.sender.deviceId.localeCompare(right.sender.deviceId) ||
    left.previewId.localeCompare(right.previewId)
  );
}
