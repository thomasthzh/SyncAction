import {
  BrowserActuator,
  BrowserCircuitBreaker,
  BrowserObserver,
  BrowserStateSchema,
  EffectLedger,
  roomGroupTitle,
  type BrowserActuatorResult,
  type BrowserObserverEvent,
  type BrowserObserverResult,
  type BrowserPort,
  type ShareTabOptions,
} from "@syncaction/browser-sync";
import { DurableOperationSchema } from "@syncaction/protocol";
import { DurableReplica, MemoryReplicaPersistence, ReplicaRepository } from "@syncaction/replica";
import { describe, expect, it } from "vitest";
import { browserRecoveryMessage, RoomBrowserController } from "../src/room-browser-controller.js";

class FakeObserver {
  public readonly events: BrowserObserverEvent[] = [];
  public results: BrowserObserverResult[] = [];
  public activeCalls = 0;
  public maximumActiveCalls = 0;
  public readonly shareOptions: Array<ShareTabOptions | undefined> = [];

  public async observe(event: BrowserObserverEvent): Promise<BrowserObserverResult> {
    this.activeCalls += 1;
    this.maximumActiveCalls = Math.max(this.maximumActiveCalls, this.activeCalls);
    await Promise.resolve();
    this.events.push(event);
    this.activeCalls -= 1;
    return (
      this.results.shift() ?? {
        kind: "IGNORED",
        reason: "NO_CHANGE",
      }
    );
  }

  public async shareTab(tabId: unknown, options?: ShareTabOptions): Promise<BrowserObserverResult> {
    this.shareOptions.push(options);
    this.events.push({ type: "TAB_UPDATED", tabId: Number(tabId) });
    return (
      this.results.shift() ?? {
        kind: "IGNORED",
        reason: "NO_CHANGE",
      }
    );
  }
}

class FakeActuator {
  public readonly confirmations: boolean[] = [];
  public results: BrowserActuatorResult[] = [];

  public async reconcile(options: { confirmedRecovery: boolean }): Promise<BrowserActuatorResult> {
    this.confirmations.push(options.confirmedRecovery);
    return (
      this.results.shift() ?? {
        kind: "SYNCHRONIZED",
        effectsApplied: 0,
      }
    );
  }
}

