import {
  applyLeaderHeartbeat,
  applyMediaCommand,
  clearOfflineRoom,
  createEmptyRoomMediaState,
  disconnectActiveDevice,
  expireLeaderGrace,
  expireProposals,
  getPlaybackGroup,
  reconnectActiveDevice,
  type MediaActor,
  type MediaDomainEvent,
  type RoomMediaState,
} from "@syncaction/media";
import {
  MediaCommandAckSchema,
  MediaCommandSchema,
  MediaErrorCodeSchema,
  MediaGroupsSnapshotMessageSchema,
  MediaHeartbeatAckSchema,
  MediaHeartbeatSchema,
  RoomIdSchema,
  type MediaCommand,
  type MediaCommandAck,
  type MediaErrorCode,
  type MediaGroupsSnapshotMessage,
  type MediaHeartbeat,
  type MediaHeartbeatAck,
  type MediaTarget,
  type PlaybackGroupSnapshot,
  type PresenceRecord,
} from "@syncaction/protocol";
import { MediaServiceError, type DocumentAuthorizationPort } from "./document-authorization.js";
import type { PresencePrincipal } from "./presence-service.js";

const COMMAND_CACHE_SIZE = 512;
const MAX_ROOM_DEVICE_ENTRIES = 256;

interface SocketBinding extends MediaActor {
  readonly socketId: string;
  readonly roomId: string;
}

interface RoomCommandLifecycle {
  generation: number;
  inFlight: number;
}

interface RoomCommandGuard {
  readonly generation: number;
  readonly lifecycle: RoomCommandLifecycle;
  readonly roomId: string;
}

export interface RoomMediaGroupServiceOptions {
  authorization: DocumentAuthorizationPort;
  now?: () => number;
  maxRoomDeviceEntries?: number;
}

export interface MediaCommandResult {
  readonly ack: MediaCommandAck;
  readonly snapshot: MediaGroupsSnapshotMessage | null;
  readonly events: readonly MediaDomainEvent[];
}

export interface MediaHeartbeatResult {
  readonly ack: MediaHeartbeatAck;
  readonly snapshot: MediaGroupsSnapshotMessage | null;
  readonly events: readonly MediaDomainEvent[];
}

export class RoomMediaGroupService {
  readonly #authorization: DocumentAuthorizationPort;
  readonly #now: () => number;
  readonly #maxRoomDeviceEntries: number;
  readonly #states = new Map<string, RoomMediaState>();
  readonly #commandResults = new Map<string, Map<string, MediaCommandAck>>();
  readonly #bindingsBySocket = new Map<string, SocketBinding>();
  readonly #activeSocketByIdentity = new Map<string, string>();
  readonly #activeSocketTokens = new Map<string, object>();
  readonly #roomCommandLifecycles = new Map<string, RoomCommandLifecycle>();

  public constructor(options: RoomMediaGroupServiceOptions) {
    this.#authorization = options.authorization;
    this.#now = options.now ?? Date.now;
    this.#maxRoomDeviceEntries = options.maxRoomDeviceEntries ?? MAX_ROOM_DEVICE_ENTRIES;
    if (
      !Number.isSafeInteger(this.#maxRoomDeviceEntries) ||
      this.#maxRoomDeviceEntries < 1 ||
      this.#maxRoomDeviceEntries > MAX_ROOM_DEVICE_ENTRIES
    ) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE");
    }
  }

  public registerSocket(socketIdInput: unknown): void {
    const socketId = parseSocketId(socketIdInput);
    if (!this.#activeSocketTokens.has(socketId)) {
      this.#activeSocketTokens.set(socketId, {});
    }
  }

