import {
  CanonicalUuidSchema,
  DeviceIdSchema,
  MediaGroupsSnapshotMessageSchema,
  MediaObservedStateSchema,
  MediaTargetSchema,
  PlaybackActionSchema,
  RoomIdSchema,
  type MediaCommand,
  type MediaCommandAck,
  type MediaGroupsSnapshotMessage,
  type MediaObservedState,
  type MediaTarget,
  type PlaybackAction,
  type PlaybackGroupSnapshot,
  type RoomId,
} from "@syncaction/protocol";
import { predictGroupPosition } from "@syncaction/media";
import type { DurableReplica } from "@syncaction/replica";
import { z } from "zod";
import type { ActiveTabPresenceStatus } from "./active-tab-presence.js";
import {
  PageCapabilityReportSchema,
  MediaObservedMessageSchema,
  type MediaObservedMessage,
  type MediaPageApplyAction,
  type MediaPageContext,
  type PageCapabilityReport,
} from "./page-collaboration/messages.js";
import type { MediaTransport } from "./socket-transport.js";
import {
  buildExistingMediaCommand,
  buildMediaCreateCommand,
  isCurrentMediaCommandAck,
  type ExistingMediaCommandPayload,
} from "./media-controller-commands.js";
import {
  hasMediaAuthoritativeDiscontinuity,
  hasMediaAuthoritativeSeek,
  planMediaLeaderAuthorityRestoration,
} from "./media-controller-correction.js";
import { MediaFollowerSession } from "./media-follower-session.js";
import { MediaHeartbeatCoordinator } from "./media-heartbeat-coordinator.js";
import {
  deriveMediaMembership,
  findMediaLeaderGroup,
  findMediaTargetRoute,
  mediaRouteKey,
  projectMediaControllerStatus,
  projectMediaNavigation,
  resolveMediaRoute,
  sameMediaContext,
  sameMediaRevision,
  sameMediaTarget,
  type MediaControllerStatus,
  type MediaLocalMembershipStatus,
  type MediaNavigationStatus,
  type MediaRoute,
} from "./media-controller-model.js";

export type {
  MediaControllerStatus,
  MediaLocalMembershipStatus,
  MediaNavigationStatus,
} from "./media-controller-model.js";

const LocalTabIdSchema = z.number().int().nonnegative().safe();
const FrameIdSchema = z.number().int().nonnegative().safe();
const BrowserSessionIdSchema = z.string().uuid();
const MediaFrameKeySchema = z
  .string()
  .max(103)
  .regex(/^(?:top|frame:[A-Za-z0-9._~-]{1,96})$/u);

export interface MediaScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface MediaPagePort {
  observe(
    tabId: number,
    frameId: number,
    context: MediaPageContext,
    target?: MediaTarget,
  ): Promise<void>;
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

export interface MediaNavigationPort {
  activateTab(tabId: number): Promise<void>;
}

export interface MediaPresencePort {
  getStatus(): ActiveTabPresenceStatus;
}

export interface MediaCompatibilityPort {
  canSynchronizeKnownMedia(input: {
    target: MediaTarget;
    remoteUserId: string;
    remoteDeviceId: string;
  }): boolean;
}

export interface MediaControllerOptions {
  roomId: unknown;
  userId: unknown;
  deviceId: unknown;
  browserSessionId: unknown;
  replica: Pick<DurableReplica, "getRecord">;
  presence: MediaPresencePort;
  page: MediaPagePort;
  transport: MediaTransport;
  compatibility?: MediaCompatibilityPort;
  navigation?: MediaNavigationPort;
  now?: () => number;
  createUuid?: () => string;
  scheduler?: MediaScheduler;
}

export class MediaControllerError extends Error {
  public readonly code: string;

  public constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "MediaControllerError";
    this.code = code;
  }
}

interface LocalObservation extends MediaRoute {
  target: MediaTarget;
  observed: MediaObservedState;
}

interface ScopedPageApplyError {
  route: MediaRoute;
  target: MediaTarget;
  code: string;
}

interface TargetSpecificObservation {
  route: MediaRoute;
  target: MediaTarget;
}

interface LeaderAuthorityBatch {
  generation: number;
  playbackGroupId: string;
  groupRevision: number;
  route: MediaRoute;
  target: MediaTarget;
  tokens: readonly string[];
  resultObservations: Array<LocalObservation | undefined>;
  resultCount: number;
  dispatchedCount: number;
  deadline: Promise<false>;
  resolveDeadline(result: false): void;
  deadlineHandle: unknown | null;
  recoveryObservationRequested: boolean;
}

interface LeaderAuthorityTokenState {
  batch: LeaderAuthorityBatch;
  index: number;
  applyResultSeen: boolean;
  discreteEventSeen: boolean;
}

const MAX_LEADER_AUTHORITY_TOKENS = 64;
const LEADER_AUTHORITY_BATCH_TIMEOUT_MS = 2_000;

