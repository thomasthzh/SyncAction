import { planCorrection, predictGroupPosition } from "@syncaction/media";
import type {
  MediaObservedState,
  MediaTarget,
  PlaybackAction,
  PlaybackGroupSnapshot,
} from "@syncaction/protocol";
import type { MediaObservedTrigger, MediaPageApplyAction } from "./page-collaboration/messages.js";
import { sameMediaTarget } from "./media-controller-model.js";

export interface MediaRateRestorePlan {
  playbackRate: number;
  durationMs: number;
}

export interface MediaFollowerCorrectionPlan {
  actions: MediaPageApplyAction[];
  rateRestore: MediaRateRestorePlan | null;
}

export function predictMediaObservation(
  observed: MediaObservedState,
  target: MediaTarget,
  nowMs: number,
): MediaObservedState {
  const advances = !observed.paused && !observed.ended && !observed.buffering;
  const elapsedMs = Math.max(0, nowMs - observed.observedAtClientMs);
  return {
    ...observed,
    observedAtClientMs: nowMs,
    positionMs: Math.min(
      target.durationMs,
      Math.max(0, observed.positionMs + (advances ? elapsedMs * observed.playbackRate : 0)),
    ),
  };
}

export function inferMediaFollowerAction(
  group: PlaybackGroupSnapshot,
  localTarget: MediaTarget,
  localObserved: MediaObservedState,
  nowMs: number,
  trigger: MediaObservedTrigger | null = null,
): PlaybackAction | null {
  if (group.target === null || group.observed === null) {
    return null;
  }
  if (!sameMediaTarget(group.target, localTarget)) {
    return {
      type: "SWITCH_TARGET",
      target: localTarget,
      observed: localObserved,
    };
  }
  if (trigger === "SEEKED") {
    return {
      type: "SEEK",
      positionMs: predictMediaObservation(localObserved, localTarget, nowMs).positionMs,
    };
  }
  if (localObserved.paused !== group.observed.paused) {
    return { type: localObserved.paused ? "PAUSE" : "PLAY" };
  }
  if (localObserved.playbackRate !== group.observed.playbackRate) {
    return {
      type: "SET_RATE",
      playbackRate: localObserved.playbackRate,
    };
  }
  const leaderPosition = predictGroupPosition(group, nowMs);
  const localPosition = predictMediaObservation(localObserved, localTarget, nowMs).positionMs;
  if (Math.abs(leaderPosition - localPosition) >= 300) {
    return {
      type: "SEEK",
      positionMs: localPosition,
    };
  }
  return null;
}

export function planMediaFollowerCorrection(
  group: PlaybackGroupSnapshot,
  localTarget: MediaTarget,
  localObserved: MediaObservedState,
  nowMs: number,
  forceSeekInput: boolean,
): MediaFollowerCorrectionPlan {
  if (group.target === null || group.observed === null) {
    return { actions: [], rateRestore: null };
  }
  const leaderPositionMs = predictGroupPosition(group, nowMs);
  const localNow = predictMediaObservation(localObserved, localTarget, nowMs);
  const forceSeek =
    forceSeekInput ||
    group.observed.paused ||
    group.observed.ended ||
    group.status === "ENDED_WAITING";
  const actions: MediaPageApplyAction[] = [];
  let rateRestore: MediaRateRestorePlan | null = null;

  if (forceSeek) {
    actions.push({ type: "SEEK", positionMs: leaderPositionMs });
    if (localNow.playbackRate !== group.observed.playbackRate) {
      actions.push({
        type: "SET_RATE",
        playbackRate: group.observed.playbackRate,
      });
    }
  } else {
    const correction = planCorrection({
      driftMs: leaderPositionMs - localNow.positionMs,
      leaderRate: group.observed.playbackRate,
    });
    if (correction.kind === "SEEK") {
      actions.push({ type: "SEEK", positionMs: leaderPositionMs });
    } else if (correction.kind === "RATE") {
      actions.push({
        type: "SET_RATE_TEMPORARY",
        playbackRate: correction.playbackRate,
        restoreRate: correction.restoreRate,
        durationMs: correction.durationMs,
      });
      rateRestore = {
        playbackRate: correction.restoreRate,
        durationMs: correction.durationMs,
      };
    } else if (localNow.playbackRate !== group.observed.playbackRate) {
      actions.push({
        type: "SET_RATE",
        playbackRate: group.observed.playbackRate,
      });
    }
  }

  if (group.observed.paused || group.observed.ended) {
    if (!localNow.paused) {
      actions.push({ type: "PAUSE" });
    }
  } else if (localNow.paused) {
    actions.push({ type: "PLAY" });
  }
  return { actions, rateRestore };
}

export function planMediaLeaderAuthorityRestoration(
  group: PlaybackGroupSnapshot,
  localTarget: MediaTarget,
  localObserved: MediaObservedState,
  nowMs: number,
  forceSeekInput: boolean,
): MediaPageApplyAction[] {
  if (group.target === null || group.observed === null) {
    return [];
  }
  const leaderPositionMs = predictGroupPosition(group, nowMs);
  const localNow = predictMediaObservation(localObserved, localTarget, nowMs);
  const driftMs = leaderPositionMs - localNow.positionMs;
  const forceSeek =
    forceSeekInput ||
    group.observed.paused ||
    group.observed.ended ||
    group.status === "ENDED_WAITING" ||
    Math.abs(driftMs) >= 300;
  const actions: MediaPageApplyAction[] = [];

  if (forceSeek) {
    actions.push({ type: "SEEK", positionMs: leaderPositionMs });
  }
  if (localNow.playbackRate !== group.observed.playbackRate) {
    actions.push({
      type: "SET_RATE",
      playbackRate: group.observed.playbackRate,
    });
  }
  if (group.observed.paused || group.observed.ended) {
    if (!localNow.paused) {
      actions.push({ type: "PAUSE" });
    }
  } else if (localNow.paused) {
    actions.push({ type: "PLAY" });
  }
  return actions;
}

export function hasMediaAuthoritativeDiscontinuity(
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
    Math.abs(
      predictGroupPosition(previous, current.observedAtServerMs) - current.observed.positionMs,
    ) >= 300
  );
}

export function hasMediaAuthoritativeSeek(
  previous: PlaybackGroupSnapshot,
  current: PlaybackGroupSnapshot,
): boolean {
  if (
    current.groupRevision <= previous.groupRevision ||
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
    Math.abs(
      predictGroupPosition(previous, current.observedAtServerMs) - current.observed.positionMs,
    ) >= 1
  );
}
