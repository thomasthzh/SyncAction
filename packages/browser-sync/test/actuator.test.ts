import { DurableReplica, MemoryReplicaPersistence, ReplicaRepository } from "@syncaction/replica";
import { beforeEach, describe, expect, it } from "vitest";
import { BrowserActuator, type BrowserPort } from "../src/actuator.js";
import { BrowserCircuitBreaker } from "../src/circuit-breaker.js";
import { EffectLedger } from "../src/effect-ledger.js";
import {
  BrowserStateSchema,
  roomGroupTitle,
  type BrowserGroup,
  type BrowserState,
  type BrowserTab,
} from "../src/model.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const secondId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const sessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";

class MemoryBrowserPort implements BrowserPort {
  public state: BrowserState;
  public createCount = 0;
  public groupCount = 0;
  public navigateCount = 0;
  public moveCount = 0;
  public closeCount = 0;
  public ungroupCount = 0;
  public failCreate = false;
  public ignoreNavigate = false;
  #nextTabId = 100;
  #nextGroupId = 7;

  public constructor(options?: { groups?: BrowserGroup[]; tabs?: BrowserTab[] }) {
    this.state = BrowserStateSchema.parse({
      browserSessionId: sessionId,
      windows: [{ windowId: 1, type: "normal", incognito: false }],
      groups: options?.groups ?? [],
      tabs: options?.tabs ?? [
        {
          tabId: 50,
          windowId: 1,
          groupId: null,
          index: 0,
          url: "https://personal.example/",
          title: "Personal",
          status: "complete",
          pinned: false,
        },
      ],
    });
  }

  public async readState(): Promise<BrowserState> {
    return BrowserStateSchema.parse(structuredClone(this.state));
  }

  public async createTab(input: {
    url: string;
    index: number;
    windowId: number | null;
  }): Promise<BrowserTab> {
    this.createCount += 1;
    if (this.failCreate) {
      throw new Error("simulated create failure");
    }
    const tab = {
      tabId: this.#nextTabId++,
      windowId: input.windowId ?? 1,
      groupId: null,
      index: this.state.tabs.length,
      url: input.url,
      title: input.url,
      status: "complete" as const,
      pinned: false,
    };
    this.state.tabs.push(tab);
    this.#normalizeIndexes();
    return BrowserStateSchema.parse(this.state).tabs.find(
      (candidate) => candidate.tabId === tab.tabId,
    )!;
  }

  public async groupTab(input: {
    tabId: number;
    groupId: number | null;
    title: string;
  }): Promise<{ tab: BrowserTab; group: BrowserGroup }> {
    this.groupCount += 1;
    let group = this.state.groups.find((candidate) => candidate.groupId === input.groupId);
    if (group === undefined) {
      group = {
        groupId: this.#nextGroupId++,
        windowId: 1,
        title: input.title,
        color: "blue",
        collapsed: false,
      };
      this.state.groups.push(group);
    }
    const tab = this.#requireTab(input.tabId);
    tab.groupId = group.groupId;
    this.state = BrowserStateSchema.parse(this.state);
    return {
      tab: this.#requireTab(input.tabId),
      group,
    };
  }

  public async ungroupTab(tabId: number): Promise<BrowserTab> {
    this.ungroupCount += 1;
    const tab = this.#requireTab(tabId);
    tab.groupId = null;
    this.state = BrowserStateSchema.parse(this.state);
    return this.#requireTab(tabId);
  }

  public async navigateTab(input: { tabId: number; url: string }): Promise<BrowserTab> {
    this.navigateCount += 1;
    const tab = this.#requireTab(input.tabId);
    if (!this.ignoreNavigate) {
      tab.url = input.url;
      tab.title = input.url;
    }
    this.state = BrowserStateSchema.parse(this.state);
    return this.#requireTab(input.tabId);
  }

