import type { LocalTabBinding, ReplicaRecord } from "@syncaction/replica";
import { projectOptimisticState, ReplicaRecordSchema } from "@syncaction/replica";
import type { LogicalTabId, SupportedUrl } from "@syncaction/protocol";
import { decideRestore } from "./circuit-breaker.js";
import {
  BrowserStateSchema,
  discoverRoomGroup,
  type BrowserGroup,
  type BrowserState,
  type BrowserTab,
} from "./model.js";
import { canonicalizeSharedUrl } from "./url-policy.js";

export type BrowserReconciliationEffect =
  | {
      kind: "CREATE";
      logicalTabId: string;
      url: string;
      index: number;
      groupId: number | null;
      serverSeq: number;
      confirmedRecovery: boolean;
    }
  | {
      kind: "GROUP";
      logicalTabId: string;
      tabId: number;
      groupId: number | null;
      serverSeq: number;
      confirmedRecovery: boolean;
    }
  | {
      kind: "NAVIGATE";
      logicalTabId: string;
      tabId: number;
      url: string;
      serverSeq: number;
      confirmedRecovery: boolean;
    }
  | {
      kind: "MOVE";
      logicalTabId: string;
      tabId: number;
      windowId: number;
      index: number;
      serverSeq: number;
      confirmedRecovery: boolean;
    }
  | {
      kind: "CLOSE";
      logicalTabId: string;
      tabId: number;
      serverSeq: number;
      confirmedRecovery: boolean;
    }
  | {
      kind: "FORGET_BINDING";
      logicalTabId: string;
      serverSeq: number;
      confirmedRecovery: boolean;
    };

export type BrowserReconciliation =
  | { kind: "NOOP" }
  | {
      kind: "BLOCKED";
      reason:
        | "REPLICA_NOT_ACTUATABLE"
        | "AMBIGUOUS_ROOM_GROUP"
        | "UNSAFE_ROOM_GROUP"
        | "STALE_BINDINGS"
        | "UNBOUND_ROOM_TAB"
        | "BOUND_TAB_OUTSIDE_ROOM_GROUP";
    }
  | { kind: "CONFIRMATION_REQUIRED"; missingTabCount: number }
  | { kind: "REBUILD_BINDINGS"; bindings: LocalTabBinding[] }
  | { kind: "EFFECT"; effect: BrowserReconciliationEffect };

export interface BrowserReconciliationInput {
  actuatable: boolean;
  record: ReplicaRecord;
  browserState: BrowserState;
  confirmedRecovery: boolean;
}

interface CanonicalTab {
  id: LogicalTabId;
  url: SupportedUrl;
  closedAtSeq: number | null;
}

export function nextReconciliation(input: BrowserReconciliationInput): BrowserReconciliation {
  const record = ReplicaRecordSchema.parse(input.record);
  const browserState = BrowserStateSchema.parse(input.browserState);
  const snapshot = record.confirmedSnapshot;
  if (!input.actuatable || record.mode !== "SYNCED" || snapshot === null) {
    return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" };
  }
  const discovery = discoverRoomGroup(browserState, record.roomId);
  if (discovery.kind === "AMBIGUOUS") {
    return { kind: "BLOCKED", reason: "AMBIGUOUS_ROOM_GROUP" };
  }
  if (discovery.kind === "UNSAFE") {
    return { kind: "BLOCKED", reason: "UNSAFE_ROOM_GROUP" };
  }
  const optimistic = projectOptimisticState(record);
  const canonicalTabs = optimistic.order.map((logicalTabId) => {
    const tab = optimistic.tabs[logicalTabId];
    if (tab === undefined || tab.closedAtSeq !== null) {
      throw new Error("INVALID_CONFIRMED_BROWSER_STATE");
    }
    return tab;
  });
  const allLogicalTabs = Object.values(optimistic.tabs).filter(
    (tab): tab is NonNullable<typeof tab> => tab !== undefined,
  );
  const hasStaleBindings = record.bindings.some(
    (binding) => binding.browserSessionId !== browserState.browserSessionId,
  );
  if (
    discovery.kind === "FOUND" &&
    (hasStaleBindings || record.bindings.length === 0) &&
    exactCanonicalGroup(discovery.tabs, canonicalTabs)
  ) {
    return {
      kind: "REBUILD_BINDINGS",
      bindings: canonicalTabs.map((tab, index) => {
        const localTab = discovery.tabs[index]!;
        return {
          logicalTabId: tab.id,
          tabId: localTab.tabId,
          windowId: discovery.group.windowId,
          groupId: discovery.group.groupId,
          browserSessionId: browserState.browserSessionId,
          validatedAtServerSeq: snapshot.serverSeq,
        };
      }),
    };
  }
  if (hasStaleBindings) {
    return { kind: "BLOCKED", reason: "STALE_BINDINGS" };
  }

  if (discovery.kind === "MISSING") {
    return reconcileMissingGroup(input, canonicalTabs, browserState);
  }
  return reconcileFoundGroup(
    input,
    canonicalTabs,
    allLogicalTabs,
    browserState,
    discovery.group,
    discovery.tabs,
  );
}

