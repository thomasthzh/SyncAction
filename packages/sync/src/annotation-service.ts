import { isDeepStrictEqual } from "node:util";
import type { createDatabase, Database } from "@syncaction/database";
import {
  AnnotationAckSchema,
  AnnotationAckV2Schema,
  AnnotationBatchItemResultSchema,
  AnnotationCommittedOperationSchema,
  AnnotationCommittedOperationV2Schema,
  AnnotationDeltaMessageSchema,
  AnnotationDeltaV2MessageSchema,
  AnnotationOperationSchema,
  AnnotationSnapshotMessageSchema,
  AnnotationSnapshotV2MessageSchema,
  AnnotationStrokeSchema,
  AnnotationStrokeV2Schema,
  AnnotationSubmitSchema,
  AnnotationSubmitV2Schema,
  AnnotationSyncRequestSchema,
  serializedAnnotationStrokeBytes,
  type AnnotationAck,
  type AnnotationAckV2,
  type AnnotationBatchItemResult,
  type AnnotationCommittedOperation,
  type AnnotationCommittedOperationV2,
  type AnnotationDeltaMessage,
  type AnnotationDeltaV2Message,
  type AnnotationOperation,
  type AnnotationOperationV2,
  type AnnotationSnapshotMessage,
  type AnnotationSnapshotV2Message,
  type AnnotationStroke,
  type AnnotationStrokeV2,
  type AnnotationSubmit,
  type AnnotationSubmitV2,
  type AnnotationSyncRequest,
} from "@syncaction/protocol";
import type { Transaction } from "kysely";
import type { AuthorizedDocument, DocumentAuthorizationPort } from "./document-authorization.js";
import { AnnotationServiceError } from "./errors.js";
import type { AnnotationPageKeyDerivationPort, AnnotationPageKeyInput } from "./page-key.js";
import type { PresencePrincipal } from "./presence-service.js";

type AnnotationDatabase = ReturnType<typeof createDatabase>;

const MAX_LIVE_STROKES = 2_000;
const MAX_LIVE_STROKE_BYTES = 5 * 1_024 * 1_024;

export interface AnnotationServiceOptions {
  db: AnnotationDatabase;
  authorization: DocumentAuthorizationPort;
  pageKeys: AnnotationPageKeyDerivationPort;
  now?: () => Date;
  deltaLimit?: number;
}

export type AnnotationServiceMode = "LEGACY" | "V2";

export interface AnnotationSubmitResult {
  readonly ack: AnnotationAck | AnnotationAckV2;
  readonly committed: AnnotationCommittedOperation | AnnotationCommittedOperationV2 | null;
  readonly legacyCommitted: AnnotationCommittedOperation | null;
  readonly v2Committed: AnnotationCommittedOperationV2 | null;
  readonly deduplicated: boolean;
}

export type AnnotationSynchronizeResult =
  | AnnotationSnapshotMessage
  | AnnotationDeltaMessage
  | AnnotationSnapshotV2Message
  | AnnotationDeltaV2Message;

interface StoredOperationPayload {
  operation: AnnotationOperation | AnnotationCommittedOperationV2["operation"];
  results: AnnotationBatchItemResult[];
  legacyVisible?: boolean;
}

interface TransactionContext {
  role: "OWNER" | "MEMBER";
}

interface AppliedOperation {
  results: AnnotationBatchItemResult[];
  liveStrokeCountDelta: number;
  liveStrokeBytesDelta: number;
  legacyVisible: boolean;
}

type AnyAnnotationSubmit = AnnotationSubmit | AnnotationSubmitV2;

type SubmitTransactionResult =
  | { kind: "COMMITTED"; result: AnnotationSubmitResult }
  | {
      kind: "REJECTED";
      code:
        | "ANNOTATION_SEQUENCE_CONFLICT"
        | "ANNOTATION_CLIENT_OP_REUSE"
        | "ANNOTATION_PAGE_CAPACITY_REACHED";
    };

export class AnnotationService {
  readonly #db: AnnotationDatabase;
  readonly #authorization: DocumentAuthorizationPort;
  readonly #pageKeys: AnnotationPageKeyDerivationPort;
  readonly #now: () => Date;
  readonly #deltaLimit: number;

