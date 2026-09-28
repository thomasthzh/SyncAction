import {
  CanonicalUuidSchema,
  DeviceIdSchema,
  PointerAnchorSchema,
  PointerClearMessageSchema,
  PointerCoordinatesSchema,
  PointerDocumentRevisionSchema,
  PointerEventMessageSchema,
  PointerFrameEventSchema,
  PointerLeaseClearSchema,
  PointerLeaseEventSchema,
  PointerLeaseSnapshotSchema,
  PointerSnapshotMessageSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type PointerDocumentRevision,
  type PointerFrame,
  type PointerFrameEvent,
  type PointerLeaseRecord,
  type PointerRecord,
  type RoomId,
} from "@syncaction/protocol";
import type { DurableReplica } from "@syncaction/replica";
import { z } from "zod";
import {
  PageCapabilityReportSchema,
  type PageCapabilityReport,
} from "./page-collaboration/capability.js";
import type { PointerMessage, PointerTransport } from "./socket-transport.js";

const LocalTabIdSchema = z.number().int().nonnegative().safe();
const BrowserSessionIdSchema = z.string().uuid();

export const PointerLocalSampleSchema = z
  .object({
    type: z.literal("pointer.sample"),
    documentRevision: PointerDocumentRevisionSchema,
    anchor: PointerAnchorSchema.nullable(),
    viewport: PointerCoordinatesSchema,
    viewportDimensions: z
      .object({
        widthCssPx: z.number().finite().positive().max(10_240),
        heightCssPx: z.number().finite().positive().max(10_240),
      })
      .strict()
      .optional(),
    documentVisible: z.boolean().optional(),
  })
  .strict();

export type PointerLocalSample = z.infer<typeof PointerLocalSampleSchema>;

export const PointerPageContextSchema = z
  .object({
    roomId: RoomIdSchema,
    logicalTabId: LogicalTabIdSchema,
    documentRevision: PointerDocumentRevisionSchema,
  })
  .strict();

export type PointerPageContext = z.infer<typeof PointerPageContextSchema>;

export interface PointerIdentity {
  userId: string;
  deviceId: string;
}

export interface PointerPagePort {
  ensureInjected(tabId: number): Promise<boolean>;
  verifyInjected(tabId: number): Promise<boolean>;
  setContext(tabId: number, context: PointerPageContext): Promise<void>;
  render(tabId: number, pointer: PointerRecord): Promise<void>;
  renderLease?(tabId: number, lease: PointerLeaseRecord): Promise<void>;
  renderFrame?(tabId: number, frame: PointerFrameEvent): Promise<void>;
  clear(tabId: number, identity?: PointerIdentity): Promise<void>;
  dispose(tabId: number): Promise<void>;
}

export interface PointerControllerStatus {
  state: "OFFLINE" | "ONLINE" | "DEGRADED";
  lastAckExpiresAt: number | null;
  errorCode: string | null;
}

export interface PointerControllerOptions {
  roomId: unknown;
  browserSessionId: unknown;
  deviceId: unknown;
  replica: Pick<DurableReplica, "getRecord">;
  transport: PointerTransport;
  page: PointerPagePort;
  compatibility?: PointerCompatibilityPort;
  now?: () => number;
  scheduler?: PointerControllerScheduler;
  createLeaseId?: () => string;
}

export interface PointerCompatibilityPort {
  canRenderRemotePointer(input: {
    logicalTabId: string;
    documentRevision: PointerDocumentRevision;
    remoteUserId: string;
    remoteDeviceId: string;
  }): boolean;
  hasCompatibleRemotePointerObserver?(input: {
    logicalTabId: string;
    documentRevision: PointerDocumentRevision;
  }): boolean;
}

export interface PointerControllerScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

interface LatestSample {
  tabId: number;
  sample: PointerLocalSample;
}

interface PendingRemoteFrame {
  frame: PointerFrameEvent;
  generation: number;
  barrier: number;
}

const POINTER_FRAME_INTERVAL_MS = 40;
const POINTER_LEASE_RENEW_INTERVAL_MS = 2_000;
const POINTER_VIEWPORT_BUCKET_PX = 160;

export class PointerController {
  readonly #roomId: RoomId;
  readonly #browserSessionId: string;
  readonly #deviceId: ReturnType<typeof DeviceIdSchema.parse>;
  readonly #replica: Pick<DurableReplica, "getRecord">;
  readonly #transport: PointerTransport;
  readonly #page: PointerPagePort;
  readonly #compatibility: PointerCompatibilityPort | undefined;
  readonly #now: () => number;
  readonly #scheduler: PointerControllerScheduler;
  readonly #createLeaseId: () => string;
  readonly #managedTabs = new Set<number>();
  readonly #contexts = new Map<number, PointerPageContext>();
  readonly #remotePointers = new Map<string, PointerRecord>();
  readonly #remoteLeases = new Map<string, PointerLeaseRecord>();
  readonly #remoteFrameSequenceByLease = new Map<string, number>();
  readonly #pendingRemoteFrames = new Map<string, PendingRemoteFrame>();
  readonly #scheduledRemoteFrameBarriers = new Map<string, number>();
  readonly #pageCapabilityErrors = new Map<number, Map<"PAGE_HOST" | "POINTER", string>>();
  #synchronized = false;
  #activeTabId: number | undefined;
  #generation = 0;
  #pageTail: Promise<void> = Promise.resolve();
  #leaseTail: Promise<void> = Promise.resolve();
  #latestSample: LatestSample | undefined;
  #leaseId: string | null = null;
  #leaseContext: PointerPageContext | null = null;
  #leaseTabId: number | null = null;
  #nextFrameSeq = 1;
  #frameTimer: unknown;
  #leaseTimer: unknown;
  #pointerBarrier = 0;
  #pointerObserverStateKnown = false;
  #remoteObserverAvailable = true;
  #documentVisible = true;
  #pauseLeaseAfterRenewal = false;
  #lastAckExpiresAt: number | null = null;
  #errorCode: string | null = null;