  public async moveTab(input: {
    tabId: number;
    windowId: number;
    index: number;
  }): Promise<BrowserTab> {
    this.moveCount += 1;
    const ordered = this.state.tabs.toSorted((left, right) => left.index - right.index);
    const currentIndex = ordered.findIndex((tab) => tab.tabId === input.tabId);
    const [tab] = ordered.splice(currentIndex, 1);
    ordered.splice(input.index, 0, tab!);
    ordered.forEach((candidate, index) => {
      candidate.index = index;
    });
    this.state.tabs = ordered;
    this.state = BrowserStateSchema.parse(this.state);
    return this.#requireTab(input.tabId);
  }

  public async closeTab(tabId: number): Promise<void> {
    this.closeCount += 1;
    this.state.tabs = this.state.tabs.filter((tab) => tab.tabId !== tabId);
    this.#normalizeIndexes();
    this.state = BrowserStateSchema.parse(this.state);
  }

  #requireTab(tabId: number): BrowserTab {
    const tab = this.state.tabs.find((candidate) => candidate.tabId === tabId);
    if (tab === undefined) {
      throw new Error(`missing tab ${tabId}`);
    }
    return tab;
  }

  #normalizeIndexes(): void {
    this.state.tabs
      .toSorted((left, right) => left.index - right.index)
      .forEach((tab, index) => {
        tab.index = index;
      });
  }
}

let replica: DurableReplica;
let browser: MemoryBrowserPort;
let ledger: EffectLedger;
let effectIndex: number;

beforeEach(async () => {
  replica = new DurableReplica({
    repository: new ReplicaRepository({
      persistence: new MemoryReplicaPersistence(),
    }),
    roomId,
    deviceId,
  });
  browser = new MemoryBrowserPort();
  ledger = new EffectLedger();
  effectIndex = 0;
  await applySnapshot([
    { id: firstId, url: "https://example.com/first" },
    { id: secondId, url: "https://example.com/second" },
  ]);
});

async function applySnapshot(tabs: Array<{ id: string; url: string }>): Promise<void> {
  await replica.applySnapshot({
    type: "room.snapshot",
    protocolVersion: 1,
    state: {
      roomId,
      roomEpoch: 0,
      serverSeq: tabs.length,
      order: tabs.map((tab) => tab.id),
      tabs: tabs.map((tab, index) => ({
        ...tab,
        createdAtSeq: index + 1,
        updatedAtSeq: index + 1,
        closedAtSeq: null,
      })),
    },
  });
}

