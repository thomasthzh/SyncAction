import { ReplicaRecordSchema } from "@syncaction/replica";
import { describe, expect, it } from "vitest";
import { BrowserStateSchema, roomGroupTitle } from "../src/model.js";
import { nextReconciliation } from "../src/reconciler.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const secondId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const sessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const staleSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789ab7";

function record(options: {
  mode?: "SYNCED" | "RECOVERING";
  firstClosed?: boolean;
  firstUrl?: string;
  secondUrl?: string;
  bindings?: Array<{
    logicalTabId: string;
    tabId: number;
    windowId: number;
    groupId: number | null;
    browserSessionId: string;
    validatedAtServerSeq: number;
  }>;
}) {
  const firstClosed = options.firstClosed ?? false;
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId,
    mode: options.mode ?? "SYNCED",
    confirmedSnapshot: {
      roomId,
      roomEpoch: 0,
      serverSeq: 2,
      order: firstClosed ? [secondId] : [firstId, secondId],
      tabs: [
        {
          id: firstId,
          url: options.firstUrl ?? "https://example.com/first",
          createdAtSeq: 1,
          updatedAtSeq: firstClosed ? 2 : 1,
          closedAtSeq: firstClosed ? 2 : null,
        },
        {
          id: secondId,
          url: options.secondUrl ?? "https://example.com/second",
          createdAtSeq: 2,
          updatedAtSeq: 2,
          closedAtSeq: null,
        },
      ],
    },
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: options.bindings ?? [],
    quarantineReason: null,
    updatedAtMs: 1_000,
  });
}

function binding(
  logicalTabId: string,
  tabId: number,
  browserSessionId = sessionId,
  groupId: number | null = 7,
) {
  return {
    logicalTabId,
    tabId,
    windowId: 1,
    groupId,
    browserSessionId,
    validatedAtServerSeq: 2,
  };
}

function browser(options?: {
  group?: boolean;
  duplicateGroup?: boolean;
  tabs?: Array<{
    tabId: number;
    groupId: number | null;
    index: number;
    url: string;
  }>;
}) {
  const hasGroup = options?.group ?? true;
  const tabs =
    options?.tabs ??
    (hasGroup
      ? [
          {
            tabId: 10,
            groupId: 7,
            index: 1,
            url: "https://example.com/first",
          },
          {
            tabId: 11,
            groupId: 7,
            index: 2,
            url: "https://example.com/second",
          },
        ]
      : []);
  return BrowserStateSchema.parse({
    browserSessionId: sessionId,
    windows: [{ windowId: 1, type: "normal", incognito: false }],
    groups: [
      ...(hasGroup
        ? [
            {
              groupId: 7,
              windowId: 1,
              title: roomGroupTitle(roomId),
              color: "blue",
              collapsed: false,
            },
          ]
        : []),
      ...(options?.duplicateGroup
        ? [
            {
              groupId: 8,
              windowId: 1,
              title: roomGroupTitle(roomId),
              color: "blue",
              collapsed: false,
            },
          ]
        : []),
    ],
    tabs: tabs.map((tab) => ({
      ...tab,
      windowId: 1,
      title: tab.url,
      status: "complete",
      pinned: false,
    })),
  });
}

