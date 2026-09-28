import { assertRoomInvariants, type LogicalTabState, type RoomState } from "@syncaction/domain";
import {
  RoomSnapshotStateSchema,
  type LogicalTabId,
  type RoomSnapshotState,
} from "@syncaction/protocol";
import { ReplicaError } from "./errors.js";

export function decodeSnapshot(snapshotInput: unknown): RoomState {
  try {
    const snapshot = RoomSnapshotStateSchema.parse(snapshotInput);
    const tabs: Partial<Record<LogicalTabId, LogicalTabState>> = {};
    for (const tab of snapshot.tabs) {
      tabs[tab.id] = {
        id: tab.id,
        url: tab.url,
        ...(tab.title === undefined ? {} : { title: tab.title }),
        ...(tab.favIconUrl === undefined ? {} : { favIconUrl: tab.favIconUrl }),
        createdAtSeq: tab.createdAtSeq,
        updatedAtSeq: tab.updatedAtSeq,
        closedAtSeq: tab.closedAtSeq,
      };
    }
    const state: RoomState = {
      roomId: snapshot.roomId,
      roomEpoch: snapshot.roomEpoch,
      serverSeq: snapshot.serverSeq,
      order: [...snapshot.order],
      tabs,
    };
    assertRoomInvariants(state);
    return state;
  } catch (cause) {
    if (cause instanceof ReplicaError) {
      throw cause;
    }
    throw new ReplicaError("INVALID_REMOTE_STATE", { cause });
  }
}

export function encodeRoomState(state: RoomState): RoomSnapshotState {
  try {
    assertRoomInvariants(state);
    const tabs = Object.values(state.tabs)
      .filter((tab): tab is LogicalTabState => tab !== undefined)
      .sort(
        (left, right) => left.createdAtSeq - right.createdAtSeq || left.id.localeCompare(right.id),
      )
      .map((tab) => ({
        id: tab.id,
        url: tab.url,
        ...(tab.title === undefined ? {} : { title: tab.title }),
        favIconUrl: tab.favIconUrl ?? null,
        createdAtSeq: tab.createdAtSeq,
        updatedAtSeq: tab.updatedAtSeq,
        closedAtSeq: tab.closedAtSeq,
      }));
    return RoomSnapshotStateSchema.parse({
      roomId: state.roomId,
      roomEpoch: state.roomEpoch,
      serverSeq: state.serverSeq,
      order: [...state.order],
      tabs,
    });
  } catch (cause) {
    if (cause instanceof ReplicaError) {
      throw cause;
    }
    throw new ReplicaError("INVALID_REMOTE_STATE", { cause });
  }
}
