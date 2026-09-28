import type {
  BrowserActuatorResult,
  BrowserObserverEvent,
  BrowserObserverResult,
} from "@syncaction/browser-sync";
import { DurableOperationSchema } from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import { browserRecoveryMessage, RoomBrowserController } from "../src/room-browser-controller.js";

class FakeObserver {
  public readonly events: BrowserObserverEvent[] = [];
  public results: BrowserObserverResult[] = [];
  public activeCalls = 0;
  public maximumActiveCalls = 0;

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

  public async shareTab(tabId: unknown): Promise<BrowserObserverResult> {
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
