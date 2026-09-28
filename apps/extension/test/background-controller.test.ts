import {
  AnnotationSnapshotV2MessageSchema as AnnotationSnapshotMessageSchema,
  CommittedOperationSchema,
  MediaCommandAckSchema,
  MediaGroupsSnapshotMessageSchema,
  OperationAckSchema,
  PageCompatibilityReportSchema,
  PointerAckSchema,
  PointerLeaseAckSchema,
  PresenceAckSchema,
  PresenceSnapshotV2MessageSchema,
  RoomSnapshotMessageSchema,
  RoomSnapshotStateSchema,
  type ClientOperationEnvelope,
  type MediaCommand,
  type MediaCommandAck,
  type MediaGroupsSnapshotMessage,
  type MediaHeartbeat,
  type OperationAck,
  type PointerFrame,
  type PointerLeaseUpdate,
  type PointerUpdate,
  type PresenceSnapshotMessage,
  type PresenceUpdate,
  type PresenceUpdateV2,
} from "@syncaction/protocol";
import {
  DurableReplica,
  MemoryReplicaPersistence,
  ReplicaRepository,
  type ReplicaTransport,
  type ReplicaTransportHandlers,
} from "@syncaction/replica";
import {
  BrowserStateSchema,
  type BrowserGroup,
  type BrowserPort,
  type BrowserState,
  type BrowserTab,
} from "@syncaction/browser-sync";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundController,
  ExtensionRuntimeConfigSchema,
  type ExtensionRuntimeConfigStore,
} from "../src/background-controller.js";
import { AnnotationReplica, type AnnotationReplicaStorageArea } from "../src/annotation-replica.js";
import { DEFAULT_SERVER_PROFILE_ID } from "../src/server-profile.js";
import type { DanmakuControllerPagePort } from "../src/danmaku-controller.js";
import type { DrawingControllerPagePort } from "../src/drawing-controller.js";
import type { MediaPagePort } from "../src/media-controller.js";
import {
  DanmakuSubmitMessageSchema,
  DrawingDraftControlMessageSchema,
  DrawingSelectionMessageSchema,
  StrokeFinalMessageSchema,
  type CollaborationPageContext,
  type PageCapabilityMessage,
} from "../src/page-collaboration/messages.js";
import type { PageToolCommandPort } from "../src/page-collaboration/chrome-page-port.js";
import type { PointerPageContext, PointerPagePort } from "../src/pointer-controller.js";
import type {
  CollaborationTransport,
  MediaSnapshotHandler,
  PointerMessageHandler,
} from "../src/socket-transport.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";

const config = ExtensionRuntimeConfigSchema.parse({
  serverUrl: "https://syncaction.example.com",
  accessToken: "test-access-token",
  roomId,
  roomName: "产品研究",
  userId,
  deviceId,
});

const snapshot = RoomSnapshotStateSchema.parse({
  roomId,
  roomEpoch: 0,
  serverSeq: 1,
  order: [logicalTabId],
  tabs: [
    {
      id: logicalTabId,
      url: "https://example.com/",
      title: "设计规范",
      favIconUrl: null,
      createdAtSeq: 1,
      updatedAtSeq: 1,
      closedAtSeq: null,
    },
  ],
});

class StaticConfigStore implements ExtensionRuntimeConfigStore {
  public constructor(public value: unknown) {}
  public async read(): Promise<unknown> {
    return this.value;
  }
}

class FakeTransport implements ReplicaTransport {
  public connectCount = 0;
  public connectFailuresRemaining = 0;
  public disconnectCount = 0;
  public synchronizeCount = 0;
  public synchronizeFailuresRemaining = 0;
  public readonly submissions: ClientOperationEnvelope[] = [];
  public handlers: ReplicaTransportHandlers | undefined;
  public presenceHandler: ((snapshot: PresenceSnapshotMessage) => void) | undefined;
  public readonly presenceUpdates: Array<PresenceUpdate | PresenceUpdateV2> = [];
  public pointerHandler: PointerMessageHandler | undefined;
  public readonly pointerUpdates: PointerUpdate[] = [];
  public readonly pointerLeases: PointerLeaseUpdate[] = [];
  public readonly pointerFrames: PointerFrame[] = [];
  public mediaHandler: MediaSnapshotHandler | undefined;
  public readonly mediaCommands: MediaCommand[] = [];
  public readonly mediaHeartbeats: MediaHeartbeat[] = [];

  public async connect(handlers: ReplicaTransportHandlers): Promise<void> {
    this.connectCount += 1;
    if (this.connectFailuresRemaining > 0) {
      this.connectFailuresRemaining -= 1;
      throw new Error("TRANSPORT_FAILURE");
    }
    this.handlers = handlers;
  }

