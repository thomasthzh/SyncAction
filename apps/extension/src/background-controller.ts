import {
  CanonicalUuidSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  SupportedUrlSchema,
  type ContentCompatibility,
  type PageCompatibilityReport,
} from "@syncaction/protocol";
import {
  BrowserActuator,
  BrowserCircuitBreaker,
  BrowserObserver,
  EffectLedger,
  type BrowserPort,
  type BrowserObserverResult,
  type BrowserActuatorResult,
} from "@syncaction/browser-sync";
import {
  DurableReplica,
  ReplicaCoordinator,
  ReplicaRepository,
  type ReplicaCoordinatorState,
  type ReplicaPersistence,
  type ReplicaTransport,
} from "@syncaction/replica";
import { z } from "zod";
import {
  ActiveTabPresenceController,
  type ActiveTabPresenceStatus,
} from "./active-tab-presence.js";
import type { AnnotationReplica } from "./annotation-replica.js";
import {
  DanmakuController,
  type DanmakuControllerPagePort,
  type DanmakuControllerStatus,
} from "./danmaku-controller.js";
import {
  DrawingController,
  type DrawingControllerPagePort,
  type DrawingControllerStatus,
  type DrawingPageReport,
} from "./drawing-controller.js";
import {
  PointerController,
  type PointerControllerStatus,
  type PointerPagePort,
} from "./pointer-controller.js";
import {
  MediaController,
  MediaControllerError,
  type MediaControllerStatus,
  type MediaNavigationPort,
  type MediaPagePort,
} from "./media-controller.js";
import type { PageToolCommandPort } from "./page-collaboration/chrome-page-port.js";
import {
  CollaborationPageContextSchema,
  PageCapabilityMessageSchema,
  type CollaborationPageContext,
  type DanmakuReportMessage,
  type DanmakuSubmitMessage,
  type DrawingReportMessage,
  type DrawingSelectionMessage,
  type DrawingDraftControlMessage,
  type MediaObservedMessage,
  type PageCapabilityReport,
  type StrokeFinalMessage,
  type StrokeSampleMessage,
} from "./page-collaboration/messages.js";
import { RoomBrowserController, type RoomBrowserStatus } from "./room-browser-controller.js";
import { parsePublicServerOrigin } from "./server-origin.js";
import type {
  CollaborationTransport,
  MediaTransport,
  PointerTransport,
  PresenceTransport,
} from "./socket-transport.js";

const INITIAL_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

export const ExtensionRuntimeConfigSchema = z
  .object({
    serverUrl: SupportedUrlSchema.transform((value, context) => {
      try {
        return parsePublicServerOrigin(value);
      } catch {
        context.addIssue({
          code: "custom",
          message: "The extension requires HTTPS or loopback HTTP",
        });
        return z.NEVER;
      }
    }),
    accessToken: z.string().min(1).max(8_192),
    roomId: RoomIdSchema,
    roomName: z.string().trim().min(1).max(120),
    userId: CanonicalUuidSchema,
    deviceId: DeviceIdSchema,
    roomRole: z.enum(["OWNER", "MEMBER"]).optional(),
  })
  .strict();

export type ExtensionRuntimeConfig = z.infer<typeof ExtensionRuntimeConfigSchema>;

export interface ExtensionRuntimeConfigStore {
  read(): Promise<unknown | undefined>;
}

export interface ExtensionTabStatus {
  logicalTabId: string;
  title: string;
  domain: string;
}

export interface ExtensionStatus {
  state: ReplicaCoordinatorState | "NOT_CONFIGURED" | "CONFIGURATION_ERROR";
  roomName: string | null;
  serverSeq: number | null;
  sharedTabCount: number;
  outboxCount: number;
  pendingConfirmationCount: number;
  bindingCount: number;
  browser: RoomBrowserStatus | null;
  presence: ActiveTabPresenceStatus | null;
  pointer: PointerControllerStatus | null;
  media: MediaControllerStatus | null;
  danmaku?: DanmakuControllerStatus | null;
  drawing?: DrawingControllerStatus | null;
  tabs: ExtensionTabStatus[];
}

export interface BackgroundControllerOptions {
  persistence: ReplicaPersistence;
  configStore: ExtensionRuntimeConfigStore;
  transportFactory: (config: ExtensionRuntimeConfig) => ReplicaTransport;
  browserPort?: BrowserPort;
  browserSessionId?: unknown;
  pagePort?: PointerPagePort &
    MediaPagePort &
    Partial<PageToolCommandPort & DanmakuControllerPagePort & DrawingControllerPagePort>;
  mediaNavigationPort?: MediaNavigationPort;
  annotationReplica?: AnnotationReplica;
  enableVolatilePointer?: boolean;
  enableContentCompatibility?: boolean;
  onStatusChanged?: () => void;
}

