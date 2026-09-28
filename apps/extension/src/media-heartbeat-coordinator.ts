import type {
  MediaObservedState,
  MediaTarget,
  PlaybackGroupSnapshot,
  RoomId,
} from "@syncaction/protocol";
import type { MediaTransport } from "./socket-transport.js";
import { buildMediaHeartbeat } from "./media-controller-commands.js";
import type { MediaRoute } from "./media-controller-model.js";

const HEARTBEAT_INTERVAL_MS = 500;
const MAINTENANCE_HEARTBEAT_INTERVAL_MS = 2_000;

export type MediaPageVisibility = "visible" | "hidden";

export interface MediaHeartbeatSample extends MediaRoute {
  target: MediaTarget;
  observed: MediaObservedState;
}

interface RevisionBoundHeartbeatSample extends MediaHeartbeatSample {
  playbackGroupId: string;
  groupRevision: number;
  sampleEpoch: number;
}

export interface MediaHeartbeatScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface MediaHeartbeatCoordinatorOptions {
  roomId: RoomId;
  transport: Pick<MediaTransport, "publishMediaHeartbeat">;
  scheduler: MediaHeartbeatScheduler;
  now(): number;
  findLeaderGroup(sample: MediaHeartbeatSample): PlaybackGroupSnapshot | undefined;
  isRouteCurrent(route: MediaRoute): Promise<boolean>;
  onError(errorCode: string): void;
}

export class MediaHeartbeatCoordinator {
  readonly #roomId: RoomId;
  readonly #transport: Pick<MediaTransport, "publishMediaHeartbeat">;
  readonly #scheduler: MediaHeartbeatScheduler;
  readonly #now: () => number;
  readonly #findLeaderGroup: (sample: MediaHeartbeatSample) => PlaybackGroupSnapshot | undefined;
  readonly #isRouteCurrent: (route: MediaRoute) => Promise<boolean>;
  readonly #onError: (errorCode: string) => void;
  #active = false;
  #generation = 0;
  #sampleEpoch = 0;
  #latestSample: RevisionBoundHeartbeatSample | null = null;
  #pendingSample: RevisionBoundHeartbeatSample | null = null;
  readonly #visibilityByRoute = new Map<string, MediaPageVisibility>();
  #pageVisibility: MediaPageVisibility = "visible";
  #publishing = false;
  #maintenanceConfirmationPending = false;
  #timer: unknown;
  #scheduledIntervalMs: number | undefined;
  #tail: Promise<void> = Promise.resolve();

  public constructor(options: MediaHeartbeatCoordinatorOptions) {
    this.#roomId = options.roomId;
    this.#transport = options.transport;
    this.#scheduler = options.scheduler;
    this.#now = options.now;
    this.#findLeaderGroup = options.findLeaderGroup;
    this.#isRouteCurrent = options.isRouteCurrent;
    this.#onError = options.onError;
  }

  public start(): void {
    if (this.#active) {
      return;
    }
    this.#active = true;
    this.#generation += 1;
    this.#rescheduleTimer();
  }

