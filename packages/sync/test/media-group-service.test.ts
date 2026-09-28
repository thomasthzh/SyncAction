import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  MediaCommandSchema,
  MediaHeartbeatSchema,
  MediaTargetSchema,
  RoomIdSchema,
  type MediaCommand,
  type MediaHeartbeat,
  type MediaTarget,
  type PresenceRecord,
} from "@syncaction/protocol";
import {
  MediaServiceError,
  RoomMediaGroupService,
  type AuthorizedDocument,
  type DocumentAuthorizationPort,
  type PresencePrincipal,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-523456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-523456789a02");
const baseNowMs = 1_700_000_000_000;
const target = MediaTargetSchema.parse({
  logicalTabId,
  documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
});
const secondLogicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-523456789a03");
const secondTarget = MediaTargetSchema.parse({
  logicalTabId: secondLogicalTabId,
  documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 13 },
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:9bZkp7q19f0",
  durationMs: 253_000,
});
const observed = {
  observedAtClientMs: baseNowMs,
  positionMs: 42_000,
  paused: false,
  playbackRate: 1,
  ended: false,
  buffering: false,
};

interface TestActor {
  principal: PresencePrincipal;
  username: string;
  displayName: string;
}

function uuid(index: number): string {
  return `018f8f8e-4b5c-4d6e-8f90-${String(523_456_790_000 + index).padStart(12, "0")}`;
}

function actor(index: number, username = `user-${index}`): TestActor {
  return {
    principal: {
      userId: uuid(index * 3),
      deviceId: DeviceIdSchema.parse(uuid(index * 3 + 1)),
      sessionId: uuid(index * 3 + 2),
    },
    username,
    displayName: `User ${index}`,
  };
}

class FakeAuthorization implements DocumentAuthorizationPort {
  public readonly sockets = new Map<string, TestActor>();
  public readonly logicalTabBySocket = new Map<string, MediaTarget["logicalTabId"]>();
  public readonly blockedSockets = new Set<string>();
  public onSocketConnected: ((socketId: string) => void) | undefined;
  public authorizationBarrier:
    | {
        entered: () => void;
        wait: Promise<void>;
      }
    | undefined;
  public roomOnline = true;
  public roomActive = true;
  public readonly unavailableDocuments = new Set<string>();

  public connect(
    socketId: string,
    identity: TestActor,
    currentLogicalTabId: MediaTarget["logicalTabId"] = logicalTabId,
  ): void {
    this.sockets.set(socketId, identity);
    this.logicalTabBySocket.set(socketId, currentLogicalTabId);
    this.onSocketConnected?.(socketId);
  }

  public closeDocument(documentTarget: MediaTarget): void {
    this.unavailableDocuments.add(documentKey(documentTarget));
  }

