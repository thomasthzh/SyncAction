import {
  DanmakuAckSchema,
  DanmakuErrorCodeSchema,
  DanmakuEventMessageSchema,
  DanmakuSendSchema,
  CollaborationFrameKeySchema,
  RoomIdSchema,
  type DanmakuErrorCode,
  type DanmakuEventMessage,
  type RoomId,
} from "@syncaction/protocol";
import type { DurableReplica } from "@syncaction/replica";
import { z } from "zod";
import {
  CollaborationPageContextSchema,
  DanmakuReportMessageSchema,
  DanmakuSubmitMessageSchema,
  type CollaborationPageContext,
  type DanmakuReportMessage,
  type DanmakuSubmitMessage,
  PageCapabilityReportSchema,
  type PageCapabilityReport,
} from "./page-collaboration/messages.js";
import type { CollaborationTransport, DanmakuMessageHandler } from "./socket-transport.js";

const LocalTabIdSchema = z.number().int().nonnegative().safe();
const FrameIdSchema = z.number().int().nonnegative().safe();
const BrowserSessionIdSchema = z.string().uuid();

export interface DanmakuControllerPagePort {
  setDanmakuStatus(
    tabId: number,
    context: CollaborationPageContext,
    status: {
      status: "IDLE" | "SENDING" | "SENT" | "FAILED";
      messageId: string | null;
      errorCode: DanmakuErrorCode | null;
    },
  ): Promise<void>;
  renderDanmaku(
    tabId: number,
    context: CollaborationPageContext,
    event: DanmakuEventMessage,
  ): Promise<void>;
  clearDanmaku(tabId: number, context: CollaborationPageContext): Promise<void>;
}

export interface DanmakuControllerOptions {
  roomId: unknown;
  browserSessionId: unknown;
  replica: Pick<DurableReplica, "getRecord">;
  transport: Pick<CollaborationTransport, "setDanmakuHandler" | "sendDanmaku">;
  page: DanmakuControllerPagePort;
}

export interface DanmakuControllerStatus {
  state: "OFFLINE" | "ONLINE" | "DEGRADED";
  errorCode: string | null;
  lastMessageId: string | null;
  ready: boolean;
  canRetry: boolean;
  hidden: boolean;
  inputOpen: boolean;
}

interface DanmakuRoute {
  tabId: number;
  frameId: number;
  context: CollaborationPageContext;
  generation: number;
}

interface InFlightDanmaku {
  messageId: string;
  route: DanmakuRoute;
}

export class DanmakuController {
  readonly #roomId: RoomId;
  readonly #browserSessionId: string;
  readonly #replica: Pick<DurableReplica, "getRecord">;
  readonly #transport: Pick<CollaborationTransport, "setDanmakuHandler" | "sendDanmaku">;
  readonly #page: DanmakuControllerPagePort;
  #synchronized = false;
  #activeTabId: number | undefined;
  #route: DanmakuRoute | undefined;
  readonly #routes = new Map<number, DanmakuRoute>();
  readonly #knownFramesByTab = new Map<number, Map<number, string>>();
  readonly #rootGenerationByTab = new Map<number, number>();
  readonly #capabilityFailures = new Map<string, string>();
  readonly #unavailableFrames = new Map<string, string>();
  #permissionBlocked = false;
  #generation = 0;
  #disconnectEpoch = 0;
  #tail: Promise<void> = Promise.resolve();
  #errorCode: DanmakuControllerStatus["errorCode"] = null;
  #lastMessageId: string | null = null;
  #inFlight: InFlightDanmaku | undefined;
  #hidden = false;
  #inputOpen = false;

  public constructor(options: DanmakuControllerOptions) {
    this.#roomId = RoomIdSchema.parse(options.roomId);
    this.#browserSessionId = BrowserSessionIdSchema.parse(options.browserSessionId);
    this.#replica = options.replica;
    this.#transport = options.transport;
    this.#page = options.page;
  }