describe("safe browser reconciliation planning", () => {
  it("blocks all effects unless the replica is connected and synced", () => {
    expect(
      nextReconciliation({
        actuatable: false,
        record: record({}),
        browserState: browser(),
        confirmedRecovery: false,
      }),
    ).toEqual({ kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" });
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({ mode: "RECOVERING" }),
        browserState: browser(),
        confirmedRecovery: false,
      }),
    ).toEqual({ kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" });
  });

  it("plans a bounded restore and requires confirmation above five missing tabs", () => {
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({}),
        browserState: browser({ group: false }),
        confirmedRecovery: false,
      }),
    ).toMatchObject({
      kind: "EFFECT",
      effect: {
        kind: "CREATE",
        logicalTabId: firstId,
        url: "https://example.com/first",
        index: 0,
      },
    });

    const large = record({});
    const first = large.confirmedSnapshot!.tabs[0]!;
    const largeOrder = Array.from(
      { length: 6 },
      (_, index) => `018f8f8e-4b5c-7d6e-8f90-${String(index).padStart(12, "0")}`,
    );
    const largeRecord = ReplicaRecordSchema.parse({
      ...large,
      confirmedSnapshot: {
        ...large.confirmedSnapshot,
        order: largeOrder,
        tabs: largeOrder.map((id, index) => ({
          ...first,
          id,
          url: `https://example.com/${index}`,
          createdAtSeq: 1,
          updatedAtSeq: 1,
        })),
      },
    });
    expect(
      nextReconciliation({
        actuatable: true,
        record: largeRecord,
        browserState: browser({ group: false }),
        confirmedRecovery: false,
      }),
    ).toEqual({
      kind: "CONFIRMATION_REQUIRED",
      missingTabCount: 6,
    });
  });

  it("creates a missing room group after existing personal tabs without reindexing them", () => {
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({}),
        browserState: browser({
          group: false,
          tabs: [
            {
              tabId: 50,
              groupId: null,
              index: 0,
              url: "https://personal.example/one",
            },
            {
              tabId: 51,
              groupId: null,
              index: 1,
              url: "https://personal.example/two",
            },
          ],
        }),
        confirmedRecovery: false,
      }),
    ).toMatchObject({
      kind: "EFFECT",
      effect: {
        kind: "CREATE",
        index: 2,
      },
    });
  });

  it("rebuilds bindings only from an exact group in current order, including duplicate URLs", () => {
    const duplicateRecord = record({
      firstUrl: "https://example.com/duplicate",
      secondUrl: "https://example.com/duplicate",
      bindings: [binding(firstId, 1, staleSessionId), binding(secondId, 2, staleSessionId)],
    });
    const duplicateBrowser = browser({
      tabs: [
        {
          tabId: 20,
          groupId: 7,
          index: 4,
          url: "https://example.com/duplicate",
        },
        {
          tabId: 21,
          groupId: 7,
          index: 5,
          url: "https://example.com/duplicate",
        },
      ],
    });

    expect(
      nextReconciliation({
        actuatable: true,
        record: duplicateRecord,
        browserState: duplicateBrowser,
        confirmedRecovery: false,
      }),
    ).toEqual({
      kind: "REBUILD_BINDINGS",
      bindings: [binding(firstId, 20), binding(secondId, 21)],
    });
  });

  it("closes only an exact tombstone binding inside the room group", () => {
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({
          firstClosed: true,
          bindings: [binding(firstId, 10), binding(secondId, 11)],
        }),
        browserState: browser(),
        confirmedRecovery: false,
      }),
    ).toEqual({
      kind: "EFFECT",
      effect: {
        kind: "CLOSE",
        logicalTabId: firstId,
        tabId: 10,
        serverSeq: 2,
        confirmedRecovery: false,
      },
    });
  });

  it("never closes an unbound extra tab or a bound tab outside the room group", () => {
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({
          firstClosed: true,
          bindings: [binding(secondId, 11)],
        }),
        browserState: browser(),
        confirmedRecovery: false,
      }),
    ).toEqual({ kind: "BLOCKED", reason: "UNBOUND_ROOM_TAB" });

    expect(
      nextReconciliation({
        actuatable: true,
        record: record({
          firstClosed: true,
          bindings: [binding(firstId, 10, sessionId, null), binding(secondId, 11)],
        }),
        browserState: browser({
          tabs: [
            {
              tabId: 10,
              groupId: null,
              index: 0,
              url: "https://example.com/first",
            },
            {
              tabId: 11,
              groupId: 7,
              index: 2,
              url: "https://example.com/second",
            },
          ],
        }),
        confirmedRecovery: false,
      }),
    ).toEqual({ kind: "BLOCKED", reason: "BOUND_TAB_OUTSIDE_ROOM_GROUP" });
  });

  it("groups a proven pending create before any other mutation", () => {
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({
          bindings: [binding(firstId, 10, sessionId, null), binding(secondId, 11)],
        }),
        browserState: browser({
          tabs: [
            {
              tabId: 10,
              groupId: null,
              index: 0,
              url: "https://example.com/first",
            },
            {
              tabId: 11,
              groupId: 7,
              index: 2,
              url: "https://example.com/second",
            },
          ],
        }),
        confirmedRecovery: false,
      }),
    ).toMatchObject({
      kind: "EFFECT",
      effect: {
        kind: "GROUP",
        logicalTabId: firstId,
        tabId: 10,
        groupId: 7,
      },
    });
  });

  it("plans exact navigation and ordering for bound room tabs", () => {
    const bindings = [binding(firstId, 10), binding(secondId, 11)];
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({ bindings }),
        browserState: browser({
          tabs: [
            {
              tabId: 10,
              groupId: 7,
              index: 1,
              url: "https://example.com/outdated",
            },
            {
              tabId: 11,
              groupId: 7,
              index: 2,
              url: "https://example.com/second",
            },
          ],
        }),
        confirmedRecovery: false,
      }),
    ).toMatchObject({
      kind: "EFFECT",
      effect: {
        kind: "NAVIGATE",
        logicalTabId: firstId,
        tabId: 10,
        url: "https://example.com/first",
      },
    });

    expect(
      nextReconciliation({
        actuatable: true,
        record: record({ bindings }),
        browserState: browser({
          tabs: [
            {
              tabId: 11,
              groupId: 7,
              index: 1,
              url: "https://example.com/second",
            },
            {
              tabId: 10,
              groupId: 7,
              index: 2,
              url: "https://example.com/first",
            },
          ],
        }),
        confirmedRecovery: false,
      }),
    ).toMatchObject({
      kind: "EFFECT",
      effect: {
        kind: "MOVE",
        logicalTabId: firstId,
        tabId: 10,
        windowId: 1,
        index: 1,
      },
    });
  });

  it("creates a missing tab at the room group's absolute browser index", () => {
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({
          bindings: [binding(firstId, 10)],
        }),
        browserState: browser({
          tabs: [
            {
              tabId: 10,
              groupId: 7,
              index: 5,
              url: "https://example.com/first",
            },
          ],
        }),
        confirmedRecovery: false,
      }),
    ).toMatchObject({
      kind: "EFFECT",
      effect: {
        kind: "CREATE",
        logicalTabId: secondId,
        index: 6,
      },
    });
  });

  it("does not undo a persisted optimistic navigation before its broadcast arrives", () => {
    const base = record({
      bindings: [binding(firstId, 10), binding(secondId, 11)],
    });
    const optimistic = ReplicaRecordSchema.parse({
      ...base,
      nextOutboxSeq: 2,
      outbox: [
        {
          outboxSeq: 1,
          enqueuedAtMs: 1_100,
          envelope: {
            protocolVersion: 1,
            clientOpId,
            roomId,
            roomEpoch: 0,
            deviceId,
            baseServerSeq: 2,
            operation: {
              type: "tab.navigate",
              logicalTabId: firstId,
              url: "https://example.com/local",
            },
          },
        },
      ],
    });

    expect(
      nextReconciliation({
        actuatable: true,
        record: optimistic,
        browserState: browser({
          tabs: [
            {
              tabId: 10,
              groupId: 7,
              index: 1,
              url: "https://example.com/local",
            },
            {
              tabId: 11,
              groupId: 7,
              index: 2,
              url: "https://example.com/second",
            },
          ],
        }),
        confirmedRecovery: false,
      }),
    ).toEqual({ kind: "NOOP" });
  });

  it("forgets a missing optimistic close binding instead of recreating the tab", () => {
    const base = record({
      bindings: [binding(firstId, 10), binding(secondId, 11)],
    });
    const optimistic = ReplicaRecordSchema.parse({
      ...base,
      nextOutboxSeq: 2,
      outbox: [
        {
          outboxSeq: 1,
          enqueuedAtMs: 1_100,
          envelope: {
            protocolVersion: 1,
            clientOpId,
            roomId,
            roomEpoch: 0,
            deviceId,
            baseServerSeq: 2,
            operation: {
              type: "tab.close",
              logicalTabId: firstId,
            },
          },
        },
      ],
    });

    expect(
      nextReconciliation({
        actuatable: true,
        record: optimistic,
        browserState: browser({
          tabs: [
            {
              tabId: 11,
              groupId: 7,
              index: 1,
              url: "https://example.com/second",
            },
          ],
        }),
        confirmedRecovery: false,
      }),
    ).toMatchObject({
      kind: "EFFECT",
      effect: {
        kind: "FORGET_BINDING",
        logicalTabId: firstId,
      },
    });
  });

  it("blocks duplicate groups instead of guessing", () => {
    expect(
      nextReconciliation({
        actuatable: true,
        record: record({}),
        browserState: browser({ duplicateGroup: true }),
        confirmedRecovery: false,
      }),
    ).toEqual({ kind: "BLOCKED", reason: "AMBIGUOUS_ROOM_GROUP" });
  });
});
