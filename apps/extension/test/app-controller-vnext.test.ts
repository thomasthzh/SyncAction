import {
  ServerMetaSchema,
  type Notification,
  type PublicRoomsInvalidated,
  type RoomEventMessage,
} from "@syncaction/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  SyncActionApiError,
  type PublicAccount,
  type PublicRoom,
  type PublicRoomDetail,
  type PublicSessionResponse,
} from "../src/api-client.js";
import {
  ExtensionAppController,
  type ExtensionAppStorageArea,
  type ExtensionOnboardingPort,
  type ExtensionProductApi,
  type ExtensionProductSessionPort,
  type ExtensionPublicCatalogPort,
  type ExtensionServerProfilePort,
  type RoomRuntime,
  type RoomRuntimeFactoryInput,
} from "../src/app-controller.js";
import type { ExtensionStatus } from "../src/background-controller.js";
import {
  ExtensionProductSessionSchema,
  type ExtensionProductSession,
  type ExtensionSessionStatus,
} from "../src/product-session.js";
import {
  ServerProfileSchema,
  type ServerProfile,
  type VerifiedServerCandidate,
} from "../src/server-profile.js";

const profileAId = "server-a";
const profileBId = "server-b";
const serverAUrl = "https://a.example";
const serverBUrl = "https://b.example";
const serverAId = "10000000-0000-4000-8000-000000000001";
const serverBId = "10000000-0000-4000-8000-000000000002";
const deviceId = "20000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000001";
const otherUserId = "30000000-0000-4000-8000-000000000002";
const roomId = "40000000-0000-4000-8000-000000000001";
const requestId = "50000000-0000-4000-8000-000000000001";
const clientOpId = "60000000-0000-4000-8000-000000000001";
const playbackGroupId = "70000000-0000-4000-8000-000000000001";
const timestamp = "2026-07-30T00:00:00.000Z";

const account: PublicAccount = {
  id: userId,
  username: "alex",
  displayName: "Alex",
  status: "ACTIVE",
  passwordResetRequired: false,
  createdAt: timestamp,
};

function metadata(
  serverId: string,
  overrides: Partial<ReturnType<typeof ServerMetaSchema.parse>> = {},
) {
  return ServerMetaSchema.parse({
    serverId,
    displayName: "SyncAction Team",
    protocolVersion: "1",
    minimumClientVersion: "0.9.0",
    termsVersion: "2026-07-30",
    capabilities: [
      "public-rooms",
      "join-requests",
      "notifications",
      "volatile-pointer-v2",
      "content-compatibility-v1",
      "future-capability",
    ],
    limits: {
      ordinaryActiveRooms: 5,
      ordinaryOpenTabs: 20,
    },
    ...overrides,
  });
}

function profile(
  profileId: string,
  baseUrl: string,
  serverId: string,
  overrides: Partial<ServerProfile> = {},
): ServerProfile {
  return ServerProfileSchema.parse({
    profileId,
    baseUrl,
    mode: "VNEXT",
    metadata: metadata(serverId),
    lastHealthyAt: 100,
    ...overrides,
  });
}

