import { describe, expect, it } from "vitest";
import {
  applyLeaderHeartbeat,
  applyMediaCommand,
  createEmptyRoomMediaState,
  disconnectActiveDevice,
  expireLeaderGrace,
  getPlaybackGroup,
  reconnectActiveDevice,
  type MediaActor,
  type RoomMediaState,
} from "../src/index.js";
import {
  LogicalTabIdSchema,
  PlaybackGroupSnapshotSchema,
  MediaTargetSchema,
  RoomIdSchema,
  type MediaCommand,
  type MediaHeartbeat,
  type MediaTarget,
} from "@syncaction/protocol";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-223456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-223456789a02");
const leaderDeviceId = "018f8f8e-4b5c-4d6e-8f90-223456789a03";
const followerDeviceId = "018f8f8e-4b5c-4d6e-8f90-223456789a04";
const secondFollowerDeviceId = "018f8f8e-4b5c-4d6e-8f90-223456789a05";
const leaderUserId = "018f8f8e-4b5c-4d6e-8f90-223456789a06";
const followerUserId = "018f8f8e-4b5c-4d6e-8f90-223456789a07";
const secondFollowerUserId = "018f8f8e-4b5c-4d6e-8f90-223456789a08";
const createCommandId = "018f8f8e-4b5c-4d6e-8f90-223456789a09";
const secondGroupCommandId = "018f8f8e-4b5c-4d6e-8f90-223456789a0a";
const nowMs = 1_700_000_000_000;

const leader: MediaActor = {
  userId: leaderUserId,
  deviceId: leaderDeviceId,
  username: "leader",
  displayName: "Leader",
};
const follower: MediaActor = {
  userId: followerUserId,
  deviceId: followerDeviceId,
  username: "follower",
  displayName: "Follower",
};
const secondFollower: MediaActor = {
  userId: secondFollowerUserId,
  deviceId: secondFollowerDeviceId,
  username: "second",
  displayName: "Second",
};

const target: MediaTarget = MediaTargetSchema.parse({
  logicalTabId,
  documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
});
const observed = {
  observedAtClientMs: nowMs,
  positionMs: 42_000,
  paused: false,
  playbackRate: 1,
  ended: false,
  buffering: false,
};

let nextCommand = 0x10;
function commandId(): string {
  const suffix = nextCommand.toString(16).padStart(2, "0");
  nextCommand += 1;
  return `018f8f8e-4b5c-4d6e-8f90-223456789a${suffix}`;
}

function createPlayingGroup(
  actor: MediaActor = leader,
  state: RoomMediaState = createEmptyRoomMediaState(roomId),
) {
  return applyMediaCommand(
    state,
    {
      type: "group.create",
      protocolVersion: 1,
      commandId: createCommandId,
      roomId,
      target,
      observed,
    },
    actor,
    nowMs,
  );
}

function applyExisting(
  state: RoomMediaState,
  actor: MediaActor,
  command: { type: Exclude<MediaCommand["type"], "group.create"> } & Record<string, unknown>,
) {
  const group = state.groups[0];
  if (group === undefined) {
    throw new Error("expected group");
  }
  return applyMediaCommand(
    state,
    {
      ...command,
      protocolVersion: 1,
      commandId: commandId(),
      roomId,
      playbackGroupId: group.playbackGroupId,
      expectedGroupRevision: group.groupRevision,
    } as MediaCommand,
    actor,
    nowMs + state.roomMediaRevision,
  );
}

