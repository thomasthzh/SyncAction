import type { MediaObservedState, MediaTarget } from "@syncaction/protocol";
import { discoverMediaAdapter } from "../media-adapters/registry.js";
import type {
  MediaAdapter,
  MediaApplyAction,
  MediaApplyResult,
  MediaDiscoveryResultCode,
  MediaDiscreteEvent,
} from "../media-adapters/types.js";
import {
  MediaCommandMessageSchema,
  MediaObservedMessageSchema,
  PageCapabilityMessageSchema,
  type MediaCommandMessage,
  type MediaObservedMessage,
  type MediaPageApplyAction,
  type MediaPageContext,
  type PageCapabilityMessage,
} from "./messages.js";

const REDISCOVERY_BASE_DELAY_MS = 50;
const REDISCOVERY_MIN_INTERVAL_MS = 200;
const REDISCOVERY_MAX_BACKOFF_MS = 800;
const REDISCOVERY_BACKOFF_RESET_MS = 1_000;
const URL_CHECK_INTERVAL_MS = 250;
const APPLY_EVENT_CORRELATION_MS = 1_000;
const MAX_APPLY_CORRELATIONS = 32;
const FOLLOWER_INTERCEPTOR_ATTRIBUTE = "data-syncaction-follower-interceptor";
const FOLLOWER_POINTER_EVENTS = ["pointerdown", "mousedown", "click", "dblclick"] as const;
const FOLLOWER_CONTROL_STRIP_MIN_PX = 48;
const FOLLOWER_CONTROL_STRIP_MAX_PX = 72;
const FOLLOWER_CONTROL_STRIP_RATIO = 0.18;

type ApplyOperation = Extract<MediaCommandMessage["operation"], { type: "APPLY" }>;
interface ApplyCorrelation {
  adapter: MediaAdapter;
  applyToken: string;
  eventType: MediaDiscreteEvent["type"];
  timer: number | undefined;
}

interface TemporaryRateRestore {
  adapter: MediaAdapter;
  restoreRate: number;
  timer: number;
}

export interface MediaPageRuntimeOptions {
  document: Document;
  window: Window;
  surface: HTMLElement;
  emitObserved(message: MediaObservedMessage): void;
  emitCapability?: (message: PageCapabilityMessage) => void;
  readPageUrl?: () => string;
  now?: () => number;
}

