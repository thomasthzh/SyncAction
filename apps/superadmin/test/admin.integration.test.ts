import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import {
  AccountActivationService,
  AccountService,
  AdminService,
  createAccessTokenCodec,
} from "@syncaction/identity";
import { RoomService } from "@syncaction/rooms";
import type { FastifyInstance } from "fastify";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAdminApp } from "../src/app.js";
import type { AdminCookieConfig } from "../src/config.js";
import { AdminReadService } from "../src/read-service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-26T00:00:00.000Z");
const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const secondDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const thirdDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
const cookie: AdminCookieConfig = {
  name: "syncaction_admin_session",
  httpOnly: true,
  sameSite: "strict",
  path: "/",
  maxAgeSeconds: 28_800,
  secure: false,
};
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let administrators: AdminService;
let rooms: RoomService;
let app: FastifyInstance;

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(7),
      now: () => now,
    }),
    now: () => now,
  });
  administrators = new AdminService({
    db,
    totpEncryptionKey: new Uint8Array(32).fill(11),
    now: () => now,
  });
  rooms = new RoomService({ db, now: () => now });
  app = await buildAdminApp({
    db,
    administrators,
    rooms,
    cookie,
    publicOrigin: "http://127.0.0.1:29374",
    now: () => now,
    authRateLimitMax: 100,
    logger: false,
  });
});

afterAll(async () => {
  await db.deleteFrom("accountActivationGrants").execute();
  await app.close();
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("accountActivationGrants").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await administrators.bootstrap({
    username: "SyncAdmin",
    password: "administrator horse battery",
    totpSecret,
  });
});

function currentTotp(): string {
  return new OTPAuth.TOTP({
    secret: totpSecret,
    digits: 6,
    period: 30,
  }).generate({ timestamp: now.getTime() });
}

