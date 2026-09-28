import type { RoomTabTable } from "@syncaction/database";
import { assertRoomInvariants, type LogicalTabState, type RoomState } from "@syncaction/domain";
import {
  LogicalTabSnapshotSchema,
  RoomIdSchema,
  RoomSnapshotStateSchema,
  SequenceSchema,
  type LogicalTabId,
  type RoomId,
  type RoomSnapshotState,
} from "@syncaction/protocol";
import type { Selectable } from "kysely";
import { SyncError } from "./errors.js";

export interface MaterializedRoomHeader {
  id: unknown;
  roomEpoch: unknown;
  serverSeq: unknown;
}

export type MaterializedTabRow = Selectable<RoomTabTable>;

export function decodeMaterializedState(
  roomInput: MaterializedRoomHeader,
  rows: readonly MaterializedTabRow[],
): RoomState {
  try {
    const roomId = RoomIdSchema.parse(roomInput.id);
    const roomEpoch = SequenceSchema.parse(roomInput.roomEpoch);
    const serverSeq = SequenceSchema.parse(roomInput.serverSeq);
    const activeRows = rows
      .filter((row) => row.closedAtSeq === null)
      .sort((left, right) => left.position - right.position);
    for (const [index, row] of activeRows.entries()) {
      if (!Number.isSafeInteger(row.position) || row.position !== index) {
        throw new Error("active materialized positions must be contiguous");
      }
    }

    const tabs: Partial<Record<LogicalTabId, LogicalTabState>> = {};
    for (const row of rows) {
      if (row.roomId !== roomId) {
        throw new Error("materialized tab belongs to another room");
      }
      const tab = LogicalTabSnapshotSchema.parse({
        id: row.logicalTabId,
        url: row.url,
        ...(row.title === null ? {} : { title: row.title }),
        favIconUrl: row.favIconUrl,
        createdAtSeq: row.createdAtSeq,
        updatedAtSeq: row.updatedAtSeq,
        closedAtSeq: row.closedAtSeq,
      });
      if (tabs[tab.id] !== undefined) {
        throw new Error("duplicate logical tab row");
      }
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
      roomId,
      roomEpoch,
      serverSeq,
      order: activeRows.map((row) => row.logicalTabId as LogicalTabId),
      tabs,
    };
    assertRoomInvariants(state);
    RoomSnapshotStateSchema.parse(encodeSnapshotState(state));
    return state;
  } catch (cause) {
    if (cause instanceof SyncError) {
      throw cause;
    }
    throw new SyncError("RECOVERY_REQUIRED", { cause });
  }
}

export function encodeSnapshotState(state: RoomState): RoomSnapshotState {
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
      roomId: state.roomId as RoomId,
      roomEpoch: state.roomEpoch,
      serverSeq: state.serverSeq,
      order: [...state.order],
      tabs,
    });
  } catch (cause) {
    if (cause instanceof SyncError) {
      throw cause;
    }
    throw new SyncError("RECOVERY_REQUIRED", { cause });
  }
}
