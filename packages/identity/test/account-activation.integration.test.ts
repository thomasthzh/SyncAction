import { createDatabase, migrateToLatest } from "@syncaction/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountActivationService } from "../src/account-activation-service.js";
import { AccountService } from "../src/account-service.js";
import { verifyPassword } from "../src/passwords.js";
import { createAccessTokenCodec } from "../src/tokens.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-08-31T00:00:00.000Z");
const administratorId = "018f8f8e-4b5c-7d6e-8f90-123456789aa1";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789aa2";
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let activation: AccountActivationService;

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(11),
      now: () => now,
    }),
    now: () => now,
  });
  activation = new AccountActivationService({ db, accounts, now: () => now });
});

afterAll(async () => {
  await db.deleteFrom("accountActivationGrants").execute();
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("accountActivationGrants").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("deviceSessions").execute();
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await db
    .insertInto("administrators")
    .values({
      id: administratorId,
      username: "GrantAdmin",
      usernameNormalized: "grantadmin",
      passwordHash: "hash",
      totpSecretCiphertext: "ciphertext",
      linkedUserId: null,
    })
    .execute();
});

describe("account activation grants", () => {
  it("returns the full key once and lists only redacted identifying data", async () => {
    const issued = await activation.issue({ administratorId, note: "  Alice / design team  " });

    expect(issued.activationKey).toMatch(/^sak_[A-Za-z0-9_-]{43}$/u);
    expect(issued.grant).toMatchObject({
      note: "Alice / design team",
      keyTail: issued.activationKey.slice(-8),
      status: "ACTIVE",
      account: null,
      createdAt: now,
      usedAt: null,
    });
    expect(issued.grant).not.toHaveProperty("tokenHash");
    expect(issued.grant).not.toHaveProperty("activationKey");

    const stored = await db
      .selectFrom("accountActivationGrants")
      .selectAll()
      .where("id", "=", issued.grant.id)
      .executeTakeFirstOrThrow();
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.tokenHash).not.toContain(issued.activationKey);
    expect(stored.expiresAt).toEqual(new Date("2026-09-07T00:00:00.000Z"));

    const listed = await activation.list();
    expect(listed).toEqual([issued.grant]);
    expect(JSON.stringify(listed)).not.toContain(issued.activationKey);
    expect(JSON.stringify(listed)).not.toContain(stored.tokenHash);

    const audit = await db
      .selectFrom("auditEvents")
      .select(["eventType", "details"])
      .where("targetId", "=", issued.grant.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      eventType: "account_activation_grant.issued",
      details: { note: "Alice / design team", keyTail: issued.grant.keyTail },
    });
    expect(JSON.stringify(audit)).not.toContain(issued.activationKey);
    expect(JSON.stringify(audit)).not.toContain(stored.tokenHash);
  });

  it("requires a useful note and revokes an active key", async () => {
    await expect(activation.issue({ administratorId, note: "   " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const issued = await activation.issue({ administratorId, note: "Bob / contractor" });

    const revoked = await activation.revoke({
      administratorId,
      grantId: issued.grant.id,
    });
    expect(revoked.status).toBe("REVOKED");
    await expect(
      activation.activate({
        activationKey: issued.activationKey,
        username: "bob-user",
        displayName: "Bob",
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_KEY_REVOKED" });
    await expect(
      activation.revoke({ administratorId, grantId: issued.grant.id }),
    ).rejects.toMatchObject({ code: "ACTIVATION_GRANT_NOT_ACTIVE" });
  });

  it("creates an active account and durable session while consuming the key", async () => {
    const issued = await activation.issue({ administratorId, note: "Carol / product" });
    const session = await activation.activate({
      activationKey: issued.activationKey,
      username: "Carol.User",
      displayName: "Carol 张",
      password: "correct horse battery",
      deviceId,
    });

    expect(session).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      refreshExpiresInSeconds: 2_592_000,
      account: {
        username: "Carol.User",
        displayName: "Carol 张",
        status: "ACTIVE",
      },
    });
    const listed = await activation.list();
    expect(listed[0]).toMatchObject({
      status: "USED",
      usedAt: now,
      account: {
        id: session.account.id,
        username: "Carol.User",
        displayName: "Carol 张",
      },
    });
    await expect(
      activation.activate({
        activationKey: issued.activationKey,
        username: "carol-second",
        displayName: "Carol second",
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_KEY_USED" });
    await expect(accounts.refresh({ refreshToken: session.refreshToken })).resolves.toMatchObject({
      account: { id: session.account.id },
    });
  });

  it("creates one temporary account and reopens it with only the account key", async () => {
    const issued = await activation.issue({ administratorId, note: "Key-only recipient" });
    const first = await activation.loginWithKey({
      activationKey: issued.activationKey,
      deviceId,
    });
    const second = await activation.loginWithKey({
      activationKey: issued.activationKey,
      deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789aa3",
    });

    expect(first.account).toMatchObject({
      id: second.account.id,
      username: expect.stringMatching(/^s[0-9a-z]{25}$/u),
      displayName: "未命名用户",
      status: "ACTIVE",
      passwordResetRequired: true,
    });
    expect(await activation.list()).toEqual([
      expect.objectContaining({
        id: issued.grant.id,
        status: "CLAIMED",
        account: expect.objectContaining({ id: first.account.id }),
      }),
    ]);
    await expect(db.selectFrom("users").select("id").execute()).resolves.toHaveLength(1);
  });

  it("serializes concurrent first account-key logins onto one account", async () => {
    const issued = await activation.issue({ administratorId, note: "Concurrent key login" });
    const sessions = await Promise.all([
      activation.loginWithKey({ activationKey: issued.activationKey, deviceId }),
      activation.loginWithKey({
        activationKey: issued.activationKey,
        deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789aa4",
      }),
    ]);

    expect(new Set(sessions.map((session) => session.account.id)).size).toBe(1);
    await expect(db.selectFrom("users").select("id").execute()).resolves.toHaveLength(1);
  });

  it("revokes a claimed key without revoking the established account session", async () => {
    const issued = await activation.issue({ administratorId, note: "Revoked claimed key" });
    const session = await activation.loginWithKey({
      activationKey: issued.activationKey,
      deviceId,
    });

    await expect(
      activation.revoke({ administratorId, grantId: issued.grant.id }),
    ).resolves.toMatchObject({ status: "REVOKED", account: { id: session.account.id } });
    await expect(
      activation.loginWithKey({ activationKey: issued.activationKey, deviceId }),
    ).rejects.toMatchObject({ code: "ACTIVATION_KEY_REVOKED" });
    await expect(accounts.refresh({ refreshToken: session.refreshToken })).resolves.toMatchObject({
      account: { id: session.account.id },
    });
  });

  it("expires a claimed key while preserving its established account session", async () => {
    const issued = await activation.issue({ administratorId, note: "Expired claimed key" });
    const session = await activation.loginWithKey({
      activationKey: issued.activationKey,
      deviceId,
    });
    const afterExpiry = new Date("2026-09-07T00:00:00.001Z");
    const expiredActivation = new AccountActivationService({
      db,
      accounts,
      now: () => afterExpiry,
    });

    await expect(expiredActivation.list()).resolves.toEqual([
      expect.objectContaining({ id: issued.grant.id, status: "EXPIRED" }),
    ]);
    await expect(
      expiredActivation.loginWithKey({ activationKey: issued.activationKey, deviceId }),
    ).rejects.toMatchObject({ code: "ACTIVATION_KEY_EXPIRED" });
    await expect(accounts.refresh({ refreshToken: session.refreshToken })).resolves.toMatchObject({
      account: { id: session.account.id },
    });
  });

  it("allows only one winner when the same key is redeemed concurrently", async () => {
    const issued = await activation.issue({ administratorId, note: "Concurrent recipient" });
    const results = await Promise.allSettled([
      activation.activate({
        activationKey: issued.activationKey,
        username: "concurrent-one",
        displayName: "Concurrent One",
        password: "correct horse battery",
        deviceId,
      }),
      activation.activate({
        activationKey: issued.activationKey,
        username: "concurrent-two",
        displayName: "Concurrent Two",
        password: "correct horse battery",
        deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789aa3",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "ACTIVATION_KEY_USED" } });
  });

  it("projects expired grants and rejects redemption after the seven-day boundary", async () => {
    const issued = await activation.issue({ administratorId, note: "Expired recipient" });
    const afterExpiry = new Date("2026-09-07T00:00:00.001Z");
    const expiredActivation = new AccountActivationService({
      db,
      accounts,
      now: () => afterExpiry,
    });

    await expect(expiredActivation.list()).resolves.toEqual([
      expect.objectContaining({ id: issued.grant.id, status: "EXPIRED" }),
    ]);
    await expect(
      expiredActivation.activate({
        activationKey: issued.activationKey,
        username: "expired-user",
        displayName: "Expired User",
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code: "ACTIVATION_KEY_EXPIRED" });
  });

  it("keeps the grant active when session establishment fails", async () => {
    const issued = await activation.issue({ administratorId, note: "Retryable recipient" });
    const failingAccounts = new AccountService({
      db,
      accessTokens: {
        sign: async () => {
          throw new Error("synthetic signing failure");
        },
        verify: async () => {
          throw new Error("not used");
        },
      },
      now: () => now,
    });
    const failingActivation = new AccountActivationService({
      db,
      accounts: failingAccounts,
      now: () => now,
    });

    await expect(
      failingActivation.activate({
        activationKey: issued.activationKey,
        username: "retryable-user",
        displayName: "Retryable User",
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toThrow("synthetic signing failure");
    await expect(activation.list()).resolves.toEqual([
      expect.objectContaining({ id: issued.grant.id, status: "ACTIVE", account: null }),
    ]);
    await expect(
      db
        .selectFrom("users")
        .select("id")
        .where("usernameNormalized", "=", "retryable-user")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });
});

describe("account self-service", () => {
  it("initializes the first password without a current password and retires the key", async () => {
    const issued = await activation.issue({ administratorId, note: "First password" });
    const current = await activation.loginWithKey({
      activationKey: issued.activationKey,
      deviceId,
    });
    const other = await activation.loginWithKey({
      activationKey: issued.activationKey,
      deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789aa5",
    });

    await expect(
      accounts.initializePassword({
        userId: current.account.id,
        sessionId: current.sessionId,
        newPassword: "too short",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await accounts.initializePassword({
      userId: current.account.id,
      sessionId: current.sessionId,
      newPassword: "correct horse battery",
    });

    await expect(activation.list()).resolves.toEqual([
      expect.objectContaining({ id: issued.grant.id, status: "USED" }),
    ]);
    await expect(
      activation.loginWithKey({ activationKey: issued.activationKey, deviceId }),
    ).rejects.toMatchObject({ code: "ACTIVATION_KEY_USED" });
    await expect(
      accounts.login({
        username: current.account.username,
        password: "correct horse battery",
        deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789aa6",
      }),
    ).resolves.toMatchObject({
      account: { id: current.account.id, passwordResetRequired: false },
    });
    await expect(accounts.refresh({ refreshToken: current.refreshToken })).resolves.toMatchObject({
      account: { id: current.account.id },
    });
    await expect(accounts.refresh({ refreshToken: other.refreshToken })).rejects.toMatchObject({
      code: "SESSION_INVALID",
    });
    await expect(
      accounts.initializePassword({
        userId: current.account.id,
        sessionId: current.sessionId,
        newPassword: "another correct battery",
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_ALREADY_CONFIGURED" });
  });

  it("updates the login and display names with normalized uniqueness", async () => {
    const first = await activation.issue({ administratorId, note: "First" });
    const session = await activation.activate({
      activationKey: first.activationKey,
      username: "profile-user",
      displayName: "Before",
      password: "correct horse battery",
      deviceId,
    });
    const second = await activation.issue({ administratorId, note: "Second" });
    await activation.activate({
      activationKey: second.activationKey,
      username: "taken-user",
      displayName: "Taken",
      password: "correct horse battery",
      deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789aa4",
    });

    await expect(
      accounts.updateProfile({
        userId: session.account.id,
        username: " TAKEN-USER ",
        displayName: "Collision",
      }),
    ).rejects.toMatchObject({ code: "USERNAME_TAKEN" });
    await expect(
      accounts.updateProfile({
        userId: session.account.id,
        username: "profile.renamed",
        displayName: "  After   Name  ",
      }),
    ).resolves.toMatchObject({
      id: session.account.id,
      username: "profile.renamed",
      displayName: "After Name",
    });
  });

  it("changes the password, preserves the current family, and revokes other devices", async () => {
    const issued = await activation.issue({ administratorId, note: "Password owner" });
    const current = await activation.activate({
      activationKey: issued.activationKey,
      username: "password-user",
      displayName: "Password User",
      password: "correct horse battery",
      deviceId,
    });
    const other = await accounts.login({
      username: "password-user",
      password: "correct horse battery",
      deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789aa5",
    });

    await expect(
      accounts.changePassword({
        userId: current.account.id,
        sessionId: current.sessionId,
        currentPassword: "incorrect horse battery",
        newPassword: "better correct horse battery",
      }),
    ).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });
    await accounts.changePassword({
      userId: current.account.id,
      sessionId: current.sessionId,
      currentPassword: "correct horse battery",
      newPassword: "better correct horse battery",
    });

    const stored = await db
      .selectFrom("users")
      .select("passwordHash")
      .where("id", "=", current.account.id)
      .executeTakeFirstOrThrow();
    await expect(verifyPassword(stored.passwordHash, "better correct horse battery")).resolves.toBe(
      true,
    );
    await expect(accounts.refresh({ refreshToken: current.refreshToken })).resolves.toMatchObject({
      account: { id: current.account.id },
    });
    await expect(accounts.refresh({ refreshToken: other.refreshToken })).rejects.toMatchObject({
      code: "SESSION_INVALID",
    });
  });

  it("serializes password change against old-password login and refresh", async () => {
    const issued = await activation.issue({ administratorId, note: "Concurrent password owner" });
    const current = await activation.activate({
      activationKey: issued.activationKey,
      username: "concurrent-password-user",
      displayName: "Concurrent Password User",
      password: "correct horse battery",
      deviceId,
    });
    const otherDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789aa6";
    const other = await accounts.login({
      username: "concurrent-password-user",
      password: "correct horse battery",
      deviceId: otherDeviceId,
    });

    const [passwordResult, loginResult, refreshResult] = await Promise.allSettled([
      accounts.changePassword({
        userId: current.account.id,
        sessionId: current.sessionId,
        currentPassword: "correct horse battery",
        newPassword: "serialized replacement battery",
      }),
      accounts.login({
        username: "concurrent-password-user",
        password: "correct horse battery",
        deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789aa7",
      }),
      accounts.refresh({ refreshToken: other.refreshToken }),
    ]);

    expect(passwordResult.status).toBe("fulfilled");
    if (loginResult.status === "fulfilled") {
      await expect(
        accounts.refresh({ refreshToken: loginResult.value.refreshToken }),
      ).rejects.toMatchObject({ code: "SESSION_INVALID" });
    } else {
      expect(loginResult.reason).toMatchObject({ code: "INVALID_CREDENTIALS" });
    }
    if (refreshResult.status === "fulfilled") {
      await expect(
        accounts.refresh({ refreshToken: refreshResult.value.refreshToken }),
      ).rejects.toMatchObject({ code: "SESSION_INVALID" });
    } else {
      expect(refreshResult.reason).toMatchObject({ code: "SESSION_INVALID" });
    }
    await expect(
      accounts.login({
        username: "concurrent-password-user",
        password: "serialized replacement battery",
        deviceId: otherDeviceId,
      }),
    ).resolves.toMatchObject({ account: { id: current.account.id } });
  });
});