describe("administrator account activation grants", () => {
  it("creates a one-time key, lists only its mapping, and revokes it", async () => {
    const { cookieHeader } = await loginAdmin();
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/account-activation-grants",
      headers: mutationHeaders(cookieHeader),
      payload: { note: "Alice / design team" },
    });
    expect(created.statusCode).toBe(201);
    const result = created.json<{
      activationKey: string;
      grant: { id: string; note: string; keyTail: string; status: string };
    }>();
    expect(result).toMatchObject({
      activationKey: expect.stringMatching(/^sak_[A-Za-z0-9_-]{43}$/u),
      grant: { note: "Alice / design team", status: "ACTIVE" },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/account-activation-grants",
      headers: { cookie: cookieHeader },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      grants: [
        expect.objectContaining({
          id: result.grant.id,
          note: "Alice / design team",
          keyTail: result.activationKey.slice(-8),
          status: "ACTIVE",
          account: null,
        }),
      ],
    });
    expect(listed.body).not.toContain(result.activationKey);
    expect(listed.body).not.toMatch(/[a-f0-9]{64}/u);

    const activation = new AccountActivationService({ db, accounts, now: () => now });
    const claimedSession = await activation.loginWithKey({
      activationKey: result.activationKey,
      deviceId,
    });
    const claimed = await app.inject({
      method: "GET",
      url: "/v1/admin/account-activation-grants",
      headers: { cookie: cookieHeader },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toEqual({
      grants: [
        expect.objectContaining({
          id: result.grant.id,
          status: "CLAIMED",
          account: expect.objectContaining({ id: claimedSession.account.id }),
        }),
      ],
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/admin/account-activation-grants/${result.grant.id}/revoke`,
      headers: mutationHeaders(cookieHeader),
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ id: result.grant.id, status: "REVOKED" });
    expect(revoked.body).not.toContain(result.activationKey);
  });

  it("requires authentication and a distinguishing note", async () => {
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/v1/admin/account-activation-grants",
      headers: mutationHeaders(),
      payload: { note: "Recipient" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const { cookieHeader } = await loginAdmin();
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/admin/account-activation-grants",
      headers: mutationHeaders(cookieHeader),
      payload: { note: "   " },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "INVALID_INPUT" });
  });
});

function mutationHeaders(cookieHeader?: string): Record<string, string> {
  const headers = {
    origin: "http://127.0.0.1:29374",
    "content-type": "application/json",
  };
  return cookieHeader === undefined ? headers : { ...headers, cookie: cookieHeader };
}

async function loginAdmin() {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    headers: mutationHeaders(),
    payload: {
      username: "SyncAdmin",
      password: "administrator horse battery",
      totp: currentTotp(),
    },
  });
  const setCookie = response.headers["set-cookie"];
  if (typeof setCookie !== "string") {
    throw new Error("Administrator login did not set a cookie");
  }
  return {
    response,
    cookieHeader: setCookie.split(";")[0] ?? "",
  };
}

async function createPendingUser(username: string) {
  return accounts.register({
    username,
    displayName: username,
    password: "correct horse battery",
  });
}

async function insertRoomTabs(roomId: string, count: number, closedPositions: number[] = []) {
  const closed = new Set(closedPositions);
  await db
    .insertInto("roomTabs")
    .values(
      Array.from({ length: count }, (_, position) => ({
        roomId,
        logicalTabId: randomUUID(),
        url: `https://private.example/secret-${position}`,
        title: `Private title ${position}`,
        favIconUrl: "https://private.example/favicon.ico",
        position,
        createdAtSeq: position + 1,
        updatedAtSeq: position + 1,
        closedAtSeq: closed.has(position) ? count + position + 1 : null,
      })),
    )
    .execute();
}

describe("administrator HTTP authentication", () => {
  it("requires password and TOTP, then sets a hardened opaque cookie", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: mutationHeaders(),
      payload: {
        username: "SyncAdmin",
        password: "administrator horse battery",
      },
    });
    expect(invalid.statusCode).toBe(401);

    const { response, cookieHeader } = await loginAdmin();

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(response.headers["set-cookie"]).toContain("Path=/");
    expect(response.headers["set-cookie"]).toContain("Max-Age=28800");
    const me = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: cookieHeader },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: "SyncAdmin", linkedUserId: null });
  });

  it("restricts first-login sessions to onboarding until password and TOTP setup complete", async () => {
    await db.deleteFrom("adminSessions").execute();
    await db.deleteFrom("administrators").execute();
    await administrators.bootstrap({
      username: "admin",
      password: "temporary administrator password",
      totpSecret,
      passwordChangeRequired: true,
      totpEnrollmentRequired: true,
    });

    const login = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: mutationHeaders(),
      payload: {
        username: "admin",
        password: "temporary administrator password",
      },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      expiresInSeconds: 600,
      administrator: {
        username: "admin",
        passwordChangeRequired: true,
        totpEnrollmentRequired: true,
      },
      onboarding: {
        passwordChangeRequired: true,
        totpEnrollmentRequired: true,
      },
    });
    expect(login.headers["set-cookie"]).toContain("Max-Age=600");
    const setCookie = login.headers["set-cookie"];
    if (typeof setCookie !== "string") {
      throw new Error("Onboarding login did not set a cookie");
    }
    const cookieHeader = setCookie.split(";")[0] ?? "";

    const onboarding = await app.inject({
      method: "GET",
      url: "/v1/admin/onboarding",
      headers: { cookie: cookieHeader },
    });
    expect(onboarding.statusCode).toBe(200);
    expect(onboarding.json()).toMatchObject({
      administrator: { username: "admin" },
      onboarding: {
        passwordChangeRequired: true,
        totpEnrollmentRequired: true,
      },
    });
    const enrollment = await app.inject({
      method: "GET",
      url: "/v1/admin/onboarding/totp",
      headers: { cookie: cookieHeader },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.json()).toMatchObject({
      secret: expect.any(String),
      otpauthUri: expect.stringContaining("otpauth://totp/"),
    });

    for (const url of [
      "/v1/admin/me",
      "/v1/admin/users",
      "/v1/admin/rooms",
      "/v1/admin/audit-events",
      "/v1/admin/diagnostics",
    ]) {
      const restricted = await app.inject({
        method: "GET",
        url,
        headers: { cookie: cookieHeader },
      });
      expect(restricted.statusCode, url).toBe(403);
      expect(restricted.json(), url).toMatchObject({
        code: "ADMIN_ONBOARDING_REQUIRED",
      });
    }

    const enrollmentBody = enrollment.json<{ secret: string }>();
    const totp = new OTPAuth.TOTP({
      secret: enrollmentBody.secret,
      digits: 6,
      period: 30,
    }).generate({ timestamp: now.getTime() });
    const complete = await app.inject({
      method: "POST",
      url: "/v1/admin/onboarding/complete",
      headers: mutationHeaders(cookieHeader),
      payload: {
        newPassword: "replacement administrator password",
        totp,
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      username: "admin",
      passwordChangeRequired: false,
      totpEnrollmentRequired: false,
    });
    expect(complete.headers["set-cookie"]).toContain("Max-Age=28800");
    expect(complete.headers["set-cookie"]).toContain(cookieHeader);

    const me = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: cookieHeader },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      username: "admin",
      passwordChangeRequired: false,
      totpEnrollmentRequired: false,
    });
  });

  it("clears and revokes the administrator cookie on logout", async () => {
    const { cookieHeader } = await loginAdmin();

    const logout = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: mutationHeaders(cookieHeader),
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/me",
          headers: { cookie: cookieHeader },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("administrator HTTP user binding", () => {
  it("binds the authenticated administrator to an active user and returns the current link", async () => {
    const { cookieHeader } = await loginAdmin();
    const user = await createPendingUser("linked-route-active-user");
    const administrator = await db
      .selectFrom("administrators")
      .select("id")
      .executeTakeFirstOrThrow();
    await administrators.approveUser({ administratorId: administrator.id, userId: user.id });

    const linked = await app.inject({
      method: "POST",
      url: "/v1/admin/me/linked-user",
      headers: mutationHeaders(cookieHeader),
      payload: { userId: user.id },
    });

    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toEqual({ administratorId: administrator.id, linkedUserId: user.id });
    const me = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: cookieHeader },
    });
    expect(me.json()).toMatchObject({ administratorId: administrator.id, linkedUserId: user.id });
  });

  it("rejects unauthenticated, malformed, invalid-target, and repeat binding requests", async () => {
    const user = await createPendingUser("linked-route-invalid-user");
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/v1/admin/me/linked-user",
      headers: mutationHeaders(),
      payload: { userId: user.id },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const { cookieHeader } = await loginAdmin();
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/admin/me/linked-user",
      headers: mutationHeaders(cookieHeader),
      payload: { userId: user.id, administratorId: "018f8f8e-4b5c-7d6e-8f90-123456789abc" },
    });
    expect(malformed.statusCode).toBe(400);
    const invalidTarget = await app.inject({
      method: "POST",
      url: "/v1/admin/me/linked-user",
      headers: mutationHeaders(cookieHeader),
      payload: { userId: user.id },
    });
    expect(invalidTarget.statusCode).toBe(409);

    const activeUser = await createPendingUser("linked-route-repeat-user");
    const administrator = await db
      .selectFrom("administrators")
      .select("id")
      .executeTakeFirstOrThrow();
    await administrators.approveUser({ administratorId: administrator.id, userId: activeUser.id });
    const bound = await app.inject({
      method: "POST",
      url: "/v1/admin/me/linked-user",
      headers: mutationHeaders(cookieHeader),
      payload: { userId: activeUser.id },
    });
    expect(bound.statusCode).toBe(200);
    const repeat = await app.inject({
      method: "POST",
      url: "/v1/admin/me/linked-user",
      headers: mutationHeaders(cookieHeader),
      payload: { userId: activeUser.id },
    });
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json()).toMatchObject({ code: "ADMIN_LINK_ALREADY_SET" });
  });
});

