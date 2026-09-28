import { createDatabase, migrateToLatest } from "@syncaction/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/account-service.js";
import { AdminService } from "../src/admin-service.js";
import { createAccessTokenCodec } from "../src/tokens.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-26T00:00:00.000Z");
let currentTime = now;
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let administrators: AdminService;

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(7),
      now: () => currentTime,
    }),
    now: () => currentTime,
  });
  administrators = new AdminService({
    db,
    totpEncryptionKey: new Uint8Array(32).fill(11),
    now: () => currentTime,
  });
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  currentTime = now;
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

async function createAdministrator() {
  return administrators.bootstrap({
    username: "SyncAdmin",
    password: "administrator horse battery",
    totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  });
}

async function createPendingUser(username: string) {
  return accounts.register({
    username,
    displayName: username,
    password: "correct horse battery",
  });
}

describe("administrator account transitions", () => {
  it("approves only a pending account and audits the transition", async () => {
    const administrator = await createAdministrator();
    const user = await createPendingUser("pending-user");

    const approved = await administrators.approveUser({
      administratorId: administrator.id,
      userId: user.id,
    });

    expect(approved.status).toBe("ACTIVE");
    await expect(
      administrators.approveUser({
        administratorId: administrator.id,
        userId: user.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ACCOUNT_TRANSITION" });
    const audit = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("targetId", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actorAdministratorId: administrator.id,
      actorUserId: null,
      eventType: "user.approved",
      targetType: "user",
      details: {
        previousStatus: "PENDING",
        newStatus: "ACTIVE",
      },
    });
  });

  it("suspends an active account and revokes all sessions atomically", async () => {
    const administrator = await createAdministrator();
    const user = await createPendingUser("suspend-user");
    await administrators.approveUser({
      administratorId: administrator.id,
      userId: user.id,
    });
    await accounts.login({
      username: user.username,
      password: "correct horse battery",
      deviceId,
    });

    const suspended = await administrators.suspendUser({
      administratorId: administrator.id,
      userId: user.id,
    });

    expect(suspended.status).toBe("SUSPENDED");
    const sessions = await db
      .selectFrom("deviceSessions")
      .select("revokedAt")
      .where("userId", "=", user.id)
      .execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revokedAt).toEqual(now);
  });

  it.each(["PENDING", "ACTIVE", "SUSPENDED"] as const)(
    "revokes an account from %s",
    async (status) => {
      const administrator = await createAdministrator();
      const user = await createPendingUser(`revoke-${status.toLowerCase()}`);
      if (status !== "PENDING") {
        await db.updateTable("users").set({ status }).where("id", "=", user.id).execute();
      }

      const revoked = await administrators.revokeUser({
        administratorId: administrator.id,
        userId: user.id,
      });

      expect(revoked.status).toBe("REVOKED");
      await expect(
        administrators.revokeUser({
          administratorId: administrator.id,
          userId: user.id,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ACCOUNT_TRANSITION" });
    },
  );
});

describe("administrator user binding", () => {
  it("binds an active user once and audits only the administrator and user IDs", async () => {
    const administrator = await createAdministrator();
    const user = await createPendingUser("linked-active-user");
    await administrators.approveUser({
      administratorId: administrator.id,
      userId: user.id,
    });

    await expect(
      administrators.bindLinkedUser({
        administratorId: administrator.id,
        userId: user.id,
      }),
    ).resolves.toEqual({ administratorId: administrator.id, linkedUserId: user.id });

    const stored = await db
      .selectFrom("administrators")
      .select("linkedUserId")
      .where("id", "=", administrator.id)
      .executeTakeFirstOrThrow();
    expect(stored.linkedUserId).toBe(user.id);
    const audit = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("eventType", "=", "administrator.user_linked")
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actorAdministratorId: administrator.id,
      actorUserId: null,
      eventType: "administrator.user_linked",
      targetType: "administrator",
      targetId: administrator.id,
      details: { administratorId: administrator.id, userId: user.id },
    });
    expect(audit.details).toEqual({ administratorId: administrator.id, userId: user.id });
  });

  it.each(["PENDING", "SUSPENDED", "REVOKED"] as const)(
    "rejects a %s user as a binding target",
    async (status) => {
      const administrator = await createAdministrator();
      const user = await createPendingUser(`linked-${status.toLowerCase()}-user`);
      if (status !== "PENDING") {
        await db.updateTable("users").set({ status }).where("id", "=", user.id).execute();
      }

      await expect(
        administrators.bindLinkedUser({ administratorId: administrator.id, userId: user.id }),
      ).rejects.toMatchObject({ code: "ADMIN_LINK_TARGET_INVALID" });
    },
  );

  it("rejects a missing user as a binding target", async () => {
    const administrator = await createAdministrator();

    await expect(
      administrators.bindLinkedUser({
        administratorId: administrator.id,
        userId: "018f8f8e-4b5c-7d6e-8f90-123456789abc",
      }),
    ).rejects.toMatchObject({ code: "ADMIN_LINK_TARGET_INVALID" });
  });

  it("rejects any second binding, including the same user", async () => {
    const administrator = await createAdministrator();
    const firstUser = await createPendingUser("linked-first-user");
    const secondUser = await createPendingUser("linked-second-user");
    await Promise.all(
      [firstUser, secondUser].map((user) =>
        administrators.approveUser({ administratorId: administrator.id, userId: user.id }),
      ),
    );
    await administrators.bindLinkedUser({
      administratorId: administrator.id,
      userId: firstUser.id,
    });

    for (const userId of [firstUser.id, secondUser.id]) {
      await expect(
        administrators.bindLinkedUser({ administratorId: administrator.id, userId }),
      ).rejects.toMatchObject({ code: "ADMIN_LINK_ALREADY_SET" });
    }
  });

  it("allows exactly one of two concurrent first bindings", async () => {
    const administrator = await createAdministrator();
    const firstUser = await createPendingUser("concurrent-link-first-user");
    const secondUser = await createPendingUser("concurrent-link-second-user");
    await Promise.all(
      [firstUser, secondUser].map((user) =>
        administrators.approveUser({ administratorId: administrator.id, userId: user.id }),
      ),
    );

    const results = await Promise.allSettled([
      administrators.bindLinkedUser({ administratorId: administrator.id, userId: firstUser.id }),
      administrators.bindLinkedUser({ administratorId: administrator.id, userId: secondUser.id }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "ADMIN_LINK_ALREADY_SET" }),
      }),
    ]);
  });
});

const secondDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";

async function createActiveUserWithTwoDevices(username: string) {
  const administrator = await createAdministrator();
  const user = await createPendingUser(username);
  await administrators.approveUser({
    administratorId: administrator.id,
    userId: user.id,
  });
  await accounts.login({
    username: user.username,
    password: "correct horse battery",
    deviceId,
  });
  await accounts.login({
    username: user.username,
    password: "correct horse battery",
    deviceId: secondDeviceId,
  });
  return { administrator, user };
}

describe("administrator session revocation", () => {
  it("revokes one device without affecting another device", async () => {
    const { administrator, user } = await createActiveUserWithTwoDevices("device-revoke-user");

    const affectedCount = await administrators.revokeDeviceSessions({
      administratorId: administrator.id,
      userId: user.id,
      deviceId,
    });

    expect(affectedCount).toBe(1);
    const sessions = await db
      .selectFrom("deviceSessions")
      .select(["deviceId", "revokedAt"])
      .where("userId", "=", user.id)
      .orderBy("deviceId")
      .execute();
    expect(sessions).toEqual([
      { deviceId, revokedAt: now },
      { deviceId: secondDeviceId, revokedAt: null },
    ]);
  });

  it("revokes every active device session for one user and audits the count", async () => {
    const { administrator, user } = await createActiveUserWithTwoDevices("all-revoke-user");

    const affectedCount = await administrators.revokeAllUserSessions({
      administratorId: administrator.id,
      userId: user.id,
    });

    expect(affectedCount).toBe(2);
    const sessions = await db
      .selectFrom("deviceSessions")
      .select("revokedAt")
      .where("userId", "=", user.id)
      .execute();
    expect(sessions.every((session) => session.revokedAt?.getTime() === now.getTime())).toBe(true);
    const audit = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("eventType", "=", "user.sessions.revoked")
      .where("targetId", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(audit.details).toEqual({ affectedCount: 2 });
  });
});

describe("administrator password-reset grants", () => {
  it("returns a reset token once and consumes it while revoking sessions", async () => {
    const administrator = await createAdministrator();
    const user = await createPendingUser("password-reset-user");
    await administrators.approveUser({
      administratorId: administrator.id,
      userId: user.id,
    });
    await accounts.login({
      username: user.username,
      password: "correct horse battery",
      deviceId,
    });

    const grant = await administrators.issuePasswordReset({
      administratorId: administrator.id,
      userId: user.id,
    });

    expect(grant.expiresInSeconds).toBe(3_600);
    const storedGrant = await db
      .selectFrom("passwordResetGrants")
      .selectAll()
      .where("id", "=", grant.grantId)
      .executeTakeFirstOrThrow();
    expect(storedGrant.tokenHash).not.toBe(grant.resetToken);
    expect(storedGrant.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      (await db.selectFrom("users").selectAll().where("id", "=", user.id).executeTakeFirstOrThrow())
        .passwordResetRequired,
    ).toBe(true);

    await accounts.completePasswordReset({
      resetToken: grant.resetToken,
      newPassword: "replacement horse battery",
    });

    const completedGrant = await db
      .selectFrom("passwordResetGrants")
      .selectAll()
      .where("id", "=", grant.grantId)
      .executeTakeFirstOrThrow();
    expect(completedGrant.usedAt).toEqual(now);
    const sessions = await db
      .selectFrom("deviceSessions")
      .select("revokedAt")
      .where("userId", "=", user.id)
      .execute();
    expect(sessions.every((session) => session.revokedAt?.getTime() === now.getTime())).toBe(true);
    await expect(
      accounts.login({
        username: user.username,
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(
      accounts.login({
        username: user.username,
        password: "replacement horse battery",
        deviceId,
      }),
    ).resolves.toMatchObject({ account: { id: user.id } });
    await expect(
      accounts.completePasswordReset({
        resetToken: grant.resetToken,
        newPassword: "another replacement battery",
      }),
    ).rejects.toMatchObject({ code: "RESET_GRANT_INVALID" });
  });

  it("rejects an expired reset grant without changing the password", async () => {
    const administrator = await createAdministrator();
    const user = await createPendingUser("expired-reset-user");
    await administrators.approveUser({
      administratorId: administrator.id,
      userId: user.id,
    });
    const grant = await administrators.issuePasswordReset({
      administratorId: administrator.id,
      userId: user.id,
    });
    currentTime = new Date(now.getTime() + 60 * 60 * 1_000 + 1);

    await expect(
      accounts.completePasswordReset({
        resetToken: grant.resetToken,
        newPassword: "replacement horse battery",
      }),
    ).rejects.toMatchObject({ code: "RESET_GRANT_INVALID" });
    await expect(
      accounts.login({
        username: user.username,
        password: "correct horse battery",
        deviceId,
      }),
    ).resolves.toMatchObject({ account: { id: user.id } });
  });
});