function actuator(options?: {
  actuatable?: boolean;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  return new BrowserActuator({
    roomId,
    replica,
    browser,
    ledger,
    breaker: new BrowserCircuitBreaker(),
    isActuatable: () => options?.actuatable ?? true,
    now: () => 1_000 + effectIndex,
    createEffectId: () => `018f8f8e-4b5c-7d6e-8f90-${String(effectIndex++).padStart(12, "0")}`,
    ...(options?.wait === undefined ? {} : { wait: options.wait }),
  });
}

describe("one-effect-at-a-time browser actuator", () => {
  it("restores a missing room group, persists bindings, and leaves personal tabs unchanged", async () => {
    const result = await actuator().reconcile({ confirmedRecovery: false });
    const state = await browser.readState();
    const roomGroup = state.groups.find((group) => group.title === roomGroupTitle(roomId))!;

    expect(result).toEqual({ kind: "SYNCHRONIZED", effectsApplied: 2 });
    expect(browser.createCount).toBe(2);
    expect(browser.groupCount).toBe(2);
    expect(state.tabs.find((tab) => tab.tabId === 50)).toMatchObject({
      url: "https://personal.example/",
      groupId: null,
    });
    expect(
      state.tabs
        .filter((tab) => tab.groupId === roomGroup.groupId)
        .toSorted((left, right) => left.index - right.index)
        .map((tab) => tab.url),
    ).toEqual(["https://example.com/first", "https://example.com/second"]);
    expect((await replica.getRecord()).bindings).toHaveLength(2);
    expect(ledger.size).toBe(4);
  });

  it("closes one exact tombstone tab and never touches a personal tab", async () => {
    await actuator().reconcile({ confirmedRecovery: false });
    const firstBinding = (await replica.getRecord()).bindings.find(
      (binding) => binding.logicalTabId === firstId,
    )!;
    await replica.applyCommitted({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ad0",
      roomId,
      roomEpoch: 0,
      deviceId,
      serverSeq: 3,
      operation: { type: "tab.close", logicalTabId: firstId },
    });

    const result = await actuator().reconcile({ confirmedRecovery: false });

    expect(result).toEqual({ kind: "SYNCHRONIZED", effectsApplied: 1 });
    expect(browser.closeCount).toBe(1);
    expect((await browser.readState()).tabs.map((tab) => tab.tabId)).not.toContain(
      firstBinding.tabId,
    );
    expect((await browser.readState()).tabs.find((tab) => tab.tabId === 50)?.url).toBe(
      "https://personal.example/",
    );
    expect(
      (await replica.getRecord()).bindings.some((binding) => binding.logicalTabId === firstId),
    ).toBe(false);
  });

  it("applies navigation and move through fresh reads", async () => {
    await actuator().reconcile({ confirmedRecovery: false });
    const bindings = await replica.getRecord();
    const firstBinding = bindings.bindings.find((binding) => binding.logicalTabId === firstId)!;
    const secondBinding = bindings.bindings.find((binding) => binding.logicalTabId === secondId)!;
    await replica.applyCommitted({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ad1",
      roomId,
      roomEpoch: 0,
      deviceId,
      serverSeq: 3,
      operation: {
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/navigated",
      },
    });
    await replica.applyCommitted({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ad2",
      roomId,
      roomEpoch: 0,
      deviceId,
      serverSeq: 4,
      operation: {
        type: "tab.move",
        logicalTabId: secondId,
        predecessor: null,
        successor: firstId,
      },
    });

    const result = await actuator().reconcile({ confirmedRecovery: false });
    const groupTabs = (await browser.readState()).tabs
      .filter((tab) => tab.groupId !== null)
      .toSorted((left, right) => left.index - right.index);

    expect(result).toEqual({ kind: "SYNCHRONIZED", effectsApplied: 2 });
    expect(browser.navigateCount).toBe(1);
    expect(browser.moveCount).toBe(1);
    expect(groupTabs.map((tab) => tab.tabId)).toEqual([secondBinding.tabId, firstBinding.tabId]);
    expect(groupTabs.find((tab) => tab.tabId === firstBinding.tabId)?.url).toBe(
      "https://example.com/navigated",
    );
  });

  it("performs no reads or mutations while the replica is not actuatable", async () => {
    const result = await actuator({ actuatable: false }).reconcile({
      confirmedRecovery: false,
    });

    expect(result).toEqual({
      kind: "BLOCKED",
      reason: "REPLICA_NOT_ACTUATABLE",
      effectsApplied: 0,
    });
    expect(browser.createCount).toBe(0);
  });

  it("stops after one browser API failure and retains canonical state", async () => {
    browser.failCreate = true;

    const result = await actuator().reconcile({ confirmedRecovery: false });

    expect(result).toEqual({
      kind: "BLOCKED",
      reason: "BROWSER_API_FAILURE",
      effectsApplied: 0,
    });
    expect(browser.createCount).toBe(1);
    expect((await replica.getRecord()).confirmedSnapshot?.order).toEqual([firstId, secondId]);
  });

  it("detects a post-effect mismatch instead of repeating a navigation", async () => {
    await actuator().reconcile({ confirmedRecovery: false });
    await replica.applyCommitted({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ad3",
      roomId,
      roomEpoch: 0,
      deviceId,
      serverSeq: 3,
      operation: {
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/will-not-apply",
      },
    });
    browser.ignoreNavigate = true;

    const result = await actuator().reconcile({ confirmedRecovery: false });

    expect(result).toEqual({
      kind: "BLOCKED",
      reason: "POST_EFFECT_MISMATCH",
      effectsApplied: 1,
    });
    expect(browser.navigateCount).toBe(1);
  });
});
