import { createDatabase, migrateToLatest } from "@syncaction/database";
import {
  AccountActivationService,
  AccountService,
  AdminService,
  createAccessTokenCodec,
} from "@syncaction/identity";
import { NotificationService, RoomProductEventBus, RoomService } from "@syncaction/rooms";
import { RoomSequencer } from "@syncaction/sync";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildPublicApp } from "../src/app.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-26T00:00:00.000Z");
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const annotationHmacKey = new Uint8Array(32).fill(23);
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let activation: AccountActivationService;
let administrators: AdminService;
let rooms: RoomService;
let notifications: NotificationService;
let productEvents: RoomProductEventBus;
let sequencer: RoomSequencer;
let administratorId: string;
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
  activation = new AccountActivationService({ db, accounts, now: () => now });
  productEvents = new RoomProductEventBus();
  notifications = new NotificationService({
    db,
    events: productEvents,
    now: () => now,
  });
  rooms = new RoomService({
    db,
    events: productEvents,
    notifications,
    now: () => now,
  });
  sequencer = new RoomSequencer({ db, now: () => now });
  app = await buildPublicApp({
    db,
    accounts,
    activation,
    rooms,
    notifications,
    productEvents,
    sequencer,
    annotationHmacKey,
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
  await db.deleteFrom("notifications").execute();
  await db.deleteFrom("policyAcceptances").execute();
  await db.deleteFrom("roomJoinRequests").execute();
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("accountActivationGrants").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await db
    .updateTable("serverPolicies")
    .set({ ordinaryActiveRoomLimit: 5, ordinaryOpenTabLimit: 20 })
    .where("id", "=", "GLOBAL")
    .execute();
  administratorId = (
    await administrators.bootstrap({
      username: "SyncAdmin",
      password: "administrator horse battery",
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    })
  ).id;
});

async function register(username: string) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      username,
      displayName: username,
      password: "correct horse battery",
    },
  });
}

async function approveByUsername(username: string) {
  const user = await db
    .selectFrom("users")
    .select(["id"])
    .where("usernameNormalized", "=", username.toLowerCase())
    .executeTakeFirstOrThrow();
  await administrators.approveUser({
    administratorId,
    userId: user.id,
  });
  return user;
}

async function login(username: string, password = "correct horse battery") {
  return app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { username, password, deviceId },
  });
}

async function createActiveSession(
  username: string,
): Promise<{ userId: string; accessToken: string }> {
  await register(username);
  const user = await approveByUsername(username);
  const response = await login(username);
  return {
    userId: user.id,
    accessToken: response.json<{ accessToken: string }>().accessToken,
  };
}

