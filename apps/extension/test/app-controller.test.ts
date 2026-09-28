import type { BrowserActuatorResult, BrowserObserverResult } from "@syncaction/browser-sync";
import {
  PageCompatibilityReportSchema,
  PlaybackGroupSnapshotSchema,
  type PageCompatibilityReport,
} from "@syncaction/protocol";
import { describe, expect, it, vi } from "vitest";
import type {
  PublicAccount,
  PublicReceivedInvitation,
  PublicRoom,
  PublicRoomDetail,
  PublicSessionResponse,
  SyncActionApiClient,
} from "../src/api-client.js";
import {
  ExtensionAppController,
  LEGACY_PRODUCT_SELECTION_STORAGE_KEY,
  PRODUCT_SELECTION_STORAGE_KEY,
  type ExtensionAppStorageArea,
  type ExtensionProductSessionPort,
  type RoomRuntime,
} from "../src/app-controller.js";
import type { ExtensionProductSession, ExtensionSessionStatus } from "../src/product-session.js";
import type { ExtensionStatus } from "../src/background-controller.js";
import {
  DanmakuSubmitMessageSchema,
  DrawingDraftControlMessageSchema,
  DrawingSelectionMessageSchema,
  MediaObservedMessageSchema,
  StrokeFinalMessageSchema,
  type PageCapabilityReport,
} from "../src/page-collaboration/messages.js";

const serverUrl = "https://syncaction.example.com";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const firstRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const secondRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const playbackGroupId = "00000000-0000-4000-8000-000000000101";
const proposalId = "00000000-0000-4000-8000-000000000102";

const account: PublicAccount = {
  id: userId,
  username: "alex",
  displayName: "Alex",
  status: "ACTIVE",
  passwordResetRequired: false,
  createdAt: "2026-07-27T00:00:00.000Z",
};

