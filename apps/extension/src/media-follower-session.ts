import type {
  MediaObservedState,
  MediaTarget,
  PlaybackAction,
  PlaybackGroupSnapshot,
} from "@syncaction/protocol";
import {
  inferMediaFollowerAction,
  planMediaFollowerCorrection,
} from "./media-controller-correction.js";
import { sameMediaContext, sameMediaTarget, type MediaRoute } from "./media-controller-model.js";
import type {
  MediaObservedTrigger,
  MediaPageApplyAction,
  MediaPageContext,
} from "./page-collaboration/messages.js";

const MAX_APPLY_TOKENS = 64;

export interface MediaFollowerPagePort {
  apply(
    tabId: number,
    frameId: number,
    context: MediaPageContext,
    target: MediaTarget,
    action: MediaPageApplyAction,
    applyToken: string,
  ): Promise<void>;
  setFollowerLock(
    tabId: number,
    frameId: number,
    context: MediaPageContext,
    target: MediaTarget,
    locked: boolean,
  ): Promise<void>;
}

export interface MediaFollowerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MediaFollowerSessionOptions {
  userId: string;
  deviceId: string;
  page: MediaFollowerPagePort;
  scheduler: MediaFollowerScheduler;
  now(): number;
  createUuid(): string;
  isRouteCurrent(route: MediaRoute): Promise<boolean>;
  getGroup(playbackGroupId: string): PlaybackGroupSnapshot | undefined;
  propose(group: PlaybackGroupSnapshot, action: PlaybackAction): Promise<void>;
  onError(errorCode: string): void;
}

interface ActiveRateCorrection {
  handle: unknown;
  route: MediaRoute;
  target: MediaTarget;
  playbackGroupId: string;
  groupRevision: number;
  temporaryRate: number;
  restoreRate: number;
  guard: () => boolean;
}

interface LockedFollowerBinding extends MediaRoute {
  target: MediaTarget;
}

interface ApplyTokenState {
  applyResultSeen: boolean;
  discreteEventSeen: boolean;
}

export class MediaFollowerSession {
  readonly #page: MediaFollowerPagePort;
  readonly #scheduler: MediaFollowerScheduler;
  readonly #now: () => number;
  readonly #createUuid: () => string;
  readonly #isRouteCurrent: (route: MediaRoute) => Promise<boolean>;
  readonly #getGroup: (playbackGroupId: string) => PlaybackGroupSnapshot | undefined;
  readonly #propose: (group: PlaybackGroupSnapshot, action: PlaybackAction) => Promise<void>;
  readonly #onError: (errorCode: string) => void;
  readonly #applyTokens = new Map<string, ApplyTokenState>();
  readonly #inFlightGestureProposals = new Set<string>();
  #lockedRoute: LockedFollowerBinding | null = null;
  #activeRateCorrection: ActiveRateCorrection | null = null;
  #pendingForcedAlignment: string | null = null;
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;

  public constructor(options: MediaFollowerSessionOptions) {
    this.#page = options.page;
    this.#scheduler = options.scheduler;
    this.#now = options.now;
    this.#createUuid = options.createUuid;
    this.#isRouteCurrent = options.isRouteCurrent;
    this.#getGroup = options.getGroup;
    this.#propose = options.propose;
    this.#onError = options.onError;
  }

  public matchesApplyToken(applyToken: string | null): boolean {
    return applyToken !== null && this.#applyTokens.has(applyToken);
  }

  public markApplyResult(applyToken: string): void {
    const state = this.#applyTokens.get(applyToken);
    if (state === undefined) {
      return;
    }
    if (state.discreteEventSeen) {
      this.#applyTokens.delete(applyToken);
      return;
    }
    state.applyResultSeen = true;
  }

  public markApplyDiscreteEvent(applyToken: string): void {
    const state = this.#applyTokens.get(applyToken);
    if (state === undefined) {
      return;
    }
    if (state.applyResultSeen) {
      this.#applyTokens.delete(applyToken);
      return;
    }
    state.discreteEventSeen = true;
  }