  public async synchronize() {
    this.synchronizeCount += 1;
    if (this.synchronizeFailuresRemaining > 0) {
      this.synchronizeFailuresRemaining -= 1;
      throw new Error("SYNC_FAILED");
    }
    return RoomSnapshotMessageSchema.parse({
      type: "room.snapshot",
      protocolVersion: 1,
      state: snapshot,
    });
  }

  public async submit(envelope: ClientOperationEnvelope): Promise<OperationAck> {
    this.submissions.push(envelope);
    return OperationAckSchema.parse({
      type: "op.ack",
      protocolVersion: 1,
      clientOpId: envelope.clientOpId,
      roomId: envelope.roomId,
      roomEpoch: envelope.roomEpoch,
      serverSeq: envelope.baseServerSeq + this.submissions.length,
    });
  }

  public async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.handlers = undefined;
  }

  public setPresenceHandler(
    handler: ((snapshot: PresenceSnapshotMessage) => void) | undefined,
  ): void {
    this.presenceHandler = handler;
  }

  public async publishPresence(update: PresenceUpdate | PresenceUpdateV2) {
    this.presenceUpdates.push(update);
    return PresenceAckSchema.parse({
      type: "presence.ack",
      protocolVersion: 1,
      roomId,
      expiresAt: Date.now() + 30_000,
    });
  }

  public setPointerHandler(handler: PointerMessageHandler | undefined): void {
    this.pointerHandler = handler;
  }

  public async publishPointer(update: PointerUpdate) {
    this.pointerUpdates.push(update);
    return PointerAckSchema.parse({
      type: "pointer.ack",
      protocolVersion: 1,
      roomId,
      accepted: true,
      expiresAt: Date.now() + 3_000,
    });
  }

  public async publishPointerLease(update: PointerLeaseUpdate) {
    this.pointerLeases.push(update);
    return PointerLeaseAckSchema.parse({
      type: "pointer.lease.ack",
      protocolVersion: 1,
      roomId,
      leaseId: update.leaseId,
      accepted: true,
      expiresAt: Date.now() + 3_000,
    });
  }

  public publishPointerFrame(frame: PointerFrame): void {
    this.pointerFrames.push(frame);
  }

  public setMediaHandler(handler: MediaSnapshotHandler | undefined): void {
    this.mediaHandler = handler;
  }

  public async sendMediaCommand(command: MediaCommand): Promise<MediaCommandAck> {
    this.mediaCommands.push(command);
    return MediaCommandAckSchema.parse({
      type: "media.command.ack",
      protocolVersion: 1,
      commandId: command.commandId,
      roomId,
      roomMediaRevision: 1,
      accepted: true,
      code: null,
      playbackGroupId:
        command.type === "group.create"
          ? "00000000-0000-4000-8000-000000000001"
          : command.playbackGroupId,
      groupRevision: command.type === "group.create" ? 1 : command.expectedGroupRevision + 1,
    });
  }

  public publishMediaHeartbeat(heartbeat: MediaHeartbeat): void {
    this.mediaHeartbeats.push(heartbeat);
  }

  public emitMedia(snapshot: MediaGroupsSnapshotMessage): void {
    this.mediaHandler?.(MediaGroupsSnapshotMessageSchema.parse(snapshot));
  }
}

class FakeCollaborationTransport extends FakeTransport implements CollaborationTransport {
  public setAnnotationHandler(
    handler: Parameters<CollaborationTransport["setAnnotationHandler"]>[0],
  ): void {
    void handler;
  }

  public setDanmakuHandler(
    handler: Parameters<CollaborationTransport["setDanmakuHandler"]>[0],
  ): void {
    void handler;
  }

  public setStrokePreviewHandler(
    handler: Parameters<CollaborationTransport["setStrokePreviewHandler"]>[0],
  ): void {
    void handler;
  }

  public synchronizeAnnotations(
    request: Parameters<CollaborationTransport["synchronizeAnnotations"]>[0],
  ): ReturnType<CollaborationTransport["synchronizeAnnotations"]> {
    return Promise.resolve(
      AnnotationSnapshotMessageSchema.parse({
        type: "annotation.snapshot.v2",
        protocolVersion: 1,
        roomId: request.roomId,
        logicalTabId: request.logicalTabId,
        documentRevision: request.documentRevision,
        frameKey: request.frameKey,
        pageKey: "A".repeat(43),
        annotationSeq: 0,
        strokes: [],
      }),
    );
  }