function reconcileMissingGroup(
  input: BrowserReconciliationInput,
  canonicalTabs: readonly CanonicalTab[],
  browserState: BrowserState,
): BrowserReconciliation {
  if (canonicalTabs.length === 0 && input.record.bindings.length === 0) {
    return { kind: "NOOP" };
  }
  const tabsById = new Map(browserState.tabs.map((tab) => [tab.tabId, tab]));
  for (const binding of input.record.bindings) {
    const localTab = tabsById.get(binding.tabId);
    const canonical = canonicalTabs.find((tab) => tab.id === binding.logicalTabId);
    if (
      canonical !== undefined &&
      binding.groupId === null &&
      localTab !== undefined &&
      urlsEqual(localTab.url, canonical.url)
    ) {
      return {
        kind: "EFFECT",
        effect: effectBase(input, {
          kind: "GROUP",
          logicalTabId: canonical.id,
          tabId: localTab.tabId,
          groupId: null,
        }),
      };
    }
  }
  if (input.record.bindings.length > 0) {
    return {
      kind: "BLOCKED",
      reason: "BOUND_TAB_OUTSIDE_ROOM_GROUP",
    };
  }
  const restore = decideRestore({
    missingTabCount: canonicalTabs.length,
    confirmed: input.confirmedRecovery,
  });
  if (restore.kind === "CONFIRMATION_REQUIRED") {
    return restore;
  }
  const first = canonicalTabs[0];
  if (first === undefined) {
    return { kind: "NOOP" };
  }
  return {
    kind: "EFFECT",
    effect: effectBase(input, {
      kind: "CREATE",
      logicalTabId: first.id,
      url: first.url,
      index:
        browserState.tabs.length === 0
          ? 0
          : Math.max(...browserState.tabs.map((tab) => tab.index)) + 1,
      groupId: null,
    }),
  };
}