export class MediaPageRuntime {
  readonly #document: Document;
  readonly #window: Window;
  readonly #surface: HTMLElement;
  readonly #emitObservedMessage: (message: MediaObservedMessage) => void;
  readonly #emitCapabilityMessage: ((message: PageCapabilityMessage) => void) | undefined;
  readonly #readPageUrl: () => string;
  readonly #now: () => number;
  readonly #onNavigation = (): void => {
    this.#checkPageUrl();
  };
  readonly #onVisibilityChanged = (): void => {
    this.#emitVisibilityChanged();
  };
  readonly #onMetadataWake = (event: Event): void => {
    if (this.#adapter === undefined && isMediaMetadataEventTarget(event.target)) {
      this.#scheduleRediscovery();
    }
  };
  readonly #onFollowerPointerGesture = (event: Event): void => {
    if (!this.#canInterceptFollowerGesture()) {
      this.#syncFollowerInterceptor();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "pointerdown" || event.type === "click") {
      this.#followerInterceptor?.focus({ preventScroll: true });
    }
    if (event.type === "click") {
      this.#emitFollowerToggleIntent();
    }
  };
  readonly #onFollowerKeyDown = (event: KeyboardEvent): void => {
    if (
      !isFollowerPlaybackKey(event.key) ||
      isEditableEventTarget(event.target) ||
      !this.#isFollowerMediaFocused() ||
      !this.#canInterceptFollowerGesture()
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) {
      this.#emitFollowerToggleIntent();
    }
  };
  readonly #onFollowerLayoutChanged = (): void => {
    this.#syncFollowerInterceptor();
  };

  #adapter: MediaAdapter | undefined;
  #unsubscribe: (() => void) | undefined;
  #context: MediaPageContext | null = null;
  #requestedTarget: MediaTarget | null = null;
  #observer: MutationObserver | undefined;
  #rediscoveryTimer: number | undefined;
  #urlCheckTimer: number | undefined;
  #applyCorrelations: ApplyCorrelation[] = [];
  #lastPageUrl = "";
  #lastRediscoveryAt = Number.NEGATIVE_INFINITY;
  #lastRediscoveryTriggerAt = Number.NEGATIVE_INFINITY;
  #rediscoveryBackoffMs = REDISCOVERY_BASE_DELAY_MS;
  #discoveryCode: MediaDiscoveryResultCode | null = null;
  #lastCapability: string | null = null;
  #monitoring = false;
  #metadataWakeListening = false;
  #followerLocked = false;
  #followerLockTarget: MediaTarget | null = null;
  #followerInterceptor: HTMLElement | undefined;
  #temporaryRateRestore: TemporaryRateRestore | null = null;
  #disposed = false;

  public constructor(options: MediaPageRuntimeOptions) {
    this.#document = options.document;
    this.#window = options.window;
    this.#surface = options.surface;
    this.#emitObservedMessage = options.emitObserved;
    this.#emitCapabilityMessage = options.emitCapability;
    this.#readPageUrl = options.readPageUrl ?? (() => this.#window.location.href);
    this.#now = options.now ?? Date.now;
  }

  public handle(messageInput: unknown): void | Promise<void> {
    if (this.#disposed) {
      return;
    }
    const parsed = MediaCommandMessageSchema.safeParse(messageInput);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.operation.type === "OBSERVE") {
      this.#observe(message.context, message.operation.target);
      return;
    }
    if (message.operation.type === "SET_FOLLOWER_LOCK") {
      if (this.#context !== null && sameContext(this.#context, message.context)) {
        this.#setFollowerLock(message.operation.locked, message.operation.target);
      }
      return;
    }
    return this.#apply(message.context, message.operation);
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#observer?.disconnect();
    this.#observer = undefined;
    if (this.#rediscoveryTimer !== undefined) {
      this.#window.clearTimeout(this.#rediscoveryTimer);
      this.#rediscoveryTimer = undefined;
    }
    if (this.#urlCheckTimer !== undefined) {
      this.#window.clearInterval(this.#urlCheckTimer);
      this.#urlCheckTimer = undefined;
    }
    this.#clearApplyCorrelations();
    this.#stopMetadataWakeListening();
    this.#window.removeEventListener("popstate", this.#onNavigation);
    this.#window.removeEventListener("hashchange", this.#onNavigation);
    this.#document.removeEventListener("visibilitychange", this.#onVisibilityChanged);
    this.#stopAdapter();
    this.#context = null;
    this.#requestedTarget = null;
    this.#setFollowerLock(false);
    this.#surface.dataset.active = "false";
  }

  #observe(context: MediaPageContext, target?: MediaTarget): void {
    if (this.#context !== null && !sameContext(this.#context, context)) {
      this.#setFollowerLock(false);
      this.#resetDiscoveryState();
    }
    const switchesExistingTarget =
      target !== undefined &&
      this.#adapter !== undefined &&
      !sameTarget(this.#adapter.target, target);
    this.#context = cloneContext(context);
    this.#requestedTarget = target === undefined ? null : structuredClone(target);
    this.#surface.dataset.active = "true";
    this.#lastPageUrl = this.#safePageUrl();
    this.#startMonitoring();
    this.#rediscover(!switchesExistingTarget);
    if (this.#document.visibilityState === "hidden") {
      this.#emitVisibilityChanged();
    }
  }

  #setFollowerLock(locked: boolean, target: MediaTarget | null = null): void {
    if (locked && target === null) {
      return;
    }
    if (
      !locked &&
      target !== null &&
      this.#followerLockTarget !== null &&
      !sameTarget(this.#followerLockTarget, target)
    ) {
      return;
    }
    if (!locked) {
      this.#clearTemporaryRateRestore(target, true);
    }
    if (locked === this.#followerLocked) {
      if (
        locked &&
        target !== null &&
        this.#followerLockTarget !== null &&
        !sameTarget(this.#followerLockTarget, target)
      ) {
        this.#followerLockTarget = structuredClone(target);
      }
      this.#surface.dataset.followerLock = locked ? "true" : "false";
      this.#syncFollowerInterceptor();
      return;
    }
    this.#followerLocked = locked;
    this.#followerLockTarget = locked && target !== null ? structuredClone(target) : null;
    this.#surface.dataset.followerLock = locked ? "true" : "false";
    if (locked) {
      this.#document.addEventListener("keydown", this.#onFollowerKeyDown, true);
      this.#window.addEventListener("resize", this.#onFollowerLayoutChanged);
      this.#window.addEventListener("scroll", this.#onFollowerLayoutChanged, true);
    } else {
      this.#document.removeEventListener("keydown", this.#onFollowerKeyDown, true);
      this.#window.removeEventListener("resize", this.#onFollowerLayoutChanged);
      this.#window.removeEventListener("scroll", this.#onFollowerLayoutChanged, true);
    }
    this.#syncFollowerInterceptor();
  }

  #canInterceptFollowerGesture(): boolean {
    return (
      this.#followerLocked &&
      this.#adapter !== undefined &&
      this.#followerLockTarget !== null &&
      sameTarget(this.#adapter.target, this.#followerLockTarget) &&
      isAdapterUsable(this.#adapter)
    );
  }

  #isFollowerMediaFocused(): boolean {
    const root = this.#surface.getRootNode();
    const activeElement =
      root instanceof ShadowRoot ? root.activeElement : this.#document.activeElement;
    if (activeElement === this.#followerInterceptor) {
      return true;
    }
    try {
      return activeElement === this.#adapter?.getMediaElement();
    } catch {
      return false;
    }
  }

  #syncFollowerInterceptor(): void {
    const adapter = this.#adapter;
    if (
      this.#followerLocked &&
      adapter !== undefined &&
      this.#followerLockTarget !== null &&
      !sameTarget(adapter.target, this.#followerLockTarget)
    ) {
      this.#setFollowerLock(false);
      return;
    }
    if (
      !this.#followerLocked ||
      adapter === undefined ||
      this.#followerLockTarget === null ||
      !isAdapterUsable(adapter)
    ) {
      this.#removeFollowerInterceptor();
      return;
    }
    let media: HTMLMediaElement;
    let bounds: DOMRect;
    try {
      media = adapter.getMediaElement();
      bounds = media.getBoundingClientRect();
    } catch {
      this.#removeFollowerInterceptor();
      return;
    }
    if (
      !media.isConnected ||
      !Number.isFinite(bounds.left) ||
      !Number.isFinite(bounds.top) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      this.#removeFollowerInterceptor();
      return;
    }
    let interceptor = this.#followerInterceptor;
    if (interceptor === undefined) {
      interceptor = this.#document.createElement("div");
      interceptor.setAttribute(FOLLOWER_INTERCEPTOR_ATTRIBUTE, "");
      interceptor.setAttribute("aria-hidden", "true");
      interceptor.tabIndex = -1;
      interceptor.style.cssText =
        "all:initial;position:fixed;display:block;pointer-events:auto;touch-action:none;background:transparent;cursor:not-allowed;";
      for (const eventType of FOLLOWER_POINTER_EVENTS) {
        interceptor.addEventListener(eventType, this.#onFollowerPointerGesture, true);
      }
      this.#surface.append(interceptor);
      this.#followerInterceptor = interceptor;
    }
    interceptor.style.left = `${String(bounds.left)}px`;
    interceptor.style.top = `${String(bounds.top)}px`;
    interceptor.style.width = `${String(bounds.width)}px`;
    interceptor.style.height = `${String(followerPlaybackSurfaceHeight(bounds.height))}px`;
  }

  #removeFollowerInterceptor(): void {
    const interceptor = this.#followerInterceptor;
    if (interceptor === undefined) {
      return;
    }
    for (const eventType of FOLLOWER_POINTER_EVENTS) {
      interceptor.removeEventListener(eventType, this.#onFollowerPointerGesture, true);
    }
    interceptor.remove();
    this.#followerInterceptor = undefined;
  }

  #emitFollowerToggleIntent(): void {
    const context = this.#context;
    const adapter = this.#adapter;
    if (context === null || adapter === undefined || !isAdapterUsable(adapter)) {
      return;
    }
    let observed: MediaObservedState;
    try {
      observed = adapter.read();
    } catch {
      return;
    }
    const wantsPlayback = observed.paused || observed.ended;
    this.#emit({
      type: "syncaction.media.observed",
      event: "STATE_CHANGED",
      context: cloneContext(context),
      target: adapter.target,
      observed: {
        ...observed,
        observedAtClientMs: this.#now(),
        paused: !wantsPlayback,
        ended: wantsPlayback ? false : observed.ended,
      },
      applyToken: null,
      trigger: wantsPlayback ? "PLAYED" : "PAUSED",
      resultCode: null,
    });
  }

  async #apply(context: MediaPageContext, operation: ApplyOperation): Promise<void> {
    if (this.#context === null || !sameContext(this.#context, context)) {
      this.#emitMismatch(context, operation.applyToken, false);
      return;
    }

    let adapter = this.#adapter;
    if (
      adapter === undefined ||
      !sameTarget(adapter.target, operation.target) ||
      !isAdapterUsable(adapter)
    ) {
      this.#rediscover(false);
      adapter = this.#adapter;
      if (
        adapter === undefined ||
        !sameTarget(adapter.target, operation.target) ||
        !isAdapterUsable(adapter)
      ) {
        this.#emitMismatch(context, operation.applyToken, true);
        return;
      }
    }

    const correlation = this.#beginApplyCorrelation(adapter, operation);
    if (correlation === undefined) {
      this.#emitUnexpectedApplyFailure(context, operation.applyToken);
      return;
    }
    if (operation.action.type === "SET_RATE_TEMPORARY") {
      this.#clearTemporaryRateRestore(operation.target, true);
    }
    let result: MediaApplyResult;
    try {
      result = await adapter.apply({
        applyToken: operation.applyToken,
        action: toAdapterAction(operation.action),
      });
    } catch {
      this.#clearApplyCorrelation(correlation);
      if (this.#disposed || !sameContext(this.#context, context)) {
        return;
      }
      if (this.#adapter !== adapter) {
        this.#emitMismatch(context, operation.applyToken, true);
        return;
      }
      this.#emitUnexpectedApplyFailure(context, operation.applyToken);
      return;
    }
    if (!result.applied) {
      this.#clearApplyCorrelation(correlation);
    }
    if (this.#disposed || !sameContext(this.#context, context)) {
      if (result.applied && operation.action.type === "SET_RATE_TEMPORARY") {
        restoreAdapterRate(adapter, operation.action.restoreRate);
      }
      return;
    }
    if (this.#adapter !== adapter) {
      if (result.applied && operation.action.type === "SET_RATE_TEMPORARY") {
        restoreAdapterRate(adapter, operation.action.restoreRate);
      }
      this.#emitMismatch(context, operation.applyToken, true);
      return;
    }
    if (result.applied) {
      if (operation.action.type === "SET_RATE_TEMPORARY") {
        this.#armTemporaryRateRestore(
          adapter,
          operation.action.restoreRate,
          operation.action.durationMs,
        );
      } else if (operation.action.type === "SET_RATE") {
        this.#clearTemporaryRateRestore(operation.target, false);
      }
    }
    this.#emit({
      type: "syncaction.media.observed",
      event: "APPLY_RESULT",
      context: cloneContext(context),
      target: adapter.target,
      observed: result.observed,
      applyToken: operation.applyToken,
      resultCode: result.code,
    });
  }

  #emitMismatch(
    context: MediaPageContext,
    applyToken: string,
    includeCurrentObservation: boolean,
  ): void {
    const current = includeCurrentObservation ? this.#currentObservation() : null;
    this.#emit({
      type: "syncaction.media.observed",
      event: "APPLY_RESULT",
      context: cloneContext(context),
      target: current?.target ?? null,
      observed: current?.observed ?? null,
      applyToken,
      resultCode: "TARGET_MISMATCH",
    });
  }

  #emitUnexpectedApplyFailure(context: MediaPageContext, applyToken: string): void {
    const current = this.#currentObservation();
    if (current === null) {
      this.#emitMismatch(context, applyToken, false);
      return;
    }
    this.#emit({
      type: "syncaction.media.observed",
      event: "APPLY_RESULT",
      context: cloneContext(context),
      target: current.target,
      observed: current.observed,
      applyToken,
      resultCode: "MEDIA_APPLY_FAILED",
    });
  }

  #rediscover(initial: boolean): void {
    if (this.#disposed || this.#context === null) {
      return;
    }
    if (this.#rediscoveryTimer !== undefined) {
      this.#window.clearTimeout(this.#rediscoveryTimer);
      this.#rediscoveryTimer = undefined;
    }
    const messageContext = cloneContext(this.#context);
    const previousTarget = this.#adapter?.target ?? null;
    const previousObserved = this.#currentObservation()?.observed ?? null;
    const previousCode = this.#discoveryCode;
    const result = discoverMediaAdapter({
      document: this.#document,
      window: this.#window,
      context: {
        logicalTabId: this.#context.logicalTabId,
        documentRevision: this.#context.documentRevision,
        frameKey: this.#context.frameKey,
        pageUrl: this.#safePageUrl(),
      },
      ...(this.#requestedTarget === null ? {} : { target: structuredClone(this.#requestedTarget) }),
      now: this.#now,
    });

    this.#stopAdapter();
    this.#lastRediscoveryAt = Date.now();
    if (result.adapter === null) {
      this.#discoveryCode = result.code;
      this.#startMetadataWakeListening();
      this.#reportCapability("DEGRADED", result.code, initial);
      if (initial) {
        this.#emit({
          type: "syncaction.media.observed",
          event: "UNSUPPORTED",
          context: messageContext,
          target: null,
          observed: null,
          applyToken: null,
          resultCode: result.code,
        });
      } else if (previousTarget !== null || previousCode !== result.code) {
        this.#emit({
          type: "syncaction.media.observed",
          event: "UNSUPPORTED",
          context: messageContext,
          target: null,
          observed: null,
          applyToken: null,
          resultCode: result.code,
        });
      }
      return;
    }

    const adapter = result.adapter;
    this.#stopMetadataWakeListening();
    this.#adapter = adapter;
    this.#discoveryCode = null;
    this.#unsubscribe = adapter.subscribe((event) => {
      this.#handleDiscreteEvent(adapter, event);
    });
    this.#syncFollowerInterceptor();
    const observed = adapter.read();
    this.#reportCapability("AVAILABLE", null, initial);

    if (initial || previousCode === "MEDIA_METADATA_PENDING") {
      this.#emit({
        type: "syncaction.media.observed",
        event: "DISCOVERED",
        context: messageContext,
        target: adapter.target,
        observed,
        applyToken: null,
        resultCode: null,
      });
      return;
    }
    if (previousTarget === null || !sameTarget(previousTarget, adapter.target)) {
      this.#emit({
        type: "syncaction.media.observed",
        event: "TARGET_CHANGED",
        context: messageContext,
        target: adapter.target,
        observed,
        applyToken: null,
        resultCode: null,
      });
      return;
    }
    if (previousObserved === null || !sameObservedState(previousObserved, observed)) {
      this.#emit({
        type: "syncaction.media.observed",
        event: "STATE_CHANGED",
        context: messageContext,
        target: adapter.target,
        observed,
        applyToken: null,
        resultCode: null,
      });
    }
  }

  #handleDiscreteEvent(adapter: MediaAdapter, event: MediaDiscreteEvent): void {
    if (this.#disposed || this.#adapter !== adapter) {
      return;
    }
    const context = this.#context;
    if (context === null) {
      return;
    }
    if (event.type === "DURATION_CHANGED" || event.type === "UNSUPPORTED") {
      this.#scheduleRediscovery();
      return;
    }
    let observed: MediaObservedState;
    try {
      observed = adapter.read();
    } catch {
      this.#scheduleRediscovery();
      return;
    }
    this.#emit({
      type: "syncaction.media.observed",
      event: "STATE_CHANGED",
      context: cloneContext(context),
      target: adapter.target,
      observed,
      applyToken: this.#takeCorrelatedApplyToken(adapter, event),
      trigger: event.type,
      resultCode: null,
    });
  }

  #currentObservation(): { target: MediaTarget; observed: MediaObservedState } | null {
    if (this.#adapter === undefined) {
      return null;
    }
    try {
      return {
        target: this.#adapter.target,
        observed: this.#adapter.read(),
      };
    } catch {
      return null;
    }
  }

  #emitVisibilityChanged(): void {
    const context = this.#context;
    const current = this.#currentObservation();
    if (context === null || current === null) {
      return;
    }
    this.#emit({
      type: "syncaction.media.observed",
      event: "VISIBILITY_CHANGED",
      context: cloneContext(context),
      target: current.target,
      observed: current.observed,
      visibilityState: this.#document.visibilityState === "hidden" ? "hidden" : "visible",
      applyToken: null,
      resultCode: null,
    });
  }

  #stopAdapter(): void {
    const adapter = this.#adapter;
    if (adapter !== undefined) {
      this.#clearApplyCorrelations(adapter);
    }
    try {
      this.#unsubscribe?.();
    } finally {
      this.#unsubscribe = undefined;
      if (adapter !== undefined) {
        this.#clearTemporaryRateRestore(adapter.target, true);
      }
      this.#adapter = undefined;
      this.#syncFollowerInterceptor();
    }
  }

  #armTemporaryRateRestore(adapter: MediaAdapter, restoreRate: number, durationMs: number): void {
    this.#clearTemporaryRateRestore(adapter.target, false);
    const correction: TemporaryRateRestore = {
      adapter,
      restoreRate,
      timer: 0,
    };
    correction.timer = this.#window.setTimeout(() => {
      if (this.#temporaryRateRestore !== correction) {
        return;
      }
      this.#temporaryRateRestore = null;
      restoreAdapterRate(adapter, restoreRate);
    }, durationMs);
    this.#temporaryRateRestore = correction;
  }

  #clearTemporaryRateRestore(target: MediaTarget | null, restore: boolean): void {
    const correction = this.#temporaryRateRestore;
    if (
      correction === null ||
      (target !== null && !sameTarget(correction.adapter.target, target))
    ) {
      return;
    }
    this.#temporaryRateRestore = null;
    this.#window.clearTimeout(correction.timer);
    if (restore) {
      restoreAdapterRate(correction.adapter, correction.restoreRate);
    }
  }

  #startMetadataWakeListening(): void {
    if (this.#metadataWakeListening || this.#disposed) {
      return;
    }
    this.#document.addEventListener("loadedmetadata", this.#onMetadataWake, true);
    this.#document.addEventListener("durationchange", this.#onMetadataWake, true);
    this.#metadataWakeListening = true;
  }

  #stopMetadataWakeListening(): void {
    if (!this.#metadataWakeListening) {
      return;
    }
    this.#document.removeEventListener("loadedmetadata", this.#onMetadataWake, true);
    this.#document.removeEventListener("durationchange", this.#onMetadataWake, true);
    this.#metadataWakeListening = false;
  }

  #resetDiscoveryState(): void {
    if (this.#rediscoveryTimer !== undefined) {
      this.#window.clearTimeout(this.#rediscoveryTimer);
      this.#rediscoveryTimer = undefined;
    }
    this.#stopMetadataWakeListening();
    this.#stopAdapter();
    this.#clearApplyCorrelations();
    this.#discoveryCode = null;
    this.#lastRediscoveryAt = Number.NEGATIVE_INFINITY;
    this.#lastRediscoveryTriggerAt = Number.NEGATIVE_INFINITY;
    this.#rediscoveryBackoffMs = REDISCOVERY_BASE_DELAY_MS;
  }

  #beginApplyCorrelation(
    adapter: MediaAdapter,
    operation: ApplyOperation,
  ): ApplyCorrelation | undefined {
    if (this.#applyCorrelations.length >= MAX_APPLY_CORRELATIONS) {
      return undefined;
    }
    const eventType: MediaDiscreteEvent["type"] =
      operation.action.type === "PLAY"
        ? "PLAYED"
        : operation.action.type === "PAUSE"
          ? "PAUSED"
          : operation.action.type === "SEEK"
            ? "SEEKED"
            : "RATE_CHANGED";
    const correlation: ApplyCorrelation = {
      adapter,
      applyToken: operation.applyToken,
      eventType,
      timer: undefined,
    };
    this.#applyCorrelations.push(correlation);
    correlation.timer = this.#window.setTimeout(() => {
      this.#clearApplyCorrelation(correlation);
    }, APPLY_EVENT_CORRELATION_MS);
    return correlation;
  }

  #takeCorrelatedApplyToken(adapter: MediaAdapter, event: MediaDiscreteEvent): string | null {
    const correlation = this.#applyCorrelations.find(
      (candidate) => candidate.adapter === adapter && candidate.eventType === event.type,
    );
    if (correlation === undefined) {
      return null;
    }
    const applyToken = correlation.applyToken;
    this.#clearApplyCorrelation(correlation);
    return applyToken;
  }

  #clearApplyCorrelation(correlation: ApplyCorrelation | undefined): void {
    if (correlation === undefined) {
      return;
    }
    const index = this.#applyCorrelations.indexOf(correlation);
    if (index < 0) {
      return;
    }
    this.#applyCorrelations.splice(index, 1);
    if (correlation.timer !== undefined) {
      this.#window.clearTimeout(correlation.timer);
      correlation.timer = undefined;
    }
  }

  #clearApplyCorrelations(adapter?: MediaAdapter): void {
    for (const correlation of [...this.#applyCorrelations]) {
      if (adapter === undefined || correlation.adapter === adapter) {
        this.#clearApplyCorrelation(correlation);
      }
    }
  }

  #startMonitoring(): void {
    if (this.#monitoring || this.#disposed) {
      return;
    }
    this.#monitoring = true;
    const root = this.#document.documentElement;
    if (root !== null) {
      try {
        const Observer = this.#document.defaultView?.MutationObserver ?? MutationObserver;
        const observer = new Observer((records) => {
          this.#checkPageUrl();
          if (records.some(isMediaTopologyMutation)) {
            this.#scheduleRediscovery();
          }
        });
        this.#observer = observer;
        observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["src", "class", "style", "hidden"],
        });
      } catch {
        this.#observer = undefined;
      }
    }
    this.#window.addEventListener("popstate", this.#onNavigation);
    this.#window.addEventListener("hashchange", this.#onNavigation);
    this.#document.addEventListener("visibilitychange", this.#onVisibilityChanged);
    this.#urlCheckTimer = this.#window.setInterval(() => {
      this.#checkPageUrl();
    }, URL_CHECK_INTERVAL_MS);
  }

  #checkPageUrl(): void {
    if (this.#disposed) {
      return;
    }
    const pageUrl = this.#safePageUrl();
    if (pageUrl === this.#lastPageUrl) {
      return;
    }
    this.#lastPageUrl = pageUrl;
    this.#scheduleRediscovery();
  }

  #scheduleRediscovery(): void {
    if (this.#disposed || this.#context === null || this.#rediscoveryTimer !== undefined) {
      return;
    }
    const schedulerNow = Date.now();
    if (schedulerNow - this.#lastRediscoveryTriggerAt > REDISCOVERY_BACKOFF_RESET_MS) {
      this.#rediscoveryBackoffMs = REDISCOVERY_BASE_DELAY_MS;
    }
    this.#lastRediscoveryTriggerAt = schedulerNow;
    const sinceLastRediscovery = schedulerNow - this.#lastRediscoveryAt;
    const delayMs = Math.max(
      this.#rediscoveryBackoffMs,
      REDISCOVERY_MIN_INTERVAL_MS - sinceLastRediscovery,
    );
    this.#rediscoveryTimer = this.#window.setTimeout(() => {
      this.#rediscoveryTimer = undefined;
      this.#rediscover(false);
      this.#rediscoveryBackoffMs = Math.min(
        REDISCOVERY_MAX_BACKOFF_MS,
        this.#rediscoveryBackoffMs * 2,
      );
    }, delayMs);
  }

  #safePageUrl(): string {
    try {
      const pageUrl = this.#readPageUrl();
      return typeof pageUrl === "string" ? pageUrl : "";
    } catch {
      return "";
    }
  }

  #reportCapability(
    state: "AVAILABLE" | "DEGRADED",
    errorCode: string | null,
    force: boolean,
  ): void {
    const signature = `${state}:${errorCode ?? ""}`;
    if (!force && signature === this.#lastCapability) {
      return;
    }
    this.#lastCapability = signature;
    const message = PageCapabilityMessageSchema.parse(
      state === "AVAILABLE"
        ? {
            type: "syncaction.page.capability",
            capability: "MEDIA",
            state,
            errorCode: null,
          }
        : {
            type: "syncaction.page.capability",
            capability: "MEDIA",
            state,
            errorCode,
          },
    );
    this.#emitCapabilityMessage?.(message);
  }

  #emit(message: MediaObservedMessage): void {
    if (this.#disposed) {
      return;
    }
    this.#emitObservedMessage(MediaObservedMessageSchema.parse(message));
  }
}

