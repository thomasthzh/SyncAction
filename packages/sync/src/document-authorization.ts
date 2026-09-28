import type { createDatabase } from "@syncaction/database";
import {
  CollaborationFrameKeySchema,
  DocumentRevisionSchema,
  LogicalTabIdSchema,
  MediaTargetSchema,
  RoomIdSchema,
  canonicalSharedPageIdentity,
  type DocumentRevision,
  type LogicalTabId,
  type MediaErrorCode,
  type MediaTarget,
  type PresenceRecord,
  type RoomId,
} from "@syncaction/protocol";
import type { PresencePrincipal, RecentPresenceAuthorizationPort } from "./presence-service.js";

type DocumentDatabase = ReturnType<typeof createDatabase>;

export class MediaServiceError extends Error {
  public readonly code: MediaErrorCode;

  public constructor(code: MediaErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "MediaServiceError";
    this.code = code;
  }
}

export interface AuthorizedDocument {
  readonly roomId: RoomId;
  readonly logicalTabId: LogicalTabId;
  readonly documentRevision: DocumentRevision;
  readonly canonicalPageIdentity: string;
  readonly role: "OWNER" | "MEMBER";
  readonly frameKey: string;
  readonly member: PresenceRecord;
}

export interface DocumentAuthorizationPort {
  authorize(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    frameKey?: unknown;
    target?: unknown;
    maxValidationAgeMs?: number;
  }): Promise<AuthorizedDocument>;
  authorizeRoomDocument(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    frameKey?: unknown;
    target?: unknown;
    maxValidationAgeMs?: number;
  }): Promise<AuthorizedDocument>;
  authorizeRoom(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    maxValidationAgeMs?: number;
  }): Promise<PresenceRecord>;
  hasRoomEntries(roomId: unknown): boolean;
  isRoomActive(roomId: unknown): Promise<boolean>;
}

export interface DocumentAuthorizationServiceOptions {
  db: DocumentDatabase;
  presence: RecentPresenceAuthorizationPort;
}

export class DocumentAuthorizationService implements DocumentAuthorizationPort {
  readonly #db: DocumentDatabase;
  readonly #presence: RecentPresenceAuthorizationPort;

  public constructor(options: DocumentAuthorizationServiceOptions) {
    this.#db = options.db;
    this.#presence = options.presence;
  }

  public async authorizeRoom(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    maxValidationAgeMs?: number;
  }): Promise<PresenceRecord> {
    const roomIdResult = RoomIdSchema.safeParse(input.roomId);
    if (!roomIdResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: roomIdResult.error,
      });
    }
    const roomId = roomIdResult.data;
    let member: PresenceRecord;
    try {
      member = this.#presence.authorizeRecent({
        ...input,
        roomId,
      });
    } catch (cause) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED", { cause });
    }
    const membership = await this.#db
      .selectFrom("roomMemberships")
      .innerJoin("rooms", "rooms.id", "roomMemberships.roomId")
      .innerJoin("users", "users.id", "roomMemberships.userId")
      .select("roomMemberships.roomId")
      .where("roomMemberships.roomId", "=", roomId)
      .where("roomMemberships.userId", "=", member.userId)
      .where("rooms.deletedAt", "is", null)
      .where("users.status", "=", "ACTIVE")
      .executeTakeFirst();
    if (membership === undefined) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }
    return member;
  }

  public hasRoomEntries(roomId: unknown): boolean {
    return this.#presence.hasRoomEntries(roomId);
  }

  public async isRoomActive(roomIdInput: unknown): Promise<boolean> {
    const roomIdResult = RoomIdSchema.safeParse(roomIdInput);
    if (!roomIdResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: roomIdResult.error,
      });
    }
    const room = await this.#db
      .selectFrom("rooms")
      .select("id")
      .where("id", "=", roomIdResult.data)
      .where("deletedAt", "is", null)
      .executeTakeFirst();
    return room !== undefined;
  }

  public async authorize(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    frameKey?: unknown;
    target?: unknown;
    maxValidationAgeMs?: number;
  }): Promise<AuthorizedDocument> {
    const request = parseDocumentRequest(input);

    let member: PresenceRecord;
    try {
      member = this.#presence.authorizeRecent({
        principal: input.principal,
        socketId: input.socketId,
        roomId: request.roomId,
        logicalTabId: request.logicalTabId,
        ...(input.frameKey === undefined ? {} : { frameKey: request.frameKey }),
        ...(input.maxValidationAgeMs === undefined
          ? {}
          : { maxValidationAgeMs: input.maxValidationAgeMs }),
      });
    } catch (cause) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED", { cause });
    }

    return await this.#authorizeCommittedDocument(request, member);
  }

  public async authorizeRoomDocument(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    frameKey?: unknown;
    target?: unknown;
    maxValidationAgeMs?: number;
  }): Promise<AuthorizedDocument> {
    const request = parseDocumentRequest(input);
    const member = await this.authorizeRoom({
      principal: input.principal,
      socketId: input.socketId,
      roomId: request.roomId,
      ...(input.maxValidationAgeMs === undefined
        ? {}
        : { maxValidationAgeMs: input.maxValidationAgeMs }),
    });
    return await this.#authorizeCommittedDocument(request, member);
  }

  async #authorizeCommittedDocument(
    request: ParsedDocumentRequest,
    member: PresenceRecord,
  ): Promise<AuthorizedDocument> {
    const committedDocument = await this.#db
      .selectFrom("roomTabs")
      .innerJoin("rooms", "rooms.id", "roomTabs.roomId")
      .innerJoin("roomMemberships", (join) =>
        join
          .onRef("roomMemberships.roomId", "=", "roomTabs.roomId")
          .on("roomMemberships.userId", "=", member.userId),
      )
      .innerJoin("users", "users.id", "roomMemberships.userId")
      .select(["rooms.roomEpoch", "roomTabs.updatedAtSeq", "roomTabs.url", "roomMemberships.role"])
      .where("rooms.id", "=", request.roomId)
      .where("rooms.deletedAt", "is", null)
      .where("roomTabs.logicalTabId", "=", request.logicalTabId)
      .where("roomTabs.closedAtSeq", "is", null)
      .where("users.status", "=", "ACTIVE")
      .executeTakeFirst();
    if (
      committedDocument === undefined ||
      committedDocument.roomEpoch !== request.documentRevision.roomEpoch ||
      committedDocument.updatedAtSeq !== request.documentRevision.tabUpdatedAtSeq
    ) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }

    let canonicalPageIdentity: string;
    try {
      canonicalPageIdentity = canonicalSharedPageIdentity(committedDocument.url);
    } catch (cause) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED", { cause });
    }
    if (
      request.target !== undefined &&
      (!targetMatchesDocument(
        request.target,
        request.logicalTabId,
        request.documentRevision,
        request.frameKey,
      ) ||
        !providerMatchesCanonicalIdentity(request.target, canonicalPageIdentity))
    ) {
      throw new MediaServiceError("TARGET_MISMATCH");
    }

    return {
      roomId: request.roomId,
      logicalTabId: request.logicalTabId,
      documentRevision: request.documentRevision,
      canonicalPageIdentity,
      role: committedDocument.role,
      frameKey: request.frameKey,
      member,
    };
  }
}