const defaultScheduler: MediaScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export class MediaController {
  readonly #roomId: RoomId;
  readonly #userId: string;
  readonly #deviceId: string;
  readonly #browserSessionId: string;
  readonly #replica: Pick<DurableReplica, "getRecord">;
  readonly #presence: MediaPresencePort;
  readonly #page: MediaPagePort;
  readonly #transport: MediaTransport;
  readonly #compatibility: MediaCompatibilityPort | undefined;
  readonly #navigation: MediaNavigationPort | undefined;
  readonly #now: () => number;
  readonly #createUuid: () => string;
  readonly #scheduler: MediaScheduler;
  readonly #heartbeat: MediaHeartbeatCoordinator;
  readonly #follower: MediaFollowerSession;
  readonly #routes = new Map<string, MediaRoute>();
  readonly #pageCapabilityErrors = new Map<string, string>();
  readonly #pendingGestureObservations = new Map<string, Promise<void>>();
  readonly #leaderAuthorityTokens = new Map<string, LeaderAuthorityTokenState>();
  #navigationStatus: MediaNavigationStatus[] = [];
  #controlStateValid = true;
  #synchronized = false;
  #disposed = false;
  #generation = 0;
  #activeTabId: number | undefined;
  #snapshot: MediaGroupsSnapshotMessage | null = null;
  #localObservation: LocalObservation | null = null;
  #tail: Promise<void> = Promise.resolve();
  #commandTail: Promise<void> = Promise.resolve();
  #errorCode: string | null = null;
  #pageApplyError: ScopedPageApplyError | null = null;
  #targetSpecificObservation: TargetSpecificObservation | null = null;
  #activeLeaderAuthorityBatch: LeaderAuthorityBatch | null = null;
  #leaderAuthorityRecoveryBatch: LeaderAuthorityBatch | null = null;
  #leaderAuthorityBlockedGroupId: string | null = null;

  public constructor(options: MediaControllerOptions) {
    this.#roomId = RoomIdSchema.parse(options.roomId);
    this.#userId = CanonicalUuidSchema.parse(options.userId);
    this.#deviceId = DeviceIdSchema.parse(options.deviceId);
    this.#browserSessionId = BrowserSessionIdSchema.parse(options.browserSessionId);
    this.#replica = options.replica;
    this.#presence = options.presence;
    this.#page = options.page;
    this.#transport = options.transport;
    this.#compatibility = options.compatibility;
    this.#navigation = options.navigation;
    this.#now = options.now ?? Date.now;
    this.#createUuid = options.createUuid ?? (() => crypto.randomUUID());
    const scheduler = options.scheduler ?? defaultScheduler;
    this.#scheduler = scheduler;
    this.#follower = new MediaFollowerSession({
      userId: this.#userId,
      deviceId: this.#deviceId,
      page: this.#page,
      scheduler,
      now: this.#now,
      createUuid: () => this.#newUuid(),
      isRouteCurrent: (route) => this.#isRouteCurrent(route),
      getGroup: (playbackGroupId) => this.#groupById(playbackGroupId),
      propose: async (group, action) => {
        await this.propose(group.playbackGroupId, action);
      },
      onError: (code) => {
        if (this.#synchronized) {
          this.#errorCode = code;
        }
      },
    });
    this.#heartbeat = new MediaHeartbeatCoordinator({
      roomId: this.#roomId,
      transport: this.#transport,
      scheduler,
      now: this.#now,
      findLeaderGroup: (sample) =>
        findMediaLeaderGroup(this.#snapshot?.groups ?? [], sample, this.#userId, this.#deviceId),
      isRouteCurrent: (route) => this.#isRouteCurrent(route),
      onError: (code) => {
        if (this.#synchronized) {
          this.#errorCode = code;
        }
      },
    });
  }

  public setSynchronized(synchronized: boolean): Promise<void> {
    if (this.#disposed && synchronized) {
      return Promise.reject(new MediaControllerError("MEDIA_CONTROLLER_DISPOSED"));
    }
    if (synchronized === this.#synchronized) {
      return this.whenIdle();
    }
    this.#synchronized = synchronized;
    this.#generation += 1;
    this.#pendingGestureObservations.clear();
    if (!synchronized) {
      this.#cancelLeaderAuthorityBatch(false);
      this.#leaderAuthorityRecoveryBatch = null;
      this.#leaderAuthorityBlockedGroupId = null;
      this.#transport.setMediaHandler(undefined);
      const heartbeatStopped = this.#heartbeat.stop();
      this.#enqueue(async () => {
        await heartbeatStopped;
        await this.#clearControlState(null, false);
        this.#snapshot = null;
        this.#routes.clear();
        this.#pageCapabilityErrors.clear();
        this.#navigationStatus = [];
      });
      return this.whenIdle();
    }
    const generation = this.#generation;
    this.#transport.setMediaHandler((message) => {
      this.#enqueue(async () => {
        if (this.#synchronized && generation === this.#generation) {
          await this.#acceptSnapshot(message, generation);
        }
      });
    });
    this.#heartbeat.start();
    if (this.#activeTabId !== undefined) {
      this.#enqueue(() => this.#observeTopFrame(this.#activeTabId!, generation));
    }
    return this.whenIdle();
  }

  public async handleActiveTabChanged(tabIdInput: unknown): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const activeTabChanged = this.#activeTabId !== tabId;
    this.#activeTabId = tabId;
    if (activeTabChanged) {
      this.#cancelLeaderAuthorityBatch(true);
      this.#leaderAuthorityRecoveryBatch = null;
      this.#pendingGestureObservations.clear();
      this.#localObservation = null;
      this.#heartbeat.clearSample();
    }
    if (this.#synchronized) {
      const generation = this.#generation;
      this.#enqueue(() => this.#observeTopFrame(tabId, generation));
    }
    await this.whenIdle();
  }

  public async handleBindingsChanged(): Promise<void> {
    if (this.#synchronized) {
      this.#cancelLeaderAuthorityBatch(true);
      this.#leaderAuthorityRecoveryBatch = null;
      const generation = this.#generation;
      this.#enqueue(async () => {
        await this.#refreshNavigation();
        if (this.#activeTabId !== undefined) {
          await this.#observeTopFrame(this.#activeTabId, generation);
        }
        const membership = this.#currentMembership();
        const group = membership === null ? undefined : this.#groupById(membership.playbackGroupId);
        const targetRouteMissing =
          group?.target !== null &&
          group?.target !== undefined &&
          (await this.#routeForTarget(group.target)) === null;
        const localRouteStale =
          this.#localObservation !== null && !(await this.#isRouteCurrent(this.#localObservation));
        if (targetRouteMissing || localRouteStale) {
          this.#controlStateValid = false;
          await this.#clearControlState("STALE_MEDIA_CONTEXT", false);
        }
      });
    }
    await this.whenIdle();
  }

  public async handlePageReady(
    tabIdInput: unknown,
    frameIdInput: unknown = 0,
    frameKeyInput: unknown = "top",
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const frameKey = MediaFrameKeySchema.parse(frameKeyInput);
    if (!this.#synchronized) {
      return;
    }
    const generation = this.#generation;
    this.#enqueue(async () => {
      const route = await this.#resolveRoute(tabId, frameId, frameKey);
      if (route === null || !this.#synchronized || generation !== this.#generation) {
        return;
      }
      this.#rememberRoute(route);
      await this.#page.observe(
        tabId,
        frameId,
        route.context,
        this.#targetForObservationRoute(route),
      );
    });
    await this.whenIdle();
  }

  public async handleMediaObserved(
    tabIdInput: unknown,
    frameIdInput: unknown,
    messageInput: unknown,
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const message = MediaObservedMessageSchema.parse(messageInput);
    if (!this.#synchronized || this.#disposed) {
      return;
    }
    const generation = this.#generation;
    const gestureKey =
      tabId === this.#activeTabId
        ? pendingGestureObservationKey(generation, tabId, frameId, message)
        : null;
    if (gestureKey !== null) {
      const pending = this.#pendingGestureObservations.get(gestureKey);
      if (pending !== undefined) {
        await pending;
        return;
      }
    }
    const operation = this.#enqueue(async () => {
      const route = await this.#resolveRoute(tabId, frameId, message.context.frameKey);
      if (
        !this.#synchronized ||
        generation !== this.#generation ||
        route === null ||
        !sameMediaContext(route.context, message.context)
      ) {
        return;
      }
      const leaderAuthorityToken =
        message.applyToken === null
          ? undefined
          : this.#leaderAuthorityTokens.get(message.applyToken);
      if (leaderAuthorityToken !== undefined && message.applyToken !== null) {
        await this.#handleLeaderAuthorityToken(
          route,
          message,
          message.applyToken,
          leaderAuthorityToken,
        );
        return;
      }
      const taggedControllerApply = this.#follower.matchesApplyToken(message.applyToken);
      if (tabId !== this.#activeTabId) {
        if (!taggedControllerApply) {
          return;
        }
        if (message.event === "APPLY_RESULT") {
          this.#follower.markApplyResult(message.applyToken);
          if (message.target !== null && message.observed !== null) {
            this.#recordPageApplyResult(route, message.target, message.resultCode);
          }
        } else if (message.applyToken !== null) {
          this.#follower.markApplyDiscreteEvent(message.applyToken);
        }
        return;
      }
      if (message.applyToken !== null && !taggedControllerApply) {
        return;
      }
      if (message.event === "VISIBILITY_CHANGED") {
        this.#heartbeat.setPageVisibility(route, message.visibilityState);
      }
      const activeLeaderAuthorityBatch = this.#activeLeaderAuthorityBatch;
      if (activeLeaderAuthorityBatch !== null && message.applyToken === null) {
        if (this.#matchesLeaderAuthorityRoute(activeLeaderAuthorityBatch, route, message.target)) {
          return;
        }
        this.#cancelLeaderAuthorityBatch(true);
      } else if (
        activeLeaderAuthorityBatch !== null &&
        taggedControllerApply &&
        message.applyToken !== null
      ) {
        if (message.event === "APPLY_RESULT") {
          this.#follower.markApplyResult(message.applyToken);
        } else {
          this.#follower.markApplyDiscreteEvent(message.applyToken);
        }
        return;
      }
      if (message.event === "APPLY_RESULT" && taggedControllerApply) {
        this.#follower.markApplyResult(message.applyToken);
      }
      if (message.target === null || message.observed === null) {
        await this.#clearControlState(message.resultCode, false);
        return;
      }
      this.#localObservation = {
        ...route,
        target: structuredClone(message.target),
        observed: structuredClone(message.observed),
      };
      if (message.event === "APPLY_RESULT") {
        if (taggedControllerApply) {
          this.#recordPageApplyResult(route, message.target, message.resultCode);
          const leaderGroup = this.#currentLeaderGroup();
          if (
            message.resultCode === null &&
            leaderGroup !== undefined &&
            sameMediaTarget(leaderGroup.target, message.target)
          ) {
            this.#heartbeat.offerSample(this.#localObservation, true);
          }
        }
        return;
      }
      if (taggedControllerApply && message.applyToken !== null) {
        this.#follower.markApplyDiscreteEvent(message.applyToken);
        return;
      }
      const leaderGroup = this.#currentLeaderGroup();
      if (leaderGroup !== undefined && sameMediaTarget(leaderGroup.target, message.target)) {
        if (this.#follower.consumeForcedAlignment(leaderGroup.playbackGroupId)) {
          await this.#reconcileLeaderAuthority(leaderGroup, generation, true);
          return;
        }
        this.#heartbeat.offerSample(
          this.#localObservation,
          message.event === "STATE_CHANGED" || message.event === "TARGET_CHANGED",
        );
        return;
      }
      const membership = this.#currentMembership();
      if (membership === null || membership.role !== "FOLLOWER" || !membership.activeDevice) {
        await this.#follower.lock(null, null);
        return;
      }
      const group = this.#groupById(membership.playbackGroupId);
      if (group === undefined || group.target === null || group.observed === null) {
        await this.#follower.lock(null, null);
        return;
      }
      const guard = this.#generationGuard(generation);
      const matchesAuthoritativeTarget = sameMediaTarget(group.target, message.target);
      if (
        matchesAuthoritativeTarget &&
        this.#follower.consumeForcedAlignment(group.playbackGroupId)
      ) {
        await this.#reconcileFollower(group, {
          forceSeek: true,
          generation,
        });
        return;
      }
      if (message.event === "STATE_CHANGED" || message.event === "TARGET_CHANGED") {
        const action = await this.#follower.handleGesture(
          group,
          route,
          message.target,
          message.observed,
          guard,
          message.event === "STATE_CHANGED" ? (message.trigger ?? null) : null,
        );
        if (action !== null) {
          if (action.type === "SWITCH_TARGET") {
            await this.#activateExistingTarget(group.target, generation);
          }
          return;
        }
      }
      const forceSeek = !matchesAuthoritativeTarget;
      await this.#reconcileFollower(group, {
        forceSeek,
        generation,
      });
    });
    if (gestureKey === null) {
      await operation;
      return;
    }
    this.#pendingGestureObservations.set(gestureKey, operation);
    try {
      await operation;
    } finally {
      if (this.#pendingGestureObservations.get(gestureKey) === operation) {
        this.#pendingGestureObservations.delete(gestureKey);
      }
    }
  }

  public async handlePermissionBoundaryChanged(): Promise<void> {
    const realignmentGroupId =
      this.#activeLeaderAuthorityBatch?.playbackGroupId ??
      this.#currentLeaderGroup()?.playbackGroupId ??
      null;
    this.#generation += 1;
    this.#pendingGestureObservations.clear();
    await this.#clearControlState(null, false);
    if (realignmentGroupId !== null && this.#groupById(realignmentGroupId) !== undefined) {
      this.#leaderAuthorityBlockedGroupId = realignmentGroupId;
      this.#follower.setPendingForcedAlignment(realignmentGroupId);
    }
    this.#routes.clear();
    if (this.#synchronized && this.#activeTabId !== undefined) {
      const generation = this.#generation;
      this.#enqueue(() => this.#observeTopFrame(this.#activeTabId!, generation));
    }
    await this.whenIdle();
  }

  public async handlePageCapability(reportInput: PageCapabilityReport): Promise<void> {
    const report = PageCapabilityReportSchema.parse(reportInput);
    if (report.message.capability !== "MEDIA" && report.message.capability !== "PAGE_HOST") {
      return;
    }
    const routeKey = mediaRouteKey(report.tabId, report.frameId);
    const capabilityKey = mediaCapabilityKey(
      report.tabId,
      report.frameId,
      report.message.capability,
    );
    const route = this.#routes.get(routeKey);
    if (
      route === undefined ||
      !(await this.#isRouteCurrent(route)) ||
      this.#routes.get(routeKey) !== route
    ) {
      this.#pageCapabilityErrors.delete(capabilityKey);
      return;
    }
    if (report.message.state === "AVAILABLE") {
      this.#pageCapabilityErrors.delete(capabilityKey);
      return;
    }
    this.#pageCapabilityErrors.set(capabilityKey, report.message.errorCode);
    const batch = this.#activeLeaderAuthorityBatch;
    if (
      batch !== null &&
      batch.route.tabId === report.tabId &&
      batch.route.frameId === report.frameId
    ) {
      this.#cancelLeaderAuthorityBatch(true);
    }
    if (report.message.errorCode === "ORIGIN_PERMISSION_REVOKED") {
      await this.handlePermissionBoundaryChanged();
    }
  }

  public async createGroup(
    targetInput?: MediaTarget | null,
    observedInput?: MediaObservedState | null,
  ): Promise<MediaCommandAck> {
    this.#requireOnline();
    const local = this.#localObservation;
    const target =
      targetInput === undefined
        ? (local?.target ?? null)
        : MediaTargetSchema.nullable().parse(targetInput);
    const observed =
      observedInput === undefined
        ? target === null
          ? null
          : (local?.observed ?? null)
        : MediaObservedStateSchema.nullable().parse(observedInput);
    return this.#sendCommand(
      buildMediaCreateCommand({
        commandId: this.#newUuid(),
        roomId: this.#roomId,
        target,
        observed,
      }),
    );
  }

  public async joinGroup(playbackGroupId: string): Promise<MediaCommandAck> {
    const group = this.#requireGroup(playbackGroupId);
    return this.#sendExistingGroupCommand(group, {
      type: "group.join",
    });
  }

  public async leaveGroup(playbackGroupId?: string): Promise<MediaCommandAck> {
    const group = this.#requireGroup(playbackGroupId ?? this.#requireMembership().playbackGroupId);
    return this.#sendExistingGroupCommand(group, {
      type: "group.leave",
    });
  }

  public async takeOverDevice(playbackGroupId: string): Promise<MediaCommandAck> {
    const group = this.#requireGroup(playbackGroupId);
    return this.#sendExistingGroupCommand(group, {
      type: "group.takeover",
    });
  }

  public async transferLeader(
    playbackGroupId: string,
    targetUserId: string,
    targetDeviceId: string,
  ): Promise<MediaCommandAck> {
    const group = this.#requireGroup(playbackGroupId);
    return this.#sendExistingGroupCommand(group, {
      type: "group.transfer-leader",
      targetUserId: CanonicalUuidSchema.parse(targetUserId),
      targetDeviceId: DeviceIdSchema.parse(targetDeviceId),
    });
  }

  public async switchTarget(
    playbackGroupId: string,
    targetInput: MediaTarget,
    observedInput: MediaObservedState,
  ): Promise<MediaCommandAck> {
    const group = this.#requireGroup(playbackGroupId);
    return this.#sendExistingGroupCommand(group, {
      type: "group.switch-target",
      target: MediaTargetSchema.parse(targetInput),
      observed: MediaObservedStateSchema.parse(observedInput),
    });
  }

  public async closeGroup(playbackGroupId?: string): Promise<MediaCommandAck> {
    const group = this.#requireGroup(playbackGroupId ?? this.#requireMembership().playbackGroupId);
    return this.#sendExistingGroupCommand(group, {
      type: "group.close",
    });
  }

  public async propose(
    playbackGroupId: string,
    actionInput: PlaybackAction,
  ): Promise<MediaCommandAck> {
    const group = this.#requireGroup(playbackGroupId);
    return this.#sendExistingGroupCommand(group, {
      type: "proposal.create",
      action: PlaybackActionSchema.parse(actionInput),
    });
  }

  public async decide(
    playbackGroupId: string,
    proposalId: string,
    decision: "APPROVE" | "REJECT",
  ): Promise<MediaCommandAck> {
    const group = this.#requireGroup(playbackGroupId);
    return this.#sendExistingGroupCommand(group, {
      type: "proposal.decide",
      proposalId: CanonicalUuidSchema.parse(proposalId),
      decision,
    });
  }

  public async alignOnce(playbackGroupId: string): Promise<void> {
    this.#requireOnline();
    const group = this.#requireGroup(playbackGroupId);
    if (group.target === null || group.observed === null) {
      throw new MediaControllerError("MEDIA_TARGET_UNAVAILABLE");
    }
    const route = await this.#routeForTarget(group.target);
    if (route === null) {
      throw new MediaControllerError("MEDIA_TARGET_UNBOUND");
    }
    const generation = this.#generation;
    await this.#follower.apply(
      route,
      group.target,
      {
        type: "SEEK",
        positionMs: predictGroupPosition(group, this.#now()),
      },
      this.#generationGuard(generation),
    );
  }

  public async jumpToMember(userIdInput: string): Promise<void> {
    if (!this.#synchronized || this.#disposed) {
      throw new MediaControllerError("MEDIA_OFFLINE");
    }
    const userId = CanonicalUuidSchema.parse(userIdInput);
    if (this.#navigation === undefined) {
      throw new MediaControllerError("MEDIA_NAVIGATION_UNAVAILABLE");
    }
    const presence = this.#presence
      .getStatus()
      .presences.filter(
        (candidate) =>
          candidate.userId === userId &&
          candidate.logicalTabId !== null &&
          candidate.expiresAt > this.#now(),
      )
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId))[0];
    if (presence?.logicalTabId === null || presence === undefined) {
      throw new MediaControllerError("MEDIA_MEMBER_TAB_UNBOUND");
    }
    const record = await this.#replica.getRecord();
    const binding = record.bindings.find(
      (candidate) =>
        candidate.browserSessionId === this.#browserSessionId &&
        candidate.logicalTabId === presence.logicalTabId,
    );
    if (record.mode !== "SYNCED" || binding === undefined) {
      throw new MediaControllerError("MEDIA_MEMBER_TAB_UNBOUND");
    }
    await this.#navigation.activateTab(binding.tabId);
  }

  public getStatus(): MediaControllerStatus {
    const effectiveErrorCode =
      this.#currentPageCapabilityError() ?? this.#currentPageApplyError() ?? this.#errorCode;
    return projectMediaControllerStatus({
      synchronized: this.#synchronized,
      errorCode: effectiveErrorCode,
      roomMediaRevision: this.#snapshot?.roomMediaRevision ?? null,
      groups: this.#snapshot?.groups ?? [],
      localObservation:
        this.#localObservation === null
          ? null
          : {
              target: this.#localObservation.target,
              observed: this.#localObservation.observed,
            },
      controlStateValid: this.#controlStateValid,
      userId: this.#userId,
      deviceId: this.#deviceId,
      navigation: this.#navigationStatus,
      nowMs: this.#now(),
    });
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) {
      await this.whenIdle();
      return;
    }
    this.#disposed = true;
    if (this.#synchronized) {
      await this.setSynchronized(false);
    } else {
      this.#transport.setMediaHandler(undefined);
      await this.#heartbeat.stop();
    }
    await this.#follower.dispose();
    await this.#heartbeat.dispose();
    this.#activeLeaderAuthorityBatch = null;
    this.#leaderAuthorityRecoveryBatch = null;
    this.#leaderAuthorityBlockedGroupId = null;
    this.#leaderAuthorityTokens.clear();
    await this.whenIdle();
  }

  public async whenIdle(): Promise<void> {
    let observedTail: Promise<void>;
    let observedCommand: Promise<void>;
    do {
      observedTail = this.#tail;
      observedCommand = this.#commandTail;
      await Promise.all([
        observedTail,
        observedCommand,
        this.#heartbeat.whenIdle(),
        this.#follower.whenIdle(),
      ]);
    } while (observedTail !== this.#tail || observedCommand !== this.#commandTail);
  }

  async #observeTopFrame(tabId: number, generation: number): Promise<void> {
    const route = await this.#resolveRoute(tabId, 0, "top");
    if (!this.#synchronized || generation !== this.#generation) {
      return;
    }
    if (route === null) {
      this.#routes.delete(mediaRouteKey(tabId, 0));
      return;
    }
    this.#rememberRoute(route);
    await this.#page.observe(tabId, 0, route.context, this.#targetForObservationRoute(route));
  }

  async #resolveRoute(
    tabId: number,
    frameId: number,
    frameKey: string,
  ): Promise<MediaRoute | null> {
    const record = await this.#replica.getRecord();
    return resolveMediaRoute(
      record,
      this.#roomId,
      this.#browserSessionId,
      tabId,
      frameId,
      frameKey,
    );
  }

  async #acceptSnapshot(
    messageInput: MediaGroupsSnapshotMessage,
    generation: number,
  ): Promise<void> {
    const message = MediaGroupsSnapshotMessageSchema.parse(messageInput);
    if (
      message.roomId !== this.#roomId ||
      (this.#snapshot !== null && message.roomMediaRevision <= this.#snapshot.roomMediaRevision)
    ) {
      return;
    }
    const previousSnapshot = this.#snapshot;
    if (
      previousSnapshot !== null &&
      message.groups.some((group) => {
        const previous = previousSnapshot.groups.find(
          (candidate) => candidate.playbackGroupId === group.playbackGroupId,
        );
        return previous !== undefined && group.groupRevision < previous.groupRevision;
      })
    ) {
      this.#snapshot = null;
      this.#controlStateValid = false;
      await this.#clearControlState("STALE_MEDIA_SNAPSHOT", false);
      return;
    }
    const previousMembership = this.#currentMembership();
    const previousGroup =
      previousMembership === null
        ? undefined
        : previousSnapshot?.groups.find(
            (candidate) => candidate.playbackGroupId === previousMembership.playbackGroupId,
          );
    const nextMembership = deriveMediaMembership(message.groups, this.#userId, this.#deviceId);
    const nextGroup =
      nextMembership === null
        ? undefined
        : message.groups.find(
            (candidate) => candidate.playbackGroupId === nextMembership.playbackGroupId,
          );
    const expiredLeaderGraceTarget =
      previousMembership?.role === "FOLLOWER" &&
      previousMembership.activeDevice &&
      previousGroup?.status === "LEADER_GRACE" &&
      previousGroup.target !== null &&
      previousGroup.observed !== null &&
      !previousGroup.observed.paused &&
      !previousGroup.observed.ended &&
      !message.groups.some(
        (candidate) => candidate.playbackGroupId === previousMembership.playbackGroupId,
      )
        ? previousGroup.target
        : null;
    const preservesRateCorrection =
      previousMembership?.role === "FOLLOWER" &&
      previousMembership.activeDevice &&
      nextMembership?.role === "FOLLOWER" &&
      nextMembership.activeDevice &&
      previousMembership.playbackGroupId === nextMembership.playbackGroupId &&
      previousGroup !== undefined &&
      nextGroup !== undefined &&
      previousGroup.groupRevision === nextGroup.groupRevision &&
      previousGroup.target !== null &&
      nextGroup.target !== null &&
      previousGroup.observed !== null &&
      nextGroup.observed !== null &&
      previousGroup.observed.playbackRate === nextGroup.observed.playbackRate &&
      sameMediaTarget(previousGroup.target, nextGroup.target) &&
      !hasMediaAuthoritativeDiscontinuity(previousGroup, nextGroup) &&
      !hasMediaAuthoritativeSeek(previousGroup, nextGroup);
    if (!preservesRateCorrection) {
      await this.#follower.cancelRateCorrection(true);
    }
    let leaderGracePauseError: string | null = null;
    if (expiredLeaderGraceTarget !== null) {
      const route = await this.#routeForTarget(expiredLeaderGraceTarget);
      if (!this.#synchronized || generation !== this.#generation) {
        return;
      }
      if (route !== null) {
        try {
          await this.#follower.apply(
            route,
            expiredLeaderGraceTarget,
            { type: "PAUSE" },
            this.#generationGuard(generation),
          );
        } catch (cause) {
          leaderGracePauseError = errorCode(cause, "MEDIA_FOLLOWER_FAILURE");
        }
      }
    }
    this.#snapshot = structuredClone(message);
    this.#controlStateValid = true;
    this.#errorCode = leaderGracePauseError;
    await this.#refreshNavigation();
    const membership = this.#currentMembership();
    const currentGroup =
      membership === null ? undefined : this.#groupById(membership.playbackGroupId);
    if (
      membership === null ||
      currentGroup?.target === null ||
      currentGroup?.target === undefined
    ) {
      this.#targetSpecificObservation = null;
    }
    if (
      membership === null ||
      !membership.activeDevice ||
      currentGroup?.target === null ||
      currentGroup?.target === undefined ||
      currentGroup.observed === null
    ) {
      this.#cancelLeaderAuthorityBatch(false);
      this.#leaderAuthorityRecoveryBatch = null;
      this.#leaderAuthorityBlockedGroupId = null;
      this.#follower.setPendingForcedAlignment(null);
      await this.#follower.lock(null, null);
      return;
    }
    if (
      membership.role === "FOLLOWER" &&
      this.#compatibility !== undefined &&
      !this.#compatibility.canSynchronizeKnownMedia({
        target: currentGroup.target,
        remoteUserId: currentGroup.leaderUserId,
        remoteDeviceId: currentGroup.leaderDeviceId,
      })
    ) {
      this.#controlStateValid = false;
      await this.#clearControlState("MEDIA_MISMATCH", false);
      return;
    }
    const membershipChanged =
      previousMembership === null ||
      previousMembership.playbackGroupId !== membership.playbackGroupId ||
      previousMembership.role !== membership.role ||
      previousMembership.activeDevice !== membership.activeDevice ||
      previousGroup === undefined;
    const targetChanged =
      previousGroup === undefined ||
      !sameMediaTarget(previousGroup.target, currentGroup.target) ||
      previousGroup.target === null;
    const discontinuity =
      previousGroup !== undefined &&
      hasMediaAuthoritativeDiscontinuity(previousGroup, currentGroup);
    const explicitSeek =
      previousGroup !== undefined && hasMediaAuthoritativeSeek(previousGroup, currentGroup);
    const forceSeek = membershipChanged || targetChanged || discontinuity || explicitSeek;
    const authorityChanged =
      membershipChanged ||
      previousGroup === undefined ||
      hasMediaAuthorityChanged(previousGroup, currentGroup);
    if (targetChanged) {
      const activatedRoute = await this.#activateExistingTarget(currentGroup.target, generation);
      if (!this.#synchronized || generation !== this.#generation) {
        return;
      }
      if (activatedRoute === null) {
        const targetError = this.#errorCode ?? "MEDIA_TARGET_UNBOUND";
        this.#controlStateValid = false;
        await this.#clearControlState(targetError, false);
        return;
      }
    }
    if (membership.role === "LEADER") {
      await this.#follower.lock(null, null);
      if (authorityChanged) {
        this.#follower.setPendingForcedAlignment(null);
        this.#heartbeat.clearSample();
        const route = await this.#routeForTarget(currentGroup.target);
        const localAuthorityMismatch =
          route === null ||
          this.#localObservation === null ||
          !sameMediaContext(this.#localObservation.context, route.context) ||
          !sameMediaTarget(this.#localObservation.target, currentGroup.target);
        if (forceSeek && localAuthorityMismatch) {
          this.#follower.setPendingForcedAlignment(currentGroup.playbackGroupId);
        }
        await this.#reconcileLeaderAuthority(currentGroup, generation, forceSeek);
      } else if (
        previousGroup !== undefined &&
        previousGroup.groupRevision !== currentGroup.groupRevision
      ) {
        if (this.#retagLeaderAuthorityBatch(previousGroup, currentGroup)) {
          return;
        }
        if (this.#activeLeaderAuthorityBatch?.playbackGroupId === currentGroup.playbackGroupId) {
          this.#cancelLeaderAuthorityBatch(true);
          return;
        }
        this.#heartbeat.clearSample();
        if (this.#leaderAuthorityBlockedGroupId === currentGroup.playbackGroupId) {
          return;
        }
        if (
          this.#localObservation !== null &&
          sameMediaTarget(this.#localObservation.target, currentGroup.target)
        ) {
          this.#heartbeat.offerSample(this.#localObservation, false);
        }
      }
      return;
    }
    this.#cancelLeaderAuthorityBatch(false);
    this.#leaderAuthorityRecoveryBatch = null;
    this.#leaderAuthorityBlockedGroupId = null;
    if (membership.role !== "FOLLOWER") {
      this.#follower.setPendingForcedAlignment(null);
      await this.#follower.lock(null, null);
      return;
    }
    const route = await this.#routeForTarget(currentGroup.target);
    if (!this.#synchronized || generation !== this.#generation) {
      return;
    }
    if (route === null) {
      this.#controlStateValid = false;
      await this.#clearControlState("MEDIA_TARGET_UNBOUND", false);
      return;
    }
    const localTargetMismatch =
      this.#localObservation === null ||
      !sameMediaContext(this.#localObservation.context, route.context) ||
      !sameMediaTarget(this.#localObservation.target, currentGroup.target);
    if (localTargetMismatch) {
      if (forceSeek) {
        this.#follower.setPendingForcedAlignment(currentGroup.playbackGroupId);
      }
    }
    try {
      await this.#follower.lock(route, currentGroup.target, this.#generationGuard(generation));
    } catch {
      // The exact target route exists, but its page bridge can still be starting.
      // Keep forced alignment pending until handlePageReady/handleMediaObserved retries it.
      return;
    }
    if (localTargetMismatch) {
      return;
    }
    this.#follower.setPendingForcedAlignment(null);
    await this.#reconcileFollower(currentGroup, {
      forceSeek,
      generation,
    });
  }

  #currentMembership(): MediaLocalMembershipStatus | null {
    return deriveMediaMembership(this.#snapshot?.groups ?? [], this.#userId, this.#deviceId);
  }

  #groupById(playbackGroupId: string): PlaybackGroupSnapshot | undefined {
    return this.#snapshot?.groups.find(
      (candidate) => candidate.playbackGroupId === playbackGroupId,
    );
  }

  async #routeForTarget(targetInput: MediaTarget): Promise<MediaRoute | null> {
    const target = MediaTargetSchema.parse(targetInput);
    const existing = findMediaTargetRoute(this.#routes.values(), target);
    if (existing !== null && (await this.#isRouteCurrent(existing))) {
      return existing;
    }
    const record = await this.#replica.getRecord();
    const binding = record.bindings.find(
      (candidate) =>
        candidate.browserSessionId === this.#browserSessionId &&
        candidate.logicalTabId === target.logicalTabId,
    );
    if (record.mode !== "SYNCED" || binding === undefined) {
      return null;
    }
    if (target.frameKey !== "top") {
      return null;
    }
    const route = await this.#resolveRoute(binding.tabId, 0, target.frameKey);
    if (route === null || !sameMediaRevision(route.context, target)) {
      return null;
    }
    this.#rememberRoute(route);
    return route;
  }

  async #activateExistingTarget(
    target: MediaTarget,
    generation: number,
  ): Promise<MediaRoute | null> {
    const route = await this.#routeForTarget(target);
    if (!this.#synchronized || generation !== this.#generation) {
      return null;
    }
    if (route === null) {
      this.#errorCode = "MEDIA_TARGET_UNBOUND";
      return null;
    }
    this.#targetSpecificObservation = {
      route: structuredClone(route),
      target: structuredClone(target),
    };
    if (this.#activeTabId !== route.tabId) {
      if (this.#navigation === undefined) {
        this.#errorCode = "MEDIA_NAVIGATION_UNAVAILABLE";
        return null;
      }
      await this.#navigation.activateTab(route.tabId);
      if (!this.#synchronized || generation !== this.#generation) {
        return null;
      }
    }
    try {
      await this.#page.observe(route.tabId, route.frameId, route.context, target);
    } catch {
      // The exact durable tab is active but its page bridge may not be ready yet.
      // handlePageReady will observe it, and forced alignment remains pending.
    }
    return route;
  }

  #targetForObservationRoute(route: MediaRoute): MediaTarget | undefined {
    const selection = this.#targetSpecificObservation;
    return selection !== null &&
      selection.route.tabId === route.tabId &&
      selection.route.frameId === route.frameId &&
      sameMediaContext(selection.route.context, route.context)
      ? selection.target
      : undefined;
  }

  #recordPageApplyResult(route: MediaRoute, target: MediaTarget, resultCode: string | null): void {
    if (resultCode !== null) {
      this.#pageApplyError = {
        route: structuredClone(route),
        target: structuredClone(target),
        code: resultCode,
      };
      return;
    }
    const error = this.#pageApplyError;
    if (
      error !== null &&
      error.route.tabId === route.tabId &&
      error.route.frameId === route.frameId &&
      sameMediaContext(error.route.context, route.context) &&
      sameMediaTarget(error.target, target)
    ) {
      this.#pageApplyError = null;
    }
  }

  #rememberRoute(route: MediaRoute): void {
    const key = mediaRouteKey(route.tabId, route.frameId);
    const previous = this.#routes.get(key);
    if (previous !== undefined && !sameMediaContext(previous.context, route.context)) {
      this.#pageCapabilityErrors.delete(mediaCapabilityKey(route.tabId, route.frameId, "MEDIA"));
      this.#pageCapabilityErrors.delete(
        mediaCapabilityKey(route.tabId, route.frameId, "PAGE_HOST"),
      );
      if (
        this.#pageApplyError !== null &&
        this.#pageApplyError.route.tabId === route.tabId &&
        this.#pageApplyError.route.frameId === route.frameId
      ) {
        this.#pageApplyError = null;
      }
    }
    this.#routes.set(key, route);
  }

  #currentPageCapabilityError(): string | null {
    let tabId: number | undefined;
    let frameId: number | undefined;
    if (this.#localObservation !== null) {
      tabId = this.#localObservation.tabId;
      frameId = this.#localObservation.frameId;
    } else if (this.#activeTabId !== undefined) {
      tabId = this.#activeTabId;
      frameId = 0;
    }
    if (tabId === undefined || frameId === undefined) {
      return null;
    }
    return (
      this.#pageCapabilityErrors.get(mediaCapabilityKey(tabId, frameId, "MEDIA")) ??
      this.#pageCapabilityErrors.get(mediaCapabilityKey(tabId, frameId, "PAGE_HOST")) ??
      null
    );
  }

  #currentPageApplyError(): string | null {
    const error = this.#pageApplyError;
    const activeTabId = this.#activeTabId;
    const local = this.#localObservation;
    if (
      error === null ||
      activeTabId === undefined ||
      activeTabId !== error.route.tabId ||
      local === null ||
      local.tabId !== error.route.tabId ||
      local.frameId !== error.route.frameId ||
      !sameMediaContext(local.context, error.route.context) ||
      !sameMediaTarget(local.target, error.target)
    ) {
      return null;
    }
    const currentRoute = this.#routes.get(mediaRouteKey(error.route.tabId, error.route.frameId));
    return currentRoute !== undefined && sameMediaContext(currentRoute.context, error.route.context)
      ? error.code
      : null;
  }

  #currentLeaderGroup(): PlaybackGroupSnapshot | undefined {
    return findMediaLeaderGroup(
      this.#snapshot?.groups ?? [],
      this.#localObservation,
      this.#userId,
      this.#deviceId,
    );
  }

  async #reconcileFollower(
    group: PlaybackGroupSnapshot,
    options: { forceSeek: boolean; generation: number },
  ): Promise<void> {
    if (
      !this.#synchronized ||
      options.generation !== this.#generation ||
      group.target === null ||
      group.observed === null
    ) {
      return;
    }
    const membership = this.#currentMembership();
    if (
      membership?.playbackGroupId !== group.playbackGroupId ||
      membership.role !== "FOLLOWER" ||
      !membership.activeDevice
    ) {
      return;
    }
    const route = await this.#routeForTarget(group.target);
    if (route === null || !this.#synchronized || options.generation !== this.#generation) {
      return;
    }
    const local = this.#localObservation;
    if (
      local === null ||
      !sameMediaContext(local.context, route.context) ||
      !sameMediaTarget(local.target, group.target)
    ) {
      return;
    }
    await this.#follower.reconcile(
      group,
      route,
      local.target,
      local.observed,
      options.forceSeek,
      this.#generationGuard(options.generation),
    );
  }

  async #reconcileLeaderAuthority(
    group: PlaybackGroupSnapshot,
    generation: number,
    forceSeek: boolean,
  ): Promise<void> {
    if (
      !this.#synchronized ||
      generation !== this.#generation ||
      group.target === null ||
      group.observed === null
    ) {
      return;
    }
    this.#cancelLeaderAuthorityBatch(false);
    this.#follower.invalidateApplyTokens();
    this.#leaderAuthorityRecoveryBatch = null;
    this.#leaderAuthorityBlockedGroupId = null;
    const route = await this.#routeForTarget(group.target);
    const local = this.#localObservation;
    if (
      route === null ||
      local === null ||
      !this.#synchronized ||
      generation !== this.#generation ||
      !sameMediaContext(local.context, route.context) ||
      !sameMediaTarget(local.target, group.target)
    ) {
      if (this.#synchronized && generation === this.#generation) {
        this.#leaderAuthorityBlockedGroupId = group.playbackGroupId;
        this.#follower.setPendingForcedAlignment(group.playbackGroupId);
      }
      return;
    }
    const guard = this.#generationGuard(generation);
    const actions = planMediaLeaderAuthorityRestoration(
      group,
      local.target,
      local.observed,
      this.#now(),
      forceSeek,
    );
    if (actions.length === 0) {
      this.#heartbeat.offerSample(local, false);
      return;
    }
    const tokens = actions.map(() => this.#follower.reserveApplyToken());
    let resolveDeadline!: (result: false) => void;
    const deadline = new Promise<false>((resolve) => {
      resolveDeadline = resolve;
    });
    const batch: LeaderAuthorityBatch = {
      generation,
      playbackGroupId: group.playbackGroupId,
      groupRevision: group.groupRevision,
      route: structuredClone(route),
      target: structuredClone(group.target),
      tokens,
      resultObservations: Array.from<LocalObservation | undefined>({
        length: tokens.length,
      }),
      resultCount: 0,
      dispatchedCount: 0,
      deadline,
      resolveDeadline,
      deadlineHandle: null,
      recoveryObservationRequested: false,
    };
    this.#activeLeaderAuthorityBatch = batch;
    batch.deadlineHandle = this.#scheduler.setTimeout(() => {
      this.#failLeaderAuthorityBatch(batch, "MEDIA_APPLY_TIMEOUT");
    }, LEADER_AUTHORITY_BATCH_TIMEOUT_MS);
    for (const [index, applyToken] of tokens.entries()) {
      this.#rememberLeaderAuthorityToken(applyToken, {
        batch,
        index,
        applyResultSeen: false,
        discreteEventSeen: false,
      });
    }
    const batchGuard = () =>
      guard() &&
      this.#activeLeaderAuthorityBatch === batch &&
      this.#activeTabId === batch.route.tabId;
    try {
      for (const [index, action] of actions.entries()) {
        const applied = await Promise.race([
          this.#follower.apply(route, group.target, action, batchGuard, tokens[index], () => {
            batch.dispatchedCount = Math.max(batch.dispatchedCount, index + 1);
          }),
          batch.deadline,
        ]);
        if (!applied) {
          throw new MediaControllerError("STALE_MEDIA_CONTEXT");
        }
        if (this.#activeLeaderAuthorityBatch !== batch) {
          return;
        }
      }
    } catch (cause) {
      if (this.#activeLeaderAuthorityBatch === batch) {
        this.#failLeaderAuthorityBatch(batch, errorCode(cause, "MEDIA_APPLY_FAILED"));
      }
    }
  }

  async #handleLeaderAuthorityToken(
    route: MediaRoute,
    message: MediaObservedMessage,
    applyToken: string,
    tokenState: LeaderAuthorityTokenState,
  ): Promise<void> {
    if (message.event !== "APPLY_RESULT") {
      const firstDiscreteEvent = !tokenState.discreteEventSeen;
      tokenState.discreteEventSeen = true;
      this.#follower.markApplyDiscreteEvent(applyToken);
      if (
        firstDiscreteEvent &&
        this.#activeLeaderAuthorityBatch === tokenState.batch &&
        !this.#matchesLeaderAuthorityRoute(tokenState.batch, route, message.target)
      ) {
        this.#cancelLeaderAuthorityBatch(true);
      }
      if (firstDiscreteEvent) {
        await this.#requestLeaderAuthorityRecoveryObservation(
          tokenState.batch,
          route,
          message.target,
        );
      }
      return;
    }

    const firstApplyResult = !tokenState.applyResultSeen;
    tokenState.applyResultSeen = true;
    this.#follower.markApplyResult(applyToken);
    const batch = tokenState.batch;
    if (!firstApplyResult) {
      return;
    }
    if (this.#activeLeaderAuthorityBatch !== batch) {
      await this.#requestLeaderAuthorityRecoveryObservation(batch, route, message.target);
      return;
    }
    if (
      this.#activeTabId !== batch.route.tabId ||
      !this.#matchesLeaderAuthorityRoute(batch, route, message.target) ||
      message.observed === null
    ) {
      this.#failLeaderAuthorityBatch(batch, message.resultCode ?? "STALE_MEDIA_CONTEXT");
      await this.#requestLeaderAuthorityRecoveryObservation(batch, route, message.target);
      return;
    }
    if (message.resultCode !== null) {
      this.#failLeaderAuthorityBatch(batch, message.resultCode);
      await this.#requestLeaderAuthorityRecoveryObservation(batch, route, message.target);
      return;
    }
    batch.resultObservations[tokenState.index] = {
      ...structuredClone(route),
      target: structuredClone(batch.target),
      observed: structuredClone(message.observed),
    };
    batch.resultCount += 1;
    if (batch.resultCount !== batch.tokens.length) {
      return;
    }
    await this.#completeLeaderAuthorityBatch(batch);
  }

  async #requestLeaderAuthorityRecoveryObservation(
    batch: LeaderAuthorityBatch,
    route: MediaRoute,
    target: MediaTarget | null,
  ): Promise<void> {
    if (
      batch.recoveryObservationRequested ||
      !this.#canRequestLeaderAuthorityRecoveryObservation(batch, route, target)
    ) {
      return;
    }
    let routeCurrent: boolean;
    try {
      routeCurrent = await this.#isRouteCurrent(route);
    } catch (cause) {
      if (this.#canRequestLeaderAuthorityRecoveryObservation(batch, route, target)) {
        this.#errorCode = errorCode(cause, "MEDIA_OBSERVE_FAILED");
      }
      return;
    }
    if (
      !routeCurrent ||
      !this.#canRequestLeaderAuthorityRecoveryObservation(batch, route, target)
    ) {
      return;
    }
    batch.recoveryObservationRequested = true;
    try {
      await this.#page.observe(route.tabId, route.frameId, route.context, batch.target);
    } catch (cause) {
      if (this.#canRequestLeaderAuthorityRecoveryObservation(batch, route, target)) {
        this.#errorCode = errorCode(cause, "MEDIA_OBSERVE_FAILED");
      }
    }
  }

  #canRequestLeaderAuthorityRecoveryObservation(
    batch: LeaderAuthorityBatch,
    route: MediaRoute,
    target: MediaTarget | null,
  ): boolean {
    if (
      this.#activeLeaderAuthorityBatch !== null ||
      this.#leaderAuthorityRecoveryBatch !== batch ||
      this.#leaderAuthorityBlockedGroupId !== batch.playbackGroupId ||
      !this.#synchronized ||
      this.#disposed ||
      batch.generation !== this.#generation ||
      this.#activeTabId !== batch.route.tabId ||
      !this.#matchesLeaderAuthorityRoute(batch, route, target)
    ) {
      return false;
    }
    const membership = this.#currentMembership();
    const group = this.#groupById(batch.playbackGroupId);
    return (
      membership?.playbackGroupId === batch.playbackGroupId &&
      membership.role === "LEADER" &&
      membership.activeDevice &&
      group?.groupRevision === batch.groupRevision &&
      group?.target !== null &&
      group?.target !== undefined &&
      group.observed !== null &&
      sameMediaTarget(group.target, batch.target)
    );
  }

  async #completeLeaderAuthorityBatch(batch: LeaderAuthorityBatch): Promise<void> {
    const finalObservation = batch.resultObservations.at(-1);
    if (
      finalObservation === undefined ||
      !this.#isLeaderAuthorityBatchCurrent(batch) ||
      !(await this.#isRouteCurrent(batch.route)) ||
      !this.#isLeaderAuthorityBatchCurrent(batch)
    ) {
      this.#cancelLeaderAuthorityBatch(true);
      return;
    }
    this.#settleLeaderAuthorityBatchDeadline(batch);
    this.#activeLeaderAuthorityBatch = null;
    this.#leaderAuthorityRecoveryBatch = null;
    this.#leaderAuthorityBlockedGroupId = null;
    this.#follower.setPendingForcedAlignment(null);
    this.#localObservation = structuredClone(finalObservation);
    this.#recordPageApplyResult(batch.route, batch.target, null);
    this.#heartbeat.offerSample(this.#localObservation, true);
  }

  #isLeaderAuthorityBatchCurrent(batch: LeaderAuthorityBatch): boolean {
    if (
      this.#activeLeaderAuthorityBatch !== batch ||
      !this.#synchronized ||
      this.#disposed ||
      batch.generation !== this.#generation ||
      this.#activeTabId !== batch.route.tabId
    ) {
      return false;
    }
    const membership = this.#currentMembership();
    const group = this.#groupById(batch.playbackGroupId);
    return (
      membership?.playbackGroupId === batch.playbackGroupId &&
      membership.role === "LEADER" &&
      membership.activeDevice &&
      group?.groupRevision === batch.groupRevision &&
      group.target !== null &&
      sameMediaTarget(group.target, batch.target)
    );
  }

  #matchesLeaderAuthorityRoute(
    batch: LeaderAuthorityBatch,
    route: MediaRoute,
    target: MediaTarget | null,
  ): boolean {
    return (
      target !== null &&
      route.tabId === batch.route.tabId &&
      route.frameId === batch.route.frameId &&
      sameMediaContext(route.context, batch.route.context) &&
      sameMediaTarget(target, batch.target)
    );
  }

  #failLeaderAuthorityBatch(batch: LeaderAuthorityBatch, failureCode: string): void {
    if (this.#activeLeaderAuthorityBatch !== batch) {
      return;
    }
    this.#settleLeaderAuthorityBatchDeadline(batch);
    this.#releaseUndispatchedLeaderAuthorityTokens(batch);
    this.#activeLeaderAuthorityBatch = null;
    this.#leaderAuthorityRecoveryBatch = batch;
    this.#leaderAuthorityBlockedGroupId = batch.playbackGroupId;
    this.#follower.setPendingForcedAlignment(batch.playbackGroupId);
    this.#heartbeat.clearSample();
    this.#recordPageApplyResult(batch.route, batch.target, failureCode);
  }

  #cancelLeaderAuthorityBatch(waitForRealignment: boolean): void {
    const batch = this.#activeLeaderAuthorityBatch;
    if (batch === null) {
      if (!waitForRealignment) {
        this.#leaderAuthorityRecoveryBatch = null;
      }
      return;
    }
    this.#settleLeaderAuthorityBatchDeadline(batch);
    this.#releaseUndispatchedLeaderAuthorityTokens(batch);
    this.#activeLeaderAuthorityBatch = null;
    this.#leaderAuthorityRecoveryBatch = waitForRealignment ? batch : null;
    this.#heartbeat.clearSample();
    if (waitForRealignment) {
      this.#leaderAuthorityBlockedGroupId = batch.playbackGroupId;
      this.#follower.setPendingForcedAlignment(batch.playbackGroupId);
    }
  }

  #retagLeaderAuthorityBatch(
    previousGroup: PlaybackGroupSnapshot,
    currentGroup: PlaybackGroupSnapshot,
  ): boolean {
    const batch = this.#activeLeaderAuthorityBatch;
    if (
      batch === null ||
      batch.playbackGroupId !== currentGroup.playbackGroupId ||
      batch.groupRevision !== previousGroup.groupRevision ||
      currentGroup.target === null ||
      !sameMediaTarget(batch.target, currentGroup.target) ||
      !hasSameMediaAuthorityTimeline(previousGroup, currentGroup)
    ) {
      return false;
    }
    batch.groupRevision = currentGroup.groupRevision;
    return true;
  }

  #rememberLeaderAuthorityToken(applyToken: string, tokenState: LeaderAuthorityTokenState): void {
    while (this.#leaderAuthorityTokens.size >= MAX_LEADER_AUTHORITY_TOKENS) {
      const oldest = this.#leaderAuthorityTokens.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#leaderAuthorityTokens.delete(oldest);
    }
    this.#leaderAuthorityTokens.set(applyToken, tokenState);
  }

  #clearLeaderAuthorityBatchDeadline(batch: LeaderAuthorityBatch): void {
    if (batch.deadlineHandle === null) {
      return;
    }
    this.#scheduler.clearTimeout(batch.deadlineHandle);
    batch.deadlineHandle = null;
  }

  #settleLeaderAuthorityBatchDeadline(batch: LeaderAuthorityBatch): void {
    this.#clearLeaderAuthorityBatchDeadline(batch);
    batch.resolveDeadline(false);
  }

  #releaseUndispatchedLeaderAuthorityTokens(batch: LeaderAuthorityBatch): void {
    for (let index = batch.dispatchedCount; index < batch.tokens.length; index += 1) {
      const applyToken = batch.tokens.at(index);
      if (applyToken === undefined) {
        continue;
      }
      const tokenState = this.#leaderAuthorityTokens.get(applyToken);
      if (tokenState?.batch === batch) {
        this.#leaderAuthorityTokens.delete(applyToken);
      }
      this.#follower.releaseApplyToken(applyToken);
    }
  }

  async #clearControlState(error: string | null, preserveObservation: boolean): Promise<void> {
    this.#cancelLeaderAuthorityBatch(false);
    this.#leaderAuthorityRecoveryBatch = null;
    this.#leaderAuthorityBlockedGroupId = null;
    await this.#follower.clear();
    this.#heartbeat.clearSample();
    if (!preserveObservation) {
      this.#localObservation = null;
      this.#pageApplyError = null;
      this.#targetSpecificObservation = null;
    }
    this.#errorCode = error;
  }

  #requireOnline(): void {
    if (!this.#synchronized || this.#disposed) {
      throw new MediaControllerError("MEDIA_OFFLINE");
    }
    if (this.#snapshot === null || !this.#controlStateValid) {
      throw new MediaControllerError("MEDIA_SNAPSHOT_REQUIRED");
    }
  }

  #requireGroup(playbackGroupIdInput: string): PlaybackGroupSnapshot {
    this.#requireOnline();
    const playbackGroupId = CanonicalUuidSchema.parse(playbackGroupIdInput);
    const group = this.#groupById(playbackGroupId);
    if (group === undefined) {
      throw new MediaControllerError("GROUP_NOT_FOUND");
    }
    return group;
  }

  #requireMembership(): MediaLocalMembershipStatus {
    const membership = this.#currentMembership();
    if (membership === null) {
      throw new MediaControllerError("NOT_GROUP_MEMBER");
    }
    return membership;
  }

  #newUuid(): string {
    return CanonicalUuidSchema.parse(this.#createUuid());
  }

  #sendExistingGroupCommand(
    group: PlaybackGroupSnapshot,
    payload: ExistingMediaCommandPayload,
  ): Promise<MediaCommandAck> {
    const command = buildExistingMediaCommand({
      commandId: this.#newUuid(),
      roomId: this.#roomId,
      group,
      payload,
    });
    return this.#sendCommand(command);
  }

  #sendCommand(commandInput: MediaCommand): Promise<MediaCommandAck> {
    this.#requireOnline();
    const command = commandInput;
    const generation = this.#generation;
    const operation = (async (): Promise<MediaCommandAck> => {
      let acknowledgement: MediaCommandAck;
      try {
        acknowledgement = await this.#transport.sendMediaCommand(command);
      } catch (cause) {
        if (!this.#synchronized || generation !== this.#generation) {
          throw new MediaControllerError("MEDIA_OFFLINE", { cause });
        }
        throw new MediaControllerError(errorCode(cause, "MEDIA_COMMAND_FAILED"), {
          cause,
        });
      }
      if (!this.#synchronized || generation !== this.#generation) {
        throw new MediaControllerError("MEDIA_OFFLINE");
      }
      const currentRoomRevision = this.#snapshot?.roomMediaRevision ?? 0;
      const currentGroup =
        acknowledgement.playbackGroupId === null
          ? undefined
          : this.#groupById(acknowledgement.playbackGroupId);
      if (
        !isCurrentMediaCommandAck({
          command,
          acknowledgement,
          roomId: this.#roomId,
          currentRoomRevision,
          currentGroupRevision: currentGroup?.groupRevision ?? null,
        })
      ) {
        throw new MediaControllerError("STALE_MEDIA_ACK");
      }
      if (!acknowledgement.accepted) {
        throw new MediaControllerError(acknowledgement.code);
      }
      return acknowledgement;
    })();
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#commandTail = Promise.all([this.#commandTail, settled]).then(() => undefined);
    return operation;
  }

  async #refreshNavigation(): Promise<void> {
    const record = await this.#replica.getRecord();
    this.#navigationStatus = projectMediaNavigation(
      record,
      this.#presence.getStatus().presences,
      this.#browserSessionId,
      this.#now(),
      this.#navigation !== undefined,
    );
  }

  async #isRouteCurrent(route: MediaRoute): Promise<boolean> {
    const current = await this.#resolveRoute(route.tabId, route.frameId, route.context.frameKey);
    return current !== null && sameMediaContext(current.context, route.context);
  }

  #generationGuard(generation: number): () => boolean {
    return () => this.#synchronized && !this.#disposed && generation === this.#generation;
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(work);
    this.#tail = result.catch((cause) => {
      if (this.#synchronized) {
        this.#errorCode = errorCode(cause, "MEDIA_CONTROLLER_FAILURE");
      }
    });
    return this.#tail;
  }
}

