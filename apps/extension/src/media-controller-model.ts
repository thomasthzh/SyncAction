import { recommendGroup } from "@syncaction/media";
import type {
  MediaObservedState,
  MediaTarget,
  PlaybackGroupSnapshot,
  RoomId,
} from "@syncaction/protocol";
import type { ReplicaRecord } from "@syncaction/replica";
import type { ActiveTabPresenceStatus } from "./active-tab-presence.js";
import type { MediaPageContext } from "./page-collaboration/messages.js";

export interface MediaRoute {
  tabId: number;
  frameId: number;
  context: MediaPageContext;
}

export interface MediaLocalObservationView {
  target: MediaTarget;
  observed: MediaObservedState;
}

export interface MediaLocalMembershipStatus {
  playbackGroupId: string;
  role: "LEADER" | "FOLLOWER" | "READ_ONLY";
  activeDevice: boolean;
}

export interface MediaNavigationStatus {
  userId: string;
  deviceId: string;
  logicalTabId: string | null;
  canJump: boolean;
  disabledReason: string | null;
}

export interface MediaControllerStatus {
  state: "OFFLINE" | "ONLINE" | "DEGRADED";
  roomMediaRevision: number | null;
  playbackGroups: PlaybackGroupSnapshot[];
  localObservation: MediaLocalObservationView | null;
  localMembership: MediaLocalMembershipStatus | null;
  recommendedPlaybackGroupId: string | null;
  navigation: MediaNavigationStatus[];
  errorCode: string | null;
}

export function resolveMediaRoute(
  record: ReplicaRecord,
  roomId: RoomId,
  browserSessionId: string,
  tabId: number,
  frameId: number,
  frameKey: string,
): MediaRoute | null {
  const snapshot = record.confirmedSnapshot;
  if (record.mode !== "SYNCED" || snapshot === null || snapshot.roomId !== roomId) {
    return null;
  }
  const binding = record.bindings.find(
    (candidate) => candidate.browserSessionId === browserSessionId && candidate.tabId === tabId,
  );
  if (binding === undefined) {
    return null;
  }
  const tab = snapshot.tabs.find(
    (candidate) =>
      candidate.id === binding.logicalTabId &&
      candidate.closedAtSeq === null &&
      snapshot.order.includes(candidate.id),
  );
  if (tab === undefined) {
    return null;
  }
  return {
    tabId,
    frameId,
    context: {
      roomId,
      logicalTabId: tab.id,
      documentRevision: {
        roomEpoch: snapshot.roomEpoch,
        tabUpdatedAtSeq: tab.updatedAtSeq,
      },
      frameKey,
    },
  };
}

export function findMediaTargetRoute(
  routes: Iterable<MediaRoute>,
  target: MediaTarget,
): MediaRoute | null {
  return (
    [...routes].find(
      (route) =>
        route.context.logicalTabId === target.logicalTabId &&
        route.context.frameKey === target.frameKey &&
        sameMediaRevision(route.context, target),
    ) ?? null
  );
}

export function deriveMediaMembership(
  groups: PlaybackGroupSnapshot[],
  userId: string,
  deviceId: string,
): MediaLocalMembershipStatus | null {
  const group = groups.find((candidate) =>
    candidate.members.some((member) => member.userId === userId),
  );
  if (group === undefined) {
    return null;
  }
  const member = group.members.find((candidate) => candidate.userId === userId)!;
  const activeDevice = member.activeDeviceId === deviceId;
  const role: MediaLocalMembershipStatus["role"] = !activeDevice
    ? "READ_ONLY"
    : group.leaderUserId === userId && group.leaderDeviceId === deviceId
      ? "LEADER"
      : "FOLLOWER";
  return {
    playbackGroupId: group.playbackGroupId,
    role,
    activeDevice,
  };
}

export function findMediaLeaderGroup(
  groups: PlaybackGroupSnapshot[],
  observation: MediaLocalObservationView | null,
  userId: string,
  deviceId: string,
): PlaybackGroupSnapshot | undefined {
  if (observation === null) {
    return undefined;
  }
  return groups.find(
    (group) =>
      group.leaderUserId === userId &&
      group.leaderDeviceId === deviceId &&
      group.target !== null &&
      sameMediaTarget(group.target, observation.target),
  );
}

export function projectMediaNavigation(
  record: ReplicaRecord,
  presences: ActiveTabPresenceStatus["presences"],
  browserSessionId: string,
  nowMs: number,
  navigationAvailable: boolean,
): MediaNavigationStatus[] {
  const bindings = new Map(
    record.bindings
      .filter((candidate) => candidate.browserSessionId === browserSessionId)
      .map((candidate) => [candidate.logicalTabId, candidate]),
  );
  return presences
    .filter((presence) => presence.expiresAt > nowMs)
    .map((presence) => {
      const binding =
        presence.logicalTabId === null ? undefined : bindings.get(presence.logicalTabId);
      const canJump = record.mode === "SYNCED" && navigationAvailable && binding !== undefined;
      return {
        userId: presence.userId,
        deviceId: presence.deviceId,
        logicalTabId: presence.logicalTabId,
        canJump,
        disabledReason: canJump ? null : "MEDIA_MEMBER_TAB_UNBOUND",
      };
    })
    .sort(
      (left, right) =>
        left.userId.localeCompare(right.userId) || left.deviceId.localeCompare(right.deviceId),
    );
}

export function projectMediaControllerStatus(input: {
  synchronized: boolean;
  errorCode: string | null;
  roomMediaRevision: number | null;
  groups: PlaybackGroupSnapshot[];
  localObservation: MediaLocalObservationView | null;
  controlStateValid: boolean;
  userId: string;
  deviceId: string;
  navigation: MediaNavigationStatus[];
  nowMs: number;
}): MediaControllerStatus {
  const membership = input.controlStateValid
    ? deriveMediaMembership(input.groups, input.userId, input.deviceId)
    : null;
  const recommendation =
    input.controlStateValid && membership === null && input.localObservation !== null
      ? recommendGroup(input.groups, input.localObservation.target, input.nowMs)
      : undefined;
  return {
    state: !input.synchronized ? "OFFLINE" : input.errorCode === null ? "ONLINE" : "DEGRADED",
    roomMediaRevision: input.roomMediaRevision,
    playbackGroups: structuredClone(input.groups),
    localObservation:
      input.localObservation === null ? null : structuredClone(input.localObservation),
    localMembership: membership,
    recommendedPlaybackGroupId: recommendation?.playbackGroupId ?? null,
    navigation: structuredClone(input.navigation),
    errorCode: input.errorCode,
  };
}

export function sameMediaRevision(context: MediaPageContext, target: MediaTarget): boolean {
  return (
    context.logicalTabId === target.logicalTabId &&
    context.documentRevision.roomEpoch === target.documentRevision.roomEpoch &&
    context.documentRevision.tabUpdatedAtSeq === target.documentRevision.tabUpdatedAtSeq &&
    context.frameKey === target.frameKey
  );
}

export function sameMediaContext(left: MediaPageContext, right: MediaPageContext): boolean {
  return (
    left.roomId === right.roomId &&
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey
  );
}

export function sameMediaTarget(left: MediaTarget | null, right: MediaTarget): boolean {
  return (
    left !== null &&
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey &&
    left.provider === right.provider &&
    left.mediaKey === right.mediaKey &&
    left.durationMs === right.durationMs
  );
}

export function mediaRouteKey(tabId: number, frameId: number): string {
  return `${String(tabId)}:${String(frameId)}`;
}