export class BackgroundController {
  readonly #persistence: ReplicaPersistence;
  readonly #configStore: ExtensionRuntimeConfigStore;
  readonly #transportFactory: (config: ExtensionRuntimeConfig) => ReplicaTransport;
  readonly #browserPort: BrowserPort | undefined;
  readonly #browserSessionId: string | undefined;
  readonly #pagePort:
    | (PointerPagePort &
        MediaPagePort &
        Partial<PageToolCommandPort & DanmakuControllerPagePort & DrawingControllerPagePort>)
    | undefined;
  readonly #annotationReplica: AnnotationReplica | undefined;
  readonly #mediaNavigationPort: MediaNavigationPort | undefined;
  readonly #enableVolatilePointer: boolean;
  readonly #enableContentCompatibility: boolean;
  readonly #onStatusChanged: (() => void) | undefined;
  #config: ExtensionRuntimeConfig | undefined;
  #replica: DurableReplica | undefined;
  #coordinator: ReplicaCoordinator | undefined;
  #roomBrowserController: RoomBrowserController | undefined;
  #presenceController: ActiveTabPresenceController | undefined;
  #pointerController: PointerController | undefined;
  #mediaController: MediaController | undefined;
  #danmakuController: DanmakuController | undefined;
  #drawingController: DrawingController | undefined;
  #activeTabId: number | undefined;
  #state: ExtensionStatus["state"] = "NOT_CONFIGURED";
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #stopping = false;

  public constructor(options: BackgroundControllerOptions) {
    this.#persistence = options.persistence;
    this.#configStore = options.configStore;
    this.#transportFactory = options.transportFactory;
    this.#browserPort = options.browserPort;
    this.#pagePort = options.pagePort;
    this.#mediaNavigationPort = options.mediaNavigationPort;
    this.#annotationReplica = options.annotationReplica;
    this.#enableVolatilePointer = options.enableVolatilePointer ?? true;
    this.#enableContentCompatibility = options.enableContentCompatibility ?? true;
    this.#onStatusChanged = options.onStatusChanged;
    this.#browserSessionId =
      options.browserSessionId === undefined
        ? undefined
        : z.string().uuid().parse(options.browserSessionId);
  }

