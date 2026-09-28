import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExtensionSessionManager,
  ExtensionSessionRequiredError,
  LEGACY_PRODUCT_SESSION_STORAGE_KEY,
  PRODUCT_SESSION_STORAGE_KEY,
  type ExtensionSessionStorageArea,
  type PublicSessionResponse,
} from "../src/product-session.js";
import { SyncActionApiError } from "../src/api-client.js";
import { DEFAULT_SERVER_PROFILE_ID, type ServerProfile } from "../src/server-profile.js";

const serverUrl = "https://syncaction.example.com";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const firstProfileId = "server-a";
const secondProfileId = "server-b";
const firstServerId = "018f8f8e-4b5c-7d6e-8f90-123456789b01";
const secondServerId = "018f8f8e-4b5c-7d6e-8f90-123456789b02";

function response(accessToken: string, refreshToken = "A".repeat(43)): PublicSessionResponse {
  return {
    sessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab2",
    accessToken,
    refreshToken,
    expiresInSeconds: 900,
    refreshExpiresInSeconds: 2_592_000,
    account: {
      id: "018f8f8e-4b5c-7d6e-8f90-123456789ab3",
      username: "alex",
      displayName: "Alex",
      status: "ACTIVE",
      passwordResetRequired: false,
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

function defaultSessionInput(
  accessToken: string,
  refreshToken = "A".repeat(43),
  origin = serverUrl,
) {
  return {
    profileId: DEFAULT_SERVER_PROFILE_ID,
    serverUrl: origin,
    serverId: firstServerId,
    deviceId,
    response: response(accessToken, refreshToken),
  };
}

class MemoryArea implements ExtensionSessionStorageArea {
  public readonly values: Record<string, unknown> = {};
  public removeCount = 0;
  public failNextSet = false;

  public async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("storage unavailable");
    }
    Object.assign(this.values, structuredClone(values));
  }

  public async remove(key: string): Promise<void> {
    this.removeCount += 1;
    delete this.values[key];
  }
}

let area: MemoryArea;
let now: number;

beforeEach(() => {
  area = new MemoryArea();
  now = Date.parse("2026-07-27T00:00:00.000Z");
});

describe("ExtensionSessionManager", () => {
  it("isolates credentials, rotation, and clearing by server profile", async () => {
    const rotate = vi.fn().mockResolvedValue(response("rotated-b", "C".repeat(43)));
    const sessions = new ExtensionSessionManager({
      area,
      rotate,
      now: () => now,
    });

    await sessions.establish({
      profileId: firstProfileId,
      serverUrl: "https://a.example",
      serverId: firstServerId,
      deviceId,
      response: response("access-a", "A".repeat(43)),
    });
    await sessions.establish({
      profileId: secondProfileId,
      serverUrl: "https://b.example",
      serverId: secondServerId,
      deviceId,
      response: response("access-b", "B".repeat(43)),
    });

    await expect(sessions.read(firstProfileId)).resolves.toMatchObject({
      profileId: firstProfileId,
      serverUrl: "https://a.example",
      serverId: firstServerId,
      accessToken: "access-a",
    });
    await expect(sessions.read(secondProfileId)).resolves.toMatchObject({
      profileId: secondProfileId,
      serverUrl: "https://b.example",
      serverId: secondServerId,
      accessToken: "access-b",
    });

    now += 15 * 60 * 1_000;
    await expect(sessions.getAccessToken(secondProfileId)).resolves.toBe("rotated-b");
    expect(rotate).toHaveBeenCalledWith({
      serverUrl: "https://b.example",
      refreshToken: "B".repeat(43),
    });
    await expect(sessions.read(firstProfileId)).resolves.toMatchObject({
      accessToken: "access-a",
      refreshToken: "A".repeat(43),
    });

    await sessions.clear(firstProfileId);
    await expect(sessions.read(firstProfileId)).resolves.toBeNull();
    await expect(sessions.read(secondProfileId)).resolves.toMatchObject({
      accessToken: "rotated-b",
    });
  });

  it("migrates one exact v1 production session into the default verified profile", async () => {
    const sessions = new ExtensionSessionManager({
      area,
      rotate: vi.fn(),
      now: () => now,
    });
    area.values[LEGACY_PRODUCT_SESSION_STORAGE_KEY] = {
      version: 1,
      serverUrl,
      deviceId,
      sessionId: response("legacy-access").sessionId,
      accessToken: "legacy-access",
      accessTokenExpiresAt: now + 900_000,
      refreshToken: "A".repeat(43),
      refreshTokenExpiresAt: now + 2_592_000_000,
      account: response("legacy-access").account,
    };
    const profile: ServerProfile = {
      profileId: DEFAULT_SERVER_PROFILE_ID,
      baseUrl: serverUrl,
      mode: "VNEXT",
      metadata: {
        serverId: firstServerId,
        displayName: "SyncAction",
        softwareVersion: "0.9.3",
        protocolVersion: "1",
        minimumClientVersion: "0.8.1",
        termsVersion: "2026-07-30",
        capabilities: ["public-rooms"],
        limits: { ordinaryActiveRooms: 5, ordinaryOpenTabs: 20 },
      },
      lastHealthyAt: now,
    };

    await sessions.migrateLegacyProductionSession(profile);

    expect(area.values).not.toHaveProperty(LEGACY_PRODUCT_SESSION_STORAGE_KEY);
    await expect(sessions.read(DEFAULT_SERVER_PROFILE_ID)).resolves.toMatchObject({
      version: 2,
      profileId: DEFAULT_SERVER_PROFILE_ID,
      serverUrl,
      serverId: firstServerId,
      accessToken: "legacy-access",
    });
    expect(area.values[PRODUCT_SESSION_STORAGE_KEY]).toMatchObject({ version: 2 });
  });

  it.each([
    {
      name: "corrupt",
      legacy: { version: 1, serverUrl, accessToken: "partial-secret" },
    },
    {
      name: "different origin",
      legacy: {
        version: 1,
        serverUrl: "https://other.example",
        deviceId,
        sessionId: response("legacy-access").sessionId,
        accessToken: "legacy-access",
        accessTokenExpiresAt: Date.parse("2026-07-27T00:15:00.000Z"),
        refreshToken: "A".repeat(43),
        refreshTokenExpiresAt: Date.parse("2026-08-26T00:00:00.000Z"),
        account: response("legacy-access").account,
      },
    },
  ])("removes a $name v1 session instead of guessing its profile", async ({ legacy }) => {
    const sessions = new ExtensionSessionManager({
      area,
      rotate: vi.fn(),
      now: () => now,
    });
    area.values[LEGACY_PRODUCT_SESSION_STORAGE_KEY] = legacy;
    const profile: ServerProfile = {
      profileId: DEFAULT_SERVER_PROFILE_ID,
      baseUrl: serverUrl,
      mode: "LEGACY_V081",
      metadata: null,
      lastHealthyAt: now,
    };

    await sessions.migrateLegacyProductionSession(profile);

    expect(area.values).not.toHaveProperty(LEGACY_PRODUCT_SESSION_STORAGE_KEY);
    await expect(sessions.read(DEFAULT_SERVER_PROFILE_ID)).resolves.toBeNull();
  });

  it("clears a legacy null-identity session when that profile becomes verified vNext", async () => {
    const sessions = new ExtensionSessionManager({
      area,
      rotate: vi.fn(),
      now: () => now,
    });
    await sessions.establish({
      profileId: "legacy-server",
      serverUrl: "https://legacy.example",
      serverId: null,
      deviceId,
      response: response("legacy-access"),
    });

    await sessions.migrateLegacyProductionSession({
      profileId: "legacy-server",
      baseUrl: "https://legacy.example",
      mode: "VNEXT",
      metadata: {
        serverId: secondServerId,
        displayName: "Upgraded server",
        softwareVersion: "0.9.3",
        protocolVersion: "1",
        minimumClientVersion: "0.8.1",
        termsVersion: "2026-07-30",
        capabilities: [],
        limits: { ordinaryActiveRooms: 5, ordinaryOpenTabs: 20 },
      },
      lastHealthyAt: now,
    });

    await expect(sessions.read("legacy-server")).resolves.toBeNull();
  });

  it("persists canonical loopback sessions for local builds and rejects remote HTTP", async () => {
    const sessions = new ExtensionSessionManager({
      area,
      rotate: vi.fn(),
      now: () => now,
    });

    await expect(
      sessions.establish({
        ...defaultSessionInput("local-access"),
        serverUrl: "http://127.0.0.1:29373/",
      }),
    ).resolves.toMatchObject({ serverUrl: "http://127.0.0.1:29373" });
    await expect(
      sessions.establish({
        ...defaultSessionInput("unsafe-access"),
        serverUrl: "http://192.0.2.10:29373",
      }),
    ).rejects.toThrow();
  });

  it("persists a strict session and reuses an access token outside the refresh margin", async () => {
    const rotate = vi.fn();
    const sessions = new ExtensionSessionManager({
      area,
      rotate,
      now: () => now,
    });

    await sessions.establish(defaultSessionInput("access-1"));

    expect(await sessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID)).toBe("access-1");
    expect(rotate).not.toHaveBeenCalled();
    expect(await sessions.getStatus(DEFAULT_SERVER_PROFILE_ID)).toMatchObject({
      kind: "AUTHENTICATED",
      account: { username: "alex" },
      deviceId,
    });
  });

  it("updates the persisted account snapshot without changing either session token", async () => {
    const sessions = new ExtensionSessionManager({
      area,
      rotate: vi.fn(),
      now: () => now,
    });
    await sessions.establish(defaultSessionInput("access-1"));
    const renamed = {
      ...response("unused").account,
      username: "alex.renamed",
      displayName: "Alex Renamed",
    };

    await sessions.updateAccount(DEFAULT_SERVER_PROFILE_ID, renamed);

    await expect(sessions.read(DEFAULT_SERVER_PROFILE_ID)).resolves.toMatchObject({
      accessToken: "access-1",
      refreshToken: "A".repeat(43),
      account: renamed,
    });
    await expect(sessions.getStatus(DEFAULT_SERVER_PROFILE_ID)).resolves.toMatchObject({
      kind: "AUTHENTICATED",
      account: renamed,
    });
  });

  it("removes malformed local credentials instead of exposing a partial session", async () => {
    area.values[PRODUCT_SESSION_STORAGE_KEY] = {
      version: 2,
      sessions: {
        [DEFAULT_SERVER_PROFILE_ID]: {
          version: 2,
          profileId: DEFAULT_SERVER_PROFILE_ID,
          serverUrl,
          accessToken: "leaked-but-incomplete",
        },
      },
    };
    const sessions = new ExtensionSessionManager({
      area,
      rotate: vi.fn(),
      now: () => now,
    });

    await expect(sessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID)).rejects.toBeInstanceOf(
      ExtensionSessionRequiredError,
    );
    expect(area.removeCount).toBe(1);
    expect(await sessions.getStatus(DEFAULT_SERVER_PROFILE_ID)).toEqual({ kind: "SIGNED_OUT" });
  });

  it("serializes concurrent refreshes and persists the successor before returning it", async () => {
    let release!: (value: PublicSessionResponse) => void;
    const rotate = vi.fn(
      () =>
        new Promise<PublicSessionResponse>((resolve) => {
          release = resolve;
        }),
    );
    const sessions = new ExtensionSessionManager({
      area,
      rotate,
      now: () => now,
    });
    await sessions.establish(defaultSessionInput("access-1"));
    now += 14 * 60 * 1_000 + 45_000;

    const first = sessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID);
    const second = sessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID);
    await vi.waitFor(() => expect(rotate).toHaveBeenCalledTimes(1));
    expect(rotate).toHaveBeenCalledWith({
      serverUrl,
      refreshToken: "A".repeat(43),
    });

    release(response("access-2", "B".repeat(43)));

    await expect(Promise.all([first, second])).resolves.toEqual(["access-2", "access-2"]);
    expect(await sessions.read(DEFAULT_SERVER_PROFILE_ID)).toMatchObject({
      accessToken: "access-2",
      refreshToken: "B".repeat(43),
    });
  });

  it("does not overwrite a replacement login that wins while an old refresh is in flight", async () => {
    let release!: (value: PublicSessionResponse) => void;
    const rotate = vi.fn(
      () =>
        new Promise<PublicSessionResponse>((resolve) => {
          release = resolve;
        }),
    );
    const sessions = new ExtensionSessionManager({
      area,
      rotate,
      now: () => now,
    });
    await sessions.establish(defaultSessionInput("old-access", "A".repeat(43)));
    now += 15 * 60 * 1_000;

    const staleRefresh = sessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID);
    await vi.waitFor(() => expect(rotate).toHaveBeenCalledOnce());
    await sessions.establish(defaultSessionInput("replacement-access", "D".repeat(43)));
    release(response("stale-successor", "C".repeat(43)));

    await expect(staleRefresh).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await expect(sessions.read(DEFAULT_SERVER_PROFILE_ID)).resolves.toMatchObject({
      accessToken: "replacement-access",
      refreshToken: "D".repeat(43),
      profileId: DEFAULT_SERVER_PROFILE_ID,
      serverUrl,
      serverId: firstServerId,
    });
  });

  it("retries one authenticated request after SESSION_INVALID with a rotated token", async () => {
    const rotate = vi.fn().mockResolvedValue(response("access-2", "B".repeat(43)));
    const sessions = new ExtensionSessionManager({
      area,
      rotate,
      now: () => now,
    });
    await sessions.establish(defaultSessionInput("access-1"));
    const operation = vi
      .fn<(accessToken: string) => Promise<string>>()
      .mockRejectedValueOnce(new SyncActionApiError("SESSION_INVALID", 401))
      .mockResolvedValueOnce("ok");

    await expect(sessions.runAuthenticated(DEFAULT_SERVER_PROFILE_ID, operation)).resolves.toBe(
      "ok",
    );
    expect(operation.mock.calls).toEqual([["access-1"], ["access-2"]]);
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it.each(["SESSION_INVALID", "SESSION_REPLAYED"] as const)(
    "clears credentials when refresh fails with %s",
    async (code) => {
      const sessions = new ExtensionSessionManager({
        area,
        rotate: vi.fn().mockRejectedValue(new SyncActionApiError(code, 401)),
        now: () => now,
      });
      await sessions.establish(defaultSessionInput("access-1"));
      now += 15 * 60 * 1_000;

      await expect(sessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID)).rejects.toMatchObject({
        code,
      });
      expect(await sessions.getStatus(DEFAULT_SERVER_PROFILE_ID)).toEqual({
        kind: "SIGNED_OUT",
      });
    },
  );

  it("clears an already expired refresh session without presenting it to the server", async () => {
    const rotate = vi.fn();
    const sessions = new ExtensionSessionManager({
      area,
      rotate,
      now: () => now,
    });
    await sessions.establish(defaultSessionInput("access-1"));
    now += 2_592_000 * 1_000;

    await expect(sessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID)).rejects.toBeInstanceOf(
      ExtensionSessionRequiredError,
    );
    expect(rotate).not.toHaveBeenCalled();
    expect(await sessions.getStatus(DEFAULT_SERVER_PROFILE_ID)).toEqual({ kind: "SIGNED_OUT" });
  });

  it("fails closed if a rotated successor cannot be persisted", async () => {
    const sessions = new ExtensionSessionManager({
      area,
      rotate: vi.fn().mockResolvedValue(response("access-2", "B".repeat(43))),
      now: () => now,
    });
    await sessions.establish(defaultSessionInput("access-1"));
    now += 15 * 60 * 1_000;
    area.failNextSet = true;

    await expect(sessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID)).rejects.toMatchObject({
      code: "SESSION_PERSIST_FAILED",
    });
    expect(await sessions.getStatus(DEFAULT_SERVER_PROFILE_ID)).toEqual({
      kind: "SIGNED_OUT",
    });
  });
});
