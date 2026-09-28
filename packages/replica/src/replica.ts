import { applyCommittedOperation, type RoomState } from "@syncaction/domain";
import {
  ClientOperationEnvelopeSchema,
  ClientOpIdSchema,
  CommittedOperationSchema,
  DeviceIdSchema,
  DurableOperationSchema,
  LogicalTabIdSchema,
  OperationAckSchema,
  RoomIdSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  type CommittedOperation,
  type DurableOperation,
} from "@syncaction/protocol";
import { ReplicaError } from "./errors.js";
import type { ReplicaRepository } from "./repository.js";
import { decodeSnapshot, encodeRoomState } from "./room-codec.js";
import {
  LocalTabBindingSchema,
  type LocalTabBinding,
  type PendingConfirmationItem,
  type PersistentOutboxItem,
  type ReplicaRecord,
} from "./schema.js";

export interface DurableReplicaOptions {
  repository: ReplicaRepository;
  roomId: unknown;
  deviceId: unknown;
  now?: () => number;
  createClientOpId?: () => string;
}

export interface ReplicaTransition {
  kind: "SNAPSHOT" | "DELTA" | "COMMITTED" | "DUPLICATE" | "EPOCH_CHANGED" | "QUARANTINED";
  record: ReplicaRecord;
  confirmedOperations: readonly CommittedOperation[];
}

export class DurableReplica {
  readonly #repository: ReplicaRepository;
  readonly #roomId: ReturnType<typeof RoomIdSchema.parse>;
  readonly #deviceId: ReturnType<typeof DeviceIdSchema.parse>;
  readonly #now: () => number;
  readonly #createClientOpId: () => string;

  public constructor(options: DurableReplicaOptions) {
    this.#repository = options.repository;
    this.#roomId = RoomIdSchema.parse(options.roomId);
    this.#deviceId = DeviceIdSchema.parse(options.deviceId);
    this.#now = options.now ?? Date.now;
    this.#createClientOpId = options.createClientOpId ?? (() => crypto.randomUUID());
  }

  public async getRecord(): Promise<ReplicaRecord> {
    return this.#repository.load(this.#roomId);
  }