  public async start(): Promise<void> {
    if (this.#coordinator !== undefined) {
      throw new Error("background controller is already started");
    }
    this.#stopping = false;
    const configInput = await this.#configStore.read();
    if (configInput === undefined) {
      this.#state = "NOT_CONFIGURED";
      this.#notifyStatusChanged();
      return;
    }
    const parsed = ExtensionRuntimeConfigSchema.safeParse(configInput);
    if (!parsed.success) {
      this.#state = "CONFIGURATION_ERROR";
      this.#notifyStatusChanged();
      return;
    }
    this.#config = parsed.data;
    const repository = new ReplicaRepository({ persistence: this.#persistence });
    this.#replica = new DurableReplica({
      repository,
      roomId: parsed.data.roomId,
      deviceId: parsed.data.deviceId,
    });
    let roomBrowserController: RoomBrowserController | undefined;
    const transport = this.#transportFactory(parsed.data);
    let presenceController: ActiveTabPresenceController | undefined;
    let pointerController: PointerController | undefined;
    let mediaController: MediaController | undefined;
    let danmakuController: DanmakuController | undefined;
    let drawingController: DrawingController | undefined;
    const coordinator = new ReplicaCoordinator({
      replica: this.#replica,
      transport,
      roomId: parsed.data.roomId,
      onStateChange: (state) => {
        this.#state = state;
        if (state === "SYNCED") {
          this.#reconnectAttempt = 0;
        }
        void presenceController?.setSynchronized(state === "SYNCED");
        void pointerController?.setSynchronized(state === "SYNCED");
        void mediaController?.setSynchronized(state === "SYNCED");
        void danmakuController?.setSynchronized(state === "SYNCED");
        void drawingController?.setSynchronized(state === "SYNCED");
        this.#notifyStatusChanged();
      },
      onTransition: () => {
        if (roomBrowserController !== undefined) {
          void roomBrowserController
            .handleReplicaTransition()
            .then(async () => {
              await presenceController?.handleBindingsChanged();
              await pointerController?.handleBindingsChanged();
              await mediaController?.handleBindingsChanged();
              await danmakuController?.handleBindingsChanged();
              await drawingController?.handleBindingsChanged();
              this.#notifyStatusChanged();
            })
            .catch(() => undefined);
        } else {
          void Promise.all([
            presenceController?.handleBindingsChanged(),
            pointerController?.handleBindingsChanged(),
            mediaController?.handleBindingsChanged(),
            danmakuController?.handleBindingsChanged(),
            drawingController?.handleBindingsChanged(),
          ])
            .then(() => this.#notifyStatusChanged())
            .catch(() => undefined);
        }
      },
      onConnectionFailure: () => this.#scheduleReconnect(),
    });
    if (this.#browserPort !== undefined) {
      const ledger = new EffectLedger();
      const actuator = new BrowserActuator({
        roomId: parsed.data.roomId,
        replica: this.#replica,
        browser: this.#browserPort,
        ledger,
        breaker: new BrowserCircuitBreaker(),
        isActuatable: () => coordinator.isActuatable(),
      });
      const observer = new BrowserObserver({
        roomId: parsed.data.roomId,
        replica: this.#replica,
        browser: this.#browserPort,
        ledger,
        writer: coordinator,
        isActuatable: () => coordinator.isActuatable(),
      });
      roomBrowserController = new RoomBrowserController({
        observer,
        actuator,
      });
      this.#roomBrowserController = roomBrowserController;
    }
    if (this.#browserSessionId !== undefined && isPresenceTransport(transport)) {
      presenceController = new ActiveTabPresenceController({
        roomId: parsed.data.roomId,
        browserSessionId: this.#browserSessionId,
        userId: parsed.data.userId,
        deviceId: parsed.data.deviceId,
        replica: this.#replica,
        transport,
        requestRoomSync: async () => {
          const record = await this.#replica!.getRecord();
          const confirmed = record.confirmedSnapshot;
          await transport.synchronize({
            protocolVersion: 1,
            roomId: parsed.data.roomId,
            roomEpoch: confirmed?.roomEpoch ?? 0,
            lastServerSeq: confirmed?.serverSeq ?? 0,
            hasConfirmedSnapshot: confirmed !== null,
          });
        },
        onRemotePresenceChanged: async (logicalTabIds) => {
          await Promise.all(
            logicalTabIds.flatMap((logicalTabId) => [
              pointerController?.handleContentCompatibilityChanged(logicalTabId),
              this.#activeTabId === undefined
                ? undefined
                : drawingController?.handleContentCompatibilityChanged(
                    this.#activeTabId,
                    logicalTabId,
                  ),
            ]),
          );
          this.#notifyStatusChanged();
        },
      });
      this.#presenceController = presenceController;
    }
    if (
      this.#browserSessionId !== undefined &&
      this.#pagePort !== undefined &&
      this.#enableVolatilePointer &&
      this.#enableContentCompatibility &&
      presenceController !== undefined &&
      isPointerTransport(transport)
    ) {
      pointerController = new PointerController({
        roomId: parsed.data.roomId,
        browserSessionId: this.#browserSessionId,
        deviceId: parsed.data.deviceId,
        replica: this.#replica,
        transport,
        page: this.#pagePort,
        compatibility: presenceController,
      });
      this.#pointerController = pointerController;
    }
    if (
      this.#browserSessionId !== undefined &&
      this.#pagePort !== undefined &&
      this.#enableContentCompatibility &&
      presenceController !== undefined &&
      isMediaTransport(transport)
    ) {
      mediaController = new MediaController({
        roomId: parsed.data.roomId,
        userId: parsed.data.userId,
        deviceId: parsed.data.deviceId,
        browserSessionId: this.#browserSessionId,
        replica: this.#replica,
        presence: presenceController,
        page: this.#pagePort,
        transport,
        compatibility: presenceController,
        ...(this.#mediaNavigationPort === undefined
          ? {}
          : { navigation: this.#mediaNavigationPort }),
      });
      this.#mediaController = mediaController;
    }
    if (
      this.#browserSessionId !== undefined &&
      this.#pagePort !== undefined &&
      this.#enableContentCompatibility &&
      isDanmakuPagePort(this.#pagePort) &&
      isCollaborationTransport(transport)
    ) {
      danmakuController = new DanmakuController({
        roomId: parsed.data.roomId,
        browserSessionId: this.#browserSessionId,
        replica: this.#replica,
        transport,
        page: this.#pagePort,
      });
      this.#danmakuController = danmakuController;
    }
    if (
      this.#browserSessionId !== undefined &&
      this.#pagePort !== undefined &&
      this.#enableContentCompatibility &&
      this.#annotationReplica !== undefined &&
      presenceController !== undefined &&
      isDrawingPagePort(this.#pagePort) &&
      isCollaborationTransport(transport)
    ) {
      drawingController = new DrawingController({
        roomId: parsed.data.roomId,
        userId: parsed.data.userId,
        roomRole: parsed.data.roomRole ?? "MEMBER",
        browserSessionId: this.#browserSessionId,
        replica: this.#replica,
        annotations: this.#annotationReplica,
        contentSignatures: presenceController,
        transport,
        page: this.#pagePort,
      });
      this.#drawingController = drawingController;
    }
    this.#coordinator = coordinator;
    try {
      await coordinator.start();
      await roomBrowserController?.whenIdle();
      await presenceController?.whenIdle();
      await pointerController?.whenIdle();
      await mediaController?.whenIdle();
      await danmakuController?.whenIdle();
      await drawingController?.whenIdle();
    } catch {
      this.#state = coordinator.state;
      this.#scheduleReconnect();
    } finally {
      this.#notifyStatusChanged();
    }
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    this.#clearReconnectTimer();
    const coordinatorWasStarted = this.#coordinator !== undefined;
    await this.#coordinator?.stop();
    await this.#mediaController?.dispose();
    await this.#drawingController?.dispose();
    await this.#danmakuController?.dispose();
    await this.#pointerController?.dispose();
    await this.#presenceController?.dispose();
    await this.#roomBrowserController?.whenIdle();
    this.#activeTabId = undefined;
    this.#state = "DISCONNECTED";
    if (!coordinatorWasStarted) {
      this.#notifyStatusChanged();
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#coordinator === undefined || this.#reconnectTimer !== undefined) {
      return;
    }
    const delay =
      INITIAL_RECONNECT_DELAYS_MS[
        Math.min(this.#reconnectAttempt, INITIAL_RECONNECT_DELAYS_MS.length - 1)
      ]!;
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#retryConnection();
    }, delay);
  }

  async #retryConnection(): Promise<void> {
    const coordinator = this.#coordinator;
    if (this.#stopping || coordinator === undefined || coordinator.state !== "DISCONNECTED") {
      return;
    }
    try {
      await coordinator.start();
    } catch {
      if (!this.#stopping && coordinator === this.#coordinator) {
        this.#state = coordinator.state;
        this.#scheduleReconnect();
      }
    } finally {
      this.#notifyStatusChanged();
    }
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === undefined) {
      return;
    }
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  public async whenIdle(): Promise<void> {
    await this.#coordinator?.whenIdle();
    await this.#roomBrowserController?.whenIdle();
    await this.#presenceController?.whenIdle();
    await this.#pointerController?.whenIdle();
    await this.#mediaController?.whenIdle();
    await this.#danmakuController?.whenIdle();
    await this.#drawingController?.whenIdle();
  }

  public async handleBrowserEvent(eventInput: unknown): Promise<BrowserObserverResult | undefined> {
    const result = await this.#roomBrowserController?.handleBrowserEvent(eventInput);
    if (result?.kind === "INTENT_RECORDED" || result?.kind === "EFFECT_CONSUMED") {
      await this.#presenceController?.handleBindingsChanged();
      await this.#pointerController?.handleBindingsChanged();
      await this.#mediaController?.handleBindingsChanged();
      await this.#danmakuController?.handleBindingsChanged();
      await this.#drawingController?.handleBindingsChanged();
    }
    this.#notifyStatusChanged();
    return result;
  }

  public async shareBrowserTab(tabIdInput: unknown): Promise<BrowserObserverResult | undefined> {
    const result = await this.#roomBrowserController?.shareBrowserTab(tabIdInput);
    await this.handleActiveTabChanged(tabIdInput);
    return result;
  }

  public async confirmBrowserRecovery(): Promise<BrowserActuatorResult | undefined> {
    const result = await this.#roomBrowserController?.confirmRecovery();
    await this.#presenceController?.handleBindingsChanged();
    await this.#pointerController?.handleBindingsChanged();
    await this.#mediaController?.handleBindingsChanged();
    await this.#danmakuController?.handleBindingsChanged();
    await this.#drawingController?.handleBindingsChanged();
    this.#notifyStatusChanged();
    return result;
  }

  public async handleActiveTabChanged(tabIdInput: unknown): Promise<void> {
    const tabId = z.number().int().nonnegative().safe().parse(tabIdInput);
    this.#activeTabId = tabId;
    await this.#presenceController?.handleActiveTabChanged(tabId);
    await this.#pointerController?.handleActiveTabChanged(tabId);
    await this.#mediaController?.handleActiveTabChanged(tabId);
    await this.#danmakuController?.handleActiveTabChanged(tabId);
    await this.#drawingController?.handleActiveTabChanged(tabId);
    this.#notifyStatusChanged();
  }

  public async getPageDocumentRevision(tabIdInput: unknown) {
    const tabId = z.number().int().nonnegative().safe().parse(tabIdInput);
    try {
      const route = await this.#requirePageToolRoute();
      if (route.tabId !== tabId) {
        return null;
      }
      return structuredClone(route.context.documentRevision);
    } catch {
      return null;
    }
  }

  public async getPageContentCompatibility(
    tabIdInput: unknown,
  ): Promise<ContentCompatibility | null> {
    const tabId = z.number().int().nonnegative().safe().parse(tabIdInput);
    const presence = this.#presenceController;
    if (presence === undefined) {
      return null;
    }
    try {
      const route = await this.#requirePageToolRoute();
      if (route.tabId !== tabId) {
        return null;
      }
      const values =
        presence
          .getStatus()
          .compatibilities?.filter((item) => item.logicalTabId === route.context.logicalTabId)
          .map((item) => item.compatibility) ?? [];
      if (values.includes("MISMATCH")) {
        return "MISMATCH";
      }
      if (values.length === 0 || values.includes("UNKNOWN")) {
        return "UNKNOWN";
      }
      return "EXACT";
    } catch {
      return null;
    }
  }

  public async toggleDanmakuInput(): Promise<void> {
    const route = await this.#requirePageToolRoute();
    if (this.#pagePort?.toggleDanmakuInput === undefined) {
      throw new Error("PAGE_TOOL_UNAVAILABLE");
    }
    const controller = this.#danmakuController;
    if (
      controller !== undefined &&
      !controller.isReadyFor(route.tabId, route.context) &&
      !controller.canRetryFor(route.tabId, route.context)
    ) {
      throw new Error("PAGE_TOOL_NOT_READY");
    }
    const response = PageCapabilityMessageSchema.parse(
      await this.#pagePort.toggleDanmakuInput(route.tabId, route.context),
    );
    if (response.capability !== "DANMAKU" || response.state !== "AVAILABLE") {
      throw new Error("PAGE_TOOL_NOT_READY");
    }
    await controller?.handlePageCapability({
      tabId: route.tabId,
      frameId: 0,
      message: response,
    });
    this.#notifyStatusChanged();
  }

  public async setDanmakuHidden(hiddenInput: unknown): Promise<void> {
    const hidden = z.boolean().parse(hiddenInput);
    const route = await this.#requirePageToolRoute();
    if (this.#pagePort?.setDanmakuHidden === undefined) {
      throw new Error("PAGE_TOOL_UNAVAILABLE");
    }
    const controller = this.#danmakuController;
    if (
      controller !== undefined &&
      !controller.isReadyFor(route.tabId, route.context) &&
      !controller.canRetryFor(route.tabId, route.context)
    ) {
      throw new Error("PAGE_TOOL_NOT_READY");
    }
    const response = PageCapabilityMessageSchema.parse(
      await this.#pagePort.setDanmakuHidden(route.tabId, route.context, hidden),
    );
    if (response.capability !== "DANMAKU" || response.state !== "AVAILABLE") {
      throw new Error("PAGE_TOOL_NOT_READY");
    }
    await controller?.handlePageCapability({
      tabId: route.tabId,
      frameId: 0,
      message: response,
    });
    this.#notifyStatusChanged();
  }

  public async togglePagePen(): Promise<void> {
    const route = await this.#requirePageToolRoute();
    if (this.#pagePort?.togglePagePen === undefined) {
      throw new Error("PAGE_TOOL_UNAVAILABLE");
    }
    const controller = this.#drawingController;
    if (
      controller !== undefined &&
      !controller.isReadyFor(route.tabId, route.context) &&
      !controller.canRetryFor(route.tabId, route.context)
    ) {
      throw new Error("PAGE_TOOL_NOT_READY");
    }
    const response = PageCapabilityMessageSchema.parse(
      await this.#pagePort.togglePagePen(route.tabId, route.context),
    );
    if (response.capability !== "DRAWING" || response.state !== "AVAILABLE") {
      throw new Error("PAGE_TOOL_NOT_READY");
    }
    await controller?.handlePageCapability({
      tabId: route.tabId,
      frameId: 0,
      message: response,
    });
    this.#notifyStatusChanged();
  }

  public async handlePointerPageReady(tabIdInput: unknown): Promise<void> {
    await this.#pointerController?.handlePageReady(tabIdInput);
    this.#notifyStatusChanged();
  }

  public async handlePageCompatibilityReport(
    tabIdInput: unknown,
    reportInput: PageCompatibilityReport,
  ): Promise<void> {
    const accepted = await this.#presenceController?.handlePageCompatibilityReport(
      tabIdInput,
      reportInput,
    );
    if (accepted === true) {
      await Promise.all([
        this.#pointerController?.handleContentCompatibilityChanged(reportInput.logicalTabId),
        this.#drawingController?.handleContentCompatibilityChanged(
          tabIdInput,
          reportInput.logicalTabId,
        ),
      ]);
      this.#notifyStatusChanged();
    }
  }

  public async handleMediaPageReady(
    tabIdInput: unknown,
    frameIdInput: unknown = 0,
    frameKeyInput: unknown = "top",
  ): Promise<void> {
    await this.#mediaController?.handlePageReady(tabIdInput, frameIdInput, frameKeyInput);
    this.#notifyStatusChanged();
  }

  public async handlePageToolFrameReady(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
    rootGenerationInput?: unknown,
  ): Promise<void> {
    await Promise.all([
      this.#danmakuController?.handlePageReady(
        tabIdInput,
        frameIdInput,
        frameKeyInput,
        rootGenerationInput,
      ),
      this.#drawingController?.handlePageReady(
        tabIdInput,
        frameIdInput,
        frameKeyInput,
        rootGenerationInput,
      ),
    ]);
    this.#notifyStatusChanged();
  }

  public async handlePageToolFrameUnavailable(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
  ): Promise<void> {
    await Promise.all([
      this.#danmakuController?.handlePageUnavailable(tabIdInput, frameIdInput, frameKeyInput),
      this.#drawingController?.handlePageUnavailable(tabIdInput, frameIdInput, frameKeyInput),
    ]);
    this.#notifyStatusChanged();
  }

  public async handleMediaObserved(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: MediaObservedMessage,
  ): Promise<void> {
    await this.#mediaController?.handleMediaObserved(tabIdInput, frameIdInput, messageInput);
  }

  public async handlePointerLocalSample(tabIdInput: unknown, sampleInput: unknown): Promise<void> {
    await this.#pointerController?.handleLocalSample(tabIdInput, sampleInput);
  }

  public async handleDanmakuSubmit(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DanmakuSubmitMessage,
  ): Promise<void> {
    if (this.#danmakuController === undefined) {
      throw new Error("DANMAKU_CONTROLLER_UNAVAILABLE");
    }
    await this.#danmakuController.handleSubmit(tabIdInput, frameIdInput, messageInput);
  }

  public async handleDanmakuReport(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DanmakuReportMessage,
  ): Promise<void> {
    await this.#danmakuController?.handlePageReport(tabIdInput, frameIdInput, messageInput);
    this.#notifyStatusChanged();
  }

  public async handleStrokeSample(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: StrokeSampleMessage,
  ): Promise<void> {
    await this.#drawingController?.handleStrokeSample(tabIdInput, frameIdInput, messageInput);
  }

  public async handleStrokeFinal(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: StrokeFinalMessage,
  ): Promise<void> {
    if (this.#drawingController === undefined) {
      throw new Error("DRAWING_CONTROLLER_UNAVAILABLE");
    }
    await this.#drawingController.handleStrokeFinal(tabIdInput, frameIdInput, messageInput);
    this.#notifyStatusChanged();
  }

  public async handleDrawingSelection(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingSelectionMessage,
  ): Promise<void> {
    if (this.#drawingController === undefined) {
      throw new Error("DRAWING_CONTROLLER_UNAVAILABLE");
    }
    await this.#drawingController.handleSelection(tabIdInput, frameIdInput, messageInput);
    this.#notifyStatusChanged();
  }

  public async handleDrawingDraftControl(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingDraftControlMessage,
  ): Promise<void> {
    if (this.#drawingController === undefined) {
      throw new Error("DRAWING_CONTROLLER_UNAVAILABLE");
    }
    await this.#drawingController.handleDraftControl(tabIdInput, frameIdInput, messageInput);
    this.#notifyStatusChanged();
  }

  public async handleDrawingReport(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DrawingReportMessage,
  ): Promise<void> {
    const report: DrawingPageReport = {
      context: messageInput.context,
      active: messageInput.active,
      tool: messageInput.tool,
      rgb: messageInput.rgb,
      width: messageInput.width,
      selectedCount: messageInput.selectedCount,
      selectedLockedCount: messageInput.selectedLockedCount,
      unlocatableCount: messageInput.unlocatableCount,
    };
    await this.#drawingController?.handlePageReport(tabIdInput, frameIdInput, report);
    this.#notifyStatusChanged();
  }

  public async handlePageCapability(reportInput: PageCapabilityReport): Promise<void> {
    this.#pointerController?.handlePageCapability(reportInput);
    await Promise.all([
      this.#mediaController?.handlePageCapability(reportInput),
      this.#danmakuController?.handlePageCapability(reportInput),
      this.#drawingController?.handlePageCapability(reportInput),
    ]);
    this.#notifyStatusChanged();
  }

  public async handlePagePermissionBoundaryChanged(): Promise<void> {
    await this.#presenceController?.handlePermissionBoundaryChanged();
    await Promise.all([
      this.#mediaController?.handlePermissionBoundaryChanged(),
      this.#pointerController?.handlePermissionBoundaryChanged(),
      this.#danmakuController?.handlePermissionBoundaryChanged(),
      this.#drawingController?.handlePermissionBoundaryChanged(),
    ]);
    this.#notifyStatusChanged();
  }

  public async jumpToMediaMember(userId: string): Promise<void> {
    await this.#requireMediaController().jumpToMember(userId);
    this.#notifyStatusChanged();
  }

  public async alignMediaGroupOnce(playbackGroupId: string): Promise<void> {
    await this.#requireMediaController().alignOnce(playbackGroupId);
    this.#notifyStatusChanged();
  }

  public async joinMediaGroup(playbackGroupId: string): Promise<void> {
    await this.#requireMediaController().joinGroup(playbackGroupId);
    this.#notifyStatusChanged();
  }

  public async leaveMediaGroup(playbackGroupId?: string): Promise<void> {
    await this.#requireMediaController().leaveGroup(playbackGroupId);
    this.#notifyStatusChanged();
  }

  public async closeMediaGroup(playbackGroupId?: string): Promise<void> {
    await this.#requireMediaController().closeGroup(playbackGroupId);
    this.#notifyStatusChanged();
  }

  public async takeOverMediaDevice(playbackGroupId: string): Promise<void> {
    await this.#requireMediaController().takeOverDevice(playbackGroupId);
    this.#notifyStatusChanged();
  }

  public async decideMediaProposal(
    playbackGroupId: string,
    proposalId: string,
    decision: "APPROVE" | "REJECT",
  ): Promise<void> {
    await this.#requireMediaController().decide(playbackGroupId, proposalId, decision);
    this.#notifyStatusChanged();
  }

  public async getStatus(): Promise<ExtensionStatus> {
    const config = this.#config;
    const replica = this.#replica;
    if (config === undefined || replica === undefined) {
      return {
        state: this.#state,
        roomName: null,
        serverSeq: null,
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
    const record = await replica.getRecord();
    const snapshot = record.confirmedSnapshot;
    const tabsById = new Map(snapshot?.tabs.map((tab) => [tab.id, tab]) ?? []);
    const tabs =
      snapshot?.order.flatMap((logicalTabId) => {
        const tab = tabsById.get(logicalTabId);
        if (tab === undefined) {
          return [];
        }
        const domain = new URL(tab.url).hostname;
        return [
          {
            logicalTabId,
            title: tab.title ?? domain,
            domain,
          },
        ];
      }) ?? [];
    return {
      state: this.#state,
      roomName: config.roomName,
      serverSeq: snapshot?.serverSeq ?? null,
      sharedTabCount: tabs.length,
      outboxCount: record.outbox.length,
      pendingConfirmationCount: record.pendingConfirmations.length,
      bindingCount: record.bindings.length,
      browser: this.#roomBrowserController?.getStatus() ?? null,
      presence: this.#presenceController?.getStatus() ?? null,
      pointer: this.#pointerController?.getStatus() ?? null,
      media: this.#mediaController?.getStatus() ?? null,
      danmaku: this.#danmakuController?.getStatus() ?? null,
      drawing: this.#drawingController?.getStatus() ?? null,
      tabs,
    };
  }

  public async activateLogicalTab(logicalTabIdInput: unknown): Promise<void> {
    const logicalTabId = LogicalTabIdSchema.parse(logicalTabIdInput);
    const replica = this.#replica;
    const navigation = this.#mediaNavigationPort;
    if (this.#state !== "SYNCED" || replica === undefined || navigation === undefined) {
      throw new Error("ROOM_TAB_NOT_AVAILABLE");
    }
    const record = await replica.getRecord();
    const snapshot = record.confirmedSnapshot;
    const binding = record.bindings.find(
      (candidate) =>
        candidate.logicalTabId === logicalTabId &&
        (this.#browserSessionId === undefined ||
          candidate.browserSessionId === this.#browserSessionId),
    );
    const tab = snapshot?.tabs.find(
      (candidate) => candidate.id === logicalTabId && candidate.closedAtSeq === null,
    );
    if (
      record.mode !== "SYNCED" ||
      snapshot === null ||
      binding === undefined ||
      tab === undefined ||
      binding.validatedAtServerSeq !== snapshot.serverSeq
    ) {
      throw new Error("ROOM_TAB_NOT_AVAILABLE");
    }
    await navigation.activateTab(binding.tabId);
  }

  #requireMediaController(): MediaController {
    if (this.#mediaController === undefined) {
      throw new MediaControllerError("MEDIA_CONTROLLER_UNAVAILABLE");
    }
    return this.#mediaController;
  }

  #notifyStatusChanged(): void {
    try {
      this.#onStatusChanged?.();
    } catch {
      // A UI observer must never be able to interrupt collaboration state transitions.
    }
  }

  async #requirePageToolRoute(): Promise<{
    tabId: number;
    context: CollaborationPageContext;
  }> {
    const tabId = this.#activeTabId;
    const replica = this.#replica;
    const config = this.#config;
    if (
      this.#state !== "SYNCED" ||
      tabId === undefined ||
      replica === undefined ||
      config === undefined ||
      this.#pagePort === undefined
    ) {
      throw new Error("PAGE_TOOL_UNAVAILABLE");
    }
    const record = await replica.getRecord();
    const snapshot = record.confirmedSnapshot;
    const binding = record.bindings.find(
      (candidate) =>
        candidate.tabId === tabId &&
        (this.#browserSessionId === undefined ||
          candidate.browserSessionId === this.#browserSessionId),
    );
    const tab = snapshot?.tabs.find(
      (candidate) => candidate.id === binding?.logicalTabId && candidate.closedAtSeq === null,
    );
    if (
      record.mode !== "SYNCED" ||
      snapshot === null ||
      binding === undefined ||
      tab === undefined ||
      binding.validatedAtServerSeq !== snapshot.serverSeq
    ) {
      throw new Error("PAGE_TOOL_UNAVAILABLE");
    }
    return {
      tabId,
      context: CollaborationPageContextSchema.parse({
        roomId: config.roomId,
        logicalTabId: binding.logicalTabId,
        documentRevision: {
          roomEpoch: snapshot.roomEpoch,
          tabUpdatedAtSeq: tab.updatedAtSeq,
        },
        frameKey: "top",
      }),
    };
  }
}