  public setSynchronized(synchronized: boolean): Promise<void> {
    if (synchronized === this.#synchronized) {
      return this.whenIdle();
    }
    this.#synchronized = synchronized;
    this.#generation += 1;
    const generation = this.#generation;
    if (!synchronized) {
      this.#disconnectEpoch += 1;
      this.#transport.setDanmakuHandler(undefined);
      const inFlight = this.#inFlight;
      this.#inFlight = undefined;
      const release =
        inFlight === undefined
          ? Promise.resolve()
          : (() => {
              this.#errorCode = "DANMAKU_OFFLINE";
              return this.#setStatus(inFlight.route, {
                status: "FAILED",
                messageId: inFlight.messageId,
                errorCode: "DANMAKU_OFFLINE",
              });
            })();
      return Promise.all([this.whenIdle(), release]).then(() => undefined);
    }
    if (!this.#permissionBlocked) {
      this.#errorCode = null;
    }
    const handler: DanmakuMessageHandler = (event) => {
      this.#enqueue(() => this.#handleRemote(event, generation));
    };
    this.#transport.setDanmakuHandler(handler);
    if (this.#activeTabId !== undefined && !this.#permissionBlocked) {
      this.#enqueue(() => this.#refreshRoute(this.#activeTabId!, generation));
    }
    return this.whenIdle();
  }

  public handleActiveTabChanged(tabIdInput: unknown): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    this.#activeTabId = tabId;
    if (this.#synchronized && !this.#permissionBlocked) {
      const generation = this.#generation;
      this.#enqueue(() => this.#refreshRoute(tabId, generation));
    } else if (this.#route !== undefined && this.#route.tabId !== tabId) {
      this.#enqueue(() => this.#clearRoute());
    }
    return this.whenIdle();
  }

  public handleBindingsChanged(): Promise<void> {
    if (this.#synchronized && this.#activeTabId !== undefined && !this.#permissionBlocked) {
      this.#generation += 1;
      const generation = this.#generation;
      this.#transport.setDanmakuHandler((event) => {
        this.#enqueue(() => this.#handleRemote(event, generation));
      });
      this.#enqueue(() => this.#refreshRoute(this.#activeTabId!, generation));
    }
    return this.whenIdle();
  }

  public handlePageReady(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
    rootGenerationInput?: unknown,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const frameKey = CollaborationFrameKeySchema.parse(frameKeyInput);
    const rootGeneration =
      rootGenerationInput === undefined
        ? (this.#rootGenerationByTab.get(tabId) ?? 1)
        : z.number().int().positive().safe().parse(rootGenerationInput);
    const existingFrames = this.#knownFramesByTab.get(tabId);
    const sameRoot = this.#rootGenerationByTab.get(tabId) === rootGeneration;
    const sameKnownFrame = sameRoot && existingFrames?.get(frameId) === frameKey;
    if (!sameRoot) {
      this.#clearTabUnavailableFrames(tabId);
    }
    this.#unavailableFrames.delete(pageFrameKey(tabId, frameId));
    const frames = sameRoot
      ? (existingFrames ?? new Map<number, string>())
      : new Map<number, string>();
    frames.set(frameId, frameKey);
    if (!sameKnownFrame) {
      this.#clearFrameCapabilityFailures(tabId, frameId);
    } else {
      this.#capabilityFailures.delete(pageCapabilityKey(tabId, frameId, "DANMAKU"));
    }
    this.#knownFramesByTab.set(tabId, frames);
    this.#rootGenerationByTab.set(tabId, rootGeneration);
    if (frameId === 0) {
      this.#permissionBlocked = false;
      if (this.#errorCode === "PAGE_TOOL_PERMISSION_REQUIRED") {
        this.#errorCode = null;
      }
    }
    if (this.#synchronized && this.#activeTabId === tabId && !this.#permissionBlocked) {
      const generation = this.#generation;
      this.#enqueue(() => this.#refreshRoute(tabId, generation));
    }
    return this.whenIdle();
  }

  public handleSubmit(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DanmakuSubmitMessage,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const message = DanmakuSubmitMessageSchema.parse(messageInput);
    const generation = this.#generation;
    const disconnectEpoch = this.#disconnectEpoch;
    const route = this.#routes.get(frameId);
    this.#enqueue(() => this.#submit(tabId, frameId, message, generation, disconnectEpoch, route));
    return this.whenIdle();
  }

  public handlePageReport(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: DanmakuReportMessage,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const message = DanmakuReportMessageSchema.parse(messageInput);
    const generation = this.#generation;
    this.#enqueue(async () => {
      const route = this.#routes.get(frameId);
      if (
        frameId === 0 &&
        route !== undefined &&
        route.tabId === tabId &&
        route.generation === generation &&
        this.#activeTabId === tabId &&
        sameContext(route.context, message.context)
      ) {
        this.#hidden = message.hidden;
        this.#inputOpen = message.inputOpen;
      }
    });
    return this.whenIdle();
  }

  public handlePageUnavailable(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const frameKey = CollaborationFrameKeySchema.parse(frameKeyInput);
    const frames = this.#knownFramesByTab.get(tabId);
    if (frames?.get(frameId) !== frameKey) {
      return this.whenIdle();
    }
    const routes =
      frameId === 0
        ? [...this.#routes.values()].filter((route) => route.tabId === tabId)
        : [this.#routes.get(frameId)].filter(
            (route): route is DanmakuRoute =>
              route !== undefined && route.tabId === tabId && route.context.frameKey === frameKey,
          );
    if (frameId === 0) {
      this.#knownFramesByTab.delete(tabId);
      this.#rootGenerationByTab.delete(tabId);
      this.#clearTabCapabilityFailures(tabId);
      this.#clearTabUnavailableFrames(tabId);
      this.#permissionBlocked = this.#activeTabId === tabId;
      this.#route = this.#route?.tabId === tabId ? undefined : this.#route;
    } else {
      this.#unavailableFrames.set(pageFrameKey(tabId, frameId), frameKey);
      frames.delete(frameId);
      this.#clearFrameCapabilityFailures(tabId, frameId);
      if (frames.size === 0) {
        this.#knownFramesByTab.delete(tabId);
      }
    }
    for (const route of routes) {
      this.#routes.delete(route.frameId);
    }
    this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
    this.#enqueue(async () => {
      await Promise.all(routes.map((route) => this.#clearOneRoute(route)));
    });
    return this.whenIdle();
  }

  public handlePermissionBoundaryChanged(): Promise<void> {
    this.#generation += 1;
    this.#permissionBlocked = true;
    this.#knownFramesByTab.clear();
    this.#rootGenerationByTab.clear();
    this.#capabilityFailures.clear();
    this.#unavailableFrames.clear();
    this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
    this.#enqueue(() => this.#clearRoute());
    return this.whenIdle();
  }

  public async dispose(): Promise<void> {
    if (this.#synchronized) {
      await this.setSynchronized(false);
    } else {
      this.#transport.setDanmakuHandler(undefined);
    }
    await this.#clearRoute();
    await this.whenIdle();
  }

  public getStatus(): DanmakuControllerStatus {
    const ready =
      this.#synchronized &&
      this.#route?.generation === this.#generation &&
      this.#retainedLocalRouteIsCurrent(this.#route) &&
      this.#capabilityErrorForRoute(this.#route) === null;
    const errorCode =
      this.#currentCapabilityError() ?? this.#currentUnavailableFrameError() ?? this.#errorCode;
    return {
      state: !this.#synchronized ? "OFFLINE" : ready && errorCode === null ? "ONLINE" : "DEGRADED",
      errorCode,
      lastMessageId: this.#lastMessageId,
      ready,
      canRetry: this.#routeCanRetry(this.#route),
      hidden: this.#hidden,
      inputOpen: this.#inputOpen,
    };
  }

  public isReadyFor(tabIdInput: unknown, contextInput: CollaborationPageContext): boolean {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const context = CollaborationPageContextSchema.parse(contextInput);
    const route = this.#route;
    return (
      this.getStatus().ready &&
      route !== undefined &&
      route.tabId === tabId &&
      route.context.frameKey === "top" &&
      sameContext(route.context, context)
    );
  }

  public canRetryFor(tabIdInput: unknown, contextInput: CollaborationPageContext): boolean {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const context = CollaborationPageContextSchema.parse(contextInput);
    const route = this.#route;
    return (
      this.#routeCanRetry(route) &&
      route !== undefined &&
      route.tabId === tabId &&
      sameContext(route.context, context)
    );
  }

  public handlePageCapability(reportInput: PageCapabilityReport): Promise<void> {
    const report = PageCapabilityReportSchema.parse(reportInput);
    if (report.message.capability !== "PAGE_HOST" && report.message.capability !== "DANMAKU") {
      return this.whenIdle();
    }
    const key = pageCapabilityKey(report.tabId, report.frameId, report.message.capability);
    if (report.message.state === "DEGRADED") {
      this.#capabilityFailures.set(key, report.message.errorCode);
    } else {
      this.#capabilityFailures.delete(key);
      if (this.#synchronized && this.#activeTabId === report.tabId && !this.#permissionBlocked) {
        const generation = this.#generation;
        this.#enqueue(() => this.#refreshRoute(report.tabId, generation));
      }
    }
    return this.whenIdle();
  }

  public async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.#tail;
      await observed;
    } while (observed !== this.#tail);
  }

  async #submit(
    tabId: number,
    frameId: number,
    message: DanmakuSubmitMessage,
    generation: number,
    disconnectEpoch: number,
    capturedRoute: DanmakuRoute | undefined,
  ): Promise<void> {
    const route = capturedRoute;
    if (
      generation !== this.#generation &&
      route !== undefined &&
      this.#retainedLocalRouteIsCurrent(route) &&
      route.tabId === tabId &&
      sameContext(route.context, message.context)
    ) {
      this.#lastMessageId = message.messageId;
      const failureCode =
        disconnectEpoch === this.#disconnectEpoch && this.#synchronized
          ? "DOCUMENT_UNAUTHORIZED"
          : "DANMAKU_OFFLINE";
      this.#errorCode = failureCode;
      await this.#setStatus(route, {
        status: "FAILED",
        messageId: message.messageId,
        errorCode: failureCode,
      });
      return;
    }
    if (
      this.#permissionBlocked ||
      generation !== this.#generation ||
      route === undefined ||
      route.tabId !== tabId ||
      this.#activeTabId !== tabId ||
      this.#capabilityErrorForRoute(route) !== null ||
      !sameContext(route.context, message.context)
    ) {
      if (route !== undefined && this.#capabilityErrorForRoute(route) !== null) {
        return;
      }
      if (this.#activeTabId === tabId && message.context.roomId === this.#roomId) {
        const failureRoute = { tabId, frameId, context: message.context, generation };
        this.#lastMessageId = message.messageId;
        const failureCode =
          disconnectEpoch === this.#disconnectEpoch && this.#synchronized
            ? "DOCUMENT_UNAUTHORIZED"
            : "DANMAKU_OFFLINE";
        if (!this.#permissionBlocked) {
          this.#errorCode = failureCode;
        }
        await this.#setStatus(failureRoute, {
          status: "FAILED",
          messageId: message.messageId,
          errorCode: failureCode,
        });
      }
      return;
    }
    this.#lastMessageId = message.messageId;
    if (!this.#synchronized) {
      this.#errorCode = "DANMAKU_OFFLINE";
      await this.#setStatus(route, {
        status: "FAILED",
        messageId: message.messageId,
        errorCode: "DANMAKU_OFFLINE",
      });
      return;
    }
    this.#errorCode = null;
    await this.#setStatus(route, {
      status: "SENDING",
      messageId: message.messageId,
      errorCode: null,
    });
    const inFlight: InFlightDanmaku = {
      messageId: message.messageId,
      route,
    };
    this.#inFlight = inFlight;
    try {
      const acknowledgement = DanmakuAckSchema.parse(
        await this.#transport.sendDanmaku(
          DanmakuSendSchema.parse({
            type: "danmaku.send",
            protocolVersion: 1,
            messageId: message.messageId,
            ...message.context,
            text: message.text,
          }),
        ),
      );
      if (
        acknowledgement.messageId !== message.messageId ||
        acknowledgement.roomId !== this.#roomId
      ) {
        throw new Error("DANMAKU_ACK_MISMATCH");
      }
      if (!this.#localRouteStillCurrent(route, generation)) {
        return;
      }
      if (acknowledgement.accepted) {
        await this.#setStatus(route, {
          status: "SENT",
          messageId: acknowledgement.messageId,
          errorCode: null,
        });
      } else {
        this.#errorCode = acknowledgement.code;
        await this.#setStatus(route, {
          status: "FAILED",
          messageId: acknowledgement.messageId,
          errorCode: acknowledgement.code,
        });
      }
    } catch (cause) {
      if (!this.#localRouteStillCurrent(route, generation)) {
        return;
      }
      const failureCode = danmakuFailureCode(cause);
      this.#errorCode = failureCode;
      await this.#setStatus(route, {
        status: "FAILED",
        messageId: message.messageId,
        errorCode: failureCode,
      });
    } finally {
      if (this.#inFlight === inFlight) {
        this.#inFlight = undefined;
      }
    }
  }

  async #handleRemote(eventInput: DanmakuEventMessage, generation: number): Promise<void> {
    const event = DanmakuEventMessageSchema.parse(eventInput);
    const route = this.#routeForContext(event);
    if (
      !this.#routeStillCurrent(route, generation) ||
      route === undefined ||
      !sameContext(route.context, event)
    ) {
      return;
    }
    try {
      await this.#page.renderDanmaku(route.tabId, route.context, event);
    } catch {
      this.#errorCode = "DANMAKU_PAGE_UNAVAILABLE";
    }
  }

  async #refreshRoute(tabId: number, generation: number): Promise<void> {
    if (
      !this.#synchronized ||
      this.#permissionBlocked ||
      generation !== this.#generation ||
      this.#activeTabId !== tabId
    ) {
      return;
    }
    if ([...this.#routes.values()].some((route) => route.generation !== generation)) {
      await this.#clearRoute();
      if (
        !this.#synchronized ||
        this.#permissionBlocked ||
        generation !== this.#generation ||
        this.#activeTabId !== tabId
      ) {
        return;
      }
    }
    const context = await this.#resolveContext(tabId);
    if (
      !this.#synchronized ||
      this.#permissionBlocked ||
      generation !== this.#generation ||
      this.#activeTabId !== tabId
    ) {
      return;
    }
    if (context === null) {
      await this.#clearRoute();
      if (this.#synchronized && !this.#permissionBlocked) {
        this.#errorCode = "DANMAKU_NOT_READY";
      }
      return;
    }
    const desiredFrames = new Map(this.#knownFramesByTab.get(tabId) ?? []);
    if (desiredFrames.get(0) !== "top") {
      await this.#clearRoute();
      this.#errorCode = "PAGE_TOOL_PERMISSION_REQUIRED";
      return;
    }
    const nextRoutes = new Map<number, DanmakuRoute>();
    for (const [frameId, frameKey] of desiredFrames) {
      const frameContext = CollaborationPageContextSchema.parse({
        ...context,
        frameKey,
      });
      const prior = this.#routes.get(frameId);
      nextRoutes.set(
        frameId,
        prior !== undefined &&
          prior.tabId === tabId &&
          prior.generation === generation &&
          sameContext(prior.context, frameContext)
          ? prior
          : {
              tabId,
              frameId,
              context: frameContext,
              generation,
            },
      );
    }
    for (const prior of this.#routes.values()) {
      if (nextRoutes.get(prior.frameId) !== prior) {
        await this.#clearOneRoute(prior);
      }
    }
    this.#routes.clear();
    for (const [frameId, route] of nextRoutes) {
      this.#routes.set(frameId, route);
    }
    this.#route = this.#routes.get(0);
    if (this.#errorCode === "DANMAKU_NOT_READY") {
      this.#errorCode = null;
    }
  }

  async #resolveContext(tabId: number): Promise<CollaborationPageContext | null> {
    const record = await this.#replica.getRecord();
    const snapshot = record.confirmedSnapshot;
    if (record.mode !== "SYNCED" || snapshot === null || snapshot.roomId !== this.#roomId) {
      return null;
    }
    const binding = record.bindings.find(
      (candidate) =>
        candidate.browserSessionId === this.#browserSessionId &&
        candidate.tabId === tabId &&
        candidate.validatedAtServerSeq === snapshot.serverSeq,
    );
    const tab = snapshot.tabs.find(
      (candidate) =>
        candidate.id === binding?.logicalTabId &&
        candidate.closedAtSeq === null &&
        snapshot.order.includes(candidate.id),
    );
    if (binding === undefined || tab === undefined) {
      return null;
    }
    return CollaborationPageContextSchema.parse({
      roomId: this.#roomId,
      logicalTabId: binding.logicalTabId,
      documentRevision: {
        roomEpoch: snapshot.roomEpoch,
        tabUpdatedAtSeq: tab.updatedAtSeq,
      },
      frameKey: "top",
    });
  }

  async #clearRoute(): Promise<void> {
    const routes = [...this.#routes.values()];
    this.#route = undefined;
    this.#routes.clear();
    this.#inputOpen = false;
    await Promise.all(routes.map((route) => this.#clearOneRoute(route)));
  }

  async #clearOneRoute(route: DanmakuRoute): Promise<void> {
    try {
      await this.#page.clearDanmaku(route.tabId, route.context);
    } catch {
      this.#errorCode = "DANMAKU_PAGE_UNAVAILABLE";
    }
  }

  async #setStatus(
    route: DanmakuRoute,
    status: {
      status: "IDLE" | "SENDING" | "SENT" | "FAILED";
      messageId: string | null;
      errorCode: DanmakuErrorCode | null;
    },
  ): Promise<void> {
    try {
      await this.#page.setDanmakuStatus(route.tabId, route.context, status);
    } catch {
      this.#errorCode = "DANMAKU_PAGE_UNAVAILABLE";
    }
  }

  #routeStillCurrent(route: DanmakuRoute | undefined, generation: number): boolean {
    return this.#synchronized && this.#localRouteStillCurrent(route, generation);
  }

  #localRouteStillCurrent(route: DanmakuRoute | undefined, generation: number): boolean {
    return (
      this.#retainedLocalRouteIsCurrent(route) &&
      route !== undefined &&
      generation === this.#generation &&
      route.generation === generation &&
      this.#routes.get(route.frameId) === route
    );
  }

  #retainedLocalRouteIsCurrent(route: DanmakuRoute | undefined): boolean {
    return (
      route !== undefined &&
      !this.#permissionBlocked &&
      this.#capabilityErrorForRoute(route) === null &&
      this.#routes.get(route.frameId) === route &&
      this.#activeTabId === route.tabId
    );
  }

  #routeCanRetry(route: DanmakuRoute | undefined): boolean {
    if (
      route === undefined ||
      !this.#synchronized ||
      this.#permissionBlocked ||
      route.frameId !== 0 ||
      route.context.frameKey !== "top" ||
      route.generation !== this.#generation ||
      this.#routes.get(route.frameId) !== route ||
      this.#activeTabId !== route.tabId
    ) {
      return false;
    }
    return (
      !this.#capabilityFailures.has(pageCapabilityKey(route.tabId, route.frameId, "PAGE_HOST")) &&
      this.#capabilityFailures.has(pageCapabilityKey(route.tabId, route.frameId, "DANMAKU"))
    );
  }

  #routeForContext(context: CollaborationPageContext): DanmakuRoute | undefined {
    return [...this.#routes.values()].find((route) => sameContext(route.context, context));
  }

  #capabilityErrorForRoute(route: DanmakuRoute | undefined): string | null {
    if (route === undefined) {
      return null;
    }
    return (
      this.#capabilityFailures.get(pageCapabilityKey(route.tabId, route.frameId, "PAGE_HOST")) ??
      this.#capabilityFailures.get(pageCapabilityKey(route.tabId, route.frameId, "DANMAKU")) ??
      null
    );
  }

  #currentCapabilityError(): string | null {
    for (const route of [...this.#routes.values()].sort(
      (left, right) => left.frameId - right.frameId,
    )) {
      const error = this.#capabilityErrorForRoute(route);
      if (error !== null) {
        return error;
      }
    }
    return null;
  }

  #clearFrameCapabilityFailures(tabId: number, frameId: number): void {
    this.#capabilityFailures.delete(pageCapabilityKey(tabId, frameId, "PAGE_HOST"));
    this.#capabilityFailures.delete(pageCapabilityKey(tabId, frameId, "DANMAKU"));
  }

  #clearTabCapabilityFailures(tabId: number): void {
    const prefix = `${String(tabId)}:`;
    for (const key of this.#capabilityFailures.keys()) {
      if (key.startsWith(prefix)) {
        this.#capabilityFailures.delete(key);
      }
    }
  }

  #currentUnavailableFrameError(): string | null {
    const tabId = this.#activeTabId;
    if (tabId === undefined) {
      return null;
    }
    const prefix = `${String(tabId)}:`;
    return [...this.#unavailableFrames.keys()].some((key) => key.startsWith(prefix))
      ? "PAGE_TOOL_PERMISSION_REQUIRED"
      : null;
  }

  #clearTabUnavailableFrames(tabId: number): void {
    const prefix = `${String(tabId)}:`;
    for (const key of this.#unavailableFrames.keys()) {
      if (key.startsWith(prefix)) {
        this.#unavailableFrames.delete(key);
      }
    }
  }

  #enqueue(work: () => Promise<void>): void {
    this.#tail = this.#tail.then(work, work).catch(() => {
      this.#errorCode = "DANMAKU_PAGE_UNAVAILABLE";
    });
  }
}

function pageCapabilityKey(
  tabId: number,
  frameId: number,
  capability: "PAGE_HOST" | "DANMAKU",
): string {
  return `${String(tabId)}:${String(frameId)}:${capability}`;
}

function pageFrameKey(tabId: number, frameId: number): string {
  return `${String(tabId)}:${String(frameId)}`;
}

function sameContext(left: CollaborationPageContext, right: CollaborationPageContext): boolean {
  return (
    left.roomId === right.roomId &&
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey
  );
}

function danmakuFailureCode(cause: unknown): DanmakuErrorCode {
  if (cause instanceof Error) {
    const transportCode = (cause as Error & { code?: unknown }).code;
    if (transportCode === "TRANSPORT_FAILURE") {
      return "DANMAKU_OFFLINE";
    }
    const errorCode = DanmakuErrorCodeSchema.safeParse(transportCode);
    if (errorCode.success) {
      return errorCode.data;
    }
  }
  return "INVALID_DANMAKU_MESSAGE";
}