function hasMediaAuthorityChanged(
  previous: PlaybackGroupSnapshot,
  current: PlaybackGroupSnapshot,
): boolean {
  if (
    current.target === null ||
    current.observed === null ||
    !sameMediaTarget(previous.target, current.target) ||
    previous.observed === null
  ) {
    return true;
  }
  return (
    previous.status !== current.status ||
    previous.observed.paused !== current.observed.paused ||
    previous.observed.playbackRate !== current.observed.playbackRate ||
    previous.observed.ended !== current.observed.ended ||
    previous.observed.buffering !== current.observed.buffering ||
    hasMediaAuthoritativeSeek(previous, current) ||
    hasMediaAuthoritativeDiscontinuity(previous, current)
  );
}

function hasSameMediaAuthorityTimeline(
  previous: PlaybackGroupSnapshot,
  current: PlaybackGroupSnapshot,
): boolean {
  if (
    previous.target === null ||
    current.target === null ||
    previous.observed === null ||
    current.observed === null ||
    current.observedAtServerMs === null ||
    !sameMediaTarget(previous.target, current.target)
  ) {
    return false;
  }
  return (
    previous.status === current.status &&
    previous.observed.paused === current.observed.paused &&
    previous.observed.playbackRate === current.observed.playbackRate &&
    previous.observed.ended === current.observed.ended &&
    previous.observed.buffering === current.observed.buffering &&
    predictGroupPosition(previous, current.observedAtServerMs) === current.observed.positionMs
  );
}

