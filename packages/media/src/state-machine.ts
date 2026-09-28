import type {
  MediaCommand,
  MediaErrorCode,
  MediaHeartbeat,
  MediaObservedState,
  MediaTarget,
  PlaybackAction,
  PlaybackGroupMember,
  PlaybackGroupSnapshot,
  PlaybackGroupStatus,
  PlaybackProposal,
} from "@syncaction/protocol";
import { predictGroupPosition } from "./recommendation.js";
import type {
  MediaActor,
  MediaDomainEvent,
  MediaStateChange,
  MediaTransition,
  RoomMediaState,
} from "./model.js";

const LEADER_GRACE_MS = 10_000;
const PROPOSAL_TTL_MS = 30_000;
const MAX_GROUPS_PER_ROOM = 20;
const MAX_MEMBERS_PER_GROUP = 256;

function rejected(state: RoomMediaState, code: MediaErrorCode): MediaTransition {
  return {
    state,
    events: [],
    outcome: { ok: false, code },
  };
}

function accepted(
  state: RoomMediaState,
  events: readonly MediaDomainEvent[],
  playbackGroupId: string,
  groupRevision: number,
): MediaTransition {
  return {
    state,
    events,
    outcome: {
      ok: true,
      playbackGroupId,
      groupRevision,
    },
  };
}

function nextRoomState(
  state: RoomMediaState,
  groups: readonly PlaybackGroupSnapshot[],
): RoomMediaState {
  return {
    ...state,
    roomMediaRevision: state.roomMediaRevision + 1,
    groups,
  };
}

function replaceGroup(
  state: RoomMediaState,
  groupIndex: number,
  group: PlaybackGroupSnapshot,
): RoomMediaState {
  const groups = [...state.groups];
  groups[groupIndex] = group;
  return nextRoomState(state, groups);
}

function withoutGroup(state: RoomMediaState, groupIndex: number): RoomMediaState {
  return nextRoomState(
    state,
    state.groups.filter((_group, index) => index !== groupIndex),
  );
}

function memberForActor(
  group: PlaybackGroupSnapshot,
  actor: MediaActor,
): PlaybackGroupMember | undefined {
  return group.members.find((member) => member.userId === actor.userId);
}

function actorOwnsActiveDevice(group: PlaybackGroupSnapshot, actor: MediaActor): boolean {
  return memberForActor(group, actor)?.activeDeviceId === actor.deviceId;
}

function actorIsLeader(group: PlaybackGroupSnapshot, actor: MediaActor): boolean {
  return (
    group.leaderUserId === actor.userId &&
    group.leaderDeviceId === actor.deviceId &&
    actorOwnsActiveDevice(group, actor)
  );
}

function actorMember(actor: MediaActor, nowMs: number): PlaybackGroupMember {
  return {
    userId: actor.userId,
    username: actor.username,
    displayName: actor.displayName,
    activeDeviceId: actor.deviceId as PlaybackGroupMember["activeDeviceId"],
    joinedAtServerMs: nowMs,
    online: true,
  };
}

function statusFor(
  target: MediaTarget | null,
  observed: MediaObservedState | null,
): PlaybackGroupStatus {
  if (target === null || observed === null) {
    return "IDLE";
  }
  if (observed.ended) {
    return "ENDED_WAITING";
  }
  if (observed.buffering) {
    return "LOADING";
  }
  return observed.paused ? "PAUSED" : "PLAYING";
}

