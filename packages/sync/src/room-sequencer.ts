import { isDeepStrictEqual } from "node:util";
import type { createDatabase, Database } from "@syncaction/database";
import { applyCommittedOperation, DomainInvariantError } from "@syncaction/domain";
import {
  ClientOperationEnvelopeSchema,
  CommittedOperationSchema,
  DurableOperationSchema,
  OperationAckSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  RoomSyncRequestSchema,
  type ClientOperationEnvelope,
  type CommittedOperation,
  type OperationAck,
  type RoomDeltaMessage,
  type RoomSnapshotMessage,
  type RoomSyncRequest,
} from "@syncaction/protocol";
import { classifyOwner, lockCapacityPolicy, RoomError } from "@syncaction/rooms";
import type { Transaction } from "kysely";
import { SyncError } from "./errors.js";
import { writeMaterializedState } from "./materializer.js";
import { decodeMaterializedState, encodeSnapshotState } from "./state-codec.js";

type SyncDatabase = ReturnType<typeof createDatabase>;

export interface SyncPrincipal {
  userId: string;
  deviceId: string;
}

export interface CommitOperationInput {
  principal: SyncPrincipal;
  envelope: unknown;
}

export interface CommitOperationResult {
  ack: OperationAck;
  committed: CommittedOperation;
  deduplicated: boolean;
}

export interface SynchronizeRoomInput {
  principal: SyncPrincipal;
  request: unknown;
}

export type SynchronizeRoomResult = RoomSnapshotMessage | RoomDeltaMessage;

export interface RoomSequencerOptions {
  db: SyncDatabase;
  now?: () => Date;
  snapshotInterval?: number;
  deltaLimit?: number;
}

type CommitTransactionOutcome =
  { kind: "COMMITTED"; result: CommitOperationResult } | { kind: "CAPACITY_REJECTED" };

export class RoomSequencer {
  readonly #db: SyncDatabase;
  readonly #now: () => Date;
  readonly #snapshotInterval: number;
  readonly #deltaLimit: number;
  readonly #roomTails = new Map<string, Promise<void>>();

  public constructor(options: RoomSequencerOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    this.#snapshotInterval = options.snapshotInterval ?? 100;
    this.#deltaLimit = options.deltaLimit ?? 1_000;
    if (!Number.isSafeInteger(this.#snapshotInterval) || this.#snapshotInterval < 1) {
      throw new SyncError("INVALID_SYNC_MESSAGE");
    }
    if (
      !Number.isSafeInteger(this.#deltaLimit) ||
      this.#deltaLimit < 1 ||
      this.#deltaLimit > 1_000
    ) {
      throw new SyncError("INVALID_SYNC_MESSAGE");
    }
  }

  public async commitOperation(input: CommitOperationInput): Promise<CommitOperationResult> {
    const parsed = ClientOperationEnvelopeSchema.safeParse(input.envelope);
    if (!parsed.success) {
      throw new SyncError("INVALID_SYNC_MESSAGE", { cause: parsed.error });
    }
    const envelope = parsed.data;
    if (input.principal.deviceId !== envelope.deviceId) {
      throw new SyncError("DEVICE_MISMATCH");
    }
    return this.#serializeRoom(envelope.roomId, () =>
      this.#commitValidated(input.principal, envelope),
    );
  }

  public async synchronize(input: SynchronizeRoomInput): Promise<SynchronizeRoomResult> {
    const parsed = RoomSyncRequestSchema.safeParse(input.request);
    if (!parsed.success) {
      throw new SyncError("INVALID_SYNC_MESSAGE", { cause: parsed.error });
    }
    return this.#serializeRoom(parsed.data.roomId, () =>
      this.#synchronizeValidated(input.principal, parsed.data),
    );
  }

