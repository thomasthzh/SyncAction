import { DomainInvariantError } from "./errors.js";
import type { RoomState } from "./model.js";

export function assertRoomInvariants(state: RoomState): void {
  if (!Number.isSafeInteger(state.serverSeq) || state.serverSeq < 0) {
    throw new DomainInvariantError("serverSeq must be a non-negative safe integer");
  }

  const uniqueOrder = new Set(state.order);
  if (uniqueOrder.size !== state.order.length) {
    throw new DomainInvariantError("room order contains duplicate logical tabs");
  }

  for (const logicalTabId of state.order) {
    const tab = state.tabs[logicalTabId];
    if (tab === undefined || tab.closedAtSeq !== null) {
      throw new DomainInvariantError("room order references a missing or closed tab");
    }
  }

  for (const tab of Object.values(state.tabs)) {
    if (tab === undefined) {
      continue;
    }
    const isOrdered = uniqueOrder.has(tab.id);
    if (tab.closedAtSeq === null && !isOrdered) {
      throw new DomainInvariantError("active tab is absent from room order");
    }
    if (tab.closedAtSeq !== null && isOrdered) {
      throw new DomainInvariantError("closed tab remains in room order");
    }
  }
}