  public constructor(options: PointerControllerOptions) {
    this.#roomId = RoomIdSchema.parse(options.roomId);
    this.#browserSessionId = BrowserSessionIdSchema.parse(options.browserSessionId);
    this.#deviceId = DeviceIdSchema.parse(options.deviceId);
    this.#replica = options.replica;
    this.#transport = options.transport;
    this.#page = options.page;
    this.#compatibility = options.compatibility;
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? browserPointerScheduler();
    this.#createLeaseId = options.createLeaseId ?? (() => crypto.randomUUID());
  }

  public setSynchronized(synchronized: boolean): Promise<void> {
    if (synchronized === this.#synchronized) {
      return this.whenIdle();
    }
    this.#synchronized = synchronized;
    this.#generation += 1;
    const generation = this.#generation;
    if (!synchronized) {
      this.#transport.setPointerHandler(undefined);
      this.#stopLocalPublisher();
      this.#remotePointers.clear();
      this.#remoteLeases.clear();
      this.#remoteFrameSequenceByLease.clear();
      this.#pendingRemoteFrames.clear();
      this.#scheduledRemoteFrameBarriers.clear();
      this.#pointerBarrier += 1;
      this.#pointerObserverStateKnown = false;
      this.#remoteObserverAvailable = true;
      this.#contexts.clear();
      this.#pageCapabilityErrors.clear();
      this.#lastAckExpiresAt = null;
      this.#errorCode = null;
      const managedTabs = [...this.#managedTabs];
      this.#managedTabs.clear();
      this.#enqueuePage(async () => {
        await Promise.all(managedTabs.map((tabId) => this.#page.dispose(tabId)));
      });
      return this.whenIdle();
    }
    this.#errorCode = null;
    this.#transport.setPointerHandler((message) => this.#handleRemote(message));
    if (this.#activeTabId !== undefined) {
      this.#enqueuePage(() => this.#refreshTab(this.#activeTabId!, generation));
    }
    return this.whenIdle();
  }

  public async handleActiveTabChanged(tabIdInput: unknown): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    if (this.#activeTabId !== tabId) {
      this.#stopLocalPublisher();
      this.#documentVisible = true;
    }
    this.#activeTabId = tabId;
    if (this.#synchronized) {
      const generation = this.#generation;
      this.#enqueuePage(() => this.#refreshTab(tabId, generation));
    }
    await this.whenIdle();
  }

  public async handleBindingsChanged(): Promise<void> {
    if (this.#synchronized) {
      const generation = this.#generation;
      this.#enqueuePage(() => this.#pruneManagedTabs(generation));
      if (this.#activeTabId !== undefined) {
        this.#enqueuePage(() => this.#refreshTab(this.#activeTabId!, generation));
      }
      this.#enqueuePage(() => this.#reconcileRemote(generation));
    }
    await this.whenIdle();
  }

