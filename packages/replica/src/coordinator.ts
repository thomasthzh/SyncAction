import { RoomIdSchema, type RoomSyncRequest } from "@syncaction/protocol";
import {
  ReplicaError,
  ReplicaPermanentOperationError,
  type ReplicaPermanentServerCode,
} from "./errors.js";
import { type DurableReplica, type ReplicaTransition } from "./replica.js";
import type { PersistentOutboxItem, ReplicaRecord } from "./schema.js";
import type { ReplicaTransport } from "./transport.js";

export type ReplicaCoordinatorState =
  "DISCONNECTED" | "AUTHENTICATING" | "WAITING_SNAPSHOT" | "SYNCED" | "RECOVERING" | "QUARANTINED";

export interface ReplicaCoordinatorOptions {
  replica: DurableReplica;
  transport: ReplicaTransport;
  roomId: unknown;
  onStateChange?: (state: ReplicaCoordinatorState) => void;
  onTransition?: (transition: ReplicaTransition) => void;
  onConnectionFailure?: () => void;
}

export type AfterLocalOperationPersisted = (item: PersistentOutboxItem) => Promise<void>;

const PERMANENT_OPERATION_CODES = new Set<ReplicaPermanentServerCode>(["ROOM_TAB_LIMIT_REACHED"]);

export class ReplicaCoordinator {
  readonly #replica: DurableReplica;
  readonly #transport: ReplicaTransport;
  readonly #roomId: ReturnType<typeof RoomIdSchema.parse>;
  readonly #onStateChange: ((state: ReplicaCoordinatorState) => void) | undefined;
  readonly #onTransition: ((transition: ReplicaTransition) => void) | undefined;
  readonly #onConnectionFailure: (() => void) | undefined;
  #state: ReplicaCoordinatorState = "DISCONNECTED";
  #generation = 0;
  #tail: Promise<void> = Promise.resolve();

  public constructor(options: ReplicaCoordinatorOptions) {
    this.#replica = options.replica;
    this.#transport = options.transport;
    this.#roomId = RoomIdSchema.parse(options.roomId);
    this.#onStateChange = options.onStateChange;
    this.#onTransition = options.onTransition;
    this.#onConnectionFailure = options.onConnectionFailure;
  }

  public get state(): ReplicaCoordinatorState {
    return this.#state;
  }

  public isActuatable(): boolean {
    return this.#state === "SYNCED";
  }

