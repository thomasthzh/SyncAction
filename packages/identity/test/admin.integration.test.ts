import { createDatabase, migrateToLatest } from "@syncaction/database";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminService } from "../src/admin-service.js";
import { hashOpaqueToken } from "../src/tokens.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-26T00:00:00.000Z");
const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const totpEncryptionKey = new Uint8Array(32).fill(11);
const onboardingPassword = "temporary administrator password";
let db: ReturnType<typeof createDatabase>;
let service: AdminService;

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function currentTotp(): string {
  return totpAt(totpSecret, now);
}

function totpAt(secret: string, timestamp: Date): string {
  return new OTPAuth.TOTP({
    secret,
    digits: 6,
    period: 30,
  }).generate({ timestamp: timestamp.getTime() });
}

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  service = new AdminService({
    db,
    totpEncryptionKey,
    now: () => now,
  });
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

async function bootstrap() {
  return service.bootstrap({
    username: "SyncAdmin",
    password: "administrator horse battery",
    totpSecret,
  });
}

async function bootstrapOnboarding(administrators = service) {
  return administrators.bootstrap({
    username: "admin",
    password: onboardingPassword,
    totpSecret,
    passwordChangeRequired: true,
    totpEnrollmentRequired: true,
  });
}

describe("administrator bootstrap", () => {
  it("creates exactly one encrypted, Argon2id-protected administrator", async () => {
    const administrator = await bootstrap();
    const repeated = await bootstrap();

    expect(repeated).toEqual(administrator);
    const stored = await db
      .selectFrom("administrators")
      .selectAll()
      .where("id", "=", administrator.id)
      .executeTakeFirstOrThrow();
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/u);
    expect(stored.totpSecretCiphertext).not.toContain(totpSecret);
    expect(await db.selectFrom("administrators").select("id").execute()).toHaveLength(1);
  });

  it("refuses to bootstrap a different second administrator", async () => {
    await bootstrap();

    await expect(
      service.bootstrap({
        username: "OtherAdmin",
        password: "administrator horse battery",
        totpSecret,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ACCOUNT_TRANSITION" });
  });

  it("requires explicit bootstrap before startup without creating an administrator", async () => {
    await expect(service.requireExistingAdministrator()).rejects.toThrow(
      "ADMIN_BOOTSTRAP_REQUIRED",
    );
    expect(await db.selectFrom("administrators").select("id").execute()).toHaveLength(0);

    const existing = await service.bootstrap({
      username: "ExistingOperator",
      password: "administrator horse battery",
      totpSecret,
    });

    await expect(service.requireExistingAdministrator()).resolves.toBeUndefined();

    const stored = await db
      .selectFrom("administrators")
      .select(["id", "username", "passwordChangeRequired", "totpEnrollmentRequired"])
      .execute();
    expect(stored).toEqual([
      {
        id: existing.id,
        username: "ExistingOperator",
        passwordChangeRequired: false,
        totpEnrollmentRequired: false,
      },
    ]);
  });

  it("rejects a weak bootstrap password even when immediate replacement is required", async () => {
    await expect(
      service.bootstrap({
        username: "admin",
        password: "123456",
        totpSecret,
        passwordChangeRequired: true,
        totpEnrollmentRequired: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("provisions production without password replacement while retaining TOTP enrollment", async () => {
    const administrator = await service.bootstrap({
      username: "admin",
      password: "production administrator password",
      totpSecret,
      passwordChangeRequired: false,
      totpEnrollmentRequired: true,
    });

    expect(administrator).toMatchObject({
      username: "admin",
      passwordChangeRequired: false,
      totpEnrollmentRequired: true,
    });
    await expect(
      db
        .selectFrom("administrators")
        .select(["passwordChangeRequired", "totpEnrollmentRequired"])
        .where("id", "=", administrator.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      passwordChangeRequired: false,
      totpEnrollmentRequired: true,
    });
  });
});

describe("administrator login", () => {
  it.each([undefined, null, "x", "invalid administrator name"])(
    "returns the uniform authentication failure for malformed username %j",
    async (username) => {
      await bootstrap();

      await expect(
        service.login({
          username,
          password: "administrator horse battery",
          totp: currentTotp(),
        }),
      ).rejects.toMatchObject({ code: "ADMIN_INVALID_CREDENTIALS" });
    },
  );

  it("requires password and a fresh TOTP, then stores only a session hash", async () => {
    const administrator = await bootstrap();

    await expect(
      service.login({
        username: administrator.username,
        password: "wrong administrator password",
        totp: currentTotp(),
      }),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_CREDENTIALS" });
    await expect(
      service.login({
        username: administrator.username,
        password: "administrator horse battery",
        totp: "000000",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_CREDENTIALS" });

    const session = await service.login({
      username: administrator.username,
      password: "administrator horse battery",
      totp: currentTotp(),
    });

    expect(session.expiresInSeconds).toBe(28_800);
    const stored = await db
      .selectFrom("adminSessions")
      .selectAll()
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    expect(stored.administratorId).toBe(administrator.id);
    expect(stored.sessionTokenHash).toBe(hashOpaqueToken(session.sessionToken));
    expect(stored.sessionTokenHash).not.toBe(session.sessionToken);
    await expect(
      service.login({
        username: administrator.username,
        password: "administrator horse battery",
        totp: currentTotp(),
      }),
    ).rejects.toMatchObject({ code: "ADMIN_TOTP_REPLAYED" });
  });

  it("returns the linked user from the locked administrator row", async () => {
    const administrator = await bootstrap();
    const linkedUserId = "018f8f8e-4b5c-7d6e-8f90-123456789abc";
    await db
      .insertInto("users")
      .values({
        id: linkedUserId,
        username: "linked-login-user",
        usernameNormalized: "linked-login-user",
        displayName: "Linked Login User",
        passwordHash: "not-used",
        status: "ACTIVE",
      })
      .execute();
    const initialReadFinished = createDeferred();
    const releaseAdministratorLock = createDeferred();
    const linkedUpdateReady = createDeferred();
    const loginService = new AdminService({
      db: db.withPlugin({
        transformQuery(args) {
          return args.node;
        },
        async transformResult(args) {
          initialReadFinished.resolve();
          return args.result;
        },
      }),
      totpEncryptionKey,
      now: () => now,
    });
    const holdingTransaction = db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("administrators")
        .select("id")
        .where("id", "=", administrator.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("administrators")
        .set({ linkedUserId })
        .where("id", "=", administrator.id)
        .execute();
      linkedUpdateReady.resolve();
      await releaseAdministratorLock.promise;
    });
    await linkedUpdateReady.promise;

    const login = loginService.login({
      username: administrator.username,
      password: "administrator horse battery",
      totp: currentTotp(),
    });
    await initialReadFinished.promise;
    releaseAdministratorLock.resolve();
    await holdingTransaction;

    await expect(login).resolves.toMatchObject({
      administrator: { id: administrator.id, linkedUserId },
    });
  });

  it("verifies and revokes an administrator session", async () => {
    const administrator = await bootstrap();
    const session = await service.login({
      username: administrator.username,
      password: "administrator horse battery",
      totp: currentTotp(),
    });

    await expect(service.authenticateSession(session.sessionToken)).resolves.toEqual({
      administratorId: administrator.id,
      username: administrator.username,
      linkedUserId: null,
      sessionId: session.sessionId,
      passwordChangeRequired: false,
      totpEnrollmentRequired: false,
    });
    await service.logout(session.sessionToken);
    await expect(service.authenticateSession(session.sessionToken)).rejects.toMatchObject({
      code: "ADMIN_SESSION_INVALID",
    });
  });
});

describe("administrator onboarding", () => {
  it("issues a restricted ten-minute session for an explicitly bootstrapped administrator", async () => {
    const administrator = await bootstrapOnboarding();

    const session = await service.login({
      username: "admin",
      password: onboardingPassword,
    });

    expect(session).toMatchObject({
      expiresInSeconds: 600,
      administrator: {
        id: administrator.id,
        username: "admin",
        passwordChangeRequired: true,
        totpEnrollmentRequired: true,
      },
      onboarding: {
        passwordChangeRequired: true,
        totpEnrollmentRequired: true,
      },
    });
    const principal = await service.authenticateSession(session.sessionToken);
    expect(principal).toMatchObject({
      administratorId: administrator.id,
      passwordChangeRequired: true,
      totpEnrollmentRequired: true,
    });
    const stored = await db
      .selectFrom("adminSessions")
      .selectAll()
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    expect(stored.expiresAt).toEqual(new Date(now.getTime() + 600_000));
    expect(stored.sessionTokenHash).toBe(hashOpaqueToken(session.sessionToken));
  });

  it("exposes enrollment only to a restricted administrator", async () => {
    await bootstrapOnboarding();
    const session = await service.login({
      username: "admin",
      password: onboardingPassword,
    });
    const principal = await service.authenticateSession(session.sessionToken);

    const enrollment = await service.getTotpEnrollment(principal);

    expect(OTPAuth.Secret.fromBase32(enrollment.secret).buffer.byteLength).toBe(20);
    expect(enrollment.otpauthUri).toContain("otpauth://totp/");
    expect(enrollment.otpauthUri).toContain("issuer=SyncAction");
    expect(enrollment.otpauthUri).not.toContain("v1.");
  });

  it("atomically replaces the temporary password, enrolls TOTP, and revokes other sessions", async () => {
    let clock = now;
    const onboardingService = new AdminService({
      db,
      totpEncryptionKey,
      now: () => clock,
    });
    const administrator = await bootstrapOnboarding(onboardingService);
    const current = await onboardingService.login({
      username: "admin",
      password: onboardingPassword,
    });
    const other = await onboardingService.login({
      username: "admin",
      password: onboardingPassword,
    });
    const principal = await onboardingService.authenticateSession(current.sessionToken);
    const enrollment = await onboardingService.getTotpEnrollment(principal);

    await expect(
      onboardingService.completeOnboarding(principal, {
        newPassword: "short",
        totp: "000000",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      onboardingService.completeOnboarding(principal, {
        newPassword: "replacement administrator password",
        totp: "000000",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_CREDENTIALS" });

    const completed = await onboardingService.completeOnboarding(principal, {
      newPassword: "replacement administrator password",
      totp: totpAt(enrollment.secret, clock),
    });

    expect(completed).toMatchObject({
      administratorId: administrator.id,
      passwordChangeRequired: false,
      totpEnrollmentRequired: false,
      sessionId: current.sessionId,
    });
    const rows = await db
      .selectFrom("adminSessions")
      .select(["id", "expiresAt", "revokedAt"])
      .where("administratorId", "=", administrator.id)
      .orderBy("id")
      .execute();
    expect(rows.find((row) => row.id === current.sessionId)).toMatchObject({
      expiresAt: new Date(now.getTime() + 28_800_000),
      revokedAt: null,
    });
    expect(rows.find((row) => row.id === other.sessionId)?.revokedAt).toEqual(now);
    const storedAdministrator = await db
      .selectFrom("administrators")
      .select(["passwordChangeRequired", "totpEnrollmentRequired"])
      .where("id", "=", administrator.id)
      .executeTakeFirstOrThrow();
    expect(storedAdministrator).toEqual({
      passwordChangeRequired: false,
      totpEnrollmentRequired: false,
    });
    const audit = await db
      .selectFrom("auditEvents")
      .select(["eventType", "details"])
      .where("actorAdministratorId", "=", administrator.id)
      .where("eventType", "=", "administrator.onboarding_completed")
      .executeTakeFirstOrThrow();
    expect(audit.eventType).toBe("administrator.onboarding_completed");
    expect(JSON.stringify(audit.details)).not.toContain(enrollment.secret);
    expect(JSON.stringify(audit.details)).not.toContain("replacement administrator password");

    await expect(
      onboardingService.login({
        username: "admin",
        password: "replacement administrator password",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_CREDENTIALS" });
    clock = new Date(now.getTime() + 30_000);
    await expect(
      onboardingService.login({
        username: "admin",
        password: "replacement administrator password",
        totp: totpAt(enrollment.secret, clock),
      }),
    ).resolves.toMatchObject({
      expiresInSeconds: 28_800,
      onboarding: {
        passwordChangeRequired: false,
        totpEnrollmentRequired: false,
      },
    });
  });

  it("enrolls production TOTP without replacing its configured password", async () => {
    const administrator = await service.bootstrap({
      username: "admin",
      password: "production administrator password",
      totpSecret,
      passwordChangeRequired: false,
      totpEnrollmentRequired: true,
    });
    const before = await db
      .selectFrom("administrators")
      .select("passwordHash")
      .where("id", "=", administrator.id)
      .executeTakeFirstOrThrow();
    const session = await service.login({
      username: "admin",
      password: "production administrator password",
    });
    const principal = await service.authenticateSession(session.sessionToken);
    const enrollment = await service.getTotpEnrollment(principal);

    await service.completeOnboarding(principal, {
      totp: totpAt(enrollment.secret, now),
    });

    const after = await db
      .selectFrom("administrators")
      .select(["passwordHash", "passwordChangeRequired", "totpEnrollmentRequired"])
      .where("id", "=", administrator.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({
      passwordHash: before.passwordHash,
      passwordChangeRequired: false,
      totpEnrollmentRequired: false,
    });
  });
});
