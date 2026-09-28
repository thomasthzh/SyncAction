import {
  MediaCommandSchema,
  MediaHeartbeatSchema,
  type MediaCommand,
  type MediaCommandAck,
  type MediaHeartbeat,
  type MediaObservedState,
  type MediaTarget,
  type PlaybackAction,
  type PlaybackGroupSnapshot,
  type RoomId,
} from "@syncaction/protocol";
import { predictMediaObservation } from "./media-controller-correction.js";

export type ExistingMediaCommandPayload =
  | { type: "group.join" }
  | { type: "group.leave" }
  | { type: "group.takeover" }
  | {
      type: "group.transfer-leader";
      targetUserId: string;
      targetDeviceId: string;
    }
  | {
      type: "group.switch-target";
      target: MediaTarget;
      observed: MediaObservedState;
    }
  | { type: "group.close" }
  | { type: "proposal.create"; action: PlaybackAction }
  | {
      type: "proposal.decide";
      proposalId: string;
      decision: "APPROVE" | "REJECT";
    };

export function buildMediaCreateCommand(input: {
  roomId: RoomId;
  commandId: string;
  target: MediaTarget | null;
  observed: MediaObservedState | null;
}): MediaCommand {
  return MediaCommandSchema.parse({
    type: "group.create",
    protocolVersion: 1,
    ...input,
  });
}

export function buildExistingMediaCommand(input: {
  roomId: RoomId;
  commandId: string;
  group: PlaybackGroupSnapshot;
  payload: ExistingMediaCommandPayload;
}): MediaCommand {
  return MediaCommandSchema.parse({
    ...input.payload,
    protocolVersion: 1,
    commandId: input.commandId,
    roomId: input.roomId,
    playbackGroupId: input.group.playbackGroupId,
    expectedGroupRevision: input.group.groupRevision,
  });
}

export function buildMediaHeartbeat(input: {
  roomId: RoomId;
  group: PlaybackGroupSnapshot;
  target: MediaTarget;
  observed: MediaObservedState;
  nowMs: number;
}): MediaHeartbeat {
  return MediaHeartbeatSchema.parse({
    type: "media.heartbeat",
    protocolVersion: 1,
    roomId: input.roomId,
    playbackGroupId: input.group.playbackGroupId,
    groupRevision: input.group.groupRevision,
    target: input.target,
    ...predictMediaObservation(input.observed, input.target, input.nowMs),
  });
}

export function isCurrentMediaCommandAck(input: {
  command: MediaCommand;
  acknowledgement: MediaCommandAck;
  roomId: RoomId;
  currentRoomRevision: number;
  currentGroupRevision: number | null;
}): boolean {
  return !(
    input.acknowledgement.commandId !== input.command.commandId ||
    input.acknowledgement.roomId !== input.roomId ||
    input.acknowledgement.roomMediaRevision < input.currentRoomRevision ||
    (input.acknowledgement.groupRevision !== null &&
      input.currentGroupRevision !== null &&
      input.acknowledgement.groupRevision < input.currentGroupRevision)
  );
}