  public constructor(options: AnnotationServiceOptions) {
    this.#db = options.db;
    this.#authorization = options.authorization;
    this.#pageKeys = options.pageKeys;
    this.#now = options.now ?? (() => new Date());
    this.#deltaLimit = options.deltaLimit ?? 1_000;
    if (
      !Number.isSafeInteger(this.#deltaLimit) ||
      this.#deltaLimit < 1 ||
      this.#deltaLimit > 1_000
    ) {
      throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE");
    }
  }

  public async synchronize(input: {
    mode?: AnnotationServiceMode;
    principal: PresencePrincipal;
    socketId: unknown;
    request: unknown;
  }): Promise<AnnotationSynchronizeResult> {
    const parsed = AnnotationSyncRequestSchema.safeParse(input.request);
    if (!parsed.success) {
      throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE", {
        cause: parsed.error,
      });
    }
    const mode = input.mode ?? "LEGACY";
    const request = parsed.data;
    const authorized = await this.#authorize(input.principal, input.socketId, request);
    const pageKey = this.#derivePageKey(authorized);
    await this.#assertCurrentDocument(request, authorized.member.userId);

    const page = await this.#db
      .selectFrom("annotationPages")
      .select("annotationSeq")
      .where("roomId", "=", request.roomId)
      .where("pageKey", "=", pageKey)
      .executeTakeFirst();
    const annotationSeq = page?.annotationSeq ?? 0;
    if (
      request.hasConfirmedSnapshot &&
      request.lastAnnotationSeq <= annotationSeq &&
      annotationSeq - request.lastAnnotationSeq <= this.#deltaLimit
    ) {
      const delta = await this.#delta(request, pageKey, annotationSeq, mode);
      if (delta !== null) {
        return delta;
      }
    }
    return this.#snapshot(request, pageKey, annotationSeq, mode);
  }

  public async submit(input: {
    mode?: AnnotationServiceMode;
    principal: PresencePrincipal;
    socketId: unknown;
    submission: unknown;
  }): Promise<AnnotationSubmitResult> {
    const mode = input.mode ?? "LEGACY";
    const parsed =
      mode === "V2"
        ? AnnotationSubmitV2Schema.safeParse(input.submission)
        : AnnotationSubmitSchema.safeParse(input.submission);
    if (!parsed.success) {
      throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE", {
        cause: parsed.error,
      });
    }
    const submission = parsed.data;
    let authorized: AuthorizedDocument;
    try {
      authorized = await this.#authorize(input.principal, input.socketId, submission);
    } catch {
      return this.#rejected(submission, mode, "DOCUMENT_UNAUTHORIZED", null);
    }
    const pageKey = this.#derivePageKey(authorized);
    if (submission.pageKey !== pageKey) {
      return this.#rejected(submission, mode, "PAGE_MISMATCH", pageKey);
    }

    let outcome: SubmitTransactionResult;
    try {
      outcome = await this.#db.transaction().execute(async (transaction) => {
        const context = await this.#lockCurrentDocument(
          transaction,
          submission,
          authorized.member.userId,
        );
        await transaction
          .insertInto("annotationPages")
          .values({
            roomId: submission.roomId,
            pageKey,
            annotationSeq: 0,
            liveStrokeCount: 0,
            liveStrokeBytes: 0,
            updatedAt: this.#now(),
          })
          .onConflict((conflict) => conflict.columns(["roomId", "pageKey"]).doNothing())
          .execute();
        const page = await transaction
          .selectFrom("annotationPages")
          .selectAll()
          .where("roomId", "=", submission.roomId)
          .where("pageKey", "=", pageKey)
          .forUpdate()
          .executeTakeFirstOrThrow();

        const prior = await transaction
          .selectFrom("annotationOperations")
          .selectAll()
          .where("roomId", "=", submission.roomId)
          .where("pageKey", "=", pageKey)
          .where("clientOpId", "=", submission.clientOpId)
          .executeTakeFirst();
        if (prior !== undefined) {
          const payload = this.#storedPayload(prior.operation);
          if (!isDeepStrictEqual(payload.operation, submission.operation)) {
            return {
              kind: "REJECTED",
              code: "ANNOTATION_CLIENT_OP_REUSE",
            };
          }
          const projections = this.#committedProjections(prior);
          const committed = mode === "V2" ? projections.v2Committed : projections.legacyCommitted;
          if (committed === null) {
            return {
              kind: "REJECTED",
              code: "ANNOTATION_CLIENT_OP_REUSE",
            };
          }
          return {
            kind: "COMMITTED",
            result: {
              ack: this.#acceptedAck(submission, mode, committed),
              committed,
              ...projections,
              deduplicated: true,
            },
          };
        }

        if (submission.baseAnnotationSeq > page.annotationSeq) {
          return {
            kind: "REJECTED",
            code: "ANNOTATION_SEQUENCE_CONFLICT",
          };
        }
        if (
          submission.operation.type === "stroke.create" &&
          (page.liveStrokeCount >= MAX_LIVE_STROKES ||
            page.liveStrokeBytes + serializedAnnotationStrokeBytes(submission.operation.stroke) >
              MAX_LIVE_STROKE_BYTES)
        ) {
          return {
            kind: "REJECTED",
            code: "ANNOTATION_PAGE_CAPACITY_REACHED",
          };
        }

        const committedAt = this.#now();
        const applied = await this.#applyOperation(
          transaction,
          submission,
          mode,
          context,
          authorized.member.userId,
          committedAt,
        );
        const annotationSeq = page.annotationSeq + 1;
        const liveStrokeCount = page.liveStrokeCount + applied.liveStrokeCountDelta;
        const liveStrokeBytes = page.liveStrokeBytes + applied.liveStrokeBytesDelta;
        if (liveStrokeCount < 0 || liveStrokeBytes < 0) {
          throw new AnnotationServiceError("ANNOTATION_OPERATION_REJECTED");
        }

        const payload: StoredOperationPayload = {
          operation: submission.operation,
          results: applied.results,
          legacyVisible: applied.legacyVisible,
        };
        await transaction
          .insertInto("annotationOperations")
          .values({
            roomId: submission.roomId,
            pageKey,
            annotationSeq,
            clientOpId: submission.clientOpId,
            actorUserId: authorized.member.userId,
            operation: payload as unknown as Record<string, unknown>,
            createdAt: committedAt,
          })
          .execute();
        await transaction
          .updateTable("annotationPages")
          .set({
            annotationSeq,
            liveStrokeCount,
            liveStrokeBytes,
            updatedAt: committedAt,
          })
          .where("roomId", "=", submission.roomId)
          .where("pageKey", "=", pageKey)
          .executeTakeFirstOrThrow();

        const stored = {
          roomId: submission.roomId,
          pageKey,
          annotationSeq,
          clientOpId: submission.clientOpId,
          actorUserId: authorized.member.userId,
          operation: payload as unknown as Record<string, unknown>,
          createdAt: committedAt,
        };
        const projections = this.#committedProjections(stored);
        const committed = mode === "V2" ? projections.v2Committed : projections.legacyCommitted;
        if (committed === null) {
          throw new AnnotationServiceError("ANNOTATION_OPERATION_REJECTED");
        }
        return {
          kind: "COMMITTED",
          result: {
            ack: this.#acceptedAck(submission, mode, committed),
            committed,
            ...projections,
            deduplicated: false,
          },
        };
      });
    } catch (cause) {
      if (cause instanceof AnnotationServiceError) {
        if (cause.code === "DOCUMENT_UNAUTHORIZED") {
          return this.#rejected(submission, mode, "DOCUMENT_UNAUTHORIZED", pageKey);
        }
        throw cause;
      }
      throw new AnnotationServiceError("ANNOTATION_OPERATION_REJECTED", {
        cause,
      });
    }

    if (outcome.kind === "REJECTED") {
      return this.#rejected(submission, mode, outcome.code, pageKey);
    }
    return outcome.result;
  }

  async #authorize(
    principal: PresencePrincipal,
    socketId: unknown,
    document: {
      roomId: unknown;
      logicalTabId: unknown;
      documentRevision: unknown;
      frameKey: unknown;
    },
  ): Promise<AuthorizedDocument> {
    try {
      return await this.#authorization.authorize({
        principal,
        socketId,
        roomId: document.roomId,
        logicalTabId: document.logicalTabId,
        documentRevision: document.documentRevision,
        frameKey: document.frameKey,
      });
    } catch (cause) {
      throw new AnnotationServiceError("DOCUMENT_UNAUTHORIZED", { cause });
    }
  }

  #derivePageKey(authorized: AuthorizedDocument): string {
    const input: AnnotationPageKeyInput = {
      roomId: authorized.roomId,
      canonicalPageIdentity: authorized.canonicalPageIdentity,
    };
    try {
      return this.#pageKeys.derive(input);
    } catch (cause) {
      throw new AnnotationServiceError("ANNOTATION_OPERATION_REJECTED", {
        cause,
      });
    }
  }

  async #assertCurrentDocument(request: AnnotationSyncRequest, userId: string): Promise<void> {
    const document = await this.#db
      .selectFrom("roomTabs")
      .innerJoin("rooms", "rooms.id", "roomTabs.roomId")
      .innerJoin("roomMemberships", (join) =>
        join
          .onRef("roomMemberships.roomId", "=", "roomTabs.roomId")
          .on("roomMemberships.userId", "=", userId),
      )
      .innerJoin("users", "users.id", "roomMemberships.userId")
      .select(["rooms.roomEpoch", "roomTabs.updatedAtSeq"])
      .where("rooms.id", "=", request.roomId)
      .where("rooms.deletedAt", "is", null)
      .where("roomTabs.logicalTabId", "=", request.logicalTabId)
      .where("roomTabs.closedAtSeq", "is", null)
      .where("users.status", "=", "ACTIVE")
      .executeTakeFirst();
    if (
      document === undefined ||
      document.roomEpoch !== request.documentRevision.roomEpoch ||
      document.updatedAtSeq !== request.documentRevision.tabUpdatedAtSeq
    ) {
      throw new AnnotationServiceError("DOCUMENT_UNAUTHORIZED");
    }
  }

  async #lockCurrentDocument(
    transaction: Transaction<Database>,
    submission: AnyAnnotationSubmit,
    userId: string,
  ): Promise<TransactionContext> {
    const document = await transaction
      .selectFrom("roomTabs")
      .innerJoin("rooms", "rooms.id", "roomTabs.roomId")
      .innerJoin("roomMemberships", (join) =>
        join
          .onRef("roomMemberships.roomId", "=", "roomTabs.roomId")
          .on("roomMemberships.userId", "=", userId),
      )
      .innerJoin("users", "users.id", "roomMemberships.userId")
      .select(["rooms.roomEpoch", "roomTabs.updatedAtSeq", "roomMemberships.role"])
      .where("rooms.id", "=", submission.roomId)
      .where("rooms.deletedAt", "is", null)
      .where("roomTabs.logicalTabId", "=", submission.logicalTabId)
      .where("roomTabs.closedAtSeq", "is", null)
      .where("users.status", "=", "ACTIVE")
      .forUpdate()
      .executeTakeFirst();
    if (
      document === undefined ||
      document.roomEpoch !== submission.documentRevision.roomEpoch ||
      document.updatedAtSeq !== submission.documentRevision.tabUpdatedAtSeq
    ) {
      throw new AnnotationServiceError("DOCUMENT_UNAUTHORIZED");
    }
    return { role: document.role };
  }

  async #applyOperation(
    transaction: Transaction<Database>,
    submission: AnyAnnotationSubmit,
    mode: AnnotationServiceMode,
    context: TransactionContext,
    actorUserId: string,
    committedAt: Date,
  ): Promise<AppliedOperation> {
    const operation = submission.operation;
    if (operation.type === "stroke.create") {
      return this.#applyCreate(
        transaction,
        submission.roomId,
        submission.pageKey,
        operation,
        mode,
        actorUserId,
        committedAt,
      );
    }
    return this.#applyMutation(
      transaction,
      submission.roomId,
      submission.pageKey,
      operation,
      mode,
      context,
      actorUserId,
      committedAt,
    );
  }

  async #applyCreate(
    transaction: Transaction<Database>,
    roomId: string,
    pageKey: string,
    operation:
      | Extract<AnnotationOperation, { type: "stroke.create" }>
      | Extract<AnnotationOperationV2, { type: "stroke.create" }>,
    mode: AnnotationServiceMode,
    actorUserId: string,
    committedAt: Date,
  ): Promise<AppliedOperation> {
    const stroke = operation.stroke;
    const existing = await transaction
      .selectFrom("annotationStrokes")
      .select(["version", "deletedAt", "contentSignature"])
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .where("strokeId", "=", stroke.strokeId)
      .forUpdate()
      .executeTakeFirst();
    if (existing !== undefined) {
      return {
        results: [
          rejectedItem(
            stroke.strokeId,
            existing.deletedAt === null ? "STROKE_VERSION_CONFLICT" : "STROKE_DELETED",
            existing.version,
          ),
        ],
        liveStrokeCountDelta: 0,
        liveStrokeBytesDelta: 0,
        legacyVisible: existing.contentSignature === null,
      };
    }

    const byteSize = serializedAnnotationStrokeBytes(stroke);
    await transaction
      .insertInto("annotationStrokes")
      .values({
        roomId,
        pageKey,
        strokeId: stroke.strokeId,
        authorUserId: actorUserId,
        frameKey: stroke.frameKey,
        anchor: stroke.anchor,
        points: JSON.stringify(stroke.points),
        rgb: stroke.rgb,
        width: stroke.width,
        byteSize,
        contentSignature:
          mode === "V2" && "contentSignature" in stroke ? stroke.contentSignature.digest : null,
        signatureVersion:
          mode === "V2" && "contentSignature" in stroke
            ? stroke.contentSignature.signatureVersion
            : null,
        lockedAt: null,
        version: 1,
        createdAt: committedAt,
        deletedAt: null,
      })
      .execute();
    return {
      results: [acceptedItem(stroke.strokeId, 1)],
      liveStrokeCountDelta: 1,
      liveStrokeBytesDelta: byteSize,
      legacyVisible: mode === "LEGACY",
    };
  }

  async #applyMutation(
    transaction: Transaction<Database>,
    roomId: string,
    pageKey: string,
    operation: Exclude<AnnotationOperationV2, { type: "stroke.create" }>,
    mode: AnnotationServiceMode,
    context: TransactionContext,
    actorUserId: string,
    committedAt: Date,
  ): Promise<AppliedOperation> {
    const ids = operation.items.map((item) => item.strokeId);
    let rowsQuery = transaction
      .selectFrom("annotationStrokes")
      .selectAll()
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .where("strokeId", "in", ids);
    if (mode === "LEGACY") {
      rowsQuery = rowsQuery.where("contentSignature", "is", null);
    }
    const rows = await rowsQuery.forUpdate().execute();
    const rowsById = new Map(rows.map((row) => [row.strokeId, row]));
    const results: AnnotationBatchItemResult[] = [];
    let liveStrokeCountDelta = 0;
    let liveStrokeBytesDelta = 0;
    for (const item of operation.items) {
      const stroke = rowsById.get(item.strokeId);
      if (stroke === undefined) {
        results.push(rejectedItem(item.strokeId, "STROKE_NOT_FOUND", null));
        continue;
      }
      if (stroke.deletedAt !== null) {
        results.push(rejectedItem(item.strokeId, "STROKE_DELETED", stroke.version));
        continue;
      }
      if (stroke.version !== item.expectedVersion) {
        results.push(rejectedItem(item.strokeId, "STROKE_VERSION_CONFLICT", stroke.version));
        continue;
      }

      if (operation.type === "stroke.delete") {
        if (
          stroke.lockedAt !== null &&
          stroke.authorUserId !== actorUserId &&
          context.role !== "OWNER"
        ) {
          results.push(rejectedItem(item.strokeId, "STROKE_PERMISSION_DENIED", stroke.version));
          continue;
        }
        const nextVersion = stroke.version + 1;
        await transaction
          .updateTable("annotationStrokes")
          .set({ deletedAt: committedAt, version: nextVersion })
          .where("roomId", "=", roomId)
          .where("pageKey", "=", pageKey)
          .where("strokeId", "=", item.strokeId)
          .executeTakeFirstOrThrow();
        if (
          stroke.lockedAt !== null &&
          stroke.authorUserId !== actorUserId &&
          context.role === "OWNER"
        ) {
          await transaction
            .insertInto("auditEvents")
            .values({
              actorUserId,
              actorAdministratorId: null,
              eventType: "annotation.owner_override_delete",
              targetType: "annotation_stroke",
              targetId: stroke.strokeId,
              details: {
                strokeId: stroke.strokeId,
                authorUserId: stroke.authorUserId,
                actorUserId,
                reasonCode: "ROOM_OWNER_LOCKED_STROKE_DELETE",
              },
              createdAt: committedAt,
            })
            .execute();
        }
        results.push(acceptedItem(item.strokeId, nextVersion));
        liveStrokeCountDelta -= 1;
        liveStrokeBytesDelta -= stroke.byteSize;
        continue;
      }

      if (stroke.authorUserId !== actorUserId) {
        results.push(rejectedItem(item.strokeId, "NOT_STROKE_AUTHOR", stroke.version));
        continue;
      }
      if (operation.type === "stroke.lock" && stroke.lockedAt !== null) {
        results.push(rejectedItem(item.strokeId, "STROKE_LOCKED", stroke.version));
        continue;
      }
      if (operation.type === "stroke.unlock" && stroke.lockedAt === null) {
        results.push(rejectedItem(item.strokeId, "STROKE_NOT_LOCKED", stroke.version));
        continue;
      }

      const nextVersion = stroke.version + 1;
      await transaction
        .updateTable("annotationStrokes")
        .set({
          lockedAt: operation.type === "stroke.lock" ? committedAt : null,
          version: nextVersion,
        })
        .where("roomId", "=", roomId)
        .where("pageKey", "=", pageKey)
        .where("strokeId", "=", item.strokeId)
        .executeTakeFirstOrThrow();
      results.push(acceptedItem(item.strokeId, nextVersion));
    }

    return {
      results,
      liveStrokeCountDelta,
      liveStrokeBytesDelta,
      legacyVisible: rows.every((stroke) => stroke.contentSignature === null),
    };
  }

  async #delta(
    request: AnnotationSyncRequest,
    pageKey: string,
    annotationSeq: number,
    mode: AnnotationServiceMode,
  ): Promise<AnnotationDeltaMessage | AnnotationDeltaV2Message | null> {
    const rows = await this.#db
      .selectFrom("annotationOperations")
      .selectAll()
      .where("roomId", "=", request.roomId)
      .where("pageKey", "=", pageKey)
      .where("annotationSeq", ">", request.lastAnnotationSeq)
      .where("annotationSeq", "<=", annotationSeq)
      .orderBy("annotationSeq")
      .execute();
    if (rows.length !== annotationSeq - request.lastAnnotationSeq) {
      return null;
    }
    const projections = rows.map((row) => this.#committedProjections(row));
    const operations =
      mode === "V2"
        ? projections.map(({ v2Committed }) => v2Committed)
        : projections.map(({ legacyCommitted }) => legacyCommitted);
    if (operations.some((operation) => operation === null)) {
      return null;
    }
    try {
      const envelope = {
        protocolVersion: 1,
        roomId: request.roomId,
        logicalTabId: request.logicalTabId,
        documentRevision: request.documentRevision,
        frameKey: request.frameKey,
        pageKey,
        fromAnnotationSeq: request.lastAnnotationSeq,
        toAnnotationSeq: annotationSeq,
        operations,
      };
      return mode === "V2"
        ? AnnotationDeltaV2MessageSchema.parse({
            ...envelope,
            type: "annotation.delta.v2",
          })
        : AnnotationDeltaMessageSchema.parse({
            ...envelope,
            type: "annotation.delta",
          });
    } catch {
      return null;
    }
  }

  async #snapshot(
    request: AnnotationSyncRequest,
    pageKey: string,
    annotationSeq: number,
    mode: AnnotationServiceMode,
  ): Promise<AnnotationSnapshotMessage | AnnotationSnapshotV2Message> {
    let query = this.#db
      .selectFrom("annotationStrokes")
      .selectAll()
      .where("roomId", "=", request.roomId)
      .where("pageKey", "=", pageKey)
      .where("deletedAt", "is", null);
    if (mode === "LEGACY") {
      query = query.where("contentSignature", "is", null);
    }
    const rows = await query.orderBy("createdAt").orderBy("strokeId").execute();
    const envelope = {
      protocolVersion: 1,
      roomId: request.roomId,
      logicalTabId: request.logicalTabId,
      documentRevision: request.documentRevision,
      frameKey: request.frameKey,
      pageKey,
      annotationSeq,
    };
    return mode === "V2"
      ? AnnotationSnapshotV2MessageSchema.parse({
          ...envelope,
          type: "annotation.snapshot.v2",
          strokes: rows.map(toProtocolStrokeV2),
        })
      : AnnotationSnapshotMessageSchema.parse({
          ...envelope,
          type: "annotation.snapshot",
          strokes: rows.map(toProtocolStroke),
        });
  }

  #storedPayload(operation: Record<string, unknown>): StoredOperationPayload {
    return operation as unknown as StoredOperationPayload;
  }

  #committedProjections(row: {
    roomId: string;
    pageKey: string;
    annotationSeq: number;
    clientOpId: string;
    actorUserId: string;
    operation: Record<string, unknown>;
    createdAt: Date;
  }): {
    legacyCommitted: AnnotationCommittedOperation | null;
    v2Committed: AnnotationCommittedOperationV2;
  } {
    const payload = this.#storedPayload(row.operation);
    const base = {
      protocolVersion: 1,
      clientOpId: row.clientOpId,
      roomId: row.roomId,
      pageKey: row.pageKey,
      annotationSeq: row.annotationSeq,
      actorUserId: row.actorUserId,
      results: payload.results,
      createdAtServerMs: timestampMs(row.createdAt),
    };
    const v2Committed = AnnotationCommittedOperationV2Schema.parse({
      ...base,
      type: "annotation.committed.v2",
      operation: toV2Operation(payload.operation),
    });
    const legacyOperation =
      payload.legacyVisible === false ? null : toLegacyOperation(payload.operation);
    return {
      legacyCommitted:
        legacyOperation === null
          ? null
          : AnnotationCommittedOperationSchema.parse({
              ...base,
              type: "annotation.committed",
              operation: legacyOperation,
            }),
      v2Committed,
    };
  }

  #acceptedAck(
    submission: AnyAnnotationSubmit,
    mode: AnnotationServiceMode,
    committed: AnnotationCommittedOperation | AnnotationCommittedOperationV2,
  ): AnnotationAck | AnnotationAckV2 {
    const envelope = {
      protocolVersion: 1,
      clientOpId: submission.clientOpId,
      roomId: submission.roomId,
      accepted: true,
      code: null,
      pageKey: committed.pageKey,
      annotationSeq: committed.annotationSeq,
      results: committed.results,
    };
    return mode === "V2"
      ? AnnotationAckV2Schema.parse({ ...envelope, type: "annotation.ack.v2" })
      : AnnotationAckSchema.parse({ ...envelope, type: "annotation.ack" });
  }

  #rejected(
    submission: AnyAnnotationSubmit,
    mode: AnnotationServiceMode,
    code:
      | "DOCUMENT_UNAUTHORIZED"
      | "PAGE_MISMATCH"
      | "ANNOTATION_SEQUENCE_CONFLICT"
      | "ANNOTATION_CLIENT_OP_REUSE"
      | "ANNOTATION_PAGE_CAPACITY_REACHED",
    pageKey: string | null,
  ): AnnotationSubmitResult {
    const envelope = {
      protocolVersion: 1,
      clientOpId: submission.clientOpId,
      roomId: submission.roomId,
      accepted: false as const,
      code,
      pageKey,
      annotationSeq: null,
      results: [],
    };
    return {
      ack:
        mode === "V2"
          ? AnnotationAckV2Schema.parse({ ...envelope, type: "annotation.ack.v2" })
          : AnnotationAckSchema.parse({ ...envelope, type: "annotation.ack" }),
      committed: null,
      legacyCommitted: null,
      v2Committed: null,
      deduplicated: false,
    };
  }
}