  public async command(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    command: unknown;
  }): Promise<MediaCommandResult> {
    const commandResult = MediaCommandSchema.safeParse(input.command);
    if (!commandResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: commandResult.error,
      });
    }
    const socketId = parseSocketId(input.socketId);
    const socketToken = this.#activeSocketToken(socketId);
    const command = commandResult.data;
    const commandGuard = this.#beginRoomCommand(command.roomId);
    try {
      let state = this.#state(command.roomId);
      const authorizedTarget = targetRequiredByCommand(command, state);
      let member: PresenceRecord;
      try {
        member = await this.#authorizeCommand(input.principal, socketId, command, state);
        if (
          !(await this.#authorization.isRoomActive(command.roomId)) ||
          !this.#roomCommandIsCurrent(commandGuard)
        ) {
          throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
        }
      } catch (cause) {
        state = this.#state(command.roomId);
        const code = this.#socketIsActive(socketId, socketToken)
          ? mediaErrorCode(cause, "DOCUMENT_UNAUTHORIZED")
          : "MEDIA_OFFLINE";
        const ack = this.#rejectedCommandAck(command, state, code, false);
        if (code !== "MEDIA_OFFLINE" && this.#roomCommandIsCurrent(commandGuard)) {
          this.#cacheCommandAck(ack);
        }
        return { ack, snapshot: null, events: [] };
      }
      if (!this.#socketIsActive(socketId, socketToken)) {
        const ack = this.#rejectedCommandAck(
          command,
          this.#state(command.roomId),
          "MEDIA_OFFLINE",
          false,
        );
        return { ack, snapshot: null, events: [] };
      }
      this.#bind(socketId, command.roomId, member);
      const nowMs = this.#nowMs();
      const temporalChange = this.#expireLeaderGraceForRoom(command.roomId, nowMs);
      state = temporalChange.state;
      const cached = this.#commandResults.get(command.roomId)?.get(command.commandId);
      if (cached !== undefined) {
        return {
          ack: cached,
          snapshot: this.snapshot(command.roomId),
          events: temporalChange.events,
        };
      }

      if (!targetsEquivalent(authorizedTarget, targetRequiredByCommand(command, state))) {
        const code =
          command.type !== "group.create" &&
          getPlaybackGroup(state, command.playbackGroupId) === undefined
            ? "GROUP_NOT_FOUND"
            : "GROUP_REVISION_CONFLICT";
        const ack = this.#rejectedCommandAck(command, state, code);
        this.#cacheCommandAck(ack);
        return {
          ack,
          snapshot: this.snapshot(command.roomId),
          events: temporalChange.events,
        };
      }

      if (
        (command.type === "group.create" || command.type === "group.join") &&
        !state.groups.some((group) =>
          group.members.some((candidate) => candidate.userId === member.userId),
        ) &&
        roomDeviceEntryCount(state) >= this.#maxRoomDeviceEntries
      ) {
        const ack = this.#rejectedCommandAck(command, state, "GROUP_MEMBER_LIMIT_REACHED");
        this.#cacheCommandAck(ack);
        return {
          ack,
          snapshot: this.snapshot(command.roomId),
          events: temporalChange.events,
        };
      }

      const transition = applyMediaCommand(state, command, toActor(member), nowMs);
      if (transition.state !== state) {
        this.#states.set(command.roomId, transition.state);
      }
      const ack = transition.outcome.ok
        ? MediaCommandAckSchema.parse({
            type: "media.command.ack",
            protocolVersion: 1,
            commandId: command.commandId,
            roomId: command.roomId,
            accepted: true,
            code: null,
            playbackGroupId: transition.outcome.playbackGroupId,
            groupRevision: transition.outcome.groupRevision,
            roomMediaRevision: transition.state.roomMediaRevision,
          })
        : this.#rejectedCommandAck(command, transition.state, transition.outcome.code);
      this.#cacheCommandAck(ack);
      return {
        ack,
        snapshot: this.snapshot(command.roomId),
        events: [...temporalChange.events, ...transition.events],
      };
    } finally {
      this.#finishRoomCommand(commandGuard);
    }
  }

  public async heartbeat(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    heartbeat: unknown;
  }): Promise<MediaHeartbeatResult> {
    const heartbeatResult = MediaHeartbeatSchema.safeParse(input.heartbeat);
    if (!heartbeatResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: heartbeatResult.error,
      });
    }
    const socketId = parseSocketId(input.socketId);
    const socketToken = this.#activeSocketToken(socketId);
    const heartbeat = heartbeatResult.data;
    let state: RoomMediaState;

    let member: PresenceRecord;
    try {
      const authorized = await this.#authorization.authorize({
        principal: input.principal,
        socketId,
        roomId: heartbeat.roomId,
        logicalTabId: heartbeat.target.logicalTabId,
        documentRevision: heartbeat.target.documentRevision,
        target: heartbeat.target,
      });
      member = authorized.member;
    } catch (cause) {
      state = this.#state(heartbeat.roomId);
      const ack = this.#heartbeatAck(
        heartbeat,
        state,
        false,
        this.#socketIsActive(socketId, socketToken)
          ? mediaErrorCode(cause, "DOCUMENT_UNAUTHORIZED")
          : "MEDIA_OFFLINE",
      );
      return { ack, snapshot: null, events: [] };
    }
    if (!this.#socketIsActive(socketId, socketToken)) {
      state = this.#state(heartbeat.roomId);
      return {
        ack: this.#heartbeatAck(heartbeat, state, false, "MEDIA_OFFLINE"),
        snapshot: null,
        events: [],
      };
    }
    this.#bind(socketId, heartbeat.roomId, member);
    const nowMs = this.#nowMs();
    const temporalChange = this.#expireLeaderGraceForRoom(heartbeat.roomId, nowMs);
    state = temporalChange.state;

    const transition = applyLeaderHeartbeat(state, heartbeat, toActor(member), nowMs);
    if (transition.state !== state) {
      this.#states.set(heartbeat.roomId, transition.state);
    }
    const ack = this.#heartbeatAck(
      heartbeat,
      transition.state,
      transition.outcome.ok,
      transition.outcome.ok ? null : transition.outcome.code,
    );
    return {
      ack,
      snapshot: this.snapshot(heartbeat.roomId),
      events: [...temporalChange.events, ...transition.events],
    };
  }

  public async connect(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
  }): Promise<MediaGroupsSnapshotMessage> {
    const socketId = parseSocketId(input.socketId);
    const socketToken = this.#activeSocketToken(socketId);
    const roomIdResult = RoomIdSchema.safeParse(input.roomId);
    if (!roomIdResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: roomIdResult.error,
      });
    }
    const roomId = roomIdResult.data;
    let member: PresenceRecord;
    try {
      member = await this.#authorization.authorizeRoom({
        principal: input.principal,
        socketId,
        roomId,
      });
    } catch (cause) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED", { cause });
    }
    if (!this.#socketIsActive(socketId, socketToken)) {
      throw new MediaServiceError("MEDIA_OFFLINE");
    }
    this.#bind(socketId, roomId, member);
    const nowMs = this.#nowMs();
    const temporalChange = this.#expireLeaderGraceForRoom(roomId, nowMs);
    const state = temporalChange.state;
    const change = reconnectActiveDevice(state, toActor(member), nowMs);
    if (change.state !== state) {
      this.#states.set(roomId, change.state);
    }
    return this.snapshot(roomId);
  }

  public snapshot(roomIdInput: unknown): MediaGroupsSnapshotMessage {
    const roomIdResult = RoomIdSchema.safeParse(roomIdInput);
    if (!roomIdResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: roomIdResult.error,
      });
    }
    const roomId = roomIdResult.data;
    const state = this.#state(roomId);
    return MediaGroupsSnapshotMessageSchema.parse({
      type: "media.groups.snapshot",
      protocolVersion: 1,
      roomId,
      roomMediaRevision: state.roomMediaRevision,
      groups: state.groups.map(sortedGroup).sort(compareGroups),
    });
  }

  public hasActivePlayback(roomIdInput: unknown): boolean {
    const roomIdResult = RoomIdSchema.safeParse(roomIdInput);
    if (!roomIdResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: roomIdResult.error,
      });
    }
    const state = this.#states.get(roomIdResult.data);
    return (
      state?.groups.some(
        (group) => group.target !== null && group.observed !== null && !group.observed.ended,
      ) ?? false
    );
  }

  public removeSocket(socketIdInput: unknown): MediaGroupsSnapshotMessage[] {
    const socketId = parseSocketId(socketIdInput);
    this.#activeSocketTokens.delete(socketId);
    return this.#removeBinding(socketId);
  }

  public leaveSocket(socketIdInput: unknown): MediaGroupsSnapshotMessage[] {
    const socketId = parseSocketId(socketIdInput);
    if (this.#activeSocketTokens.has(socketId)) {
      this.#activeSocketTokens.set(socketId, {});
    }
    return this.#removeBinding(socketId);
  }

  #removeBinding(socketId: string): MediaGroupsSnapshotMessage[] {
    const binding = this.#bindingsBySocket.get(socketId);
    if (binding === undefined) {
      return [];
    }
    this.#bindingsBySocket.delete(socketId);
    const identity = bindingIdentity(binding.roomId, binding.userId, binding.deviceId);
    if (this.#activeSocketByIdentity.get(identity) !== socketId) {
      return [];
    }
    this.#activeSocketByIdentity.delete(identity);

    const nowMs = this.#nowMs();
    const initialState = this.#state(binding.roomId);
    const temporalChange = this.#expireLeaderGraceForRoom(binding.roomId, nowMs);
    const change = disconnectActiveDevice(temporalChange.state, binding, nowMs);
    if (change.state === initialState) {
      return [];
    }
    if (change.state !== temporalChange.state) {
      this.#states.set(binding.roomId, change.state);
    }
    return [this.snapshot(binding.roomId)];
  }

  public sweep(): MediaGroupsSnapshotMessage[] {
    const nowMs = this.#nowMs();
    const affectedRooms: string[] = [];
    for (const [roomId] of this.#states) {
      const graceChange = this.#expireLeaderGraceForRoom(roomId, nowMs);
      const proposalChange = expireProposals(graceChange.state, nowMs);
      if (proposalChange.state !== graceChange.state) {
        this.#states.set(roomId, proposalChange.state);
      }
      if (graceChange.events.length > 0 || proposalChange.events.length > 0) {
        affectedRooms.push(roomId);
      }
    }
    return affectedRooms.sort().map((roomId) => this.snapshot(roomId));
  }

  public removeRoomIfOffline(roomIdInput: unknown): MediaGroupsSnapshotMessage | null {
    const roomIdResult = RoomIdSchema.safeParse(roomIdInput);
    if (!roomIdResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: roomIdResult.error,
      });
    }
    const roomId = roomIdResult.data;
    if (this.#authorization.hasRoomEntries(roomId)) {
      return null;
    }
    return this.closeRoom(roomId);
  }

  public closeRoom(roomIdInput: unknown): MediaGroupsSnapshotMessage | null {
    const roomIdResult = RoomIdSchema.safeParse(roomIdInput);
    if (!roomIdResult.success) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
        cause: roomIdResult.error,
      });
    }
    const roomId = roomIdResult.data;
    this.#invalidateRoomCommands(roomId);
    const state = this.#state(roomId);
    const change = clearOfflineRoom(state);
    if (change.state === state) {
      this.#deleteRoomEphemera(roomId);
      return null;
    }
    this.#states.set(roomId, change.state);
    const snapshot = this.snapshot(roomId);
    this.#deleteRoomEphemera(roomId);
    return snapshot;
  }

  public async removeInactiveRooms(): Promise<MediaGroupsSnapshotMessage[]> {
    const snapshots: MediaGroupsSnapshotMessage[] = [];
    for (const roomId of [...this.#states.keys()].sort()) {
      if (!(await this.#authorization.isRoomActive(roomId))) {
        const snapshot = this.closeRoom(roomId);
        if (snapshot !== null) {
          snapshots.push(snapshot);
        }
      }
    }
    return snapshots;
  }

  async #authorizeCommand(
    principal: PresencePrincipal,
    socketId: string,
    command: MediaCommand,
    state: RoomMediaState,
  ): Promise<PresenceRecord> {
    const target = targetRequiredByCommand(command, state);
    if (target === undefined) {
      return await this.#authorization.authorizeRoom({
        principal,
        socketId,
        roomId: command.roomId,
      });
    }
    const authorizationInput = {
      principal,
      socketId,
      roomId: command.roomId,
      logicalTabId: target.logicalTabId,
      documentRevision: target.documentRevision,
      target,
    };
    const authorized =
      command.type === "proposal.decide" && command.decision === "APPROVE"
        ? await this.#authorization.authorizeRoomDocument(authorizationInput)
        : await this.#authorization.authorize(authorizationInput);
    return authorized.member;
  }

  #state(roomId: string): RoomMediaState {
    return this.#states.get(roomId) ?? createEmptyRoomMediaState(roomId);
  }

  #expireLeaderGraceForRoom(
    roomId: string,
    nowMs: number,
  ): { state: RoomMediaState; events: readonly MediaDomainEvent[] } {
    const state = this.#state(roomId);
    const change = expireLeaderGrace(state, nowMs);
    if (change.state !== state) {
      this.#states.set(roomId, change.state);
    }
    return change;
  }

  #rejectedCommandAck(
    command: MediaCommand,
    state: RoomMediaState,
    code: MediaErrorCode,
    exposeGroupAuthority = true,
  ): MediaCommandAck {
    const playbackGroupId = command.type === "group.create" ? null : command.playbackGroupId;
    const group =
      exposeGroupAuthority && playbackGroupId !== null
        ? getPlaybackGroup(state, playbackGroupId)
        : undefined;
    return MediaCommandAckSchema.parse({
      type: "media.command.ack",
      protocolVersion: 1,
      commandId: command.commandId,
      roomId: command.roomId,
      accepted: false,
      code,
      playbackGroupId: group?.playbackGroupId ?? null,
      groupRevision: group?.groupRevision ?? null,
      roomMediaRevision: state.roomMediaRevision,
    });
  }

  #heartbeatAck(
    heartbeat: MediaHeartbeat,
    state: RoomMediaState,
    accepted: boolean,
    code: MediaErrorCode | null,
  ): MediaHeartbeatAck {
    const group = getPlaybackGroup(state, heartbeat.playbackGroupId);
    const exposesGroupAuthority =
      accepted ||
      code === "TARGET_MISMATCH" ||
      code === "GROUP_REVISION_CONFLICT" ||
      code === "NOT_GROUP_MEMBER" ||
      code === "NOT_GROUP_LEADER" ||
      code === "LEADER_DEVICE_REQUIRED";
    return MediaHeartbeatAckSchema.parse({
      type: "media.heartbeat.ack",
      protocolVersion: 1,
      roomId: heartbeat.roomId,
      playbackGroupId: heartbeat.playbackGroupId,
      accepted,
      code,
      groupRevision: exposesGroupAuthority ? (group?.groupRevision ?? null) : null,
      roomMediaRevision: state.roomMediaRevision,
    });
  }

  #cacheCommandAck(ack: MediaCommandAck): void {
    let roomCache = this.#commandResults.get(ack.roomId);
    if (roomCache === undefined) {
      roomCache = new Map();
      this.#commandResults.set(ack.roomId, roomCache);
    }
    if (roomCache.has(ack.commandId)) {
      return;
    }
    roomCache.set(ack.commandId, ack);
    if (roomCache.size > COMMAND_CACHE_SIZE) {
      const oldest = roomCache.keys().next().value;
      if (oldest !== undefined) {
        roomCache.delete(oldest);
      }
    }
  }

  #bind(socketId: string, roomId: string, member: PresenceRecord): void {
    const previous = this.#bindingsBySocket.get(socketId);
    if (previous !== undefined) {
      const previousIdentity = bindingIdentity(previous.roomId, previous.userId, previous.deviceId);
      if (this.#activeSocketByIdentity.get(previousIdentity) === socketId) {
        this.#activeSocketByIdentity.delete(previousIdentity);
      }
    }

    const identity = bindingIdentity(roomId, member.userId, member.deviceId);
    const replacedSocket = this.#activeSocketByIdentity.get(identity);
    if (replacedSocket !== undefined && replacedSocket !== socketId) {
      this.#bindingsBySocket.delete(replacedSocket);
    }
    const binding: SocketBinding = {
      socketId,
      roomId,
      ...toActor(member),
    };
    this.#bindingsBySocket.set(socketId, binding);
    this.#activeSocketByIdentity.set(identity, socketId);
  }

  #activeSocketToken(socketId: string): object {
    const token = this.#activeSocketTokens.get(socketId);
    if (token === undefined) {
      throw new MediaServiceError("MEDIA_OFFLINE");
    }
    return token;
  }

  #socketIsActive(socketId: string, token: object): boolean {
    return this.#activeSocketTokens.get(socketId) === token;
  }

  #beginRoomCommand(roomId: string): RoomCommandGuard {
    let lifecycle = this.#roomCommandLifecycles.get(roomId);
    if (lifecycle === undefined) {
      lifecycle = { generation: 0, inFlight: 0 };
      this.#roomCommandLifecycles.set(roomId, lifecycle);
    }
    lifecycle.inFlight += 1;
    return {
      generation: lifecycle.generation,
      lifecycle,
      roomId,
    };
  }

  #roomCommandIsCurrent(guard: RoomCommandGuard): boolean {
    return (
      this.#roomCommandLifecycles.get(guard.roomId) === guard.lifecycle &&
      guard.lifecycle.generation === guard.generation
    );
  }

  #finishRoomCommand(guard: RoomCommandGuard): void {
    guard.lifecycle.inFlight -= 1;
    if (
      guard.lifecycle.inFlight === 0 &&
      this.#roomCommandLifecycles.get(guard.roomId) === guard.lifecycle
    ) {
      this.#roomCommandLifecycles.delete(guard.roomId);
    }
  }

  #invalidateRoomCommands(roomId: string): void {
    const lifecycle = this.#roomCommandLifecycles.get(roomId);
    if (lifecycle !== undefined) {
      lifecycle.generation += 1;
    }
  }

  #deleteRoomEphemera(roomId: string): void {
    this.#states.delete(roomId);
    this.#commandResults.delete(roomId);
    for (const [socketId, binding] of this.#bindingsBySocket) {
      if (binding.roomId === roomId) {
        this.#bindingsBySocket.delete(socketId);
        const identity = bindingIdentity(roomId, binding.userId, binding.deviceId);
        if (this.#activeSocketByIdentity.get(identity) === socketId) {
          this.#activeSocketByIdentity.delete(identity);
        }
      }
    }
  }

  #nowMs(): number {
    const nowMs = this.#now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
      throw new MediaServiceError("INVALID_MEDIA_MESSAGE");
    }
    return nowMs;
  }
}