  public submitAnnotation(): ReturnType<CollaborationTransport["submitAnnotation"]> {
    return Promise.reject(new Error("UNEXPECTED_ANNOTATION_SUBMISSION"));
  }

  public sendDanmaku(): ReturnType<CollaborationTransport["sendDanmaku"]> {
    return Promise.reject(new Error("UNEXPECTED_DANMAKU_SUBMISSION"));
  }

  public async publishStrokePreview(): Promise<void> {}

  public async clearStrokePreview(): Promise<void> {}
}

class MemoryAnnotationArea implements AnnotationReplicaStorageArea {
  readonly #values = new Map<string, unknown>();

  public async get(key: string): Promise<Record<string, unknown>> {
    return this.#values.has(key) ? { [key]: structuredClone(this.#values.get(key)) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.#values.set(key, structuredClone(value));
    }
  }
}

class FakePointerPagePort
  implements
    PointerPagePort,
    MediaPagePort,
    PageToolCommandPort,
    DanmakuControllerPagePort,
    DrawingControllerPagePort
{
  public readonly injected: number[] = [];
  public readonly contexts: Array<{ tabId: number; context: PointerPageContext }> = [];
  public readonly disposed: number[] = [];
  public readonly mediaObservations: number[] = [];
  public readonly mediaLocks: boolean[] = [];
  public readonly danmakuToggles: Array<{ tabId: number; context: CollaborationPageContext }> = [];
  public readonly danmakuVisibility: Array<{
    tabId: number;
    context: CollaborationPageContext;
    hidden: boolean;
  }> = [];
  public readonly penToggles: Array<{ tabId: number; context: CollaborationPageContext }> = [];
  public disposeBarrier: Promise<void> | undefined;
  public onDispose: (() => void) | undefined;
  public degradeNextDrawingSnapshot = false;
  public onCapability:
    | ((report: { tabId: number; frameId: number; message: PageCapabilityMessage }) => void)
    | undefined;

  public async ensureInjected(tabId: number): Promise<boolean> {
    this.injected.push(tabId);
    return true;
  }

  public async verifyInjected(): Promise<boolean> {
    return true;
  }

  public async setContext(tabId: number, context: PointerPageContext): Promise<void> {
    this.contexts.push({ tabId, context });
  }

  public async render(): Promise<void> {}

  public async clear(): Promise<void> {}

  public async dispose(tabId: number): Promise<void> {
    this.disposed.push(tabId);
    this.onDispose?.();
    await this.disposeBarrier;
  }

  public async observe(tabId: number): Promise<void> {
    this.mediaObservations.push(tabId);
  }

  public async apply(): Promise<void> {}

  public async setFollowerLock(
    ...input: Parameters<MediaPagePort["setFollowerLock"]>
  ): Promise<void> {
    this.mediaLocks.push(input[4]);
  }

  public async toggleDanmakuInput(
    tabId: number,
    context: CollaborationPageContext,
  ): Promise<PageCapabilityMessage> {
    this.danmakuToggles.push({ tabId, context });
    return {
      type: "syncaction.page.capability",
      capability: "DANMAKU",
      state: "AVAILABLE",
      errorCode: null,
    };
  }

  public async togglePagePen(
    tabId: number,
    context: CollaborationPageContext,
  ): Promise<PageCapabilityMessage> {
    this.penToggles.push({ tabId, context });
    return {
      type: "syncaction.page.capability",
      capability: "DRAWING",
      state: "AVAILABLE",
      errorCode: null,
    };
  }

  public async setDanmakuHidden(
    tabId: number,
    context: CollaborationPageContext,
    hidden: boolean,
  ): Promise<PageCapabilityMessage> {
    this.danmakuVisibility.push({ tabId, context, hidden });
    return {
      type: "syncaction.page.capability",
      capability: "DANMAKU",
      state: "AVAILABLE",
      errorCode: null,
    };
  }

  public async setDanmakuStatus(): Promise<void> {}

  public async renderDanmaku(): Promise<void> {}

  public async clearDanmaku(): Promise<void> {}

  public async setDrawingViewer(): Promise<void> {}

  public async renderAnnotationSnapshot(
    ...input: Parameters<DrawingControllerPagePort["renderAnnotationSnapshot"]>
  ): Promise<void> {
    if (!this.degradeNextDrawingSnapshot) {
      return;
    }
    this.degradeNextDrawingSnapshot = false;
    this.onCapability?.({
      tabId: input[0],
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DRAWING",
        state: "DEGRADED",
        errorCode: "DRAWING_RUNTIME_LOAD_FAILED",
      },
    });
    throw Object.assign(new Error("DRAWING_RUNTIME_LOAD_FAILED"), {
      code: "PAGE_TOOL_REACHABLE_DEGRADED",
    });
  }

  public async renderAnnotationCommitted(): Promise<void> {}

  public async renderAnnotationAcknowledgement(): Promise<void> {}

  public async resolveElementAnchorSignature(): Promise<null> {
    return null;
  }

  public async renderLocalDraft(): Promise<void> {}

  public async renderStrokePreview(): Promise<void> {}

  public async clearStrokePreview(): Promise<void> {}

  public async clearDrawing(): Promise<void> {}
}

