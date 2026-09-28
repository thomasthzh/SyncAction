import type { LogicalTabId } from "@syncaction/protocol";

export function insertAfter(
  order: readonly LogicalTabId[],
  logicalTabId: LogicalTabId,
  after: LogicalTabId | null,
): LogicalTabId[] {
  const next = order.filter((id) => id !== logicalTabId);
  if (after === null) {
    return [...next, logicalTabId];
  }

  const anchorIndex = next.indexOf(after);
  if (anchorIndex === -1) {
    return [...next, logicalTabId];
  }

  next.splice(anchorIndex + 1, 0, logicalTabId);
  return next;
}

export function moveBetween(
  order: readonly LogicalTabId[],
  logicalTabId: LogicalTabId,
  predecessor: LogicalTabId | null,
  successor: LogicalTabId | null,
): LogicalTabId[] {
  const next = order.filter((id) => id !== logicalTabId);
  if (successor !== null) {
    const successorIndex = next.indexOf(successor);
    if (successorIndex !== -1) {
      next.splice(successorIndex, 0, logicalTabId);
      return next;
    }
  }

  if (predecessor !== null) {
    const predecessorIndex = next.indexOf(predecessor);
    if (predecessorIndex !== -1) {
      next.splice(predecessorIndex + 1, 0, logicalTabId);
      return next;
    }
  }

  return [...next, logicalTabId];
}
