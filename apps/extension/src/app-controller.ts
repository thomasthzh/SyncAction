import type { BrowserActuatorResult, BrowserObserverResult } from "@syncaction/browser-sync";
import {
  CanonicalUuidSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  ServerCapabilitySchema,
  type Notification,
  type NotificationReadEvent,
  type ContentCompatibility,
  type DocumentRevision,
  type PageCompatibilityReport,
  type PublicRoomSummary,
  type RoomEventMessage,
  type RoomJoinPolicy,
  type RoomVisibility,
  type ServerCapability,
} from "@syncaction/protocol";
import { z } from "zod";
import type {
  BatchInvitationResult,
  DirectoryList,
  DirectorySearchInput,
  PublicAccount,
  PublicReceivedInvitation,
  PublicRoom,
  PublicRoomDetail,
  RoomMutationInput,
  SyncActionApiClient,
} from "./api-client.js";
import { SyncActionApiError } from "./api-client.js";
import type { ExtensionStatus } from "./background-controller.js";
import type { OnboardingStateStore } from "./onboarding-state.js";
import {
  ExtensionSessionRequiredError,
  type ExtensionSessionManager,
  type ExtensionSessionStatus,
} from "./product-session.js";
import type {
  DanmakuReportMessage,
  DanmakuSubmitMessage,
  DrawingDraftControlMessage,
  DrawingReportMessage,
  DrawingSelectionMessage,
  MediaObservedMessage,
  PageCapabilityReport,
  StrokeFinalMessage,
  StrokeSampleMessage,
} from "./page-collaboration/messages.js";
import type { PublicCatalogTransport } from "./public-catalog-transport.js";
import { PRODUCTION_PUBLIC_SERVER_ORIGIN, parsePublicServerOrigin } from "./server-origin.js";
import {
  DEFAULT_SERVER_PROFILE_ID,
  ServerProfileIdSchema,
  type ServerProfile,
  type ServerProfileStore,
  type VerifiedServerCandidate,
} from "./server-profile.js";
import type { UiSliceHint } from "./ui/ui-protocol.js";

export const PRODUCT_SELECTION_STORAGE_KEY = "syncaction.product-selections.v2";
export const LEGACY_PRODUCT_SELECTION_STORAGE_KEY = "syncaction.product-selection.v1";

const LegacyProductSelectionSchema = z
  .object({
    version: z.literal(1),
    userId: CanonicalUuidSchema,
    roomId: RoomIdSchema,
  })
  .strict();

const ProductSelectionSchema = z
  .object({
    userId: CanonicalUuidSchema,
    roomId: RoomIdSchema,
  })
  .strict();

const ProductSelectionCollectionSchema = z
  .object({
    version: z.literal(2),
    byProfile: z.record(ServerProfileIdSchema, ProductSelectionSchema),
  })
  .strict();

type ProductSelection = z.infer<typeof ProductSelectionSchema>;
type ProductSelectionCollection = z.infer<typeof ProductSelectionCollectionSchema>;

export interface ExtensionAppStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export type ExtensionProductApi = Pick<
  SyncActionApiClient,
  | "register"
  | "activateAccount"
  | "loginWithAccountKey"
  | "login"
  | "logout"
  | "updateProfile"
  | "changePassword"
  | "initializePassword"
  | "getMeta"
  | "getHealth"
  | "listPublicRooms"
  | "listRooms"
  | "createRoom"
  | "updateRoom"
  | "getRoom"
  | "listInvitations"
  | "acceptInvitation"
  | "invite"
  | "searchDirectory"
  | "joinOpenRoom"
  | "requestRoomJoin"
  | "cancelJoinRequest"
  | "decideJoinRequest"
  | "batchInvite"
  | "listNotifications"
  | "markNotificationRead"
  | "markNotificationsRead"
  | "getCurrentPolicyAcceptance"
  | "acceptCurrentPolicy"
  | "leaveRoom"
  | "removeMember"
  | "transferOwnership"
  | "dissolveRoom"
>;

export type LegacyExtensionProductApi = Pick<
  SyncActionApiClient,
  | "register"
  | "login"
  | "logout"
  | "listRooms"
  | "createRoom"
  | "getRoom"
  | "listInvitations"
  | "acceptInvitation"
  | "invite"
>;

export type ExtensionProductSessionPort = Pick<
  ExtensionSessionManager,
  | "establish"
  | "read"
  | "getStatus"
  | "getAccessToken"
  | "runAuthenticated"
  | "updateAccount"
  | "clear"
> &
  Partial<Pick<ExtensionSessionManager, "migrateLegacyProductionSession">>;

export type ExtensionServerProfilePort = Pick<
  ServerProfileStore,
  "initialize" | "list" | "get" | "getSelected" | "addCandidate" | "verify" | "select"
>;

export type ExtensionOnboardingPort = Pick<OnboardingStateStore, "isRequired" | "dismiss">;

export type ExtensionPublicCatalogPort = Pick<
  PublicCatalogTransport,
  "start" | "stop" | "setInvalidatedHandler"
>;

export interface RoomRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<ExtensionStatus>;
  getPageDocumentRevision?(tabIdInput: unknown): Promise<DocumentRevision | null>;
  getPageContentCompatibility?(tabIdInput: unknown): Promise<ContentCompatibility | null>;
  handleBrowserEvent(eventInput: unknown): Promise<BrowserObserverResult | undefined>;
  handleActiveTabChanged(tabIdInput: unknown): Promise<void>;
  handlePointerPageReady(tabIdInput: unknown): Promise<void>;
  handlePageCompatibilityReport?(
    tabIdInput: unknown,
    reportInput: PageCompatibilityReport,
  ): Promise<void>;
  handleMediaPageReady(
    tabIdInput: unknown,
    frameIdInput?: unknown,
    frameKeyInput?: unknown,
  ): Promise<void>;
  handlePageToolFrameReady?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
    rootGenerationInput?: unknown,
  ): Promise<void>;
  handlePageToolFrameUnavailable?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
  ): Promise<void>;
  handleMediaObserved(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: MediaObservedMessage,
  ): Promise<void>;
  handlePointerLocalSample(tabIdInput: unknown, sampleInput: unknown): Promise<void>;
  handleDanmakuSubmit?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DanmakuSubmitMessage,
  ): Promise<void>;
  handleDanmakuReport?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DanmakuReportMessage,
  ): Promise<void>;
  handleStrokeSample?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: StrokeSampleMessage,
  ): Promise<void>;
  handleStrokeFinal?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: StrokeFinalMessage,
  ): Promise<void>;
  handleDrawingSelection?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingSelectionMessage,
  ): Promise<void>;
  handleDrawingDraftControl?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingDraftControlMessage,
  ): Promise<void>;
  handleDrawingReport?(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingReportMessage,
  ): Promise<void>;
  handlePageCapability(reportInput: PageCapabilityReport): Promise<void>;
  handlePagePermissionBoundaryChanged(): Promise<void>;
  toggleDanmakuInput(): Promise<void>;
  setDanmakuHidden?(hidden: boolean): Promise<void>;
  togglePagePen(): Promise<void>;
  jumpToMediaMember(userId: string): Promise<void>;
  alignMediaGroupOnce(playbackGroupId: string): Promise<void>;
  joinMediaGroup(playbackGroupId: string): Promise<void>;
  leaveMediaGroup?(playbackGroupId?: string): Promise<void>;
  closeMediaGroup?(playbackGroupId?: string): Promise<void>;
  takeOverMediaDevice?(playbackGroupId: string): Promise<void>;
  activateLogicalTab?(logicalTabId: string): Promise<void>;
  decideMediaProposal(
    playbackGroupId: string,
    proposalId: string,
    decision: "APPROVE" | "REJECT",
  ): Promise<void>;
  shareBrowserTab(tabIdInput: unknown): Promise<BrowserObserverResult | undefined>;
  confirmBrowserRecovery(): Promise<BrowserActuatorResult | undefined>;
}

export interface RoomRuntimeFactoryInput {
  profileId?: string;
  serverId?: string | null;
  serverUrl: string;
  userId: string;
  deviceId: string;
  room: PublicRoom;
  serverCapabilities?: ServerCapability[];
  enableVolatilePointer?: boolean;
  enableContentCompatibility?: boolean;
  onRoomEvent?: (event: RoomEventMessage) => void;
  onNotificationCreated?: (notification: Notification) => void;
  onNotificationRead?: (event: NotificationReadEvent) => void;
  onStatusChanged?: () => void;
  getAccessToken(): Promise<string>;
}

export type RoomRuntimeFactory = (
  input: RoomRuntimeFactoryInput,
) => RoomRuntime | Promise<RoomRuntime>;

export type ExtensionAppPhase =
  | "SIGNED_OUT"
  | "ACCOUNT_PENDING"
  | "AUTHENTICATED_NO_ROOM"
  | "CONNECTING_ROOM"
  | "ROOM_ACTIVE"
  | "SESSION_EXPIRED"
  | "ERROR";

export interface ExtensionCollaborationCapacitySummary {
  openTabCount: number;
  limit: number | null;
  exemption: "EXEMPT" | "NOT_EXEMPT" | "UNKNOWN";
}

export interface ExtensionCollaborationNavigationSummary {
  canJump: boolean;
  disabledReason: string | null;
}

export interface ExtensionCollaborationPageSummary {
  pageId: string;
  title: string;
  domain: string;
  state: "OPEN" | "CLOSED";
  compatibility?: ContentCompatibility | undefined;
  compatibilityWarning?: string | null | undefined;
}

export interface ExtensionCollaborationMemberSummary {
  userId: string;
  displayName: string;
  roomRole: "OWNER" | "MEMBER";
  online: boolean;
  deviceCount: number;
  activePageIds: string[];
}