  public async handlePageReady(tabIdInput: unknown): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    if (this.#synchronized) {
      const generation = this.#generation;
      this.#enqueuePage(() => this.#refreshTab(tabId, generation, true));
    }
    await this.whenIdle();
  }

  public async handleContentCompatibilityChanged(logicalTabIdInput: unknown): Promise<void> {
    const logicalTabId = LogicalTabIdSchema.parse(logicalTabIdInput);
    if (!this.#synchronized) {
      return;
    }
    const generation = this.#generation;
    this.#enqueuePage(async () => {
      this.#refreshRemoteObserverAvailability();
      await Promise.all([
        ...[...this.#remoteLeases.values()]
          .filter((lease) => lease.logicalTabId === logicalTabId)
          .map((lease) => this.#routeRemoteLease(lease, generation)),
        ...[...this.#remotePointers.values()]
          .filter((pointer) => pointer.logicalTabId === logicalTabId)
          .map((pointer) => this.#routeRemote(pointer, generation)),
      ]);
    });
    await this.whenIdle();
  }

  public async getContextForTab(tabIdInput: unknown): Promise<PointerPageContext | null> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    return this.#resolveContext(tabId);
  }

  public async handleLocalSample(tabIdInput: unknown, sampleInput: unknown): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const sample = PointerLocalSampleSchema.parse(sampleInput);
    const cachedContext = this.#contexts.get(tabId);
    if (
      !this.#synchronized ||
      this.#activeTabId !== tabId ||
      this.#leaseTabId !== tabId ||
      this.#leaseContext === null ||
      cachedContext === undefined ||
      !samePageContext(cachedContext, this.#leaseContext) ||
      !sameRevision(this.#leaseContext.documentRevision, sample.documentRevision)
    ) {
      return;
    }
    if (sample.documentVisible === false) {
      this.#documentVisible = false;
      this.#latestSample = undefined;
      this.#stopFrameTimer();
      return;
    }
    const becameVisible = !this.#documentVisible;
    this.#documentVisible = true;
    this.#latestSample = { tabId, sample };
    if (becameVisible && this.#hasRemoteObserver()) {
      this.#queueLeaseRenewal();
    }
  }

  #applyRemoteObserverAvailability(observedAfter: boolean): void {
    const observedBefore = this.#remoteObserverAvailable;
    this.#remoteObserverAvailable = observedAfter;
    if (observedAfter === observedBefore) {
      return;
    }
    if (!observedAfter) {
      this.#pauseLeaseAfterRenewal = true;
      if (this.#leaseId !== null && this.#lastAckExpiresAt !== null) {
        this.#ensureLeaseTimer();
      }
      return;
    }
    this.#pauseLeaseAfterRenewal = false;
    if (
      this.#documentVisible &&
      this.#synchronized &&
      this.#leaseTabId !== null &&
      this.#leaseContext !== null
    ) {
      this.#queueLeaseRenewal();
    }
  }

  #refreshRemoteObserverAvailability(): void {
    this.#applyRemoteObserverAvailability(this.#computeRemoteObserver());
  }

  public handlePageCapability(reportInput: PageCapabilityReport): void {
    const report = PageCapabilityReportSchema.parse(reportInput);
    const { tabId, frameId, message } = report;
    if (
      !this.#synchronized ||
      frameId !== 0 ||
      (message.capability !== "PAGE_HOST" && message.capability !== "POINTER") ||
      (this.#activeTabId !== tabId && !this.#managedTabs.has(tabId))
    ) {
      return;
    }
    const errors = this.#pageCapabilityErrors.get(tabId) ?? new Map();
    if (message.state === "AVAILABLE") {
      errors.delete(message.capability);
    } else {
      errors.set(message.capability, pointerCapabilityErrorCode(message.errorCode));
      if (message.errorCode === "ORIGIN_PERMISSION_REVOKED") {
        this.#managedTabs.delete(tabId);
        this.#contexts.delete(tabId);
        if (this.#activeTabId === tabId) {
          this.#stopLocalPublisher();
        }
      }
    }
    if (errors.size === 0) {
      this.#pageCapabilityErrors.delete(tabId);
    } else {
      this.#pageCapabilityErrors.set(tabId, errors);
    }
  }

  public getStatus(): PointerControllerStatus {
    const capabilityError =
      this.#activeTabId === undefined
        ? null
        : (this.#pageCapabilityErrors.get(this.#activeTabId)?.get("PAGE_HOST") ??
          this.#pageCapabilityErrors.get(this.#activeTabId)?.get("POINTER") ??
          null);
    const errorCode = capabilityError ?? this.#errorCode;
    return {
      state: !this.#synchronized ? "OFFLINE" : errorCode === null ? "ONLINE" : "DEGRADED",
      lastAckExpiresAt: this.#lastAckExpiresAt,
      errorCode,
    };
  }

  public async handlePermissionBoundaryChanged(): Promise<void> {
    if (!this.#synchronized) {
      return;
    }
    this.#generation += 1;
    const generation = this.#generation;
    this.#stopLocalPublisher();
    this.#managedTabs.clear();
    this.#contexts.clear();
    this.#pageCapabilityErrors.clear();
    this.#errorCode = null;
    if (this.#activeTabId !== undefined) {
      this.#enqueuePage(() => this.#refreshTab(this.#activeTabId!, generation));
    }
    await this.whenIdle();
  }

  public async dispose(): Promise<void> {
    if (this.#synchronized) {
      await this.setSynchronized(false);
    } else {
      this.#transport.setPointerHandler(undefined);
      const managedTabs = [...this.#managedTabs];
      this.#managedTabs.clear();
      this.#pageCapabilityErrors.clear();
      await Promise.all(managedTabs.map((tabId) => this.#page.dispose(tabId)));
    }
    await this.whenIdle();
  }

  public async whenIdle(): Promise<void> {
    let observedPage: Promise<void>;
    let observedLease: Promise<void>;
    do {
      observedPage = this.#pageTail;
      observedLease = this.#leaseTail;
      await Promise.all([observedPage, observedLease]);
    } while (observedPage !== this.#pageTail || observedLease !== this.#leaseTail);
  }

  async #resolveContext(tabId: number): Promise<PointerPageContext | null> {
    const record = await this.#replica.getRecord();
    const snapshot = record.confirmedSnapshot;
    if (record.mode !== "SYNCED" || snapshot === null || snapshot.roomId !== this.#roomId) {
      return null;
    }
    const binding = record.bindings.find(
      (candidate) =>
        candidate.browserSessionId === this.#browserSessionId && candidate.tabId === tabId,
    );
    if (binding === undefined || !snapshot.order.includes(binding.logicalTabId)) {
      return null;
    }
    const logicalTab = snapshot.tabs.find(
      (candidate) => candidate.id === binding.logicalTabId && candidate.closedAtSeq === null,
    );
    if (logicalTab === undefined) {
      return null;
    }
    return {
      roomId: this.#roomId,
      logicalTabId: binding.logicalTabId,
      documentRevision: {
        roomEpoch: snapshot.roomEpoch,
        tabUpdatedAtSeq: logicalTab.updatedAtSeq,
      },
    };
  }

  async #refreshTab(tabId: number, generation: number, alreadyInjected = false): Promise<void> {
    if (!this.#synchronized || generation !== this.#generation) {
      return;
    }
    try {
      const context = await this.#resolveContext(tabId);
      if (!this.#synchronized || generation !== this.#generation) {
        return;
      }
      if (context === null) {
        if (this.#activeTabId === tabId) {
          this.#stopLocalPublisher();
        }
        if (this.#managedTabs.delete(tabId)) {
          this.#contexts.delete(tabId);
          this.#pageCapabilityErrors.delete(tabId);
          await this.#page.dispose(tabId);
        }
        return;
      }
      const injected = alreadyInjected
        ? await this.#page.verifyInjected(tabId)
        : await this.#page.ensureInjected(tabId);
      if (!this.#synchronized || generation !== this.#generation) {
        return;
      }
      if (!injected) {
        this.#managedTabs.delete(tabId);
        this.#contexts.delete(tabId);
        try {
          await this.#page.dispose(tabId);
        } catch {
          // Permission removal may make the already-disposed page unreachable.
        }
        throw new Error("POINTER_PERMISSION_REQUIRED");
      }
      await this.#page.setContext(tabId, context);
      this.#managedTabs.add(tabId);
      this.#contexts.set(tabId, context);
      this.#errorCode = null;
      if (this.#activeTabId === tabId) {
        this.#activateLocalPublisher(tabId, context, generation);
      }
    } catch (cause) {
      if (this.#synchronized && generation === this.#generation) {
        if (this.#activeTabId === tabId) {
          this.#stopLocalPublisher();
        }
        this.#errorCode = pointerErrorCode(cause);
      }
    }
  }

  #activateLocalPublisher(tabId: number, context: PointerPageContext, generation: number): void {
    if (
      this.#leaseId !== null &&
      this.#leaseTabId === tabId &&
      this.#leaseContext !== null &&
      samePageContext(this.#leaseContext, context)
    ) {
      return;
    }
    this.#stopLocalPublisher();
    const leaseId = CanonicalUuidSchema.parse(this.#createLeaseId());
    this.#leaseId = leaseId;
    this.#leaseTabId = tabId;
    this.#leaseContext = structuredClone(context);
    this.#remoteObserverAvailable = this.#computeRemoteObserver();
    this.#nextFrameSeq = 1;
    this.#pauseLeaseAfterRenewal = !this.#hasRemoteObserver();
    const publish = this.#leaseTail.then(() =>
      this.#publishLease(tabId, context, leaseId, generation, false),
    );
    this.#leaseTail = publish.catch((cause) => {
      if (this.#synchronized && generation === this.#generation && this.#leaseId === leaseId) {
        this.#errorCode = pointerErrorCode(cause);
        this.#stopLocalPublisher();
      }
    });
  }

  async #publishLease(
    tabId: number,
    context: PointerPageContext,
    leaseId: string,
    generation: number,
    renewal: boolean,
  ): Promise<void> {
    if (
      !this.#synchronized ||
      generation !== this.#generation ||
      this.#leaseId !== leaseId ||
      this.#leaseTabId !== tabId ||
      this.#leaseContext === null ||
      !samePageContext(this.#leaseContext, context)
    ) {
      return;
    }
    if (!this.#hasRemoteObserver()) {
      this.#stopFrameTimer();
      this.#stopLeaseTimer();
      return;
    }
    const sample =
      this.#latestSample?.tabId === tabId &&
      sameRevision(this.#latestSample.sample.documentRevision, context.documentRevision)
        ? this.#latestSample.sample
        : undefined;
    const acknowledgement = await this.#transport.publishPointerLease({
      type: "pointer.lease",
      protocolVersion: 1,
      roomId: context.roomId,
      deviceId: this.#deviceId,
      leaseId,
      logicalTabId: context.logicalTabId,
      documentRevision: context.documentRevision,
      anchor: sample?.anchor ?? null,
    });
    if (!this.#synchronized || generation !== this.#generation || this.#leaseId !== leaseId) {
      return;
    }
    this.#lastAckExpiresAt = acknowledgement.expiresAt;
    this.#errorCode = null;
    if (this.#documentVisible && this.#hasRemoteObserver()) {
      this.#ensureFrameTimer();
    } else {
      this.#stopFrameTimer();
    }
    if (!this.#hasRemoteObserver() && renewal && this.#pauseLeaseAfterRenewal) {
      this.#stopLeaseTimer();
    } else {
      this.#ensureLeaseTimer();
    }
  }

  #queueLeaseRenewal(): void {
    const leaseId = this.#leaseId;
    const tabId = this.#leaseTabId;
    const context = this.#leaseContext;
    const generation = this.#generation;
    if (!this.#synchronized || leaseId === null || tabId === null || context === null) {
      return;
    }
    const publish = this.#leaseTail.then(() =>
      this.#publishLease(tabId, context, leaseId, generation, true),
    );
    this.#leaseTail = publish.catch((cause) => {
      if (this.#synchronized && generation === this.#generation && this.#leaseId === leaseId) {
        this.#errorCode = pointerErrorCode(cause);
      }
    });
  }

  #flushLatestFrame(): void {
    const latest = this.#latestSample;
    const leaseId = this.#leaseId;
    const context = this.#leaseContext;
    if (
      !this.#synchronized ||
      !this.#documentVisible ||
      !this.#hasRemoteObserver() ||
      latest === undefined ||
      leaseId === null ||
      context === null ||
      latest.tabId !== this.#leaseTabId ||
      latest.tabId !== this.#activeTabId ||
      !sameRevision(latest.sample.documentRevision, context.documentRevision)
    ) {
      return;
    }
    this.#latestSample = undefined;
    const dimensions = latest.sample.viewportDimensions;
    const frame: PointerFrame = {
      type: "pointer.frame",
      protocolVersion: 1,
      roomId: context.roomId,
      leaseId,
      seq: this.#nextFrameSeq,
      xQuantized: quantizeCoordinate(latest.sample.viewport.x),
      yQuantized: quantizeCoordinate(latest.sample.viewport.y),
      viewport: {
        widthBucket: viewportBucket(dimensions?.widthCssPx),
        heightBucket: viewportBucket(dimensions?.heightCssPx),
      },
      sentAtClientMs: Math.max(0, Math.floor(this.#now())),
    };
    try {
      this.#transport.publishPointerFrame(frame);
      this.#nextFrameSeq += 1;
      if (!Number.isSafeInteger(this.#nextFrameSeq)) {
        throw new Error("POINTER_SEQUENCE_EXHAUSTED");
      }
      this.#errorCode = null;
    } catch (cause) {
      this.#errorCode = pointerErrorCode(cause);
    }
  }

  #stopLocalPublisher(): void {
    this.#stopFrameTimer();
    this.#stopLeaseTimer();
    this.#latestSample = undefined;
    this.#leaseId = null;
    this.#leaseContext = null;
    this.#leaseTabId = null;
    this.#nextFrameSeq = 1;
    this.#lastAckExpiresAt = null;
    this.#pauseLeaseAfterRenewal = false;
  }

  #ensureFrameTimer(): void {
    if (this.#frameTimer === undefined) {
      this.#frameTimer = this.#scheduler.setInterval(
        () => this.#flushLatestFrame(),
        POINTER_FRAME_INTERVAL_MS,
      );
    }
  }

  #stopFrameTimer(): void {
    if (this.#frameTimer !== undefined) {
      this.#scheduler.clearInterval(this.#frameTimer);
      this.#frameTimer = undefined;
    }
  }

  #ensureLeaseTimer(): void {
    if (this.#leaseTimer === undefined) {
      this.#leaseTimer = this.#scheduler.setInterval(
        () => this.#queueLeaseRenewal(),
        POINTER_LEASE_RENEW_INTERVAL_MS,
      );
    }
  }

  #stopLeaseTimer(): void {
    if (this.#leaseTimer !== undefined) {
      this.#scheduler.clearInterval(this.#leaseTimer);
      this.#leaseTimer = undefined;
    }
  }

  #hasRemoteObserver(): boolean {
    return this.#remoteObserverAvailable;
  }

  #computeRemoteObserver(): boolean {
    if (this.#leaseContext === null) {
      return true;
    }
    if (this.#compatibility?.hasCompatibleRemotePointerObserver !== undefined) {
      return this.#compatibility.hasCompatibleRemotePointerObserver({
        logicalTabId: this.#leaseContext.logicalTabId,
        documentRevision: this.#leaseContext.documentRevision,
      });
    }
    if (!this.#pointerObserverStateKnown) {
      return true;
    }
    for (const lease of this.#remoteLeases.values()) {
      if (
        lease.logicalTabId === this.#leaseContext.logicalTabId &&
        sameRevision(lease.documentRevision, this.#leaseContext.documentRevision) &&
        lease.expiresAt > this.#now()
      ) {
        return true;
      }
    }
    return false;
  }

  #handleRemote(messageInput: PointerMessage): void {
    if (!this.#synchronized) {
      return;
    }
    const parsed = parsePointerMessage(messageInput);
    if (parsed === undefined || parsed.roomId !== this.#roomId) {
      return;
    }
    const generation = this.#generation;
    if (parsed.type === "pointer.frame") {
      this.#queueRemoteFrame(parsed, generation, this.#pointerBarrier);
      return;
    }
    this.#pointerBarrier += 1;
    const reliableBarrier = this.#pointerBarrier;
    this.#enqueuePage(async () => {
      if (!this.#synchronized || generation !== this.#generation) {
        return;
      }
      if (parsed.type === "pointer.lease.clear") {
        this.#pointerObserverStateKnown = true;
        const identity = {
          userId: parsed.userId,
          deviceId: parsed.deviceId,
        };
        const key = pointerKey(identity);
        const current = this.#remoteLeases.get(key);
        if (current?.leaseId !== parsed.leaseId) {
          return;
        }
        this.#remoteLeases.delete(key);
        this.#remoteFrameSequenceByLease.delete(parsed.leaseId);
        this.#pendingRemoteFrames.delete(parsed.leaseId);
        this.#refreshRemoteObserverAvailability();
        await this.#clearIdentity(identity);
        return;
      }
      if (parsed.type === "pointer.lease.snapshot") {
        this.#pointerObserverStateKnown = true;
        this.#remoteLeases.clear();
        this.#remoteFrameSequenceByLease.clear();
        for (const [leaseId, pending] of this.#pendingRemoteFrames) {
          if (pending.barrier < reliableBarrier) {
            this.#pendingRemoteFrames.delete(leaseId);
          }
        }
        for (const lease of parsed.leases) {
          if (this.#acceptRemoteLease(lease)) {
            this.#remoteLeases.set(pointerKey(lease), lease);
          }
        }
        this.#refreshRemoteObserverAvailability();
        await Promise.all([...this.#managedTabs].map((tabId) => this.#page.clear(tabId)));
        await this.#reconcileRemoteLeases(generation);
        return;
      }
      if (parsed.type === "pointer.lease.event") {
        this.#pointerObserverStateKnown = true;
        const lease = parsed.lease;
        const key = pointerKey(lease);
        const previous = this.#remoteLeases.get(key);
        if (!this.#acceptRemoteLease(lease)) {
          this.#remoteLeases.delete(key);
          if (previous !== undefined) {
            this.#remoteFrameSequenceByLease.delete(previous.leaseId);
            this.#pendingRemoteFrames.delete(previous.leaseId);
          }
          this.#refreshRemoteObserverAvailability();
          await this.#clearIdentity(lease);
          return;
        }
        if (previous?.leaseId !== lease.leaseId && previous !== undefined) {
          this.#remoteFrameSequenceByLease.delete(previous.leaseId);
          this.#pendingRemoteFrames.delete(previous.leaseId);
        }
        this.#remoteLeases.set(key, lease);
        this.#refreshRemoteObserverAvailability();
        await this.#routeRemoteLease(lease, generation);
        return;
      }
      if (parsed.type === "pointer.clear") {
        const identity = {
          userId: parsed.userId,
          deviceId: parsed.deviceId,
        };
        this.#remotePointers.delete(pointerKey(identity));
        await this.#clearIdentity(identity);
        return;
      }
      if (parsed.type === "pointer.snapshot") {
        this.#remotePointers.clear();
        for (const pointer of parsed.pointers) {
          if (this.#acceptRemote(pointer)) {
            this.#remotePointers.set(pointerKey(pointer), pointer);
          }
        }
        await Promise.all([...this.#managedTabs].map((tabId) => this.#page.clear(tabId)));
        await this.#reconcileRemote(generation);
        return;
      }
      const pointer = parsed.pointer;
      const identity = {
        userId: pointer.userId,
        deviceId: pointer.deviceId,
      };
      if (!this.#acceptRemote(pointer)) {
        this.#remotePointers.delete(pointerKey(identity));
        await this.#clearIdentity(identity);
        return;
      }
      this.#remotePointers.set(pointerKey(pointer), pointer);
      await this.#routeRemote(pointer, generation);
    });
  }

  #queueRemoteFrame(frame: PointerFrameEvent, generation: number, barrier: number): void {
    const acceptedSequence = this.#remoteFrameSequenceByLease.get(frame.leaseId);
    const pending = this.#pendingRemoteFrames.get(frame.leaseId);
    if (
      (acceptedSequence !== undefined && frame.seq <= acceptedSequence) ||
      (pending !== undefined && frame.seq <= pending.frame.seq)
    ) {
      return;
    }
    this.#pendingRemoteFrames.set(frame.leaseId, {
      frame,
      generation,
      barrier,
    });
    if (!this.#scheduledRemoteFrameBarriers.has(frame.leaseId)) {
      this.#scheduleRemoteFrameDrain(frame.leaseId, barrier);
    }
  }

  #scheduleRemoteFrameDrain(leaseId: string, barrier: number): void {
    this.#scheduledRemoteFrameBarriers.set(leaseId, barrier);
    this.#enqueuePage(async () => {
      try {
        const pending = this.#pendingRemoteFrames.get(leaseId);
        if (
          pending === undefined ||
          pending.barrier !== barrier ||
          !this.#synchronized ||
          pending.generation !== this.#generation
        ) {
          return;
        }
        this.#pendingRemoteFrames.delete(leaseId);
        const { frame } = pending;
        const lease = this.#remoteLeases.get(pointerKey(frame));
        if (
          lease === undefined ||
          lease.leaseId !== frame.leaseId ||
          !this.#acceptRemoteLease(lease)
        ) {
          return;
        }
        const latestSequence = this.#remoteFrameSequenceByLease.get(frame.leaseId);
        if (latestSequence !== undefined && frame.seq <= latestSequence) {
          return;
        }
        this.#remoteFrameSequenceByLease.set(frame.leaseId, frame.seq);
        await this.#routeRemoteFrame(lease, frame, pending.generation);
      } finally {
        if (this.#scheduledRemoteFrameBarriers.get(leaseId) === barrier) {
          this.#scheduledRemoteFrameBarriers.delete(leaseId);
        }
        const pending = this.#pendingRemoteFrames.get(leaseId);
        if (pending !== undefined && !this.#scheduledRemoteFrameBarriers.has(leaseId)) {
          this.#scheduleRemoteFrameDrain(leaseId, pending.barrier);
        }
      }
    });
  }

  #acceptRemote(pointer: PointerRecord): boolean {
    return pointer.deviceId !== this.#deviceId && pointer.expiresAt > this.#now();
  }

  #acceptRemoteLease(lease: PointerLeaseRecord): boolean {
    return lease.deviceId !== this.#deviceId && lease.expiresAt > this.#now();
  }

  async #reconcileRemoteLeases(generation: number): Promise<void> {
    let observerSetChanged = false;
    for (const [key, lease] of this.#remoteLeases) {
      if (!this.#acceptRemoteLease(lease)) {
        this.#remoteLeases.delete(key);
        this.#remoteFrameSequenceByLease.delete(lease.leaseId);
        this.#pendingRemoteFrames.delete(lease.leaseId);
        observerSetChanged = true;
        await this.#clearIdentity(lease);
        continue;
      }
      await this.#routeRemoteLease(lease, generation);
    }
    if (observerSetChanged) {
      this.#refreshRemoteObserverAvailability();
    }
  }

  async #reconcileRemote(generation: number): Promise<void> {
    for (const [key, pointer] of this.#remotePointers) {
      if (!this.#acceptRemote(pointer)) {
        this.#remotePointers.delete(key);
        await this.#clearIdentity(pointer);
        continue;
      }
      await this.#routeRemote(pointer, generation);
    }
  }

  async #pruneManagedTabs(generation: number): Promise<void> {
    for (const tabId of [...this.#managedTabs]) {
      if (!this.#synchronized || generation !== this.#generation) {
        return;
      }
      const context = await this.#resolveContext(tabId);
      if (!this.#synchronized || generation !== this.#generation) {
        return;
      }
      if (context === null) {
        this.#managedTabs.delete(tabId);
        this.#contexts.delete(tabId);
        this.#pageCapabilityErrors.delete(tabId);
        await this.#page.dispose(tabId);
        continue;
      }
      const previous = this.#contexts.get(tabId);
      if (previous !== undefined && !samePageContext(previous, context)) {
        await this.#page.setContext(tabId, context);
        this.#contexts.set(tabId, context);
      }
    }
  }

  async #routeRemoteLease(lease: PointerLeaseRecord, generation: number): Promise<void> {
    if (!this.#synchronized || generation !== this.#generation) {
      return;
    }
    if (!this.#canRenderRemote(lease)) {
      await this.#clearIdentity(lease);
      return;
    }
    const binding = await this.#bindingForLogicalTab(lease.logicalTabId);
    if (binding === null) {
      await this.#clearIdentity(lease);
      return;
    }
    const context = await this.#resolveContext(binding.tabId);
    if (context === null || !sameRevision(context.documentRevision, lease.documentRevision)) {
      await this.#clearIdentity(lease);
      return;
    }
    await this.#refreshTab(binding.tabId, generation);
    if (
      this.#synchronized &&
      generation === this.#generation &&
      this.#managedTabs.has(binding.tabId)
    ) {
      await this.#page.renderLease?.(binding.tabId, lease);
    }
  }

  async #routeRemoteFrame(
    lease: PointerLeaseRecord,
    frame: PointerFrameEvent,
    generation: number,
  ): Promise<void> {
    if (!this.#synchronized || generation !== this.#generation) {
      return;
    }
    if (!this.#canRenderRemote(lease)) {
      await this.#clearIdentity(lease);
      return;
    }
    const cachedBinding = [...this.#contexts.entries()].find(
      ([tabId, context]) =>
        this.#managedTabs.has(tabId) &&
        context.logicalTabId === lease.logicalTabId &&
        sameRevision(context.documentRevision, lease.documentRevision),
    );
    if (cachedBinding === undefined) {
      return;
    }
    const [tabId] = cachedBinding;
    if (this.#page.renderFrame !== undefined) {
      await this.#page.renderFrame(tabId, frame);
      return;
    }
    await this.#page.render(tabId, {
      userId: lease.userId,
      username: lease.username,
      displayName: lease.displayName,
      deviceId: lease.deviceId,
      color: lease.color,
      logicalTabId: lease.logicalTabId,
      documentRevision: lease.documentRevision,
      anchor: lease.anchor,
      viewport: {
        x: frame.xQuantized / 4_095,
        y: frame.yQuantized / 4_095,
      },
      expiresAt: lease.expiresAt,
    });
  }

  async #bindingForLogicalTab(logicalTabId: string): Promise<{ tabId: number } | null> {
    const record = await this.#replica.getRecord();
    const binding = record.bindings.find(
      (candidate) =>
        candidate.browserSessionId === this.#browserSessionId &&
        candidate.logicalTabId === logicalTabId,
    );
    return binding === undefined ? null : { tabId: binding.tabId };
  }

  async #routeRemote(pointer: PointerRecord, generation: number): Promise<void> {
    if (!this.#synchronized || generation !== this.#generation) {
      return;
    }
    if (!this.#canRenderRemote(pointer)) {
      await this.#clearIdentity(pointer);
      return;
    }
    const record = await this.#replica.getRecord();
    const binding = record.bindings.find(
      (candidate) =>
        candidate.browserSessionId === this.#browserSessionId &&
        candidate.logicalTabId === pointer.logicalTabId,
    );
    if (binding === undefined) {
      await this.#clearIdentity(pointer);
      return;
    }
    const context = await this.#resolveContext(binding.tabId);
    if (context === null || !sameRevision(context.documentRevision, pointer.documentRevision)) {
      await this.#clearIdentity(pointer);
      return;
    }
    await this.#refreshTab(binding.tabId, generation);
    if (
      this.#synchronized &&
      generation === this.#generation &&
      this.#managedTabs.has(binding.tabId)
    ) {
      await this.#page.render(binding.tabId, pointer);
    }
  }

  async #clearIdentity(identity: PointerIdentity): Promise<void> {
    await Promise.all(
      [...this.#managedTabs].map((tabId) =>
        this.#page.clear(tabId, {
          userId: identity.userId,
          deviceId: identity.deviceId,
        }),
      ),
    );
  }

  #canRenderRemote(
    pointer: Pick<
      PointerRecord | PointerLeaseRecord,
      "logicalTabId" | "documentRevision" | "userId" | "deviceId"
    >,
  ): boolean {
    return (
      this.#compatibility?.canRenderRemotePointer({
        logicalTabId: pointer.logicalTabId,
        documentRevision: pointer.documentRevision,
        remoteUserId: pointer.userId,
        remoteDeviceId: pointer.deviceId,
      }) ?? true
    );
  }

  #enqueuePage(work: () => Promise<void>): void {
    const result = this.#pageTail.then(work);
    this.#pageTail = result.catch((cause) => {
      if (this.#synchronized) {
        this.#errorCode = pointerErrorCode(cause);
      }
    });
  }
}

