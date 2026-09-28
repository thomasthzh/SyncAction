import { EffectLedger } from "@syncaction/browser-sync";
import { describe, expect, it } from "vitest";

type Operation =
  | { id: string; kind: "OPEN"; logicalTabId: string; url: string }
  | { id: string; kind: "NAVIGATE"; logicalTabId: string; url: string }
  | { id: string; kind: "MOVE"; logicalTabId: string; index: number }
  | { id: string; kind: "CLOSE"; logicalTabId: string };

interface PersistedStormState {
  readonly appliedOperationIds: Set<string>;
  readonly bindings: Map<string, number>;
  readonly authoritative: Map<string, { url: string; index: number; open: boolean }>;
}

class StormHarness {
  public readonly ledger = new EffectLedger();
  public readonly personalTabId = 1;
  public readonly browserTabs = new Map<number, { url: string; index: number; personal: boolean }>([
    [this.personalTabId, { url: "https://personal.example/keep", index: 0, personal: true }],
  ]);
  public readonly sideEffects = new Map<string, number>();
  public quarantined = false;
  public maximumTabCount = this.browserTabs.size;
  #nextTabId = 10;
  #effectSequence = 0;

  public constructor(public readonly persisted: PersistedStormState = persistedState()) {}

  public apply(operation: Operation, confirmedRecovery = false): void {
    if (this.persisted.appliedOperationIds.has(operation.id)) {
      return;
    }
    this.persisted.appliedOperationIds.add(operation.id);
    this.#applyAuthoritative(operation);
    if (this.quarantined && !confirmedRecovery) {
      return;
    }
    if (confirmedRecovery) {
      this.quarantined = false;
    }
    this.#actuate(operation);
  }

  public injectAmbiguousMapping(): void {
    this.quarantined = true;
  }

  public recoverSnapshot(
    tabs: ReadonlyArray<{ logicalTabId: string; url: string; index: number }>,
    confirmed: boolean,
  ): void {
    this.persisted.authoritative.clear();
    for (const tab of tabs) {
      this.persisted.authoritative.set(tab.logicalTabId, {
        url: tab.url,
        index: tab.index,
        open: true,
      });
    }
    if (!confirmed || this.quarantined) {
      return;
    }
    const snapshotIds = new Set(tabs.map(({ logicalTabId }) => logicalTabId));
    for (const logicalTabId of [...this.persisted.bindings.keys()]) {
      if (!snapshotIds.has(logicalTabId)) {
        this.apply(
          {
            id: `recovery-close-${logicalTabId}`,
            kind: "CLOSE",
            logicalTabId,
          },
          true,
        );
      }
    }
    for (const tab of tabs) {
      if (!this.persisted.bindings.has(tab.logicalTabId)) {
        this.apply(
          {
            id: `recovery-${tab.logicalTabId}`,
            kind: "OPEN",
            logicalTabId: tab.logicalTabId,
            url: tab.url,
          },
          true,
        );
      }
    }
  }

  public restart(): StormHarness {
    const restarted = new StormHarness(this.persisted);
    restarted.#nextTabId = this.#nextTabId;
    for (const [tabId, tab] of this.browserTabs) {
      restarted.browserTabs.set(tabId, structuredClone(tab));
    }
    restarted.maximumTabCount = this.maximumTabCount;
    restarted.quarantined = this.quarantined;
    return restarted;
  }

