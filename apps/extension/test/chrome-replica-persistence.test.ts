import { ReplicaRepository, createReplicaRecord, replicaStorageKey } from "@syncaction/replica";
import { describe, expect, it } from "vitest";
import {
  ChromeReplicaPersistence,
  restrictReplicaStorageAccess,
  type ChromeStorageArea,
} from "../src/chrome-replica-persistence.js";
import { DEFAULT_SERVER_PROFILE_ID } from "../src/server-profile.js";
import { serverScopedStorageKey } from "../src/scoped-storage.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";

class FakeChromeStorageArea implements ChromeStorageArea {
  public readonly values: Record<string, unknown> = {};
  public readonly writes: Record<string, unknown>[] = [];
  public accessLevels: string[] = [];

  public async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    this.writes.push(structuredClone(items));
    Object.assign(this.values, structuredClone(items));
  }

  public async setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void> {
    this.accessLevels.push(options.accessLevel);
  }
}

describe("ChromeReplicaPersistence", () => {
  it("reads and writes exactly one complete room-key value", async () => {
    const area = new FakeChromeStorageArea();
    const persistence = new ChromeReplicaPersistence(area, {
      profileId: DEFAULT_SERVER_PROFILE_ID,
    });
    const repository = new ReplicaRepository({ persistence, now: () => 100 });

    const record = await repository.load(roomId);
    const scopedKey = serverScopedStorageKey(DEFAULT_SERVER_PROFILE_ID, replicaStorageKey(roomId));

    expect(area.writes).toEqual([{ [scopedKey]: record }]);
    expect(await persistence.read(replicaStorageKey(roomId))).toEqual(record);
  });

  it("isolates the same logical replica key between server profiles", async () => {
    const area = new FakeChromeStorageArea();
    const first = new ChromeReplicaPersistence(area, { profileId: "server-a" });
    const second = new ChromeReplicaPersistence(area, { profileId: "server-b" });
    const logicalKey = replicaStorageKey(roomId);
    const recordA = createReplicaRecord(roomId, 100);
    const recordB = createReplicaRecord(roomId, 200);

    await first.write(logicalKey, recordA);
    await second.write(logicalKey, recordB);

    expect(await first.read(logicalKey)).toEqual(recordA);
    expect(await second.read(logicalKey)).toEqual(recordB);
    expect(Object.keys(area.values)).toEqual([
      serverScopedStorageKey("server-a", logicalKey),
      serverScopedStorageKey("server-b", logicalKey),
    ]);
  });

  it("migrates an unscoped replica only into the default server profile", async () => {
    const area = new FakeChromeStorageArea();
    const logicalKey = replicaStorageKey(roomId);
    const legacyRecord = createReplicaRecord(roomId, 100);
    area.values[logicalKey] = legacyRecord;

    const custom = new ChromeReplicaPersistence(area, { profileId: "server-a" });
    expect(await custom.read(logicalKey)).toBeUndefined();

    const production = new ChromeReplicaPersistence(area, {
      profileId: DEFAULT_SERVER_PROFILE_ID,
    });
    expect(await production.read(logicalKey)).toEqual(legacyRecord);
    expect(area.values[serverScopedStorageKey(DEFAULT_SERVER_PROFILE_ID, logicalKey)]).toEqual(
      legacyRecord,
    );
  });

  it("does not overwrite corrupt stored state with an empty room", async () => {
    const area = new FakeChromeStorageArea();
    const logicalKey = replicaStorageKey(roomId);
    const key = serverScopedStorageKey(DEFAULT_SERVER_PROFILE_ID, logicalKey);
    area.values[key] = { schemaVersion: 1, mode: "SYNCED" };
    const repository = new ReplicaRepository({
      persistence: new ChromeReplicaPersistence(area, {
        profileId: DEFAULT_SERVER_PROFILE_ID,
      }),
    });

    await expect(repository.load(roomId)).rejects.toMatchObject({
      code: "CORRUPT_REPLICA",
    });
    expect(area.writes).toEqual([]);
    expect(area.values[key]).toEqual({ schemaVersion: 1, mode: "SYNCED" });
  });

  it("restricts local storage to trusted extension contexts", async () => {
    const area = new FakeChromeStorageArea();

    await restrictReplicaStorageAccess(area);

    expect(area.accessLevels).toEqual(["TRUSTED_CONTEXTS"]);
  });
});