  public async bindTab(bindingInput: unknown): Promise<ReplicaRecord> {
    const parsed = LocalTabBindingSchema.safeParse(bindingInput);
    if (!parsed.success) {
      throw new ReplicaError("INVALID_REPLICA_TRANSITION", {
        cause: parsed.error,
      });
    }
    const binding = parsed.data;
    return this.#repository.update(this.#roomId, (record) => {
      const snapshot = record.confirmedSnapshot;
      const optimistic = snapshot === null ? null : projectOptimisticState(record);
      if (
        record.mode !== "SYNCED" ||
        snapshot === null ||
        optimistic === null ||
        !optimistic.order.includes(binding.logicalTabId) ||
        binding.validatedAtServerSeq !== snapshot.serverSeq
      ) {
        throw new ReplicaError("INVALID_REPLICA_TRANSITION");
      }
      const otherBindings = record.bindings.filter(
        (candidate) => candidate.logicalTabId !== binding.logicalTabId,
      );
      if (
        otherBindings.some(
          (candidate) =>
            candidate.tabId === binding.tabId ||
            candidate.browserSessionId !== binding.browserSessionId,
        )
      ) {
        throw new ReplicaError("INVALID_REPLICA_TRANSITION");
      }
      return {
        ...record,
        bindings: sortBindings([...otherBindings, binding], optimistic.order),
      };
    });
  }

  public async replaceBindings(bindingsInput: unknown): Promise<ReplicaRecord> {
    const parsed = LocalTabBindingSchema.array().max(2_000).safeParse(bindingsInput);
    if (!parsed.success) {
      throw new ReplicaError("INVALID_REPLICA_TRANSITION", {
        cause: parsed.error,
      });
    }
    const bindings = parsed.data;
    return this.#repository.update(this.#roomId, (record) => {
      const snapshot = record.confirmedSnapshot;
      if (record.mode !== "SYNCED" || snapshot === null) {
        throw new ReplicaError("INVALID_REPLICA_TRANSITION");
      }
      const optimistic = projectOptimisticState(record);
      const logicalIds = new Set(bindings.map((binding) => binding.logicalTabId));
      const localTabIds = new Set(bindings.map((binding) => binding.tabId));
      const browserSessions = new Set(bindings.map((binding) => binding.browserSessionId));
      if (
        logicalIds.size !== bindings.length ||
        localTabIds.size !== bindings.length ||
        logicalIds.size !== optimistic.order.length ||
        optimistic.order.some((logicalTabId) => !logicalIds.has(logicalTabId)) ||
        bindings.some((binding) => binding.validatedAtServerSeq !== snapshot.serverSeq) ||
        (bindings.length > 0 && browserSessions.size !== 1)
      ) {
        throw new ReplicaError("INVALID_REPLICA_TRANSITION");
      }
      return {
        ...record,
        bindings: sortBindings(bindings, optimistic.order),
      };
    });
  }

  public async removeBinding(logicalTabIdInput: unknown): Promise<ReplicaRecord> {
    const logicalTabId = LogicalTabIdSchema.safeParse(logicalTabIdInput);
    if (!logicalTabId.success) {
      throw new ReplicaError("INVALID_REPLICA_TRANSITION", {
        cause: logicalTabId.error,
      });
    }
    return this.#repository.update(this.#roomId, (record) => ({
      ...record,
      bindings: record.bindings.filter((binding) => binding.logicalTabId !== logicalTabId.data),
    }));
  }

  public async quarantineBrowserAmbiguity(): Promise<ReplicaRecord> {
    return this.#repository.update(this.#roomId, (record) => ({
      ...record,
      mode: "QUARANTINED",
      quarantineReason: "AMBIGUOUS_BINDING",
    }));
  }

  public async beginSynchronization(): Promise<ReplicaRecord> {
    return this.#repository.update(this.#roomId, (record) => {
      if (record.mode === "QUARANTINED") {
        return record;
      }
      return {
        ...record,
        mode: "WAITING_SNAPSHOT",
        quarantineReason: null,
      };
    });
  }

  public async enqueueLocalOperation(operationInput: unknown): Promise<PersistentOutboxItem> {
    const parsedOperation = DurableOperationSchema.safeParse(operationInput);
    if (!parsedOperation.success) {
      throw new ReplicaError("INVALID_REPLICA_TRANSITION", {
        cause: parsedOperation.error,
      });
    }
    let conflict = false;
    const result = await this.#repository.update(this.#roomId, (record) => {
      if (record.mode !== "SYNCED" || record.confirmedSnapshot === null) {
        throw new ReplicaError("LOCAL_INTENT_NOT_ALLOWED");
      }
      const envelope = ClientOperationEnvelopeSchema.parse({
        protocolVersion: 1,
        clientOpId: this.#createClientOpId(),
        roomId: this.#roomId,
        roomEpoch: record.confirmedSnapshot.roomEpoch,
        deviceId: this.#deviceId,
        baseServerSeq: record.confirmedSnapshot.serverSeq,
        operation: parsedOperation.data,
      });
      const item: PersistentOutboxItem = {
        outboxSeq: record.nextOutboxSeq,
        envelope,
        enqueuedAtMs: this.#now(),
      };
      const next: ReplicaRecord = {
        ...record,
        nextOutboxSeq: record.nextOutboxSeq + 1,
        outbox: [...record.outbox, item],
      };
      try {
        projectOptimisticState(next);
        return next;
      } catch (cause) {
        if (cause instanceof ReplicaError && cause.code === "OPTIMISTIC_CONFLICT") {
          conflict = true;
          return {
            ...next,
            mode: "QUARANTINED",
            quarantineReason: "OPTIMISTIC_CONFLICT",
          };
        }
        throw cause;
      }
    });
    const item = result.outbox.at(-1);
    if (item === undefined) {
      throw new ReplicaError("INVALID_REPLICA_TRANSITION");
    }
    if (conflict) {
      throw new ReplicaError("OPTIMISTIC_CONFLICT");
    }
    return item;
  }

  public async getOptimisticState(): Promise<RoomState> {
    return projectOptimisticState(await this.#repository.load(this.#roomId));
  }

  public async reject(clientOpIdInput: unknown): Promise<ReplicaRecord> {
    const parsedClientOpId = ClientOpIdSchema.safeParse(clientOpIdInput);
    if (!parsedClientOpId.success) {
      throw new ReplicaError("INVALID_REPLICA_TRANSITION", {
        cause: parsedClientOpId.error,
      });
    }
    return this.#repository.update(this.#roomId, (record) => {
      const matches = record.outbox.filter(
        (item) => item.envelope.clientOpId === parsedClientOpId.data,
      );
      if (matches.length !== 1) {
        throw new ReplicaError("OUTBOX_OPERATION_NOT_FOUND");
      }
      const rejected = matches[0]!;
      if (rejected.envelope.operation.type !== "tab.create") {
        throw new ReplicaError("INVALID_REPLICA_TRANSITION");
      }
      const logicalTabId = rejected.envelope.operation.logicalTabId;
      const candidate = {
        ...record,
        outbox: record.outbox.filter((item) => item.envelope.clientOpId !== parsedClientOpId.data),
        bindings: record.bindings.filter((binding) => binding.logicalTabId !== logicalTabId),
      };
      try {
        projectOptimisticState(candidate);
        return candidate;
      } catch (cause) {
        if (!(cause instanceof ReplicaError) || cause.code !== "OPTIMISTIC_CONFLICT") {
          throw cause;
        }
        const orphanedAtMs = this.#now();
        return {
          ...record,
          mode: "QUARANTINED",
          outbox: [],
          orphanedOutbox: [
            ...record.orphanedOutbox,
            ...candidate.outbox.map((item) => ({
              ...item,
              orphanedReason: "PERMANENT_OPERATION_REJECTED" as const,
              orphanedAtMs,
            })),
          ].toSorted((left, right) => left.outboxSeq - right.outboxSeq),
          bindings: [],
          quarantineReason: "PERMANENT_OPERATION_REJECTED",
        };
      }
    });
  }

  public async acknowledge(ackInput: unknown): Promise<ReplicaRecord> {
    const parsedAck = OperationAckSchema.safeParse(ackInput);
    if (!parsedAck.success || parsedAck.data.roomId !== this.#roomId) {
      throw new ReplicaError("ACK_MISMATCH", {
        ...(parsedAck.success ? {} : { cause: parsedAck.error }),
      });
    }
    const ack = parsedAck.data;
    return this.#repository.update(this.#roomId, (record) => {
      const index = record.outbox.findIndex((item) => item.envelope.clientOpId === ack.clientOpId);
      if (index === -1) {
        const pending = record.pendingConfirmations.find(
          (item) => item.envelope.clientOpId === ack.clientOpId,
        );
        if (pending === undefined) {
          return record;
        }
        if (
          record.confirmedSnapshot === null ||
          ack.roomEpoch !== record.confirmedSnapshot.roomEpoch ||
          ack.roomEpoch !== pending.envelope.roomEpoch ||
          ack.serverSeq !== pending.acknowledgedServerSeq
        ) {
          throw new ReplicaError("ACK_MISMATCH");
        }
        return record;
      }
      const item = record.outbox[index];
      if (
        item === undefined ||
        record.confirmedSnapshot === null ||
        ack.roomEpoch !== record.confirmedSnapshot.roomEpoch ||
        ack.roomEpoch !== item.envelope.roomEpoch ||
        ack.serverSeq <= item.envelope.baseServerSeq ||
        ack.serverSeq <= record.confirmedSnapshot.serverSeq ||
        record.pendingConfirmations.some(
          (pending) => pending.acknowledgedServerSeq === ack.serverSeq,
        )
      ) {
        throw new ReplicaError("ACK_MISMATCH");
      }
      const pending: PendingConfirmationItem = {
        ...item,
        acknowledgedServerSeq: ack.serverSeq,
        acknowledgedAtMs: this.#now(),
      };
      return {
        ...record,
        outbox: record.outbox.filter((_, itemIndex) => itemIndex !== index),
        pendingConfirmations: [...record.pendingConfirmations, pending].toSorted(
          (left, right) => left.outboxSeq - right.outboxSeq,
        ),
      };
    });
  }

  public async applySnapshot(snapshotMessageInput: unknown): Promise<ReplicaTransition> {
    const parsed = RoomSnapshotMessageSchema.safeParse(snapshotMessageInput);
    if (!parsed.success || parsed.data.state.roomId !== this.#roomId) {
      await this.#quarantine("INVALID_REMOTE_STATE");
      throw new ReplicaError("INVALID_REMOTE_STATE", {
        ...(parsed.success ? {} : { cause: parsed.error }),
      });
    }
    const incoming = parsed.data.state;
    let failure: "SEQUENCE_GAP" | "INVALID_REMOTE_STATE" | undefined;
    let epochChanged = false;
    const record = await this.#repository.update(this.#roomId, (current) => {
      const confirmed = current.confirmedSnapshot;
      if (confirmed !== null && confirmed.roomEpoch === incoming.roomEpoch) {
        if (incoming.serverSeq < confirmed.serverSeq) {
          failure = "SEQUENCE_GAP";
          return recoveringRecord(current);
        }
        if (
          incoming.serverSeq === confirmed.serverSeq &&
          JSON.stringify(incoming) !== JSON.stringify(confirmed)
        ) {
          failure = "INVALID_REMOTE_STATE";
          return quarantinedRecord(current, "INVALID_REMOTE_STATE");
        }
      }
      if (confirmed !== null && confirmed.roomEpoch !== incoming.roomEpoch) {
        epochChanged = true;
        return {
          ...current,
          mode: "QUARANTINED",
          confirmedSnapshot: incoming,
          outbox: [],
          pendingConfirmations: [],
          orphanedOutbox: [
            ...current.orphanedOutbox,
            ...[...current.pendingConfirmations, ...current.outbox]
              .toSorted((left, right) => left.outboxSeq - right.outboxSeq)
              .map((item) => ({
                outboxSeq: item.outboxSeq,
                envelope: item.envelope,
                enqueuedAtMs: item.enqueuedAtMs,
                orphanedReason: "ROOM_EPOCH_CHANGED" as const,
                orphanedAtMs: this.#now(),
              })),
          ],
          bindings: [],
          quarantineReason: "ROOM_EPOCH_CHANGED",
        };
      }
      return validateOptimisticCandidate({
        ...current,
        mode: current.mode === "QUARANTINED" ? current.mode : "SYNCED",
        confirmedSnapshot: incoming,
        quarantineReason: current.mode === "QUARANTINED" ? current.quarantineReason : null,
      });
    });
    if (failure !== undefined) {
      throw new ReplicaError(failure);
    }
    return {
      kind: epochChanged
        ? "EPOCH_CHANGED"
        : record.mode === "QUARANTINED"
          ? "QUARANTINED"
          : "SNAPSHOT",
      record,
      confirmedOperations: [],
    };
  }

  public async applyDelta(deltaMessageInput: unknown): Promise<ReplicaTransition> {
    const parsed = RoomDeltaMessageSchema.safeParse(deltaMessageInput);
    if (!parsed.success || parsed.data.roomId !== this.#roomId) {
      await this.#quarantine("INVALID_REMOTE_STATE");
      throw new ReplicaError("INVALID_REMOTE_STATE", {
        ...(parsed.success ? {} : { cause: parsed.error }),
      });
    }
    const delta = parsed.data;
    let failure: "SEQUENCE_GAP" | "INVALID_REMOTE_STATE" | undefined;
    const record = await this.#repository.update(this.#roomId, (current) => {
      const confirmed = current.confirmedSnapshot;
      if (current.mode === "QUARANTINED") {
        failure = "INVALID_REMOTE_STATE";
        return current;
      }
      if (
        confirmed === null ||
        delta.roomEpoch !== confirmed.roomEpoch ||
        delta.fromServerSeq !== confirmed.serverSeq
      ) {
        failure = "SEQUENCE_GAP";
        return recoveringRecord(current);
      }
      if (!confirmedIntentsMatch(current.outbox, current.pendingConfirmations, delta.operations)) {
        failure = "INVALID_REMOTE_STATE";
        return recoveringRecord(current);
      }
      try {
        let nextState = decodeSnapshot(confirmed);
        for (const operation of delta.operations) {
          nextState = applyCommittedOperation(nextState, operation);
        }
        const candidate = {
          ...current,
          mode: "SYNCED" as const,
          confirmedSnapshot: encodeRoomState(nextState),
          outbox: removeConfirmedOutbox(current.outbox, delta.operations),
          pendingConfirmations: removeConfirmedPending(
            current.pendingConfirmations,
            delta.operations,
          ),
          quarantineReason: null,
        };
        return validateOptimisticCandidate(candidate);
      } catch {
        failure = "INVALID_REMOTE_STATE";
        return recoveringRecord(current);
      }
    });
    if (failure !== undefined) {
      throw new ReplicaError(failure);
    }
    return {
      kind: record.mode === "QUARANTINED" ? "QUARANTINED" : "DELTA",
      record,
      confirmedOperations: record.mode === "QUARANTINED" ? [] : delta.operations,
    };
  }

  public async applyCommitted(committedInput: unknown): Promise<ReplicaTransition> {
    const parsed = CommittedOperationSchema.safeParse(committedInput);
    if (!parsed.success || parsed.data.roomId !== this.#roomId) {
      await this.#quarantine("INVALID_REMOTE_STATE");
      throw new ReplicaError("INVALID_REMOTE_STATE", {
        ...(parsed.success ? {} : { cause: parsed.error }),
      });
    }
    const committed = parsed.data;
    let failure: "SEQUENCE_GAP" | "INVALID_REMOTE_STATE" | undefined;
    let duplicate = false;
    const record = await this.#repository.update(this.#roomId, (current) => {
      const confirmed = current.confirmedSnapshot;
      if (current.mode === "QUARANTINED") {
        failure = "INVALID_REMOTE_STATE";
        return current;
      }
      if (
        confirmed === null ||
        current.mode !== "SYNCED" ||
        committed.roomEpoch !== confirmed.roomEpoch
      ) {
        failure = "SEQUENCE_GAP";
        return recoveringRecord(current);
      }
      if (!confirmedIntentsMatch(current.outbox, current.pendingConfirmations, [committed])) {
        failure = "INVALID_REMOTE_STATE";
        return recoveringRecord(current);
      }
      if (committed.serverSeq <= confirmed.serverSeq) {
        duplicate = true;
        return {
          ...current,
          outbox: removeConfirmedOutbox(current.outbox, [committed]),
          pendingConfirmations: removeConfirmedPending(current.pendingConfirmations, [committed]),
        };
      }
      if (committed.serverSeq !== confirmed.serverSeq + 1) {
        failure = "SEQUENCE_GAP";
        return recoveringRecord(current);
      }
      try {
        const nextState = applyCommittedOperation(decodeSnapshot(confirmed), committed);
        return validateOptimisticCandidate({
          ...current,
          confirmedSnapshot: encodeRoomState(nextState),
          outbox: removeConfirmedOutbox(current.outbox, [committed]),
          pendingConfirmations: removeConfirmedPending(current.pendingConfirmations, [committed]),
        });
      } catch {
        failure = "INVALID_REMOTE_STATE";
        return recoveringRecord(current);
      }
    });
    if (failure !== undefined) {
      throw new ReplicaError(failure);
    }
    return {
      kind: duplicate ? "DUPLICATE" : record.mode === "QUARANTINED" ? "QUARANTINED" : "COMMITTED",
      record,
      confirmedOperations: duplicate || record.mode === "QUARANTINED" ? [] : [committed],
    };
  }

  async #quarantine(reason: "INVALID_REMOTE_STATE"): Promise<void> {
    await this.#repository.update(this.#roomId, (record) => quarantinedRecord(record, reason));
  }
}