  public offerSample(sample: MediaHeartbeatSample, immediate: boolean): void {
    if (!this.#active) {
      return;
    }
    const group = this.#findLeaderGroup(sample);
    if (group === undefined || group.target === null) {
      return;
    }
    const revisionBoundSample: RevisionBoundHeartbeatSample = {
      ...structuredClone(sample),
      playbackGroupId: group.playbackGroupId,
      groupRevision: group.groupRevision,
      sampleEpoch: this.#sampleEpoch,
    };
    if (!isMaintenanceObservation(revisionBoundSample.observed)) {
      this.#maintenanceConfirmationPending = false;
    } else if (immediate) {
      this.#maintenanceConfirmationPending = true;
    }
    this.#latestSample = revisionBoundSample;
    this.#setCurrentPageVisibility(
      this.#visibilityByRoute.get(mediaHeartbeatRouteKey(sample)) ?? "visible",
    );
    this.#ensureHeartbeatInterval();
    if (immediate) {
      this.#queueSample(structuredClone(revisionBoundSample), this.#generation);
    }
  }

  public clearSample(): void {
    this.#sampleEpoch += 1;
    this.#latestSample = null;
    this.#pendingSample = null;
    this.#maintenanceConfirmationPending = false;
    this.#visibilityByRoute.clear();
    this.#setCurrentPageVisibility("visible");
    this.#ensureHeartbeatInterval();
  }

  public setPageVisibility(route: MediaRoute, visibility: MediaPageVisibility): void {
    const routeKey = mediaHeartbeatRouteKey(route);
    this.#visibilityByRoute.set(routeKey, visibility);
    if (this.#latestSample !== null && routeKey === mediaHeartbeatRouteKey(this.#latestSample)) {
      this.#setCurrentPageVisibility(visibility);
    }
  }

  public async stop(): Promise<void> {
    if (!this.#active) {
      this.#latestSample = null;
      await this.whenIdle();
      return;
    }
    this.#active = false;
    this.#generation += 1;
    this.#sampleEpoch += 1;
    this.#latestSample = null;
    this.#pendingSample = null;
    this.#maintenanceConfirmationPending = false;
    this.#visibilityByRoute.clear();
    this.#pageVisibility = "visible";
    if (this.#timer !== undefined) {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = undefined;
      this.#scheduledIntervalMs = undefined;
    }
    await this.whenIdle();
  }

  public async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.#tail;
      await observed;
    } while (observed !== this.#tail);
  }

  public dispose(): Promise<void> {
    return this.stop();
  }

  #queueLatest(generation: number): void {
    const sample = this.#latestSample;
    if (sample !== null) {
      this.#queueSample(structuredClone(sample), generation);
    }
  }

  #queueSample(revisionBoundSample: RevisionBoundHeartbeatSample, generation: number): void {
    if (!this.#active || generation !== this.#generation) {
      return;
    }
    if (this.#publishing) {
      this.#pendingSample = structuredClone(revisionBoundSample);
      return;
    }
    this.#publishing = true;
    const result = this.#drain(revisionBoundSample, generation);
    this.#tail = result.catch(() => undefined);
  }

  async #drain(initialSample: RevisionBoundHeartbeatSample, generation: number): Promise<void> {
    let sample: RevisionBoundHeartbeatSample | null = initialSample;
    try {
      while (sample !== null && this.#active && generation === this.#generation) {
        await this.#publish(sample, generation);
        if (!this.#active || generation !== this.#generation) {
          this.#pendingSample = null;
          return;
        }
        sample = this.#pendingSample;
        this.#pendingSample = null;
      }
    } finally {
      this.#publishing = false;
    }
  }

  async #publish(sample: RevisionBoundHeartbeatSample, generation: number): Promise<void> {
    let group = this.#currentGroupForSample(sample, generation);
    if (group === undefined) {
      return;
    }
    let routeCurrent: boolean;
    try {
      routeCurrent = await this.#isRouteCurrent(sample);
    } catch (cause) {
      if (this.#currentGroupForSample(sample, generation) !== undefined) {
        this.#onError(mediaHeartbeatErrorCode(cause));
      }
      return;
    }
    if (!routeCurrent) {
      return;
    }
    group = this.#currentGroupForSample(sample, generation);
    if (group === undefined) {
      return;
    }
    try {
      this.#transport.publishMediaHeartbeat(
        buildMediaHeartbeat({
          roomId: this.#roomId,
          group,
          target: sample.target,
          observed: sample.observed,
          nowMs: this.#now(),
        }),
      );
    } catch (cause) {
      if (
        this.#active &&
        generation === this.#generation &&
        sample.sampleEpoch === this.#sampleEpoch
      ) {
        this.#onError(mediaHeartbeatErrorCode(cause));
      }
    }
  }

  #currentGroupForSample(
    sample: RevisionBoundHeartbeatSample,
    generation: number,
  ): PlaybackGroupSnapshot | undefined {
    if (
      !this.#active ||
      generation !== this.#generation ||
      sample.sampleEpoch !== this.#sampleEpoch
    ) {
      return undefined;
    }
    const group = this.#findLeaderGroup(sample);
    return group !== undefined &&
      group.target !== null &&
      group.playbackGroupId === sample.playbackGroupId &&
      group.groupRevision === sample.groupRevision
      ? group
      : undefined;
  }

  #setCurrentPageVisibility(visibility: MediaPageVisibility): void {
    if (visibility === this.#pageVisibility) {
      return;
    }
    this.#pageVisibility = visibility;
    this.#ensureHeartbeatInterval();
  }

  #rescheduleTimer(): void {
    if (!this.#active) {
      return;
    }
    if (this.#timer !== undefined) {
      this.#scheduler.clearInterval(this.#timer);
    }
    const generation = this.#generation;
    const intervalMs = this.#desiredHeartbeatIntervalMs();
    this.#scheduledIntervalMs = intervalMs;
    this.#timer = this.#scheduler.setInterval(() => {
      this.#queueLatest(generation);
      if (this.#maintenanceConfirmationPending) {
        this.#maintenanceConfirmationPending = false;
        this.#ensureHeartbeatInterval();
      }
    }, intervalMs);
  }

  #ensureHeartbeatInterval(): void {
    if (this.#active && this.#scheduledIntervalMs !== this.#desiredHeartbeatIntervalMs()) {
      this.#rescheduleTimer();
    }
  }

  #desiredHeartbeatIntervalMs(): number {
    const observed = this.#latestSample?.observed;
    return !this.#maintenanceConfirmationPending &&
      (this.#pageVisibility === "hidden" || isMaintenanceObservation(observed))
      ? MAINTENANCE_HEARTBEAT_INTERVAL_MS
      : HEARTBEAT_INTERVAL_MS;
  }
}

function isMaintenanceObservation(observed: MediaObservedState | undefined): boolean {
  return observed?.paused === true || observed?.ended === true;
}

function mediaHeartbeatRouteKey(route: MediaRoute): string {
  return [
    route.tabId,
    route.frameId,
    route.context.roomId,
    route.context.logicalTabId,
    route.context.documentRevision.roomEpoch,
    route.context.documentRevision.tabUpdatedAtSeq,
    route.context.frameKey,
  ].join(":");
}

function mediaHeartbeatErrorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code;
  }
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "MEDIA_HEARTBEAT_FAILED";
}
