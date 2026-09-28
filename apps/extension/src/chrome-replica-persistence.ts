import type { ReplicaPersistence, ReplicaRecord } from "@syncaction/replica";
import { DEFAULT_SERVER_PROFILE_ID, ServerProfileIdSchema } from "./server-profile.js";
import { serverScopedStorageKey } from "./scoped-storage.js";

export interface ChromeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}

export interface ChromeReplicaPersistenceOptions {
  profileId: unknown;
}

export class ChromeReplicaPersistence implements ReplicaPersistence {
  readonly #area: ChromeStorageArea;
  readonly #profileId: string;

  public constructor(area: ChromeStorageArea, options: ChromeReplicaPersistenceOptions) {
    this.#area = area;
    this.#profileId = ServerProfileIdSchema.parse(options.profileId);
  }

  public async read(key: string): Promise<unknown | undefined> {
    const scopedKey = serverScopedStorageKey(this.#profileId, key);
    const values = await this.#area.get(scopedKey);
    const scopedValue = values[scopedKey];
    if (scopedValue !== undefined || this.#profileId !== DEFAULT_SERVER_PROFILE_ID) {
      return scopedValue;
    }

    const legacyValue = (await this.#area.get(key))[key];
    if (legacyValue !== undefined) {
      await this.#area.set({ [scopedKey]: legacyValue });
    }
    return legacyValue;
  }

  public async write(key: string, value: ReplicaRecord): Promise<void> {
    await this.#area.set({
      [serverScopedStorageKey(this.#profileId, key)]: value,
    });
  }
}

export async function restrictReplicaStorageAccess(area: ChromeStorageArea): Promise<void> {
  if (area.setAccessLevel === undefined) {
    throw new Error("chrome.storage.local.setAccessLevel is unavailable");
  }
  await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}