function acceptedItem(strokeId: string, version: number): AnnotationBatchItemResult {
  return AnnotationBatchItemResultSchema.parse({
    strokeId,
    accepted: true,
    code: null,
    version,
  });
}

function rejectedItem(
  strokeId: string,
  code: Exclude<AnnotationBatchItemResult, { accepted: true }>["code"],
  version: number | null,
): AnnotationBatchItemResult {
  return AnnotationBatchItemResultSchema.parse({
    strokeId,
    accepted: false,
    code,
    version,
  });
}

function timestampMs(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new AnnotationServiceError("ANNOTATION_OPERATION_REJECTED");
  }
  return milliseconds;
}

function toV2Operation(
  operation: StoredOperationPayload["operation"],
): AnnotationCommittedOperationV2["operation"] {
  if (operation.type !== "stroke.create" || "contentSignature" in operation.stroke) {
    return operation as AnnotationCommittedOperationV2["operation"];
  }
  return {
    ...operation,
    stroke: {
      ...operation.stroke,
      contentSignature: null,
    },
  };
}

function toLegacyOperation(
  operation: StoredOperationPayload["operation"],
): AnnotationOperation | null {
  if (operation.type !== "stroke.create") {
    return AnnotationOperationSchema.parse(operation);
  }
  if (!("contentSignature" in operation.stroke)) {
    return AnnotationOperationSchema.parse(operation);
  }
  if (operation.stroke.contentSignature !== null) {
    return null;
  }
  const stroke: Record<string, unknown> = structuredClone(operation.stroke);
  Reflect.deleteProperty(stroke, "contentSignature");
  const parsed = AnnotationOperationSchema.safeParse({
    ...operation,
    stroke,
  });
  return parsed.success ? parsed.data : null;
}