  public setPendingForcedAlignment(playbackGroupId: string | null): void {
    this.#pendingForcedAlignment = playbackGroupId;
  }

  public consumeForcedAlignment(playbackGroupId: string): boolean {
    const pending = this.#pendingForcedAlignment === playbackGroupId;
    if (pending) {
      this.#pendingForcedAlignment = null;
    }
    return pending;
  }

  public reserveApplyToken(): string {
    const applyToken = this.#createUuid();
    this.#rememberApplyToken(applyToken);
    return applyToken;
  }

  public releaseApplyToken(applyToken: string): void {
    this.#applyTokens.delete(applyToken);
  }

  public invalidateApplyTokens(): void {
    this.#applyTokens.clear();
  }

  public async apply(
    route: MediaRoute,
    target: MediaTarget,
    action: MediaPageApplyAction,
    guard: () => boolean,
    applyToken?: string,
    onDispatch?: () => void,
  ): Promise<boolean> {
    if (this.#disposed || !guard() || !(await this.#isRouteCurrent(route)) || !guard()) {
      return false;
    }
    onDispatch?.();
    await this.#sendPageApply(route, target, action, applyToken);
    return true;
  }

  public async lock(
    route: MediaRoute | null,
    target: MediaTarget | null,
    guard: () => boolean = () => true,
  ): Promise<void> {
    const previous = this.#lockedRoute;
    if (
      previous !== null &&
      (route === null ||
        previous.tabId !== route.tabId ||
        previous.frameId !== route.frameId ||
        !sameMediaContext(previous.context, route.context) ||
        target === null ||
        !sameMediaTarget(previous.target, target))
    ) {
      try {
        await this.#page.setFollowerLock(
          previous.tabId,
          previous.frameId,
          previous.context,
          previous.target,
          false,
        );
      } catch {
        // A stale or revoked document may already be unreachable.
      }
      this.#lockedRoute = null;
    }
    if (
      !this.#disposed &&
      route !== null &&
      target !== null &&
      guard() &&
      (this.#lockedRoute === null ||
        this.#lockedRoute.tabId !== route.tabId ||
        this.#lockedRoute.frameId !== route.frameId ||
        !sameMediaContext(this.#lockedRoute.context, route.context) ||
        !sameMediaTarget(this.#lockedRoute.target, target))
    ) {
      await this.#page.setFollowerLock(route.tabId, route.frameId, route.context, target, true);
      if (guard()) {
        this.#lockedRoute = {
          ...route,
          target: structuredClone(target),
        };
      } else {
        try {
          await this.#page.setFollowerLock(
            route.tabId,
            route.frameId,
            route.context,
            target,
            false,
          );
        } catch {
          // Cleanup may race a document replacement or permission revoke.
        }
      }
    }
  }