function isMediaTopologyMutation(record: MutationRecord): boolean {
  if (record.type === "attributes") {
    return isMediaTopologyElement(record.target);
  }
  return (
    [...record.addedNodes].some(nodeContainsMediaTopology) ||
    [...record.removedNodes].some(nodeContainsMediaTopology)
  );
}

function nodeContainsMediaTopology(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  const element = node as Element;
  return isMediaTopologyElement(element) || element.querySelector("video, audio, source") !== null;
}

function isMediaTopologyElement(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  const tagName = (node as Element).tagName.toLowerCase();
  return tagName === "video" || tagName === "audio" || tagName === "source";
}

function isMediaMetadataEventTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Element).tagName !== "string") {
    return false;
  }
  const tagName = (target as Element).tagName.toLowerCase();
  return tagName === "video" || tagName === "audio";
}

function isFollowerPlaybackKey(key: string): boolean {
  return (
    key === " " ||
    key === "Spacebar" ||
    key.toLowerCase() === "k" ||
    key === "MediaPlayPause" ||
    key === "Play" ||
    key === "Pause"
  );
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return true;
  }
  return (
    target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !==
    null
  );
}

function cloneContext(context: MediaPageContext): MediaPageContext {
  return {
    roomId: context.roomId,
    logicalTabId: context.logicalTabId,
    documentRevision: {
      roomEpoch: context.documentRevision.roomEpoch,
      tabUpdatedAtSeq: context.documentRevision.tabUpdatedAtSeq,
    },
    frameKey: context.frameKey,
  };
}

