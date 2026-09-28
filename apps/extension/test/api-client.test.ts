import { describe, expect, it, vi } from "vitest";
import { SyncActionApiClient, SyncActionApiError } from "../src/api-client.js";

const serverUrl = "https://syncaction.example.com";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const requestId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789ab7";
const notificationId = "018f8f8e-4b5c-7d6e-8f90-123456789ab8";
const invitationId = "018f8f8e-4b5c-7d6e-8f90-123456789ab9";
const timestamp = "2026-07-27T00:00:00.000Z";
const metadata = {
  serverId: "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
  displayName: "SyncAction",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sessionResponse(): Record<string, unknown> {
  return {
    sessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab2",
    accessToken: "access-token",
    refreshToken: "A".repeat(43),
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

function roomResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: roomId,
    name: "产品研究",
    role: "OWNER",
    roomEpoch: 0,
    visibility: "PUBLIC",
    joinPolicy: "APPROVAL",
    roomRevision: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function joinRequestResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId,
    roomId,
    applicant: {
      userId,
      username: "friend",
      displayName: "Friend",
    },
    status: "PENDING",
    createdAt: timestamp,
    decidedAt: null,
    ...overrides,
  };
}

function notificationResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notificationId,
    cursor: 4,
    type: "SYSTEM_UPDATE",
    actor: null,
    room: null,
    requestId: null,
    invitationId: null,
    decision: null,
    title: "SyncAction v0.9.0",
    body: "Update available",
    version: "0.9.0",
    createdAt: timestamp,
    readAt: null,
    ...overrides,
  };
}

