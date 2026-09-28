import type { ServerMeta } from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_PROFILE_ID,
  SERVER_PROFILE_STORAGE_KEY,
  ServerProfileStore,
  type ServerProfileStorageArea,
} from "../src/server-profile.js";

class MemoryArea implements ServerProfileStorageArea {
  public readonly values: Record<string, unknown> = {};

  public async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items));
  }
}

const firstServerId = "018f8f8e-4b5c-7d6e-8f90-123456789c01";
const secondServerId = "018f8f8e-4b5c-7d6e-8f90-123456789c02";

function metadata(serverId = firstServerId): ServerMeta {
  return {
    serverId,
    displayName: "SyncAction Team",
    softwareVersion: "0.9.3",
    protocolVersion: "1",
    minimumClientVersion: "0.8.1",
    termsVersion: "2026-07-30",
    capabilities: ["public-rooms", "join-requests", "notifications"],
    limits: {
      ordinaryActiveRooms: 5,
      ordinaryOpenTabs: 20,
    },
  };
}

describe("ServerProfileStore", () => {
  it("creates and selects only the unverified production default", async () => {
    const area = new MemoryArea();
    const store = new ServerProfileStore({ area, now: () => 1_785_312_000_000 });

    await store.initialize();

    await expect(store.getSelected()).resolves.toEqual({
      profileId: DEFAULT_SERVER_PROFILE_ID,
      baseUrl: "https://syncaction.example.com",
      mode: "UNVERIFIED",
      metadata: null,
      lastHealthyAt: null,
    });
    await expect(store.list()).resolves.toHaveLength(1);
    expect(area.values[SERVER_PROFILE_STORAGE_KEY]).toMatchObject({
      version: 1,
      selectedProfileId: DEFAULT_SERVER_PROFILE_ID,
    });
  });

  it("persists metadata updates but rejects a replaced server identity before writing", async () => {
    const area = new MemoryArea();
    const store = new ServerProfileStore({ area, now: () => 1_785_312_000_000 });
    await store.initialize();

    await store.verify(DEFAULT_SERVER_PROFILE_ID, metadata());
    await expect(store.getSelected()).resolves.toMatchObject({
      mode: "VNEXT",
      metadata: { serverId: firstServerId },
      lastHealthyAt: 1_785_312_000_000,
    });

    await store.verify(DEFAULT_SERVER_PROFILE_ID, {
      ...metadata(),
      displayName: "Renamed, same server",
    });
    const beforeReplacement = structuredClone(area.values[SERVER_PROFILE_STORAGE_KEY]);

    await expect(store.verify(DEFAULT_SERVER_PROFILE_ID, metadata(secondServerId))).rejects.toThrow(
      "SERVER_IDENTITY_CHANGED",
    );
    expect(area.values[SERVER_PROFILE_STORAGE_KEY]).toEqual(beforeReplacement);
  });

  it("normalizes valid origins, selects a verified candidate, and rejects duplicates", async () => {
    const area = new MemoryArea();
    const ids = ["018f8f8e-4b5c-7d6e-8f90-123456789c11", "018f8f8e-4b5c-7d6e-8f90-123456789c12"];
    const store = new ServerProfileStore({
      area,
      now: () => 1_785_312_000_000,
      createProfileId: () => ids.shift()!,
    });
    await store.initialize();

    const added = await store.addCandidate(
      {
        baseUrl: "https://team.example:443/",
        mode: "VNEXT",
        metadata: metadata(),
        healthyAt: 1_785_312_000_000,
      },
      { select: true },
    );
    expect(added).toMatchObject({
      profileId: "018f8f8e-4b5c-7d6e-8f90-123456789c11",
      baseUrl: "https://team.example",
      mode: "VNEXT",
    });
    await expect(store.getSelected()).resolves.toEqual(added);

    await expect(
      store.addCandidate({
        baseUrl: "https://team.example",
        mode: "VNEXT",
        metadata: metadata(),
        healthyAt: 1_785_312_000_000,
      }),
    ).rejects.toThrow("SERVER_PROFILE_URL_EXISTS");
  });

  it("accepts HTTP only for exact loopback hosts and leaves state unchanged on invalid add", async () => {
    const area = new MemoryArea();
    let id = 0;
    const store = new ServerProfileStore({
      area,
      createProfileId: () =>
        `018f8f8e-4b5c-7d6e-8f90-${String(123456789_000 + id++).padStart(12, "0")}`,
    });
    await store.initialize();

    for (const baseUrl of [
      "http://localhost:29373",
      "http://127.0.0.1:29373",
      "http://[::1]:29373",
    ]) {
      await expect(
        store.addCandidate({
          baseUrl,
          mode: "LEGACY_V081",
          metadata: null,
          healthyAt: 1_785_312_000_000,
        }),
      ).resolves.toMatchObject({ baseUrl });
    }

    for (const baseUrl of [
      "http://192.0.2.5:29373",
      "https://user:pass@team.example",
      "https://team.example/path",
      "https://team.example?query=1",
      "https://team.example#fragment",
    ]) {
      const before = structuredClone(area.values[SERVER_PROFILE_STORAGE_KEY]);
      await expect(
        store.addCandidate({
          baseUrl,
          mode: "LEGACY_V081",
          metadata: null,
          healthyAt: 1_785_312_000_000,
        }),
      ).rejects.toThrow("INVALID_SERVER_URL");
      expect(area.values[SERVER_PROFILE_STORAGE_KEY]).toEqual(before);
    }
  });

  it("stores legacy v0.8.1 only after explicit confirmation and protects selected/default profiles", async () => {
    const area = new MemoryArea();
    const store = new ServerProfileStore({
      area,
      createProfileId: () => "018f8f8e-4b5c-7d6e-8f90-123456789c21",
    });
    await store.initialize();

    const legacy = await store.addCandidate({
      baseUrl: "https://legacy.example",
      mode: "LEGACY_V081",
      metadata: null,
      healthyAt: 1_785_312_000_000,
    });
    expect(legacy).toMatchObject({
      mode: "LEGACY_V081",
      metadata: null,
      lastHealthyAt: 1_785_312_000_000,
    });
    expect(JSON.stringify(legacy)).not.toContain("serverId");

    await expect(store.remove(DEFAULT_SERVER_PROFILE_ID)).rejects.toThrow(
      "DEFAULT_SERVER_PROFILE_REQUIRED",
    );
    await store.select(legacy.profileId);
    await expect(store.remove(legacy.profileId)).rejects.toThrow(
      "SELECTED_SERVER_PROFILE_REQUIRED",
    );
  });
});