  public async authorizeRoom(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    maxValidationAgeMs?: number;
  }): Promise<PresenceRecord> {
    const socketId = String(input.socketId);
    const identity = this.sockets.get(socketId);
    if (
      identity === undefined ||
      this.blockedSockets.has(socketId) ||
      input.roomId !== roomId ||
      input.principal.userId !== identity.principal.userId ||
      input.principal.deviceId !== identity.principal.deviceId ||
      input.principal.sessionId !== identity.principal.sessionId
    ) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }
    const barrier = this.authorizationBarrier;
    if (barrier !== undefined) {
      barrier.entered();
      await barrier.wait;
    }
    return {
      userId: identity.principal.userId,
      username: identity.username,
      displayName: identity.displayName,
      deviceId: DeviceIdSchema.parse(identity.principal.deviceId),
      logicalTabId: this.logicalTabBySocket.get(socketId) ?? logicalTabId,
      expiresAt: baseNowMs + 30_000,
    };
  }

  public async authorize(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    target?: unknown;
    maxValidationAgeMs?: number;
  }): Promise<AuthorizedDocument> {
    const member = await this.authorizeRoom(input);
    if (member.logicalTabId !== input.logicalTabId) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }
    return this.#authorizeDocument(input, member);
  }

  public async authorizeRoomDocument(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    target?: unknown;
    maxValidationAgeMs?: number;
  }): Promise<AuthorizedDocument> {
    const member = await this.authorizeRoom(input);
    return this.#authorizeDocument(input, member);
  }

  #authorizeDocument(
    input: {
      logicalTabId: unknown;
      documentRevision: unknown;
      target?: unknown;
    },
    member: PresenceRecord,
  ): AuthorizedDocument {
    const authorizedTarget = [target, secondTarget].find(
      (candidate) =>
        input.logicalTabId === candidate.logicalTabId &&
        JSON.stringify(input.documentRevision) === JSON.stringify(candidate.documentRevision),
    );
    if (
      authorizedTarget === undefined ||
      this.unavailableDocuments.has(documentKey(authorizedTarget))
    ) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }
    if (
      input.target !== undefined &&
      JSON.stringify(MediaTargetSchema.parse(input.target)) !== JSON.stringify(authorizedTarget)
    ) {
      throw new MediaServiceError("TARGET_MISMATCH");
    }
    return {
      roomId,
      logicalTabId: authorizedTarget.logicalTabId,
      documentRevision: authorizedTarget.documentRevision,
      canonicalPageIdentity: authorizedTarget.mediaKey,
      role: "OWNER",
      frameKey: authorizedTarget.frameKey,
      member,
    };
  }

  public hasRoomEntries(roomIdInput: unknown): boolean {
    return roomIdInput === roomId && this.roomOnline;
  }

  public async isRoomActive(roomIdInput: unknown): Promise<boolean> {
    if (roomIdInput !== roomId) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE");
    }
    return this.roomActive;
  }
}

function documentKey(documentTarget: MediaTarget): string {
  return `${documentTarget.logicalTabId}:${documentTarget.documentRevision.roomEpoch}:${documentTarget.documentRevision.tabUpdatedAtSeq}`;
}

function createCommand(commandId: string): MediaCommand {
  return MediaCommandSchema.parse({
    type: "group.create",
    protocolVersion: 1,
    commandId,
    roomId,
    target,
    observed,
  });
}

function existingCommand(
  type: Exclude<MediaCommand["type"], "group.create">,
  commandId: string,
  playbackGroupId: string,
  expectedGroupRevision: number,
  extra: Record<string, unknown> = {},
): MediaCommand {
  return MediaCommandSchema.parse({
    type,
    protocolVersion: 1,
    commandId,
    roomId,
    playbackGroupId,
    expectedGroupRevision,
    ...extra,
  });
}

function heartbeat(
  playbackGroupId: string,
  groupRevision: number,
  overrides: Partial<MediaHeartbeat> = {},
): MediaHeartbeat {
  return MediaHeartbeatSchema.parse({
    type: "media.heartbeat",
    protocolVersion: 1,
    roomId,
    playbackGroupId,
    groupRevision,
    target,
    ...observed,
    ...overrides,
  });
}

function setup(options: { maxRoomDeviceEntries?: number } = {}) {
  let nowMs = baseNowMs;
  const authorization = new FakeAuthorization();
  const service = new RoomMediaGroupService({
    authorization,
    now: () => nowMs,
    ...options,
  });
  authorization.onSocketConnected = (socketId) => {
    service.registerSocket(socketId);
  };
  return {
    authorization,
    service,
    setNow(value: number) {
      nowMs = value;
    },
  };
}