class MutableBrowserPort implements BrowserPort {
  public state: BrowserState = BrowserStateSchema.parse({
    browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
    windows: [{ windowId: 1, type: "normal", incognito: false }],
    groups: [],
    tabs: [],
  });
  public createCount = 0;
  public groupCount = 0;
  public ungroupCount = 0;

  public async readState(): Promise<BrowserState> {
    return BrowserStateSchema.parse(structuredClone(this.state));
  }

  public async createTab(input: {
    url: string;
    index: number;
    windowId: number | null;
  }): Promise<BrowserTab> {
    this.createCount += 1;
    const tab = {
      tabId: 20,
      windowId: input.windowId ?? 1,
      groupId: null,
      index: input.index,
      url: input.url,
      title: input.url,
      status: "complete" as const,
      pinned: false,
    };
    this.state.tabs.push(tab);
    this.state = BrowserStateSchema.parse(this.state);
    return tab;
  }

  public async groupTab(input: {
    tabId: number;
    groupId: number | null;
    title: string;
  }): Promise<{ tab: BrowserTab; group: BrowserGroup }> {
    this.groupCount += 1;
    const group = {
      groupId: input.groupId ?? 7,
      windowId: 1,
      title: input.title,
      color: "blue" as const,
      collapsed: false,
    };
    this.state.groups = [group];
    const tab = this.state.tabs.find((candidate) => candidate.tabId === input.tabId)!;
    tab.groupId = group.groupId;
    this.state = BrowserStateSchema.parse(this.state);
    return { tab, group };
  }

  public async ungroupTab(tabId: number): Promise<BrowserTab> {
    this.ungroupCount += 1;
    const tab = this.state.tabs.find((candidate) => candidate.tabId === tabId)!;
    tab.groupId = null;
    this.state = BrowserStateSchema.parse(this.state);
    return tab;
  }

  public async navigateTab(input: { tabId: number; url: string }): Promise<BrowserTab> {
    const tab = this.state.tabs.find((candidate) => candidate.tabId === input.tabId)!;
    tab.url = input.url;
    return tab;
  }

  public async moveTab(input: {
    tabId: number;
    windowId: number;
    index: number;
  }): Promise<BrowserTab> {
    const tab = this.state.tabs.find((candidate) => candidate.tabId === input.tabId)!;
    tab.windowId = input.windowId;
    tab.index = input.index;
    return tab;
  }

  public async closeTab(tabId: number): Promise<void> {
    this.state.tabs = this.state.tabs.filter((tab) => tab.tabId !== tabId);
  }
}

let persistence: MemoryReplicaPersistence;
let transport: FakeTransport;

beforeEach(() => {
  persistence = new MemoryReplicaPersistence();
  transport = new FakeTransport();
});