function callShape(fetch: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = fetch.mock.calls[index]!;
  return {
    url,
    method: init?.method,
    authorization: new Headers(init?.headers).get("authorization"),
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

describe("SyncActionApiClient", () => {
  it("accepts loopback HTTP for local builds without weakening remote HTTPS", () => {
    expect(
      () =>
        new SyncActionApiClient({
          serverUrl: "http://127.0.0.1:29373",
          fetch: vi.fn<typeof globalThis.fetch>(),
        }),
    ).not.toThrow();
    expect(
      () =>
        new SyncActionApiClient({
          serverUrl: "http://192.0.2.10:29373",
          fetch: vi.fn<typeof globalThis.fetch>(),
        }),
    ).toThrow(expect.objectContaining({ code: "INVALID_SERVER_URL" }));
  });

  it("invokes browser fetch without binding the API client as its receiver", async () => {
    const fetch = function (this: unknown): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError("FETCH_RECEIVER_BOUND");
      }
      return Promise.resolve(jsonResponse(sessionResponse()));
    };
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(
      api.login({
        username: "alex",
        password: "correct horse battery",
        deviceId,
      }),
    ).resolves.toMatchObject({ accessToken: "access-token" });
  });

  it("sends a login without credentials and strictly parses the public session", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(sessionResponse()));
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(
      api.login({
        username: "alex",
        password: "correct horse battery",
        deviceId,
      }),
    ).resolves.toMatchObject({
      accessToken: "access-token",
      account: { username: "alex" },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${serverUrl}/v1/auth/login`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      username: "alex",
      password: "correct horse battery",
      deviceId,
    });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("activates an account and manages the authenticated profile without leaking credentials", async () => {
    const renamedAccount = {
      ...(sessionResponse().account as Record<string, unknown>),
      username: "alex.renamed",
      displayName: "Alex Renamed",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionResponse()))
      .mockResolvedValueOnce(jsonResponse(renamedAccount))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new SyncActionApiClient({ serverUrl, fetch });
    const activationKey = `sak_${"A".repeat(43)}`;

    await expect(
      api.activateAccount({
        activationKey,
        username: "alex",
        displayName: "Alex",
        password: "correct horse battery",
        deviceId,
      }),
    ).resolves.toMatchObject({ account: { username: "alex" } });
    await expect(
      api.updateProfile("access-token", {
        username: "alex.renamed",
        displayName: "Alex Renamed",
      }),
    ).resolves.toEqual(renamedAccount);
    await expect(
      api.changePassword("access-token", {
        currentPassword: "correct horse battery",
        newPassword: "replacement horse battery",
      }),
    ).resolves.toBeUndefined();

    expect(callShape(fetch, 0)).toEqual({
      url: `${serverUrl}/v1/auth/activation/complete`,
      method: "POST",
      authorization: null,
      body: {
        activationKey,
        username: "alex",
        displayName: "Alex",
        password: "correct horse battery",
        deviceId,
      },
    });
    expect(callShape(fetch, 1)).toEqual({
      url: `${serverUrl}/v1/me/profile`,
      method: "PATCH",
      authorization: "Bearer access-token",
      body: { username: "alex.renamed", displayName: "Alex Renamed" },
    });
    expect(callShape(fetch, 2)).toEqual({
      url: `${serverUrl}/v1/me/password`,
      method: "POST",
      authorization: "Bearer access-token",
      body: {
        currentPassword: "correct horse battery",
        newPassword: "replacement horse battery",
      },
    });
    expect(JSON.stringify(api)).not.toMatch(/correct horse|replacement horse|sak_/u);
  });

  it("logs in with only an account key and initializes the first password", async () => {
    const provisionalSession = sessionResponse();
    (provisionalSession.account as Record<string, unknown>).passwordResetRequired = true;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(provisionalSession))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new SyncActionApiClient({ serverUrl, fetch });
    const activationKey = `sak_${"B".repeat(43)}`;

    await expect(api.loginWithAccountKey({ activationKey, deviceId })).resolves.toMatchObject({
      account: { passwordResetRequired: true },
    });
    await expect(
      api.initializePassword("access-token", { newPassword: "correct horse battery" }),
    ).resolves.toBeUndefined();

    expect(callShape(fetch, 0)).toEqual({
      url: `${serverUrl}/v1/auth/key-login`,
      method: "POST",
      authorization: null,
      body: { activationKey, deviceId },
    });
    expect(callShape(fetch, 1)).toEqual({
      url: `${serverUrl}/v1/me/password/initialize`,
      method: "POST",
      authorization: "Bearer access-token",
      body: { newPassword: "correct horse battery" },
    });
    expect(JSON.stringify(api)).not.toMatch(/correct horse|sak_/u);
  });

  it("maps stable server errors without retaining the submitted password", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(
        {
          code: "ACCOUNT_PENDING",
          message: "ACCOUNT_PENDING",
          requestId: "req-1",
        },
        403,
      ),
    );
    const api = new SyncActionApiClient({ serverUrl, fetch });

    const failure = await api
      .login({
        username: "alex",
        password: "correct horse battery",
        deviceId,
      })
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(SyncActionApiError);
    expect(failure).toMatchObject({
      code: "ACCOUNT_PENDING",
      status: 403,
      requestId: "req-1",
    });
    expect(JSON.stringify(failure)).not.toContain("correct horse battery");
  });

  it("rejects a successful but malformed response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ ...sessionResponse(), refreshToken: "too-short" }));
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(
      api.login({
        username: "alex",
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 200 });
  });

  it("uses a bearer token for room listing and parses each room", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        rooms: [
          {
            id: "018f8f8e-4b5c-7d6e-8f90-123456789ab4",
            name: "产品研究",
            role: "OWNER",
            roomEpoch: 0,
            visibility: "PRIVATE",
            joinPolicy: "INVITE_ONLY",
            roomRevision: 0,
            createdAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
        ],
      }),
    );
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(api.listRooms("access-token")).resolves.toMatchObject([
      { name: "产品研究", role: "OWNER" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      `${serverUrl}/v1/rooms`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer access-token" }),
      }),
    );
  });

  it("does not accept redirects to a different origin", async () => {
    const redirectedResponse = jsonResponse(sessionResponse());
    Object.defineProperties(redirectedResponse, {
      redirected: { value: true },
      url: { value: "https://attacker.example/v1/auth/login" },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(redirectedResponse);
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(
      api.login({
        username: "alex",
        password: "correct horse battery",
        deviceId,
      }),
    ).rejects.toMatchObject({ code: "CROSS_ORIGIN_REDIRECT" });
  });

  it("fetches strict server metadata without credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(metadata));
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(api.getMeta()).resolves.toEqual(metadata);
    expect(fetch).toHaveBeenCalledWith(
      `${serverUrl}/v1/meta`,
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
      }),
    );

    fetch.mockResolvedValueOnce(jsonResponse({ ...metadata, unknown: true }));
    await expect(api.getMeta()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 200,
    });
  });

  it("checks exact health with an eight-second abort deadline", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ status: "ok" }));
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(api.getHealth()).resolves.toEqual({ status: "ok" });
    expect(fetch).toHaveBeenCalledWith(
      `${serverUrl}/healthz`,
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );

    fetch.mockResolvedValueOnce(jsonResponse({ status: "ok", detail: "unexpected" }));
    await expect(api.getHealth()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 200,
    });
  });

  it("maps public discovery and room mutations to exact product requests", async () => {
    const publicList = {
      items: [
        {
          roomId,
          name: "产品研究",
          joinPolicy: "APPROVAL",
          onlineCount: 1,
          memberCount: 2,
          openTabCount: 3,
          hasActivePlayback: true,
          updatedAt: timestamp,
        },
      ],
      nextCursor: "next_cursor",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(publicList))
      .mockResolvedValueOnce(jsonResponse({ rooms: [roomResponse()] }))
      .mockResolvedValueOnce(jsonResponse(roomResponse()))
      .mockResolvedValueOnce(jsonResponse(roomResponse({ name: "新名称" })))
      .mockResolvedValueOnce(jsonResponse(roomResponse({ role: "MEMBER" })));
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(
      api.listPublicRooms({
        query: "A&B /?+%",
        cursor: "cursor_token",
        limit: 20,
      }),
    ).resolves.toEqual(publicList);
    await expect(api.listRooms("access-token")).resolves.toHaveLength(1);
    await expect(
      api.createRoom("access-token", {
        name: "产品研究",
        visibility: "PUBLIC",
        joinPolicy: "APPROVAL",
      }),
    ).resolves.toMatchObject({ id: roomId });
    await expect(
      api.updateRoom("access-token", roomId, {
        name: "新名称",
        visibility: "PRIVATE",
        joinPolicy: "INVITE_ONLY",
      }),
    ).resolves.toMatchObject({ name: "新名称" });
    await expect(api.joinOpenRoom("access-token", roomId)).resolves.toMatchObject({
      role: "MEMBER",
    });

    expect(callShape(fetch, 0)).toEqual({
      url: `${serverUrl}/v1/public-rooms?query=A%26B+%2F%3F%2B%25&cursor=cursor_token&limit=20`,
      method: "GET",
      authorization: null,
      body: undefined,
    });
    expect(callShape(fetch, 1)).toEqual({
      url: `${serverUrl}/v1/rooms`,
      method: "GET",
      authorization: "Bearer access-token",
      body: undefined,
    });
    expect(callShape(fetch, 2)).toEqual({
      url: `${serverUrl}/v1/rooms`,
      method: "POST",
      authorization: "Bearer access-token",
      body: {
        name: "产品研究",
        visibility: "PUBLIC",
        joinPolicy: "APPROVAL",
      },
    });
    expect(callShape(fetch, 3)).toEqual({
      url: `${serverUrl}/v1/rooms/${roomId}`,
      method: "PATCH",
      authorization: "Bearer access-token",
      body: {
        name: "新名称",
        visibility: "PRIVATE",
        joinPolicy: "INVITE_ONLY",
      },
    });
    expect(callShape(fetch, 4)).toEqual({
      url: `${serverUrl}/v1/rooms/${roomId}/join`,
      method: "POST",
      authorization: "Bearer access-token",
      body: undefined,
    });
  });

  it("maps directory, join-request, and batch-invite actions exactly", async () => {
    const directory = {
      items: [
        {
          userId,
          username: "friend",
          displayName: "Friend",
          online: true,
        },
      ],
      nextCursor: null,
    };
    const pending = joinRequestResponse();
    const decided = joinRequestResponse({
      status: "APPROVED",
      decidedAt: timestamp,
    });
    const batch = [{ userId, status: "CREATED", invitationId }];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(directory))
      .mockResolvedValueOnce(jsonResponse(pending, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(decided))
      .mockResolvedValueOnce(jsonResponse(batch, 201));
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(
      api.searchDirectory("access-token", {
        roomId,
        query: "友&人",
        cursor: "directory_cursor",
        limit: 12,
      }),
    ).resolves.toEqual(directory);
    await expect(api.requestRoomJoin("access-token", roomId)).resolves.toEqual(pending);
    await expect(api.cancelJoinRequest("access-token", requestId)).resolves.toBeUndefined();
    await expect(
      api.decideJoinRequest("access-token", requestId, {
        decision: "APPROVE",
        clientOpId,
      }),
    ).resolves.toEqual(decided);
    await expect(api.batchInvite("access-token", roomId, [userId])).resolves.toEqual(batch);

    expect(callShape(fetch, 0)).toEqual({
      url: `${serverUrl}/v1/directory/users?roomId=${roomId}&query=%E5%8F%8B%26%E4%BA%BA&cursor=directory_cursor&limit=12`,
      method: "GET",
      authorization: "Bearer access-token",
      body: undefined,
    });
    expect(callShape(fetch, 1)).toEqual({
      url: `${serverUrl}/v1/rooms/${roomId}/join-requests`,
      method: "POST",
      authorization: "Bearer access-token",
      body: undefined,
    });
    expect(callShape(fetch, 2)).toEqual({
      url: `${serverUrl}/v1/room-join-requests/${requestId}`,
      method: "DELETE",
      authorization: "Bearer access-token",
      body: undefined,
    });
    expect(callShape(fetch, 3)).toEqual({
      url: `${serverUrl}/v1/room-join-requests/${requestId}/decision`,
      method: "POST",
      authorization: "Bearer access-token",
      body: { decision: "APPROVE", clientOpId },
    });
    expect(callShape(fetch, 4)).toEqual({
      url: `${serverUrl}/v1/rooms/${roomId}/invitations/batch`,
      method: "POST",
      authorization: "Bearer access-token",
      body: { userIds: [userId] },
    });
  });

  it("maps notification and policy actions exactly", async () => {
    const notification = notificationResponse();
    const notificationList = {
      items: [notification],
      nextCursor: 4,
      unreadCount: 1,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(notificationList))
      .mockResolvedValueOnce(jsonResponse({ ...notification, readAt: timestamp }))
      .mockResolvedValueOnce(jsonResponse({ readAt: timestamp, throughCursor: 4 }))
      .mockResolvedValueOnce(jsonResponse({ termsVersion: "2026-07-30", accepted: false }))
      .mockResolvedValueOnce(jsonResponse({ termsVersion: "2026-07-30", accepted: true }));
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(api.listNotifications("access-token", { after: 0, limit: 20 })).resolves.toEqual(
      notificationList,
    );
    await expect(api.markNotificationRead("access-token", notificationId)).resolves.toMatchObject({
      readAt: timestamp,
    });
    await expect(api.markNotificationsRead("access-token", 4)).resolves.toEqual({
      readAt: timestamp,
      throughCursor: 4,
    });
    await expect(api.getCurrentPolicyAcceptance("access-token")).resolves.toEqual({
      termsVersion: "2026-07-30",
      accepted: false,
    });
    await expect(
      api.acceptCurrentPolicy("access-token", {
        termsVersion: "2026-07-30",
        clientVersion: "0.9.0",
      }),
    ).resolves.toEqual({ termsVersion: "2026-07-30", accepted: true });

    expect(callShape(fetch, 0)).toEqual({
      url: `${serverUrl}/v1/notifications?after=0&limit=20`,
      method: "GET",
      authorization: "Bearer access-token",
      body: undefined,
    });
    expect(callShape(fetch, 1)).toEqual({
      url: `${serverUrl}/v1/notifications/${notificationId}/read`,
      method: "POST",
      authorization: "Bearer access-token",
      body: undefined,
    });
    expect(callShape(fetch, 2)).toEqual({
      url: `${serverUrl}/v1/notifications/read-all`,
      method: "POST",
      authorization: "Bearer access-token",
      body: { throughCursor: 4 },
    });
    expect(callShape(fetch, 3)).toEqual({
      url: `${serverUrl}/v1/policy-acceptances/current`,
      method: "GET",
      authorization: "Bearer access-token",
      body: undefined,
    });
    expect(callShape(fetch, 4)).toEqual({
      url: `${serverUrl}/v1/policy-acceptances`,
      method: "POST",
      authorization: "Bearer access-token",
      body: {
        termsVersion: "2026-07-30",
        clientVersion: "0.9.0",
        accepted: true,
      },
    });
  });

  it("maps room lifecycle actions exactly and omits bodies for 204 deletes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(roomResponse({ role: "OWNER" })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new SyncActionApiClient({ serverUrl, fetch });

    await expect(api.leaveRoom("access-token", roomId)).resolves.toBeUndefined();
    await expect(api.removeMember("access-token", roomId, userId)).resolves.toBeUndefined();
    await expect(api.transferOwnership("access-token", roomId, userId)).resolves.toMatchObject({
      id: roomId,
    });
    await expect(api.dissolveRoom("access-token", roomId)).resolves.toBeUndefined();

    expect(fetch.mock.calls.map((_, index) => callShape(fetch, index))).toEqual([
      {
        url: `${serverUrl}/v1/rooms/${roomId}/members/me`,
        method: "DELETE",
        authorization: "Bearer access-token",
        body: undefined,
      },
      {
        url: `${serverUrl}/v1/rooms/${roomId}/members/${userId}`,
        method: "DELETE",
        authorization: "Bearer access-token",
        body: undefined,
      },
      {
        url: `${serverUrl}/v1/rooms/${roomId}/ownership-transfer`,
        method: "POST",
        authorization: "Bearer access-token",
        body: { newOwnerUserId: userId },
      },
      {
        url: `${serverUrl}/v1/rooms/${roomId}`,
        method: "DELETE",
        authorization: "Bearer access-token",
        body: undefined,
      },
    ]);
  });

  it("rejects unknown fields in every new product response envelope", async () => {
    const malformedResponses = [
      { items: [], nextCursor: null, unexpected: true },
      { items: [], nextCursor: null, unreadCount: 0, unexpected: true },
      { termsVersion: "2026-07-30", accepted: false, unexpected: true },
      [{ userId, status: "CREATED", invitationId, unexpected: true }],
    ];
    const actions = [
      (api: SyncActionApiClient) => api.listPublicRooms({ query: "", cursor: null, limit: 20 }),
      (api: SyncActionApiClient) => api.listNotifications("access-token", { after: 0, limit: 20 }),
      (api: SyncActionApiClient) => api.getCurrentPolicyAcceptance("access-token"),
      (api: SyncActionApiClient) => api.batchInvite("access-token", roomId, [userId]),
    ];

    for (const [index, action] of actions.entries()) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(jsonResponse(malformedResponses[index]));
      await expect(action(new SyncActionApiClient({ serverUrl, fetch }))).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        status: 200,
      });
    }
  });
});
