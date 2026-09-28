import type { LogicalTabId, RoomId, SupportedUrl } from "@syncaction/protocol";

export interface LogicalTabState {
  readonly id: LogicalTabId;
  readonly url: SupportedUrl;
  readonly title?: string;
  readonly favIconUrl?: string | null;
  readonly createdAtSeq: number;
  readonly updatedAtSeq: number;
  readonly closedAtSeq: number | null;
}

export interface RoomState {
  readonly roomId: RoomId;
  readonly roomEpoch: number;
  readonly serverSeq: number;
  readonly order: readonly LogicalTabId[];
  readonly tabs: Readonly<Partial<Record<LogicalTabId, LogicalTabState>>>;
}

export function createEmptyRoomState(roomId: RoomId, roomEpoch: number): RoomState {
  return {
    roomId,
    roomEpoch,
    serverSeq: 0,
    order: [],
    tabs: {},
  };
}