describe("BackgroundController", () => {
  it("retries an initial transport failure without enabling browser actuation", async () => {
    vi.useFakeTimers();
    try {
      transport.connectFailuresRemaining = 2;
      const browserPort = new MutableBrowserPort();
      const controller = new BackgroundController({
        persistence,
        configStore: new StaticConfigStore(config),
        transportFactory: () => transport,
        browserPort,
      });

      await controller.start();

      expect(transport.connectCount).toBe(1);
      expect(transport.synchronizeCount).toBe(0);
      expect((await controller.getStatus()).state).toBe("DISCONNECTED");
      expect(browserPort.createCount).toBe(0);

      await vi.advanceTimersByTimeAsync(500);
      expect(transport.connectCount).toBe(2);
      expect((await controller.getStatus()).state).toBe("DISCONNECTED");
      expect(browserPort.createCount).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      await controller.whenIdle();
      expect(transport.connectCount).toBe(3);
      expect(transport.synchronizeCount).toBe(1);
      expect((await controller.getStatus()).state).toBe("SYNCED");
      expect(browserPort.createCount).toBe(1);

      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending initial reconnect when the room runtime stops", async () => {
    vi.useFakeTimers();
    try {
      transport.connectFailuresRemaining = 10;
      const controller = new BackgroundController({
        persistence,
        configStore: new StaticConfigStore(config),
        transportFactory: () => transport,
      });

      await controller.start();
      expect(transport.connectCount).toBe(1);

      await controller.stop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(transport.connectCount).toBe(1);
      expect((await controller.getStatus()).state).toBe("DISCONNECTED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps repeated initial reconnect delays at thirty seconds", async () => {
    vi.useFakeTimers();
    try {
      transport.connectFailuresRemaining = 20;
      const controller = new BackgroundController({
        persistence,
        configStore: new StaticConfigStore(config),
        transportFactory: () => transport,
      });

      await controller.start();
      for (const delay of [500, 1_000, 2_000, 5_000, 10_000]) {
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(transport.connectCount).toBe(6);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(transport.connectCount).toBe(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.connectCount).toBe(7);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(transport.connectCount).toBe(8);

      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects again when snapshot recovery fails after a socket reconnect", async () => {
    vi.useFakeTimers();
    try {
      const controller = new BackgroundController({
        persistence,
        configStore: new StaticConfigStore(config),
        transportFactory: () => transport,
      });
      await controller.start();
      const connectedHandlers = transport.handlers;
      if (connectedHandlers === undefined) {
        throw new Error("expected connected replica handlers");
      }

      transport.synchronizeFailuresRemaining = 1;
      connectedHandlers.onDisconnect();
      connectedHandlers.onReconnect();
      await settleMicrotasks();

      expect((await controller.getStatus()).state).toBe("DISCONNECTED");
      expect(transport.connectCount).toBe(1);

      await vi.advanceTimersByTimeAsync(500);
      await controller.whenIdle();

      expect(transport.connectCount).toBe(2);
      expect(transport.synchronizeCount).toBe(3);
      expect((await controller.getStatus()).state).toBe("SYNCED");
      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays not configured without constructing a transport", async () => {
    let factoryCalls = 0;
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(undefined),
      transportFactory: () => {
        factoryCalls += 1;
        return transport;
      },
    });

    await controller.start();

    expect(factoryCalls).toBe(0);
    expect(await controller.getStatus()).toMatchObject({
      state: "NOT_CONFIGURED",
      roomName: null,
      serverSeq: null,
      outboxCount: 0,
    });
  });

  it("starts a configured replica, reports persisted status, and shuts down explicitly", async () => {
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
    });

    await controller.start();

    expect(transport.connectCount).toBe(1);
    expect(await controller.getStatus()).toMatchObject({
      state: "SYNCED",
      roomName: "产品研究",
      serverSeq: 1,
      sharedTabCount: 1,
      outboxCount: 0,
      tabs: [{ title: "设计规范", domain: "example.com" }],
    });
    await controller.stop();
    expect(transport.disconnectCount).toBe(1);
    expect((await controller.getStatus()).state).toBe("DISCONNECTED");
  });

  it("notifies the UI only after durable runtime state transitions", async () => {
    const onStatusChanged = vi.fn();
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
      onStatusChanged,
    });

    await controller.start();
    expect(onStatusChanged).toHaveBeenCalled();
    onStatusChanged.mockClear();

    transport.handlers?.onCommitted(
      CommittedOperationSchema.parse({
        type: "op.committed",
        protocolVersion: 1,
        clientOpId,
        roomId,
        roomEpoch: 0,
        deviceId,
        serverSeq: 2,
        operation: {
          type: "tab.navigate",
          logicalTabId,
          url: "https://example.com/next",
        },
      }),
    );
    await controller.whenIdle();
    await vi.waitFor(() => expect(onStatusChanged).toHaveBeenCalled());
    expect((await controller.getStatus()).serverSeq).toBe(2);

    onStatusChanged.mockClear();
    await controller.stop();
    expect(onStatusChanged).toHaveBeenCalledOnce();
    expect((await controller.getStatus()).state).toBe("DISCONNECTED");
  });

  it("replays a persisted outbox after constructing a fresh background controller", async () => {
    const repository = new ReplicaRepository({ persistence, now: () => 100 });
    await repository.update(roomId, (record) => ({
      ...record,
      mode: "SYNCED",
      confirmedSnapshot: snapshot,
    }));
    const replica = new DurableReplica({
      repository,
      roomId,
      deviceId,
      now: () => 100,
      createClientOpId: () => clientOpId,
    });
    const pending = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId,
      url: "https://example.com/replayed",
    });
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
    });

    await controller.start();

    expect(transport.submissions).toEqual([pending.envelope]);
    expect((await controller.getStatus()).outboxCount).toBe(0);
  });

  it("fails closed on invalid configuration", async () => {
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore({ ...config, serverUrl: "http://insecure.example" }),
      transportFactory: () => transport,
    });

    await controller.start();

    expect(transport.connectCount).toBe(0);
    expect(await controller.getStatus()).toMatchObject({
      state: "CONFIGURATION_ERROR",
    });
  });

  it("accepts the loopback HTTP origin used by local browser builds", async () => {
    const localConfig = {
      ...config,
      serverUrl: "http://127.0.0.1:29373/",
    };
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(localConfig),
      transportFactory: (parsed) => {
        expect(parsed.serverUrl).toBe("http://127.0.0.1:29373");
        return transport;
      },
    });

    await controller.start();

    expect(transport.connectCount).toBe(1);
    expect(await controller.getStatus()).toMatchObject({
      state: "SYNCED",
    });
  });

  it("surfaces a confirmed broadcast only after the replica persists it", async () => {
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
    });
    await controller.start();
    transport.handlers?.onCommitted(
      CommittedOperationSchema.parse({
        type: "op.committed",
        protocolVersion: 1,
        clientOpId,
        roomId,
        roomEpoch: 0,
        deviceId,
        serverSeq: 2,
        operation: {
          type: "tab.navigate",
          logicalTabId,
          url: "https://github.com/example/syncaction",
        },
      }),
    );
    await controller.whenIdle();

    expect(await controller.getStatus()).toMatchObject({
      serverSeq: 2,
      tabs: [
        {
          title: "设计规范",
          domain: "github.com",
        },
      ],
    });
  });

  it("wires a synced replica into the safe browser actuator and exposes browser status", async () => {
    const browserPort = new MutableBrowserPort();
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
      browserPort,
    });

    await controller.start();
    await controller.whenIdle();

    expect(browserPort.createCount).toBe(1);
    expect(browserPort.groupCount).toBe(1);
    expect(await controller.getStatus()).toMatchObject({
      state: "SYNCED",
      bindingCount: 1,
      browser: {
        state: "SYNCHRONIZED",
        effectsApplied: 1,
      },
    });
  });

  it("activates only an existing current-session logical-tab binding without creating a tab", async () => {
    const browserPort = new MutableBrowserPort();
    const activated: number[] = [];
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
      browserPort,
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
      mediaNavigationPort: {
        activateTab: async (tabId) => {
          activated.push(tabId);
        },
      },
    });
    await controller.start();
    await controller.whenIdle();
    expect(browserPort.createCount).toBe(1);

    await controller.activateLogicalTab(logicalTabId);

    expect(activated).toEqual([20]);
    expect(browserPort.createCount).toBe(1);
    await expect(
      controller.activateLogicalTab("018f8f8e-4b5c-7d6e-8f90-123456789fff"),
    ).rejects.toThrow("ROOM_TAB_NOT_AVAILABLE");
    expect(browserPort.createCount).toBe(1);
  });

  it("publishes an exact active-tab binding through the shared room transport", async () => {
    const browserPort = new MutableBrowserPort();
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
      browserPort,
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
      pagePort: new FakePointerPagePort(),
    });
    await controller.start();
    await controller.whenIdle();

    await controller.handleActiveTabChanged(20);

    await expect(controller.getPageContentCompatibility(20)).resolves.toBe("UNKNOWN");
    expect(transport.presenceUpdates.at(-1)).toMatchObject({
      roomId,
      logicalTabId,
    });
    expect(await controller.getStatus()).toMatchObject({
      presence: {
        state: "ONLINE",
        errorCode: null,
      },
    });

    await controller.handlePageCompatibilityReport(
      20,
      PageCompatibilityReportSchema.parse({
        type: "page.compatibility.report",
        protocolVersion: 1,
        logicalTabId,
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
    expect(transport.presenceUpdates.at(-1)).toMatchObject({
      type: "presence.update.v2",
      logicalTabId,
      contentContext: {
        canonicalPageIdentity: "url:https://example.com/",
      },
    });

    await controller.handlePagePermissionBoundaryChanged();
    expect(transport.presenceUpdates.at(-1)).toMatchObject({
      type: "presence.update",
      logicalTabId,
    });
    await controller.stop();
  });

  it("composes same-page pointers through the exact browser binding without another socket", async () => {
    const browserPort = new MutableBrowserPort();
    const pointerPagePort = new FakePointerPagePort();
    const onStatusChanged = vi.fn();
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
      browserPort,
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
      pagePort: pointerPagePort,
      onStatusChanged,
    });
    await controller.start();
    await controller.whenIdle();

    await controller.handleActiveTabChanged(20);
    await controller.handlePointerPageReady(20);
    await controller.handlePageCompatibilityReport(
      20,
      PageCompatibilityReportSchema.parse({
        type: "page.compatibility.report",
        protocolVersion: 1,
        logicalTabId,
        contentContext: {
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
          canonicalPageIdentity: "url:https://example.com/",
          contentSignature: { signatureVersion: 1, digest: "A".repeat(43) },
          media: null,
        },
      }),
    );
    transport.presenceHandler?.(
      PresenceSnapshotV2MessageSchema.parse({
        type: "presence.snapshot.v2",
        protocolVersion: 1,
        roomId,
        presenceSeq: 1,
        presences: [
          {
            userId: "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
            username: "remote",
            displayName: "Remote",
            deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789ac2",
            logicalTabId,
            contentContext: {
              documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
              canonicalPageIdentity: "url:https://example.com/",
              contentSignature: { signatureVersion: 1, digest: "A".repeat(43) },
              media: null,
            },
            expiresAt: Date.now() + 30_000,
          },
        ],
      }) as never,
    );
    await controller.whenIdle();
    onStatusChanged.mockClear();
    await controller.handlePointerLocalSample(20, {
      type: "pointer.sample",
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      anchor: {
        path: [{ tagName: "main", nthOfType: 1 }],
        x: 0.25,
        y: 0.75,
      },
      viewport: { x: 0.4, y: 0.6 },
    });

    expect(pointerPagePort.contexts.at(-1)).toMatchObject({
      tabId: 20,
      context: {
        roomId,
        logicalTabId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      },
    });
    await vi.waitFor(() => expect(transport.pointerFrames).toHaveLength(1));
    expect(transport.pointerLeases).toHaveLength(1);
    expect(transport.pointerUpdates).toHaveLength(0);
    expect(onStatusChanged).not.toHaveBeenCalled();
    expect(await controller.getStatus()).toMatchObject({
      pointer: {
        state: "ONLINE",
        errorCode: null,
      },
    });
    await controller.handlePageCapability({
      tabId: 20,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      },
    });
    expect(await controller.getStatus()).toMatchObject({
      pointer: {
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      },
    });
    const injectionCountBeforeBoundary = pointerPagePort.injected.length;
    await controller.handlePagePermissionBoundaryChanged();
    expect(pointerPagePort.injected).toHaveLength(injectionCountBeforeBoundary + 1);
    expect(await controller.getStatus()).toMatchObject({
      pointer: {
        state: "ONLINE",
        errorCode: null,
      },
    });

    await controller.stop();
    expect(transport.pointerHandler).toBeUndefined();
    expect(pointerPagePort.disposed).toContain(20);
  });

  it("does not enable acknowledged pointer fallback or positional tools without capabilities", async () => {
    const browserPort = new MutableBrowserPort();
    const pagePort = new FakePointerPagePort();
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
      browserPort,
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
      pagePort,
      enableVolatilePointer: false,
      enableContentCompatibility: false,
    });

    await controller.start();
    await controller.whenIdle();

    expect(transport.pointerHandler).toBeUndefined();
    expect(transport.mediaHandler).toBeUndefined();
    expect(await controller.getStatus()).toMatchObject({
      state: "SYNCED",
      presence: { state: "ONLINE" },
      pointer: null,
      media: null,
      danmaku: null,
      drawing: null,
    });
  });

  it("starts media only with authenticated identity, presence, one page port, and the synced socket", async () => {
    const browserPort = new MutableBrowserPort();
    const pagePort = new FakePointerPagePort();
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore({
        ...config,
        userId,
      }),
      transportFactory: () => transport,
      browserPort,
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
      pagePort,
    });

    await controller.start();
    await controller.handleActiveTabChanged(20);
    await controller.whenIdle();

    expect(transport.mediaHandler).toBeTypeOf("function");
    expect(pagePort.mediaObservations).toContain(20);
    expect(await controller.getStatus()).toMatchObject({
      state: "SYNCED",
      media: {
        state: "ONLINE",
        roomMediaRevision: null,
      },
    });

    await controller.stop();
    expect(transport.mediaHandler).toBeUndefined();
    expect(pagePort.mediaLocks.every((locked) => !locked)).toBe(true);
  });

  it("routes page tool commands only to the active synchronized browser binding", async () => {
    const browserPort = new MutableBrowserPort();
    const pagePort = new FakePointerPagePort();
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
      browserPort,
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
      pagePort,
    });
    await controller.start();
    await controller.whenIdle();
    await controller.handleActiveTabChanged(20);

    await controller.toggleDanmakuInput();
    await controller.setDanmakuHidden(true);
    await controller.togglePagePen();

    const expectedContext = {
      roomId,
      logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      frameKey: "top",
    };
    expect(pagePort.danmakuToggles).toEqual([{ tabId: 20, context: expectedContext }]);
    expect(pagePort.danmakuVisibility).toEqual([
      { tabId: 20, context: expectedContext, hidden: true },
    ]);
    expect(pagePort.penToggles).toEqual([{ tabId: 20, context: expectedContext }]);

    await controller.handleActiveTabChanged(99);
    await expect(controller.toggleDanmakuInput()).rejects.toThrow("PAGE_TOOL_UNAVAILABLE");
    expect(pagePort.danmakuToggles).toHaveLength(1);
    await controller.stop();
  });

  it("recovers a reachable degraded drawing runtime through the retry command response", async () => {
    const collaborationTransport = new FakeCollaborationTransport();
    const browserPort = new MutableBrowserPort();
    const pagePort = new FakePointerPagePort();
    const annotationReplica = new AnnotationReplica({
      area: new MemoryAnnotationArea(),
      profileId: DEFAULT_SERVER_PROFILE_ID,
      userId,
    });
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => collaborationTransport,
      browserPort,
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
      pagePort,
      annotationReplica,
    });
    pagePort.onCapability = (report) => {
      void controller.handlePageCapability(report);
    };

    await controller.start();
    await controller.whenIdle();
    await controller.handleActiveTabChanged(20);
    pagePort.degradeNextDrawingSnapshot = true;
    await controller.handlePageToolFrameReady(20, 0, "top", 1);
    await controller.whenIdle();

    expect((await controller.getStatus()).drawing).toMatchObject({
      state: "DEGRADED",
      errorCode: "DRAWING_RUNTIME_LOAD_FAILED",
      ready: false,
      canRetry: true,
    });

    await controller.togglePagePen();
    await controller.whenIdle();

    expect(pagePort.penToggles).toHaveLength(1);
    expect((await controller.getStatus()).drawing).toMatchObject({
      state: "ONLINE",
      errorCode: null,
      ready: true,
      canRetry: false,
    });
    await controller.stop();
  });

  it("fails side-panel media actions closed when the room has no media controller", async () => {
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
    });
    await controller.start();

    const playbackGroupId = "00000000-0000-4000-8000-000000000101";
    const proposalId = "00000000-0000-4000-8000-000000000201";
    const actions = [
      controller.jumpToMediaMember(userId),
      controller.alignMediaGroupOnce(playbackGroupId),
      controller.joinMediaGroup(playbackGroupId),
      controller.decideMediaProposal(playbackGroupId, proposalId, "REJECT"),
    ];

    for (const action of actions) {
      await expect(action).rejects.toMatchObject({
        code: "MEDIA_CONTROLLER_UNAVAILABLE",
      });
    }
    expect(transport.mediaCommands).toEqual([]);
    await controller.stop();
  });

  it("rejects page mutations when collaboration controllers were not constructed", async () => {
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
    });
    await controller.start();
    const pageContext = {
      roomId,
      logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      frameKey: "top" as const,
    };

    await expect(
      controller.handleDanmakuSubmit(
        20,
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
      controller.handleStrokeFinal(
        20,
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
      controller.handleDrawingSelection(
        20,
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
      controller.handleDrawingDraftControl(
        20,
        0,
        DrawingDraftControlMessageSchema.parse({
          type: "syncaction.annotation.draft.control",
          controller: "drawing",
          context: pageContext,
          action: "RETRY",
          strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789ac3",
        }),
      ),
    ).rejects.toThrow("DRAWING_CONTROLLER_UNAVAILABLE");

    await controller.stop();
  });

  it("stops the coordinator before a page-disposal barrier can admit a late reconnect", async () => {
    const browserPort = new MutableBrowserPort();
    const pagePort = new FakePointerPagePort();
    const disposeEntered = deferred<void>();
    const releaseDispose = deferred<void>();
    const controller = new BackgroundController({
      persistence,
      configStore: new StaticConfigStore(config),
      transportFactory: () => transport,
      browserPort,
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab5",
      pagePort,
    });
    await controller.start();
    await controller.handleActiveTabChanged(20);
    await controller.whenIdle();
    const connectedHandlers = transport.handlers;
    if (connectedHandlers === undefined) {
      throw new Error("expected connected replica handlers");
    }
    pagePort.disposeBarrier = releaseDispose.promise;
    pagePort.onDispose = () => disposeEntered.resolve();

    const stopping = controller.stop();
    await disposeEntered.promise;
    connectedHandlers.onDisconnect();
    connectedHandlers.onReconnect();
    await settleMicrotasks();

    expect(transport.synchronizeCount).toBe(1);

    releaseDispose.resolve();
    await stopping;
    expect(transport.disconnectCount).toBe(1);
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
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}