export interface ExtensionCollaborationGroupParticipantSummary {
  userId: string;
  role: "LEADER" | "FOLLOWER";
  statusText: string;
  canJump: boolean;
  canAlign: boolean;
  disabledReason: string | null;
}

export interface ExtensionCollaborationPlaybackGroupSummary {
  groupId: string;
  name: string;
  state: "PLAYING" | "PAUSED" | "ENDED" | "PENDING";
  statusText: string;
  participants: ExtensionCollaborationGroupParticipantSummary[];
  canJoin: boolean;
  joinDisabledReason: string | null;
}

export interface ExtensionCollaborationToolSummary {
  toolId: string;
  kind: "POINTER" | "DANMAKU" | "DRAWING";
  state: "AVAILABLE" | "ACTIVE" | "DEGRADED" | "UNAVAILABLE";
  statusText: string;
  errorCode: string | null;
  canActivate: boolean;
  disabledReason: string | null;
}

export interface ExtensionCollaborationProposalSummary {
  groupId: string;
  proposalId: string;
  title: string;
  detail: string;
  state: "PENDING" | "ACCEPTED" | "REJECTED";
  canApprove: boolean;
  canReject: boolean;
  disabledReason: string | null;
}

export interface ExtensionCollaborationAnnotationSummary {
  used: number;
  capacity: number | null;
  lockedCount: number;
  state: "AVAILABLE" | "NEAR_LIMIT" | "FULL" | "UNAVAILABLE";
  canCreate: boolean;
  disabledReason: string | null;
}

export interface ExtensionCollaborationActivitySummary {
  activityId: string;
  text: string;
  detail: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
}

export interface ExtensionCollaborationSummary {
  capacity: ExtensionCollaborationCapacitySummary;
  navigation: ExtensionCollaborationNavigationSummary;
  pages: ExtensionCollaborationPageSummary[];
  members: ExtensionCollaborationMemberSummary[];
  playbackGroups: ExtensionCollaborationPlaybackGroupSummary[];
  tools: ExtensionCollaborationToolSummary[];
  proposals: ExtensionCollaborationProposalSummary[];
  annotation: ExtensionCollaborationAnnotationSummary;
  activities: ExtensionCollaborationActivitySummary[];
}

export interface ExtensionAppStatus {
  phase: ExtensionAppPhase;
  account: PublicAccount | null;
  profiles: ServerProfile[];
  selectedProfileId: string;
  selectedProfile: ServerProfile | null;
  serverCapabilities: ServerCapability[];
  publicRooms: PublicRoomSummary[];
  publicRoomsUnavailableReason: string | null;
  pointerUnavailableReason: string | null;
  contentCompatibilityUnavailableReason: string | null;
  notifications: Notification[];
  notificationCursor: number;
  unreadNotificationCount: number;
  onboardingRequired: boolean;
  rooms: PublicRoom[];
  invitations: PublicReceivedInvitation[];
  selectedRoomId: string | null;
  roomDetail: PublicRoomDetail | null;
  room: ExtensionStatus | null;
  errorCode: string | null;
  collaboration: ExtensionCollaborationSummary;
}

export interface ExtensionPageAccessContext {
  profileId: string;
  serverOrigin: string;
  serverTermsVersion: string | null;
  documentRevision: DocumentRevision | null;
  contentCompatibility: ContentCompatibility | null;
}

export interface LegacyExtensionAppControllerOptions {
  profileId?: unknown;
  serverUrl: unknown;
  serverId?: unknown;
  deviceId: unknown;
  area: ExtensionAppStorageArea;
  sessions: ExtensionProductSessionPort;
  api: LegacyExtensionProductApi;
  runtimeFactory: RoomRuntimeFactory;
}

export interface VnextExtensionAppControllerOptions {
  deviceId: unknown;
  area: ExtensionAppStorageArea;
  profiles: ExtensionServerProfilePort;
  sessions: ExtensionProductSessionPort;
  clientVersion: unknown;
  apiFactory(baseUrl: string): ExtensionProductApi;
  publicTransportFactory(baseUrl: string): ExtensionPublicCatalogPort;
  onboarding: ExtensionOnboardingPort;
  runtimeFactory: RoomRuntimeFactory;
}

export type ExtensionAppControllerOptions =
  LegacyExtensionAppControllerOptions | VnextExtensionAppControllerOptions;

export class ExtensionAppController {
  #profileId: string;
  #serverUrl: string;
  #serverId: string | null;
  readonly #deviceId: string;
  readonly #area: ExtensionAppStorageArea;
  readonly #sessions: ExtensionProductSessionPort;
  readonly #profiles: ExtensionServerProfilePort | undefined;
  readonly #clientVersion: string;
  readonly #apiFactory: ((baseUrl: string) => ExtensionProductApi) | undefined;
  readonly #publicTransportFactory: ((baseUrl: string) => ExtensionPublicCatalogPort) | undefined;
  readonly #onboarding: ExtensionOnboardingPort | undefined;
  readonly #runtimeFactory: RoomRuntimeFactory;
  readonly #pendingMediaGestureObservations = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(hint?: UiSliceHint) => void>();
  #profile: ServerProfile | null = null;
  #profilesList: ServerProfile[] = [];
  #api: ExtensionProductApi | null;
  #publicTransport: ExtensionPublicCatalogPort | null = null;
  #publicRefreshPending = false;
  #publicRefreshRunning = false;
  #publicRooms: PublicRoomSummary[] = [];
  #notifications: Notification[] = [];
  #notificationCursor = 0;
  #unreadNotificationCount = 0;
  #serverCapabilities = new Set<ServerCapability>();
  #onboardingRequired = false;
  #started = false;
  #tail: Promise<void> = Promise.resolve();
  #phase: ExtensionAppPhase = "SIGNED_OUT";
  #account: PublicAccount | null = null;
  #rooms: PublicRoom[] = [];
  #invitations: PublicReceivedInvitation[] = [];
  #selection: ProductSelection | null = null;
  #roomDetail: PublicRoomDetail | null = null;
  #runtime: RoomRuntime | undefined;
  #errorCode: string | null = null;

  public constructor(options: ExtensionAppControllerOptions) {
    this.#deviceId = DeviceIdSchema.parse(options.deviceId);
    this.#area = options.area;
    this.#sessions = options.sessions;
    this.#runtimeFactory = options.runtimeFactory;
    if ("profiles" in options) {
      this.#profileId = DEFAULT_SERVER_PROFILE_ID;
      this.#serverUrl = PRODUCTION_PUBLIC_SERVER_ORIGIN;
      this.#serverId = null;
      this.#profiles = options.profiles;
      this.#clientVersion = z
        .string()
        .regex(/^\d+\.\d+\.\d+$/u)
        .parse(options.clientVersion);
      this.#apiFactory = options.apiFactory;
      this.#publicTransportFactory = options.publicTransportFactory;
      this.#onboarding = options.onboarding;
      this.#api = null;
    } else {
      this.#profileId = ServerProfileIdSchema.parse(options.profileId ?? DEFAULT_SERVER_PROFILE_ID);
      this.#serverUrl = parsePublicServerOrigin(options.serverUrl);
      this.#serverId = CanonicalUuidSchema.nullable().parse(options.serverId ?? null);
      this.#profiles = undefined;
      this.#clientVersion = "0.8.1";
      this.#apiFactory = undefined;
      this.#publicTransportFactory = undefined;
      this.#onboarding = undefined;
      this.#api = options.api as ExtensionProductApi;
    }
  }

