import { createDatabase, migrateToLatest } from "@syncaction/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/account-service.js";
import { createAccessTokenCodec } from "../src/tokens.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-26T00:00:00.000Z");
let db: ReturnType<typeof createDatabase>;
let service: AccountService;

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  service = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(7),
      now: () => now,
    }),
    now: () => now,
  });
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

describe("account registration", () => {
  it("creates a pending account with an Argon2id password hash", async () => {
    const account = await service.register({
      username: "Alex",
      displayName: "Alex 张",
      password: "correct horse battery",
    });

    expect(account).toMatchObject({
      username: "Alex",
      displayName: "Alex 张",
      status: "PENDING",
    });
    const stored = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", account.id)
      .executeTakeFirstOrThrow();
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/u);
    expect(stored.passwordHash).not.toContain("correct horse battery");
  });

  it("rejects a normalized duplicate username", async () => {
    await service.register({
      username: "Alex",
      displayName: "Alex",
      password: "correct horse battery",
    });

    await expect(
      service.register({
        username: " ALEX ",
        displayName: "Other Alex",
        password: "another horse battery",
      }),
    ).rejects.toMatchObject({ code: "USERNAME_TAKEN" });
  });
});

const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";

async function registerWithStatus(
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED",
  username = `user-${status.toLowerCase()}`,
) {
  const account = await service.register({
    username,
    displayName: username,
    password: "correct horse battery",
  });
  if (status !== "PENDING") {
    await db.updateTable("users").set({ status }).where("id", "=", account.id).execute();
  }
  return account;
}

describe("account login", () => {
  it.each([
    ["PENDING", "ACCOUNT_PENDING"],
    ["SUSPENDED", "ACCOUNT_SUSPENDED"],
    ["REVOKED", "ACCOUNT_REVOKED"],
  ] as const)("rejects a %s account with %s", async (status, code) => {
    const account = await registerWithStatus(status);

    await expect(
      service.login({
        username: account.username,
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("issues an access token and stored-hash refresh session to an active account", async () => {
    const account = await registerWithStatus("ACTIVE", "active-user");

    const session = await service.login({
      username: account.username,
      password: "correct horse battery",
      deviceId,
    });

    expect(session).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresInSeconds: 900,
      refreshExpiresInSeconds: 2_592_000,
      account: {
        id: account.id,
        status: "ACTIVE",
      },
    });
    const stored = await db
      .selectFrom("deviceSessions")
      .selectAll()
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    expect(stored.deviceId).toBe(deviceId);
    expect(stored.generation).toBe(0);
    expect(stored.refreshTokenHash).not.toBe(session.refreshToken);
    expect(stored.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses one invalid-credentials result for unknown usernames and wrong passwords", async () => {
    const account = await registerWithStatus("ACTIVE", "credential-user");

    await expect(
      service.login({
        username: "unknown-user",
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(
      service.login({
        username: account.username,
        password: "wrong horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
});

describe("refresh-token rotation", () => {
  it("rotates once and marks the predecessor as consumed", async () => {
    const account = await registerWithStatus("ACTIVE", "rotation-user");
    const initial = await service.login({
      username: account.username,
      password: "correct horse battery",
      deviceId,
    });

    const rotated = await service.refresh({ refreshToken: initial.refreshToken });

    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    expect(rotated.sessionId).not.toBe(initial.sessionId);
    const predecessor = await db
      .selectFrom("deviceSessions")
      .selectAll()
      .where("id", "=", initial.sessionId)
      .executeTakeFirstOrThrow();
    const successor = await db
      .selectFrom("deviceSessions")
      .selectAll()
      .where("id", "=", rotated.sessionId)
      .executeTakeFirstOrThrow();
    expect(predecessor.usedAt).toEqual(now);
    expect(predecessor.replacedBySessionId).toBe(successor.id);
    expect(successor.generation).toBe(1);
    expect(successor.tokenFamilyId).toBe(predecessor.tokenFamilyId);
  });

  it("revokes the complete token family when a consumed token is replayed", async () => {
    const account = await registerWithStatus("ACTIVE", "replay-user");
    const initial = await service.login({
      username: account.username,
      password: "correct horse battery",
      deviceId,
    });
    const rotated = await service.refresh({ refreshToken: initial.refreshToken });

    await expect(service.refresh({ refreshToken: initial.refreshToken })).rejects.toMatchObject({
      code: "SESSION_REPLAYED",
    });
    const rows = await db
      .selectFrom("deviceSessions")
      .select(["revokedAt"])
      .where(
        "tokenFamilyId",
        "=",
        (
          await db
            .selectFrom("deviceSessions")
            .select("tokenFamilyId")
            .where("id", "=", initial.sessionId)
            .executeTakeFirstOrThrow()
        ).tokenFamilyId,
      )
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt?.getTime() === now.getTime())).toBe(true);
    await expect(service.refresh({ refreshToken: rotated.refreshToken })).rejects.toMatchObject({
      code: "SESSION_INVALID",
    });
  });
});

describe("session revocation and access principals", () => {
  it("logs out by revoking the presented refresh-token family", async () => {
    const account = await registerWithStatus("ACTIVE", "logout-user");
    const initial = await service.login({
      username: account.username,
      password: "correct horse battery",
      deviceId,
    });
    const rotated = await service.refresh({ refreshToken: initial.refreshToken });

    await service.logout({ refreshToken: rotated.refreshToken });

    const rows = await db
      .selectFrom("deviceSessions")
      .select("revokedAt")
      .where("userId", "=", account.id)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt?.getTime() === now.getTime())).toBe(true);
    await expect(service.refresh({ refreshToken: rotated.refreshToken })).rejects.toMatchObject({
      code: "SESSION_INVALID",
    });
  });

  it("checks current account and device-session state for every access principal", async () => {
    const account = await registerWithStatus("ACTIVE", "principal-user");
    const session = await service.login({
      username: account.username,
      password: "correct horse battery",
      deviceId,
    });

    await expect(service.authenticateAccessToken(session.accessToken)).resolves.toMatchObject({
      userId: account.id,
      deviceId,
      sessionId: session.sessionId,
    });

    await db
      .updateTable("users")
      .set({ status: "SUSPENDED" })
      .where("id", "=", account.id)
      .execute();
    await expect(service.authenticateAccessToken(session.accessToken)).rejects.toMatchObject({
      code: "ACCOUNT_SUSPENDED",
    });

    await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", account.id).execute();
    await db
      .updateTable("deviceSessions")
      .set({ revokedAt: now })
      .where("id", "=", session.sessionId)
      .execute();
    await expect(service.authenticateAccessToken(session.accessToken)).rejects.toMatchObject({
      code: "SESSION_INVALID",
    });
  });
});
