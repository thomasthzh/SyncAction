import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AccountService, AdminService, createAccessTokenCodec } from "@syncaction/identity";
import { buildPublicApp } from "@syncaction/server/app";
import { RoomService } from "@syncaction/rooms";
import { RoomSequencer } from "@syncaction/sync";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SyncActionApiClient } from "../src/api-client.js";
import {
  ExtensionSessionManager,
  type ExtensionSessionStorageArea,
} from "../src/product-session.js";
import { DEFAULT_SERVER_PROFILE_ID } from "../src/server-profile.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const publicOrigin = "https://syncaction.example.com";
const ownerDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const memberDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
let nowMs = Date.parse("2026-07-27T00:00:00.000Z");
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let administrators: AdminService;
let app: Awaited<ReturnType<typeof buildPublicApp>>;
let api: SyncActionApiClient;
let administratorId: string;

class MemoryArea implements ExtensionSessionStorageArea {
  public readonly values: Record<string, unknown> = {};

  public async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items));
  }

  public async remove(key: string): Promise<void> {
    delete this.values[key];
  }
}

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  const now = () => new Date(nowMs);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(37),
      now,
    }),
    now,
  });
  administrators = new AdminService({
    db,
    totpEncryptionKey: new Uint8Array(32).fill(41),
    now,
  });
  const rooms = new RoomService({ db, now });
  app = await buildPublicApp({
    db,
    accounts,
    rooms,
    sequencer: new RoomSequencer({ db, now }),
    annotationHmacKey: new Uint8Array(32).fill(23),
    authRateLimitMax: 100,
    logger: false,
  });
  api = new SyncActionApiClient({
    serverUrl: publicOrigin,
    fetch: createInjectFetch(app),
  });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

beforeEach(async () => {
  nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  administratorId = (
    await administrators.bootstrap({
      username: "SyncAdmin",
      password: "administrator horse battery",
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    })
  ).id;
});

async function approve(username: string): Promise<void> {
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("usernameNormalized", "=", username.toLowerCase())
    .executeTakeFirstOrThrow();
  await administrators.approveUser({
    administratorId,
    userId: user.id,
  });
}

function sessions(area: MemoryArea): ExtensionSessionManager {
  return new ExtensionSessionManager({
    area,
    now: () => nowMs,
    rotate: ({ refreshToken }) => api.refresh(refreshToken),
  });
}

describe("extension product flow over the public HTTP boundary", () => {
  it("enforces approval, shares a room by invitation, and rotates the member session", async () => {
    const pendingOwner = await api.register({
      username: "route-owner",
      displayName: "Route Owner",
      password: "correct horse battery",
    });
    expect(pendingOwner.status).toBe("PENDING");
    await expect(
      api.login({
        username: "route-owner",
        password: "correct horse battery",
        deviceId: ownerDeviceId,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_PENDING", status: 403 });
    await approve("route-owner");

    const ownerArea = new MemoryArea();
    const ownerSessions = sessions(ownerArea);
    await ownerSessions.establish({
      profileId: DEFAULT_SERVER_PROFILE_ID,
      serverUrl: publicOrigin,
      serverId: null,
      deviceId: ownerDeviceId,
      response: await api.login({
        username: "route-owner",
        password: "correct horse battery",
        deviceId: ownerDeviceId,
      }),
    });
    const created = await ownerSessions.runAuthenticated(DEFAULT_SERVER_PROFILE_ID, (accessToken) =>
      api.createRoom(accessToken, "产品研究"),
    );

    await api.register({
      username: "route-member",
      displayName: "Route Member",
      password: "correct horse battery",
    });
    await approve("route-member");
    const memberArea = new MemoryArea();
    const memberSessions = sessions(memberArea);
    await memberSessions.establish({
      profileId: DEFAULT_SERVER_PROFILE_ID,
      serverUrl: publicOrigin,
      serverId: null,
      deviceId: memberDeviceId,
      response: await api.login({
        username: "route-member",
        password: "correct horse battery",
        deviceId: memberDeviceId,
      }),
    });

    await ownerSessions.runAuthenticated(DEFAULT_SERVER_PROFILE_ID, (accessToken) =>
      api.invite(accessToken, created.id, "route-member"),
    );
    const received = await memberSessions.runAuthenticated(
      DEFAULT_SERVER_PROFILE_ID,
      (accessToken) => api.listInvitations(accessToken),
    );
    expect(received).toMatchObject([
      {
        roomId: created.id,
        roomName: "产品研究",
        invitedByUsername: "route-owner",
      },
    ]);
    await memberSessions.runAuthenticated(DEFAULT_SERVER_PROFILE_ID, (accessToken) =>
      api.acceptInvitation(accessToken, received[0]!.id),
    );

    await expect(
      memberSessions.runAuthenticated(DEFAULT_SERVER_PROFILE_ID, (accessToken) =>
        api.listRooms(accessToken),
      ),
    ).resolves.toMatchObject([{ id: created.id, role: "MEMBER" }]);
    await expect(
      ownerSessions.runAuthenticated(DEFAULT_SERVER_PROFILE_ID, (accessToken) =>
        api.getRoom(accessToken, created.id),
      ),
    ).resolves.toMatchObject({
      role: "OWNER",
      members: [
        { username: "route-owner", role: "OWNER" },
        { username: "route-member", role: "MEMBER" },
      ],
    });

    const predecessor = await memberSessions.read(DEFAULT_SERVER_PROFILE_ID);
    nowMs += 14 * 60 * 1_000 + 30_000;
    const successorAccessToken = await memberSessions.getAccessToken(DEFAULT_SERVER_PROFILE_ID);
    const successor = await memberSessions.read(DEFAULT_SERVER_PROFILE_ID);

    expect(successorAccessToken).not.toBe(predecessor?.accessToken);
    expect(successor?.refreshToken).not.toBe(predecessor?.refreshToken);
    expect(successor?.account.id).toBe(predecessor?.account.id);
  });
});

function createInjectFetch(
  fastify: Awaited<ReturnType<typeof buildPublicApp>>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const inputUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const url = new URL(inputUrl);
    if (url.origin !== publicOrigin) {
      throw new Error("unexpected test origin");
    }
    const response = await fastify.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
      url: `${url.pathname}${url.search}`,
      headers: normalizeHeaders(init?.headers),
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
    }
    return new Response(response.statusCode === 204 ? null : response.body, {
      status: response.statusCode,
      headers,
    });
  };
}

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  new Headers(input).forEach((value, key) => {
    output[key] = value;
  });
  return output;
}