export function projectOptimisticState(record: ReplicaRecord): RoomState {
  if (record.confirmedSnapshot === null) {
    throw new ReplicaError("LOCAL_INTENT_NOT_ALLOWED");
  }
  try {
    let state = decodeSnapshot(record.confirmedSnapshot);
    const liveOperations = [...record.pendingConfirmations, ...record.outbox].toSorted(
      (left, right) => left.outboxSeq - right.outboxSeq,
    );
    for (const [index, item] of liveOperations.entries()) {
      state = applyCommittedOperation(
        state,
        CommittedOperationSchema.parse({
          type: "op.committed",
          protocolVersion: 1,
          clientOpId: item.envelope.clientOpId,
          roomId: item.envelope.roomId,
          roomEpoch: item.envelope.roomEpoch,
          deviceId: item.envelope.deviceId,
          serverSeq: record.confirmedSnapshot.serverSeq + index + 1,
          operation: item.envelope.operation as DurableOperation,
        }),
      );
    }
    return state;
  } catch (cause) {
    if (cause instanceof ReplicaError && cause.code === "LOCAL_INTENT_NOT_ALLOWED") {
      throw cause;
    }
    throw new ReplicaError("OPTIMISTIC_CONFLICT", { cause });
  }
}

function removeConfirmedOutbox(
  outbox: readonly PersistentOutboxItem[],
  operations: readonly CommittedOperation[],
): PersistentOutboxItem[] {
  const confirmedIdentities = new Set(
    operations.map((operation) => `${operation.deviceId}:${operation.clientOpId}`),
  );
  return outbox.filter(
    (item) => !confirmedIdentities.has(`${item.envelope.deviceId}:${item.envelope.clientOpId}`),
  );
}