function isPresenceTransport(
  transport: ReplicaTransport,
): transport is ReplicaTransport & PresenceTransport {
  const candidate = transport as Partial<PresenceTransport>;
  return (
    typeof candidate.setPresenceHandler === "function" &&
    typeof candidate.publishPresence === "function"
  );
}

function isPointerTransport(
  transport: ReplicaTransport,
): transport is ReplicaTransport & PointerTransport {
  const candidate = transport as Partial<PointerTransport>;
  return (
    typeof candidate.setPointerHandler === "function" &&
    typeof candidate.publishPointerLease === "function" &&
    typeof candidate.publishPointerFrame === "function" &&
    typeof candidate.publishPointer === "function"
  );
}

function isMediaTransport(
  transport: ReplicaTransport,
): transport is ReplicaTransport & MediaTransport {
  const candidate = transport as Partial<MediaTransport>;
  return (
    typeof candidate.setMediaHandler === "function" &&
    typeof candidate.sendMediaCommand === "function" &&
    typeof candidate.publishMediaHeartbeat === "function"
  );
}

function isCollaborationTransport(
  transport: ReplicaTransport,
): transport is ReplicaTransport & CollaborationTransport {
  const candidate = transport as Partial<CollaborationTransport>;
  return (
    typeof candidate.setAnnotationHandler === "function" &&
    typeof candidate.setDanmakuHandler === "function" &&
    typeof candidate.setStrokePreviewHandler === "function" &&
    typeof candidate.synchronizeAnnotations === "function" &&
    typeof candidate.submitAnnotation === "function" &&
    typeof candidate.sendDanmaku === "function" &&
    typeof candidate.publishStrokePreview === "function" &&
    typeof candidate.clearStrokePreview === "function"
  );
}