function room(role: "OWNER" | "MEMBER" = "OWNER", revision = 0): PublicRoom {
  return {
    id: roomId as PublicRoom["id"],
    name: "产品研究",
    role,
    roomEpoch: 0,
    visibility: "PUBLIC",
    joinPolicy: "APPROVAL",
    roomRevision: revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function roomDetail(role: "OWNER" | "MEMBER" = "OWNER", revision = 0): PublicRoomDetail {
  return {
    ...room(role, revision),
    members: [
      {
        userId,
        username: "alex",
        displayName: "Alex",
        role,
        joinedAt: timestamp,
      },
    ],
    pendingInvitations: role === "OWNER" ? [] : null,
  };
}

function sessionResponse(): PublicSessionResponse {
  return {
    sessionId: "80000000-0000-4000-8000-000000000001",
    accessToken: "access-token",
    refreshToken: "A".repeat(43),
    expiresInSeconds: 900,
    refreshExpiresInSeconds: 2_592_000,
    account,
  };
}

function notification(
  id = "90000000-0000-4000-8000-000000000001",
  cursor = 1,
  readAt: string | null = null,
): Notification {
  return {
    notificationId: id,
    cursor,
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
    readAt,
  };
}

class MemoryArea implements ExtensionAppStorageArea {
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

class FakeProfiles implements ExtensionServerProfilePort {
  public readonly calls: string[] = [];
  public readonly byId = new Map<string, ServerProfile>();
  public selectedProfileId: string;
  private nextProfile = 0;

  public constructor(profiles: ServerProfile[], selectedProfileId: string) {
    this.selectedProfileId = selectedProfileId;
    for (const value of profiles) {
      this.byId.set(value.profileId, structuredClone(value));
    }
  }

  public async initialize(): Promise<void> {
    this.calls.push("profiles:initialize");
  }

  public async list(): Promise<ServerProfile[]> {
    this.calls.push("profiles:list");
    return structuredClone([...this.byId.values()]);
  }

  public async get(profileId: unknown): Promise<ServerProfile | null> {
    const value = this.byId.get(String(profileId));
    return value === undefined ? null : structuredClone(value);
  }

  public async getSelected(): Promise<ServerProfile> {
    this.calls.push(`profiles:getSelected:${this.selectedProfileId}`);
    return structuredClone(this.byId.get(this.selectedProfileId)!);
  }

  public async addCandidate(candidate: VerifiedServerCandidate): Promise<ServerProfile> {
    this.calls.push(`profiles:add:${candidate.baseUrl}`);
    const profileId = `added-${++this.nextProfile}`;
    const value = ServerProfileSchema.parse({
      profileId,
      baseUrl: candidate.baseUrl,
      mode: candidate.mode,
      metadata: candidate.metadata,
      lastHealthyAt: candidate.healthyAt,
    });
    this.byId.set(profileId, value);
    return structuredClone(value);
  }

  public async verify(profileId: unknown, nextMetadata: unknown): Promise<ServerProfile> {
    const id = String(profileId);
    this.calls.push(`profiles:verify:${id}`);
    const current = this.byId.get(id)!;
    const value = ServerProfileSchema.parse({
      ...current,
      mode: "VNEXT",
      metadata: nextMetadata,
      lastHealthyAt: 200,
    });
    this.byId.set(id, value);
    return structuredClone(value);
  }

  public async select(profileId: unknown): Promise<ServerProfile> {
    const id = String(profileId);
    this.calls.push(`profiles:select:${id}`);
    this.selectedProfileId = id;
    return structuredClone(this.byId.get(id)!);
  }
}

class FakeSessions implements ExtensionProductSessionPort {
  public readonly calls: string[] = [];
  public readonly sessions = new Map<string, ExtensionProductSession>();
  public readonly statuses = new Map<string, ExtensionSessionStatus>();

  public async establish(input: {
    profileId: unknown;
    serverUrl: unknown;
    serverId: unknown;
    deviceId: unknown;
    response: PublicSessionResponse;
  }): Promise<ExtensionProductSession> {
    const profileId = String(input.profileId);
    const value = ExtensionProductSessionSchema.parse({
      version: 2,
      profileId,
      serverUrl: input.serverUrl,
      serverId: input.serverId,
      deviceId: input.deviceId,
      sessionId: input.response.sessionId,
      accessToken: input.response.accessToken,
      accessTokenExpiresAt: 10_000,
      refreshToken: input.response.refreshToken,
      refreshTokenExpiresAt: 20_000,
      account: input.response.account,
    });
    this.sessions.set(profileId, value);
    this.statuses.set(profileId, {
      kind: "AUTHENTICATED",
      account: value.account,
      deviceId: value.deviceId,
      accessTokenExpiresAt: value.accessTokenExpiresAt,
      refreshTokenExpiresAt: value.refreshTokenExpiresAt,
    });
    return value;
  }

  public seed(profileId: string, baseUrl: string, serverId: string): void {
    const response = sessionResponse();
    const value = ExtensionProductSessionSchema.parse({
      version: 2,
      profileId,
      serverUrl: baseUrl,
      serverId,
      deviceId,
      sessionId: response.sessionId,
      accessToken: `access-${profileId}`,
      accessTokenExpiresAt: 10_000,
      refreshToken: profileId === profileAId ? "A".repeat(43) : "B".repeat(43),
      refreshTokenExpiresAt: 20_000,
      account,
    });
    this.sessions.set(profileId, value);
    this.statuses.set(profileId, {
      kind: "AUTHENTICATED",
      account,
      deviceId: value.deviceId,
      accessTokenExpiresAt: value.accessTokenExpiresAt,
      refreshTokenExpiresAt: value.refreshTokenExpiresAt,
    });
  }

  public async read(profileId: unknown): Promise<ExtensionProductSession | null> {
    const id = String(profileId);
    this.calls.push(`sessions:read:${id}`);
    return structuredClone(this.sessions.get(id) ?? null);
  }

  public async getStatus(profileId: unknown): Promise<ExtensionSessionStatus> {
    const id = String(profileId);
    this.calls.push(`sessions:getStatus:${id}`);
    return structuredClone(this.statuses.get(id) ?? { kind: "SIGNED_OUT" });
  }

  public async getAccessToken(profileId: unknown): Promise<string> {
    const id = String(profileId);
    this.calls.push(`sessions:getAccessToken:${id}`);
    const value = this.sessions.get(id);
    if (value === undefined) {
      throw new Error("SESSION_REQUIRED");
    }
    return value.accessToken;
  }

  public async runAuthenticated<T>(
    profileId: unknown,
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const id = String(profileId);
    this.calls.push(`sessions:run:${id}`);
    return operation(this.sessions.get(id)?.accessToken ?? `access-${id}`);
  }

  public async updateAccount(profileId: unknown, nextAccount: PublicAccount): Promise<void> {
    const id = String(profileId);
    this.calls.push(`sessions:updateAccount:${id}`);
    const current = this.sessions.get(id);
    if (current === undefined) {
      throw new Error("SESSION_REQUIRED");
    }
    this.sessions.set(id, { ...current, account: structuredClone(nextAccount) });
    const status = this.statuses.get(id);
    if (status?.kind === "AUTHENTICATED") {
      this.statuses.set(id, { ...status, account: structuredClone(nextAccount) });
    }
  }

  public async clear(profileId: unknown): Promise<void> {
    const id = String(profileId);
    this.calls.push(`sessions:clear:${id}`);
    this.sessions.delete(id);
    this.statuses.delete(id);
  }

  public async migrateLegacyProductionSession(profile: ServerProfile): Promise<void> {
    this.calls.push(`sessions:migrate:${profile.profileId}`);
  }
}

class FakeCatalog implements ExtensionPublicCatalogPort {
  public readonly start = vi.fn(async () => undefined);
  public readonly stop = vi.fn(async () => undefined);
  private handler: ((message: PublicRoomsInvalidated) => void) | undefined;

  public setInvalidatedHandler(
    handler: ((message: PublicRoomsInvalidated) => void) | undefined,
  ): void {
    this.handler = handler;
  }

  public invalidate(): void {
    this.handler?.({
      type: "public-rooms.invalidated",
      roomId: roomId as PublicRoomsInvalidated["roomId"],
      reason: "PRESENCE",
      roomRevision: null,
    });
  }
}

class FakeOnboarding implements ExtensionOnboardingPort {
  public dismissCalls = 0;

  public constructor(private required: boolean) {}

  public async isRequired(): Promise<boolean> {
    return this.required;
  }

  public async dismiss(): Promise<boolean> {
    this.dismissCalls += 1;
    if (!this.required) {
      return false;
    }
    this.required = false;
    return true;
  }
}

function runtimeStatus(): ExtensionStatus {
  return {
    state: "SYNCED",
    roomName: "产品研究",
    serverSeq: 0,
    sharedTabCount: 0,
    outboxCount: 0,
    pendingConfirmationCount: 0,
    bindingCount: 0,
    browser: null,
    presence: null,
    pointer: null,
    media: null,
    danmaku: null,
    drawing: null,
    tabs: [],
  };
}

function fakeRuntime(events: string[]): RoomRuntime {
  return {
    start: vi.fn(async () => {
      events.push("runtime:start");
    }),
    stop: vi.fn(async () => {
      events.push("runtime:stop");
    }),
    getStatus: vi.fn(async () => runtimeStatus()),
    handleActiveTabChanged: vi.fn(async () => undefined),
    handlePagePermissionBoundaryChanged: vi.fn(async () => undefined),
    leaveMediaGroup: vi.fn(async (groupId?: string) => {
      events.push(`media:leave:${String(groupId)}`);
    }),
    closeMediaGroup: vi.fn(async (groupId?: string) => {
      events.push(`media:close:${String(groupId)}`);
    }),
    takeOverMediaDevice: vi.fn(async (groupId: string) => {
      events.push(`media:takeover:${groupId}`);
    }),
  } as unknown as RoomRuntime;
}

function apiFixture(
  label: string,
  meta: ReturnType<typeof ServerMetaSchema.parse>,
  trace: string[],
  overrides: Partial<ExtensionProductApi> = {},
): ExtensionProductApi {
  const baseRoom = room();
  const baseDetail = roomDetail();
  return {
    getHealth: vi.fn(async () => {
      trace.push(`${label}:health`);
      return { status: "ok" as const };
    }),
    getMeta: vi.fn(async () => {
      trace.push(`${label}:meta`);
      return meta;
    }),
    register: vi.fn(async () => ({ ...account, status: "PENDING" as const })),
    activateAccount: vi.fn(async () => sessionResponse()),
    login: vi.fn(async () => sessionResponse()),
    logout: vi.fn(async () => {
      trace.push(`${label}:logout`);
    }),
    updateProfile: vi.fn(async (_token, input) => ({ ...account, ...input })),
    changePassword: vi.fn(async () => undefined),
    listPublicRooms: vi.fn(async () => ({
      items: [
        {
          roomId: baseRoom.id,
          name: baseRoom.name,
          joinPolicy: baseRoom.joinPolicy,
          onlineCount: 1,
          memberCount: 1,
          openTabCount: 0,
          hasActivePlayback: false,
          updatedAt: timestamp,
        },
      ],
      nextCursor: null,
    })),
    listRooms: vi.fn(async () => [baseRoom]),
    createRoom: vi.fn(async () => baseRoom),
    updateRoom: vi.fn(async (_token, _roomId, input) => ({ ...baseRoom, ...input })),
    getRoom: vi.fn(async () => baseDetail),
    listInvitations: vi.fn(async () => []),
    acceptInvitation: vi.fn(async () => baseRoom),
    invite: vi.fn(async () => ({
      id: "a0000000-0000-4000-8000-000000000001",
      roomId: baseRoom.id,
      invitedUserId: otherUserId,
      invitedByUserId: userId,
      status: "PENDING" as const,
      expiresAt: timestamp,
      createdAt: timestamp,
    })),
    searchDirectory: vi.fn(async () => ({ items: [], nextCursor: null })),
    joinOpenRoom: vi.fn(async () => ({ ...baseRoom, role: "MEMBER" as const })),
    requestRoomJoin: vi.fn(async () => ({
      requestId,
      roomId: baseRoom.id,
      applicant: {
        userId,
        username: account.username,
        displayName: account.displayName,
      },
      status: "PENDING" as const,
      createdAt: timestamp,
      decidedAt: null,
    })),
    cancelJoinRequest: vi.fn(async () => undefined),
    decideJoinRequest: vi.fn(async () => ({
      requestId,
      roomId: baseRoom.id,
      applicant: {
        userId: otherUserId,
        username: "friend",
        displayName: "Friend",
      },
      status: "APPROVED" as const,
      createdAt: timestamp,
      decidedAt: timestamp,
    })),
    batchInvite: vi.fn(async () => [
      {
        userId: otherUserId,
        status: "CREATED" as const,
        invitationId: "b0000000-0000-4000-8000-000000000001",
      },
    ]),
    listNotifications: vi.fn(async () => ({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    })),
    markNotificationRead: vi.fn(async () => notification(undefined, 1, timestamp)),
    markNotificationsRead: vi.fn(async (_token, throughCursor) => ({
      readAt: timestamp,
      throughCursor: Number(throughCursor),
    })),
    getCurrentPolicyAcceptance: vi.fn(async () => ({
      termsVersion: meta.termsVersion,
      accepted: false,
    })),
    acceptCurrentPolicy: vi.fn(async () => ({
      termsVersion: meta.termsVersion,
      accepted: true,
    })),
    leaveRoom: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
    transferOwnership: vi.fn(async () => baseRoom),
    dissolveRoom: vi.fn(async () => undefined),
    ...overrides,
  } as ExtensionProductApi;
}

function createApp(input: {
  profiles: FakeProfiles;
  sessions?: FakeSessions;
  apis: Map<string, ExtensionProductApi>;
  catalogs?: FakeCatalog[];
  onboarding?: FakeOnboarding;
  runtimeFactory?: (input: RoomRuntimeFactoryInput) => RoomRuntime;
}) {
  const sessions = input.sessions ?? new FakeSessions();
  const catalogs = input.catalogs ?? [];
  const onboarding = input.onboarding ?? new FakeOnboarding(false);
  const runtimeEvents: string[] = [];
  const app = new ExtensionAppController({
    deviceId,
    area: new MemoryArea(),
    profiles: input.profiles,
    sessions,
    clientVersion: "0.9.0",
    apiFactory: (baseUrl) => input.apis.get(baseUrl)!,
    publicTransportFactory: () => {
      const value = new FakeCatalog();
      catalogs.push(value);
      return value;
    },
    onboarding,
    runtimeFactory: input.runtimeFactory ?? (() => fakeRuntime(runtimeEvents)),
  });
  return { app, sessions, catalogs, onboarding, runtimeEvents };
}

describe("ExtensionAppController vNext server hub", () => {
  it("activates an account and persists profile changes through the existing session", async () => {
    const selected = profile(profileAId, serverAUrl, serverAId, {
      metadata: metadata(serverAId, {
        capabilities: ["public-rooms", "account-activation-v1"],
      }),
    });
    const activateAccount = vi.fn(async () => sessionResponse());
    const updateProfile = vi.fn(
      async (
        _accessToken: string,
        input: {
          username: string;
          displayName: string;
        },
      ) => ({ ...account, ...input }),
    );
    const changePassword = vi.fn(async () => undefined);
    const api = apiFixture("a", selected.metadata!, [], {
      activateAccount,
      updateProfile,
      changePassword,
    });
    const { app, sessions } = createApp({
      profiles: new FakeProfiles([selected], profileAId),
      apis: new Map([[serverAUrl, api]]),
    });
    await app.start();

    await app.activateAccount({
      activationKey: `sak_${"A".repeat(43)}`,
      username: "alex",
      displayName: "Alex",
      password: "correct horse battery",
    });
    expect(activateAccount).toHaveBeenCalledWith({
      activationKey: `sak_${"A".repeat(43)}`,
      username: "alex",
      displayName: "Alex",
      password: "correct horse battery",
      deviceId,
    });
    expect(await app.getStatus()).toMatchObject({
      phase: "AUTHENTICATED_NO_ROOM",
      account: { username: "alex" },
    });

    await app.updateAccountProfile({
      username: "alex.renamed",
      displayName: "Alex Renamed",
    });
    expect(updateProfile).toHaveBeenCalledWith("access-token", {
      username: "alex.renamed",
      displayName: "Alex Renamed",
    });
    expect(sessions.calls).toContain(`sessions:updateAccount:${profileAId}`);
    expect(await app.getStatus()).toMatchObject({
      account: { username: "alex.renamed", displayName: "Alex Renamed" },
    });

    await app.changeAccountPassword({
      currentPassword: "correct horse battery",
      newPassword: "replacement horse battery",
    });
    expect(changePassword).toHaveBeenCalledWith("access-token", {
      currentPassword: "correct horse battery",
      newPassword: "replacement horse battery",
    });
  });

  it("persists an account-key session and initializes its first password", async () => {
    const selected = profile(profileAId, serverAUrl, serverAId, {
      metadata: metadata(serverAId, {
        capabilities: ["public-rooms", "account-activation-v1", "account-key-login-v1"],
      }),
    });
    const provisionalResponse: PublicSessionResponse = {
      ...sessionResponse(),
      account: { ...account, passwordResetRequired: true },
    };
    const loginWithAccountKey = vi.fn(async () => provisionalResponse);
    const initializePassword = vi.fn(async () => undefined);
    const api = apiFixture("a", selected.metadata!, [], {
      loginWithAccountKey,
      initializePassword,
    });
    const { app, sessions } = createApp({
      profiles: new FakeProfiles([selected], profileAId),
      apis: new Map([[serverAUrl, api]]),
    });
    await app.start();

    await app.loginWithAccountKey({ activationKey: `sak_${"B".repeat(43)}` });
    expect(loginWithAccountKey).toHaveBeenCalledWith({
      activationKey: `sak_${"B".repeat(43)}`,
      deviceId,
    });
    expect(sessions.sessions.get(profileAId)).toMatchObject({
      account: { id: account.id, passwordResetRequired: true },
    });
    expect(await app.getStatus()).toMatchObject({
      phase: "AUTHENTICATED_NO_ROOM",
      account: { passwordResetRequired: true },
    });

    await app.initializeAccountPassword({ newPassword: "correct horse battery" });
    expect(initializePassword).toHaveBeenCalledWith("access-token", {
      newPassword: "correct horse battery",
    });
    expect(sessions.calls).toContain(`sessions:updateAccount:${profileAId}`);
    expect(await app.getStatus()).toMatchObject({
      account: { passwordResetRequired: false },
    });
  });

  it("projects the selected verified terms into a page-access context without inventing a room document", async () => {
    const selected = profile(profileAId, serverAUrl, serverAId);
    const profiles = new FakeProfiles([selected], profileAId);
    const { app } = createApp({
      profiles,
      apis: new Map([[serverAUrl, apiFixture("a", metadata(serverAId), [])]]),
    });

    await app.start();

    await expect(app.getPageAccessContext(42)).resolves.toEqual({
      profileId: profileAId,
      serverOrigin: serverAUrl,
      serverTermsVersion: "2026-07-30",
      documentRevision: null,
      contentCompatibility: null,
    });
  });

  it("verifies anonymously, exposes guest discovery, coalesces invalidations, and dismisses onboarding once", async () => {
    const trace: string[] = [];
    const selected = profile(profileAId, serverAUrl, serverAId, {
      mode: "UNVERIFIED",
      metadata: null,
    });
    const selectedMetadata = metadata(serverAId);
    const profiles = new FakeProfiles([selected], profileAId);
    const api = apiFixture("a", selectedMetadata, trace);
    const catalogs: FakeCatalog[] = [];
    const onboarding = new FakeOnboarding(true);
    const { app, sessions } = createApp({
      profiles,
      apis: new Map([[serverAUrl, api]]),
      catalogs,
      onboarding,
    });

    await app.start();

    const status = await app.getStatus();
    expect(status).toMatchObject({
      phase: "SIGNED_OUT",
      selectedProfileId: profileAId,
      onboardingRequired: true,
      publicRooms: [{ roomId }],
      publicRoomsUnavailableReason: null,
      pointerUnavailableReason: null,
      contentCompatibilityUnavailableReason: null,
    });
    expect(status.serverCapabilities).toEqual([
      "public-rooms",
      "join-requests",
      "notifications",
      "volatile-pointer-v2",
      "content-compatibility-v1",
    ]);
    expect(trace).toEqual(["a:health", "a:meta"]);
    expect(sessions.calls).toEqual([`sessions:getStatus:${profileAId}`]);
    expect(profiles.calls).toContain(`profiles:verify:${profileAId}`);

    catalogs[0]!.invalidate();
    catalogs[0]!.invalidate();
    catalogs[0]!.invalidate();
    await vi.waitFor(() => expect(api.listPublicRooms).toHaveBeenCalledTimes(2));

    const listener = vi.fn();
    app.subscribe(listener);
    await app.dismissVnextOnboarding();
    await app.dismissVnextOnboarding();
    expect(onboarding.dismissCalls).toBe(2);
    expect(listener).toHaveBeenCalledOnce();
    expect((await app.getStatus()).onboardingRequired).toBe(false);
  });

  it("refetches custom-server health and metadata before persisting an added profile", async () => {
    const trace: string[] = [];
    const selected = profile(profileAId, serverAUrl, serverAId, {
      metadata: metadata(serverAId, { capabilities: [] }),
    });
    const profiles = new FakeProfiles([selected], profileAId);
    const addedUrl = "https://c.example";
    const addedApi = apiFixture("c", metadata(serverBId, { capabilities: [] }), trace);
    const { app } = createApp({
      profiles,
      apis: new Map([
        [serverAUrl, apiFixture("a", selected.metadata!, [])],
        [addedUrl, addedApi],
      ]),
    });
    await app.start();

    await expect(app.addServer({ baseUrl: addedUrl })).resolves.toBe("added-1");

    expect(trace).toEqual(["c:health", "c:meta"]);
    expect(profiles.calls).toContain(`profiles:add:${addedUrl}`);
  });

  it("confirms the old identity before logout and clears only the old profile on switch", async () => {
    const trace: string[] = [];
    const first = profile(profileAId, serverAUrl, serverAId, {
      metadata: metadata(serverAId, { capabilities: [] }),
    });
    const second = profile(profileBId, serverBUrl, serverBId, {
      metadata: metadata(serverBId, { capabilities: [] }),
    });
    const profiles = new FakeProfiles([first, second], profileAId);
    const sessions = new FakeSessions();
    sessions.seed(profileAId, serverAUrl, serverAId);
    sessions.seed(profileBId, serverBUrl, serverBId);
    const apiA = apiFixture("a", first.metadata!, trace);
    const apiB = apiFixture("b", second.metadata!, trace);
    const { app, runtimeEvents } = createApp({
      profiles,
      sessions,
      apis: new Map([
        [serverAUrl, apiA],
        [serverBUrl, apiB],
      ]),
    });
    await app.start();
    await app.selectRoom(roomId);
    trace.length = 0;
    sessions.calls.length = 0;
    profiles.calls.length = 0;

    await app.selectServer(profileBId);

    expect(trace).toEqual(["a:health", "a:meta", "a:logout", "b:health", "b:meta"]);
    expect(sessions.calls).toContain(`sessions:read:${profileAId}`);
    expect(sessions.calls).toContain(`sessions:clear:${profileAId}`);
    expect(sessions.calls).not.toContain(`sessions:clear:${profileBId}`);
    expect(sessions.sessions.has(profileAId)).toBe(false);
    expect(sessions.sessions.has(profileBId)).toBe(true);
    expect(profiles.calls).toContain(`profiles:select:${profileBId}`);
    expect(runtimeEvents).toContain("runtime:stop");
    expect((await app.getStatus()).selectedProfileId).toBe(profileBId);
  });

  it("quarantines identity replacement before reading or sending any stored credential", async () => {
    const trace: string[] = [];
    const selected = profile(profileAId, serverAUrl, serverAId);
    const profiles = new FakeProfiles([selected], profileAId);
    const sessions = new FakeSessions();
    sessions.seed(profileAId, serverAUrl, serverAId);
    const mismatched = metadata(serverBId);
    const api = apiFixture("a", mismatched, trace);
    const { app } = createApp({
      profiles,
      sessions,
      apis: new Map([[serverAUrl, api]]),
    });

    await app.start();

    expect(await app.getStatus()).toMatchObject({
      phase: "ERROR",
      errorCode: "SERVER_IDENTITY_CHANGED",
      account: null,
    });
    expect(sessions.calls).toEqual([`sessions:clear:${profileAId}`]);
    expect(api.logout).not.toHaveBeenCalled();
    await expect(app.login({ username: "alex", password: "password" })).rejects.toThrow(
      "SERVER_IDENTITY_CHANGED",
    );
    expect(api.login).not.toHaveBeenCalled();
  });

  it.each([
    ["SERVER_PROTOCOL_UNSUPPORTED", metadata(serverAId, { protocolVersion: "2" })],
    ["CLIENT_UPGRADE_REQUIRED", metadata(serverAId, { minimumClientVersion: "9.0.0" })],
  ])("blocks credentials for an incompatible server: %s", async (errorCode, meta) => {
    const selected = profile(profileAId, serverAUrl, serverAId);
    const sessions = new FakeSessions();
    sessions.seed(profileAId, serverAUrl, serverAId);
    const api = apiFixture("a", meta, []);
    const { app } = createApp({
      profiles: new FakeProfiles([selected], profileAId),
      sessions,
      apis: new Map([[serverAUrl, api]]),
    });

    await app.start();

    expect(await app.getStatus()).toMatchObject({ phase: "ERROR", errorCode });
    expect(sessions.calls).not.toContain(`sessions:read:${profileAId}`);
    expect(api.logout).not.toHaveBeenCalled();
  });

  it("keeps legacy private-room support while disabling vNext-only capabilities", async () => {
    const legacy = profile(profileAId, serverAUrl, serverAId, {
      mode: "LEGACY_V081",
      metadata: null,
    });
    const api = apiFixture("legacy", metadata(serverAId), [], {
      getMeta: vi.fn().mockRejectedValue(new SyncActionApiError("NOT_FOUND", 404)),
    });
    const { app } = createApp({
      profiles: new FakeProfiles([legacy], profileAId),
      apis: new Map([[serverAUrl, api]]),
    });

    await app.start();

    expect(await app.getStatus()).toMatchObject({
      phase: "SIGNED_OUT",
      errorCode: "SERVER_LEGACY_LIMITED",
      publicRooms: [],
      publicRoomsUnavailableReason: "SERVER_LEGACY_LIMITED",
      pointerUnavailableReason: "SERVER_LEGACY_LIMITED",
      contentCompatibilityUnavailableReason: "SERVER_LEGACY_LIMITED",
    });
    expect(api.listPublicRooms).not.toHaveBeenCalled();
  });
});

describe("ExtensionAppController realtime product state", () => {
  it("applies contiguous events, heals one gap, dedupes notifications, and leaves without polling", async () => {
    const meta = metadata(serverAId, {
      capabilities: ["notifications", "volatile-pointer-v2", "content-compatibility-v1"],
    });
    const selected = profile(profileAId, serverAUrl, serverAId, { metadata: meta });
    const sessions = new FakeSessions();
    sessions.seed(profileAId, serverAUrl, serverAId);
    let currentDetail = roomDetail();
    const api = apiFixture("a", meta, [], {
      getRoom: vi.fn(async () => currentDetail),
    });
    let runtimeInput: RoomRuntimeFactoryInput | undefined;
    const events: string[] = [];
    const { app } = createApp({
      profiles: new FakeProfiles([selected], profileAId),
      sessions,
      apis: new Map([[serverAUrl, api]]),
      runtimeFactory: (input) => {
        runtimeInput = input;
        return fakeRuntime(events);
      },
    });
    await app.start();
    await app.selectRoom(roomId);
    const listener = vi.fn();
    app.subscribe(listener);

    runtimeInput!.onRoomEvent?.({
      type: "room.event",
      protocolVersion: 1,
      eventId: "a0000000-0000-4000-8000-000000000001",
      roomId: roomId as RoomEventMessage["roomId"],
      roomRevision: 1,
      occurredAt: timestamp,
      kind: "ROOM_MEMBER_JOINED",
      member: {
        userId: otherUserId,
        username: "friend",
        displayName: "Friend",
        role: "MEMBER",
        joinedAt: timestamp,
      },
    });
    await vi.waitFor(async () =>
      expect((await app.getStatus()).roomDetail?.members).toHaveLength(2),
    );
    expect(api.getRoom).toHaveBeenCalledOnce();
    expect(api.listRooms).toHaveBeenCalledOnce();

    currentDetail = {
      ...roomDetail(),
      name: "Gap healed",
      roomRevision: 3,
    };
    runtimeInput!.onRoomEvent?.({
      type: "room.event",
      protocolVersion: 1,
      eventId: "a0000000-0000-4000-8000-000000000002",
      roomId: roomId as RoomEventMessage["roomId"],
      roomRevision: 3,
      occurredAt: timestamp,
      kind: "ROOM_UPDATED",
      name: "Gap healed",
      visibility: "PRIVATE",
      joinPolicy: "INVITE_ONLY",
    });
    await vi.waitFor(() => expect(api.getRoom).toHaveBeenCalledTimes(2));
    expect((await app.getStatus()).roomDetail?.name).toBe("Gap healed");
    expect(api.listRooms).toHaveBeenCalledOnce();

    const created = notification();
    runtimeInput!.onNotificationCreated?.(created);
    runtimeInput!.onNotificationCreated?.(created);
    await vi.waitFor(async () => expect((await app.getStatus()).unreadNotificationCount).toBe(1));
    expect((await app.getStatus()).notifications).toHaveLength(1);

    runtimeInput!.onNotificationRead?.({
      kind: "ONE",
      notificationId: created.notificationId,
      readAt: timestamp,
    });
    await vi.waitFor(async () => expect((await app.getStatus()).unreadNotificationCount).toBe(0));
    runtimeInput!.onNotificationCreated?.(
      notification("90000000-0000-4000-8000-000000000002", 2, timestamp),
    );
    await vi.waitFor(async () => expect((await app.getStatus()).notifications).toHaveLength(2));
    expect((await app.getStatus()).unreadNotificationCount).toBe(0);

    await app.leaveRoom();
    expect(api.leaveRoom).toHaveBeenCalledWith(`access-${profileAId}`, roomId);
    expect(events).toContain("runtime:stop");
    expect(await app.getStatus()).toMatchObject({
      phase: "AUTHENTICATED_NO_ROOM",
      selectedRoomId: null,
    });
    expect(listener).toHaveBeenCalled();
  });

  it("returns batch/decision results through state, routes reliable media commands, transfers, and dissolves", async () => {
    const meta = metadata(serverAId, { capabilities: [] });
    const selected = profile(profileAId, serverAUrl, serverAId, { metadata: meta });
    const sessions = new FakeSessions();
    sessions.seed(profileAId, serverAUrl, serverAId);
    const events: string[] = [];
    const api = apiFixture("a", meta, []);
    const { app } = createApp({
      profiles: new FakeProfiles([selected], profileAId),
      sessions,
      apis: new Map([[serverAUrl, api]]),
      runtimeFactory: () => fakeRuntime(events),
    });
    await app.start();
    await app.selectRoom(roomId);

    await expect(app.batchInvite([otherUserId])).resolves.toEqual([
      expect.objectContaining({ userId: otherUserId, status: "CREATED" }),
    ]);
    await app.decideJoinRequest(requestId, "APPROVE", clientOpId);
    await app.leaveMediaGroup(playbackGroupId);
    await app.closeMediaGroup(playbackGroupId);
    await app.takeOverMediaDevice(playbackGroupId);
    expect(events).toEqual(
      expect.arrayContaining([
        `media:leave:${playbackGroupId}`,
        `media:close:${playbackGroupId}`,
        `media:takeover:${playbackGroupId}`,
      ]),
    );

    await app.transferOwnership(otherUserId);
    expect((await app.getStatus()).roomDetail?.role).toBe("MEMBER");

    const sessions2 = new FakeSessions();
    sessions2.seed(profileAId, serverAUrl, serverAId);
    const api2 = apiFixture("a2", meta, []);
    const { app: ownerApp } = createApp({
      profiles: new FakeProfiles([selected], profileAId),
      sessions: sessions2,
      apis: new Map([[serverAUrl, api2]]),
    });
    await ownerApp.start();
    await ownerApp.selectRoom(roomId);
    await ownerApp.dissolveRoom();
    expect(api2.dissolveRoom).toHaveBeenCalledWith(`access-${profileAId}`, roomId);
    expect(await ownerApp.getStatus()).toMatchObject({
      phase: "AUTHENTICATED_NO_ROOM",
      selectedRoomId: null,
    });
  });

  it("passes explicit capability gates to the runtime and ignores unknown tokens", async () => {
    const meta = metadata(serverAId, {
      capabilities: ["future-capability"],
    });
    const selected = profile(profileAId, serverAUrl, serverAId, { metadata: meta });
    const sessions = new FakeSessions();
    sessions.seed(profileAId, serverAUrl, serverAId);
    let runtimeInput: RoomRuntimeFactoryInput | undefined;
    const { app } = createApp({
      profiles: new FakeProfiles([selected], profileAId),
      sessions,
      apis: new Map([[serverAUrl, apiFixture("a", meta, [])]]),
      runtimeFactory: (input) => {
        runtimeInput = input;
        return fakeRuntime([]);
      },
    });
    await app.start();
    await app.selectRoom(roomId);
    const listener = vi.fn();
    app.subscribe(listener);
    runtimeInput?.onStatusChanged?.();

    expect(runtimeInput).toMatchObject({
      serverCapabilities: [],
      enableVolatilePointer: false,
      enableContentCompatibility: false,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(["room", "collaboration"]);
    listener.mockClear();
    await app.handleActiveTabChanged(42);
    await app.handlePagePermissionBoundaryChanged();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(await app.getStatus()).toMatchObject({
      publicRoomsUnavailableReason: "SERVER_CAPABILITY_PUBLIC_ROOMS_UNAVAILABLE",
      pointerUnavailableReason: "SERVER_CAPABILITY_VOLATILE_POINTER_UNAVAILABLE",
      contentCompatibilityUnavailableReason: "SERVER_CAPABILITY_CONTENT_COMPATIBILITY_UNAVAILABLE",
    });
  });
});
