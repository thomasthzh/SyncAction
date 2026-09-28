import {
  AnnotationAckV2Schema,
  AnnotationCommittedOperationV2Schema,
  AnnotationDeltaV2MessageSchema,
  AnnotationErrorCodeSchema,
  AnnotationItemErrorCodeSchema,
  AnnotationOperationV2Schema,
  AnnotationPageKeySchema,
  AnnotationSnapshotV2MessageSchema,
  AnnotationStrokeSchema,
  AnnotationStrokeDraftV2Schema,
  AnnotationStrokeV2Schema,
  CanonicalUuidSchema,
  CollaborationFrameKeySchema,
  RoomIdSchema,
  type AnnotationAckV2,
  type AnnotationCommittedOperationV2,
  type AnnotationDeltaV2Message,
  type AnnotationOperationV2,
  type AnnotationSnapshotV2Message,
  type AnnotationStrokeV2,
  type AnnotationStrokeDraftV2,
} from "@syncaction/protocol";
import { z } from "zod";
import { DEFAULT_SERVER_PROFILE_ID, ServerProfileIdSchema } from "./server-profile.js";
import { serverScopedStorageKey } from "./scoped-storage.js";

const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const LegacyAnnotationConfirmedSnapshotSchema = z
  .object({
    annotationSeq: SafeNonnegativeIntegerSchema,
    strokes: z.array(AnnotationStrokeSchema).max(2_000),
  })
  .strict();

export interface AnnotationReplicaStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const AnnotationConfirmedSnapshotSchema = z
  .object({
    annotationSeq: SafeNonnegativeIntegerSchema,
    strokes: z.array(AnnotationStrokeV2Schema).max(2_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const strokeIds = new Set<string>();
    for (const [index, stroke] of snapshot.strokes.entries()) {
      if (strokeIds.has(stroke.strokeId)) {
        context.addIssue({
          code: "custom",
          path: ["strokes", index, "strokeId"],
          message: "annotation replica snapshot contains a duplicate stroke",
        });
      }
      strokeIds.add(stroke.strokeId);
    }
  });

export const AnnotationOutboxItemSchema = z
  .object({
    clientOpId: CanonicalUuidSchema,
    frameKey: CollaborationFrameKeySchema.optional(),
    baseAnnotationSeq: SafeNonnegativeIntegerSchema,
    operation: AnnotationOperationV2Schema,
    state: z.enum(["QUEUED", "ACKNOWLEDGED", "FAILED"]),
    acknowledgement: AnnotationAckV2Schema.nullable(),
    errorCode: AnnotationErrorCodeSchema.nullable(),
    enqueuedAtMs: SafeNonnegativeIntegerSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (item.acknowledgement !== null && item.acknowledgement.clientOpId !== item.clientOpId) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgement", "clientOpId"],
        message: "annotation acknowledgement belongs to another operation",
      });
    }
    if (item.state === "QUEUED" && (item.acknowledgement !== null || item.errorCode !== null)) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "queued annotation operation cannot have an acknowledgement",
      });
    }
    if (
      item.state === "ACKNOWLEDGED" &&
      (item.acknowledgement?.accepted !== true || item.errorCode !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "acknowledged annotation operation requires an accepted acknowledgement",
      });
    }
    if (
      item.state === "FAILED" &&
      (item.acknowledgement?.accepted !== false || item.errorCode === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "failed annotation operation requires a rejected acknowledgement",
      });
    }
  });

export const AnnotationLocalDraftSchema = z
  .object({
    clientOpId: CanonicalUuidSchema,
    draft: AnnotationStrokeDraftV2Schema,
    status: z.enum(["PENDING", "ERROR"]),
    errorCode: z.union([AnnotationErrorCodeSchema, AnnotationItemErrorCodeSchema]).nullable(),
  })
  .strict()
  .superRefine((draft, context) => {
    if (draft.status === "PENDING" && draft.errorCode !== null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "pending local draft cannot have an error",
      });
    }
    if (draft.status === "ERROR" && draft.errorCode === null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "failed local draft requires an error",
      });
    }
  });

