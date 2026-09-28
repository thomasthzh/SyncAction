import type { MediaTarget, PlaybackGroupSnapshot } from "@syncaction/protocol";

function sameDocument(left: MediaTarget, right: MediaTarget): boolean {
  return (
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey
  );
}

export function targetsMatchForRecommendation(left: MediaTarget, right: MediaTarget): boolean {
  if (left.provider !== right.provider || left.mediaKey !== right.mediaKey) {
    return false;
  }
  return left.provider === "HTML5" ? sameDocument(left, right) : true;
}

export function predictGroupPosition(group: PlaybackGroupSnapshot, nowMs: number): number {
  if (group.target === null || group.observed === null || group.observedAtServerMs === null) {
    return 0;
  }

  const elapsedMs = Math.max(0, nowMs - group.observedAtServerMs);
  const advances =
    group.status === "PLAYING" &&
    !group.observed.paused &&
    !group.observed.ended &&
    !group.observed.buffering;
  const predicted = advances
    ? group.observed.positionMs + elapsedMs * group.observed.playbackRate
    : group.observed.positionMs;
  return Math.min(group.target.durationMs, Math.max(0, predicted));
}

export function recommendGroup(
  groups: readonly PlaybackGroupSnapshot[],
  localTarget: MediaTarget,
  nowMs: number,
): PlaybackGroupSnapshot | undefined {
  return groups
    .filter(
      (group) =>
        group.status !== "IDLE" &&
        group.status !== "LEADER_GRACE" &&
        group.target !== null &&
        targetsMatchForRecommendation(group.target, localTarget),
    )
    .map((group) => ({
      group,
      onlineMemberCount: group.members.filter((member) => member.online).length,
      predictedPositionMs: predictGroupPosition(group, nowMs),
    }))
    .filter((candidate) => candidate.onlineMemberCount > 0)
    .sort(
      (left, right) =>
        right.onlineMemberCount - left.onlineMemberCount ||
        right.predictedPositionMs - left.predictedPositionMs ||
        left.group.playbackGroupId.localeCompare(right.group.playbackGroupId),
    )[0]?.group;
}