describe("administrator HTTP account controls", () => {
  it("approves, suspends, and revokes users", async () => {
    const { cookieHeader } = await loginAdmin();
    const suspendUser = await createPendingUser("suspend-route-user");
    const revokeUser = await createPendingUser("revoke-route-user");

    const approved = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${suspendUser.id}/approve`,
      headers: mutationHeaders(cookieHeader),
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "ACTIVE" });
    await accounts.login({
      username: suspendUser.username,
      password: "correct horse battery",
      deviceId,
    });
    const suspended = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${suspendUser.id}/suspend`,
      headers: mutationHeaders(cookieHeader),
      payload: {},
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({ status: "SUSPENDED" });
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${revokeUser.id}/revoke`,
      headers: mutationHeaders(cookieHeader),
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: "REVOKED" });
  });

  it("revokes one device or every user session and issues reset grants", async () => {
    const { cookieHeader } = await loginAdmin();
    const user = await createPendingUser("session-route-user");
    const administrator = await db
      .selectFrom("administrators")
      .select("id")
      .executeTakeFirstOrThrow();
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

    const oneDevice = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${user.id}/devices/${deviceId}/revoke`,
      headers: mutationHeaders(cookieHeader),
      payload: {},
    });
    expect(oneDevice.json()).toEqual({ affectedCount: 1 });
    const allSessions = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${user.id}/sessions/revoke`,
      headers: mutationHeaders(cookieHeader),
      payload: {},
    });
    expect(allSessions.json()).toEqual({ affectedCount: 1 });
    const reset = await app.inject({
      method: "POST",
      url: `/v1/admin/users/${user.id}/password-reset`,
      headers: mutationHeaders(cookieHeader),
      payload: {},
    });
    expect(reset.statusCode).toBe(201);
    expect(reset.json()).toMatchObject({
      resetToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expiresInSeconds: 3_600,
    });
  });

  it("lists redacted audits and aggregate diagnostics without public routes", async () => {
    const { cookieHeader } = await loginAdmin();
    const user = await createPendingUser("audit-route-user");
    const administrator = await db
      .selectFrom("administrators")
      .select("id")
      .executeTakeFirstOrThrow();
    await administrators.approveUser({
      administratorId: administrator.id,
      userId: user.id,
    });
    await administrators.issuePasswordReset({
      administratorId: administrator.id,
      userId: user.id,
    });

    const audit = await app.inject({
      method: "GET",
      url: "/v1/admin/audit-events?limit=50",
      headers: { cookie: cookieHeader },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json<{ events: unknown[] }>().events.length).toBeGreaterThan(0);
    expect(audit.body).not.toMatch(
      /passwordHash|refreshToken|resetToken|totpSecret|https?:|pointer/iu,
    );
    const diagnostics = await app.inject({
      method: "GET",
      url: "/v1/admin/diagnostics",
      headers: { cookie: cookieHeader },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({
      database: "ready",
      counts: {
        users: 1,
        rooms: 0,
      },
    });
    expect(
      (await app.inject({ method: "POST", url: "/v1/auth/register", payload: {} })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/rooms" })).statusCode).toBe(404);
  });
});

describe("administrator account read models", () => {
  it("filters redacted users and reports only currently usable device sessions", async () => {
    const pending = await createPendingUser("pending-read-user");
    const active = await createPendingUser("active-read-user");
    const suspended = await createPendingUser("suspended-read-user");
    const revoked = await createPendingUser("revoked-read-user");
    await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", active.id).execute();
    await db
      .updateTable("users")
      .set({ status: "SUSPENDED" })
      .where("id", "=", suspended.id)
      .execute();
    await db.updateTable("users").set({ status: "REVOKED" }).where("id", "=", revoked.id).execute();

    const firstSession = await accounts.login({
      username: active.username,
      password: "correct horse battery",
      deviceId,
    });
    await accounts.refresh({ refreshToken: firstSession.refreshToken });
    await accounts.login({
      username: active.username,
      password: "correct horse battery",
      deviceId: secondDeviceId,
    });
    await accounts.login({
      username: active.username,
      password: "correct horse battery",
      deviceId: thirdDeviceId,
    });
    await db
      .updateTable("deviceSessions")
      .set({ revokedAt: now, updatedAt: now })
      .where("userId", "=", active.id)
      .where("deviceId", "=", secondDeviceId)
      .execute();
    await db
      .updateTable("deviceSessions")
      .set({
        expiresAt: new Date(now.getTime() - 1),
        updatedAt: now,
      })
      .where("userId", "=", active.id)
      .where("deviceId", "=", thirdDeviceId)
      .execute();
    const { cookieHeader } = await loginAdmin();

    const filtered = await app.inject({
      method: "GET",
      url: "/v1/admin/users?status=PENDING&limit=20",
      headers: { cookie: cookieHeader },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({
      total: 1,
      users: [{ id: pending.id, username: pending.username, status: "PENDING" }],
    });

    const devices = await app.inject({
      method: "GET",
      url: `/v1/admin/users/${active.id}/devices`,
      headers: { cookie: cookieHeader },
    });
    expect(devices.statusCode).toBe(200);
    expect(devices.json()).toEqual({
      devices: [
        {
          deviceId,
          activeSessionCount: 1,
          lastRotatedAt: now.toISOString(),
        },
      ],
    });
    expect(`${filtered.body}${devices.body}`).not.toMatch(
      /passwordHash|refreshTokenHash|tokenFamilyId|resetToken|totp|logicalTabId|https?:/iu,
    );
    expect(filtered.headers["cache-control"]).toBe("no-store");
  });

  it("validates filters, authentication, and unknown users", async () => {
    const { cookieHeader } = await loginAdmin();

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/users?status=UNKNOWN",
          headers: { cookie: cookieHeader },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/users?limit=201",
          headers: { cookie: cookieHeader },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/admin/users" })).statusCode).toBe(401);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/admin/users/018f8f8e-4b5c-7d6e-8f90-123456789abc/devices",
      headers: { cookie: cookieHeader },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "ADMIN_READ_NOT_FOUND" });
  });
});

describe("administrator room and diagnostic read models", () => {
  it("lists exact ordinary, exempt, and deleted room aggregates without browsing data", async () => {
    const ordinaryOwner = await createPendingUser("ordinary-room-owner");
    const exemptOwner = await createPendingUser("exempt-room-owner");
    const deletedOwner = await createPendingUser("deleted-room-owner");
    const member = await createPendingUser("room-read-member");
    await db
      .updateTable("users")
      .set({ status: "ACTIVE" })
      .where("id", "in", [ordinaryOwner.id, exemptOwner.id, deletedOwner.id, member.id])
      .execute();
    const administrator = await db
      .selectFrom("administrators")
      .select("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("administrators")
      .set({ linkedUserId: exemptOwner.id })
      .where("id", "=", administrator.id)
      .execute();
    const ordinaryRoom = await rooms.createRoom({
      actorUserId: ordinaryOwner.id,
      name: "Ordinary Aggregate Room",
    });
    const exemptRoom = await rooms.createRoom({
      actorUserId: exemptOwner.id,
      name: "Exempt Aggregate Room",
    });
    const deletedRoom = await rooms.createRoom({
      actorUserId: deletedOwner.id,
      name: "Deleted Aggregate Room",
    });
    await db
      .insertInto("roomMemberships")
      .values({
        roomId: ordinaryRoom.id,
        userId: member.id,
        role: "MEMBER",
        createdAt: now,
      })
      .execute();
    await insertRoomTabs(ordinaryRoom.id, 3, [2]);
    await insertRoomTabs(exemptRoom.id, 1);
    await db.updateTable("rooms").set({ serverSeq: 7 }).where("id", "=", ordinaryRoom.id).execute();
    await rooms.administratorSoftDeleteRoom({
      administratorId: administrator.id,
      roomId: deletedRoom.id,
      reasonCode: "ADMIN_CLEANUP",
    });
    const { cookieHeader } = await loginAdmin();

    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/rooms?limit=20",
      headers: { cookie: cookieHeader },
    });
    expect(listed.statusCode).toBe(200);
    const listedRooms = listed.json<{ rooms: Array<Record<string, unknown>> }>().rooms;
    expect(listedRooms).toHaveLength(3);
    expect(listedRooms).toEqual(
      expect.arrayContaining([
        {
          roomId: ordinaryRoom.id,
          name: "Ordinary Aggregate Room",
          ownerUserId: ordinaryOwner.id,
          ownerUsername: ordinaryOwner.username,
          memberCount: 2,
          openTabCount: 2,
          roomEpoch: 0,
          serverSeq: 7,
          lifecycle: "ACTIVE",
          quotaClass: "ORDINARY",
        },
        {
          roomId: exemptRoom.id,
          name: "Exempt Aggregate Room",
          ownerUserId: exemptOwner.id,
          ownerUsername: exemptOwner.username,
          memberCount: 1,
          openTabCount: 1,
          roomEpoch: 0,
          serverSeq: 0,
          lifecycle: "ACTIVE",
          quotaClass: "EXEMPT",
        },
        {
          roomId: deletedRoom.id,
          name: "Deleted Aggregate Room",
          ownerUserId: deletedOwner.id,
          ownerUsername: deletedOwner.username,
          memberCount: 1,
          openTabCount: 0,
          roomEpoch: 1,
          serverSeq: 0,
          lifecycle: "DELETED",
          quotaClass: "ORDINARY",
        },
      ]),
    );
    expect(listedRooms.every((room) => Object.keys(room).length === 10)).toBe(true);
    expect(listed.body).not.toMatch(
      /url|title|favIconUrl|media|pointer|danmaku|anchor|points|stroke/iu,
    );

    const members = await app.inject({
      method: "GET",
      url: `/v1/admin/rooms/${ordinaryRoom.id}/members`,
      headers: { cookie: cookieHeader },
    });
    expect(members.statusCode).toBe(200);
    expect(members.json()).toMatchObject({
      members: [
        {
          userId: ordinaryOwner.id,
          username: ordinaryOwner.username,
          role: "OWNER",
          status: "ACTIVE",
        },
        {
          userId: member.id,
          username: member.username,
          role: "MEMBER",
          status: "ACTIVE",
        },
      ],
    });
    expect(members.body).not.toMatch(/logicalTabId|favIcon|roomTabs|operation|snapshot|https?:/iu);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/rooms?limit=201",
          headers: { cookie: cookieHeader },
        })
      ).statusCode,
    ).toBe(400);
    const missing = await app.inject({
      method: "GET",
      url: "/v1/admin/rooms/018f8f8e-4b5c-7d6e-8f90-123456789abc/members",
      headers: { cookie: cookieHeader },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "ADMIN_READ_NOT_FOUND" });
  });

  it("filters room aggregates by lifecycle and quota class and requires authentication", async () => {
    const ordinaryOwner = await createPendingUser("filter-ordinary-owner");
    const exemptOwner = await createPendingUser("filter-exempt-owner");
    await db
      .updateTable("users")
      .set({ status: "ACTIVE" })
      .where("id", "in", [ordinaryOwner.id, exemptOwner.id])
      .execute();
    const administrator = await db
      .selectFrom("administrators")
      .select("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("administrators")
      .set({ linkedUserId: exemptOwner.id })
      .where("id", "=", administrator.id)
      .execute();
    const ordinaryRoom = await rooms.createRoom({
      actorUserId: ordinaryOwner.id,
      name: "Filtered Ordinary",
    });
    const exemptRoom = await rooms.createRoom({
      actorUserId: exemptOwner.id,
      name: "Filtered Exempt",
    });
    await rooms.administratorSoftDeleteRoom({
      administratorId: administrator.id,
      roomId: ordinaryRoom.id,
      reasonCode: "ADMIN_CLEANUP",
    });
    const { cookieHeader } = await loginAdmin();

    const deletedOrdinary = await app.inject({
      method: "GET",
      url: "/v1/admin/rooms?lifecycle=DELETED&quotaClass=ORDINARY&limit=200",
      headers: { cookie: cookieHeader },
    });
    expect(deletedOrdinary.statusCode).toBe(200);
    expect(deletedOrdinary.json()).toEqual({
      rooms: [expect.objectContaining({ roomId: ordinaryRoom.id })],
    });
    const activeExempt = await app.inject({
      method: "GET",
      url: "/v1/admin/rooms?lifecycle=ACTIVE&quotaClass=EXEMPT",
      headers: { cookie: cookieHeader },
    });
    expect(activeExempt.statusCode).toBe(200);
    expect(activeExempt.json()).toEqual({
      rooms: [expect.objectContaining({ roomId: exemptRoom.id })],
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/rooms?lifecycle=UNKNOWN",
          headers: { cookie: cookieHeader },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/rooms?quotaClass=UNKNOWN",
          headers: { cookie: cookieHeader },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/admin/rooms" })).statusCode).toBe(401);
  });

  it("executes the room aggregate projection as one privacy-safe SQL statement", async () => {
    const owner = await createPendingUser("single-query-owner");
    await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", owner.id).execute();
    const room = await rooms.createRoom({ actorUserId: owner.id, name: "Single Query Room" });
    await insertRoomTabs(room.id, 2, [1]);
    const queryNodes: unknown[] = [];
    const reads = new AdminReadService({
      db: db.withPlugin({
        transformQuery(args) {
          queryNodes.push(args.node);
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      }),
      now: () => now,
    });

    await expect(reads.listRooms({ limit: 200 })).resolves.toMatchObject({
      rooms: [
        {
          roomId: room.id,
          memberCount: 1,
          openTabCount: 1,
          quotaClass: "ORDINARY",
        },
      ],
    });

    expect(queryNodes).toHaveLength(1);
    expect(JSON.stringify(queryNodes)).not.toMatch(/"name":"(?:url|title|favIconUrl)"/u);
  });

  it("counts account states and only currently usable device sessions", async () => {
    await createPendingUser("diagnostic-pending");
    const active = await createPendingUser("diagnostic-active");
    const suspended = await createPendingUser("diagnostic-suspended");
    const revoked = await createPendingUser("diagnostic-revoked");
    await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", active.id).execute();
    await db
      .updateTable("users")
      .set({ status: "SUSPENDED" })
      .where("id", "=", suspended.id)
      .execute();
    await db.updateTable("users").set({ status: "REVOKED" }).where("id", "=", revoked.id).execute();

    const firstSession = await accounts.login({
      username: active.username,
      password: "correct horse battery",
      deviceId,
    });
    await accounts.refresh({ refreshToken: firstSession.refreshToken });
    await accounts.login({
      username: active.username,
      password: "correct horse battery",
      deviceId: secondDeviceId,
    });
    await accounts.login({
      username: active.username,
      password: "correct horse battery",
      deviceId: thirdDeviceId,
    });
    await db
      .updateTable("deviceSessions")
      .set({ revokedAt: now, updatedAt: now })
      .where("userId", "=", active.id)
      .where("deviceId", "=", secondDeviceId)
      .execute();
    await db
      .updateTable("deviceSessions")
      .set({ expiresAt: new Date(now.getTime() - 1), updatedAt: now })
      .where("userId", "=", active.id)
      .where("deviceId", "=", thirdDeviceId)
      .execute();
    const { cookieHeader } = await loginAdmin();

    const diagnostics = await app.inject({
      method: "GET",
      url: "/v1/admin/diagnostics",
      headers: { cookie: cookieHeader },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toEqual({
      database: "ready",
      counts: {
        users: 4,
        pendingUsers: 1,
        activeUsers: 1,
        suspendedUsers: 1,
        revokedUsers: 1,
        rooms: 0,
        activeDeviceSessions: 1,
      },
    });
  });
});

describe("administrator room lifecycle controls", () => {
  it("requires cookie, same-origin JSON, and writes redacted reasoned lifecycle audits", async () => {
    const owner = await createPendingUser("lifecycle-route-owner");
    await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", owner.id).execute();
    const room = await rooms.createRoom({ actorUserId: owner.id, name: "Lifecycle Route Room" });
    const { cookieHeader } = await loginAdmin();

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${room.id}/soft-delete`,
      headers: mutationHeaders(),
      payload: { reasonCode: "ADMIN_CLEANUP" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const crossOrigin = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${room.id}/soft-delete`,
      headers: {
        cookie: cookieHeader,
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      payload: { reasonCode: "ADMIN_CLEANUP" },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const nonJson = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${room.id}/soft-delete`,
      headers: {
        cookie: cookieHeader,
        origin: "http://127.0.0.1:29374",
        "content-type": "text/plain",
      },
      payload: "{}",
    });
    expect(nonJson.statusCode).toBe(415);

    const deleted = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${room.id}/soft-delete`,
      headers: mutationHeaders(cookieHeader),
      payload: { reasonCode: "ADMIN_CLEANUP" },
    });
    expect(deleted.statusCode).toBe(204);
    const restored = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${room.id}/restore`,
      headers: mutationHeaders(cookieHeader),
      payload: { reasonCode: "ADMIN_RECOVERY" },
    });
    expect(restored.statusCode).toBe(204);

    const stored = await db
      .selectFrom("rooms")
      .select(["deletedAt", "roomEpoch"])
      .where("id", "=", room.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ deletedAt: null, roomEpoch: 2 });
    const events = await db
      .selectFrom("auditEvents")
      .select([
        "actorUserId",
        "actorAdministratorId",
        "eventType",
        "targetType",
        "targetId",
        "details",
      ])
      .where("targetId", "=", room.id)
      .orderBy("id")
      .execute();
    expect(events).toEqual([
      {
        actorUserId: null,
        actorAdministratorId: expect.any(String),
        eventType: "administrator.room_soft_deleted",
        targetType: "room",
        targetId: room.id,
        details: {
          ownerUserId: owner.id,
          previousLifecycle: "ACTIVE",
          lifecycle: "DELETED",
          reasonCode: "ADMIN_CLEANUP",
        },
      },
      {
        actorUserId: null,
        actorAdministratorId: expect.any(String),
        eventType: "administrator.room_restored",
        targetType: "room",
        targetId: room.id,
        details: {
          ownerUserId: owner.id,
          previousLifecycle: "DELETED",
          lifecycle: "ACTIVE",
          reasonCode: "ADMIN_RECOVERY",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /https?:|url|title|favIcon|media|pointer|danmaku|anchor|points|stroke/iu,
    );
  });

  it("returns quota conflicts as 409 without partial transfer or restore mutations", async () => {
    const exemptOwner = await createPendingUser("quota-exempt-owner");
    const targetOwner = await createPendingUser("quota-target-owner");
    const ordinaryOwner = await createPendingUser("quota-ordinary-owner");
    await db
      .updateTable("users")
      .set({ status: "ACTIVE" })
      .where("id", "in", [exemptOwner.id, targetOwner.id, ordinaryOwner.id])
      .execute();
    const administrator = await db
      .selectFrom("administrators")
      .select("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("administrators")
      .set({ linkedUserId: exemptOwner.id })
      .where("id", "=", administrator.id)
      .execute();
    const exemptRoom = await rooms.createRoom({
      actorUserId: exemptOwner.id,
      name: "Over Capacity Exempt",
    });
    await db
      .insertInto("roomMemberships")
      .values({
        roomId: exemptRoom.id,
        userId: targetOwner.id,
        role: "MEMBER",
        createdAt: now,
      })
      .execute();
    await insertRoomTabs(exemptRoom.id, 21);
    const ordinaryRoom = await rooms.createRoom({
      actorUserId: ordinaryOwner.id,
      name: "Over Capacity Deleted",
    });
    await insertRoomTabs(ordinaryRoom.id, 21);
    const { cookieHeader } = await loginAdmin();

    const transfer = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${exemptRoom.id}/ownership-transfer`,
      headers: mutationHeaders(cookieHeader),
      payload: {
        newOwnerUserId: targetOwner.id,
        reasonCode: "OWNER_RECOVERY",
      },
    });
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json()).toMatchObject({ code: "ROOM_TAB_LIMIT_REACHED" });
    const transferRoom = await db
      .selectFrom("rooms")
      .select("ownerUserId")
      .where("id", "=", exemptRoom.id)
      .executeTakeFirstOrThrow();
    expect(transferRoom.ownerUserId).toBe(exemptOwner.id);
    const transferMemberships = await db
      .selectFrom("roomMemberships")
      .select(["userId", "role"])
      .where("roomId", "=", exemptRoom.id)
      .orderBy("userId")
      .execute();
    expect(transferMemberships).toHaveLength(2);
    expect(transferMemberships).toEqual(
      expect.arrayContaining([
        { userId: exemptOwner.id, role: "OWNER" },
        { userId: targetOwner.id, role: "MEMBER" },
      ]),
    );

    const deleted = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${ordinaryRoom.id}/soft-delete`,
      headers: mutationHeaders(cookieHeader),
      payload: { reasonCode: "ADMIN_CLEANUP" },
    });
    expect(deleted.statusCode).toBe(204);
    const restore = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${ordinaryRoom.id}/restore`,
      headers: mutationHeaders(cookieHeader),
      payload: { reasonCode: "ADMIN_RECOVERY" },
    });
    expect(restore.statusCode).toBe(409);
    expect(restore.json()).toMatchObject({ code: "ROOM_TAB_LIMIT_REACHED" });
    const restoreRoom = await db
      .selectFrom("rooms")
      .select(["deletedAt", "roomEpoch"])
      .where("id", "=", ordinaryRoom.id)
      .executeTakeFirstOrThrow();
    expect(restoreRoom).toEqual({ deletedAt: now, roomEpoch: 1 });
  });
});

describe("administrator room ownership recovery", () => {
  it("transfers an unavailable owner's room to an active accepted member and audits only IDs", async () => {
    const owner = await createPendingUser("room-owner");
    const member = await createPendingUser("room-member");
    const outsider = await createPendingUser("room-outsider");
    await db
      .updateTable("users")
      .set({ status: "ACTIVE" })
      .where("id", "in", [owner.id, member.id, outsider.id])
      .execute();
    const room = await rooms.createRoom({ actorUserId: owner.id, name: "Recovery Room" });
    await db
      .insertInto("roomMemberships")
      .values({ roomId: room.id, userId: member.id, role: "MEMBER", createdAt: now })
      .execute();
    await db.updateTable("users").set({ status: "SUSPENDED" }).where("id", "=", owner.id).execute();
    const { cookieHeader } = await loginAdmin();

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${room.id}/ownership-transfer`,
      headers: mutationHeaders(),
      payload: { newOwnerUserId: member.id },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const invalidTarget = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${room.id}/ownership-transfer`,
      headers: mutationHeaders(cookieHeader),
      payload: { newOwnerUserId: outsider.id, reasonCode: "OWNER_RECOVERY" },
    });
    expect(invalidTarget.statusCode).toBe(409);
    const transferred = await app.inject({
      method: "POST",
      url: `/v1/admin/rooms/${room.id}/ownership-transfer`,
      headers: mutationHeaders(cookieHeader),
      payload: { newOwnerUserId: member.id, reasonCode: "OWNER_RECOVERY" },
    });

    expect(transferred.statusCode).toBe(200);
    expect(transferred.json()).toMatchObject({ id: room.id, role: "OWNER" });
    const storedRoom = await db
      .selectFrom("rooms")
      .select("ownerUserId")
      .where("id", "=", room.id)
      .executeTakeFirstOrThrow();
    expect(storedRoom.ownerUserId).toBe(member.id);
    const audit = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("eventType", "=", "ADMIN_ROOM_OWNERSHIP_TRANSFERRED")
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actorUserId: null,
      targetType: "room",
      targetId: room.id,
      details: {
        previousOwnerUserId: owner.id,
        newOwnerUserId: member.id,
        reasonCode: "OWNER_RECOVERY",
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/https?:|tab|cursor|pointer/iu);
  });
});