  public async handleGesture(
    group: PlaybackGroupSnapshot,
    route: MediaRoute,
    localTarget: MediaTarget,
    localObserved: MediaObservedState,
    guard: () => boolean,
    trigger: MediaObservedTrigger | null = null,
  ): Promise<PlaybackAction | null> {
    const action = inferMediaFollowerAction(
      group,
      localTarget,
      localObserved,
      this.#now(),
      trigger,
    );
    if (action === null) {
      return null;
    }
    const correction =
      action.type === "SWITCH_TARGET"
        ? this.#containUnapprovedTarget(route, localTarget, localObserved, guard)
        : this.reconcile(group, route, localTarget, localObserved, true, guard);
    const results = await Promise.allSettled([this.#proposeOnce(group, action, guard), correction]);
    const correctionFailure = results[1];
    if (correctionFailure?.status === "rejected" && guard()) {
      this.#onError(mediaFollowerErrorCode(correctionFailure.reason, "MEDIA_FOLLOWER_FAILURE"));
    }
    return action;
  }

  public async reconcile(
    group: PlaybackGroupSnapshot,
    route: MediaRoute,
    localTarget: MediaTarget,
    localObserved: MediaObservedState,
    forceSeek: boolean,
    guard: () => boolean,
  ): Promise<void> {
    if (
      this.#disposed ||
      group.target === null ||
      group.observed === null ||
      !sameMediaTarget(group.target, localTarget) ||
      !guard()
    ) {
      return;
    }
    await this.lock(route, group.target, guard);
    if (!guard()) {
      return;
    }
    const plan = planMediaFollowerCorrection(
      group,
      localTarget,
      localObserved,
      this.#now(),
      forceSeek,
    );
    const plannedRestoreRate = plan.rateRestore?.playbackRate ?? null;
    let plannedCorrectionRate: number | null = null;
    if (plannedRestoreRate !== null) {
      for (const action of plan.actions) {
        if (action.type === "SET_RATE_TEMPORARY" && action.playbackRate !== plannedRestoreRate) {
          plannedCorrectionRate = action.playbackRate;
          break;
        }
      }
    }
    let continuesRateCorrection =
      this.#activeRateCorrection !== null &&
      sameRateCorrectionSession(this.#activeRateCorrection, route, group);
    if (
      this.#activeRateCorrection !== null &&
      (!continuesRateCorrection ||
        plan.actions.some((action) => action.type === "SEEK") ||
        (plannedCorrectionRate !== null &&
          plannedCorrectionRate !== this.#activeRateCorrection.temporaryRate))
    ) {
      await this.cancelRateCorrection(true);
      continuesRateCorrection = false;
    }
    for (const action of plan.actions) {
      if (
        continuesRateCorrection &&
        (action.type === "SET_RATE" || action.type === "SET_RATE_TEMPORARY")
      ) {
        continue;
      }
      await this.apply(route, group.target, action, guard);
    }
    if (
      plan.rateRestore !== null &&
      plannedCorrectionRate !== null &&
      !continuesRateCorrection &&
      guard()
    ) {
      this.#scheduleRateRestore(
        route,
        group,
        plannedCorrectionRate,
        plan.rateRestore.playbackRate,
        plan.rateRestore.durationMs,
        guard,
      );
    }
  }

  public async cancelRateCorrection(restore: boolean): Promise<void> {
    const correction = this.#activeRateCorrection;
    if (correction === null) {
      return;
    }
    this.#activeRateCorrection = null;
    this.#scheduler.clearTimeout(correction.handle);
    if (restore) {
      try {
        if (await this.#isRouteCurrent(correction.route)) {
          await this.#sendPageApply(correction.route, correction.target, {
            type: "SET_RATE",
            playbackRate: correction.restoreRate,
          });
        }
      } catch (cause) {
        this.#onError(mediaFollowerErrorCode(cause, "MEDIA_RATE_RESTORE_FAILED"));
      }
    }
  }

  public async clear(): Promise<void> {
    await this.cancelRateCorrection(true);
    await this.lock(null, null);
    this.#pendingForcedAlignment = null;
    this.#inFlightGestureProposals.clear();
    this.#applyTokens.clear();
  }

  public async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.#tail;
      await observed;
    } while (observed !== this.#tail);
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) {
      await this.whenIdle();
      return;
    }
    await this.clear();
    this.#disposed = true;
    await this.whenIdle();
  }