  async #commitValidated(
    principal: SyncPrincipal,
    envelope: ClientOperationEnvelope,
  ): Promise<CommitOperationResult> {
    try {
      const commitTransaction = async (
        transaction: Transaction<Database>,
      ): Promise<CommitTransactionOutcome> => {
        const capacityPolicy =
          envelope.operation.type === "tab.create" ? await lockCapacityPolicy(transaction) : null;
        const room = await transaction
          .selectFrom("rooms")
          .select(["id", "ownerUserId", "roomEpoch", "serverSeq", "deletedAt"])
          .where("id", "=", envelope.roomId)
          .forUpdate()
          .executeTakeFirst();
        if (room === undefined || room.deletedAt !== null) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        const membership = await transaction
          .selectFrom("roomMemberships")
          .innerJoin("users", "users.id", "roomMemberships.userId")
          .select("roomMemberships.userId")
          .where("roomMemberships.roomId", "=", room.id)
          .where("roomMemberships.userId", "=", principal.userId)
          .where("users.status", "=", "ACTIVE")
          .executeTakeFirst();
        if (membership === undefined) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        if (room.roomEpoch !== envelope.roomEpoch) {
          throw new SyncError("ROOM_EPOCH_MISMATCH");
        }

        const prior = await transaction
          .selectFrom("clientOperations")
          .select("serverSeq")
          .where("roomId", "=", room.id)
          .where("deviceId", "=", envelope.deviceId)
          .where("clientOpId", "=", envelope.clientOpId)
          .executeTakeFirst();
        if (prior !== undefined) {
          const stored = await transaction
            .selectFrom("roomOperations")
            .selectAll()
            .where("roomId", "=", room.id)
            .where("serverSeq", "=", prior.serverSeq)
            .executeTakeFirst();
          if (stored === undefined) {
            throw new SyncError("RECOVERY_REQUIRED");
          }
          const storedOperation = DurableOperationSchema.safeParse(stored.payload);
          if (
            !storedOperation.success ||
            stored.roomEpoch !== envelope.roomEpoch ||
            stored.deviceId !== envelope.deviceId ||
            stored.clientOpId !== envelope.clientOpId
          ) {
            throw new SyncError("RECOVERY_REQUIRED", {
              ...(storedOperation.success ? {} : { cause: storedOperation.error }),
            });
          }
          if (!isDeepStrictEqual(storedOperation.data, envelope.operation)) {
            throw new SyncError("CLIENT_OP_REUSE");
          }
          return {
            kind: "COMMITTED",
            result: this.#resultFromStored(envelope, stored.serverSeq, storedOperation.data, true),
          };
        }

        if (envelope.baseServerSeq > room.serverSeq) {
          throw new SyncError("BASE_SEQUENCE_AHEAD");
        }
        const rows = await transaction
          .selectFrom("roomTabs")
          .selectAll()
          .where("roomId", "=", room.id)
          .execute();
        const previous = decodeMaterializedState(room, rows);
        const serverSeq = room.serverSeq + 1;
        const committed = CommittedOperationSchema.parse({
          type: "op.committed",
          protocolVersion: 1,
          clientOpId: envelope.clientOpId,
          roomId: envelope.roomId,
          roomEpoch: envelope.roomEpoch,
          deviceId: envelope.deviceId,
          serverSeq,
          operation: envelope.operation,
        });
        let next;
        try {
          next = applyCommittedOperation(previous, committed);
        } catch (cause) {
          if (cause instanceof DomainInvariantError) {
            throw new SyncError("OPERATION_REJECTED", { cause });
          }
          throw cause;
        }

        if (
          capacityPolicy !== null &&
          (await classifyOwner(transaction, room.ownerUserId)) === "ORDINARY"
        ) {
          const openTabs = await transaction
            .selectFrom("roomTabs")
            .select((expression) => expression.fn.countAll<number>().as("count"))
            .where("roomId", "=", room.id)
            .where("closedAtSeq", "is", null)
            .executeTakeFirstOrThrow();
          const openTabCount = Number(openTabs.count);
          if (openTabCount >= capacityPolicy.ordinaryOpenTabLimit) {
            await transaction
              .insertInto("auditEvents")
              .values({
                actorUserId: principal.userId,
                actorAdministratorId: null,
                eventType: "room.tab_create_capacity_rejected",
                targetType: "room",
                targetId: room.id,
                details: {
                  deviceId: principal.deviceId,
                  clientOpId: envelope.clientOpId,
                  quotaClass: "ORDINARY",
                  openTabCount,
                  ordinaryOpenTabLimit: capacityPolicy.ordinaryOpenTabLimit,
                  reasonCode: "ROOM_TAB_LIMIT_REACHED",
                },
                createdAt: this.#now(),
              })
              .execute();
            return { kind: "CAPACITY_REJECTED" };
          }
        }

        const committedAt = this.#now();
        await writeMaterializedState(transaction, previous, next);
        await transaction
          .insertInto("roomOperations")
          .values({
            roomId: room.id,
            serverSeq,
            roomEpoch: room.roomEpoch,
            clientOpId: envelope.clientOpId,
            deviceId: envelope.deviceId,
            payload: envelope.operation as unknown as Record<string, unknown>,
            createdAt: committedAt,
          })
          .execute();
        await transaction
          .insertInto("clientOperations")
          .values({
            roomId: room.id,
            deviceId: envelope.deviceId,
            clientOpId: envelope.clientOpId,
            serverSeq,
            createdAt: committedAt,
          })
          .execute();
        await transaction
          .updateTable("rooms")
          .set({ serverSeq, updatedAt: committedAt })
          .where("id", "=", room.id)
          .execute();
        if (serverSeq % this.#snapshotInterval === 0) {
          await transaction
            .insertInto("roomSnapshots")
            .values({
              roomId: room.id,
              roomEpoch: room.roomEpoch,
              serverSeq,
              state: encodeSnapshotState(next) as unknown as Record<string, unknown>,
              createdAt: committedAt,
            })
            .execute();
        }
        return {
          kind: "COMMITTED",
          result: {
            ack: OperationAckSchema.parse({
              type: "op.ack",
              protocolVersion: 1,
              clientOpId: envelope.clientOpId,
              roomId: envelope.roomId,
              roomEpoch: envelope.roomEpoch,
              serverSeq,
            }),
            committed,
            deduplicated: false,
          },
        };
      };
      const outcome = await this.#db.transaction().execute(commitTransaction);
      if (outcome.kind === "CAPACITY_REJECTED") {
        throw new RoomError("ROOM_TAB_LIMIT_REACHED");
      }
      return outcome.result;
    } catch (cause) {
      if (cause instanceof SyncError) {
        throw cause;
      }
      if (cause instanceof RoomError && cause.code === "ROOM_TAB_LIMIT_REACHED") {
        throw new SyncError("ROOM_TAB_LIMIT_REACHED", { cause });
      }
      throw new SyncError("RECOVERY_REQUIRED", { cause });
    }
  }

  async #synchronizeValidated(
    principal: SyncPrincipal,
    request: RoomSyncRequest,
  ): Promise<SynchronizeRoomResult> {
    try {
      return await this.#db.transaction().execute(async (transaction) => {
        const room = await transaction
          .selectFrom("rooms")
          .select(["id", "roomEpoch", "serverSeq", "deletedAt"])
          .where("id", "=", request.roomId)
          .forShare()
          .executeTakeFirst();
        if (room === undefined || room.deletedAt !== null) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        const membership = await transaction
          .selectFrom("roomMemberships")
          .innerJoin("users", "users.id", "roomMemberships.userId")
          .select("roomMemberships.userId")
          .where("roomMemberships.roomId", "=", room.id)
          .where("roomMemberships.userId", "=", principal.userId)
          .where("users.status", "=", "ACTIVE")
          .executeTakeFirst();
        if (membership === undefined) {
          throw new SyncError("ROOM_NOT_FOUND");
        }

        if (
          !request.hasConfirmedSnapshot ||
          request.roomEpoch !== room.roomEpoch ||
          request.lastServerSeq > room.serverSeq ||
          room.serverSeq - request.lastServerSeq > this.#deltaLimit
        ) {
          return this.#buildSnapshot(transaction, room);
        }

        const rows = await transaction
          .selectFrom("roomOperations")
          .selectAll()
          .where("roomId", "=", room.id)
          .where("serverSeq", ">", request.lastServerSeq)
          .where("serverSeq", "<=", room.serverSeq)
          .orderBy("serverSeq", "asc")
          .execute();
        const operations: CommittedOperation[] = [];
        for (const [index, row] of rows.entries()) {
          const operation = DurableOperationSchema.safeParse(row.payload);
          const committed = operation.success
            ? CommittedOperationSchema.safeParse({
                type: "op.committed",
                protocolVersion: 1,
                clientOpId: row.clientOpId,
                roomId: row.roomId,
                roomEpoch: row.roomEpoch,
                deviceId: row.deviceId,
                serverSeq: row.serverSeq,
                operation: operation.data,
              })
            : undefined;
          if (
            committed === undefined ||
            !committed.success ||
            row.roomEpoch !== room.roomEpoch ||
            row.serverSeq !== request.lastServerSeq + index + 1
          ) {
            return this.#buildSnapshot(transaction, room);
          }
          operations.push(committed.data);
        }
        if (operations.length !== room.serverSeq - request.lastServerSeq) {
          return this.#buildSnapshot(transaction, room);
        }
        return RoomDeltaMessageSchema.parse({
          type: "room.delta",
          protocolVersion: 1,
          roomId: room.id,
          roomEpoch: room.roomEpoch,
          fromServerSeq: request.lastServerSeq,
          toServerSeq: room.serverSeq,
          operations,
        });
      });
    } catch (cause) {
      if (cause instanceof SyncError) {
        throw cause;
      }
      throw new SyncError("RECOVERY_REQUIRED", { cause });
    }
  }

  async #buildSnapshot(
    transaction: Transaction<Database>,
    room: { id: string; roomEpoch: number; serverSeq: number },
  ): Promise<RoomSnapshotMessage> {
    const rows = await transaction
      .selectFrom("roomTabs")
      .selectAll()
      .where("roomId", "=", room.id)
      .execute();
    const state = encodeSnapshotState(decodeMaterializedState(room, rows));
    const message = RoomSnapshotMessageSchema.parse({
      type: "room.snapshot",
      protocolVersion: 1,
      state,
    });
    await transaction
      .insertInto("roomSnapshots")
      .values({
        roomId: room.id,
        roomEpoch: room.roomEpoch,
        serverSeq: room.serverSeq,
        state: state as unknown as Record<string, unknown>,
        createdAt: this.#now(),
      })
      .onConflict((conflict) => conflict.columns(["roomId", "roomEpoch", "serverSeq"]).doNothing())
      .execute();
    return message;
  }

  async #serializeRoom<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#roomTails.get(roomId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#roomTails.set(roomId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release?.();
      if (this.#roomTails.get(roomId) === tail) {
        this.#roomTails.delete(roomId);
      }
    }
  }

  #resultFromStored(
    envelope: ClientOperationEnvelope,
    serverSeq: number,
    operation: ClientOperationEnvelope["operation"],
    deduplicated: boolean,
  ): CommitOperationResult {
    const committed = CommittedOperationSchema.parse({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId: envelope.clientOpId,
      roomId: envelope.roomId,
      roomEpoch: envelope.roomEpoch,
      deviceId: envelope.deviceId,
      serverSeq,
      operation,
    });
    return {
      ack: OperationAckSchema.parse({
        type: "op.ack",
        protocolVersion: 1,
        clientOpId: envelope.clientOpId,
        roomId: envelope.roomId,
        roomEpoch: envelope.roomEpoch,
        serverSeq,
      }),
      committed,
      deduplicated,
    };
  }
}
