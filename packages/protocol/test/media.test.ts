import { describe, expect, it } from "vitest";
import {
  MediaCommandAckSchema,
  MediaCommandSchema,
  MediaGroupsSnapshotMessageSchema,
  MediaHeartbeatAckSchema,
  MediaHeartbeatSchema,
  MediaIdentitySchema,
  MediaTargetSchema,
  PlaybackGroupSnapshotSchema,
  ServerMessageSchema,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-4d6e-8f90-123456789a01";
const logicalTabId = "018f8f8e-4b5c-4d6e-8f90-123456789a02";
const playbackGroupId = "018f8f8e-4b5c-4d6e-8f90-123456789a03";
const commandId = "018f8f8e-4b5c-4d6e-8f90-123456789a04";
const proposalId = "018f8f8e-4b5c-4d6e-8f90-123456789a05";
const leaderUserId = "018f8f8e-4b5c-4d6e-8f90-123456789a06";
const leaderDeviceId = "018f8f8e-4b5c-4d6e-8f90-123456789a07";
const followerUserId = "018f8f8e-4b5c-4d6e-8f90-123456789a08";
const followerDeviceId = "018f8f8e-4b5c-4d6e-8f90-123456789a09";

const target = {
  logicalTabId,
  documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
  frameKey: "top",
  provider: "YOUTUBE" as const,
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
};

const observed = {
  observedAtClientMs: 1_700_000_000_000,
  positionMs: 42_000,
  paused: false,
  playbackRate: 1,
  ended: false,
  buffering: false,
};

const heartbeat = {
  type: "media.heartbeat" as const,
  protocolVersion: 1 as const,
  roomId,
  playbackGroupId,
  groupRevision: 7,
  target,
  ...observed,
};

const members = [
  {
    userId: leaderUserId,
    username: "leader",
    displayName: "Leader",
    activeDeviceId: leaderDeviceId,
    joinedAtServerMs: 1_700_000_000_000,
    online: true,
  },
  {
    userId: followerUserId,
    username: "follower",
    displayName: "Follower",
    activeDeviceId: followerDeviceId,
    joinedAtServerMs: 1_700_000_000_100,
    online: true,
  },
];

const group = {
  playbackGroupId,
  roomId,
  groupRevision: 7,
  status: "PLAYING" as const,
  leaderUserId,
  leaderDeviceId,
  members,
  target,
  observed,
  observedAtServerMs: 1_700_000_000_250,
  proposals: [
    {
      proposalId,
      proposedByUserId: followerUserId,
      proposedByDeviceId: followerDeviceId,
      baseGroupRevision: 7,
      action: { type: "SEEK", positionMs: 84_000 },
      createdAtServerMs: 1_700_000_000_200,
      expiresAtServerMs: 1_700_000_030_200,
    },
  ],
  leaderGraceExpiresAtServerMs: null,
  updatedAtServerMs: 1_700_000_000_250,
};

describe("strict media targets and observations", () => {
  it.each([
    ["YOUTUBE", "youtube:dQw4w9WgXcQ"],
    ["BILIBILI", "bilibili:av170001"],
    ["HTML5", "html5:primary-video"],
  ] as const)("parses a standalone %s media identity", (provider, mediaKey) => {
    expect(MediaIdentitySchema.parse({ provider, mediaKey })).toEqual({ provider, mediaKey });
  });

  it("keeps standalone and target media identity validation identical", () => {
    for (const identity of [
      { provider: "YOUTUBE", mediaKey: "youtube:short" },
      { provider: "BILIBILI", mediaKey: "bilibili:av0170001" },
      { provider: "HTML5", mediaKey: "youtube:dQw4w9WgXcQ" },
      { provider: "HTML5", mediaKey: "html5:primary-video", rawUrl: "https://private.example" },
    ]) {
      expect(() => MediaIdentitySchema.parse(identity)).toThrow();
    }
  });

  it("parses a privacy-safe supported media target and heartbeat", () => {
    expect(MediaTargetSchema.parse(target)).toEqual(target);
    expect(MediaHeartbeatSchema.parse(heartbeat)).toEqual(heartbeat);
  });

  it.each([
    ["unknown target key", { ...target, pageTitle: "private" }],
    ["raw URL", { ...target, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }],
    ["HTML", { ...target, mediaKey: "youtube:<script>" }],
    ["oversized media key", { ...target, mediaKey: `youtube:${"a".repeat(260)}` }],
    ["invalid frame key", { ...target, frameKey: "https://private.example/frame" }],
    ["provider/key mismatch", { ...target, provider: "BILIBILI" }],
    ["short YouTube id", { ...target, mediaKey: "youtube:abcdef" }],
    ["long YouTube id", { ...target, mediaKey: "youtube:dQw4w9WgXcQabc" }],
    [
      "noncanonical Bilibili bvid",
      { ...target, provider: "BILIBILI", mediaKey: "bilibili:BV17x411w7KC" },
    ],
    [
      "zero-padded Bilibili aid",
      { ...target, provider: "BILIBILI", mediaKey: "bilibili:av0170001" },
    ],
    [
      "Bilibili aid beyond the 51-bit identity space",
      {
        ...target,
        provider: "BILIBILI",
        mediaKey: "bilibili:av2251799813685248",
      },
    ],
    ["zero duration", { ...target, durationMs: 0 }],
    ["infinite duration", { ...target, durationMs: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_name, value) => {
    expect(() => MediaTargetSchema.parse(value)).toThrow();
  });

  it.each([
    ["negative position", { ...heartbeat, positionMs: -1 }],
    ["position beyond duration", { ...heartbeat, positionMs: target.durationMs + 1 }],
    ["NaN position", { ...heartbeat, positionMs: Number.NaN }],
    ["infinite rate", { ...heartbeat, playbackRate: Number.POSITIVE_INFINITY }],
    ["rate below range", { ...heartbeat, playbackRate: 0.24 }],
    ["rate above range", { ...heartbeat, playbackRate: 4.01 }],
    ["client identity", { ...heartbeat, userId: leaderUserId }],
  ])("rejects a heartbeat with %s", (_name, value) => {
    expect(() => MediaHeartbeatSchema.parse(value)).toThrow();
  });
});

describe("reliable media commands", () => {
  const expectedCommands = [
    {
      type: "group.create",
      protocolVersion: 1,
      commandId,
      roomId,
      target,
      observed,
    },
    {
      type: "group.join",
      protocolVersion: 1,
      commandId,
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
    },
    {
      type: "group.leave",
      protocolVersion: 1,
      commandId,
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
    },
    {
      type: "group.takeover",
      protocolVersion: 1,
      commandId,
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
    },
    {
      type: "group.transfer-leader",
      protocolVersion: 1,
      commandId,
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
      targetUserId: followerUserId,
      targetDeviceId: followerDeviceId,
    },
    {
      type: "group.switch-target",
      protocolVersion: 1,
      commandId,
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
      target,
      observed,
    },
    {
      type: "group.close",
      protocolVersion: 1,
      commandId,
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
    },
    {
      type: "proposal.create",
      protocolVersion: 1,
      commandId,
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
      action: { type: "SET_RATE", playbackRate: 1.25 },
    },
    {
      type: "proposal.decide",
      protocolVersion: 1,
      commandId,
      roomId,
      playbackGroupId,
      expectedGroupRevision: 7,
      proposalId,
      decision: "APPROVE",
    },
  ] as const;

  it.each(expectedCommands)("parses $type without client identity", (command) => {
    expect(MediaCommandSchema.parse(command)).toEqual(command);
  });

  it("allows an idle group to be created without a target", () => {
    const command = {
      type: "group.create",
      protocolVersion: 1,
      commandId,
      roomId,
      target: null,
      observed: null,
    };
    expect(MediaCommandSchema.parse(command)).toEqual(command);
  });

  it("requires revisions on every existing-group command", () => {
    for (const command of expectedCommands.slice(1)) {
      const withoutRevision: Record<string, unknown> = { ...command };
      delete withoutRevision.expectedGroupRevision;
      expect(() => MediaCommandSchema.parse(withoutRevision)).toThrow();
    }
  });

  it("rejects spoofed identities, raw page data, unknown actions, and target mismatches", () => {
    expect(() =>
      MediaCommandSchema.parse({ ...expectedCommands[1], userId: followerUserId }),
    ).toThrow();
    expect(() =>
      MediaCommandSchema.parse({ ...expectedCommands[5], pageTitle: "private" }),
    ).toThrow();
    expect(() =>
      MediaCommandSchema.parse({
        ...expectedCommands[7],
        action: { type: "EVAL", html: "<script>" },
      }),
    ).toThrow();
    expect(() =>
      MediaCommandSchema.parse({
        ...expectedCommands[0],
        observed: { ...observed, positionMs: target.durationMs + 1 },
      }),
    ).toThrow();
    expect(() =>
      MediaCommandSchema.parse({
        ...expectedCommands[0],
        target: null,
        observed,
      }),
    ).toThrow();
  });
});

describe("authoritative playback group messages", () => {
  it("parses a strict group snapshot and top-level server message", () => {
    expect(PlaybackGroupSnapshotSchema.parse(group)).toEqual(group);
    const message = {
      type: "media.groups.snapshot" as const,
      protocolVersion: 1 as const,
      roomId,
      roomMediaRevision: 11,
      groups: [group],
    };
    expect(MediaGroupsSnapshotMessageSchema.parse(message)).toEqual(message);
    expect(ServerMessageSchema.parse(message)).toEqual(message);
  });

  it("parses command and heartbeat acknowledgements as server messages", () => {
    const commandAck = {
      type: "media.command.ack" as const,
      protocolVersion: 1 as const,
      commandId,
      roomId,
      accepted: true,
      code: null,
      playbackGroupId,
      groupRevision: 8,
      roomMediaRevision: 12,
    };
    const heartbeatAck = {
      type: "media.heartbeat.ack" as const,
      protocolVersion: 1 as const,
      roomId,
      playbackGroupId,
      accepted: false,
      code: "NOT_GROUP_LEADER" as const,
      groupRevision: 8,
      roomMediaRevision: 12,
    };
    expect(MediaCommandAckSchema.parse(commandAck)).toEqual(commandAck);
    expect(MediaHeartbeatAckSchema.parse(heartbeatAck)).toEqual(heartbeatAck);
    expect(ServerMessageSchema.parse(commandAck)).toEqual(commandAck);
    expect(ServerMessageSchema.parse(heartbeatAck)).toEqual(heartbeatAck);
  });

  it("models acknowledgement authority without impossible field combinations", () => {
    const baseCommandAck = {
      type: "media.command.ack",
      protocolVersion: 1,
      commandId,
      roomId,
      roomMediaRevision: 12,
    };
    expect(
      MediaCommandAckSchema.parse({
        ...baseCommandAck,
        accepted: false,
        code: "GROUP_NOT_FOUND",
        playbackGroupId: null,
        groupRevision: null,
      }),
    ).toMatchObject({ accepted: false, groupRevision: null });
    expect(() =>
      MediaCommandAckSchema.parse({
        ...baseCommandAck,
        accepted: false,
        code: "GROUP_NOT_FOUND",
        playbackGroupId: null,
        groupRevision: 8,
      }),
    ).toThrow();
    expect(() =>
      MediaCommandAckSchema.parse({
        ...baseCommandAck,
        accepted: false,
        code: "NOT_GROUP_LEADER",
        playbackGroupId,
        groupRevision: null,
      }),
    ).toThrow();
    expect(() =>
      MediaCommandAckSchema.parse({
        ...baseCommandAck,
        accepted: false,
        code: "GROUP_NOT_FOUND",
        playbackGroupId,
        groupRevision: 8,
      }),
    ).toThrow();
    expect(() =>
      MediaCommandAckSchema.parse({
        ...baseCommandAck,
        accepted: false,
        code: "GROUP_REVISION_CONFLICT",
        playbackGroupId: null,
        groupRevision: null,
      }),
    ).toThrow();

    const baseHeartbeatAck = {
      type: "media.heartbeat.ack",
      protocolVersion: 1,
      roomId,
      playbackGroupId,
      roomMediaRevision: 12,
    };
    expect(
      MediaHeartbeatAckSchema.parse({
        ...baseHeartbeatAck,
        accepted: false,
        code: "GROUP_NOT_FOUND",
        groupRevision: null,
      }),
    ).toMatchObject({ accepted: false, groupRevision: null });
    expect(
      MediaHeartbeatAckSchema.parse({
        ...baseHeartbeatAck,
        accepted: false,
        code: "TARGET_MISMATCH",
        groupRevision: null,
      }),
    ).toMatchObject({ accepted: false, code: "TARGET_MISMATCH", groupRevision: null });
    expect(() =>
      MediaHeartbeatAckSchema.parse({
        ...baseHeartbeatAck,
        accepted: false,
        code: "GROUP_NOT_FOUND",
        groupRevision: 8,
      }),
    ).toThrow();
    expect(() =>
      MediaHeartbeatAckSchema.parse({
        ...baseHeartbeatAck,
        accepted: false,
        code: "PROPOSAL_EXPIRED",
        groupRevision: 8,
      }),
    ).toThrow();
  });

  it("rejects contradictory ACKs and inconsistent group projections", () => {
    expect(() =>
      MediaCommandAckSchema.parse({
        type: "media.command.ack",
        protocolVersion: 1,
        commandId,
        roomId,
        accepted: true,
        code: "GROUP_NOT_FOUND",
        playbackGroupId: null,
        groupRevision: null,
        roomMediaRevision: 12,
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        leaderDeviceId: followerDeviceId,
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        proposals: [
          {
            ...group.proposals[0],
            expiresAtServerMs: group.proposals[0]!.createdAtServerMs + 1,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        status: "LEADER_GRACE",
        members: group.members.map((member) =>
          member.userId === group.leaderUserId ? { ...member, online: false } : member,
        ),
        leaderGraceExpiresAtServerMs: group.updatedAtServerMs + 86_400_000,
      }),
    ).toThrow();
    expect(
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        status: "LEADER_GRACE",
        members: group.members.map((member) =>
          member.userId === group.leaderUserId ? { ...member, online: false } : member,
        ),
        leaderGraceExpiresAtServerMs: group.updatedAtServerMs + 9_000,
      }),
    ).toMatchObject({
      status: "LEADER_GRACE",
      leaderGraceExpiresAtServerMs: group.updatedAtServerMs + 9_000,
    });
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        members: [members[0], members[0]],
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        observed: { ...observed, positionMs: target.durationMs + 1 },
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        observedAtServerMs: null,
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        observed: { ...observed, ended: true },
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        status: "LOADING",
        observed: { ...observed, buffering: false },
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        status: "LOADING",
        observed: { ...observed, ended: true, buffering: true },
      }),
    ).toThrow();
    expect(() =>
      PlaybackGroupSnapshotSchema.parse({
        ...group,
        status: "LEADER_GRACE",
        leaderGraceExpiresAtServerMs: group.updatedAtServerMs + 10_000,
      }),
    ).toThrow();
    expect(() =>
      MediaGroupsSnapshotMessageSchema.parse({
        type: "media.groups.snapshot",
        protocolVersion: 1,
        roomId,
        roomMediaRevision: 11,
        groups: [{ ...group, roomId: "018f8f8e-4b5c-4d6e-8f90-123456789aff" }],
      }),
    ).toThrow();
  });

  it("enforces room-wide member uniqueness and the 256-device snapshot bound", () => {
    const secondGroup = {
      ...group,
      playbackGroupId: "018f8f8e-4b5c-4d6e-8f90-123456789b03",
    };
    const snapshot = {
      type: "media.groups.snapshot",
      protocolVersion: 1,
      roomId,
      roomMediaRevision: 11,
      groups: [group, secondGroup],
    };
    expect(() => MediaGroupsSnapshotMessageSchema.parse(snapshot)).toThrow();
    expect(() =>
      MediaGroupsSnapshotMessageSchema.parse({
        ...snapshot,
        groups: [
          group,
          {
            ...secondGroup,
            members: secondGroup.members.map((member) => ({
              ...member,
              userId: member.userId.toUpperCase(),
              activeDeviceId: member.activeDeviceId.toUpperCase(),
            })),
            leaderUserId: secondGroup.leaderUserId.toUpperCase(),
            leaderDeviceId: secondGroup.leaderDeviceId.toUpperCase(),
          },
        ],
      }),
    ).toThrow();

    const uuid = (value: number): string =>
      `018f8f8e-4b5c-4d6e-8f90-${value.toString().padStart(12, "0")}`;
    const oversizedGroups = Array.from({ length: 20 }, (_, groupIndex) => {
      const groupMembers = Array.from({ length: 13 }, (_, memberIndex) => {
        const ordinal = groupIndex * 13 + memberIndex + 1;
        return {
          userId: uuid(10_000 + ordinal),
          username: `user-${ordinal}`,
          displayName: `User ${ordinal}`,
          activeDeviceId: uuid(20_000 + ordinal),
          joinedAtServerMs: 1_700_000_000_000 + ordinal,
          online: true,
        };
      });
      return {
        ...group,
        playbackGroupId: uuid(30_000 + groupIndex),
        leaderUserId: groupMembers[0]!.userId,
        leaderDeviceId: groupMembers[0]!.activeDeviceId,
        members: groupMembers,
        proposals: [],
      };
    });
    expect(oversizedGroups.flatMap((candidate) => candidate.members)).toHaveLength(260);
    expect(() =>
      MediaGroupsSnapshotMessageSchema.parse({
        ...snapshot,
        groups: oversizedGroups,
      }),
    ).toThrow();
  });
});