interface ParsedDocumentRequest {
  readonly roomId: RoomId;
  readonly logicalTabId: LogicalTabId;
  readonly documentRevision: DocumentRevision;
  readonly frameKey: string;
  readonly target: MediaTarget | undefined;
}

function parseDocumentRequest(input: {
  roomId: unknown;
  logicalTabId: unknown;
  documentRevision: unknown;
  frameKey?: unknown;
  target?: unknown;
}): ParsedDocumentRequest {
  const roomIdResult = RoomIdSchema.safeParse(input.roomId);
  const logicalTabIdResult = LogicalTabIdSchema.safeParse(input.logicalTabId);
  const revisionResult = DocumentRevisionSchema.safeParse(input.documentRevision);
  const targetResult =
    input.target === undefined ? undefined : MediaTargetSchema.safeParse(input.target);
  const frameKeyResult =
    input.frameKey === undefined
      ? undefined
      : CollaborationFrameKeySchema.safeParse(input.frameKey);
  if (
    !roomIdResult.success ||
    !logicalTabIdResult.success ||
    !revisionResult.success ||
    (frameKeyResult !== undefined && !frameKeyResult.success) ||
    (targetResult !== undefined && !targetResult.success)
  ) {
    throw new MediaServiceError("INVALID_MEDIA_MESSAGE");
  }
  return {
    roomId: roomIdResult.data,
    logicalTabId: logicalTabIdResult.data,
    documentRevision: revisionResult.data,
    frameKey: frameKeyResult?.data ?? targetResult?.data.frameKey ?? "top",
    target: targetResult?.data,
  };
}

function targetMatchesDocument(
  target: MediaTarget,
  logicalTabId: LogicalTabId,
  revision: DocumentRevision,
  frameKey: string,
): boolean {
  return (
    target.logicalTabId === logicalTabId &&
    target.frameKey === frameKey &&
    target.documentRevision.roomEpoch === revision.roomEpoch &&
    target.documentRevision.tabUpdatedAtSeq === revision.tabUpdatedAtSeq
  );
}

function providerMatchesCanonicalIdentity(
  target: MediaTarget,
  canonicalPageIdentity: string,
): boolean {
  if (canonicalPageIdentity.startsWith("youtube:")) {
    return target.provider === "YOUTUBE" && target.mediaKey === canonicalPageIdentity;
  }
  if (canonicalPageIdentity.startsWith("bilibili:")) {
    return target.provider === "BILIBILI" && target.mediaKey === canonicalPageIdentity;
  }
  return canonicalPageIdentity.startsWith("url:") && target.provider === "HTML5";
}