function toProtocolStroke(row: {
  strokeId: string;
  authorUserId: string;
  frameKey: string;
  anchor: Record<string, unknown>;
  points: Record<string, unknown>[];
  rgb: Record<string, unknown>;
  width: number;
  lockedAt: Date | null;
  version: number;
  createdAt: Date;
  deletedAt: Date | null;
}): AnnotationStroke {
  return AnnotationStrokeSchema.parse({
    strokeId: row.strokeId,
    authorUserId: row.authorUserId,
    frameKey: row.frameKey,
    anchor: row.anchor,
    points: row.points,
    rgb: row.rgb,
    width: row.width,
    lockedAtServerMs: row.lockedAt === null ? null : timestampMs(row.lockedAt),
    version: row.version,
    createdAtServerMs: timestampMs(row.createdAt),
    deletedAtServerMs: row.deletedAt === null ? null : timestampMs(row.deletedAt),
  });
}

function toProtocolStrokeV2(row: {
  strokeId: string;
  authorUserId: string;
  frameKey: string;
  anchor: Record<string, unknown>;
  points: Record<string, unknown>[];
  rgb: Record<string, unknown>;
  width: number;
  contentSignature: string | null;
  signatureVersion: number | null;
  lockedAt: Date | null;
  version: number;
  createdAt: Date;
  deletedAt: Date | null;
}): AnnotationStrokeV2 {
  return AnnotationStrokeV2Schema.parse({
    strokeId: row.strokeId,
    authorUserId: row.authorUserId,
    frameKey: row.frameKey,
    anchor: row.anchor,
    points: row.points,
    rgb: row.rgb,
    width: row.width,
    contentSignature:
      row.contentSignature === null || row.signatureVersion === null
        ? null
        : {
            digest: row.contentSignature,
            signatureVersion: row.signatureVersion,
          },
    lockedAtServerMs: row.lockedAt === null ? null : timestampMs(row.lockedAt),
    version: row.version,
    createdAtServerMs: timestampMs(row.createdAt),
    deletedAtServerMs: row.deletedAt === null ? null : timestampMs(row.deletedAt),
  });
}