  public async start(): Promise<void> {
    if (this.#state !== "DISCONNECTED") {
      throw new ReplicaError("INVALID_REPLICA_TRANSITION");
    }
    const generation = ++this.#generation;
    return this.#enqueue(async () => {
      this.#assertActive(generation);
      this.#setState("AUTHENTICATING");
      try {
        await this.#transport.connect({
          onCommitted: (operation) => {
            if (!this.#isActive(generation)) {
              return;
            }
            void this.#enqueue(async () => {
              if (!this.#isActive(generation)) {
                return;
              }
              try {
                const transition = await this.#replica.applyCommitted(operation);
                if (!this.#isActive(generation)) {
                  return;
                }
                this.#publishTransition(transition);
                this.#setStateFromRecord(transition.record);
              } catch {
                if (!this.#isActive(generation)) {
                  return;
                }
                const record = await this.#replica.getRecord();
                this.#setStateFromRecord(record);
                if (record.mode === "RECOVERING") {
                  try {
                    await this.#synchronizeAndReplay(generation);
                  } catch {
                    await this.#failConnection(generation);
                  }
                }
              }
            });
          },
          onDisconnect: () => {
            if (!this.#isActive(generation)) {
              return;
            }
            this.#setState("DISCONNECTED");
          },
          onReconnect: () => {
            if (!this.#isActive(generation) || this.#state !== "DISCONNECTED") {
              return;
            }
            void this.#enqueue(async () => {
              if (!this.#isActive(generation) || this.#state !== "DISCONNECTED") {
                return;
              }
              this.#setState("AUTHENTICATING");
              try {
                await this.#synchronizeAndReplay(generation);
              } catch {
                await this.#failConnection(generation);
              }
            });
          },
        });
        this.#assertActive(generation);
        await this.#synchronizeAndReplay(generation);
      } catch (cause) {
        await this.#failConnection(generation);
        throw cause;
      }
    });
  }

  public async stop(): Promise<void> {
    this.#generation += 1;
    this.#setState("DISCONNECTED");
    await this.#transport.disconnect();
  }

  public async enqueueLocalOperation(
    operation: unknown,
    afterPersist?: AfterLocalOperationPersisted,
  ): Promise<void> {
    const generation = this.#generation;
    return this.#enqueue(async () => {
      if (!this.#isActive(generation) || this.#state !== "SYNCED") {
        throw new ReplicaError("LOCAL_INTENT_NOT_ALLOWED");
      }
      let permanentServerRejectionHandled = false;
      try {
        const item = await this.#replica.enqueueLocalOperation(operation);
        this.#assertActive(generation);
        await afterPersist?.(item);
        this.#assertActive(generation);
        let ack;
        try {
          ack = await this.#transport.submit(item.envelope);
        } catch (cause) {
          const serverCode = permanentOperationCode(cause);
          if (serverCode === null) {
            throw cause;
          }
          this.#assertActive(generation);
          const rejectedRecord = await this.#replica.reject(item.envelope.clientOpId);
          this.#assertActive(generation);
          this.#setStateFromRecordUnlessDisconnected(rejectedRecord);
          permanentServerRejectionHandled = true;
          throw new ReplicaPermanentOperationError(serverCode, { cause });
        }
        this.#assertActive(generation);
        await this.#replica.acknowledge(ack);
      } catch (cause) {
        if (!permanentServerRejectionHandled) {
          await this.#failConnection(generation);
        }
        throw cause;
      }
    });
  }

  public async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.#tail;
      await observed;
    } while (observed !== this.#tail);
  }

  async #synchronizeAndReplay(generation: number): Promise<void> {
    const waiting = await this.#replica.beginSynchronization();
    this.#assertActive(generation);
    this.#setStateFromRecord(waiting);
    if (waiting.mode === "QUARANTINED") {
      return;
    }
    const confirmed = waiting.confirmedSnapshot;
    const request: RoomSyncRequest = {
      protocolVersion: 1,
      roomId: this.#roomId,
      roomEpoch: confirmed?.roomEpoch ?? 0,
      lastServerSeq: confirmed?.serverSeq ?? 0,
      hasConfirmedSnapshot: confirmed !== null,
    };
    const response = await this.#transport.synchronize(request);
    this.#assertActive(generation);
    const transition =
      response.type === "room.snapshot"
        ? await this.#replica.applySnapshot(response)
        : await this.#replica.applyDelta(response);
    this.#assertActive(generation);
    this.#publishTransition(transition);
    this.#setStateFromRecord(transition.record);
    if (this.#state !== "SYNCED") {
      return;
    }
    await this.#replayOutbox(generation);
  }

  async #replayOutbox(generation: number): Promise<void> {
    while (this.#isActive(generation) && this.#state === "SYNCED") {
      const record = await this.#replica.getRecord();
      const item = record.outbox[0];
      if (item === undefined) {
        return;
      }
      let ack;
      try {
        ack = await this.#transport.submit(item.envelope);
      } catch (cause) {
        const serverCode = permanentOperationCode(cause);
        if (serverCode === null) {
          throw cause;
        }
        this.#assertActive(generation);
        const rejectedRecord = await this.#replica.reject(item.envelope.clientOpId);
        this.#assertActive(generation);
        this.#setStateFromRecordUnlessDisconnected(rejectedRecord);
        if (this.#state !== "SYNCED") {
          return;
        }
        continue;
      }
      this.#assertActive(generation);
      await this.#replica.acknowledge(ack);
    }
  }

  async #failConnection(generation: number): Promise<void> {
    if (!this.#isActive(generation)) {
      return;
    }
    this.#generation += 1;
    try {
      await this.#transport.disconnect();
    } catch {
      // The connection is already considered unusable; preserve the original operation error.
    }
    try {
      this.#setStateFromRecord(await this.#replica.getRecord());
    } catch {
      this.#setState("DISCONNECTED");
      this.#notifyConnectionFailure();
      return;
    }
    if (this.#state !== "QUARANTINED") {
      this.#setState("DISCONNECTED");
    }
    this.#notifyConnectionFailure();
  }

  #notifyConnectionFailure(): void {
    try {
      this.#onConnectionFailure?.();
    } catch {
      // Recovery notification must not replace the transport failure.
    }
  }

  #publishTransition(transition: ReplicaTransition): void {
    this.#onTransition?.(transition);
  }

  #setStateFromRecord(record: ReplicaRecord): void {
    const stateByMode: Record<ReplicaRecord["mode"], ReplicaCoordinatorState> = {
      UNINITIALIZED: "WAITING_SNAPSHOT",
      WAITING_SNAPSHOT: "WAITING_SNAPSHOT",
      SYNCED: "SYNCED",
      RECOVERING: "RECOVERING",
      QUARANTINED: "QUARANTINED",
    };
    this.#setState(stateByMode[record.mode]);
  }

  #setStateFromRecordUnlessDisconnected(record: ReplicaRecord): void {
    if (this.#state === "DISCONNECTED") {
      return;
    }
    this.#setStateFromRecord(record);
  }

  #setState(state: ReplicaCoordinatorState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#onStateChange?.(state);
  }

  #isActive(generation: number): boolean {
    return this.#generation === generation;
  }

  #assertActive(generation: number): void {
    if (!this.#isActive(generation)) {
      throw new ReplicaError("INVALID_REPLICA_TRANSITION");
    }
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function permanentOperationCode(cause: unknown): ReplicaPermanentServerCode | null {
  if ((typeof cause !== "object" || cause === null) && typeof cause !== "function") {
    return null;
  }
  let code: unknown;
  try {
    code = (cause as { code?: unknown }).code;
  } catch {
    return null;
  }
  if (
    typeof code !== "string" ||
    !PERMANENT_OPERATION_CODES.has(code as ReplicaPermanentServerCode)
  ) {
    return null;
  }
  return code as ReplicaPermanentServerCode;
}