describe("RoomBrowserController", () => {
  it("revalidates a real manual binding when remote navigation and same-URL reload finish loading", async () => {
    const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
    const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
    const otherTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
    const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
    const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
    const replica = new DurableReplica({
      repository: new ReplicaRepository({ persistence: new MemoryReplicaPersistence() }),
      roomId,
      deviceId,
    });
    await replica.applySnapshot({
      type: "room.snapshot",
      protocolVersion: 1,
      state: {
        roomId,
        roomEpoch: 0,
        serverSeq: 1,
        order: [logicalTabId],
        tabs: [
          {
            id: logicalTabId,
            url: "https://example.com/first",
            createdAtSeq: 1,
            updatedAtSeq: 1,
            closedAtSeq: null,
          },
        ],
      },
    });
    const state = BrowserStateSchema.parse({
      browserSessionId,
      windows: [{ windowId: 1, type: "normal", incognito: false }],
      groups: [
        { groupId: 7, windowId: 1, title: roomGroupTitle(roomId), color: "blue", collapsed: false },
      ],
      tabs: [
        {
          tabId: 20,
          windowId: 1,
          groupId: 7,
          index: 0,
          url: "https://example.com/first",
          title: "First",
          status: "complete",
          pinned: false,
        },
      ],
    });
    await replica.bindTab({
      logicalTabId,
      tabId: 20,
      windowId: 1,
      groupId: 7,
      browserSessionId,
      validatedAtServerSeq: 1,
    });
    const unexpectedMutation = async (): Promise<never> => {
      throw new Error("Unexpected browser mutation");
    };
    let navigationCount = 0;
    const browser: BrowserPort = {
      readState: async () => structuredClone(state),
      navigateTab: async ({ tabId, url }) => {
        expect(tabId).toBe(20);
        navigationCount += 1;
        state.tabs[0]!.url = url;
        state.tabs[0]!.status = "loading";
        return structuredClone(state.tabs[0]!);
      },
      createTab: unexpectedMutation,
      closeTab: unexpectedMutation,
      groupTab: unexpectedMutation,
      ungroupTab: unexpectedMutation,
      moveTab: unexpectedMutation,
    };
    const ledger = new EffectLedger();
    const observer = new BrowserObserver({
      roomId,
      replica,
      browser,
      ledger,
      writer: { enqueueLocalOperation: unexpectedMutation },
      isActuatable: () => true,
      browserChangePolicy: "MANUAL",
    });
    const actuator = new BrowserActuator({
      roomId,
      replica,
      browser,
      ledger,
      breaker: new BrowserCircuitBreaker(),
      isActuatable: () => true,
      browserChangePolicy: "MANUAL",
    });
    const controller = new RoomBrowserController({
      observer,
      actuator,
      browserChangePolicy: "MANUAL",
    });
    await controller.handleReplicaTransition();
    await replica.applyCommitted({
      type: "op.committed",
      protocolVersion: 1,
      roomId,
      roomEpoch: 0,
      deviceId,
      clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
      serverSeq: 2,
      operation: { type: "tab.navigate", logicalTabId, url: "https://example.com/next" },
    });
    await controller.handleReplicaTransition();
    expect(navigationCount).toBe(1);
    expect((await replica.getRecord()).bindings[0]?.validatedAtServerSeq).toBe(1);
    state.tabs[0]!.status = "complete";
    await expect(
      controller.handleBrowserEvent({ type: "TAB_UPDATED", tabId: 20 }),
    ).resolves.toMatchObject({ kind: "EFFECT_CONSUMED" });
    expect((await replica.getRecord()).bindings[0]?.validatedAtServerSeq).toBe(2);

    state.tabs[0]!.status = "loading";
    await replica.applyCommitted({
      type: "op.committed",
      protocolVersion: 1,
      roomId,
      roomEpoch: 0,
      deviceId,
      clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ac2",
      serverSeq: 3,
      operation: {
        type: "tab.create",
        logicalTabId: otherTabId,
        url: "https://example.com/other",
        after: logicalTabId,
      },
    });
    await controller.handleReplicaTransition();
    expect((await replica.getRecord()).bindings[0]?.validatedAtServerSeq).toBe(2);
    state.tabs[0]!.status = "complete";
    await expect(
      controller.handleBrowserEvent({ type: "TAB_UPDATED", tabId: 20 }),
    ).resolves.toMatchObject({ kind: "IGNORED", reason: "NO_CHANGE" });
    expect((await replica.getRecord()).bindings[0]?.validatedAtServerSeq).toBe(3);
    expect(navigationCount).toBe(1);
    expect(state.tabs).toHaveLength(1);
  });

  it("keeps personal-tab and automatic-mode updates from triggering reconciliation", async () => {
    const observer = new FakeObserver();
    const actuator = new FakeActuator();
    observer.results.push({ kind: "IGNORED", reason: "PERSONAL_TAB" });
    const manual = new RoomBrowserController({ observer, actuator, browserChangePolicy: "MANUAL" });
    await manual.handleBrowserEvent({ type: "TAB_UPDATED", tabId: 30 });
    const automatic = new RoomBrowserController({ observer, actuator });
    await automatic.handleBrowserEvent({ type: "TAB_UPDATED", tabId: 20 });
    expect(actuator.confirmations).toEqual([]);
  });

  it("presents the exact retained-tab capacity message", () => {
    expect(
      browserRecoveryMessage({
        state: "BLOCKED",
        reason: "ROOM_TAB_LIMIT_REACHED",
        missingTabCount: 0,
        effectsApplied: 0,
      }),
    ).toBe("房间已达 20 个共享标签页；此页面仍保持打开");
  });

  it("serializes browser callbacks and surfaces observer recovery state", async () => {
    const observer = new FakeObserver();
    const actuator = new FakeActuator();
    observer.results.push(
      { kind: "IGNORED", reason: "NO_CHANGE" },
      { kind: "RECOVERY_REQUIRED", reason: "TAB_REPLACED" },
    );
    const controller = new RoomBrowserController({ observer, actuator });

    const first = controller.handleBrowserEvent({
      type: "TAB_UPDATED",
      tabId: 10,
    });
    const second = controller.handleBrowserEvent({
      type: "TAB_REPLACED",
      addedTabId: 20,
      removedTabId: 10,
    });
    await Promise.all([first, second]);

    expect(observer.events.map((event) => event.type)).toEqual(["TAB_UPDATED", "TAB_REPLACED"]);
    expect(observer.maximumActiveCalls).toBe(1);
    expect(controller.getStatus()).toEqual({
      state: "RECOVERY_REQUIRED",
      reason: "TAB_REPLACED",
      missingTabCount: 0,
      effectsApplied: 0,
    });
  });

  it("reconciles persisted transitions and exposes restore confirmation", async () => {
    const observer = new FakeObserver();
    const actuator = new FakeActuator();
    actuator.results.push(
      {
        kind: "CONFIRMATION_REQUIRED",
        missingTabCount: 6,
        effectsApplied: 0,
      },
      {
        kind: "SYNCHRONIZED",
        effectsApplied: 6,
      },
    );
    const controller = new RoomBrowserController({ observer, actuator });

    await controller.handleReplicaTransition();
    expect(controller.getStatus()).toMatchObject({
      state: "CONFIRMATION_REQUIRED",
      missingTabCount: 6,
    });

    await controller.confirmRecovery();

    expect(actuator.confirmations).toEqual([false, true]);
    expect(controller.getStatus()).toEqual({
      state: "SYNCHRONIZED",
      reason: null,
      missingTabCount: 0,
      effectsApplied: 6,
    });
  });

  it("exposes exact actuator block reasons without retry loops", async () => {
    const observer = new FakeObserver();
    const actuator = new FakeActuator();
    actuator.results.push({
      kind: "BLOCKED",
      reason: "CIRCUIT_BREAKER",
      effectsApplied: 8,
    });
    const controller = new RoomBrowserController({ observer, actuator });

    await controller.handleReplicaTransition();

    expect(actuator.confirmations).toEqual([false]);
    expect(controller.getStatus()).toEqual({
      state: "BLOCKED",
      reason: "CIRCUIT_BREAKER",
      missingTabCount: 0,
      effectsApplied: 8,
    });
  });

  it("serializes an explicit share-tab command through the observer", async () => {
    const observer = new FakeObserver();
    const actuator = new FakeActuator();
    observer.results.push({
      kind: "INTENT_RECORDED",
      operation: DurableOperationSchema.parse({
        type: "tab.create",
        logicalTabId: "018f8f8e-4b5c-7d6e-8f90-123456789ab1",
        url: "https://example.com/",
        after: null,
      }),
    });
    const controller = new RoomBrowserController({ observer, actuator });

    await expect(controller.shareBrowserTab(42)).resolves.toMatchObject({
      kind: "INTENT_RECORDED",
      operation: { type: "tab.create" },
    });
    expect(observer.events).toEqual([{ type: "TAB_UPDATED", tabId: 42 }]);
    expect(controller.getStatus().state).toBe("SYNCHRONIZED");
  });

  it("discards a draft only for an explicit new-page publication", async () => {
    const observer = new FakeObserver();
    const actuator = new FakeActuator();
    const controller = new RoomBrowserController({
      observer,
      actuator,
      browserChangePolicy: "MANUAL",
    });
    await controller.shareBrowserTab(42);
    expect(observer.shareOptions).toEqual([undefined]);
    await controller.shareBrowserTabAsNew(42);
    expect(observer.shareOptions).toEqual([undefined, { asNew: true }]);
    expect(observer.events).toEqual([
      { type: "TAB_UPDATED", tabId: 42 },
      { type: "TAB_UPDATED", tabId: 42 },
    ]);
  });

  it("surfaces a tab-capacity rejection as blocked without offering recovery confirmation", async () => {
    const observer = new FakeObserver();
    const actuator = new FakeActuator();
    observer.results.push({
      kind: "BLOCKED",
      reason: "ROOM_TAB_LIMIT_REACHED",
    });
    const controller = new RoomBrowserController({ observer, actuator });

    await controller.shareBrowserTab(42);

    expect(actuator.confirmations).toEqual([]);
    expect(controller.getStatus()).toEqual({
      state: "BLOCKED",
      reason: "ROOM_TAB_LIMIT_REACHED",
      missingTabCount: 0,
      effectsApplied: 0,
    });
  });
});