describe("public identity routes", () => {
  it("activates an account once and supports authenticated profile and password changes", async () => {
    const issued = await activation.issue({ administratorId, note: "HTTP recipient" });
    const activated = await app.inject({
      method: "POST",
      url: "/v1/auth/activation/complete",
      payload: {
        activationKey: issued.activationKey,
        username: "activated-user",
        displayName: "Activated User",
        password: "correct horse battery",
        deviceId,
      },
    });
    expect(activated.statusCode).toBe(200);
    const session = activated.json<{
      accessToken: string;
      refreshToken: string;
      account: { id: string; username: string; displayName: string; status: string };
    }>();
    expect(session).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      account: { username: "activated-user", status: "ACTIVE" },
    });
    expect(activated.body).not.toContain("passwordHash");
    expect(activated.body).not.toContain(issued.activationKey);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/activation/complete",
      payload: {
        activationKey: issued.activationKey,
        username: "activated-replay",
        displayName: "Replay",
        password: "correct horse battery",
        deviceId,
      },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "ACTIVATION_KEY_USED" });
    expect(replay.body).not.toContain(issued.activationKey);

    const profile = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { username: "activated.renamed", displayName: "Renamed User" },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      id: session.account.id,
      username: "activated.renamed",
      displayName: "Renamed User",
    });

    const changed = await app.inject({
      method: "POST",
      url: "/v1/me/password",
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: {
        currentPassword: "correct horse battery",
        newPassword: "replacement horse battery",
      },
    });
    expect(changed.statusCode).toBe(204);
    expect((await login("activated.renamed", "replacement horse battery")).statusCode).toBe(200);
  });

  it("logs in with only an account key and initializes the first password", async () => {
    const issued = await activation.issue({ administratorId, note: "Key login HTTP recipient" });
    const keyLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/key-login",
      payload: { activationKey: issued.activationKey, deviceId },
    });
    expect(keyLogin.statusCode).toBe(200);
    const session = keyLogin.json<{
      sessionId: string;
      accessToken: string;
      refreshToken: string;
      account: { id: string; username: string; passwordResetRequired: boolean };
    }>();
    expect(session).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      account: {
        username: expect.stringMatching(/^s[0-9a-z]{25}$/u),
        passwordResetRequired: true,
      },
    });
    expect(keyLogin.body).not.toContain(issued.activationKey);

    const strict = await app.inject({
      method: "POST",
      url: "/v1/auth/key-login",
      payload: { activationKey: issued.activationKey, deviceId, username: "not-accepted" },
    });
    expect(strict.statusCode).toBe(400);
    expect(strict.json()).toMatchObject({ code: "INVALID_INPUT" });

    const initialized = await app.inject({
      method: "POST",
      url: "/v1/me/password/initialize",
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { newPassword: "correct horse battery" },
    });
    expect(initialized.statusCode).toBe(204);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/key-login",
      payload: { activationKey: issued.activationKey, deviceId },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "ACTIVATION_KEY_USED" });
    expect((await login(session.account.username)).statusCode).toBe(200);
  });

  it("rejects invalid activation and unauthenticated account mutations with stable codes", async () => {
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/auth/activation/complete",
      payload: {
        activationKey: `sak_${"A".repeat(43)}`,
        username: "invalid-key-user",
        displayName: "Invalid Key",
        password: "correct horse battery",
        deviceId,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "ACTIVATION_KEY_INVALID" });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/v1/me/profile",
          payload: { username: "unauthorized", displayName: "Unauthorized" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("registers pending, then logs in only after administrator approval", async () => {
    const registration = await register("Alex");

    expect(registration.statusCode).toBe(202);
    expect(registration.json()).toMatchObject({
      account: {
        username: "Alex",
        status: "PENDING",
      },
    });
    expect(registration.body).not.toContain("passwordHash");
    const pendingLogin = await login("Alex");
    expect(pendingLogin.statusCode).toBe(403);
    expect(pendingLogin.json()).toMatchObject({ code: "ACCOUNT_PENDING" });

    await approveByUsername("Alex");
    const activeLogin = await login("Alex");
    expect(activeLogin.statusCode).toBe(200);
    expect(activeLogin.json()).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresInSeconds: 900,
      account: { status: "ACTIVE" },
    });
  });

  it("rotates, authenticates, and logs out a public session", async () => {
    await register("session-user");
    await approveByUsername("session-user");
    const signedIn = (await login("session-user")).json<{
      accessToken: string;
      refreshToken: string;
    }>();

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${signedIn.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ deviceId, account: { username: "session-user" } });

    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: signedIn.refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    const rotated = refresh.json<{ refreshToken: string }>();
    expect(rotated.refreshToken).not.toBe(signedIn.refreshToken);

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(logout.statusCode).toBe(204);
    const rejectedRefresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(rejectedRefresh.statusCode).toBe(401);
    expect(rejectedRefresh.json()).toMatchObject({ code: "SESSION_INVALID" });
  });

  it("completes a one-time administrator-issued password reset", async () => {
    await register("reset-user");
    const user = await approveByUsername("reset-user");
    const grant = await administrators.issuePasswordReset({
      administratorId,
      userId: user.id,
    });

    const completion = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/complete",
      payload: {
        resetToken: grant.resetToken,
        newPassword: "replacement horse battery",
      },
    });
    expect(completion.statusCode).toBe(204);
    expect((await login("reset-user", "replacement horse battery")).statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/password-reset/complete",
      payload: {
        resetToken: grant.resetToken,
        newPassword: "another replacement battery",
      },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ code: "RESET_GRANT_INVALID" });
  });

  it("maps malformed payloads to a stable input error and exposes no admin routes", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {},
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      code: "INVALID_INPUT",
      requestId: expect.any(String),
    });
    expect((await app.inject({ method: "GET", url: "/v1/admin/users" })).statusCode).toBe(404);
  });

  it("rate limits authentication attempts", async () => {
    const account = await createActiveSession("password-rate-user");
    const limited = await buildPublicApp({
      db,
      accounts,
      rooms,
      sequencer,
      annotationHmacKey,
      authRateLimitMax: 1,
      logger: false,
    });
    try {
      expect(
        (
          await limited.inject({
            method: "POST",
            url: "/v1/auth/login",
            payload: {
              username: "unknown-user",
              password: "correct horse battery",
              deviceId,
            },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await limited.inject({
            method: "POST",
            url: "/v1/auth/login",
            payload: {
              username: "unknown-user",
              password: "correct horse battery",
              deviceId,
            },
          })
        ).statusCode,
      ).toBe(429);
      const firstPasswordAttempt = await limited.inject({
        method: "POST",
        url: "/v1/me/password",
        headers: { authorization: `Bearer ${account.accessToken}` },
        payload: {
          currentPassword: "incorrect horse battery",
          newPassword: "replacement horse battery",
        },
      });
      expect(firstPasswordAttempt.statusCode).not.toBe(429);
      expect(
        (
          await limited.inject({
            method: "POST",
            url: "/v1/me/password",
            headers: { authorization: `Bearer ${account.accessToken}` },
            payload: {
              currentPassword: "incorrect horse battery",
              newPassword: "replacement horse battery",
            },
          })
        ).statusCode,
      ).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("reports liveness and database readiness independently", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({
      status: "ok",
    });
    expect((await app.inject({ method: "GET", url: "/readyz" })).json()).toEqual({
      status: "ready",
    });
  });

  it("reports not-ready when PostgreSQL is unavailable", async () => {
    const unavailableApp = await buildPublicApp({
      db,
      accounts,
      rooms,
      sequencer,
      annotationHmacKey,
      logger: false,
      readinessCheck: () => Promise.reject(new Error("database unavailable")),
    });
    try {
      const response = await unavailableApp.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not-ready" });
    } finally {
      await unavailableApp.close();
    }
  });
});

describe("v0.9 product HTTP contracts", () => {
  it("serves anonymous metadata and privacy-safe public rooms, then records current policy acceptance", async () => {
    const meta = await app.inject({ method: "GET", url: "/v1/meta" });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({
      displayName: "SyncAction",
      softwareVersion: "0.9.9",
      protocolVersion: "1",
      minimumClientVersion: "0.8.1",
      termsVersion: "2026-07-30",
      capabilities: [
        "public-rooms",
        "join-requests",
        "notifications",
        "volatile-pointer-v2",
        "content-compatibility-v1",
        "account-activation-v1",
        "account-key-login-v1",
      ],
      limits: { ordinaryActiveRooms: 5, ordinaryOpenTabs: 20 },
    });
    expect(meta.json<{ capabilities: string[] }>().capabilities).toContain(
      "content-compatibility-v1",
    );

    const owner = await createActiveSession("public-meta-owner");
    const created = await app.inject({
      method: "POST",
      url: "/v1/rooms",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        name: "Public metadata room",
        visibility: "PUBLIC",
        joinPolicy: "APPROVAL",
      },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json<{ id: string }>();
    expect(created.json()).toMatchObject({
      visibility: "PUBLIC",
      joinPolicy: "APPROVAL",
      roomRevision: 0,
    });
    await db
      .insertInto("roomTabs")
      .values({
        roomId: room.id,
        logicalTabId: "018f8f8e-4b5c-7d6e-8f90-123456789d01",
        url: "https://private.example/watch",
        title: "Private media title",
        favIconUrl: null,
        position: 0,
        createdAtSeq: 1,
        updatedAtSeq: 1,
        closedAtSeq: null,
      })
      .execute();

    const publicRooms = await app.inject({
      method: "GET",
      url: "/v1/public-rooms?query=metadata&limit=20",
    });
    expect(publicRooms.statusCode).toBe(200);
    expect(publicRooms.json()).toEqual({
      items: [
        expect.objectContaining({
          roomId: room.id,
          joinPolicy: "APPROVAL",
          memberCount: 1,
          openTabCount: 1,
        }),
      ],
      nextCursor: null,
    });
    expect(publicRooms.body).not.toContain("public-meta-owner");
    expect(publicRooms.body).not.toContain("https://");
    expect(publicRooms.body).not.toContain("Private media title");

    const currentBefore = await app.inject({
      method: "GET",
      url: "/v1/policy-acceptances/current",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(currentBefore.statusCode).toBe(200);
    expect(currentBefore.json()).toEqual({ termsVersion: "2026-07-30", accepted: false });

    const stale = await app.inject({
      method: "POST",
      url: "/v1/policy-acceptances",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { termsVersion: "stale", clientVersion: "0.9.0", accepted: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "POLICY_VERSION_MISMATCH" });

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/policy-acceptances",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        termsVersion: "2026-07-30",
        clientVersion: "0.9.0",
        accepted: true,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ termsVersion: "2026-07-30", accepted: true });
    const currentAfter = await app.inject({
      method: "GET",
      url: "/v1/policy-acceptances/current",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(currentAfter.json()).toEqual({ termsVersion: "2026-07-30", accepted: true });
  });

  it("maps directory, join, decision, cancellation, batch, and notification services exactly", async () => {
    const owner = await createActiveSession("product-route-owner");
    const applicant = await createActiveSession("product-route-applicant");
    const candidate = await createActiveSession("product-route-candidate");
    const invitee = await createActiveSession("product-route-invitee");
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}` };
    const applicantHeaders = { authorization: `Bearer ${applicant.accessToken}` };
    const candidateHeaders = { authorization: `Bearer ${candidate.accessToken}` };

    const approvalRoomResponse = await app.inject({
      method: "POST",
      url: "/v1/rooms",
      headers: ownerHeaders,
      payload: {
        name: "Approval HTTP room",
        visibility: "PUBLIC",
        joinPolicy: "APPROVAL",
      },
    });
    expect(approvalRoomResponse.statusCode).toBe(201);
    const approvalRoom = approvalRoomResponse.json<{ id: string }>();

    const directory = await app.inject({
      method: "GET",
      url: `/v1/directory/users?roomId=${approvalRoom.id}&query=product-route&limit=20`,
      headers: ownerHeaders,
    });
    expect(directory.statusCode).toBe(200);
    expect(
      directory.json<{ items: Array<{ userId: string }> }>().items.map((user) => user.userId),
    ).toEqual(expect.arrayContaining([applicant.userId, candidate.userId, invitee.userId]));

    const requested = await app.inject({
      method: "POST",
      url: `/v1/rooms/${approvalRoom.id}/join-requests`,
      headers: applicantHeaders,
    });
    expect(requested.statusCode).toBe(201);
    const request = requested.json<{ requestId: string }>();
    expect(requested.json()).toMatchObject({ status: "PENDING" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/rooms/${approvalRoom.id}/join-requests`,
          headers: applicantHeaders,
        })
      ).statusCode,
    ).toBe(409);

    const ownerInbox = await app.inject({
      method: "GET",
      url: "/v1/notifications?after=0&limit=20",
      headers: ownerHeaders,
    });
    expect(ownerInbox.statusCode).toBe(200);
    expect(ownerInbox.json()).toMatchObject({
      items: [
        expect.objectContaining({
          type: "ROOM_JOIN_REQUEST_CREATED",
          requestId: request.requestId,
        }),
      ],
      unreadCount: 1,
    });

    const malformedDecision = await app.inject({
      method: "POST",
      url: `/v1/room-join-requests/${request.requestId}/decision`,
      headers: ownerHeaders,
      payload: {
        decision: "APPROVE",
        clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789d02",
        unexpected: true,
      },
    });
    expect(malformedDecision.statusCode).toBe(400);

    const decided = await app.inject({
      method: "POST",
      url: `/v1/room-join-requests/${request.requestId}/decision`,
      headers: ownerHeaders,
      payload: {
        decision: "APPROVE",
        clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789d02",
      },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ requestId: request.requestId, status: "APPROVED" });

    const applicantInbox = await app.inject({
      method: "GET",
      url: "/v1/notifications?after=0&limit=20",
      headers: applicantHeaders,
    });
    const applicantNotification = applicantInbox.json<{
      items: Array<{ notificationId: string; cursor: number }>;
    }>().items[0]!;
    expect(applicantInbox.json()).toMatchObject({
      items: [expect.objectContaining({ type: "ROOM_JOIN_REQUEST_APPROVED", readAt: null })],
    });
    const read = await app.inject({
      method: "POST",
      url: `/v1/notifications/${applicantNotification.notificationId}/read`,
      headers: applicantHeaders,
      payload: {},
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ readAt: now.toISOString() });

    const candidateRequest = await app.inject({
      method: "POST",
      url: `/v1/rooms/${approvalRoom.id}/join-requests`,
      headers: candidateHeaders,
    });
    const candidateRequestId = candidateRequest.json<{ requestId: string }>().requestId;
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/v1/room-join-requests/${candidateRequestId}`,
      headers: candidateHeaders,
    });
    expect(cancelled.statusCode).toBe(204);

    const batch = await app.inject({
      method: "POST",
      url: `/v1/rooms/${approvalRoom.id}/invitations/batch`,
      headers: ownerHeaders,
      payload: { userIds: [invitee.userId] },
    });
    expect(batch.statusCode).toBe(201);
    expect(batch.json()).toEqual([
      { userId: invitee.userId, status: "CREATED", invitationId: expect.any(String) },
    ]);

    const ownerInboxAfter = await app.inject({
      method: "GET",
      url: "/v1/notifications?after=0&limit=20",
      headers: ownerHeaders,
    });
    const ownerItems = ownerInboxAfter.json<{ items: Array<{ cursor: number }> }>().items;
    const throughCursor = Math.max(...ownerItems.map((item) => item.cursor));
    const readAll = await app.inject({
      method: "POST",
      url: "/v1/notifications/read-all",
      headers: ownerHeaders,
      payload: { throughCursor },
    });
    expect(readAll.statusCode).toBe(200);
    expect(readAll.json()).toEqual({ readAt: now.toISOString(), throughCursor });

    const openRoom = (
      await app.inject({
        method: "POST",
        url: "/v1/rooms",
        headers: ownerHeaders,
        payload: { name: "Open HTTP room", visibility: "PUBLIC", joinPolicy: "OPEN" },
      })
    ).json<{ id: string }>();
    const openJoin = await app.inject({
      method: "POST",
      url: `/v1/rooms/${openRoom.id}/join`,
      headers: candidateHeaders,
    });
    expect(openJoin.statusCode).toBe(200);
    expect(openJoin.json()).toMatchObject({ id: openRoom.id, role: "MEMBER" });

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/rooms/${approvalRoom.id}`,
      headers: ownerHeaders,
      payload: {
        name: "Approval HTTP renamed",
        visibility: "PRIVATE",
        joinPolicy: "INVITE_ONLY",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: "Approval HTTP renamed",
      visibility: "PRIVATE",
      joinPolicy: "INVITE_ONLY",
      roomRevision: 3,
    });
  });

  it("authenticates every product route except public discovery and metadata", async () => {
    for (const request of [
      { method: "GET" as const, url: "/v1/directory/users?roomId=x&limit=20" },
      { method: "GET" as const, url: "/v1/notifications?after=0&limit=20" },
      { method: "GET" as const, url: "/v1/policy-acceptances/current" },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "GET", url: "/v1/meta" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/public-rooms?limit=20" })).statusCode).toBe(
      200,
    );
  });
});

describe("public room routes", () => {
  it("authenticates room creation and uses one non-enumerating read error", async () => {
    const owner = await createActiveSession("route-owner");
    const outsider = await createActiveSession("route-outsider");
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/v1/rooms",
      payload: { name: "Denied" },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const createdResponse = await app.inject({
      method: "POST",
      url: "/v1/rooms",
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "  Shared   Product " },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<{ id: string }>();
    expect(createdResponse.json()).toMatchObject({ name: "Shared Product", role: "OWNER" });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/rooms",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(listed.json()).toMatchObject({
      rooms: [expect.objectContaining({ id: created.id, role: "OWNER" })],
    });
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/rooms/${created.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Renamed" },
    });
    expect(renamed.json()).toMatchObject({ id: created.id, name: "Renamed" });

    const unauthorized = await app.inject({
      method: "GET",
      url: `/v1/rooms/${created.id}`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    const missing = await app.inject({
      method: "GET",
      url: "/v1/rooms/018f8f8e-4b5c-7d6e-8f90-123456789c00",
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(unauthorized.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(unauthorized.json()).toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect(missing.json()).toMatchObject({ code: "ROOM_NOT_FOUND" });
  });

  it("requires invitation acceptance before member access and supports revocation", async () => {
    const owner = await createActiveSession("invite-route-owner");
    const member = await createActiveSession("invite-route-member");
    const outsider = await createActiveSession("invite-route-outsider");
    const room = (
      await app.inject({
        method: "POST",
        url: "/v1/rooms",
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Invitation Routes" },
      })
    ).json<{ id: string }>();
    const invitationResponse = await app.inject({
      method: "POST",
      url: `/v1/rooms/${room.id}/invitations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { username: " INVITE-ROUTE-MEMBER " },
    });
    expect(invitationResponse.statusCode).toBe(201);
    const invitation = invitationResponse.json<{ id: string }>();

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/rooms/${room.id}`,
          headers: { authorization: `Bearer ${member.accessToken}` },
        })
      ).statusCode,
    ).toBe(404);
    const received = await app.inject({
      method: "GET",
      url: "/v1/invitations",
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(received.json()).toMatchObject({
      invitations: [expect.objectContaining({ id: invitation.id, roomId: room.id })],
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/invitations",
          headers: { authorization: `Bearer ${outsider.accessToken}` },
        })
      ).json(),
    ).toEqual({ invitations: [] });

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/invitations/${invitation.id}/accept`,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id: room.id, role: "MEMBER" });
    const memberInvite = await app.inject({
      method: "POST",
      url: `/v1/rooms/${room.id}/invitations`,
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { username: "invite-route-outsider" },
    });
    expect(memberInvite.statusCode).toBe(403);
    expect(memberInvite.json()).toMatchObject({ code: "ROOM_OWNER_REQUIRED" });

    const revokedInvitation = (
      await app.inject({
        method: "POST",
        url: `/v1/rooms/${room.id}/invitations`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { username: "invite-route-outsider" },
      })
    ).json<{ id: string }>();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/rooms/${room.id}/invitations/${revokedInvitation.id}`,
          headers: { authorization: `Bearer ${owner.accessToken}` },
        })
      ).statusCode,
    ).toBe(204);
    const revokedAccept = await app.inject({
      method: "POST",
      url: `/v1/invitations/${revokedInvitation.id}/accept`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
    });
    expect(revokedAccept.statusCode).toBe(404);
    expect(revokedAccept.json()).toMatchObject({ code: "INVITATION_NOT_FOUND" });
  });

  it("exposes leave, removal, ownership transfer, and soft deletion", async () => {
    const owner = await createActiveSession("lifecycle-route-owner");
    const member = await createActiveSession("lifecycle-route-member");
    const room = (
      await app.inject({
        method: "POST",
        url: "/v1/rooms",
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: "Lifecycle Routes" },
      })
    ).json<{ id: string }>();

    const join = async (): Promise<void> => {
      const invitation = (
        await app.inject({
          method: "POST",
          url: `/v1/rooms/${room.id}/invitations`,
          headers: { authorization: `Bearer ${owner.accessToken}` },
          payload: { username: "lifecycle-route-member" },
        })
      ).json<{ id: string }>();
      const accepted = await app.inject({
        method: "POST",
        url: `/v1/invitations/${invitation.id}/accept`,
        headers: { authorization: `Bearer ${member.accessToken}` },
      });
      expect(accepted.statusCode).toBe(200);
    };

    await join();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/rooms/${room.id}/members/me`,
          headers: { authorization: `Bearer ${member.accessToken}` },
        })
      ).statusCode,
    ).toBe(204);
    await join();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/rooms/${room.id}/members/${member.userId}`,
          headers: { authorization: `Bearer ${owner.accessToken}` },
        })
      ).statusCode,
    ).toBe(204);
    await join();

    const transferred = await app.inject({
      method: "POST",
      url: `/v1/rooms/${room.id}/ownership-transfer`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { newOwnerUserId: member.userId },
    });
    expect(transferred.statusCode).toBe(200);
    expect(transferred.json()).toMatchObject({ role: "OWNER" });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/rooms/${room.id}`,
          headers: { authorization: `Bearer ${owner.accessToken}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/rooms/${room.id}`,
          headers: { authorization: `Bearer ${member.accessToken}` },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/rooms/${room.id}`,
          headers: { authorization: `Bearer ${member.accessToken}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/rooms/${room.id}/ownership-transfer`,
          payload: { newOwnerUserId: owner.userId },
        })
      ).statusCode,
    ).toBe(404);
  });
});