  public subscribe(listener: (hint?: UiSliceHint) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public async getPageAccessContext(tabIdInput: unknown): Promise<ExtensionPageAccessContext> {
    const tabId = z.number().int().nonnegative().safe().parse(tabIdInput);
    const runtime = this.#runtime;
    const [documentRevision, contentCompatibility] = await Promise.all([
      runtime?.getPageDocumentRevision === undefined
        ? null
        : runtime.getPageDocumentRevision(tabId),
      runtime?.getPageContentCompatibility === undefined
        ? null
        : runtime.getPageContentCompatibility(tabId),
    ]);
    return {
      profileId: this.#profileId,
      serverOrigin: this.#serverUrl,
      serverTermsVersion: this.#profile?.metadata?.termsVersion ?? null,
      documentRevision:
        documentRevision === null
          ? null
          : {
              roomEpoch: documentRevision.roomEpoch,
              tabUpdatedAtSeq: documentRevision.tabUpdatedAtSeq,
            },
      contentCompatibility:
        documentRevision === null || contentCompatibility === null ? null : contentCompatibility,
    };
  }

  public start(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#started) {
        throw new Error("APP_CONTROLLER_ALREADY_STARTED");
      }
      this.#started = true;
      if (this.#profiles !== undefined) {
        await this.#profiles.initialize();
        this.#onboardingRequired = (await this.#onboarding?.isRequired()) ?? false;
        this.#profilesList = await this.#profiles.list();
        const selected = await this.#profiles.getSelected();
        await this.#configureProfile(selected);
        this.#emitChanged();
        return;
      }
      const status = await this.#sessions.getStatus(this.#profileId);
      if (status.kind === "SIGNED_OUT") {
        this.#resetProductState("SIGNED_OUT");
        this.#emitChanged();
        return;
      }
      await this.#restoreAuthenticated(status);
      this.#emitChanged();
    });
  }

  public register(input: {
    username: string;
    displayName: string;
    password: string;
  }): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      await this.#stopRuntime();
      const pending = await this.#requireApi().register(input);
      this.#phase = "ACCOUNT_PENDING";
      this.#account = pending;
      this.#rooms = [];
      this.#invitations = [];
      this.#selection = null;
      this.#roomDetail = null;
      this.#errorCode = null;
      this.#emitChanged();
    });
  }

  public login(input: { username: string; password: string }): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      await this.#stopRuntime();
      const response = await this.#requireApi().login({
        username: input.username,
        password: input.password,
        deviceId: this.#deviceId,
      });
      await this.#sessions.establish({
        profileId: this.#profileId,
        serverUrl: this.#serverUrl,
        serverId: this.#serverId,
        deviceId: this.#deviceId,
        response,
      });
      await this.#restoreAuthenticated({
        kind: "AUTHENTICATED",
        account: response.account,
        deviceId: this.#deviceId,
        accessTokenExpiresAt: Date.now() + response.expiresInSeconds * 1_000,
        refreshTokenExpiresAt: Date.now() + response.refreshExpiresInSeconds * 1_000,
      });
      this.#emitChanged();
    });
  }

  public activateAccount(input: {
    activationKey: string;
    username: string;
    displayName: string;
    password: string;
  }): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      this.#requireCapability("account-activation-v1");
      await this.#stopRuntime();
      const response = await this.#requireApi().activateAccount({
        ...input,
        deviceId: this.#deviceId,
      });
      await this.#sessions.establish({
        profileId: this.#profileId,
        serverUrl: this.#serverUrl,
        serverId: this.#serverId,
        deviceId: this.#deviceId,
        response,
      });
      await this.#restoreAuthenticated({
        kind: "AUTHENTICATED",
        account: response.account,
        deviceId: this.#deviceId,
        accessTokenExpiresAt: Date.now() + response.expiresInSeconds * 1_000,
        refreshTokenExpiresAt: Date.now() + response.refreshExpiresInSeconds * 1_000,
      });
      this.#emitChanged();
    });
  }

  public loginWithAccountKey(input: { activationKey: string }): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      this.#requireCapability("account-key-login-v1");
      await this.#stopRuntime();
      const response = await this.#requireApi().loginWithAccountKey({
        activationKey: input.activationKey,
        deviceId: this.#deviceId,
      });
      await this.#sessions.establish({
        profileId: this.#profileId,
        serverUrl: this.#serverUrl,
        serverId: this.#serverId,
        deviceId: this.#deviceId,
        response,
      });
      await this.#restoreAuthenticated({
        kind: "AUTHENTICATED",
        account: response.account,
        deviceId: this.#deviceId,
        accessTokenExpiresAt: Date.now() + response.expiresInSeconds * 1_000,
        refreshTokenExpiresAt: Date.now() + response.refreshExpiresInSeconds * 1_000,
      });
      this.#emitChanged();
    });
  }

  public updateAccountProfile(input: { username: string; displayName: string }): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      this.#requireCapability("account-activation-v1");
      const updated = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().updateProfile(accessToken, input),
      );
      await this.#sessions.updateAccount(this.#profileId, updated);
      this.#account = updated;
      this.#emitChanged(["shell"]);
    });
  }

  public changeAccountPassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      this.#requireCapability("account-activation-v1");
      await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().changePassword(accessToken, input),
      );
    });
  }

  public initializeAccountPassword(input: { newPassword: string }): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      this.#requireCapability("account-key-login-v1");
      await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().initializePassword(accessToken, input),
      );
      const updated = { ...this.#account!, passwordResetRequired: false };
      await this.#sessions.updateAccount(this.#profileId, updated);
      this.#account = updated;
      this.#emitChanged(["shell"]);
    });
  }

  public logout(): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      await this.#stopRuntime();
      const session = await this.#sessions.read(this.#profileId);
      try {
        if (session !== null) {
          await this.#requireApi().logout(session.refreshToken);
        }
      } catch {
        // Local logout must succeed even if the server is temporarily unreachable.
      } finally {
        await this.#sessions.clear(this.#profileId);
        await this.#clearSelection();
        this.#resetProductState("SIGNED_OUT");
        this.#emitChanged();
      }
    });
  }

  public refreshProductData(): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      await this.#loadProductData();
      if (
        this.#selection !== null &&
        !this.#rooms.some((room) => room.id === this.#selection?.roomId)
      ) {
        await this.#stopRuntime();
        await this.#clearSelection();
        this.#phase = "AUTHENTICATED_NO_ROOM";
      }
      this.#emitChanged();
    });
  }

  public createRoom(input: string | RoomMutationInput): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const roomInput =
        typeof input === "string"
          ? {
              name: input,
              visibility: "PRIVATE" as const,
              joinPolicy: "INVITE_ONLY" as const,
            }
          : input;
      const created = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().createRoom(accessToken, roomInput),
      );
      await this.#loadProductData();
      await this.#selectRoom(created.id);
      this.#emitChanged();
    });
  }

  public selectRoom(roomIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      await this.#selectRoom(RoomIdSchema.parse(roomIdInput));
      this.#emitChanged();
    });
  }

  public acceptInvitation(invitationId: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const accepted = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().acceptInvitation(accessToken, invitationId),
      );
      await this.#loadProductData();
      await this.#selectRoom(accepted.id);
      this.#emitChanged();
    });
  }

  public invite(username: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const detail = this.#roomDetail;
      if (detail === null || detail.role !== "OWNER") {
        throw new Error("ROOM_OWNER_REQUIRED");
      }
      await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().invite(accessToken, detail.id, username),
      );
      this.#roomDetail = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().getRoom(accessToken, detail.id),
      );
      this.#emitChanged();
    });
  }

  public addServer(input: { baseUrl: string }): Promise<string> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      const profiles = this.#requireProfiles();
      const candidate = await this.#probeServer(input.baseUrl);
      const profile = await profiles.addCandidate(candidate);
      this.#profilesList = await profiles.list();
      this.#emitChanged();
      return profile.profileId;
    });
  }

  public selectServer(profileIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      const profileId = ServerProfileIdSchema.parse(profileIdInput);
      const profiles = this.#requireProfiles();
      const target = await profiles.get(profileId);
      if (target === null) {
        throw new Error("SERVER_PROFILE_NOT_FOUND");
      }
      if (target.mode === "UNVERIFIED") {
        throw new Error("SERVER_PROFILE_UNVERIFIED");
      }
      if (profileId === this.#profileId && this.#profile !== null) {
        return;
      }
      await this.#switchProfile(target);
      this.#emitChanged();
    });
  }

  public refreshPublicRooms(): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      await this.#loadPublicRooms();
      this.#emitChanged();
    });
  }

  public updateRoom(input: {
    name: string;
    visibility: RoomVisibility;
    joinPolicy: RoomJoinPolicy;
  }): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const detail = this.#requireRoomDetail();
      if (detail.role !== "OWNER") {
        throw new Error("ROOM_OWNER_REQUIRED");
      }
      const updated = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().updateRoom(accessToken, detail.id, input),
      );
      this.#replaceRoom(updated);
      this.#roomDetail = {
        ...detail,
        ...updated,
      };
      this.#emitChanged();
    });
  }

  public activateLogicalTab(logicalTabIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      const logicalTabId = LogicalTabIdSchema.parse(logicalTabIdInput);
      const runtime = this.#requireRuntime();
      if (runtime.activateLogicalTab === undefined) {
        throw new Error("ROOM_TAB_NOT_AVAILABLE");
      }
      await runtime.activateLogicalTab(logicalTabId);
    });
  }

  public joinOpenRoom(roomIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const roomId = RoomIdSchema.parse(roomIdInput);
      const joined = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().joinOpenRoom(accessToken, roomId),
      );
      this.#replaceRoom(joined);
      await this.#selectRoom(joined.id);
      this.#emitChanged();
    });
  }

  public requestRoomJoin(roomIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const roomId = RoomIdSchema.parse(roomIdInput);
      await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().requestRoomJoin(accessToken, roomId),
      );
      this.#emitChanged();
    });
  }

  public decideJoinRequest(
    requestIdInput: unknown,
    decisionInput: unknown,
    clientOpIdInput: unknown,
  ): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const requestId = CanonicalUuidSchema.parse(requestIdInput);
      const decision = z.enum(["APPROVE", "REJECT"]).parse(decisionInput);
      const clientOpId = CanonicalUuidSchema.parse(clientOpIdInput);
      const result = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().decideJoinRequest(accessToken, requestId, {
          decision,
          clientOpId,
        }),
      );
      if (result.status === "APPROVED" && this.#roomDetail?.id === result.roomId) {
        await this.#reloadRoomDetail(result.roomId);
      }
      this.#emitChanged();
    });
  }

  public searchDirectory(input: DirectorySearchInput): Promise<DirectoryList> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      return this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().searchDirectory(accessToken, input),
      );
    });
  }

  public batchInvite(userIds: string[]): Promise<BatchInvitationResult[]> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const detail = this.#requireRoomDetail();
      if (detail.role !== "OWNER") {
        throw new Error("ROOM_OWNER_REQUIRED");
      }
      const results = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().batchInvite(accessToken, detail.id, userIds),
      );
      if (results.some((result) => result.status === "CREATED")) {
        await this.#reloadRoomDetail(detail.id);
      }
      this.#emitChanged();
      return results;
    });
  }

  public markNotificationRead(notificationIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const notificationId = CanonicalUuidSchema.parse(notificationIdInput);
      const notification = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().markNotificationRead(accessToken, notificationId),
      );
      this.#applyNotification(notification);
      this.#emitChanged();
    });
  }

  public markAllNotificationsRead(): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      if (this.#notificationCursor === 0) {
        return;
      }
      const read = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().markNotificationsRead(accessToken, this.#notificationCursor),
      );
      this.#applyNotificationRead({
        kind: "THROUGH",
        throughCursor: read.throughCursor,
        readAt: read.readAt,
      });
      this.#emitChanged();
    });
  }

  public leaveRoom(): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const detail = this.#requireRoomDetail();
      await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().leaveRoom(accessToken, detail.id),
      );
      await this.#stopRuntime();
      await this.#clearSelection();
      this.#rooms = this.#rooms.filter((room) => room.id !== detail.id);
      this.#phase = "AUTHENTICATED_NO_ROOM";
      this.#emitChanged();
    });
  }

  public removeMember(userIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const detail = this.#requireRoomDetail();
      if (detail.role !== "OWNER") {
        throw new Error("ROOM_OWNER_REQUIRED");
      }
      const userId = CanonicalUuidSchema.parse(userIdInput);
      await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().removeMember(accessToken, detail.id, userId),
      );
      this.#roomDetail = {
        ...detail,
        members: detail.members.filter((member) => member.userId !== userId),
      };
      this.#emitChanged();
    });
  }

  public transferOwnership(userIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const detail = this.#requireRoomDetail();
      if (detail.role !== "OWNER") {
        throw new Error("ROOM_OWNER_REQUIRED");
      }
      const userId = CanonicalUuidSchema.parse(userIdInput);
      const updated = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().transferOwnership(accessToken, detail.id, userId),
      );
      const localRoom = { ...updated, role: "MEMBER" as const };
      this.#replaceRoom(localRoom);
      this.#roomDetail = {
        ...detail,
        ...localRoom,
        members: detail.members.map((member) => ({
          ...member,
          role:
            member.userId === userId
              ? ("OWNER" as const)
              : member.userId === this.#account?.id
                ? ("MEMBER" as const)
                : member.role,
        })),
      };
      this.#emitChanged();
    });
  }

  public dissolveRoom(): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const detail = this.#requireRoomDetail();
      if (detail.role !== "OWNER") {
        throw new Error("ROOM_OWNER_REQUIRED");
      }
      await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().dissolveRoom(accessToken, detail.id),
      );
      await this.#stopRuntime();
      await this.#clearSelection();
      this.#rooms = this.#rooms.filter((room) => room.id !== detail.id);
      this.#phase = "AUTHENTICATED_NO_ROOM";
      this.#emitChanged();
    });
  }

  public recordCurrentPolicyAcceptance(): Promise<{
    profileId: string;
    serverTermsVersion: string;
  }> {
    return this.#enqueue(async () => {
      this.#requireAuthenticated();
      const termsVersion = this.#profile?.metadata?.termsVersion;
      if (termsVersion === undefined) {
        throw new Error("SERVER_POLICY_UNAVAILABLE");
      }
      await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().acceptCurrentPolicy(accessToken, {
          termsVersion,
          clientVersion: this.#clientVersion,
        }),
      );
      this.#emitChanged();
      return {
        profileId: this.#profileId,
        serverTermsVersion: termsVersion,
      };
    });
  }

  public leaveMediaGroup(playbackGroupIdInput?: unknown): Promise<void> {
    return this.#enqueue(async () => {
      const runtime = this.#requireRuntime();
      if (runtime.leaveMediaGroup === undefined) {
        throw new Error("MEDIA_CONTROLLER_UNAVAILABLE");
      }
      await runtime.leaveMediaGroup(
        playbackGroupIdInput === undefined
          ? undefined
          : CanonicalUuidSchema.parse(playbackGroupIdInput),
      );
    });
  }

  public closeMediaGroup(playbackGroupIdInput?: unknown): Promise<void> {
    return this.#enqueue(async () => {
      const runtime = this.#requireRuntime();
      if (runtime.closeMediaGroup === undefined) {
        throw new Error("MEDIA_CONTROLLER_UNAVAILABLE");
      }
      await runtime.closeMediaGroup(
        playbackGroupIdInput === undefined
          ? undefined
          : CanonicalUuidSchema.parse(playbackGroupIdInput),
      );
    });
  }

  public takeOverMediaDevice(playbackGroupIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      const runtime = this.#requireRuntime();
      if (runtime.takeOverMediaDevice === undefined) {
        throw new Error("MEDIA_CONTROLLER_UNAVAILABLE");
      }
      await runtime.takeOverMediaDevice(CanonicalUuidSchema.parse(playbackGroupIdInput));
    });
  }

  public dismissVnextOnboarding(): Promise<void> {
    return this.#enqueue(async () => {
      this.#requireStarted();
      if ((await this.#onboarding?.dismiss()) === true) {
        this.#onboardingRequired = false;
        this.#emitChanged();
      }
    });
  }

  public handleBrowserEvent(eventInput: unknown): Promise<BrowserObserverResult | undefined> {
    return this.#enqueue(async () => this.#runtime?.handleBrowserEvent(eventInput));
  }

  public shareBrowserTab(tabIdInput: unknown): Promise<BrowserObserverResult | undefined> {
    return this.#enqueue(async () => this.#runtime?.shareBrowserTab(tabIdInput));
  }

  public handleActiveTabChanged(tabIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => {
      await this.#runtime?.handleActiveTabChanged(tabIdInput);
      this.#emitChanged();
    });
  }

  public handlePointerPageReady(tabIdInput: unknown): Promise<void> {
    return this.#enqueue(async () => this.#runtime?.handlePointerPageReady(tabIdInput));
  }

  public handlePageCompatibilityReport(
    tabIdInput: unknown,
    reportInput: PageCompatibilityReport,
  ): Promise<void> {
    return this.#enqueue(async () =>
      this.#runtime?.handlePageCompatibilityReport?.(tabIdInput, reportInput),
    );
  }

  public handleMediaPageReady(
    tabIdInput: unknown,
    frameIdInput: unknown = 0,
    frameKeyInput: unknown = "top",
  ): Promise<void> {
    return this.#enqueue(async () =>
      this.#runtime?.handleMediaPageReady(tabIdInput, frameIdInput, frameKeyInput),
    );
  }

  public handlePageToolFrameReady(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
    rootGenerationInput?: unknown,
  ): Promise<void> {
    return this.#enqueue(async () =>
      this.#runtime?.handlePageToolFrameReady?.(
        tabIdInput,
        frameIdInput,
        frameKeyInput,
        rootGenerationInput,
      ),
    );
  }

  public handlePageToolFrameUnavailable(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
  ): Promise<void> {
    return this.#enqueue(async () =>
      this.#runtime?.handlePageToolFrameUnavailable?.(tabIdInput, frameIdInput, frameKeyInput),
    );
  }

  public handleMediaObserved(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: MediaObservedMessage,
  ): Promise<void> {
    const gestureKey = appMediaGestureObservationKey(tabIdInput, frameIdInput, messageInput);
    if (gestureKey !== null) {
      const pending = this.#pendingMediaGestureObservations.get(gestureKey);
      if (pending !== undefined) {
        return pending;
      }
    }
    const operation = this.#enqueue(async () =>
      this.#runtime?.handleMediaObserved(tabIdInput, frameIdInput, messageInput),
    );
    if (gestureKey === null) {
      return operation;
    }
    this.#pendingMediaGestureObservations.set(gestureKey, operation);
    return operation.finally(() => {
      if (this.#pendingMediaGestureObservations.get(gestureKey) === operation) {
        this.#pendingMediaGestureObservations.delete(gestureKey);
      }
    });
  }

  public handlePointerLocalSample(tabIdInput: unknown, sampleInput: unknown): Promise<void> {
    return this.#enqueue(async () =>
      this.#runtime?.handlePointerLocalSample(tabIdInput, sampleInput),
    );
  }

  public handleDanmakuSubmit(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DanmakuSubmitMessage,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const runtime = this.#requireRuntime();
      if (runtime.handleDanmakuSubmit === undefined) {
        throw new Error("DANMAKU_CONTROLLER_UNAVAILABLE");
      }
      await runtime.handleDanmakuSubmit(tabIdInput, frameIdInput, messageInput);
    });
  }

  public handleStrokeSample(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: StrokeSampleMessage,
  ): Promise<void> {
    return this.#enqueue(async () =>
      this.#runtime?.handleStrokeSample?.(tabIdInput, frameIdInput, messageInput),
    );
  }

  public handleStrokeFinal(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: StrokeFinalMessage,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const runtime = this.#requireRuntime();
      if (runtime.handleStrokeFinal === undefined) {
        throw new Error("DRAWING_CONTROLLER_UNAVAILABLE");
      }
      await runtime.handleStrokeFinal(tabIdInput, frameIdInput, messageInput);
    });
  }

  public handleDrawingSelection(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingSelectionMessage,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const runtime = this.#requireRuntime();
      if (runtime.handleDrawingSelection === undefined) {
        throw new Error("DRAWING_CONTROLLER_UNAVAILABLE");
      }
      await runtime.handleDrawingSelection(tabIdInput, frameIdInput, messageInput);
    });
  }

  public handleDrawingDraftControl(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingDraftControlMessage,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const runtime = this.#requireRuntime();
      if (runtime.handleDrawingDraftControl === undefined) {
        throw new Error("DRAWING_CONTROLLER_UNAVAILABLE");
      }
      await runtime.handleDrawingDraftControl(tabIdInput, frameIdInput, messageInput);
    });
  }

  public handleDrawingReport(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingReportMessage,
  ): Promise<void> {
    return this.#enqueue(async () =>
      this.#runtime?.handleDrawingReport?.(tabIdInput, frameIdInput, messageInput),
    );
  }

  public handleDanmakuReport(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DanmakuReportMessage,
  ): Promise<void> {
    return this.#enqueue(async () =>
      this.#runtime?.handleDanmakuReport?.(tabIdInput, frameIdInput, messageInput),
    );
  }

  public handlePageCapability(reportInput: PageCapabilityReport): Promise<void> {
    return this.#enqueue(async () => this.#runtime?.handlePageCapability(reportInput));
  }

  public handlePagePermissionBoundaryChanged(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#runtime?.handlePagePermissionBoundaryChanged();
      this.#emitChanged();
    });
  }

  public toggleDanmakuInput(): Promise<void> {
    return this.#enqueue(async () => this.#requireRuntime().toggleDanmakuInput());
  }

  public setDanmakuHidden(hiddenInput: unknown): Promise<void> {
    const hidden = z.boolean().parse(hiddenInput);
    return this.#enqueue(async () => {
      const runtime = this.#requireRuntime();
      if (runtime.setDanmakuHidden === undefined) {
        throw new Error("PAGE_TOOL_UNAVAILABLE");
      }
      await runtime.setDanmakuHidden(hidden);
    });
  }

  public togglePagePen(): Promise<void> {
    return this.#enqueue(async () => this.#requireRuntime().togglePagePen());
  }

  public jumpToMediaMember(userIdInput: unknown): Promise<void> {
    return this.#enqueue(async () =>
      this.#requireRuntime().jumpToMediaMember(CanonicalUuidSchema.parse(userIdInput)),
    );
  }

  public alignMediaGroupOnce(playbackGroupIdInput: unknown): Promise<void> {
    return this.#enqueue(async () =>
      this.#requireRuntime().alignMediaGroupOnce(CanonicalUuidSchema.parse(playbackGroupIdInput)),
    );
  }

  public joinMediaGroup(playbackGroupIdInput: unknown): Promise<void> {
    return this.#enqueue(async () =>
      this.#requireRuntime().joinMediaGroup(CanonicalUuidSchema.parse(playbackGroupIdInput)),
    );
  }

  public decideMediaProposal(
    playbackGroupIdInput: unknown,
    proposalIdInput: unknown,
    decisionInput: unknown,
  ): Promise<void> {
    return this.#enqueue(async () =>
      this.#requireRuntime().decideMediaProposal(
        CanonicalUuidSchema.parse(playbackGroupIdInput),
        CanonicalUuidSchema.parse(proposalIdInput),
        z.enum(["APPROVE", "REJECT"]).parse(decisionInput),
      ),
    );
  }

  public confirmBrowserRecovery(): Promise<BrowserActuatorResult | undefined> {
    return this.#enqueue(async () => this.#runtime?.confirmBrowserRecovery());
  }

  public getStatus(): Promise<ExtensionAppStatus> {
    return this.#enqueue(async () => {
      if (
        this.#account?.status === "ACTIVE" &&
        (await this.#sessions.getStatus(this.#profileId)).kind === "SIGNED_OUT"
      ) {
        await this.#stopRuntime();
        this.#resetProductState("SESSION_EXPIRED");
        this.#errorCode = "SESSION_REQUIRED";
      }
      const runtime = this.#runtime;
      const room = runtime === undefined ? null : await runtime.getStatus();
      return structuredClone({
        phase: this.#phase,
        account: this.#account,
        profiles: this.#profilesList,
        selectedProfileId: this.#profileId,
        selectedProfile: this.#profile,
        serverCapabilities: [...this.#serverCapabilities],
        publicRooms: this.#publicRooms,
        publicRoomsUnavailableReason: this.#publicRoomsUnavailableReason(),
        pointerUnavailableReason: this.#pointerUnavailableReason(),
        contentCompatibilityUnavailableReason: this.#contentCompatibilityUnavailableReason(),
        notifications: this.#notifications,
        notificationCursor: this.#notificationCursor,
        unreadNotificationCount: this.#unreadNotificationCount,
        onboardingRequired: this.#onboardingRequired,
        rooms: this.#rooms,
        invitations: this.#invitations,
        selectedRoomId: this.#selection?.roomId ?? null,
        roomDetail: this.#roomDetail,
        room,
        errorCode: this.#errorCode,
        collaboration: projectCollaborationSummary(this.#roomDetail, room),
      });
    });
  }

  async #configureProfile(profileInput: ServerProfile): Promise<void> {
    const profiles = this.#requireProfiles();
    await this.#stopPublicTransport();
    this.#profileId = profileInput.profileId;
    this.#serverUrl = profileInput.baseUrl;
    this.#serverId = profileInput.metadata?.serverId ?? null;
    this.#profile = profileInput;
    this.#api = this.#apiFactory?.(profileInput.baseUrl) ?? null;
    this.#serverCapabilities.clear();
    this.#publicRooms = [];
    this.#notifications = [];
    this.#notificationCursor = 0;
    this.#unreadNotificationCount = 0;
    this.#errorCode = null;

    try {
      const api = this.#requireApi();
      await api.getHealth();
      let profile = profileInput;
      if (profile.mode === "LEGACY_V081") {
        try {
          await api.getMeta();
          await this.#sessions.clear(profile.profileId);
          this.#api = null;
          this.#phase = "ERROR";
          this.#errorCode = "SERVER_IDENTITY_CHANGED";
          return;
        } catch (cause) {
          if (!(cause instanceof SyncActionApiError && cause.status === 404)) {
            throw cause;
          }
        }
      } else {
        const metadata = await api.getMeta();
        if (
          profile.mode === "VNEXT" &&
          profile.metadata !== null &&
          profile.metadata.serverId !== metadata.serverId
        ) {
          await this.#sessions.clear(profile.profileId);
          this.#api = null;
          this.#phase = "ERROR";
          this.#errorCode = "SERVER_IDENTITY_CHANGED";
          return;
        }
        profile = await profiles.verify(profile.profileId, metadata);
        this.#profile = profile;
        this.#serverId = metadata.serverId;
        if (metadata.protocolVersion !== "1") {
          this.#api = null;
          this.#phase = "ERROR";
          this.#errorCode = "SERVER_PROTOCOL_UNSUPPORTED";
          return;
        }
        if (compareVersions(metadata.minimumClientVersion, this.#clientVersion) > 0) {
          this.#api = null;
          this.#phase = "ERROR";
          this.#errorCode = "CLIENT_UPGRADE_REQUIRED";
          return;
        }
        for (const token of metadata.capabilities) {
          const capability = ServerCapabilitySchema.safeParse(token);
          if (capability.success) {
            this.#serverCapabilities.add(capability.data);
          }
        }
      }

      this.#profilesList = await profiles.list();
      if (
        profile.profileId === DEFAULT_SERVER_PROFILE_ID &&
        this.#sessions.migrateLegacyProductionSession !== undefined
      ) {
        await this.#sessions.migrateLegacyProductionSession(profile);
      }
      if (this.#serverCapabilities.has("public-rooms")) {
        try {
          await this.#loadPublicRooms();
        } catch {
          this.#publicRooms = [];
          this.#errorCode = "PUBLIC_CATALOG_UNAVAILABLE";
        }
        await this.#startPublicTransport();
      }
      const status = await this.#sessions.getStatus(profile.profileId);
      if (status.kind === "SIGNED_OUT") {
        this.#resetProductState("SIGNED_OUT");
      } else {
        await this.#restoreAuthenticated(status);
      }
      if (profile.mode === "LEGACY_V081" && this.#errorCode === null) {
        this.#errorCode = "SERVER_LEGACY_LIMITED";
      }
    } catch (cause) {
      this.#api = null;
      this.#resetProductState("SIGNED_OUT");
      this.#phase = "ERROR";
      this.#errorCode = errorCode(cause);
    }
  }

  async #switchProfile(target: ServerProfile): Promise<void> {
    const profiles = this.#requireProfiles();
    const oldProfile = this.#profile;
    const oldApi = this.#api;
    await this.#stopRuntime();
    await this.#stopPublicTransport();
    if (oldProfile !== null) {
      if (oldProfile.mode === "VNEXT" && oldProfile.metadata !== null && oldApi !== null) {
        try {
          await oldApi.getHealth();
          const metadata = await oldApi.getMeta();
          if (metadata.serverId === oldProfile.metadata.serverId) {
            const session = await this.#sessions.read(oldProfile.profileId);
            if (session !== null) {
              try {
                await oldApi.logout(session.refreshToken);
              } catch {
                // Local profile switching must complete after identity was safely checked.
              }
            }
          }
        } catch {
          // No credential is sent when anonymous identity confirmation fails.
        }
      }
      await this.#sessions.clear(oldProfile.profileId);
      await this.#clearSelectionForProfile(oldProfile.profileId);
    }
    this.#resetProductState("SIGNED_OUT");
    const selected = await profiles.select(target.profileId);
    this.#profilesList = await profiles.list();
    await this.#configureProfile(selected);
  }

  async #probeServer(baseUrlInput: unknown): Promise<VerifiedServerCandidate> {
    const baseUrl = parsePublicServerOrigin(baseUrlInput);
    const api = this.#apiFactory?.(baseUrl);
    if (api === undefined) {
      throw new Error("SERVER_PROFILE_UNAVAILABLE");
    }
    await api.getHealth();
    const healthyAt = Date.now();
    try {
      return {
        baseUrl,
        mode: "VNEXT",
        metadata: await api.getMeta(),
        healthyAt,
      };
    } catch (cause) {
      if (cause instanceof SyncActionApiError && cause.status === 404) {
        return {
          baseUrl,
          mode: "LEGACY_V081",
          metadata: null,
          healthyAt,
        };
      }
      throw cause;
    }
  }

  async #loadPublicRooms(): Promise<void> {
    if (!this.#serverCapabilities.has("public-rooms")) {
      this.#publicRooms = [];
      throw new Error("SERVER_CAPABILITY_PUBLIC_ROOMS_UNAVAILABLE");
    }
    const response = await this.#requireApi().listPublicRooms({
      query: "",
      cursor: null,
      limit: 50,
    });
    this.#publicRooms = response.items;
  }

  async #startPublicTransport(): Promise<void> {
    const factory = this.#publicTransportFactory;
    if (factory === undefined || !this.#serverCapabilities.has("public-rooms")) {
      return;
    }
    const transport = factory(this.#serverUrl);
    transport.setInvalidatedHandler(() => this.#schedulePublicRefresh());
    try {
      await transport.start();
      this.#publicTransport = transport;
    } catch {
      await transport.stop().catch(() => undefined);
      this.#publicTransport = null;
      if (this.#errorCode === null) {
        this.#errorCode = "PUBLIC_CATALOG_OFFLINE";
      }
    }
  }

  async #stopPublicTransport(): Promise<void> {
    const transport = this.#publicTransport;
    this.#publicTransport = null;
    this.#publicRefreshPending = false;
    if (transport !== null) {
      transport.setInvalidatedHandler(undefined);
      await transport.stop();
    }
  }

  #schedulePublicRefresh(): void {
    this.#publicRefreshPending = true;
    if (this.#publicRefreshRunning) {
      return;
    }
    this.#publicRefreshRunning = true;
    queueMicrotask(() => {
      void this.#enqueue(async () => {
        do {
          this.#publicRefreshPending = false;
          try {
            await this.#loadPublicRooms();
            this.#emitChanged();
          } catch {
            // The next invalidation or explicit refresh can recover public discovery.
          }
        } while (this.#publicRefreshPending && this.#publicTransport !== null);
      }).finally(() => {
        this.#publicRefreshRunning = false;
        if (this.#publicRefreshPending && this.#publicTransport !== null) {
          this.#schedulePublicRefresh();
        }
      });
    });
  }

  #scheduleRoomEvent(event: RoomEventMessage): void {
    void this.#enqueue(async () => {
      await this.#applyRoomEvent(event);
      this.#emitChanged();
    }).catch(() => undefined);
  }

  #scheduleNotificationCreated(notification: Notification): void {
    void this.#enqueue(async () => {
      this.#applyNotification(notification);
      this.#emitChanged();
    }).catch(() => undefined);
  }

  #scheduleNotificationRead(event: NotificationReadEvent): void {
    void this.#enqueue(async () => {
      this.#applyNotificationRead(event);
      this.#emitChanged();
    }).catch(() => undefined);
  }

  async #applyRoomEvent(event: RoomEventMessage): Promise<void> {
    const detail = this.#roomDetail;
    if (
      detail === null ||
      event.roomId !== detail.id ||
      event.roomRevision <= detail.roomRevision
    ) {
      return;
    }
    if (event.roomRevision !== detail.roomRevision + 1) {
      await this.#reloadRoomDetail(detail.id);
      return;
    }
    if (event.kind === "ROOM_DISSOLVED") {
      await this.#stopRuntime();
      await this.#clearSelection();
      this.#rooms = this.#rooms.filter((room) => room.id !== event.roomId);
      this.#phase = "AUTHENTICATED_NO_ROOM";
      return;
    }
    if (
      (event.kind === "ROOM_MEMBER_LEFT" || event.kind === "ROOM_MEMBER_REMOVED") &&
      event.userId === this.#account?.id
    ) {
      await this.#stopRuntime();
      await this.#clearSelection();
      this.#rooms = this.#rooms.filter((room) => room.id !== event.roomId);
      this.#phase = "AUTHENTICATED_NO_ROOM";
      return;
    }

    let next: PublicRoomDetail = {
      ...detail,
      roomRevision: event.roomRevision,
      updatedAt: event.occurredAt,
    };
    switch (event.kind) {
      case "ROOM_MEMBER_JOINED":
        next = {
          ...next,
          members: [
            ...next.members.filter((member) => member.userId !== event.member.userId),
            event.member,
          ],
        };
        break;
      case "ROOM_MEMBER_LEFT":
      case "ROOM_MEMBER_REMOVED":
        next = {
          ...next,
          members: next.members.filter((member) => member.userId !== event.userId),
        };
        break;
      case "ROOM_OWNER_TRANSFERRED":
        next = {
          ...next,
          role:
            this.#account?.id === event.newOwnerUserId
              ? "OWNER"
              : this.#account?.id === event.previousOwnerUserId
                ? "MEMBER"
                : next.role,
          members: next.members.map((member) => ({
            ...member,
            role:
              member.userId === event.newOwnerUserId
                ? ("OWNER" as const)
                : member.userId === event.previousOwnerUserId
                  ? ("MEMBER" as const)
                  : member.role,
          })),
        };
        break;
      case "ROOM_UPDATED":
        next = {
          ...next,
          name: event.name,
          visibility: event.visibility,
          joinPolicy: event.joinPolicy,
        };
        break;
    }
    this.#roomDetail = next;
    this.#replaceRoom(next);
  }

  #applyNotification(notification: Notification): void {
    const index = this.#notifications.findIndex(
      (candidate) => candidate.notificationId === notification.notificationId,
    );
    if (index < 0) {
      this.#notifications = [
        notification,
        ...this.#notifications.filter(
          (candidate) => candidate.notificationId !== notification.notificationId,
        ),
      ];
      if (notification.readAt === null) {
        this.#unreadNotificationCount += 1;
      }
    } else {
      const prior = this.#notifications[index]!;
      this.#notifications[index] = notification;
      if (prior.readAt === null && notification.readAt !== null) {
        this.#unreadNotificationCount = Math.max(0, this.#unreadNotificationCount - 1);
      } else if (prior.readAt !== null && notification.readAt === null) {
        this.#unreadNotificationCount += 1;
      }
    }
    this.#notificationCursor = Math.max(this.#notificationCursor, notification.cursor);
  }

  #applyNotificationRead(event: NotificationReadEvent): void {
    let changedUnread = 0;
    this.#notifications = this.#notifications.map((notification) => {
      const matches =
        notification.readAt === null &&
        (event.kind === "ONE"
          ? notification.notificationId === event.notificationId
          : notification.cursor <= event.throughCursor);
      if (!matches) {
        return notification;
      }
      changedUnread += 1;
      return {
        ...notification,
        readAt: event.readAt,
      };
    });
    this.#unreadNotificationCount = Math.max(0, this.#unreadNotificationCount - changedUnread);
  }

  async #reloadRoomDetail(roomId: string): Promise<void> {
    const detail = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
      this.#requireApi().getRoom(accessToken, roomId),
    );
    this.#roomDetail = detail;
    this.#replaceRoom(detail);
  }

  #replaceRoom(room: PublicRoom): void {
    const index = this.#rooms.findIndex((candidate) => candidate.id === room.id);
    if (index < 0) {
      this.#rooms = [room, ...this.#rooms];
    } else {
      this.#rooms[index] = room;
    }
  }

  #publicRoomsUnavailableReason(): string | null {
    if (this.#profile?.mode === "LEGACY_V081") {
      return "SERVER_LEGACY_LIMITED";
    }
    return this.#serverCapabilities.has("public-rooms")
      ? null
      : "SERVER_CAPABILITY_PUBLIC_ROOMS_UNAVAILABLE";
  }

  #pointerUnavailableReason(): string | null {
    if (this.#profile?.mode === "LEGACY_V081") {
      return "SERVER_LEGACY_LIMITED";
    }
    return this.#serverCapabilities.has("volatile-pointer-v2")
      ? null
      : "SERVER_CAPABILITY_VOLATILE_POINTER_UNAVAILABLE";
  }

  #contentCompatibilityUnavailableReason(): string | null {
    if (this.#profile?.mode === "LEGACY_V081") {
      return "SERVER_LEGACY_LIMITED";
    }
    return this.#serverCapabilities.has("content-compatibility-v1")
      ? null
      : "SERVER_CAPABILITY_CONTENT_COMPATIBILITY_UNAVAILABLE";
  }

  async #restoreAuthenticated(status: Extract<ExtensionSessionStatus, { kind: "AUTHENTICATED" }>) {
    this.#account = status.account;
    this.#selection = null;
    this.#roomDetail = null;
    this.#errorCode = null;
    try {
      await this.#loadProductData();
      const selection = await this.#readSelection(status.account.id);
      if (selection === null || !this.#rooms.some((room) => room.id === selection.roomId)) {
        if (selection !== null) {
          await this.#clearSelection();
        }
        this.#phase = "AUTHENTICATED_NO_ROOM";
        return;
      }
      this.#selection = selection;
      await this.#activateRoom(selection.roomId, false);
    } catch (cause) {
      await this.#handleProductFailure(cause);
    }
  }

  async #loadProductData(): Promise<void> {
    this.#rooms = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
      this.#requireApi().listRooms(accessToken),
    );
    this.#invitations = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
      this.#requireApi().listInvitations(accessToken),
    );
    if (this.#serverCapabilities.has("notifications")) {
      const listed = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
        this.#requireApi().listNotifications(accessToken, { after: 0, limit: 100 }),
      );
      this.#notifications = [...listed.items].sort((left, right) => right.cursor - left.cursor);
      this.#notificationCursor = Math.max(0, ...listed.items.map(({ cursor }) => cursor));
      this.#unreadNotificationCount = listed.unreadCount;
    } else {
      this.#notifications = [];
      this.#notificationCursor = 0;
      this.#unreadNotificationCount = 0;
    }
  }

  async #selectRoom(roomId: string): Promise<void> {
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (room === undefined || this.#account === null) {
      throw new Error("ROOM_NOT_FOUND");
    }
    this.#selection = ProductSelectionSchema.parse({
      userId: this.#account.id,
      roomId,
    });
    await this.#writeSelection(this.#selection);
    await this.#activateRoom(roomId, true);
  }

  async #activateRoom(roomId: string, selectionAlreadyPersisted: boolean): Promise<void> {
    const room = this.#rooms.find((candidate) => candidate.id === roomId);
    if (room === undefined || this.#account === null) {
      throw new Error("ROOM_NOT_FOUND");
    }
    if (!selectionAlreadyPersisted) {
      this.#selection = ProductSelectionSchema.parse({
        userId: this.#account.id,
        roomId,
      });
    }
    const detail = await this.#sessions.runAuthenticated(this.#profileId, (accessToken) =>
      this.#requireApi().getRoom(accessToken, roomId),
    );
    await this.#stopRuntime();
    this.#phase = "CONNECTING_ROOM";
    this.#errorCode = null;
    const runtimeInput: RoomRuntimeFactoryInput = {
      serverUrl: this.#serverUrl,
      userId: this.#account.id,
      deviceId: this.#deviceId,
      room,
      getAccessToken: () => this.#sessions.getAccessToken(this.#profileId),
      ...(this.#profiles === undefined
        ? {}
        : {
            profileId: this.#profileId,
            serverId: this.#serverId,
            serverCapabilities: [...this.#serverCapabilities],
            enableVolatilePointer: this.#serverCapabilities.has("volatile-pointer-v2"),
            enableContentCompatibility: this.#serverCapabilities.has("content-compatibility-v1"),
            onRoomEvent: (event: RoomEventMessage) => this.#scheduleRoomEvent(event),
            onNotificationCreated: (notification: Notification) =>
              this.#scheduleNotificationCreated(notification),
            onNotificationRead: (event: NotificationReadEvent) =>
              this.#scheduleNotificationRead(event),
            onStatusChanged: () => this.#emitChanged(["room", "collaboration"]),
          }),
    };
    const runtime = await this.#runtimeFactory(runtimeInput);
    try {
      await runtime.start();
    } catch (cause) {
      try {
        await runtime.stop();
      } catch {
        // The failed runtime is discarded regardless of cleanup outcome.
      }
      this.#runtime = undefined;
      this.#roomDetail = null;
      this.#phase = "ERROR";
      this.#errorCode = "ROOM_START_FAILED";
      throw cause;
    }
    this.#runtime = runtime;
    this.#roomDetail = detail;
    this.#phase = "ROOM_ACTIVE";
  }

  async #stopRuntime(): Promise<void> {
    this.#pendingMediaGestureObservations.clear();
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime !== undefined) {
      await runtime.stop();
    }
    this.#roomDetail = null;
  }

  async #readSelection(userId: string): Promise<ProductSelection | null> {
    const collection = await this.#loadSelectionCollection();
    let selection = collection.byProfile[this.#profileId];
    if (this.#profileId === DEFAULT_SERVER_PROFILE_ID) {
      const legacyInput = (await this.#area.get(LEGACY_PRODUCT_SELECTION_STORAGE_KEY))[
        LEGACY_PRODUCT_SELECTION_STORAGE_KEY
      ];
      await this.#area.remove(LEGACY_PRODUCT_SELECTION_STORAGE_KEY);
      const legacy = LegacyProductSelectionSchema.safeParse(legacyInput);
      if (selection === undefined && legacy.success && legacy.data.userId === userId) {
        selection = ProductSelectionSchema.parse({
          userId: legacy.data.userId,
          roomId: legacy.data.roomId,
        });
        collection.byProfile[this.#profileId] = selection;
        await this.#persistSelectionCollection(collection);
      }
    }
    if (selection === undefined) {
      return null;
    }
    if (selection.userId !== userId) {
      delete collection.byProfile[this.#profileId];
      await this.#persistSelectionCollection(collection);
      return null;
    }
    return structuredClone(selection);
  }

  async #clearSelection(): Promise<void> {
    this.#selection = null;
    this.#roomDetail = null;
    await this.#clearSelectionForProfile(this.#profileId);
  }

  async #clearSelectionForProfile(profileId: string): Promise<void> {
    const collection = await this.#loadSelectionCollection();
    delete collection.byProfile[profileId];
    await this.#persistSelectionCollection(collection);
  }

  async #writeSelection(selection: ProductSelection): Promise<void> {
    const collection = await this.#loadSelectionCollection();
    collection.byProfile[this.#profileId] = selection;
    await this.#persistSelectionCollection(collection);
  }

  async #loadSelectionCollection(): Promise<ProductSelectionCollection> {
    const input = (await this.#area.get(PRODUCT_SELECTION_STORAGE_KEY))[
      PRODUCT_SELECTION_STORAGE_KEY
    ];
    if (input === undefined) {
      return { version: 2, byProfile: {} };
    }
    const parsed = ProductSelectionCollectionSchema.safeParse(input);
    if (!parsed.success) {
      await this.#area.remove(PRODUCT_SELECTION_STORAGE_KEY);
      return { version: 2, byProfile: {} };
    }
    return parsed.data;
  }

  async #persistSelectionCollection(collection: ProductSelectionCollection): Promise<void> {
    await this.#area.set({
      [PRODUCT_SELECTION_STORAGE_KEY]: ProductSelectionCollectionSchema.parse(collection),
    });
  }

  async #handleProductFailure(cause: unknown): Promise<void> {
    await this.#stopRuntime();
    if (
      cause instanceof ExtensionSessionRequiredError ||
      (cause instanceof SyncActionApiError &&
        (cause.code === "SESSION_INVALID" ||
          cause.code === "SESSION_REPLAYED" ||
          cause.code === "ACCOUNT_SUSPENDED" ||
          cause.code === "ACCOUNT_REVOKED"))
    ) {
      this.#resetProductState("SESSION_EXPIRED");
      this.#errorCode = cause instanceof SyncActionApiError ? cause.code : "SESSION_REQUIRED";
      return;
    }
    this.#phase = "ERROR";
    this.#errorCode = errorCode(cause);
  }

  #requireStarted(): void {
    if (!this.#started) {
      throw new Error("APP_CONTROLLER_NOT_STARTED");
    }
  }

  #requireApi(): ExtensionProductApi {
    if (this.#api === null) {
      throw new Error(this.#errorCode ?? "SERVER_NOT_READY");
    }
    return this.#api;
  }

  #requireProfiles(): ExtensionServerProfilePort {
    if (this.#profiles === undefined) {
      throw new Error("SERVER_PROFILE_UNAVAILABLE");
    }
    return this.#profiles;
  }

  #requireRoomDetail(): PublicRoomDetail {
    this.#requireAuthenticated();
    if (this.#roomDetail === null) {
      throw new Error("ROOM_RUNTIME_UNAVAILABLE");
    }
    return this.#roomDetail;
  }

  #requireAuthenticated(): void {
    this.#requireStarted();
    if (this.#account === null || this.#account.status !== "ACTIVE") {
      throw new ExtensionSessionRequiredError();
    }
  }

  #requireCapability(capability: ServerCapability): void {
    if (!this.#serverCapabilities.has(capability)) {
      throw new Error("SERVER_UNSUPPORTED");
    }
  }

  #requireRuntime(): RoomRuntime {
    this.#requireAuthenticated();
    if (this.#runtime === undefined || this.#phase !== "ROOM_ACTIVE") {
      throw new Error("ROOM_RUNTIME_UNAVAILABLE");
    }
    return this.#runtime;
  }

  #resetProductState(phase: "SIGNED_OUT" | "SESSION_EXPIRED"): void {
    this.#pendingMediaGestureObservations.clear();
    this.#phase = phase;
    this.#account = null;
    this.#rooms = [];
    this.#invitations = [];
    this.#notifications = [];
    this.#notificationCursor = 0;
    this.#unreadNotificationCount = 0;
    this.#selection = null;
    this.#roomDetail = null;
    this.#runtime = undefined;
    this.#errorCode = null;
  }

  #emitChanged(hint?: UiSliceHint): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(hint);
      } catch {
        // One UI listener must not block product state propagation.
      }
    }
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function errorCode(cause: unknown): string {
  if (cause instanceof SyncActionApiError) {
    return cause.code;
  }
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return "UNKNOWN_ERROR";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function appMediaGestureObservationKey(
  tabIdInput: unknown,
  frameIdInput: unknown,
  message: MediaObservedMessage,
): string | null {
  if (
    typeof tabIdInput !== "number" ||
    !Number.isSafeInteger(tabIdInput) ||
    tabIdInput < 0 ||
    typeof frameIdInput !== "number" ||
    !Number.isSafeInteger(frameIdInput) ||
    frameIdInput < 0 ||
    message.applyToken !== null ||
    (message.event !== "STATE_CHANGED" && message.event !== "TARGET_CHANGED") ||
    message.target === null ||
    message.observed === null
  ) {
    return null;
  }
  return JSON.stringify([tabIdInput, frameIdInput, message]);
}

function projectCollaborationSummary(
  roomDetail: PublicRoomDetail | null,
  room: ExtensionStatus | null,
): ExtensionCollaborationSummary {
  if (roomDetail === null || room === null) {
    return emptyCollaborationSummary();
  }

  const pageIds = new Set(room.tabs.map((tab) => tab.logicalTabId));
  const presences = room.presence?.presences ?? [];
  const compatibilityByPage = new Map<string, ContentCompatibility[]>();
  for (const item of room.presence?.compatibilities ?? []) {
    if (!pageIds.has(item.logicalTabId)) {
      continue;
    }
    const values = compatibilityByPage.get(item.logicalTabId) ?? [];
    values.push(item.compatibility);
    compatibilityByPage.set(item.logicalTabId, values);
  }
  const presenceByUser = new Map<string, { deviceIds: Set<string>; activePageIds: Set<string> }>();
  for (const presence of presences) {
    const aggregate = presenceByUser.get(presence.userId) ?? {
      deviceIds: new Set<string>(),
      activePageIds: new Set<string>(),
    };
    aggregate.deviceIds.add(presence.deviceId);
    if (presence.logicalTabId !== null && pageIds.has(presence.logicalTabId)) {
      aggregate.activePageIds.add(presence.logicalTabId);
    }
    presenceByUser.set(presence.userId, aggregate);
  }

  const pages = room.tabs.map((tab) => {
    const compatibilities = compatibilityByPage.get(tab.logicalTabId) ?? [];
    const compatibility = aggregatePageCompatibility(compatibilities);
    return {
      pageId: tab.logicalTabId,
      title: tab.title,
      domain: tab.domain,
      state: "OPEN" as const,
      compatibility,
      compatibilityWarning: pageCompatibilityWarning(compatibility, compatibilities.length > 0),
    };
  });
  const members = roomDetail.members.map((member) => {
    const presence = presenceByUser.get(member.userId);
    return {
      userId: member.userId,
      displayName: member.displayName,
      roomRole: member.role,
      online: presence !== undefined && presence.deviceIds.size > 0,
      deviceCount: presence?.deviceIds.size ?? 0,
      activePageIds: [...(presence?.activePageIds ?? [])],
    };
  });
  const media = room.media;
  const canJump = media?.navigation.some((item) => item.canJump) ?? false;
  const playbackGroups =
    media?.playbackGroups.map((group) => {
      const canAlign = media.state === "ONLINE" && group.target !== null && group.observed !== null;
      return {
        groupId: group.playbackGroupId,
        name: `播放组 ${group.playbackGroupId.slice(0, 8)}`,
        state: playbackGroupState(group.status),
        statusText: playbackGroupStatusText(group.status),
        participants: group.members.map((member) => {
          const canJumpToMember = media.navigation.some(
            (candidate) => candidate.userId === member.userId && candidate.canJump,
          );
          return {
            userId: member.userId,
            role:
              member.userId === group.leaderUserId && member.activeDeviceId === group.leaderDeviceId
                ? ("LEADER" as const)
                : ("FOLLOWER" as const),
            statusText: member.online ? "在线" : "离线",
            canJump: canJumpToMember,
            canAlign,
            disabledReason: canAlign ? null : "当前媒体目标不可用",
          };
        }),
        canJoin: media.state === "ONLINE" && media.localMembership === null,
        joinDisabledReason:
          media.state !== "ONLINE"
            ? "媒体同步当前不可用"
            : media.localMembership !== null
              ? "已加入播放组"
              : null,
      };
    }) ?? [];
  const proposals =
    media?.playbackGroups.flatMap((group) => {
      const canDecide =
        media.state === "ONLINE" &&
        media.localMembership?.playbackGroupId === group.playbackGroupId &&
        media.localMembership.role === "LEADER" &&
        media.localMembership.activeDevice;
      if (!canDecide) {
        return [];
      }
      return group.proposals.map((proposal) => ({
        groupId: group.playbackGroupId,
        proposalId: proposal.proposalId,
        title: proposalTitle(proposal.action.type),
        detail: proposalDetail(proposal.action),
        state: "PENDING" as const,
        canApprove: canDecide,
        canReject: canDecide,
        disabledReason: canDecide ? null : "仅领播者可处理建议",
      }));
    }) ?? [];

  return {
    capacity: {
      openTabCount: room.sharedTabCount,
      limit: 20,
      exemption: "UNKNOWN",
    },
    navigation: {
      canJump,
      disabledReason: canJump
        ? null
        : media === null
          ? "同步跳转功能尚未启用"
          : "没有可跳转的成员页面",
    },
    pages,
    members,
    playbackGroups,
    tools: [
      ...(room.pointer === null ? [] : [pointerToolSummary(room.pointer)]),
      ...(room.danmaku === null || room.danmaku === undefined
        ? []
        : [danmakuToolSummary(room.danmaku)]),
      ...(room.drawing === null || room.drawing === undefined
        ? []
        : [drawingToolSummary(room.drawing)]),
    ],
    proposals,
    annotation:
      room.drawing === null || room.drawing === undefined
        ? unavailableAnnotationSummary()
        : drawingAnnotationSummary(room.drawing),
    activities: [],
  };
}

function playbackGroupState(
  status: NonNullable<ExtensionStatus["media"]>["playbackGroups"][number]["status"],
): ExtensionCollaborationPlaybackGroupSummary["state"] {
  if (status === "PLAYING") {
    return "PLAYING";
  }
  if (status === "PAUSED") {
    return "PAUSED";
  }
  if (status === "ENDED_WAITING") {
    return "ENDED";
  }
  return "PENDING";
}

function playbackGroupStatusText(
  status: NonNullable<ExtensionStatus["media"]>["playbackGroups"][number]["status"],
): string {
  switch (status) {
    case "PLAYING":
      return "播放中";
    case "PAUSED":
      return "已暂停";
    case "ENDED_WAITING":
      return "播放结束";
    case "LOADING":
      return "加载中";
    case "LEADER_GRACE":
      return "等待领播者恢复";
    case "IDLE":
      return "等待媒体";
  }
}

function proposalTitle(
  action: NonNullable<
    ExtensionStatus["media"]
  >["playbackGroups"][number]["proposals"][number]["action"]["type"],
): string {
  switch (action) {
    case "PLAY":
      return "建议播放";
    case "PAUSE":
      return "建议暂停";
    case "SEEK":
      return "建议调整进度";
    case "SET_RATE":
      return "建议调整倍速";
    case "SWITCH_TARGET":
      return "建议切换媒体";
  }
}

function proposalDetail(
  action: NonNullable<
    ExtensionStatus["media"]
  >["playbackGroups"][number]["proposals"][number]["action"],
): string {
  switch (action.type) {
    case "PLAY":
      return "跟随者希望继续播放";
    case "PAUSE":
      return "跟随者希望暂停播放";
    case "SEEK":
      return `跳转到 ${Math.round(action.positionMs / 1_000)} 秒`;
    case "SET_RATE":
      return `调整到 ${action.playbackRate} 倍速`;
    case "SWITCH_TARGET":
      return `切换到 ${action.target.provider} 媒体`;
  }
}

function aggregatePageCompatibility(
  compatibilities: readonly ContentCompatibility[],
): ContentCompatibility {
  if (compatibilities.includes("MISMATCH")) {
    return "MISMATCH";
  }
  if (compatibilities.includes("UNKNOWN") || compatibilities.length === 0) {
    return "UNKNOWN";
  }
  return "EXACT";
}

function pageCompatibilityWarning(
  compatibility: ContentCompatibility,
  hasRemoteComparison: boolean,
): string | null {
  if (!hasRemoteComparison || compatibility === "EXACT") {
    return null;
  }
  return compatibility === "MISMATCH"
    ? "页面内容与部分成员不同，坐标协作已保护性暂停"
    : "暂时无法确认页面内容一致，坐标协作已保护性暂停";
}

function emptyCollaborationSummary(): ExtensionCollaborationSummary {
  return {
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
    annotation: unavailableAnnotationSummary(),
    activities: [],
  };
}

function unavailableAnnotationSummary(): ExtensionCollaborationAnnotationSummary {
  return {
    used: 0,
    capacity: null,
    lockedCount: 0,
    state: "UNAVAILABLE",
    canCreate: false,
    disabledReason: "批注功能尚未启用",
  };
}

function pointerToolSummary(
  pointer: NonNullable<ExtensionStatus["pointer"]>,
): ExtensionCollaborationToolSummary {
  const permissionRequired =
    pointer.state === "DEGRADED" && pointer.errorCode === "POINTER_PERMISSION_REQUIRED";
  const state =
    pointer.state === "ONLINE"
      ? "ACTIVE"
      : pointer.state === "DEGRADED"
        ? "DEGRADED"
        : "UNAVAILABLE";
  const statusText =
    pointer.state === "ONLINE"
      ? "同页光标可用"
      : permissionRequired
        ? "当前站点未授权同页光标"
        : pointer.state === "DEGRADED"
          ? "同页光标受限"
          : "同页光标不可用";
  return {
    toolId: "pointer",
    kind: "POINTER",
    state,
    statusText,
    errorCode:
      pointer.errorCode === null
        ? null
        : permissionRequired
          ? "POINTER_PERMISSION_REQUIRED"
          : "POINTER_FAILURE",
    canActivate: permissionRequired,
    disabledReason: permissionRequired
      ? null
      : pointer.state === "ONLINE"
        ? "同页光标已启用"
        : "同页光标当前不可用",
  };
}

function danmakuToolSummary(
  danmaku: NonNullable<ExtensionStatus["danmaku"]>,
): ExtensionCollaborationToolSummary {
  const state =
    danmaku.state === "ONLINE"
      ? "AVAILABLE"
      : danmaku.state === "DEGRADED"
        ? "DEGRADED"
        : "UNAVAILABLE";
  return {
    toolId: "danmaku",
    kind: "DANMAKU",
    state,
    statusText:
      danmaku.state === "ONLINE"
        ? "页面弹幕可用"
        : danmaku.state === "DEGRADED"
          ? "页面弹幕发送受限"
          : "页面弹幕当前离线",
    errorCode: danmaku.errorCode,
    canActivate: danmaku.ready || danmaku.canRetry,
    disabledReason: danmaku.ready || danmaku.canRetry ? null : "页面弹幕当前不可用",
  };
}

function drawingToolSummary(
  drawing: NonNullable<ExtensionStatus["drawing"]>,
): ExtensionCollaborationToolSummary {
  const state =
    drawing.state === "ONLINE"
      ? "AVAILABLE"
      : drawing.state === "DEGRADED" || drawing.state === "SYNCING"
        ? "DEGRADED"
        : "UNAVAILABLE";
  const canActivate = drawing.ready || drawing.canRetry;
  return {
    toolId: "drawing",
    kind: "DRAWING",
    state,
    statusText:
      drawing.state === "ONLINE"
        ? "页面画笔可用"
        : drawing.state === "SYNCING"
          ? "正在恢复页面涂鸦"
          : drawing.state === "DEGRADED"
            ? "页面画笔受限"
            : "页面画笔当前离线",
    errorCode: drawing.errorCode,
    canActivate,
    disabledReason: canActivate ? null : "页面画笔当前不可用",
  };
}

function drawingAnnotationSummary(
  drawing: NonNullable<ExtensionStatus["drawing"]>,
): ExtensionCollaborationAnnotationSummary {
  return {
    used: drawing.used,
    capacity: drawing.capacity,
    lockedCount: drawing.lockedCount,
    state: drawing.capacityState,
    canCreate: drawing.canCreate,
    disabledReason: drawing.canCreate
      ? null
      : drawing.capacityState === "FULL"
        ? "页面涂鸦容量已满，请先删除不需要的涂鸦"
        : "当前页面画笔不可用",
  };
}