function reconcileFoundGroup(
  input: BrowserReconciliationInput,
  canonicalTabs: readonly CanonicalTab[],
  allLogicalTabs: readonly CanonicalTab[],
  browserState: BrowserState,
  group: BrowserGroup,
  roomTabs: BrowserTab[],
): BrowserReconciliation {
  const bindingsByLogicalId = new Map(
    input.record.bindings.map((binding) => [binding.logicalTabId, binding]),
  );
  const bindingsByTabId = new Map(input.record.bindings.map((binding) => [binding.tabId, binding]));
  const browserTabsById = new Map(browserState.tabs.map((tab) => [tab.tabId, tab]));
  if (roomTabs.some((tab) => !bindingsByTabId.has(tab.tabId))) {
    return { kind: "BLOCKED", reason: "UNBOUND_ROOM_TAB" };
  }

  for (const tombstone of allLogicalTabs.filter((tab) => tab.closedAtSeq !== null)) {
    const binding = bindingsByLogicalId.get(tombstone.id);
    if (binding === undefined) {
      continue;
    }
    const localTab = browserTabsById.get(binding.tabId);
    if (localTab === undefined) {
      return {
        kind: "EFFECT",
        effect: effectBase(input, {
          kind: "FORGET_BINDING",
          logicalTabId: tombstone.id,
        }),
      };
    }
    if (localTab.groupId !== group.groupId) {
      return {
        kind: "BLOCKED",
        reason: "BOUND_TAB_OUTSIDE_ROOM_GROUP",
      };
    }
    return {
      kind: "EFFECT",
      effect: effectBase(input, {
        kind: "CLOSE",
        logicalTabId: tombstone.id,
        tabId: binding.tabId,
      }),
    };
  }

  const missingTabs: CanonicalTab[] = [];
  for (const canonical of canonicalTabs) {
    const binding = bindingsByLogicalId.get(canonical.id);
    const localTab = binding === undefined ? undefined : browserTabsById.get(binding.tabId);
    if (binding === undefined || localTab === undefined) {
      missingTabs.push(canonical);
      continue;
    }
    if (binding.groupId === null && urlsEqual(localTab.url, canonical.url)) {
      return {
        kind: "EFFECT",
        effect: effectBase(input, {
          kind: "GROUP",
          logicalTabId: canonical.id,
          tabId: localTab.tabId,
          groupId: group.groupId,
        }),
      };
    }
    if (localTab.groupId !== group.groupId) {
      return {
        kind: "BLOCKED",
        reason: "BOUND_TAB_OUTSIDE_ROOM_GROUP",
      };
    }
  }
  if (missingTabs.length > 0) {
    const restore = decideRestore({
      missingTabCount: missingTabs.length,
      confirmed: input.confirmedRecovery,
    });
    if (restore.kind === "CONFIRMATION_REQUIRED") {
      return restore;
    }
    const missing = missingTabs[0]!;
    const groupStartIndex =
      roomTabs.length === 0 ? 0 : Math.min(...roomTabs.map((tab) => tab.index));
    return {
      kind: "EFFECT",
      effect: effectBase(input, {
        kind: "CREATE",
        logicalTabId: missing.id,
        url: missing.url,
        index: groupStartIndex + canonicalTabs.findIndex((tab) => tab.id === missing.id),
        groupId: group.groupId,
      }),
    };
  }

  for (const canonical of canonicalTabs) {
    const binding = bindingsByLogicalId.get(canonical.id)!;
    const localTab = browserTabsById.get(binding.tabId)!;
    if (!urlsEqual(localTab.url, canonical.url)) {
      return {
        kind: "EFFECT",
        effect: effectBase(input, {
          kind: "NAVIGATE",
          logicalTabId: canonical.id,
          tabId: localTab.tabId,
          url: canonical.url,
        }),
      };
    }
  }

  const activeRoomTabs = roomTabs.filter((tab) => {
    const binding = bindingsByTabId.get(tab.tabId);
    return (
      binding !== undefined &&
      canonicalTabs.some((canonical) => canonical.id === binding.logicalTabId)
    );
  });
  const desiredTabIds = canonicalTabs.map((tab) => bindingsByLogicalId.get(tab.id)!.tabId);
  const firstMismatch = desiredTabIds.findIndex(
    (tabId, index) => activeRoomTabs[index]?.tabId !== tabId,
  );
  if (firstMismatch !== -1) {
    const tabId = desiredTabIds[firstMismatch]!;
    const logicalTabId = canonicalTabs[firstMismatch]!.id;
    const groupStartIndex = Math.min(...roomTabs.map((tab) => tab.index));
    return {
      kind: "EFFECT",
      effect: effectBase(input, {
        kind: "MOVE",
        logicalTabId,
        tabId,
        windowId: group.windowId,
        index: groupStartIndex + firstMismatch,
      }),
    };
  }
  return { kind: "NOOP" };
}

function exactCanonicalGroup(
  localTabs: readonly BrowserTab[],
  canonicalTabs: readonly CanonicalTab[],
): boolean {
  return (
    localTabs.length === canonicalTabs.length &&
    canonicalTabs.every((tab, index) => urlsEqual(localTabs[index]?.url, tab.url))
  );
}

function urlsEqual(left: string | null | undefined, right: string): boolean {
  if (left === null || left === undefined) {
    return false;
  }
  try {
    return canonicalizeSharedUrl(left) === canonicalizeSharedUrl(right);
  } catch {
    return false;
  }
}

function effectBase<T extends Omit<BrowserReconciliationEffect, "serverSeq" | "confirmedRecovery">>(
  input: BrowserReconciliationInput,
  effect: T,
): T & { serverSeq: number; confirmedRecovery: boolean } {
  return {
    ...effect,
    serverSeq: input.record.confirmedSnapshot!.serverSeq,
    confirmedRecovery: input.confirmedRecovery,
  };
}