export const AnnotationReplicaRecordSchema = z
  .object({
    schemaVersion: z.literal(3),
    profileId: ServerProfileIdSchema,
    userId: CanonicalUuidSchema,
    roomId: RoomIdSchema,
    pageKey: AnnotationPageKeySchema,
    mode: z.enum(["UNINITIALIZED", "SYNCED", "RECOVERING", "QUARANTINED"]),
    confirmedSnapshot: AnnotationConfirmedSnapshotSchema.nullable(),
    outbox: z.array(AnnotationOutboxItemSchema).max(2_000),
    localDrafts: z.array(AnnotationLocalDraftSchema).max(2_000),
    quarantineReason: z.enum(["CORRUPT_ANNOTATION_REPLICA", "STORAGE_FAILURE"]).nullable(),
    updatedAtMs: SafeNonnegativeIntegerSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.mode === "UNINITIALIZED" && record.confirmedSnapshot !== null) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSnapshot"],
        message: "uninitialized annotation replica cannot have a snapshot",
      });
    }
    if (
      (record.mode === "SYNCED" || record.mode === "RECOVERING") &&
      record.confirmedSnapshot === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSnapshot"],
        message: "active annotation replica requires a snapshot",
      });
    }
    if (record.mode === "QUARANTINED" && record.quarantineReason === null) {
      context.addIssue({
        code: "custom",
        path: ["quarantineReason"],
        message: "quarantined annotation replica requires a reason",
      });
    }
    if (record.mode !== "QUARANTINED" && record.quarantineReason !== null) {
      context.addIssue({
        code: "custom",
        path: ["quarantineReason"],
        message: "only quarantined annotation replicas can have a quarantine reason",
      });
    }
    if (
      record.confirmedSnapshot === null &&
      (record.outbox.length > 0 || record.localDrafts.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSnapshot"],
        message: "annotation operations require a confirmed page snapshot",
      });
    }

    const operationIds = new Set<string>();
    for (const [index, item] of record.outbox.entries()) {
      if (operationIds.has(item.clientOpId)) {
        context.addIssue({
          code: "custom",
          path: ["outbox", index, "clientOpId"],
          message: "annotation outbox operation ID must be unique",
        });
      }
      operationIds.add(item.clientOpId);
      if (
        item.acknowledgement !== null &&
        (item.acknowledgement.roomId !== record.roomId ||
          (item.acknowledgement.pageKey !== null &&
            item.acknowledgement.pageKey !== record.pageKey))
      ) {
        context.addIssue({
          code: "custom",
          path: ["outbox", index, "acknowledgement"],
          message: "annotation acknowledgement belongs to another page",
        });
      }
    }

    const draftIds = new Set<string>();
    for (const [index, draft] of record.localDrafts.entries()) {
      if (draftIds.has(draft.draft.strokeId)) {
        context.addIssue({
          code: "custom",
          path: ["localDrafts", index, "draft", "strokeId"],
          message: "local annotation draft stroke ID must be unique",
        });
      }
      draftIds.add(draft.draft.strokeId);
      const operation = record.outbox.find((item) => item.clientOpId === draft.clientOpId);
      if (
        operation !== undefined &&
        (operation.operation.type !== "stroke.create" ||
          operation.operation.stroke.strokeId !== draft.draft.strokeId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["localDrafts", index, "clientOpId"],
          message: "local annotation draft does not match its create operation",
        });
      }
    }
  });

export type AnnotationReplicaRecord = z.infer<typeof AnnotationReplicaRecordSchema>;
export type AnnotationOutboxItem = z.infer<typeof AnnotationOutboxItemSchema>;
export type AnnotationLocalDraft = z.infer<typeof AnnotationLocalDraftSchema>;

export interface AnnotationReplicaOptions {
  area: AnnotationReplicaStorageArea;
  profileId: unknown;
  userId: unknown;
  now?: () => number;
}

export interface EnqueueFinalOperationInput {
  roomId: unknown;
  pageKey: unknown;
  clientOpId: unknown;
  operation: AnnotationOperationV2;
  localDraft?: AnnotationStrokeDraftV2;
  frameKey?: unknown;
}

export interface RetryableAnnotationOperation {
  clientOpId: string;
  frameKey: string;
  baseAnnotationSeq: number;
  operation: AnnotationOperationV2;
}

export type AnnotationApplyResult =
  | { kind: "APPLIED"; record: AnnotationReplicaRecord }
  | { kind: "SNAPSHOT_REQUIRED"; record: AnnotationReplicaRecord };

export function annotationReplicaStorageKey(
  profileIdInput: unknown,
  userIdInput: unknown,
  roomIdInput: unknown,
  pageKeyInput: unknown,
): string {
  const profileId = ServerProfileIdSchema.parse(profileIdInput);
  const userId = CanonicalUuidSchema.parse(userIdInput);
  const roomId = RoomIdSchema.parse(roomIdInput);
  const pageKey = AnnotationPageKeySchema.parse(pageKeyInput);
  return serverScopedStorageKey(profileId, `annotation-replica.v3.${userId}.${roomId}.${pageKey}`);
}

function legacyAnnotationReplicaStorageKey(
  userId: string,
  roomId: string,
  pageKey: string,
): string {
  return `syncaction.annotation-replica.v2.${userId}.${roomId}.${pageKey}`;
}