function removeConfirmedPending(
  pendingConfirmations: readonly PendingConfirmationItem[],
  operations: readonly CommittedOperation[],
): PendingConfirmationItem[] {
  const confirmedIdentities = new Set(
    operations.map((operation) => `${operation.deviceId}:${operation.clientOpId}`),
  );
  return pendingConfirmations.filter(
    (item) => !confirmedIdentities.has(`${item.envelope.deviceId}:${item.envelope.clientOpId}`),
  );
}

function confirmedIntentsMatch(
  outbox: readonly PersistentOutboxItem[],
  pendingConfirmations: readonly PendingConfirmationItem[],
  operations: readonly CommittedOperation[],
): boolean {
  const pendingByIdentity = new Map(
    pendingConfirmations.map((item) => [
      `${item.envelope.deviceId}:${item.envelope.clientOpId}`,
      item,
    ]),
  );
  const liveByIdentity = new Map(
    [...pendingConfirmations, ...outbox].map((item) => [
      `${item.envelope.deviceId}:${item.envelope.clientOpId}`,
      item,
    ]),
  );
  for (const operation of operations) {
    const identity = `${operation.deviceId}:${operation.clientOpId}`;
    const live = liveByIdentity.get(identity);
    if (
      live !== undefined &&
      (live.envelope.roomId !== operation.roomId ||
        live.envelope.roomEpoch !== operation.roomEpoch ||
        JSON.stringify(live.envelope.operation) !== JSON.stringify(operation.operation))
    ) {
      return false;
    }
    const pending = pendingByIdentity.get(identity);
    if (pending !== undefined && pending.acknowledgedServerSeq !== operation.serverSeq) {
      return false;
    }
  }
  return true;
}

