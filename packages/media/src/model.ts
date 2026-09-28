import type { MediaErrorCode, PlaybackGroupSnapshot, RoomId } from "@syncaction/protocol";

export interface MediaActor {
  readonly userId: string;
  readonly deviceId: string;
  readonly username: string;
  readonly displayName: string;
}

export interface RoomMediaState {
  readonly roomId: RoomId | string;
  readonly roomMediaRevision: number;
  readonly groups: readonly PlaybackGroupSnapshot[];
}

export type MediaDomainEvent =
  | {
      readonly type: "GROUP_CREATED";
      readonly playbackGroupId: string;
    }
  | {
      readonly type: "GROUP_CHANGED";
      readonly playbackGroupId: string;
    }
  | {
      readonly type: "PROPOSAL_CREATED";
      readonly playbackGroupId: string;
      readonly proposalId: string;
    }
  | {
      readonly type: "PROPOSAL_DECIDED";
      readonly playbackGroupId: string;
      readonly proposalId: string;
      readonly decision: "APPROVE" | "REJECT";
    }
  | {
      readonly type: "GROUP_CLOSED";
      readonly playbackGroupId: string;
      readonly reason:
        | "LEADER_CLOSED"
        | "LEADER_LEFT"
        | "LAST_MEMBER_LEFT"
        | "LEADER_GRACE_EXPIRED"
        | "ROOM_OFFLINE";
    };

export type MediaTransitionOutcome =
  | {
      readonly ok: true;
      readonly playbackGroupId: string;
      readonly groupRevision: number;
    }
  | {
      readonly ok: false;
      readonly code: MediaErrorCode;
    };

export interface MediaTransition {
  readonly state: RoomMediaState;
  readonly events: readonly MediaDomainEvent[];
  readonly outcome: MediaTransitionOutcome;
}

export interface MediaStateChange {
  readonly state: RoomMediaState;
  readonly events: readonly MediaDomainEvent[];
}

export function createEmptyRoomMediaState(roomId: RoomId | string): RoomMediaState {
  return {
    roomId,
    roomMediaRevision: 0,
    groups: [],
  };
}

export function getPlaybackGroup(
  state: RoomMediaState,
  playbackGroupId: string,
): PlaybackGroupSnapshot | undefined {
  return state.groups.find((group) => group.playbackGroupId === playbackGroupId);
}