function parsePointerMessage(message: unknown): PointerMessage | undefined {
  const leaseEvent = PointerLeaseEventSchema.safeParse(message);
  if (leaseEvent.success) {
    return leaseEvent.data;
  }
  const leaseClear = PointerLeaseClearSchema.safeParse(message);
  if (leaseClear.success) {
    return leaseClear.data;
  }
  const leaseSnapshot = PointerLeaseSnapshotSchema.safeParse(message);
  if (leaseSnapshot.success) {
    return leaseSnapshot.data;
  }
  const frame = PointerFrameEventSchema.safeParse(message);
  if (frame.success) {
    return frame.data;
  }
  const event = PointerEventMessageSchema.safeParse(message);
  if (event.success) {
    return event.data;
  }
  const clear = PointerClearMessageSchema.safeParse(message);
  if (clear.success) {
    return clear.data;
  }
  const snapshot = PointerSnapshotMessageSchema.safeParse(message);
  return snapshot.success ? snapshot.data : undefined;
}

function sameRevision(left: PointerDocumentRevision, right: PointerDocumentRevision): boolean {
  return left.roomEpoch === right.roomEpoch && left.tabUpdatedAtSeq === right.tabUpdatedAtSeq;
}

function samePageContext(left: PointerPageContext, right: PointerPageContext): boolean {
  return (
    left.roomId === right.roomId &&
    left.logicalTabId === right.logicalTabId &&
    sameRevision(left.documentRevision, right.documentRevision)
  );
}

function pointerKey(identity: PointerIdentity): string {
  return `${identity.userId}:${identity.deviceId}`;
}

function pointerErrorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code;
  }
  return cause instanceof Error && cause.message.length > 0 ? cause.message : "POINTER_FAILURE";
}

function pointerCapabilityErrorCode(errorCode: string): string {
  return errorCode === "ORIGIN_PERMISSION_REQUIRED" || errorCode === "ORIGIN_PERMISSION_REVOKED"
    ? "POINTER_PERMISSION_REQUIRED"
    : errorCode;
}

function quantizeCoordinate(value: number): number {
  return Math.max(0, Math.min(4_095, Math.round(value * 4_095)));
}

function viewportBucket(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  return Math.max(1, Math.min(64, Math.ceil(value / POINTER_VIEWPORT_BUCKET_PX)));
}

function browserPointerScheduler(): PointerControllerScheduler {
  return {
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
}