export class AnnotationReplica {
  readonly #area: AnnotationReplicaStorageArea;
  readonly #profileId: string;
  readonly #userId: string;
  readonly #now: () => number;
  readonly #tails = new Map<string, Promise<void>>();

  public constructor(options: AnnotationReplicaOptions) {
    this.#area = options.area;
    this.#profileId = ServerProfileIdSchema.parse(options.profileId);
    this.#userId = CanonicalUuidSchema.parse(options.userId);
    this.#now = options.now ?? Date.now;
  }

  public async load(roomIdInput: unknown, pageKeyInput: unknown): Promise<AnnotationReplicaRecord> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const pageKey = AnnotationPageKeySchema.parse(pageKeyInput);
    const storageKey = this.#storageKey(roomId, pageKey);
    return this.#serialize(storageKey, () => this.#read(roomId, pageKey, storageKey));
  }

  public async applySnapshot(
    snapshotInput: AnnotationSnapshotV2Message,
  ): Promise<AnnotationReplicaRecord> {
    const snapshot = AnnotationSnapshotV2MessageSchema.parse(snapshotInput);
    const storageKey = this.#storageKey(snapshot.roomId, snapshot.pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(snapshot.roomId, snapshot.pageKey, storageKey);
      this.#requireMutable(current);
      const confirmed = current.confirmedSnapshot;
      if (confirmed !== null && snapshot.annotationSeq < confirmed.annotationSeq) {
        throw new Error("ANNOTATION_SNAPSHOT_REGRESSION");
      }
      if (
        confirmed !== null &&
        snapshot.annotationSeq === confirmed.annotationSeq &&
        !sameAuthoritativeStrokes(confirmed.strokes, snapshot.strokes)
      ) {
        throw new Error("ANNOTATION_SNAPSHOT_CONFLICT");
      }
      const confirmedStrokeIds = new Set(snapshot.strokes.map((stroke) => stroke.strokeId));
      const localDrafts = current.localDrafts.filter(
        (local) => !confirmedStrokeIds.has(local.draft.strokeId),
      );
      const outbox = current.outbox.filter((item) => {
        if (
          item.operation.type === "stroke.create" &&
          confirmedStrokeIds.has(item.operation.stroke.strokeId)
        ) {
          return false;
        }
        const acknowledgement = item.acknowledgement;
        if (
          item.state === "ACKNOWLEDGED" &&
          acknowledgement?.accepted === true &&
          acknowledgement.annotationSeq <= snapshot.annotationSeq
        ) {
          return false;
        }
        return true;
      });
      const retainedOperationIds = new Set(outbox.map((item) => item.clientOpId));
      const reconciledDrafts = localDrafts.filter((local) => {
        if (retainedOperationIds.has(local.clientOpId)) {
          return true;
        }
        const prior = current.outbox.find((item) => item.clientOpId === local.clientOpId);
        if (
          prior?.acknowledgement?.accepted === true &&
          prior.acknowledgement.results.some(
            (result) => result.strokeId === local.draft.strokeId && !result.accepted,
          )
        ) {
          return true;
        }
        return prior === undefined;
      });
      return this.#write(
        storageKey,
        this.#parseRecord({
          ...current,
          mode: "SYNCED",
          confirmedSnapshot: {
            annotationSeq: snapshot.annotationSeq,
            strokes: snapshot.strokes,
          },
          outbox,
          localDrafts: reconciledDrafts,
          quarantineReason: null,
        }),
      );
    });
  }

  public async enqueueFinalOperation(
    input: EnqueueFinalOperationInput,
  ): Promise<AnnotationReplicaRecord> {
    const roomId = RoomIdSchema.parse(input.roomId);
    const pageKey = AnnotationPageKeySchema.parse(input.pageKey);
    const clientOpId = CanonicalUuidSchema.parse(input.clientOpId);
    const operation = AnnotationOperationV2Schema.parse(input.operation);
    const frameKey = CollaborationFrameKeySchema.parse(
      input.frameKey ??
        (operation.type === "stroke.create" ? operation.stroke.frameKey : undefined),
    );
    const localDraft =
      input.localDraft === undefined
        ? undefined
        : AnnotationStrokeDraftV2Schema.parse(input.localDraft);
    if (
      localDraft !== undefined &&
      (operation.type !== "stroke.create" || operation.stroke.strokeId !== localDraft.strokeId)
    ) {
      throw new Error("ANNOTATION_DRAFT_OPERATION_MISMATCH");
    }
    const storageKey = this.#storageKey(roomId, pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(roomId, pageKey, storageKey);
      this.#requireSynchronized(current);
      const existing = current.outbox.find((item) => item.clientOpId === clientOpId);
      if (existing !== undefined) {
        if (JSON.stringify(existing.operation) !== JSON.stringify(operation)) {
          throw new Error("ANNOTATION_CLIENT_OP_REUSE");
        }
        return current;
      }
      const localDrafts =
        localDraft === undefined
          ? current.localDrafts
          : [
              ...current.localDrafts.filter((item) => item.draft.strokeId !== localDraft.strokeId),
              {
                clientOpId,
                draft: localDraft,
                status: "PENDING" as const,
                errorCode: null,
              },
            ];
      return this.#write(
        storageKey,
        this.#parseRecord({
          ...current,
          outbox: [
            ...current.outbox,
            {
              clientOpId,
              frameKey,
              baseAnnotationSeq: current.confirmedSnapshot!.annotationSeq,
              operation,
              state: "QUEUED",
              acknowledgement: null,
              errorCode: null,
              enqueuedAtMs: this.#now(),
            },
          ],
          localDrafts,
        }),
      );
    });
  }

  public async applyAcknowledgement(
    pageKeyInput: unknown,
    acknowledgementInput: AnnotationAckV2,
  ): Promise<AnnotationReplicaRecord> {
    const pageKey = AnnotationPageKeySchema.parse(pageKeyInput);
    const acknowledgement = AnnotationAckV2Schema.parse(acknowledgementInput);
    const storageKey = this.#storageKey(acknowledgement.roomId, pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(acknowledgement.roomId, pageKey, storageKey);
      this.#requireMutable(current);
      const outboxIndex = current.outbox.findIndex(
        (item) => item.clientOpId === acknowledgement.clientOpId,
      );
      if (outboxIndex < 0) {
        return current;
      }
      const prior = current.outbox[outboxIndex]!;
      const createStrokeId =
        prior.operation.type === "stroke.create" ? prior.operation.stroke.strokeId : null;
      const errorCode = acknowledgement.accepted ? null : acknowledgement.code;
      const updated = {
        ...prior,
        state: acknowledgement.accepted ? "ACKNOWLEDGED" : "FAILED",
        acknowledgement,
        errorCode,
      } as const;
      const rejectedItemCode =
        acknowledgement.accepted && createStrokeId !== null
          ? (acknowledgement.results.find(
              (result) => result.strokeId === createStrokeId && !result.accepted,
            )?.code ?? null)
          : null;
      let localDrafts = current.localDrafts.map((local) =>
        local.clientOpId === acknowledgement.clientOpId &&
        (!acknowledgement.accepted || rejectedItemCode !== null)
          ? {
              ...local,
              status: "ERROR" as const,
              errorCode: acknowledgement.accepted ? rejectedItemCode : acknowledgement.code,
            }
          : local,
      );
      const acceptedSequenceCovered =
        acknowledgement.accepted &&
        acknowledgement.annotationSeq !== null &&
        current.confirmedSnapshot !== null &&
        current.confirmedSnapshot.annotationSeq >= acknowledgement.annotationSeq;
      if (acceptedSequenceCovered && createStrokeId !== null && rejectedItemCode === null) {
        localDrafts = localDrafts.filter(
          (local) => local.clientOpId !== acknowledgement.clientOpId,
        );
      }
      const terminalMutationFailure =
        !acknowledgement.accepted &&
        acknowledgement.code !== "ANNOTATION_SEQUENCE_CONFLICT" &&
        prior.operation.type !== "stroke.create";
      const outbox =
        acceptedSequenceCovered || terminalMutationFailure
          ? current.outbox.filter((item) => item.clientOpId !== acknowledgement.clientOpId)
          : current.outbox.map((item, index) => (index === outboxIndex ? updated : item));
      return this.#write(
        storageKey,
        this.#parseRecord({
          ...current,
          mode:
            acknowledgement.accepted || acknowledgement.code !== "ANNOTATION_SEQUENCE_CONFLICT"
              ? current.mode
              : "RECOVERING",
          outbox,
          localDrafts,
        }),
      );
    });
  }

  public async applyCommitted(
    committedInput: AnnotationCommittedOperationV2,
  ): Promise<AnnotationApplyResult> {
    const committed = AnnotationCommittedOperationV2Schema.parse(committedInput);
    const storageKey = this.#storageKey(committed.roomId, committed.pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(committed.roomId, committed.pageKey, storageKey);
      this.#requireSynchronized(current);
      const currentSequence = current.confirmedSnapshot!.annotationSeq;
      if (committed.annotationSeq <= currentSequence) {
        const reconciled = this.#reconcileConfirmedOperation(current, committed);
        return {
          kind: "APPLIED",
          record: reconciled === current ? current : await this.#write(storageKey, reconciled),
        };
      }
      if (committed.annotationSeq !== currentSequence + 1) {
        const recovering = await this.#write(
          storageKey,
          this.#parseRecord({
            ...current,
            mode: "RECOVERING",
          }),
        );
        return { kind: "SNAPSHOT_REQUIRED", record: recovering };
      }
      const applied = this.#applyCommittedToRecord(current, committed);
      return {
        kind: "APPLIED",
        record: await this.#write(storageKey, applied),
      };
    });
  }

  public async applyDelta(deltaInput: AnnotationDeltaV2Message): Promise<AnnotationApplyResult> {
    const delta = AnnotationDeltaV2MessageSchema.parse(deltaInput);
    const storageKey = this.#storageKey(delta.roomId, delta.pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(delta.roomId, delta.pageKey, storageKey);
      this.#requireSynchronized(current);
      const currentSequence = current.confirmedSnapshot!.annotationSeq;
      if (delta.toAnnotationSeq <= currentSequence) {
        return { kind: "APPLIED", record: current };
      }
      if (delta.fromAnnotationSeq !== currentSequence) {
        const recovering = await this.#write(
          storageKey,
          this.#parseRecord({
            ...current,
            mode: "RECOVERING",
          }),
        );
        return { kind: "SNAPSHOT_REQUIRED", record: recovering };
      }
      let next = current;
      for (const operation of delta.operations) {
        next = this.#applyCommittedToRecord(next, operation);
      }
      return {
        kind: "APPLIED",
        record: await this.#write(storageKey, next),
      };
    });
  }

  public async getRetryableOperations(
    roomIdInput: unknown,
    pageKeyInput: unknown,
  ): Promise<RetryableAnnotationOperation[]> {
    const record = await this.load(roomIdInput, pageKeyInput);
    this.#requireMutable(record);
    return record.outbox
      .filter((item) => item.state === "QUEUED")
      .map((item) => ({
        clientOpId: item.clientOpId,
        frameKey:
          item.frameKey ??
          (item.operation.type === "stroke.create" ? item.operation.stroke.frameKey : "top"),
        baseAnnotationSeq: item.baseAnnotationSeq,
        operation: structuredClone(item.operation),
      }));
  }

  public async markTransportFailure(
    roomIdInput: unknown,
    pageKeyInput: unknown,
    clientOpIdInput: unknown,
  ): Promise<AnnotationReplicaRecord> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const pageKey = AnnotationPageKeySchema.parse(pageKeyInput);
    const clientOpId = CanonicalUuidSchema.parse(clientOpIdInput);
    const storageKey = this.#storageKey(roomId, pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(roomId, pageKey, storageKey);
      this.#requireMutable(current);
      const localDrafts = current.localDrafts.map((local) =>
        local.clientOpId === clientOpId
          ? {
              ...local,
              status: "ERROR" as const,
              errorCode: "ANNOTATION_OFFLINE" as const,
            }
          : local,
      );
      return this.#write(
        storageKey,
        this.#parseRecord({
          ...current,
          localDrafts,
        }),
      );
    });
  }

  public async rebaseSequenceConflicts(
    roomIdInput: unknown,
    pageKeyInput: unknown,
  ): Promise<AnnotationReplicaRecord> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const pageKey = AnnotationPageKeySchema.parse(pageKeyInput);
    const storageKey = this.#storageKey(roomId, pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(roomId, pageKey, storageKey);
      this.#requireSynchronized(current);
      const baseAnnotationSeq = current.confirmedSnapshot!.annotationSeq;
      const rebasedIds = new Set<string>();
      const outbox = current.outbox.map((item) => {
        if (item.state !== "FAILED" || item.errorCode !== "ANNOTATION_SEQUENCE_CONFLICT") {
          return item;
        }
        rebasedIds.add(item.clientOpId);
        return {
          ...item,
          baseAnnotationSeq,
          state: "QUEUED" as const,
          acknowledgement: null,
          errorCode: null,
        };
      });
      const localDrafts = current.localDrafts.map((local) =>
        rebasedIds.has(local.clientOpId)
          ? {
              ...local,
              status: "PENDING" as const,
              errorCode: null,
            }
          : local,
      );
      return this.#write(
        storageKey,
        this.#parseRecord({
          ...current,
          mode: "SYNCED",
          outbox,
          localDrafts,
        }),
      );
    });
  }

  public async discardLocalDraft(
    roomIdInput: unknown,
    pageKeyInput: unknown,
    strokeIdInput: unknown,
  ): Promise<AnnotationReplicaRecord> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const pageKey = AnnotationPageKeySchema.parse(pageKeyInput);
    const strokeId = CanonicalUuidSchema.parse(strokeIdInput);
    const storageKey = this.#storageKey(roomId, pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(roomId, pageKey, storageKey);
      this.#requireMutable(current);
      const discarded = current.localDrafts.find((local) => local.draft.strokeId === strokeId);
      if (discarded === undefined) {
        return current;
      }
      const associated = current.outbox.find((item) => item.clientOpId === discarded.clientOpId);
      if (associated?.state === "ACKNOWLEDGED") {
        throw new Error("ANNOTATION_DRAFT_AWAITING_CONFIRMATION");
      }
      return this.#write(
        storageKey,
        this.#parseRecord({
          ...current,
          localDrafts: current.localDrafts.filter((local) => local.draft.strokeId !== strokeId),
          outbox: current.outbox.filter((item) => item.clientOpId !== discarded.clientOpId),
        }),
      );
    });
  }

  public async retryLocalDraft(
    roomIdInput: unknown,
    pageKeyInput: unknown,
    strokeIdInput: unknown,
  ): Promise<AnnotationReplicaRecord> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const pageKey = AnnotationPageKeySchema.parse(pageKeyInput);
    const strokeId = CanonicalUuidSchema.parse(strokeIdInput);
    const storageKey = this.#storageKey(roomId, pageKey);
    return this.#serialize(storageKey, async () => {
      const current = await this.#read(roomId, pageKey, storageKey);
      this.#requireMutable(current);
      const draft = current.localDrafts.find((local) => local.draft.strokeId === strokeId);
      if (draft === undefined) {
        throw new Error("ANNOTATION_DRAFT_NOT_FOUND");
      }
      const operation = current.outbox.find((item) => item.clientOpId === draft.clientOpId);
      if (operation === undefined || operation.state === "ACKNOWLEDGED") {
        throw new Error("ANNOTATION_DRAFT_NOT_RETRYABLE");
      }
      if (
        operation.state === "FAILED" &&
        operation.errorCode !== "ANNOTATION_OFFLINE" &&
        operation.errorCode !== "ANNOTATION_SEQUENCE_CONFLICT" &&
        operation.errorCode !== "ANNOTATION_PAGE_CAPACITY_REACHED"
      ) {
        throw new Error("ANNOTATION_DRAFT_NOT_RETRYABLE");
      }
      return this.#write(
        storageKey,
        this.#parseRecord({
          ...current,
          outbox: current.outbox.map((item) =>
            item.clientOpId === draft.clientOpId
              ? {
                  ...item,
                  state: "QUEUED" as const,
                  acknowledgement: null,
                  errorCode: null,
                }
              : item,
          ),
          localDrafts: current.localDrafts.map((local) =>
            local.clientOpId === draft.clientOpId
              ? {
                  ...local,
                  status: "PENDING" as const,
                  errorCode: null,
                }
              : local,
          ),
        }),
      );
    });
  }

  #applyCommittedToRecord(
    record: AnnotationReplicaRecord,
    committed: AnnotationCommittedOperationV2,
  ): AnnotationReplicaRecord {
    const snapshot = record.confirmedSnapshot!;
    const strokes = applyCommittedOperation(snapshot.strokes, committed);
    const reconciled = this.#reconcileConfirmedOperation(
      {
        ...record,
        confirmedSnapshot: {
          annotationSeq: committed.annotationSeq,
          strokes,
        },
        mode: "SYNCED",
      },
      committed,
    );
    return this.#parseRecord(reconciled);
  }

  #reconcileConfirmedOperation(
    record: AnnotationReplicaRecord,
    committed: AnnotationCommittedOperationV2,
  ): AnnotationReplicaRecord {
    const outbox = record.outbox.filter((item) => item.clientOpId !== committed.clientOpId);
    const acceptedStrokeIds = new Set(
      committed.results.filter((result) => result.accepted).map((result) => result.strokeId),
    );
    const localDrafts: AnnotationLocalDraft[] = [];
    for (const local of record.localDrafts) {
      if (local.clientOpId !== committed.clientOpId) {
        localDrafts.push(local);
        continue;
      }
      if (acceptedStrokeIds.has(local.draft.strokeId)) {
        continue;
      }
      const result = committed.results.find(
        (candidate) => candidate.strokeId === local.draft.strokeId,
      );
      const errorCode: AnnotationLocalDraft["errorCode"] =
        result?.accepted === false ? result.code : "ANNOTATION_OPERATION_REJECTED";
      localDrafts.push({
        ...local,
        status: "ERROR",
        errorCode,
      });
    }
    return this.#parseRecord({
      ...record,
      outbox,
      localDrafts,
    });
  }

  #storageKey(roomId: string, pageKey: string): string {
    return annotationReplicaStorageKey(this.#profileId, this.#userId, roomId, pageKey);
  }

  async #read(
    roomId: string,
    pageKey: string,
    storageKey: string,
  ): Promise<AnnotationReplicaRecord> {
    let value: unknown;
    try {
      value = (await this.#area.get(storageKey))[storageKey];
    } catch {
      const quarantined = createAnnotationRecord(
        this.#profileId,
        this.#userId,
        roomId,
        pageKey,
        this.#now(),
        "STORAGE_FAILURE",
      );
      return quarantined;
    }

    if (value === undefined && this.#profileId === DEFAULT_SERVER_PROFILE_ID) {
      const legacyKey = legacyAnnotationReplicaStorageKey(this.#userId, roomId, pageKey);
      try {
        value = (await this.#area.get(legacyKey))[legacyKey];
      } catch {
        return createAnnotationRecord(
          this.#profileId,
          this.#userId,
          roomId,
          pageKey,
          this.#now(),
          "STORAGE_FAILURE",
        );
      }
      if (value !== undefined) {
        const migrated = migrateUnsignedAnnotationRecord(value, {
          profileId: this.#profileId,
          userId: this.#userId,
          roomId,
          pageKey,
          now: this.#now(),
          sourceSchemaVersion: 2,
        });
        if (migrated !== null) {
          try {
            await this.#area.set({ [storageKey]: migrated });
          } catch {
            return createAnnotationRecord(
              this.#profileId,
              this.#userId,
              roomId,
              pageKey,
              this.#now(),
              "STORAGE_FAILURE",
            );
          }
          return migrated;
        }
        return createAnnotationRecord(
          this.#profileId,
          this.#userId,
          roomId,
          pageKey,
          this.#now(),
          "CORRUPT_ANNOTATION_REPLICA",
        );
      }
    }

    if (value === undefined) {
      return createAnnotationRecord(this.#profileId, this.#userId, roomId, pageKey, this.#now());
    }
    const parsed = AnnotationReplicaRecordSchema.safeParse(value);
    if (
      parsed.success &&
      parsed.data.profileId === this.#profileId &&
      parsed.data.userId === this.#userId &&
      parsed.data.roomId === roomId &&
      parsed.data.pageKey === pageKey
    ) {
      return parsed.data;
    }
    const migrated = migrateUnsignedAnnotationRecord(value, {
      profileId: this.#profileId,
      userId: this.#userId,
      roomId,
      pageKey,
      now: this.#now(),
      sourceSchemaVersion: 3,
    });
    if (migrated !== null) {
      try {
        await this.#area.set({ [storageKey]: migrated });
      } catch {
        return createAnnotationRecord(
          this.#profileId,
          this.#userId,
          roomId,
          pageKey,
          this.#now(),
          "STORAGE_FAILURE",
        );
      }
      return migrated;
    }
    const quarantined = createAnnotationRecord(
      this.#profileId,
      this.#userId,
      roomId,
      pageKey,
      this.#now(),
      "CORRUPT_ANNOTATION_REPLICA",
    );
    return quarantined;
  }

  async #write(
    storageKey: string,
    recordInput: AnnotationReplicaRecord,
  ): Promise<AnnotationReplicaRecord> {
    const record = this.#parseRecord(recordInput);
    try {
      await this.#area.set({ [storageKey]: record });
    } catch (cause) {
      throw new Error("ANNOTATION_STORAGE_FAILURE", { cause });
    }
    return record;
  }

  #parseRecord(
    recordInput: Omit<AnnotationReplicaRecord, "updatedAtMs"> & {
      updatedAtMs?: number;
    },
  ): AnnotationReplicaRecord {
    return AnnotationReplicaRecordSchema.parse({
      ...recordInput,
      updatedAtMs: this.#now(),
    });
  }

  #requireMutable(record: AnnotationReplicaRecord): void {
    if (record.mode === "QUARANTINED") {
      throw new Error(record.quarantineReason ?? "CORRUPT_ANNOTATION_REPLICA");
    }
  }

  #requireSynchronized(record: AnnotationReplicaRecord): void {
    this.#requireMutable(record);
    if (record.confirmedSnapshot === null) {
      throw new Error("ANNOTATION_SNAPSHOT_REQUIRED");
    }
  }

  async #serialize<T>(storageKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(storageKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(storageKey, tail);
    await previous;
    try {
      return await work();
    } finally {
      release?.();
      if (this.#tails.get(storageKey) === tail) {
        this.#tails.delete(storageKey);
      }
    }
  }
}