function sameContext(left: MediaPageContext | null, right: MediaPageContext): boolean {
  return (
    left !== null &&
    left.roomId === right.roomId &&
    left.logicalTabId === right.logicalTabId &&
    left.frameKey === right.frameKey &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq
  );
}

function toAdapterAction(action: MediaPageApplyAction): MediaApplyAction {
  if (action.type === "SET_RATE_TEMPORARY") {
    return {
      type: "SET_RATE",
      playbackRate: action.playbackRate,
    };
  }
  return action;
}

function restoreAdapterRate(adapter: MediaAdapter, restoreRate: number): void {
  try {
    adapter.getMediaElement().playbackRate = restoreRate;
  } catch {
    // The media may have been removed; no external cleanup remains possible.
  }
}

function sameTarget(left: MediaTarget, right: MediaTarget): boolean {
  return (
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey &&
    left.provider === right.provider &&
    left.mediaKey === right.mediaKey &&
    left.durationMs === right.durationMs
  );
}

function isAdapterUsable(adapter: MediaAdapter): boolean {
  try {
    return adapter.isUsable();
  } catch {
    return false;
  }
}

function followerPlaybackSurfaceHeight(mediaHeight: number): number {
  const preferredControlStrip = Math.min(
    FOLLOWER_CONTROL_STRIP_MAX_PX,
    Math.max(FOLLOWER_CONTROL_STRIP_MIN_PX, mediaHeight * FOLLOWER_CONTROL_STRIP_RATIO),
  );
  const controlStrip = Math.min(mediaHeight / 2, preferredControlStrip);
  return Math.max(0, mediaHeight - controlStrip);
}

function sameObservedState(left: MediaObservedState, right: MediaObservedState): boolean {
  return (
    left.positionMs === right.positionMs &&
    left.paused === right.paused &&
    left.playbackRate === right.playbackRate &&
    left.ended === right.ended &&
    left.buffering === right.buffering
  );
}