describe("pure playback group transitions", () => {
  it("returns new valid snapshots without mutating its input", () => {
    const initial = createPlayingGroup().state;
    const serialized = JSON.stringify(initial);
    const transition = applyExisting(initial, follower, { type: "group.join" });
    expect(JSON.stringify(initial)).toBe(serialized);
    expect(transition.state).not.toBe(initial);
    for (const group of transition.state.groups) {
      expect(PlaybackGroupSnapshotSchema.parse(group)).toEqual(group);
    }
  });

  it("creates, joins, takes over, transfers leadership, leaves, and closes", () => {
    let transition = createPlayingGroup();
    expect(transition.outcome).toMatchObject({
      ok: true,
      playbackGroupId: createCommandId,
      groupRevision: 1,
    });
    expect(transition.state.roomMediaRevision).toBe(1);
    expect(transition.state.groups[0]).toMatchObject({
      playbackGroupId: createCommandId,
      status: "PLAYING",
      leaderUserId,
      leaderDeviceId,
      members: [{ userId: leaderUserId, activeDeviceId: leaderDeviceId }],
    });

    transition = applyExisting(transition.state, follower, { type: "group.join" });
    expect(transition.state.groups[0]?.members).toHaveLength(2);
    expect(transition.state.groups[0]?.groupRevision).toBe(2);

    transition = applyExisting(
      transition.state,
      { ...follower, deviceId: secondFollowerDeviceId },
      { type: "group.takeover" },
    );
    expect(
      transition.state.groups[0]?.members.find((member) => member.userId === followerUserId),
    ).toMatchObject({ activeDeviceId: secondFollowerDeviceId, online: true });

    transition = applyExisting(transition.state, leader, {
      type: "group.transfer-leader",
      targetUserId: followerUserId,
      targetDeviceId: secondFollowerDeviceId,
    });
    expect(transition.state.groups[0]).toMatchObject({
      leaderUserId: followerUserId,
      leaderDeviceId: secondFollowerDeviceId,
    });

    transition = applyExisting(transition.state, leader, { type: "group.leave" });
    expect(transition.state.groups[0]?.members).toHaveLength(1);

    transition = applyExisting(
      transition.state,
      { ...follower, deviceId: secondFollowerDeviceId },
      { type: "group.close" },
    );
    expect(transition.state.groups).toEqual([]);
    expect(transition.events.at(-1)).toMatchObject({
      type: "GROUP_CLOSED",
      reason: "LEADER_CLOSED",
    });
  });

  it("retains membership after ended and lets the leader switch targets", () => {
    let transition = createPlayingGroup();
    transition = applyExisting(transition.state, follower, { type: "group.join" });
    const group = transition.state.groups[0]!;
    const heartbeat: MediaHeartbeat = {
      type: "media.heartbeat",
      protocolVersion: 1,
      roomId,
      playbackGroupId: group.playbackGroupId,
      groupRevision: group.groupRevision,
      target,
      ...observed,
      positionMs: target.durationMs,
      paused: true,
      ended: true,
    };

    transition = applyLeaderHeartbeat(transition.state, heartbeat, leader, nowMs + 1_000);
    expect(transition.state.groups[0]).toMatchObject({
      playbackGroupId: createCommandId,
      status: "ENDED_WAITING",
    });
    expect(transition.state.groups[0]?.members).toHaveLength(2);

    const nextTarget: MediaTarget = {
      ...target,
      mediaKey: "youtube:9bZkp7q19f0",
      durationMs: 253_000,
    };
    transition = applyExisting(transition.state, leader, {
      type: "group.switch-target",
      target: nextTarget,
      observed: { ...observed, positionMs: 0, paused: true },
    });
    expect(transition.state.groups[0]).toMatchObject({
      playbackGroupId: createCommandId,
      status: "PAUSED",
      target: { mediaKey: "youtube:9bZkp7q19f0" },
    });
    expect(transition.state.groups[0]?.members).toHaveLength(2);
  });

  it("turns follower controls into replaceable proposals and applies only leader approval", () => {
    let transition = createPlayingGroup();
    transition = applyExisting(transition.state, follower, { type: "group.join" });
    const revisionBeforeProposal = transition.state.groups[0]!.groupRevision;
    transition = applyExisting(transition.state, follower, {
      type: "proposal.create",
      action: { type: "SEEK", positionMs: 84_000 },
    });
    expect(transition.state.groups[0]).toMatchObject({
      groupRevision: revisionBeforeProposal,
      observed: { positionMs: 42_000 },
      proposals: [
        {
          proposedByUserId: followerUserId,
          baseGroupRevision: revisionBeforeProposal,
          action: { type: "SEEK", positionMs: 84_000 },
        },
      ],
    });

    transition = applyExisting(transition.state, follower, {
      type: "proposal.create",
      action: { type: "PAUSE" },
    });
    expect(transition.state.groups[0]?.proposals).toHaveLength(1);
    expect(transition.state.groups[0]?.proposals[0]?.action).toEqual({ type: "PAUSE" });

    const proposal = transition.state.groups[0]!.proposals[0]!;
    const nonleaderDecision = applyExisting(transition.state, follower, {
      type: "proposal.decide",
      proposalId: proposal.proposalId,
      decision: "APPROVE",
    });
    expect(nonleaderDecision.outcome).toEqual({ ok: false, code: "NOT_GROUP_LEADER" });
    expect(nonleaderDecision.state).toBe(transition.state);

    transition = applyExisting(transition.state, leader, {
      type: "proposal.decide",
      proposalId: proposal.proposalId,
      decision: "APPROVE",
    });
    expect(transition.state.groups[0]).toMatchObject({
      status: "PAUSED",
      observed: { paused: true },
      proposals: [],
      groupRevision: revisionBeforeProposal + 1,
    });
  });

  it("rejects a stale approval and membership in a second group", () => {
    let transition = createPlayingGroup();
    transition = applyExisting(transition.state, follower, { type: "group.join" });
    transition = applyExisting(transition.state, follower, {
      type: "proposal.create",
      action: { type: "PLAY" },
    });
    const proposal = transition.state.groups[0]!.proposals[0]!;
    const staleDecision = applyMediaCommand(
      transition.state,
      {
        type: "proposal.decide",
        protocolVersion: 1,
        commandId: commandId(),
        roomId,
        playbackGroupId: createCommandId,
        expectedGroupRevision: proposal.baseGroupRevision + 1,
        proposalId: proposal.proposalId,
        decision: "APPROVE",
      },
      leader,
      nowMs + 10,
    );
    expect(staleDecision.outcome).toEqual({ ok: false, code: "GROUP_REVISION_CONFLICT" });

    const secondGroup = applyMediaCommand(
      transition.state,
      {
        type: "group.create",
        protocolVersion: 1,
        commandId: secondGroupCommandId,
        roomId,
        target,
        observed,
      },
      follower,
      nowMs + 20,
    );
    expect(secondGroup.outcome).toEqual({ ok: false, code: "GROUP_MEMBERSHIP_CONFLICT" });
  });

  it("closes the group if its leader leaves without transferring", () => {
    let transition = createPlayingGroup();
    transition = applyExisting(transition.state, follower, { type: "group.join" });
    transition = applyExisting(transition.state, leader, { type: "group.leave" });
    expect(transition.state.groups).toEqual([]);
    expect(transition.events).toContainEqual({
      type: "GROUP_CLOSED",
      playbackGroupId: createCommandId,
      reason: "LEADER_LEFT",
    });
  });
});