async function createPendingSwitchProposal(
  value: ReturnType<typeof setup>,
  commandIndex: number,
): Promise<{
  leader: TestActor;
  playbackGroupId: string;
  proposalId: string;
}> {
  const leader = actor(1);
  const follower = actor(2);
  value.authorization.connect("socket-leader", leader);
  value.authorization.connect("socket-follower", follower);
  const playbackGroupId = uuid(commandIndex);
  await value.service.command({
    principal: leader.principal,
    socketId: "socket-leader",
    command: createCommand(playbackGroupId),
  });
  await value.service.command({
    principal: follower.principal,
    socketId: "socket-follower",
    command: existingCommand("group.join", uuid(commandIndex + 1), playbackGroupId, 1),
  });
  value.authorization.logicalTabBySocket.set("socket-follower", secondLogicalTabId);
  const proposalId = uuid(commandIndex + 2);
  const proposed = await value.service.command({
    principal: follower.principal,
    socketId: "socket-follower",
    command: existingCommand("proposal.create", proposalId, playbackGroupId, 2, {
      action: {
        type: "SWITCH_TARGET",
        target: secondTarget,
        observed: {
          ...observed,
          positionMs: 0,
          paused: true,
        },
      },
    }),
  });
  expect(proposed.ack.accepted).toBe(true);
  return {
    leader,
    playbackGroupId,
    proposalId,
  };
}