function parseSocketId(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 256) {
    throw new MediaServiceError("INVALID_MEDIA_MESSAGE");
  }
  return input;
}

function toActor(member: PresenceRecord): MediaActor {
  return {
    userId: member.userId,
    deviceId: member.deviceId,
    username: member.username,
    displayName: member.displayName,
  };
}

function mediaErrorCode(cause: unknown, fallback: MediaErrorCode): MediaErrorCode {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    const parsed = MediaErrorCodeSchema.safeParse(cause.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return fallback;
}

function targetRequiredByCommand(
  command: MediaCommand,
  state: RoomMediaState,
): MediaTarget | undefined {
  switch (command.type) {
    case "group.create":
    case "group.switch-target":
      return command.target ?? undefined;
    case "group.join":
      return getPlaybackGroup(state, command.playbackGroupId)?.target ?? undefined;
    case "proposal.create":
      return command.action.type === "SWITCH_TARGET"
        ? command.action.target
        : (getPlaybackGroup(state, command.playbackGroupId)?.target ?? undefined);
    case "proposal.decide": {
      if (command.decision !== "APPROVE") {
        return undefined;
      }
      const group = getPlaybackGroup(state, command.playbackGroupId);
      const proposal = group?.proposals.find(
        (candidate) => candidate.proposalId === command.proposalId,
      );
      if (proposal?.action.type === "SWITCH_TARGET") {
        return proposal.action.target;
      }
      return group?.target ?? undefined;
    }
    case "group.leave":
    case "group.takeover":
    case "group.transfer-leader":
    case "group.close":
      return undefined;
  }
}

function targetsEquivalent(left: MediaTarget | undefined, right: MediaTarget | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
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

function roomDeviceEntryCount(state: RoomMediaState): number {
  return state.groups.reduce((count, group) => count + group.members.length, 0);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedGroup(group: PlaybackGroupSnapshot): PlaybackGroupSnapshot {
  return {
    ...group,
    members: [...group.members].sort(
      (left, right) =>
        compareCodeUnits(left.username, right.username) ||
        compareCodeUnits(left.userId, right.userId) ||
        compareCodeUnits(left.activeDeviceId, right.activeDeviceId),
    ),
    proposals: [...group.proposals].sort(
      (left, right) =>
        left.createdAtServerMs - right.createdAtServerMs ||
        compareCodeUnits(left.proposalId, right.proposalId),
    ),
  };
}

function compareGroups(left: PlaybackGroupSnapshot, right: PlaybackGroupSnapshot): number {
  return compareCodeUnits(left.playbackGroupId, right.playbackGroupId);
}

function bindingIdentity(roomId: string, userId: string, deviceId: string): string {
  return `${roomId}:${userId}:${deviceId}`;
}