function createAnnotationRecord(
  profileId: string,
  userId: string,
  roomId: string,
  pageKey: string,
  now: number,
  quarantineReason?: "CORRUPT_ANNOTATION_REPLICA" | "STORAGE_FAILURE",
): AnnotationReplicaRecord {
  return AnnotationReplicaRecordSchema.parse({
    schemaVersion: 3,
    profileId,
    userId,
    roomId,
    pageKey,
    mode: quarantineReason === undefined ? "UNINITIALIZED" : "QUARANTINED",
    confirmedSnapshot: null,
    outbox: [],
    localDrafts: [],
    quarantineReason: quarantineReason ?? null,
    updatedAtMs: now,
  });
}

function migrateUnsignedAnnotationRecord(
  value: unknown,
  expected: {
    profileId: string;
    userId: string;
    roomId: string;
    pageKey: string;
    now: number;
    sourceSchemaVersion: 2 | 3;
  },
): AnnotationReplicaRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const legacy = value as Record<string, unknown>;
  if (
    legacy.schemaVersion !== expected.sourceSchemaVersion ||
    (expected.sourceSchemaVersion === 2 && "profileId" in legacy) ||
    (expected.sourceSchemaVersion === 3 && legacy.profileId !== expected.profileId) ||
    !Array.isArray(legacy.outbox) ||
    legacy.outbox.length > 0 ||
    !Array.isArray(legacy.localDrafts) ||
    legacy.localDrafts.length > 0
  ) {
    return null;
  }
  let confirmedSnapshot: AnnotationReplicaRecord["confirmedSnapshot"] = null;
  if (legacy.confirmedSnapshot !== null) {
    const parsedSnapshot = LegacyAnnotationConfirmedSnapshotSchema.safeParse(
      legacy.confirmedSnapshot,
    );
    if (!parsedSnapshot.success) {
      return null;
    }
    confirmedSnapshot = {
      annotationSeq: parsedSnapshot.data.annotationSeq,
      strokes: parsedSnapshot.data.strokes.map((stroke) =>
        AnnotationStrokeV2Schema.parse({
          ...stroke,
          contentSignature: null,
        }),
      ),
    };
  }
  const migrated = AnnotationReplicaRecordSchema.safeParse({
    ...legacy,
    schemaVersion: 3,
    profileId: expected.profileId,
    confirmedSnapshot,
    updatedAtMs: expected.now,
  });
  return migrated.success &&
    migrated.data.userId === expected.userId &&
    migrated.data.roomId === expected.roomId &&
    migrated.data.pageKey === expected.pageKey
    ? migrated.data
    : null;
}

