import type { ReplicaRecord } from "./schema.js";

export interface ReplicaPersistence {
  read(key: string): Promise<unknown | undefined>;
  write(key: string, value: ReplicaRecord): Promise<void>;
}

export interface PersistenceWrite {
  key: string;
  value: ReplicaRecord;
}

export class MemoryReplicaPersistence implements ReplicaPersistence {
  readonly #values = new Map<string, unknown>();
  public readonly writes: PersistenceWrite[] = [];
  public failNextRead = false;
  public failNextWrite = false;

  public constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.#values.set(key, structuredClone(value));
    }
  }

  public async read(key: string): Promise<unknown | undefined> {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("injected storage read failure");
    }
    const value = this.#values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  public async write(key: string, value: ReplicaRecord): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("injected storage write failure");
    }
    const stored = structuredClone(value);
    this.#values.set(key, stored);
    this.writes.push({ key, value: structuredClone(value) });
  }

  public peek(key: string): unknown | undefined {
    const value = this.#values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
}
