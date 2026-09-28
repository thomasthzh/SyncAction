import {
  ClientOperationEnvelopeSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  RoomSnapshotStateSchema,
} from "@syncaction/protocol";
import { z } from "zod";

const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const SafePositiveIntegerSchema = z.number().int().positive().safe();
const LocalBrowserIdSchema = z.number().int().nonnegative().safe();

export const ReplicaModeSchema = z.enum([
  "UNINITIALIZED",
  "WAITING_SNAPSHOT",
  "SYNCED",
  "RECOVERING",
  "QUARANTINED",
]);

export const QuarantineReasonSchema = z.enum([
  "CORRUPT_REPLICA",
  "ROOM_EPOCH_CHANGED",
  "OPTIMISTIC_CONFLICT",
  "INVALID_REMOTE_STATE",
  "STORAGE_FAILURE",
  "AMBIGUOUS_BINDING",
  "PERMANENT_OPERATION_REJECTED",
]);

export const PersistentOutboxItemSchema = z
  .object({
    outboxSeq: SafePositiveIntegerSchema,
    envelope: ClientOperationEnvelopeSchema,
    enqueuedAtMs: SafeNonnegativeIntegerSchema,
  })
  .strict();

export const PendingConfirmationItemSchema = PersistentOutboxItemSchema.extend({
  acknowledgedServerSeq: SafePositiveIntegerSchema,
  acknowledgedAtMs: SafeNonnegativeIntegerSchema,
}).strict();

export const OrphanedOutboxItemSchema = PersistentOutboxItemSchema.extend({
  orphanedReason: z.enum(["ROOM_EPOCH_CHANGED", "PERMANENT_OPERATION_REJECTED"]),
  orphanedAtMs: SafeNonnegativeIntegerSchema,
}).strict();

export const LocalTabBindingSchema = z
  .object({
    logicalTabId: LogicalTabIdSchema,
    tabId: LocalBrowserIdSchema,
    windowId: LocalBrowserIdSchema,
    groupId: LocalBrowserIdSchema.nullable(),
    browserSessionId: z.string().uuid(),
    validatedAtServerSeq: SafeNonnegativeIntegerSchema,
  })
  .strict();