function recoveringRecord(record: ReplicaRecord): ReplicaRecord {
  if (record.confirmedSnapshot === null) {
    return {
      ...record,
      mode: "WAITING_SNAPSHOT",
      quarantineReason: null,
    };
  }
  return {
    ...record,
    mode: "RECOVERING",
    quarantineReason: null,
  };
}

function quarantinedRecord(record: ReplicaRecord, reason: "INVALID_REMOTE_STATE"): ReplicaRecord {
  return {
    ...record,
    mode: "QUARANTINED",
    quarantineReason: reason,
  };
}

function validateOptimisticCandidate(record: ReplicaRecord): ReplicaRecord {
  const candidate = pruneUnknownBindings(record);
  try {
    projectOptimisticState(candidate);
    return candidate;
  } catch (cause) {
    if (cause instanceof ReplicaError && cause.code === "OPTIMISTIC_CONFLICT") {
      return {
        ...candidate,
        mode: "QUARANTINED",
        quarantineReason: "OPTIMISTIC_CONFLICT",
      };
    }
    throw cause;
  }
}

function pruneUnknownBindings(record: ReplicaRecord): ReplicaRecord {
  const knownLogicalTabs = new Set([
    ...(record.confirmedSnapshot?.tabs.map((tab) => tab.id) ?? []),
    ...record.outbox.flatMap((item) =>
      item.envelope.operation.type === "tab.create" ? [item.envelope.operation.logicalTabId] : [],
    ),
    ...record.pendingConfirmations.flatMap((item) =>
      item.envelope.operation.type === "tab.create" ? [item.envelope.operation.logicalTabId] : [],
    ),
  ]);
  return {
    ...record,
    bindings: record.bindings.filter((binding) => knownLogicalTabs.has(binding.logicalTabId)),
  };
}

function sortBindings(
  bindings: readonly LocalTabBinding[],
  logicalOrder: readonly string[],
): LocalTabBinding[] {
  const orderByLogicalId = new Map(
    logicalOrder.map((logicalTabId, index) => [logicalTabId, index]),
  );
  return [...bindings].toSorted(
    (left, right) =>
      (orderByLogicalId.get(left.logicalTabId) ?? Number.MAX_SAFE_INTEGER) -
      (orderByLogicalId.get(right.logicalTabId) ?? Number.MAX_SAFE_INTEGER),
  );
}