function errorCode(cause: unknown, fallback: string): string {
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

function mediaCapabilityKey(
  tabId: number,
  frameId: number,
  capability: "MEDIA" | "PAGE_HOST",
): string {
  return `${mediaRouteKey(tabId, frameId)}:${capability}`;
}

function pendingGestureObservationKey(
  generation: number,
  tabId: number,
  frameId: number,
  message: MediaObservedMessage,
): string | null {
  if (
    message.applyToken !== null ||
    (message.event !== "STATE_CHANGED" && message.event !== "TARGET_CHANGED") ||
    message.target === null ||
    message.observed === null
  ) {
    return null;
  }
  return JSON.stringify([
    generation,
    tabId,
    frameId,
    message.event,
    message.event === "STATE_CHANGED" ? (message.trigger ?? null) : null,
    message.context.roomId,
    message.context.logicalTabId,
    message.context.documentRevision.roomEpoch,
    message.context.documentRevision.tabUpdatedAtSeq,
    message.context.frameKey,
    message.target.logicalTabId,
    message.target.documentRevision.roomEpoch,
    message.target.documentRevision.tabUpdatedAtSeq,
    message.target.frameKey,
    message.target.provider,
    message.target.mediaKey,
    message.target.durationMs,
    message.observed.observedAtClientMs,
    message.observed.positionMs,
    message.observed.paused,
    message.observed.playbackRate,
    message.observed.ended,
    message.observed.buffering,
  ]);
}