export const ReplicaRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    roomId: RoomIdSchema,
    mode: ReplicaModeSchema,
    confirmedSnapshot: RoomSnapshotStateSchema.nullable(),
    nextOutboxSeq: SafePositiveIntegerSchema,
    outbox: z.array(PersistentOutboxItemSchema).max(2_000),
    pendingConfirmations: z.array(PendingConfirmationItemSchema).max(2_000),
    orphanedOutbox: z.array(OrphanedOutboxItemSchema).max(2_000),
    bindings: z.array(LocalTabBindingSchema).max(2_000),
    quarantineReason: QuarantineReasonSchema.nullable(),
    updatedAtMs: SafeNonnegativeIntegerSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const snapshot = record.confirmedSnapshot;
    if (record.mode === "UNINITIALIZED" && snapshot !== null) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSnapshot"],
        message: "uninitialized replica cannot contain confirmed state",
      });
    }
    if ((record.mode === "SYNCED" || record.mode === "RECOVERING") && snapshot === null) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSnapshot"],
        message: `${record.mode} replica requires confirmed state`,
      });
    }
    if (record.mode === "QUARANTINED" && record.quarantineReason === null) {
      context.addIssue({
        code: "custom",
        path: ["quarantineReason"],
        message: "quarantined replica requires a reason",
      });
    }
    if (record.mode !== "QUARANTINED" && record.quarantineReason !== null) {
      context.addIssue({
        code: "custom",
        path: ["quarantineReason"],
        message: "only quarantined replicas may carry a quarantine reason",
      });
    }
    if (
      snapshot === null &&
      (record.outbox.length !== 0 ||
        record.pendingConfirmations.length !== 0 ||
        record.bindings.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSnapshot"],
        message: "unknown room state cannot carry live operations or bindings",
      });
    }
    if (snapshot !== null && snapshot.roomId !== record.roomId) {
      context.addIssue({
        code: "custom",
        path: ["confirmedSnapshot", "roomId"],
        message: "confirmed snapshot belongs to another room",
      });
    }

    const operationIdentities = new Set<string>();
    const operationSequences = new Set<number>();
    const acknowledgedServerSequences = new Set<number>();
    let previousOutboxSeq = 0;
    let maximumOutboxSeq = 0;
    for (const [index, item] of record.outbox.entries()) {
      if (item.outboxSeq <= previousOutboxSeq) {
        context.addIssue({
          code: "custom",
          path: ["outbox", index, "outboxSeq"],
          message: "outbox sequence must be strictly increasing",
        });
      }
      previousOutboxSeq = item.outboxSeq;
      maximumOutboxSeq = Math.max(maximumOutboxSeq, item.outboxSeq);
      operationSequences.add(item.outboxSeq);
      if (item.envelope.roomId !== record.roomId) {
        context.addIssue({
          code: "custom",
          path: ["outbox", index, "envelope", "roomId"],
          message: "outbox operation belongs to another room",
        });
      }
      if (
        snapshot !== null &&
        (item.envelope.roomEpoch !== snapshot.roomEpoch ||
          item.envelope.baseServerSeq > snapshot.serverSeq)
      ) {
        context.addIssue({
          code: "custom",
          path: ["outbox", index, "envelope"],
          message: "outbox operation is incompatible with confirmed state",
        });
      }
      const identity = `${item.envelope.deviceId}:${item.envelope.clientOpId}`;
      if (operationIdentities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["outbox", index, "envelope", "clientOpId"],
          message: "outbox operation identity must be unique",
        });
      }
      operationIdentities.add(identity);
    }

    let previousPendingSeq = 0;
    for (const [index, item] of record.pendingConfirmations.entries()) {
      if (item.outboxSeq <= previousPendingSeq) {
        context.addIssue({
          code: "custom",
          path: ["pendingConfirmations", index, "outboxSeq"],
          message: "pending confirmation sequence must be strictly increasing",
        });
      }
      previousPendingSeq = item.outboxSeq;
      maximumOutboxSeq = Math.max(maximumOutboxSeq, item.outboxSeq);
      if (operationSequences.has(item.outboxSeq)) {
        context.addIssue({
          code: "custom",
          path: ["pendingConfirmations", index, "outboxSeq"],
          message: "persisted operation sequence must be unique",
        });
      }
      operationSequences.add(item.outboxSeq);
      if (
        item.envelope.roomId !== record.roomId ||
        (snapshot !== null &&
          (item.envelope.roomEpoch !== snapshot.roomEpoch ||
            item.envelope.baseServerSeq > snapshot.serverSeq ||
            item.acknowledgedServerSeq <= item.envelope.baseServerSeq ||
            item.acknowledgedServerSeq <= snapshot.serverSeq))
      ) {
        context.addIssue({
          code: "custom",
          path: ["pendingConfirmations", index, "envelope"],
          message: "pending confirmation is incompatible with confirmed state",
        });
      }
      const identity = `${item.envelope.deviceId}:${item.envelope.clientOpId}`;
      if (operationIdentities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["pendingConfirmations", index, "envelope", "clientOpId"],
          message: "operation identity cannot be retrying and awaiting confirmation",
        });
      }
      operationIdentities.add(identity);
      if (acknowledgedServerSequences.has(item.acknowledgedServerSeq)) {
        context.addIssue({
          code: "custom",
          path: ["pendingConfirmations", index, "acknowledgedServerSeq"],
          message: "acknowledged server sequence must be unique",
        });
      }
      acknowledgedServerSequences.add(item.acknowledgedServerSeq);
    }

    let previousOrphanSeq = 0;
    for (const [index, item] of record.orphanedOutbox.entries()) {
      if (item.outboxSeq <= previousOrphanSeq) {
        context.addIssue({
          code: "custom",
          path: ["orphanedOutbox", index, "outboxSeq"],
          message: "orphan sequence must be strictly increasing",
        });
      }
      previousOrphanSeq = item.outboxSeq;
      maximumOutboxSeq = Math.max(maximumOutboxSeq, item.outboxSeq);
      if (operationSequences.has(item.outboxSeq)) {
        context.addIssue({
          code: "custom",
          path: ["orphanedOutbox", index, "outboxSeq"],
          message: "persisted operation sequence must be unique",
        });
      }
      operationSequences.add(item.outboxSeq);
      if (item.envelope.roomId !== record.roomId) {
        context.addIssue({
          code: "custom",
          path: ["orphanedOutbox", index, "envelope", "roomId"],
          message: "orphaned operation belongs to another room",
        });
      }
      const identity = `${item.envelope.deviceId}:${item.envelope.clientOpId}`;
      if (operationIdentities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["orphanedOutbox", index, "envelope", "clientOpId"],
          message: "operation identity cannot be live and orphaned",
        });
      }
      operationIdentities.add(identity);
    }
    if (record.nextOutboxSeq <= maximumOutboxSeq) {
      context.addIssue({
        code: "custom",
        path: ["nextOutboxSeq"],
        message: "nextOutboxSeq must exceed every persisted operation",
      });
    }

    const logicalBindings = new Set<string>();
    const localTabs = new Set<number>();
    const browserSessions = new Set<string>();
    const knownLogicalTabs = new Set([
      ...(snapshot?.tabs.map((tab) => tab.id) ?? []),
      ...record.outbox.flatMap((item) =>
        item.envelope.operation.type === "tab.create" ? [item.envelope.operation.logicalTabId] : [],
      ),
      ...record.pendingConfirmations.flatMap((item) =>
        item.envelope.operation.type === "tab.create" ? [item.envelope.operation.logicalTabId] : [],
      ),
    ]);
    for (const [index, binding] of record.bindings.entries()) {
      if (logicalBindings.has(binding.logicalTabId)) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "logicalTabId"],
          message: "logical tab cannot have multiple local bindings",
        });
      }
      if (localTabs.has(binding.tabId)) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "tabId"],
          message: "local tab cannot represent multiple logical tabs",
        });
      }
      logicalBindings.add(binding.logicalTabId);
      localTabs.add(binding.tabId);
      browserSessions.add(binding.browserSessionId);
      if (!knownLogicalTabs.has(binding.logicalTabId)) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "logicalTabId"],
          message: "binding must reference a known logical tab",
        });
      }
      if (snapshot !== null && binding.validatedAtServerSeq > snapshot.serverSeq) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "validatedAtServerSeq"],
          message: "binding validation cannot be ahead of confirmed state",
        });
      }
    }
    if (browserSessions.size > 1) {
      context.addIssue({
        code: "custom",
        path: ["bindings"],
        message: "live bindings must belong to one browser session",
      });
    }
  });

export type ReplicaMode = z.infer<typeof ReplicaModeSchema>;
export type QuarantineReason = z.infer<typeof QuarantineReasonSchema>;
export type PersistentOutboxItem = z.infer<typeof PersistentOutboxItemSchema>;
export type PendingConfirmationItem = z.infer<typeof PendingConfirmationItemSchema>;
export type OrphanedOutboxItem = z.infer<typeof OrphanedOutboxItemSchema>;
export type LocalTabBinding = z.infer<typeof LocalTabBindingSchema>;
export type ReplicaRecord = z.infer<typeof ReplicaRecordSchema>;

export function createReplicaRecord(roomIdInput: unknown, nowMsInput: unknown): ReplicaRecord {
  const roomId = RoomIdSchema.parse(roomIdInput);
  const updatedAtMs = SafeNonnegativeIntegerSchema.parse(nowMsInput);
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId,
    mode: "UNINITIALIZED",
    confirmedSnapshot: null,
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: [],
    quarantineReason: null,
    updatedAtMs,
  });
}