function sameAuthoritativeStrokes(
  leftInput: readonly AnnotationStrokeV2[],
  rightInput: readonly AnnotationStrokeV2[],
): boolean {
  if (leftInput.length !== rightInput.length) {
    return false;
  }
  const byStrokeId = (left: AnnotationStrokeV2, right: AnnotationStrokeV2): number =>
    left.strokeId.localeCompare(right.strokeId);
  const left = [...leftInput].sort(byStrokeId);
  const right = [...rightInput].sort(byStrokeId);
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyCommittedOperation(
  strokesInput: readonly AnnotationStrokeV2[],
  committed: AnnotationCommittedOperationV2,
): AnnotationStrokeV2[] {
  const strokes = new Map(strokesInput.map((stroke) => [stroke.strokeId, structuredClone(stroke)]));
  const acceptedVersions = new Map(
    committed.results
      .filter((result) => result.accepted)
      .map((result) => [result.strokeId, result.version] as const),
  );
  if (committed.operation.type === "stroke.create") {
    const draft = committed.operation.stroke;
    const version = acceptedVersions.get(draft.strokeId);
    if (version !== undefined) {
      const stroke = AnnotationStrokeV2Schema.parse({
        ...draft,
        authorUserId: committed.actorUserId,
        lockedAtServerMs: null,
        version,
        createdAtServerMs: committed.createdAtServerMs,
        deletedAtServerMs: null,
      });
      strokes.set(stroke.strokeId, stroke);
    }
    return [...strokes.values()];
  }
  for (const target of committed.operation.items) {
    const version = acceptedVersions.get(target.strokeId);
    if (version === undefined) {
      continue;
    }
    const stroke = strokes.get(target.strokeId);
    if (committed.operation.type === "stroke.delete") {
      strokes.delete(target.strokeId);
      continue;
    }
    if (stroke === undefined) {
      continue;
    }
    strokes.set(
      target.strokeId,
      AnnotationStrokeV2Schema.parse({
        ...stroke,
        version,
        lockedAtServerMs:
          committed.operation.type === "stroke.lock" ? committed.createdAtServerMs : null,
      }),
    );
  }
  return [...strokes.values()];
}