describe("leader disconnect grace", () => {
  it("restores leadership when the same account and device reconnect within ten seconds", () => {
    let state = createPlayingGroup().state;
    state = disconnectActiveDevice(state, leader, nowMs + 1_000).state;
    expect(getPlaybackGroup(state, createCommandId)).toMatchObject({
      status: "LEADER_GRACE",
      leaderGraceExpiresAtServerMs: nowMs + 11_000,
      members: [{ online: false }],
    });

    state = reconnectActiveDevice(state, leader, nowMs + 10_999).state;
    expect(getPlaybackGroup(state, createCommandId)).toMatchObject({
      status: "PLAYING",
      leaderGraceExpiresAtServerMs: null,
      members: [{ online: true }],
    });
  });

  it("does not restore from another device and closes after grace expiry", () => {
    let state = createPlayingGroup().state;
    state = disconnectActiveDevice(state, leader, nowMs + 1_000).state;
    const wrongDevice = reconnectActiveDevice(
      state,
      { ...leader, deviceId: secondFollowerDeviceId },
      nowMs + 5_000,
    );
    expect(wrongDevice.state).toBe(state);

    const expired = expireLeaderGrace(state, nowMs + 11_000);
    expect(expired.state.groups).toEqual([]);
    expect(expired.events).toContainEqual({
      type: "GROUP_CLOSED",
      playbackGroupId: createCommandId,
      reason: "LEADER_GRACE_EXPIRED",
    });
  });

  it("allows an explicit leader-device takeover without advancing through the grace gap", () => {
    let state = createPlayingGroup().state;
    state = disconnectActiveDevice(state, leader, nowMs + 1_000).state;
    const gracePosition = state.groups[0]!.observed!.positionMs;
    const group = state.groups[0]!;
    const takeover = applyMediaCommand(
      state,
      {
        type: "group.takeover",
        protocolVersion: 1,
        commandId: commandId(),
        roomId,
        playbackGroupId: group.playbackGroupId,
        expectedGroupRevision: group.groupRevision,
      },
      { ...leader, deviceId: secondFollowerDeviceId },
      nowMs + 5_000,
    );
    expect(takeover.state.groups[0]).toMatchObject({
      status: "PLAYING",
      leaderDeviceId: secondFollowerDeviceId,
      observed: { positionMs: gracePosition },
      observedAtServerMs: nowMs + 5_000,
      leaderGraceExpiresAtServerMs: null,
    });
  });

  it("keeps a disconnected follower in the group without starting leader grace", () => {
    let transition = createPlayingGroup();
    transition = applyExisting(transition.state, secondFollower, { type: "group.join" });
    const disconnected = disconnectActiveDevice(transition.state, secondFollower, nowMs + 1_000);
    expect(disconnected.state.groups[0]).toMatchObject({
      status: "PLAYING",
      leaderGraceExpiresAtServerMs: null,
    });
    expect(disconnected.state.groups[0]?.members[1]).toMatchObject({
      userId: secondFollowerUserId,
      online: false,
    });
  });

  it("does not clear an existing leader deadline when a follower disconnects", () => {
    let transition = createPlayingGroup();
    transition = applyExisting(transition.state, follower, { type: "group.join" });
    const leaderDisconnected = disconnectActiveDevice(transition.state, leader, nowMs + 1_000);
    const followerDisconnected = disconnectActiveDevice(
      leaderDisconnected.state,
      follower,
      nowMs + 2_000,
    );
    expect(followerDisconnected.state.groups[0]).toMatchObject({
      status: "LEADER_GRACE",
      leaderGraceExpiresAtServerMs: nowMs + 11_000,
    });
  });
});