function targetsEqual(left: MediaTarget, right: MediaTarget): boolean {
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

function groupWithRevision(
  group: PlaybackGroupSnapshot,
  changes: Partial<PlaybackGroupSnapshot>,
  nowMs: number,
): PlaybackGroupSnapshot {
  return {
    ...group,
    ...changes,
    groupRevision: group.groupRevision + 1,
    updatedAtServerMs: nowMs,
  };
}

function groupWithoutRevision(
  group: PlaybackGroupSnapshot,
  changes: Partial<PlaybackGroupSnapshot>,
  nowMs: number,
): PlaybackGroupSnapshot {
  return {
    ...group,
    ...changes,
    updatedAtServerMs: nowMs,
  };
}

function currentObserved(group: PlaybackGroupSnapshot, nowMs: number): MediaObservedState | null {
  if (group.observed === null) {
    return null;
  }
  return {
    ...group.observed,
    positionMs: predictGroupPosition(group, nowMs),
  };
}

function applyApprovedAction(
  group: PlaybackGroupSnapshot,
  action: PlaybackAction,
  nowMs: number,
): PlaybackGroupSnapshot | undefined {
  if (action.type === "SWITCH_TARGET") {
    return groupWithRevision(
      group,
      {
        target: action.target,
        observed: action.observed,
        observedAtServerMs: nowMs,
        status: statusFor(action.target, action.observed),
        proposals: [],
        leaderGraceExpiresAtServerMs: null,
      },
      nowMs,
    );
  }

  if (group.target === null || group.observed === null) {
    return undefined;
  }
  const observed = currentObserved(group, nowMs);
  if (observed === null) {
    return undefined;
  }

  let nextObserved: MediaObservedState;
  switch (action.type) {
    case "PLAY":
      nextObserved = {
        ...observed,
        positionMs:
          observed.ended && observed.positionMs >= group.target.durationMs
            ? 0
            : observed.positionMs,
        paused: false,
        ended: false,
        buffering: false,
      };
      break;
    case "PAUSE":
      nextObserved = {
        ...observed,
        paused: true,
        buffering: false,
      };
      break;
    case "SEEK":
      if (action.positionMs > group.target.durationMs) {
        return undefined;
      }
      nextObserved = {
        ...observed,
        positionMs: action.positionMs,
        ended: action.positionMs >= group.target.durationMs,
        buffering: false,
      };
      break;
    case "SET_RATE":
      nextObserved = {
        ...observed,
        playbackRate: action.playbackRate,
      };
      break;
  }

  return groupWithRevision(
    group,
    {
      observed: nextObserved,
      observedAtServerMs: nowMs,
      status: statusFor(group.target, nextObserved),
      proposals: [],
      leaderGraceExpiresAtServerMs: null,
    },
    nowMs,
  );
}

function findGroupIndex(state: RoomMediaState, playbackGroupId: string): number {
  return state.groups.findIndex((group) => group.playbackGroupId === playbackGroupId);
}

function hasRoomMembership(state: RoomMediaState, userId: string): boolean {
  return state.groups.some((group) => group.members.some((member) => member.userId === userId));
}

function changeExistingGroup(
  state: RoomMediaState,
  groupIndex: number,
  group: PlaybackGroupSnapshot,
  events: readonly MediaDomainEvent[] = [
    { type: "GROUP_CHANGED", playbackGroupId: group.playbackGroupId },
  ],
): MediaTransition {
  return accepted(
    replaceGroup(state, groupIndex, group),
    events,
    group.playbackGroupId,
    group.groupRevision,
  );
}

export function applyMediaCommand(
  state: RoomMediaState,
  command: MediaCommand,
  actor: MediaActor,
  nowMs: number,
): MediaTransition {
  if (command.roomId !== state.roomId) {
    return rejected(state, "ROOM_MISMATCH");
  }

  if (command.type === "group.create") {
    if (state.groups.length >= MAX_GROUPS_PER_ROOM) {
      return rejected(state, "GROUP_LIMIT_REACHED");
    }
    if (hasRoomMembership(state, actor.userId)) {
      return rejected(state, "GROUP_MEMBERSHIP_CONFLICT");
    }

    const group: PlaybackGroupSnapshot = {
      playbackGroupId: command.commandId,
      roomId: command.roomId,
      groupRevision: 1,
      status: statusFor(command.target, command.observed),
      leaderUserId: actor.userId,
      leaderDeviceId: actor.deviceId as PlaybackGroupSnapshot["leaderDeviceId"],
      members: [actorMember(actor, nowMs)],
      target: command.target,
      observed: command.observed,
      observedAtServerMs: command.observed === null ? null : nowMs,
      proposals: [],
      leaderGraceExpiresAtServerMs: null,
      updatedAtServerMs: nowMs,
    };
    const nextState = nextRoomState(state, [...state.groups, group]);
    return accepted(
      nextState,
      [{ type: "GROUP_CREATED", playbackGroupId: group.playbackGroupId }],
      group.playbackGroupId,
      group.groupRevision,
    );
  }

  const groupIndex = findGroupIndex(state, command.playbackGroupId);
  if (groupIndex < 0) {
    return rejected(state, "GROUP_NOT_FOUND");
  }
  const group = state.groups[groupIndex]!;
  if (command.expectedGroupRevision !== group.groupRevision) {
    return rejected(state, "GROUP_REVISION_CONFLICT");
  }

  switch (command.type) {
    case "group.join": {
      if (hasRoomMembership(state, actor.userId)) {
        return rejected(state, "GROUP_MEMBERSHIP_CONFLICT");
      }
      if (group.members.length >= MAX_MEMBERS_PER_GROUP) {
        return rejected(state, "GROUP_MEMBER_LIMIT_REACHED");
      }
      const nextGroup = groupWithRevision(
        group,
        { members: [...group.members, actorMember(actor, nowMs)], proposals: [] },
        nowMs,
      );
      return changeExistingGroup(state, groupIndex, nextGroup);
    }

    case "group.takeover": {
      const member = memberForActor(group, actor);
      if (member === undefined) {
        return rejected(state, "NOT_GROUP_MEMBER");
      }
      const members = group.members.map((candidate) =>
        candidate.userId === actor.userId
          ? {
              ...candidate,
              activeDeviceId: actor.deviceId as PlaybackGroupMember["activeDeviceId"],
              online: true,
            }
          : candidate,
      );
      const resumesLeaderGrace =
        group.leaderUserId === actor.userId && group.status === "LEADER_GRACE";
      const nextGroup = groupWithRevision(
        group,
        {
          members,
          leaderDeviceId:
            group.leaderUserId === actor.userId
              ? (actor.deviceId as PlaybackGroupSnapshot["leaderDeviceId"])
              : group.leaderDeviceId,
          leaderGraceExpiresAtServerMs:
            group.leaderUserId === actor.userId ? null : group.leaderGraceExpiresAtServerMs,
          status: resumesLeaderGrace ? statusFor(group.target, group.observed) : group.status,
          observedAtServerMs:
            resumesLeaderGrace && group.observed !== null ? nowMs : group.observedAtServerMs,
          proposals: [],
        },
        nowMs,
      );
      return changeExistingGroup(state, groupIndex, nextGroup);
    }

    case "group.transfer-leader": {
      if (!actorIsLeader(group, actor)) {
        return rejected(state, "NOT_GROUP_LEADER");
      }
      const targetMember = group.members.find((member) => member.userId === command.targetUserId);
      if (
        targetMember === undefined ||
        !targetMember.online ||
        targetMember.activeDeviceId !== command.targetDeviceId
      ) {
        return rejected(state, "TARGET_MISMATCH");
      }
      const nextGroup = groupWithRevision(
        group,
        {
          leaderUserId: targetMember.userId,
          leaderDeviceId: targetMember.activeDeviceId,
          proposals: [],
          leaderGraceExpiresAtServerMs: null,
        },
        nowMs,
      );
      return changeExistingGroup(state, groupIndex, nextGroup);
    }

    case "group.switch-target": {
      if (!actorIsLeader(group, actor)) {
        return rejected(state, "NOT_GROUP_LEADER");
      }
      const nextGroup = groupWithRevision(
        group,
        {
          target: command.target,
          observed: command.observed,
          observedAtServerMs: nowMs,
          status: statusFor(command.target, command.observed),
          proposals: [],
          leaderGraceExpiresAtServerMs: null,
        },
        nowMs,
      );
      return changeExistingGroup(state, groupIndex, nextGroup);
    }

    case "group.leave": {
      if (!actorOwnsActiveDevice(group, actor)) {
        return rejected(state, "NOT_GROUP_MEMBER");
      }
      if (actorIsLeader(group, actor)) {
        const nextState = withoutGroup(state, groupIndex);
        return accepted(
          nextState,
          [
            {
              type: "GROUP_CLOSED",
              playbackGroupId: group.playbackGroupId,
              reason: "LEADER_LEFT",
            },
          ],
          group.playbackGroupId,
          group.groupRevision + 1,
        );
      }
      const members = group.members.filter((member) => member.userId !== actor.userId);
      if (members.length === 0) {
        const nextState = withoutGroup(state, groupIndex);
        return accepted(
          nextState,
          [
            {
              type: "GROUP_CLOSED",
              playbackGroupId: group.playbackGroupId,
              reason: "LAST_MEMBER_LEFT",
            },
          ],
          group.playbackGroupId,
          group.groupRevision + 1,
        );
      }
      const nextGroup = groupWithRevision(group, { members, proposals: [] }, nowMs);
      return changeExistingGroup(state, groupIndex, nextGroup);
    }

    case "group.close": {
      if (!actorIsLeader(group, actor)) {
        return rejected(state, "NOT_GROUP_LEADER");
      }
      const nextState = withoutGroup(state, groupIndex);
      return accepted(
        nextState,
        [
          {
            type: "GROUP_CLOSED",
            playbackGroupId: group.playbackGroupId,
            reason: "LEADER_CLOSED",
          },
        ],
        group.playbackGroupId,
        group.groupRevision + 1,
      );
    }

    case "proposal.create": {
      if (!actorOwnsActiveDevice(group, actor)) {
        return rejected(state, "NOT_GROUP_MEMBER");
      }
      if (actorIsLeader(group, actor)) {
        return rejected(state, "NOT_GROUP_LEADER");
      }
      if (command.action.type !== "SWITCH_TARGET" && group.target === null) {
        return rejected(state, "TARGET_MISMATCH");
      }
      if (
        command.action.type === "SEEK" &&
        group.target !== null &&
        command.action.positionMs > group.target.durationMs
      ) {
        return rejected(state, "TARGET_MISMATCH");
      }
      const proposal: PlaybackProposal = {
        proposalId: command.commandId,
        proposedByUserId: actor.userId,
        proposedByDeviceId: actor.deviceId as PlaybackProposal["proposedByDeviceId"],
        baseGroupRevision: group.groupRevision,
        action: command.action,
        createdAtServerMs: nowMs,
        expiresAtServerMs: nowMs + PROPOSAL_TTL_MS,
      };
      const nextGroup = groupWithoutRevision(
        group,
        {
          proposals: [
            ...group.proposals.filter((candidate) => candidate.proposedByUserId !== actor.userId),
            proposal,
          ],
        },
        nowMs,
      );
      return changeExistingGroup(state, groupIndex, nextGroup, [
        {
          type: "PROPOSAL_CREATED",
          playbackGroupId: group.playbackGroupId,
          proposalId: proposal.proposalId,
        },
      ]);
    }

    case "proposal.decide": {
      if (!actorIsLeader(group, actor)) {
        return rejected(state, "NOT_GROUP_LEADER");
      }
      const proposal = group.proposals.find(
        (candidate) => candidate.proposalId === command.proposalId,
      );
      if (proposal === undefined) {
        return rejected(state, "PROPOSAL_NOT_FOUND");
      }
      if (proposal.expiresAtServerMs <= nowMs) {
        return rejected(state, "PROPOSAL_EXPIRED");
      }
      if (proposal.baseGroupRevision !== group.groupRevision) {
        return rejected(state, "GROUP_REVISION_CONFLICT");
      }

      if (command.decision === "REJECT") {
        const nextGroup = groupWithoutRevision(
          group,
          {
            proposals: group.proposals.filter(
              (candidate) => candidate.proposalId !== proposal.proposalId,
            ),
          },
          nowMs,
        );
        return changeExistingGroup(state, groupIndex, nextGroup, [
          {
            type: "PROPOSAL_DECIDED",
            playbackGroupId: group.playbackGroupId,
            proposalId: proposal.proposalId,
            decision: "REJECT",
          },
        ]);
      }

      const approvedGroup = applyApprovedAction(group, proposal.action, nowMs);
      if (approvedGroup === undefined) {
        return rejected(state, "TARGET_MISMATCH");
      }
      return changeExistingGroup(state, groupIndex, approvedGroup, [
        {
          type: "PROPOSAL_DECIDED",
          playbackGroupId: group.playbackGroupId,
          proposalId: proposal.proposalId,
          decision: "APPROVE",
        },
      ]);
    }
  }
}

export function applyLeaderHeartbeat(
  state: RoomMediaState,
  heartbeat: MediaHeartbeat,
  actor: MediaActor,
  nowMs: number,
): MediaTransition {
  if (heartbeat.roomId !== state.roomId) {
    return rejected(state, "ROOM_MISMATCH");
  }
  const groupIndex = findGroupIndex(state, heartbeat.playbackGroupId);
  if (groupIndex < 0) {
    return rejected(state, "GROUP_NOT_FOUND");
  }
  const group = state.groups[groupIndex]!;
  if (heartbeat.groupRevision !== group.groupRevision) {
    return rejected(state, "GROUP_REVISION_CONFLICT");
  }
  if (!actorIsLeader(group, actor)) {
    return rejected(state, "NOT_GROUP_LEADER");
  }
  if (group.target === null || !targetsEqual(group.target, heartbeat.target)) {
    return rejected(state, "TARGET_MISMATCH");
  }

  const observed: MediaObservedState = {
    observedAtClientMs: heartbeat.observedAtClientMs,
    positionMs: heartbeat.positionMs,
    paused: heartbeat.paused,
    playbackRate: heartbeat.playbackRate,
    ended: heartbeat.ended,
    buffering: heartbeat.buffering,
  };
  const nextGroup = groupWithoutRevision(
    group,
    {
      target: heartbeat.target,
      observed,
      observedAtServerMs: nowMs,
      status: statusFor(heartbeat.target, observed),
      leaderGraceExpiresAtServerMs: null,
    },
    nowMs,
  );
  return changeExistingGroup(state, groupIndex, nextGroup);
}

export function disconnectActiveDevice(
  state: RoomMediaState,
  actor: Pick<MediaActor, "userId" | "deviceId">,
  nowMs: number,
): MediaStateChange {
  const events: MediaDomainEvent[] = [];
  let changed = false;
  const groups = state.groups.map((group) => {
    const member = memberForActor(group, {
      ...actor,
      username: "",
      displayName: "",
    });
    if (member?.activeDeviceId !== actor.deviceId || !member.online) {
      return group;
    }
    changed = true;
    const members = group.members.map((candidate) =>
      candidate.userId === actor.userId ? { ...candidate, online: false } : candidate,
    );
    const isLeader = group.leaderUserId === actor.userId && group.leaderDeviceId === actor.deviceId;
    let observed = group.observed;
    let observedAtServerMs = group.observedAtServerMs;
    if (isLeader && observed !== null) {
      observed = currentObserved(group, nowMs);
      observedAtServerMs = nowMs;
    }
    const nextGroup = groupWithRevision(
      group,
      {
        members,
        observed,
        observedAtServerMs,
        status: isLeader ? "LEADER_GRACE" : group.status,
        leaderGraceExpiresAtServerMs: isLeader
          ? nowMs + LEADER_GRACE_MS
          : group.leaderGraceExpiresAtServerMs,
        proposals: [],
      },
      nowMs,
    );
    events.push({ type: "GROUP_CHANGED", playbackGroupId: group.playbackGroupId });
    return nextGroup;
  });

  return {
    state: changed ? nextRoomState(state, groups) : state,
    events,
  };
}

export function reconnectActiveDevice(
  state: RoomMediaState,
  actor: MediaActor,
  nowMs: number,
): MediaStateChange {
  const events: MediaDomainEvent[] = [];
  let changed = false;
  const groups = state.groups.map((group) => {
    const member = memberForActor(group, actor);
    if (
      member?.activeDeviceId !== actor.deviceId ||
      member.online ||
      (group.status === "LEADER_GRACE" &&
        group.leaderGraceExpiresAtServerMs !== null &&
        nowMs >= group.leaderGraceExpiresAtServerMs)
    ) {
      return group;
    }
    changed = true;
    const members = group.members.map((candidate) =>
      candidate.userId === actor.userId
        ? {
            ...candidate,
            username: actor.username,
            displayName: actor.displayName,
            online: true,
          }
        : candidate,
    );
    const isLeader = group.leaderUserId === actor.userId && group.leaderDeviceId === actor.deviceId;
    const nextGroup = groupWithRevision(
      group,
      {
        members,
        status:
          isLeader && group.status === "LEADER_GRACE"
            ? statusFor(group.target, group.observed)
            : group.status,
        observedAtServerMs: isLeader && group.observed !== null ? nowMs : group.observedAtServerMs,
        leaderGraceExpiresAtServerMs: isLeader ? null : group.leaderGraceExpiresAtServerMs,
        proposals: [],
      },
      nowMs,
    );
    events.push({ type: "GROUP_CHANGED", playbackGroupId: group.playbackGroupId });
    return nextGroup;
  });

  return {
    state: changed ? nextRoomState(state, groups) : state,
    events,
  };
}

export function expireLeaderGrace(state: RoomMediaState, nowMs: number): MediaStateChange {
  const expired = state.groups.filter(
    (group) =>
      group.status === "LEADER_GRACE" &&
      group.leaderGraceExpiresAtServerMs !== null &&
      group.leaderGraceExpiresAtServerMs <= nowMs,
  );
  if (expired.length === 0) {
    return { state, events: [] };
  }
  const expiredIds = new Set(expired.map((group) => group.playbackGroupId));
  return {
    state: nextRoomState(
      state,
      state.groups.filter((group) => !expiredIds.has(group.playbackGroupId)),
    ),
    events: expired.map((group) => ({
      type: "GROUP_CLOSED" as const,
      playbackGroupId: group.playbackGroupId,
      reason: "LEADER_GRACE_EXPIRED" as const,
    })),
  };
}

export function clearOfflineRoom(state: RoomMediaState): MediaStateChange {
  if (state.groups.length === 0) {
    return { state, events: [] };
  }
  return {
    state: nextRoomState(state, []),
    events: state.groups.map((group) => ({
      type: "GROUP_CLOSED" as const,
      playbackGroupId: group.playbackGroupId,
      reason: "ROOM_OFFLINE" as const,
    })),
  };
}

export function expireProposals(state: RoomMediaState, nowMs: number): MediaStateChange {
  const events: MediaDomainEvent[] = [];
  let changed = false;
  const groups = state.groups.map((group) => {
    const proposals = group.proposals.filter((proposal) => proposal.expiresAtServerMs > nowMs);
    if (proposals.length === group.proposals.length) {
      return group;
    }
    changed = true;
    events.push({ type: "GROUP_CHANGED", playbackGroupId: group.playbackGroupId });
    return groupWithoutRevision(group, { proposals }, nowMs);
  });
  return {
    state: changed ? nextRoomState(state, groups) : state,
    events,
  };
}