  async #sendPageApply(
    route: MediaRoute,
    target: MediaTarget,
    action: MediaPageApplyAction,
    reservedApplyToken?: string,
  ): Promise<void> {
    const applyToken = reservedApplyToken ?? this.reserveApplyToken();
    if (!this.#applyTokens.has(applyToken)) {
      this.#rememberApplyToken(applyToken);
    }
    try {
      await this.#page.apply(route.tabId, route.frameId, route.context, target, action, applyToken);
    } catch (cause) {
      this.#applyTokens.delete(applyToken);
      throw cause;
    }
  }

  #rememberApplyToken(applyToken: string): void {
    while (this.#applyTokens.size >= MAX_APPLY_TOKENS) {
      const oldest = this.#applyTokens.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#applyTokens.delete(oldest);
    }
    this.#applyTokens.set(applyToken, {
      applyResultSeen: false,
      discreteEventSeen: false,
    });
  }

  async #containUnapprovedTarget(
    route: MediaRoute,
    target: MediaTarget,
    observed: MediaObservedState,
    guard: () => boolean,
  ): Promise<void> {
    await this.lock(route, target, guard);
    if (!observed.paused && guard()) {
      await this.apply(route, target, { type: "PAUSE" }, guard);
    }
  }

  #scheduleRateRestore(
    route: MediaRoute,
    group: PlaybackGroupSnapshot,
    temporaryRate: number,
    restoreRate: number,
    durationMs: number,
    guard: () => boolean,
  ): void {
    if (this.#activeRateCorrection !== null) {
      this.#scheduler.clearTimeout(this.#activeRateCorrection.handle);
    }
    const correction: ActiveRateCorrection = {
      handle: undefined,
      route,
      target: group.target!,
      playbackGroupId: group.playbackGroupId,
      groupRevision: group.groupRevision,
      temporaryRate,
      restoreRate,
      guard,
    };
    correction.handle = this.#scheduler.setTimeout(() => {
      if (this.#activeRateCorrection !== correction) {
        return;
      }
      this.#enqueue(async () => {
        if (this.#activeRateCorrection !== correction) {
          return;
        }
        const current = this.#getGroup(correction.playbackGroupId);
        if (
          correction.guard() &&
          current?.groupRevision === correction.groupRevision &&
          sameMediaTarget(current.target, correction.target)
        ) {
          await this.apply(
            correction.route,
            correction.target,
            { type: "SET_RATE", playbackRate: correction.restoreRate },
            correction.guard,
          );
          if (correction.guard() && this.#activeRateCorrection === correction) {
            this.#activeRateCorrection = null;
          }
        }
      });
    }, durationMs);
    this.#activeRateCorrection = correction;
  }

  async #proposeOnce(
    group: PlaybackGroupSnapshot,
    action: PlaybackAction,
    guard: () => boolean,
  ): Promise<void> {
    const key = `${group.playbackGroupId}:${String(group.groupRevision)}:${JSON.stringify(action)}`;
    if (this.#inFlightGestureProposals.has(key)) {
      return;
    }
    this.#inFlightGestureProposals.add(key);
    try {
      await this.#propose(group, action);
    } catch (cause) {
      if (guard()) {
        this.#onError(mediaFollowerErrorCode(cause, "MEDIA_PROPOSAL_FAILED"));
      }
    } finally {
      this.#inFlightGestureProposals.delete(key);
    }
  }

  #enqueue(work: () => Promise<void>): void {
    const result = this.#tail.then(work);
    this.#tail = result.catch((cause) => {
      this.#onError(mediaFollowerErrorCode(cause, "MEDIA_FOLLOWER_FAILURE"));
    });
  }
}

function sameRateCorrectionSession(
  correction: ActiveRateCorrection,
  route: MediaRoute,
  group: PlaybackGroupSnapshot,
): boolean {
  return (
    group.target !== null &&
    group.observed !== null &&
    correction.playbackGroupId === group.playbackGroupId &&
    correction.groupRevision === group.groupRevision &&
    correction.restoreRate === group.observed.playbackRate &&
    correction.route.tabId === route.tabId &&
    correction.route.frameId === route.frameId &&
    sameMediaContext(correction.route.context, route.context) &&
    sameMediaTarget(correction.target, group.target)
  );
}

function mediaFollowerErrorCode(cause: unknown, fallback: string): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code;
  }
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