  #applyAuthoritative(operation: Operation): void {
    const existing = this.persisted.authoritative.get(operation.logicalTabId);
    if (operation.kind === "OPEN") {
      this.persisted.authoritative.set(operation.logicalTabId, {
        url: operation.url,
        index: this.persisted.authoritative.size,
        open: true,
      });
    } else if (operation.kind === "NAVIGATE" && existing !== undefined) {
      existing.url = operation.url;
    } else if (operation.kind === "MOVE" && existing !== undefined) {
      existing.index = operation.index;
    } else if (operation.kind === "CLOSE" && existing !== undefined) {
      existing.open = false;
    }
  }

  #actuate(operation: Operation): void {
    this.sideEffects.set(operation.id, (this.sideEffects.get(operation.id) ?? 0) + 1);
    const boundTabId = this.persisted.bindings.get(operation.logicalTabId);
    if (operation.kind === "OPEN") {
      if (boundTabId !== undefined) {
        return;
      }
      const tabId = this.#nextTabId++;
      const effectId = this.#effectId();
      this.ledger.begin({
        effectId,
        logicalTabId: operation.logicalTabId,
        serverSeq: this.persisted.appliedOperationIds.size,
        expectation: { type: "TAB_CREATED", tabId: null, url: operation.url },
        startedAtMs: 1_000,
        expiresAtMs: 6_000,
      });
      this.browserTabs.set(tabId, {
        url: operation.url,
        index: this.browserTabs.size,
        personal: false,
      });
      this.persisted.bindings.set(operation.logicalTabId, tabId);
      this.maximumTabCount = Math.max(this.maximumTabCount, this.browserTabs.size);
      this.ledger.attachCreatedTab(effectId, tabId);
      const callback = { type: "TAB_CREATED" as const, tabId, url: operation.url };
      expect(this.ledger.consume(callback, 1_001)).toBeDefined();
      expect(this.ledger.consume(callback, 1_001)).toBeUndefined();
      return;
    }
    if (boundTabId === undefined) {
      this.quarantined = true;
      return;
    }
    const tab = this.browserTabs.get(boundTabId);
    if (tab === undefined) {
      this.quarantined = true;
      return;
    }
    const effectId = this.#effectId();
    if (operation.kind === "NAVIGATE") {
      this.ledger.begin({
        effectId,
        logicalTabId: operation.logicalTabId,
        serverSeq: this.persisted.appliedOperationIds.size,
        expectation: { type: "TAB_NAVIGATED", tabId: boundTabId, url: operation.url },
        startedAtMs: 1_000,
        expiresAtMs: 6_000,
      });
      tab.url = operation.url;
      expect(
        this.ledger.consume(
          { type: "TAB_NAVIGATED", tabId: boundTabId, url: operation.url },
          1_001,
        ),
      ).toBeDefined();
    } else if (operation.kind === "MOVE") {
      this.ledger.begin({
        effectId,
        logicalTabId: operation.logicalTabId,
        serverSeq: this.persisted.appliedOperationIds.size,
        expectation: { type: "TAB_MOVED", tabId: boundTabId, windowId: 1, index: operation.index },
        startedAtMs: 1_000,
        expiresAtMs: 6_000,
      });
      tab.index = operation.index;
      expect(
        this.ledger.consume(
          { type: "TAB_MOVED", tabId: boundTabId, windowId: 1, index: operation.index },
          1_001,
        ),
      ).toBeDefined();
    } else {
      this.ledger.begin({
        effectId,
        logicalTabId: operation.logicalTabId,
        serverSeq: this.persisted.appliedOperationIds.size,
        expectation: { type: "TAB_CLOSED", tabId: boundTabId },
        startedAtMs: 1_000,
        expiresAtMs: 6_000,
      });
      this.browserTabs.delete(boundTabId);
      this.persisted.bindings.delete(operation.logicalTabId);
      expect(this.ledger.consume({ type: "TAB_CLOSED", tabId: boundTabId }, 1_001)).toBeDefined();
    }
  }

  #effectId(): string {
    this.#effectSequence += 1;
    return `70000000-0000-4000-8000-${this.#effectSequence.toString(16).padStart(12, "0")}`;
  }
}

describe("vNext tab-storm acceptance", () => {
  it("deduplicates bursts, survives restart, and quarantines ambiguous recovery", () => {
    let harness = new StormHarness();
    const tabs = Array.from({ length: 12 }, (_, index) => ({
      logicalTabId: logicalId(index),
      url: `https://example.test/page-${index}`,
    }));
    const operations: Operation[] = tabs.flatMap((tab, index) => [
      { id: `open-${index}`, kind: "OPEN", ...tab },
      {
        id: `navigate-${index}`,
        kind: "NAVIGATE",
        logicalTabId: tab.logicalTabId,
        url: `${tab.url}?revision=2`,
      },
      { id: `move-${index}`, kind: "MOVE", logicalTabId: tab.logicalTabId, index: 11 - index },
    ]);

    for (const kind of ["OPEN", "NAVIGATE", "MOVE"] as const) {
      const phase = operations.filter((operation) => operation.kind === kind);
      for (const operation of [...phase, ...phase.toReversed(), ...phase]) {
        harness.apply(operation);
      }
    }
    expect(harness.browserTabs.size).toBe(13);
    expect(harness.sideEffects.size).toBe(36);
    expect([...harness.sideEffects.values()]).toEqual(expect.arrayContaining([1]));
    expect(Math.max(...harness.sideEffects.values())).toBe(1);

    harness = harness.restart();
    for (const operation of operations) {
      harness.apply(operation);
    }
    expect(harness.browserTabs.size).toBe(13);
    expect(harness.sideEffects.size).toBe(0);

    harness.injectAmbiguousMapping();
    harness.apply({
      id: "ambiguous-close",
      kind: "CLOSE",
      logicalTabId: tabs[0]!.logicalTabId,
    });
    expect(harness.browserTabs.has(harness.personalTabId)).toBe(true);
    expect(harness.browserTabs.size).toBe(13);
    expect(harness.quarantined).toBe(true);

    harness.recoverSnapshot(
      tabs.slice(1).map((tab, index) => ({
        logicalTabId: tab.logicalTabId,
        url: `${tab.url}?revision=2`,
        index,
      })),
      false,
    );
    expect(harness.browserTabs.size).toBe(13);
    harness.quarantined = false;
    harness.recoverSnapshot(
      tabs.slice(1).map((tab, index) => ({
        logicalTabId: tab.logicalTabId,
        url: `${tab.url}?revision=2`,
        index,
      })),
      true,
    );

    const openAuthoritativeCount = [...harness.persisted.authoritative.values()].filter(
      ({ open }) => open,
    ).length;
    expect(harness.maximumTabCount).toBeLessThanOrEqual(openAuthoritativeCount + 2);
    expect(harness.browserTabs.get(harness.personalTabId)).toEqual({
      url: "https://personal.example/keep",
      index: 0,
      personal: true,
    });
    expect(new Set(harness.persisted.bindings.keys()).size).toBe(harness.persisted.bindings.size);
  });
});

function persistedState(): PersistedStormState {
  return {
    appliedOperationIds: new Set(),
    bindings: new Map(),
    authoritative: new Map(),
  };
}

function logicalId(index: number): string {
  return `80000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}
