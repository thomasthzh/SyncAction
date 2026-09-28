import { RoomIdSchema } from "@syncaction/protocol";
import { ReplicaError } from "./errors.js";
import type { ReplicaPersistence } from "./persistence.js";
import { ReplicaRecordSchema, createReplicaRecord, type ReplicaRecord } from "./schema.js";

export interface ReplicaRepositoryOptions {
  persistence: ReplicaPersistence;
  now?: () => number;
}

export type ReplicaRecordReducer = (
  record: ReplicaRecord,
) => ReplicaRecord | Promise<ReplicaRecord>;

export function replicaStorageKey(roomIdInput: unknown): string {
  return `syncaction.replica.v1.${RoomIdSchema.parse(roomIdInput)}`;
}

export class ReplicaRepository {
  readonly #persistence: ReplicaPersistence;
  readonly #now: () => number;
  readonly #roomTails = new Map<string, Promise<void>>();

  public constructor(options: ReplicaRepositoryOptions) {
    this.#persistence = options.persistence;
    this.#now = options.now ?? Date.now;
  }

  public async load(roomIdInput: unknown): Promise<ReplicaRecord> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#serializeRoom(roomId, async () => {
      const loaded = await this.#read(roomId);
      if (!loaded.missing) {
        return loaded.record;
      }
      await this.#write(roomId, loaded.record);
      return loaded.record;
    });
  }

  public async update(roomIdInput: unknown, reducer: ReplicaRecordReducer): Promise<ReplicaRecord> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#serializeRoom(roomId, async () => {
      const current = (await this.#read(roomId)).record;
      let reduced: ReplicaRecord;
      try {
        reduced = await reducer(structuredClone(current));
      } catch (cause) {
        if (cause instanceof ReplicaError) {
          throw cause;
        }
        throw new ReplicaError("INVALID_REPLICA_TRANSITION", { cause });
      }
      const parsed = ReplicaRecordSchema.safeParse({
        ...reduced,
        updatedAtMs: this.#now(),
      });
      if (!parsed.success || parsed.data.roomId !== roomId) {
        throw new ReplicaError("INVALID_REPLICA_TRANSITION", {
          ...(parsed.success ? {} : { cause: parsed.error }),
        });
      }
      await this.#write(roomId, parsed.data);
      return parsed.data;
    });
  }

  async #read(roomId: string): Promise<{ record: ReplicaRecord; missing: boolean }> {
    const key = replicaStorageKey(roomId);
    let stored: unknown;
    try {
      stored = await this.#persistence.read(key);
    } catch (cause) {
      throw new ReplicaError("STORAGE_FAILURE", { cause });
    }
    if (stored === undefined) {
      return {
        record: createReplicaRecord(roomId, this.#now()),
        missing: true,
      };
    }
    const parsed = ReplicaRecordSchema.safeParse(stored);
    if (!parsed.success || parsed.data.roomId !== roomId) {
      throw new ReplicaError("CORRUPT_REPLICA", {
        ...(parsed.success ? {} : { cause: parsed.error }),
      });
    }
    return { record: parsed.data, missing: false };
  }

  async #write(roomId: string, record: ReplicaRecord): Promise<void> {
    try {
      await this.#persistence.write(replicaStorageKey(roomId), record);
    } catch (cause) {
      throw new ReplicaError("STORAGE_FAILURE", { cause });
    }
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
}