function isDanmakuPagePort(
  page: PointerPagePort & MediaPagePort & Partial<PageToolCommandPort>,
): page is PointerPagePort &
  MediaPagePort &
  Partial<PageToolCommandPort> &
  DanmakuControllerPagePort {
  const candidate = page as Partial<DanmakuControllerPagePort>;
  return (
    typeof candidate.setDanmakuStatus === "function" &&
    typeof candidate.renderDanmaku === "function" &&
    typeof candidate.clearDanmaku === "function"
  );
}

function isDrawingPagePort(
  page: PointerPagePort & MediaPagePort & Partial<PageToolCommandPort>,
): page is PointerPagePort &
  MediaPagePort &
  Partial<PageToolCommandPort> &
  DrawingControllerPagePort {
  const candidate = page as Partial<DrawingControllerPagePort>;
  return (
    typeof candidate.setDrawingViewer === "function" &&
    typeof candidate.renderAnnotationSnapshot === "function" &&
    typeof candidate.renderAnnotationCommitted === "function" &&
    typeof candidate.renderAnnotationAcknowledgement === "function" &&
    typeof candidate.renderLocalDraft === "function" &&
    typeof candidate.renderStrokePreview === "function" &&
    typeof candidate.clearStrokePreview === "function" &&
    typeof candidate.clearDrawing === "function" &&
    typeof candidate.resolveElementAnchorSignature === "function"
  );
}

export class ChromeExtensionRuntimeConfigStore implements ExtensionRuntimeConfigStore {
  readonly #area: { get(key: string): Promise<Record<string, unknown>> };
  readonly #key: string;

  public constructor(
    area: { get(key: string): Promise<Record<string, unknown>> },
    key = "syncaction.runtime.v1",
  ) {
    this.#area = area;
    this.#key = key;
  }

  public async read(): Promise<unknown | undefined> {
    return (await this.#area.get(this.#key))[this.#key];
  }
}