describe("RoomMediaGroupService", () => {
  it("projects active playback across pause, end, target switch, and group close", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);
    const playbackGroupId = uuid(90);

    expect(service.hasActivePlayback(roomId)).toBe(false);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(playbackGroupId),
    });
    expect(service.hasActivePlayback(roomId)).toBe(true);

    await service.heartbeat({
      principal: leader.principal,
      socketId: "socket-leader",
      heartbeat: heartbeat(playbackGroupId, 1, {
        paused: true,
      }),
    });
    expect(service.hasActivePlayback(roomId)).toBe(true);

    await service.heartbeat({
      principal: leader.principal,
      socketId: "socket-leader",
      heartbeat: heartbeat(playbackGroupId, 1, {
        positionMs: target.durationMs,
        paused: true,
        ended: true,
      }),
    });
    expect(service.hasActivePlayback(roomId)).toBe(false);

    authorization.logicalTabBySocket.set("socket-leader", secondLogicalTabId);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: existingCommand("group.switch-target", uuid(91), playbackGroupId, 1, {
        target: secondTarget,
        observed: {
          ...observed,
          positionMs: 0,
          paused: true,
        },
      }),
    });
    expect(service.hasActivePlayback(roomId)).toBe(true);

    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: existingCommand("group.close", uuid(92), playbackGroupId, 2),
    });
    expect(service.hasActivePlayback(roomId)).toBe(false);
  });

  it("keeps playback active during leader grace and clears it at expiry", async () => {
    const { authorization, service, setNow } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(93)),
    });

    service.removeSocket("socket-leader");
    expect(service.hasActivePlayback(roomId)).toBe(true);
    setNow(baseNowMs + 10_000);
    service.sweep();
    expect(service.hasActivePlayback(roomId)).toBe(false);
  });

  it("authorizes commands, returns strict snapshots, and deduplicates the original ACK", async () => {
    const { authorization, service } = setup();
    const leader = actor(1, "z-leader");
    const follower = actor(2, "a-follower");
    authorization.connect("socket-leader", leader);
    authorization.connect("socket-follower", follower);

    const created = await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(100)),
    });
    expect(created.ack).toMatchObject({
      accepted: true,
      playbackGroupId: uuid(100),
      groupRevision: 1,
      roomMediaRevision: 1,
    });

    const join = existingCommand("group.join", uuid(101), uuid(100), 1);
    const joined = await service.command({
      principal: follower.principal,
      socketId: "socket-follower",
      command: join,
    });
    expect(joined.snapshot!.groups[0]?.members).toHaveLength(2);
    const duplicate = await service.command({
      principal: follower.principal,
      socketId: "socket-follower",
      command: join,
    });
    expect(duplicate.ack).toEqual(joined.ack);
    expect(duplicate.snapshot!.groups[0]?.members).toHaveLength(2);
    expect(duplicate.snapshot!.roomMediaRevision).toBe(joined.snapshot!.roomMediaRevision);

    const intruder = actor(9, "intruder");
    authorization.connect("socket-intruder", intruder);
    authorization.blockedSockets.add("socket-intruder");
    const unauthorizedReplay = await service.command({
      principal: intruder.principal,
      socketId: "socket-intruder",
      command: createCommand(uuid(100)),
    });
    expect(unauthorizedReplay).toMatchObject({
      ack: { accepted: false, code: "DOCUMENT_UNAUTHORIZED" },
      snapshot: null,
    });
  });

  it("accepts heartbeats only from the current active leader document", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    const follower = actor(2);
    authorization.connect("socket-leader", leader);
    authorization.connect("socket-follower", follower);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(110)),
    });
    await service.command({
      principal: follower.principal,
      socketId: "socket-follower",
      command: existingCommand("group.join", uuid(111), uuid(110), 1),
    });

    const accepted = await service.heartbeat({
      principal: leader.principal,
      socketId: "socket-leader",
      heartbeat: heartbeat(uuid(110), 2, { positionMs: 50_000 }),
    });
    expect(accepted.ack).toMatchObject({ accepted: true, code: null });
    expect(accepted.snapshot!.groups[0]?.observed?.positionMs).toBe(50_000);

    const nonleader = await service.heartbeat({
      principal: follower.principal,
      socketId: "socket-follower",
      heartbeat: heartbeat(uuid(110), 2),
    });
    expect(nonleader.ack).toMatchObject({
      accepted: false,
      code: "NOT_GROUP_LEADER",
    });

    authorization.blockedSockets.add("socket-leader");
    const stale = await service.heartbeat({
      principal: leader.principal,
      socketId: "socket-leader",
      heartbeat: heartbeat(uuid(110), 2),
    });
    expect(stale.ack).toMatchObject({
      accepted: false,
      code: "DOCUMENT_UNAUTHORIZED",
      groupRevision: null,
    });
    expect(stale.snapshot).toBeNull();
  });

  it("keeps an authorization rejection idempotent after permission recovers", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);
    authorization.blockedSockets.add("socket-leader");
    const command = createCommand(uuid(109));

    await expect(
      service.command({
        principal: leader.principal,
        socketId: "socket-leader",
        command,
      }),
    ).resolves.toMatchObject({
      ack: { accepted: false, code: "DOCUMENT_UNAUTHORIZED" },
      snapshot: null,
    });
    authorization.blockedSockets.delete("socket-leader");

    await expect(
      service.command({
        principal: leader.principal,
        socketId: "socket-leader",
        command,
      }),
    ).resolves.toMatchObject({
      ack: { accepted: false, code: "DOCUMENT_UNAUTHORIZED" },
      snapshot: { groups: [] },
    });
  });

  it("redacts group authority when heartbeat target authorization fails without a group", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);

    await expect(
      service.heartbeat({
        principal: leader.principal,
        socketId: "socket-leader",
        heartbeat: heartbeat(uuid(119), 1, {
          target: {
            ...target,
            mediaKey: "youtube:9bZkp7q19f0",
          },
        }),
      }),
    ).resolves.toMatchObject({
      ack: {
        accepted: false,
        code: "TARGET_MISMATCH",
        groupRevision: null,
      },
      snapshot: null,
      events: [],
    });
  });

  it("bounds active device entries per room", async () => {
    const { authorization, service } = setup({ maxRoomDeviceEntries: 2 });
    const leader = actor(1);
    const firstFollower = actor(2);
    const secondFollower = actor(3);
    authorization.connect("socket-leader", leader);
    authorization.connect("socket-first", firstFollower);
    authorization.connect("socket-second", secondFollower);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(120)),
    });
    await service.command({
      principal: firstFollower.principal,
      socketId: "socket-first",
      command: existingCommand("group.join", uuid(121), uuid(120), 1),
    });
    const rejected = await service.command({
      principal: secondFollower.principal,
      socketId: "socket-second",
      command: existingCommand("group.join", uuid(122), uuid(120), 2),
    });
    expect(rejected.ack).toMatchObject({
      accepted: false,
      code: "GROUP_MEMBER_LIMIT_REACHED",
    });
    expect(rejected.snapshot!.groups[0]?.members).toHaveLength(2);
  });

  it("returns group-not-found when a target group closes during authorization", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    const follower = actor(2);
    authorization.connect("socket-leader", leader);
    authorization.connect("socket-follower", follower);
    const playbackGroupId = uuid(123);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(playbackGroupId),
    });

    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let markAuthorizationEntered!: () => void;
    const authorizationEntered = new Promise<void>((resolve) => {
      markAuthorizationEntered = resolve;
    });
    authorization.authorizationBarrier = {
      entered: markAuthorizationEntered,
      wait: authorizationReleased,
    };

    const joining = service.command({
      principal: follower.principal,
      socketId: "socket-follower",
      command: existingCommand("group.join", uuid(124), playbackGroupId, 1),
    });
    await authorizationEntered;
    authorization.authorizationBarrier = undefined;
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: existingCommand("group.close", uuid(125), playbackGroupId, 1),
    });
    releaseAuthorization();

    await expect(joining).resolves.toMatchObject({
      ack: {
        accepted: false,
        code: "GROUP_NOT_FOUND",
        playbackGroupId: null,
        groupRevision: null,
      },
      snapshot: { groups: [] },
      events: [],
    });
  });

  it("lets a leader approve a valid switch target without already being on that document", async () => {
    const value = setup();
    const { leader, playbackGroupId, proposalId } = await createPendingSwitchProposal(value, 126);

    const decided = await value.service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: existingCommand("proposal.decide", uuid(129), playbackGroupId, 2, {
        proposalId,
        decision: "APPROVE",
      }),
    });

    expect(decided.ack).toMatchObject({
      accepted: true,
      code: null,
      groupRevision: 3,
    });
    expect(decided.snapshot?.groups[0]).toMatchObject({
      target: secondTarget,
      proposals: [],
    });
  });

  it("rejects approval when a proposed switch target document has closed", async () => {
    const value = setup();
    const { leader, playbackGroupId, proposalId } = await createPendingSwitchProposal(value, 136);
    const { authorization, service } = value;
    authorization.closeDocument(secondTarget);

    const decided = await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: existingCommand("proposal.decide", uuid(139), playbackGroupId, 2, {
        proposalId,
        decision: "APPROVE",
      }),
    });

    expect(decided).toMatchObject({
      ack: {
        accepted: false,
        code: "DOCUMENT_UNAUTHORIZED",
      },
      snapshot: null,
      events: [],
    });
    expect(service.snapshot(roomId).groups[0]).toMatchObject({
      groupRevision: 2,
      target,
      proposals: [expect.objectContaining({ proposalId })],
    });

    const rejected = await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: existingCommand("proposal.decide", uuid(140), playbackGroupId, 2, {
        proposalId,
        decision: "REJECT",
      }),
    });
    expect(rejected.ack).toMatchObject({
      accepted: true,
      code: null,
      groupRevision: 2,
    });
    expect(rejected.snapshot?.groups[0]?.proposals).toEqual([]);
  });

  it("sorts groups, members, and proposals deterministically", async () => {
    const { authorization, service } = setup();
    const firstLeader = actor(1, "Zulu");
    const secondLeader = actor(2, "beta");
    const follower = actor(3, "alpha");
    authorization.connect("socket-first", firstLeader);
    authorization.connect("socket-second", secondLeader);
    authorization.connect("socket-follower", follower);
    await service.command({
      principal: firstLeader.principal,
      socketId: "socket-first",
      command: createCommand("00000000-0000-4000-8000-000000000020"),
    });
    await service.command({
      principal: secondLeader.principal,
      socketId: "socket-second",
      command: createCommand("00000000-0000-4000-8000-000000000010"),
    });
    await service.command({
      principal: follower.principal,
      socketId: "socket-follower",
      command: existingCommand("group.join", uuid(131), "00000000-0000-4000-8000-000000000020", 1),
    });
    await service.command({
      principal: follower.principal,
      socketId: "socket-follower",
      command: existingCommand(
        "proposal.create",
        uuid(132),
        "00000000-0000-4000-8000-000000000020",
        2,
        { action: { type: "PAUSE" } },
      ),
    });

    const snapshot = service.snapshot(roomId);
    expect(snapshot.groups.map((group) => group.playbackGroupId)).toEqual([
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]);
    expect(snapshot.groups[1]?.members.map((member) => member.username)).toEqual(["Zulu", "alpha"]);
    expect(snapshot.groups[1]?.proposals).toHaveLength(1);
  });

  it("keeps follower membership, starts leader grace, and closes exactly at expiry", async () => {
    const { authorization, service, setNow } = setup();
    const leader = actor(1);
    const follower = actor(2);
    authorization.connect("socket-leader", leader);
    authorization.connect("socket-follower", follower);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(140)),
    });
    await service.command({
      principal: follower.principal,
      socketId: "socket-follower",
      command: existingCommand("group.join", uuid(141), uuid(140), 1),
    });

    expect(service.removeSocket("socket-follower")[0]?.groups[0]).toMatchObject({
      status: "PLAYING",
      members: [
        expect.objectContaining({ userId: leader.principal.userId, online: true }),
        expect.objectContaining({ userId: follower.principal.userId, online: false }),
      ],
    });
    const leaderRemoved = service.removeSocket("socket-leader")[0]!;
    expect(leaderRemoved.groups[0]).toMatchObject({
      status: "LEADER_GRACE",
      leaderGraceExpiresAtServerMs: baseNowMs + 10_000,
    });

    setNow(baseNowMs + 9_999);
    expect(service.sweep()).toEqual([]);
    setNow(baseNowMs + 10_000);
    expect(service.sweep()[0]).toMatchObject({ roomId, groups: [] });
  });

  it("expires leader grace before a later socket event can mutate the stale group", async () => {
    const { authorization, service, setNow } = setup();
    const leader = actor(1);
    const follower = actor(2);
    authorization.connect("socket-leader", leader);
    authorization.connect("socket-follower", follower);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(144)),
    });
    await service.command({
      principal: follower.principal,
      socketId: "socket-follower",
      command: existingCommand("group.join", uuid(145), uuid(144), 1),
    });
    expect(service.removeSocket("socket-leader")[0]?.groups[0]?.status).toBe("LEADER_GRACE");

    setNow(baseNowMs + 10_001);
    expect(service.removeSocket("socket-follower")).toEqual([
      expect.objectContaining({
        roomId,
        groups: [],
      }),
    ]);
    expect(service.snapshot(roomId).groups).toEqual([]);
  });

  it("restores the same leader account/device through room reconnect", async () => {
    const { authorization, service, setNow } = setup();
    const leader = actor(1);
    authorization.connect("socket-old", leader);
    await service.command({
      principal: leader.principal,
      socketId: "socket-old",
      command: createCommand(uuid(145)),
    });
    service.removeSocket("socket-old");

    setNow(baseNowMs + 9_999);
    authorization.connect("socket-new", leader);
    expect(
      (
        await service.connect({
          principal: leader.principal,
          socketId: "socket-new",
          roomId,
        })
      ).groups[0],
    ).toMatchObject({
      status: "PLAYING",
      leaderGraceExpiresAtServerMs: null,
      members: [expect.objectContaining({ online: true })],
    });
    setNow(baseNowMs + 20_000);
    expect(service.sweep()).toEqual([]);
  });

  it("does not reconnect a device when disconnect wins an in-flight authorization", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(146)),
    });

    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let markAuthorizationEntered!: () => void;
    const authorizationEntered = new Promise<void>((resolve) => {
      markAuthorizationEntered = resolve;
    });
    authorization.authorizationBarrier = {
      entered: markAuthorizationEntered,
      wait: authorizationReleased,
    };

    const reconnecting = service.connect({
      principal: leader.principal,
      socketId: "socket-leader",
      roomId,
    });
    await authorizationEntered;
    expect(service.removeSocket("socket-leader")[0]?.groups[0]).toMatchObject({
      status: "LEADER_GRACE",
      members: [expect.objectContaining({ online: false })],
    });
    releaseAuthorization();

    await expect(reconnecting).rejects.toMatchObject({ code: "MEDIA_OFFLINE" });
    expect(service.snapshot(roomId).groups[0]).toMatchObject({
      status: "LEADER_GRACE",
      members: [expect.objectContaining({ online: false })],
    });
  });

  it("does not apply an old-room command when a room switch wins authorization", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);

    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let markAuthorizationEntered!: () => void;
    const authorizationEntered = new Promise<void>((resolve) => {
      markAuthorizationEntered = resolve;
    });
    authorization.authorizationBarrier = {
      entered: markAuthorizationEntered,
      wait: authorizationReleased,
    };

    const creating = service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(147)),
    });
    await authorizationEntered;
    expect(service.leaveSocket("socket-leader")).toEqual([]);
    releaseAuthorization();

    await expect(creating).resolves.toMatchObject({
      ack: {
        accepted: false,
        code: "MEDIA_OFFLINE",
        playbackGroupId: null,
        groupRevision: null,
      },
      snapshot: null,
      events: [],
    });
    expect(service.snapshot(roomId).groups).toEqual([]);
  });

  it("clears groups only after Presence reports the room fully offline", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(150)),
    });
    expect(service.removeRoomIfOffline(roomId)).toBeNull();
    expect(service.snapshot(roomId).groups).toHaveLength(1);

    authorization.roomOnline = false;
    expect(service.removeRoomIfOffline(roomId)).toMatchObject({ roomId, groups: [] });
    expect(service.snapshot(roomId).groups).toEqual([]);
  });

  it("closes and forgets groups after the durable room is deleted", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);
    await service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(155)),
    });

    authorization.roomActive = false;

    await expect(service.removeInactiveRooms()).resolves.toEqual([
      expect.objectContaining({ roomId, groups: [] }),
    ]);
    expect(service.snapshot(roomId)).toMatchObject({
      roomId,
      roomMediaRevision: 0,
      groups: [],
    });
  });

  it("does not recreate a group when room deletion wins in-flight authorization", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);
    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let markAuthorizationEntered!: () => void;
    const authorizationEntered = new Promise<void>((resolve) => {
      markAuthorizationEntered = resolve;
    });
    authorization.authorizationBarrier = {
      entered: markAuthorizationEntered,
      wait: authorizationReleased,
    };

    const creating = service.command({
      principal: leader.principal,
      socketId: "socket-leader",
      command: createCommand(uuid(156)),
    });
    await authorizationEntered;
    authorization.roomActive = false;
    expect(service.closeRoom(roomId)).toBeNull();
    releaseAuthorization();

    await expect(creating).resolves.toMatchObject({
      ack: {
        accepted: false,
        code: "DOCUMENT_UNAUTHORIZED",
        playbackGroupId: null,
        groupRevision: null,
      },
      snapshot: null,
      events: [],
    });
    expect(service.snapshot(roomId).groups).toEqual([]);
  });

  it("rejects malformed input before authorization", async () => {
    const { authorization, service } = setup();
    const leader = actor(1);
    authorization.connect("socket-leader", leader);
    await expect(
      service.command({
        principal: leader.principal,
        socketId: "socket-leader",
        command: { ...createCommand(uuid(160)), userId: leader.principal.userId },
      }),
    ).rejects.toMatchObject({ code: "INVALID_MEDIA_MESSAGE" });
    expect(authorization.blockedSockets).toEqual(new Set());
  });
});
