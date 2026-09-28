import type { CommittedOperation, LogicalTabId, SupportedUrl } from "@syncaction/protocol";
import { DomainInvariantError } from "./errors.js";
import { assertRoomInvariants } from "./invariants.js";
import type { LogicalTabState, RoomState } from "./model.js";
import { insertAfter, moveBetween } from "./order.js";

function requireActiveTab(state: RoomState, logicalTabId: LogicalTabId): LogicalTabState {
  const tab = state.tabs[logicalTabId];
  if (tab === undefined || tab.closedAtSeq !== null) {
    throw new DomainInvariantError(`logical tab ${logicalTabId} is not active`);
  }
  return tab;
}

function updateTab(
  state: RoomState,
  logicalTabId: LogicalTabId,
  patch: Partial<LogicalTabState>,
): RoomState["tabs"] {
  const current = requireActiveTab(state, logicalTabId);
  return {
    ...state.tabs,
    [logicalTabId]: { ...current, ...patch },
  };
}

export function applyCommittedOperation(state: RoomState, message: CommittedOperation): RoomState {
  if (message.roomId !== state.roomId || message.roomEpoch !== state.roomEpoch) {
    throw new DomainInvariantError("committed operation targets another room epoch");
  }
  if (message.serverSeq !== state.serverSeq + 1) {
    throw new DomainInvariantError("committed operation is not the next sequence");
  }

  const seq = message.serverSeq;
  const operation = message.operation;
  let next: RoomState;

  switch (operation.type) {
    case "tab.create": {
      if (state.tabs[operation.logicalTabId] !== undefined) {
        throw new DomainInvariantError("logical tab IDs cannot be reused");
      }
      const tab: LogicalTabState = {
        id: operation.logicalTabId,
        url: operation.url as SupportedUrl,
        ...(operation.title === undefined ? {} : { title: operation.title }),
        ...(operation.favIconUrl === undefined ? {} : { favIconUrl: operation.favIconUrl }),
        createdAtSeq: seq,
        updatedAtSeq: seq,
        closedAtSeq: null,
      };
      next = {
        ...state,
        serverSeq: seq,
        tabs: { ...state.tabs, [tab.id]: tab },
        order: insertAfter(state.order, tab.id, operation.after),
      };
      break;
    }
    case "tab.navigate":
      next = {
        ...state,
        serverSeq: seq,
        tabs: updateTab(state, operation.logicalTabId, {
          url: operation.url as SupportedUrl,
          updatedAtSeq: seq,
        }),
      };
      break;
    case "tab.close":
      next = {
        ...state,
        serverSeq: seq,
        tabs: updateTab(state, operation.logicalTabId, {
          updatedAtSeq: seq,
          closedAtSeq: seq,
        }),
        order: state.order.filter((id) => id !== operation.logicalTabId),
      };
      break;
    case "tab.move":
      requireActiveTab(state, operation.logicalTabId);
      next = {
        ...state,
        serverSeq: seq,
        order: moveBetween(
          state.order,
          operation.logicalTabId,
          operation.predecessor,
          operation.successor,
        ),
      };
      break;
    case "tab.updateMetadata":
      next = {
        ...state,
        serverSeq: seq,
        tabs: updateTab(state, operation.logicalTabId, {
          ...(operation.title === undefined ? {} : { title: operation.title }),
          ...(operation.favIconUrl === undefined ? {} : { favIconUrl: operation.favIconUrl }),
          updatedAtSeq: seq,
        }),
      };
      break;
  }

  assertRoomInvariants(next);
  return next;
}