function room(id: string, name: string, role: "OWNER" | "MEMBER" = "OWNER"): PublicRoom {
  return {
    id: id as PublicRoom["id"],
    name,
    role,
    roomEpoch: 0,
    visibility: "PRIVATE",
    joinPolicy: "INVITE_ONLY",
    roomRevision: 0,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

const rooms = [room(firstRoomId, "产品研究"), room(secondRoomId, "资料整理", "MEMBER")];

function detail(value: PublicRoom): PublicRoomDetail {
  return {
    ...value,
    members: [
      {
        userId,
        username: "alex",
        displayName: "Alex",
        role: value.role,
        joinedAt: "2026-07-27T00:00:00.000Z",
      },
    ],
    pendingInvitations: value.role === "OWNER" ? [] : null,
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

class FakeSessions implements ExtensionProductSessionPort {
  public status: ExtensionSessionStatus = { kind: "SIGNED_OUT" };
  public stored: ExtensionProductSession | null = null;
  public readonly events: string[];

  public constructor(events: string[]) {
    this.events = events;
  }

  public async establish(input: {
    profileId: unknown;
    serverUrl: unknown;
    serverId: unknown;
    deviceId: unknown;
    response: PublicSessionResponse;
  }): Promise<ExtensionProductSession> {
    this.events.push("session:establish");
    this.status = {
      kind: "AUTHENTICATED",
      account: input.response.account,
      deviceId: String(input.deviceId),
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    this.stored = {
      version: 2,
      profileId: String(input.profileId),
      serverUrl: String(input.serverUrl) as ExtensionProductSession["serverUrl"],
      serverId:
        input.serverId === null
          ? null
          : (String(input.serverId) as ExtensionProductSession["serverId"]),
      deviceId: String(input.deviceId) as ExtensionProductSession["deviceId"],
      sessionId: input.response.sessionId,
      accessToken: input.response.accessToken,
      accessTokenExpiresAt: 2,
      refreshToken: input.response.refreshToken,
      refreshTokenExpiresAt: 3,
      account: input.response.account,
    };
    return this.stored!;
  }

  public async read(_profileId: unknown): Promise<ExtensionProductSession | null> {
    void _profileId;
    return this.stored;
  }

  public async getStatus(_profileId: unknown): Promise<ExtensionSessionStatus> {
    void _profileId;
    return this.status;
  }

  public async getAccessToken(_profileId: unknown): Promise<string> {
    void _profileId;
    return "access-token";
  }

  public async runAuthenticated<T>(
    _profileId: unknown,
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    void _profileId;
    return operation("access-token");
  }

  public async updateAccount(_profileId: unknown, nextAccount: PublicAccount): Promise<void> {
    void _profileId;
    if (this.stored === null || this.status.kind !== "AUTHENTICATED") {
      throw new Error("SESSION_REQUIRED");
    }
    this.stored = { ...this.stored, account: structuredClone(nextAccount) };
    this.status = { ...this.status, account: structuredClone(nextAccount) };
  }

  public async clear(_profileId: unknown): Promise<void> {
    void _profileId;
    this.events.push("session:clear");
    this.status = { kind: "SIGNED_OUT" };
    this.stored = null;
  }
}

class FakeRuntime implements RoomRuntime {
  public mediaObservedBarrier: Promise<void> | undefined;

  public constructor(
    public readonly roomId: string,
    private readonly events: string[],
    private readonly failStart = false,
    private readonly status?: ExtensionStatus,
  ) {}

  public async start(): Promise<void> {
    this.events.push(`start:${this.roomId}`);
    if (this.failStart) {
      throw new Error("room start failed");
    }
  }

  public async stop(): Promise<void> {
    this.events.push(`stop:${this.roomId}`);
  }

  public async getStatus(): Promise<ExtensionStatus> {
    return (
      this.status ?? {
        state: "SYNCED",
        roomName: this.roomId,
        serverSeq: 0,
        sharedTabCount: 0,
        outboxCount: 0,
        pendingConfirmationCount: 0,
        bindingCount: 0,
        browser: null,
        presence: null,
        pointer: null,
        media: null,
        tabs: [],
      }
    );
  }

  public async handleBrowserEvent(): Promise<BrowserObserverResult | undefined> {
    this.events.push(`browser:${this.roomId}`);
    return { kind: "IGNORED", reason: "PERSONAL_TAB" };
  }

  public async handleActiveTabChanged(): Promise<void> {
    this.events.push(`active:${this.roomId}`);
  }

  public async handlePointerPageReady(tabId: unknown): Promise<void> {
    this.events.push(`pointer-ready:${this.roomId}:${String(tabId)}`);
  }

  public async handlePageCompatibilityReport(
    tabId: unknown,
    report: PageCompatibilityReport,
  ): Promise<void> {
    this.events.push(`page-compatibility:${this.roomId}:${String(tabId)}:${report.logicalTabId}`);
  }

  public async handleMediaPageReady(
    tabId: unknown,
    frameId: unknown = 0,
    frameKey: unknown = "top",
  ): Promise<void> {
    this.events.push(
      `media-ready:${this.roomId}:${String(tabId)}:${String(frameId)}:${String(frameKey)}`,
    );
  }

  public async handleMediaObserved(tabId: unknown, frameId: unknown): Promise<void> {
    this.events.push(`media-observed:${this.roomId}:${String(tabId)}:${String(frameId)}`);
    await this.mediaObservedBarrier;
  }

  public async handlePointerLocalSample(tabId: unknown): Promise<void> {
    this.events.push(`pointer-sample:${this.roomId}:${String(tabId)}`);
  }

  public async handlePageCapability(report: PageCapabilityReport): Promise<void> {
    this.events.push(
      `page-capability:${this.roomId}:${String(report.tabId)}:${String(report.frameId)}:${report.message.capability}:${report.message.state}:${String(report.message.errorCode)}`,
    );
  }

  public async handlePagePermissionBoundaryChanged(): Promise<void> {
    this.events.push(`page-permission-boundary:${this.roomId}`);
  }

  public async jumpToMediaMember(targetUserId: string): Promise<void> {
    this.events.push(`media-jump:${this.roomId}:${targetUserId}`);
  }

  public async alignMediaGroupOnce(targetPlaybackGroupId: string): Promise<void> {
    this.events.push(`media-align:${this.roomId}:${targetPlaybackGroupId}`);
  }

  public async joinMediaGroup(targetPlaybackGroupId: string): Promise<void> {
    this.events.push(`media-join:${this.roomId}:${targetPlaybackGroupId}`);
  }

  public async leaveMediaGroup(targetPlaybackGroupId?: string): Promise<void> {
    this.events.push(`media-leave:${this.roomId}:${String(targetPlaybackGroupId)}`);
  }

  public async closeMediaGroup(targetPlaybackGroupId?: string): Promise<void> {
    this.events.push(`media-close:${this.roomId}:${String(targetPlaybackGroupId)}`);
  }

  public async takeOverMediaDevice(targetPlaybackGroupId: string): Promise<void> {
    this.events.push(`media-takeover:${this.roomId}:${targetPlaybackGroupId}`);
  }

  public async activateLogicalTab(logicalTabId: string): Promise<void> {
    this.events.push(`tab-activate:${this.roomId}:${logicalTabId}`);
  }

  public async decideMediaProposal(
    targetPlaybackGroupId: string,
    targetProposalId: string,
    decision: "APPROVE" | "REJECT",
  ): Promise<void> {
    this.events.push(
      `media-decide:${this.roomId}:${targetPlaybackGroupId}:${targetProposalId}:${decision}`,
    );
  }

  public async toggleDanmakuInput(): Promise<void> {
    this.events.push(`danmaku-toggle:${this.roomId}`);
  }

  public async setDanmakuHidden(hidden: boolean): Promise<void> {
    this.events.push(`danmaku-hidden:${this.roomId}:${String(hidden)}`);
  }

  public async togglePagePen(): Promise<void> {
    this.events.push(`pen-toggle:${this.roomId}`);
  }

  public async shareBrowserTab(): Promise<BrowserObserverResult | undefined> {
    return { kind: "IGNORED", reason: "PERSONAL_TAB" };
  }

  public async confirmBrowserRecovery(): Promise<BrowserActuatorResult | undefined> {
    return { kind: "SYNCHRONIZED", effectsApplied: 0 };
  }
}

function sessionResponse(): PublicSessionResponse {
  return {
    sessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
    accessToken: "access-token",
    refreshToken: "A".repeat(43),
    expiresInSeconds: 900,
    refreshExpiresInSeconds: 2_592_000,
    account,
  };
}

function createApi() {
  return {
    register: vi.fn().mockResolvedValue({ ...account, status: "PENDING" as const }),
    login: vi.fn().mockResolvedValue(sessionResponse()),
    refresh: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    listRooms: vi.fn().mockResolvedValue(rooms),
    createRoom: vi.fn(),
    getRoom: vi.fn(async (_token: string, roomId: unknown) => {
      const found = rooms.find((candidate) => candidate.id === roomId);
      if (found === undefined) {
        throw new Error("ROOM_NOT_FOUND");
      }
      return detail(found);
    }),
    listInvitations: vi.fn().mockResolvedValue([] as PublicReceivedInvitation[]),
    acceptInvitation: vi.fn(),
    invite: vi.fn(),
  } satisfies Pick<
    SyncActionApiClient,
    | "register"
    | "login"
    | "refresh"
    | "logout"
    | "listRooms"
    | "createRoom"
    | "getRoom"
    | "listInvitations"
    | "acceptInvitation"
    | "invite"
  >;
}

describe("ExtensionAppController", () => {
  it("starts signed out without constructing a room runtime", async () => {
    const events: string[] = [];
    const runtimeFactory = vi.fn();
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions: new FakeSessions(events),
      api: createApi(),
      runtimeFactory,
    });

    await app.start();

    expect(await app.getStatus()).toMatchObject({
      phase: "SIGNED_OUT",
      account: null,
      rooms: [],
      room: null,
      collaboration: {
        capacity: {
          openTabCount: 0,
          limit: 20,
          exemption: "UNKNOWN",
        },
        navigation: {
          canJump: false,
          disabledReason: "同步跳转功能尚未启用",
        },
        pages: [],
        members: [],
        playbackGroups: [],
        tools: [],
        proposals: [],
        annotation: {
          used: 0,
          capacity: null,
          lockedCount: 0,
          state: "UNAVAILABLE",
          canCreate: false,
        },
        activities: [],
      },
    });
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("routes pointer page readiness and samples only through the active room runtime", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events),
    });
    await app.start();
    await app.selectRoom(firstRoomId);
    events.length = 0;

    await app.handlePointerPageReady(7);
    await app.handlePointerLocalSample(7, {
      type: "pointer.sample",
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      anchor: null,
      viewport: { x: 0.5, y: 0.5 },
    });
    await app.handlePageCapability({
      tabId: 7,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      },
    });
    await app.handlePageCompatibilityReport(
      7,
      PageCompatibilityReportSchema.parse({
        type: "page.compatibility.report",
        protocolVersion: 1,
        logicalTabId: "018f8f8e-4b5c-7d6e-8f90-123456789aa1",
        contentContext: {
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
          canonicalPageIdentity: "url:https://example.com/",
          contentSignature: {
            signatureVersion: 1,
            digest: "A".repeat(43),
          },
          media: null,
        },
      }),
    );
    await app.handlePagePermissionBoundaryChanged();

    expect(events).toEqual([
      `pointer-ready:${firstRoomId}:7`,
      `pointer-sample:${firstRoomId}:7`,
      `page-capability:${firstRoomId}:7:0:PAGE_HOST:DEGRADED:PAGE_HOST_CONFLICT`,
      `page-compatibility:${firstRoomId}:7:018f8f8e-4b5c-7d6e-8f90-123456789aa1`,
      `page-permission-boundary:${firstRoomId}`,
    ]);
  });

  it("serializes media side-panel actions through only the active room runtime", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events),
    });
    await app.start();
    await app.selectRoom(firstRoomId);
    events.length = 0;

    await app.jumpToMediaMember(userId);
    await app.alignMediaGroupOnce(playbackGroupId);
    await app.joinMediaGroup(playbackGroupId);
    await app.leaveMediaGroup(playbackGroupId);
    await app.closeMediaGroup(playbackGroupId);
    await app.takeOverMediaDevice(playbackGroupId);
    await app.activateLogicalTab("00000000-0000-4000-8000-000000000103");
    await app.decideMediaProposal(playbackGroupId, proposalId, "APPROVE");

    expect(events).toEqual([
      `media-jump:${firstRoomId}:${userId}`,
      `media-align:${firstRoomId}:${playbackGroupId}`,
      `media-join:${firstRoomId}:${playbackGroupId}`,
      `media-leave:${firstRoomId}:${playbackGroupId}`,
      `media-close:${firstRoomId}:${playbackGroupId}`,
      `media-takeover:${firstRoomId}:${playbackGroupId}`,
      `tab-activate:${firstRoomId}:00000000-0000-4000-8000-000000000103`,
      `media-decide:${firstRoomId}:${playbackGroupId}:${proposalId}:APPROVE`,
    ]);
  });

  it("exposes shortcut-equivalent page tool actions through only the active room runtime", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events),
    });
    await app.start();
    await app.selectRoom(firstRoomId);
    events.length = 0;

    await app.toggleDanmakuInput();
    await app.setDanmakuHidden(true);
    await app.togglePagePen();

    expect(events).toEqual([
      `danmaku-toggle:${firstRoomId}`,
      `danmaku-hidden:${firstRoomId}:true`,
      `pen-toggle:${firstRoomId}`,
    ]);
  });

  it("rejects durable page input when the active room runtime lacks its controller", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events),
    });
    await app.start();
    await app.selectRoom(firstRoomId);
    const pageContext = {
      roomId: firstRoomId,
      logicalTabId: "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
      documentRevision: { roomEpoch: 1, tabUpdatedAtSeq: 2 },
      frameKey: "top" as const,
    };

    await expect(
      app.handleDanmakuSubmit(
        7,
        0,
        DanmakuSubmitMessageSchema.parse({
          type: "syncaction.danmaku.submit",
          controller: "danmaku",
          context: pageContext,
          messageId: "018f8f8e-4b5c-7d6e-8f90-123456789ac2",
          text: "不得静默接受",
        }),
      ),
    ).rejects.toThrow("DANMAKU_CONTROLLER_UNAVAILABLE");
    await expect(
      app.handleStrokeFinal(
        7,
        0,
        StrokeFinalMessageSchema.parse({
          type: "syncaction.stroke.final",
          controller: "drawing",
          context: pageContext,
          stroke: {
            strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789ac3",
            frameKey: "top",
            anchor: {
              type: "document",
              layoutSignature: { widthCssPx: 1280, heightCssPx: 1800 },
            },
            points: [
              { x: 0.1, y: 0.2, pressure: 0.5 },
              { x: 0.2, y: 0.3, pressure: 0.6 },
            ],
            rgb: { r: 0, g: 122, b: 255 },
            width: 6,
          },
        }),
      ),
    ).rejects.toThrow("DRAWING_CONTROLLER_UNAVAILABLE");
    await expect(
      app.handleDrawingSelection(
        7,
        0,
        DrawingSelectionMessageSchema.parse({
          type: "syncaction.drawing.selection",
          controller: "drawing",
          context: pageContext,
          action: "DELETE",
          items: [
            {
              strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789ac3",
              expectedVersion: 1,
            },
          ],
        }),
      ),
    ).rejects.toThrow("DRAWING_CONTROLLER_UNAVAILABLE");
    await expect(
      app.handleDrawingDraftControl(
        7,
        0,
        DrawingDraftControlMessageSchema.parse({
          type: "syncaction.annotation.draft.control",
          controller: "drawing",
          context: pageContext,
          action: "DISCARD",
          strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789ac3",
        }),
      ),
    ).rejects.toThrow("DRAWING_CONTROLLER_UNAVAILABLE");
  });

  it("deduplicates a pending media gesture before app serialization and releases it on replacement", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const runtimes: FakeRuntime[] = [];
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => {
        const runtime = new FakeRuntime(room.id, events);
        runtimes.push(runtime);
        return runtime;
      },
    });
    await app.start();
    await app.selectRoom(firstRoomId);
    events.length = 0;

    const gate = deferred<void>();
    runtimes[0]!.mediaObservedBarrier = gate.promise;
    const message = MediaObservedMessageSchema.parse({
      type: "syncaction.media.observed",
      event: "STATE_CHANGED",
      context: {
        roomId: firstRoomId,
        logicalTabId: "018f8f8e-4b5c-7d6e-8f90-123456789ab6",
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 4 },
        frameKey: "top",
      },
      target: {
        logicalTabId: "018f8f8e-4b5c-7d6e-8f90-123456789ab6",
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 4 },
        frameKey: "top",
        provider: "HTML5",
        mediaKey: "html5:primary",
        durationMs: 100_000,
      },
      observed: {
        observedAtClientMs: 1_700_000_000_000,
        positionMs: 42_000,
        paused: true,
        playbackRate: 1,
        ended: false,
        buffering: false,
      },
      applyToken: null,
      trigger: "PAUSED",
      resultCode: null,
    });

    const first = app.handleMediaObserved(7, 0, message);
    await settleMicrotasks();
    const duplicate = app.handleMediaObserved(7, 0, message);
    await settleMicrotasks();
    expect(events).toEqual([`media-observed:${firstRoomId}:7:0`]);

    gate.resolve();
    await Promise.all([first, duplicate]);
    expect(events).toEqual([`media-observed:${firstRoomId}:7:0`]);

    await app.selectRoom(secondRoomId);
    events.length = 0;
    await app.handleMediaObserved(7, 0, message);
    expect(events).toEqual([`media-observed:${secondRoomId}:7:0`]);
  });

  it("logs in, stores the session, and exposes rooms without leaking tokens", async () => {
    const events: string[] = [];
    const api = createApi();
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions: new FakeSessions(events),
      api,
      runtimeFactory: vi.fn(),
    });

    await app.start();
    await app.login({ username: "alex", password: "correct horse battery" });

    const status = await app.getStatus();
    expect(status).toMatchObject({
      phase: "AUTHENTICATED_NO_ROOM",
      account: { username: "alex" },
      rooms: [{ id: firstRoomId }, { id: secondRoomId }],
      selectedRoomId: null,
    });
    expect(JSON.stringify(status)).not.toContain("access-token");
    expect(JSON.stringify(status)).not.toContain("correct horse battery");
    expect(events).toEqual(["session:establish"]);
    expect(api.login).toHaveBeenCalledWith({
      username: "alex",
      password: "correct horse battery",
      deviceId,
    });
  });

  it("keeps a submitted registration visibly pending while no session exists", async () => {
    const events: string[] = [];
    const api = createApi();
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions: new FakeSessions(events),
      api,
      runtimeFactory: vi.fn(),
    });
    await app.start();

    await app.register({
      username: "alex",
      displayName: "Alex",
      password: "correct horse battery",
    });

    expect(await app.getStatus()).toMatchObject({
      phase: "ACCOUNT_PENDING",
      account: { username: "alex", status: "PENDING" },
      room: null,
    });
  });

  it("recovers a valid account-bound room selection after a worker restart", async () => {
    const events: string[] = [];
    const area = new MemoryArea();
    area.values[LEGACY_PRODUCT_SELECTION_STORAGE_KEY] = {
      version: 1,
      userId,
      roomId: firstRoomId,
    };
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const runtimeFactory = vi.fn(({ room }: { room: PublicRoom }) => {
      return new FakeRuntime(room.id, events);
    });
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area,
      sessions,
      api: createApi(),
      runtimeFactory,
    });

    await app.start();

    expect(events).toEqual([`start:${firstRoomId}`]);
    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
      }),
    );
    expect(await app.getStatus()).toMatchObject({
      phase: "ROOM_ACTIVE",
      selectedRoomId: firstRoomId,
      roomDetail: { id: firstRoomId },
      room: { state: "SYNCED" },
    });
    expect(area.values).not.toHaveProperty(LEGACY_PRODUCT_SELECTION_STORAGE_KEY);
    expect(area.values[PRODUCT_SELECTION_STORAGE_KEY]).toEqual({
      version: 2,
      byProfile: {
        "syncaction-production": {
          userId,
          roomId: firstRoomId,
        },
      },
    });
  });

  it("removes a legacy selection owned by a different account instead of migrating it", async () => {
    const area = new MemoryArea();
    area.values[LEGACY_PRODUCT_SELECTION_STORAGE_KEY] = {
      version: 1,
      userId: "018f8f8e-4b5c-7d6e-8f90-123456789aff",
      roomId: firstRoomId,
    };
    const sessions = new FakeSessions([]);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area,
      sessions,
      api: createApi(),
      runtimeFactory: vi.fn(),
    });

    await app.start();

    await expect(app.getStatus()).resolves.toMatchObject({
      phase: "AUTHENTICATED_NO_ROOM",
      selectedRoomId: null,
    });
    expect(area.values).not.toHaveProperty(LEGACY_PRODUCT_SELECTION_STORAGE_KEY);
    expect(area.values[PRODUCT_SELECTION_STORAGE_KEY]).toBeUndefined();
  });

  it("stops the previous room before starting a newly selected room", async () => {
    const events: string[] = [];
    const area = new MemoryArea();
    area.values[PRODUCT_SELECTION_STORAGE_KEY] = {
      version: 2,
      byProfile: {
        "syncaction-production": {
          userId,
          roomId: firstRoomId,
        },
      },
    };
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area,
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events),
    });
    await app.start();

    await app.selectRoom(secondRoomId);

    expect(events).toEqual([
      `start:${firstRoomId}`,
      `stop:${firstRoomId}`,
      `start:${secondRoomId}`,
    ]);
    expect(area.values[PRODUCT_SELECTION_STORAGE_KEY]).toEqual({
      version: 2,
      byProfile: {
        "syncaction-production": {
          userId,
          roomId: secondRoomId,
        },
      },
    });
  });

  it("persists and clears selected rooms only inside the active server profile", async () => {
    const area = new MemoryArea();
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const firstSessions = new FakeSessions(firstEvents);
    const secondSessions = new FakeSessions(secondEvents);
    firstSessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    secondSessions.status = structuredClone(firstSessions.status);
    const first = new ExtensionAppController({
      profileId: "server-a",
      serverUrl: "https://a.example",
      serverId: "018f8f8e-4b5c-7d6e-8f90-123456789c01",
      deviceId,
      area,
      sessions: firstSessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, firstEvents),
    });
    const second = new ExtensionAppController({
      profileId: "server-b",
      serverUrl: "https://b.example",
      serverId: "018f8f8e-4b5c-7d6e-8f90-123456789c02",
      deviceId,
      area,
      sessions: secondSessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, secondEvents),
    });
    await first.start();
    await second.start();
    await first.selectRoom(firstRoomId);
    await second.selectRoom(secondRoomId);

    expect(area.values[PRODUCT_SELECTION_STORAGE_KEY]).toEqual({
      version: 2,
      byProfile: {
        "server-a": { userId, roomId: firstRoomId },
        "server-b": { userId, roomId: secondRoomId },
      },
    });

    await first.logout();
    expect(area.values[PRODUCT_SELECTION_STORAGE_KEY]).toEqual({
      version: 2,
      byProfile: {
        "server-b": { userId, roomId: secondRoomId },
      },
    });

    const restartedSessions = new FakeSessions(secondEvents);
    restartedSessions.status = structuredClone(secondSessions.status);
    const restartedSecond = new ExtensionAppController({
      profileId: "server-b",
      serverUrl: "https://b.example",
      serverId: "018f8f8e-4b5c-7d6e-8f90-123456789c02",
      deviceId,
      area,
      sessions: restartedSessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, secondEvents),
    });
    await restartedSecond.start();
    await expect(restartedSecond.getStatus()).resolves.toMatchObject({
      phase: "ROOM_ACTIVE",
      selectedRoomId: secondRoomId,
    });
  });

  it("stops browser actuation before logout and clears local credentials even if logout fails", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    sessions.stored = {
      version: 2,
      profileId: "syncaction-production",
      serverUrl,
      serverId: null,
      deviceId: deviceId as ExtensionProductSession["deviceId"],
      sessionId: sessionResponse().sessionId,
      accessToken: "access-token",
      accessTokenExpiresAt: 2,
      refreshToken: "A".repeat(43),
      refreshTokenExpiresAt: 3,
      account,
    };
    const api = createApi();
    api.logout.mockImplementation(async () => {
      events.push("api:logout");
      throw new Error("offline");
    });
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api,
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events),
    });
    await app.start();
    await app.selectRoom(firstRoomId);
    events.length = 0;

    await expect(app.logout()).resolves.toBeUndefined();

    expect(events).toEqual([`stop:${firstRoomId}`, "api:logout", "session:clear"]);
    expect((await app.getStatus()).phase).toBe("SIGNED_OUT");
  });

  it("leaves no runtime active when a room switch fails", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events, room.id === secondRoomId),
    });
    await app.start();
    await app.selectRoom(firstRoomId);
    events.length = 0;

    await expect(app.selectRoom(secondRoomId)).rejects.toThrow("room start failed");

    expect(events).toEqual([
      `stop:${firstRoomId}`,
      `start:${secondRoomId}`,
      `stop:${secondRoomId}`,
    ]);
    expect(await app.getStatus()).toMatchObject({
      phase: "ERROR",
      room: null,
      errorCode: "ROOM_START_FAILED",
    });
    await app.handleBrowserEvent({ type: "TAB_UPDATED", tabId: 1 });
    expect(events).not.toContain(`browser:${secondRoomId}`);
  });

  it("projects room pages, unique member presence, and degraded tools into a safe collaboration summary", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
    const runtimeStatus: ExtensionStatus = {
      state: "SYNCED",
      roomName: "产品研究",
      serverSeq: 4,
      sharedTabCount: 1,
      outboxCount: 0,
      pendingConfirmationCount: 0,
      bindingCount: 1,
      browser: null,
      presence: {
        state: "ONLINE",
        lastAckExpiresAt: 10_000,
        errorCode: null,
        presences: [
          {
            userId,
            username: "alex",
            displayName: "Alex",
            deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789ab7" as NonNullable<
              ExtensionStatus["presence"]
            >["presences"][number]["deviceId"],
            logicalTabId: logicalTabId as NonNullable<
              ExtensionStatus["presence"]
            >["presences"][number]["logicalTabId"],
            expiresAt: 9_000,
          },
          {
            userId,
            username: "alex",
            displayName: "Alex",
            deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789ab8" as NonNullable<
              ExtensionStatus["presence"]
            >["presences"][number]["deviceId"],
            logicalTabId: logicalTabId as NonNullable<
              ExtensionStatus["presence"]
            >["presences"][number]["logicalTabId"],
            expiresAt: 9_000,
          },
        ],
        compatibilities: [
          {
            userId,
            deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789ab7",
            logicalTabId,
            compatibility: "EXACT",
            warning: false,
          },
          {
            userId,
            deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789ab8",
            logicalTabId,
            compatibility: "MISMATCH",
            warning: true,
          },
        ],
      },
      pointer: {
        state: "DEGRADED",
        lastAckExpiresAt: null,
        errorCode: "POINTER_PERMISSION_REQUIRED",
      },
      media: null,
      danmaku: {
        state: "ONLINE",
        errorCode: null,
        lastMessageId: null,
        ready: true,
        canRetry: false,
        hidden: false,
        inputOpen: false,
      },
      drawing: {
        state: "DEGRADED",
        errorCode: "ANNOTATION_PAGE_CAPACITY_REACHED",
        pageKey: "A".repeat(43),
        used: 2_000,
        capacity: 2_000,
        lockedCount: 3,
        capacityState: "FULL",
        canCreate: false,
        pendingDraftCount: 1,
        errorDraftCount: 1,
        unlocatableCount: 2,
        ready: true,
        canRetry: false,
        active: true,
        tool: "PEN",
        rgb: { r: 0, g: 122, b: 255 },
        width: 6,
        selectedCount: 0,
        selectedLockedCount: 0,
      },
      tabs: [
        {
          logicalTabId,
          title: "设计规范",
          domain: "example.com",
        },
      ],
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events, false, runtimeStatus),
    });
    await app.start();
    await app.selectRoom(firstRoomId);

    const status = await app.getStatus();

    expect(status.collaboration).toEqual({
      capacity: {
        openTabCount: 1,
        limit: 20,
        exemption: "UNKNOWN",
      },
      navigation: {
        canJump: false,
        disabledReason: "同步跳转功能尚未启用",
      },
      pages: [
        {
          pageId: logicalTabId,
          title: "设计规范",
          domain: "example.com",
          state: "OPEN",
          compatibility: "MISMATCH",
          compatibilityWarning: "页面内容与部分成员不同，坐标协作已保护性暂停",
        },
      ],
      members: [
        {
          userId,
          displayName: "Alex",
          roomRole: "OWNER",
          online: true,
          deviceCount: 2,
          activePageIds: [logicalTabId],
        },
      ],
      playbackGroups: [],
      tools: [
        {
          toolId: "pointer",
          kind: "POINTER",
          state: "DEGRADED",
          statusText: "当前站点未授权同页光标",
          errorCode: "POINTER_PERMISSION_REQUIRED",
          canActivate: true,
          disabledReason: null,
        },
        {
          toolId: "danmaku",
          kind: "DANMAKU",
          state: "AVAILABLE",
          statusText: "页面弹幕可用",
          errorCode: null,
          canActivate: true,
          disabledReason: null,
        },
        {
          toolId: "drawing",
          kind: "DRAWING",
          state: "DEGRADED",
          statusText: "页面画笔受限",
          errorCode: "ANNOTATION_PAGE_CAPACITY_REACHED",
          canActivate: true,
          disabledReason: null,
        },
      ],
      proposals: [],
      annotation: {
        used: 2_000,
        capacity: 2_000,
        lockedCount: 3,
        state: "FULL",
        canCreate: false,
        disabledReason: "页面涂鸦容量已满，请先删除不需要的涂鸦",
      },
      activities: [],
    });
    expect(status.collaboration.pages[0]).not.toHaveProperty("activeUserIds");
    expect(status.collaboration.members[0]).not.toHaveProperty("username");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain('"password":');
    expect(serialized).not.toContain("https://example.com/");
  });

  it("projects playback groups, participants, proposals, and bounded jump capability", async () => {
    const events: string[] = [];
    const sessions = new FakeSessions(events);
    sessions.status = {
      kind: "AUTHENTICATED",
      account,
      deviceId,
      accessTokenExpiresAt: 2,
      refreshTokenExpiresAt: 3,
    };
    const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
    const followerId = "018f8f8e-4b5c-7d6e-8f90-123456789ab7";
    const followerDevice = "018f8f8e-4b5c-7d6e-8f90-123456789ab8";
    const target = {
      logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 4 },
      frameKey: "top",
      provider: "YOUTUBE" as const,
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 212_000,
    };
    const playbackGroup = PlaybackGroupSnapshotSchema.parse({
      playbackGroupId,
      roomId: firstRoomId,
      groupRevision: 4,
      status: "PLAYING",
      leaderUserId: userId,
      leaderDeviceId: deviceId,
      members: [
        {
          userId,
          username: "alex",
          displayName: "Alex",
          activeDeviceId: deviceId,
          joinedAtServerMs: 1_700_000_000_000,
          online: true,
        },
        {
          userId: followerId,
          username: "follower",
          displayName: "Follower",
          activeDeviceId: followerDevice,
          joinedAtServerMs: 1_700_000_000_001,
          online: true,
        },
      ],
      target,
      observed: {
        observedAtClientMs: 1_700_000_000_000,
        positionMs: 42_000,
        paused: false,
        playbackRate: 1,
        ended: false,
        buffering: false,
      },
      observedAtServerMs: 1_700_000_000_000,
      proposals: [
        {
          proposalId: "00000000-0000-4000-8000-000000000102",
          proposedByUserId: followerId,
          proposedByDeviceId: followerDevice,
          baseGroupRevision: 4,
          action: { type: "SEEK", positionMs: 50_000 },
          createdAtServerMs: 1_700_000_000_000,
          expiresAtServerMs: 1_700_000_030_000,
        },
      ],
      leaderGraceExpiresAtServerMs: null,
      updatedAtServerMs: 1_700_000_000_000,
    });
    const runtimeStatus: ExtensionStatus = {
      state: "SYNCED",
      roomName: "产品研究",
      serverSeq: 4,
      sharedTabCount: 1,
      outboxCount: 0,
      pendingConfirmationCount: 0,
      bindingCount: 1,
      browser: null,
      presence: null,
      pointer: null,
      media: {
        state: "ONLINE",
        roomMediaRevision: 4,
        playbackGroups: [playbackGroup],
        localObservation: null,
        localMembership: {
          playbackGroupId,
          role: "LEADER",
          activeDevice: true,
        },
        recommendedPlaybackGroupId: null,
        navigation: [
          {
            userId: followerId,
            deviceId: followerDevice,
            logicalTabId,
            canJump: true,
            disabledReason: null,
          },
        ],
        errorCode: null,
      },
      tabs: [{ logicalTabId, title: "Existing title", domain: "youtube.com" }],
    };
    const app = new ExtensionAppController({
      serverUrl,
      deviceId,
      area: new MemoryArea(),
      sessions,
      api: createApi(),
      runtimeFactory: ({ room }) => new FakeRuntime(room.id, events, false, runtimeStatus),
    });
    await app.start();
    await app.selectRoom(firstRoomId);

    const collaboration = (await app.getStatus()).collaboration;

    expect(collaboration.navigation).toEqual({
      canJump: true,
      disabledReason: null,
    });
    expect(collaboration.playbackGroups).toEqual([
      expect.objectContaining({
        groupId: playbackGroupId,
        state: "PLAYING",
        participants: [
          expect.objectContaining({ userId, role: "LEADER" }),
          expect.objectContaining({
            userId: followerId,
            role: "FOLLOWER",
            canJump: true,
          }),
        ],
      }),
    ]);
    expect(collaboration.proposals).toEqual([
      expect.objectContaining({
        proposalId: "00000000-0000-4000-8000-000000000102",
        state: "PENDING",
        canApprove: true,
        canReject: true,
      }),
    ]);
    expect(JSON.stringify(collaboration)).not.toContain("https://");

    if (runtimeStatus.media?.localMembership === null || runtimeStatus.media === null) {
      throw new Error("expected local media membership");
    }
    runtimeStatus.media.localMembership.activeDevice = false;
    expect((await app.getStatus()).collaboration.proposals).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
