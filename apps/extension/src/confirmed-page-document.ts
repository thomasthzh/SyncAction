import { projectOptimisticState, type ReplicaRecord } from "@syncaction/replica";

/** Collaboration belongs to the confirmed document, never a pending URL or close. */
export function isConfirmedPageDocument(record: ReplicaRecord, logicalTabId: string): boolean {
  const snapshot = record.confirmedSnapshot;
  if (
    record.mode !== "SYNCED" ||
    snapshot === null ||
    !snapshot.order.some((id) => id === logicalTabId)
  ) {
    return false;
  }
  const confirmed = snapshot.tabs.find(
    (tab) => tab.id === logicalTabId && tab.closedAtSeq === null,
  );
  if (confirmed === undefined) return false;
  const pending = [...record.outbox, ...record.pendingConfirmations];
  if (pending.length === 0) return true;
  if (
    pending.some(
      ({ envelope }) =>
        envelope.operation.logicalTabId === logicalTabId &&
        (envelope.operation.type === "tab.navigate" || envelope.operation.type === "tab.close"),
    )
  )
    return false;
  try {
    const optimistic = projectOptimisticState(record).tabs[confirmed.id];
    return (
      optimistic !== undefined &&
      optimistic.closedAtSeq === null &&
      optimistic.url === confirmed.url
    );
  } catch {
    return false;
  }
}
