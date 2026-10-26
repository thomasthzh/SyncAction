import {
  BrowserObserverEventSchema,
  type BrowserActuator,
  type BrowserActuatorResult,
  type BrowserObserver,
  type BrowserObserverResult,
  type PendingTabPublication,
  type BrowserChangePolicy,
} from "@syncaction/browser-sync";

export interface RoomBrowserControllerOptions {
  observer: Pick<BrowserObserver, "observe" | "shareTab"> &
    Partial<Pick<BrowserObserver, "readPendingPublication" | "discardPendingPublication">>;
  actuator: Pick<BrowserActuator, "reconcile"> & Partial<Pick<BrowserActuator, "openSharedTab">>;
  browserChangePolicy?: BrowserChangePolicy;
}

type ObserverStatusReason = Extract<
  BrowserObserverResult,
  { kind: "BLOCKED" | "RECOVERY_REQUIRED" }
>["reason"];
type ActuatorStatusReason = Extract<BrowserActuatorResult, { kind: "BLOCKED" }>["reason"];

export interface RoomBrowserStatus {
  state: "IDLE" | "SYNCHRONIZED" | "CONFIRMATION_REQUIRED" | "RECOVERY_REQUIRED" | "BLOCKED";
  reason: ObserverStatusReason | ActuatorStatusReason | null;
  missingTabCount: number;
  effectsApplied: number;
}

export function browserRecoveryMessage(status: RoomBrowserStatus | null): string {
  if (status?.state === "CONFIRMATION_REQUIRED") {
    return `需要恢复 ${status.missingTabCount} 个标签页。`;
  }
  if (status?.state === "BLOCKED" && status.reason === "ROOM_TAB_LIMIT_REACHED") {
    return "房间已达 20 个共享标签页；此页面仍保持打开";
  }
  return status?.reason ?? "";
}

export class RoomBrowserController {
  readonly #observer: RoomBrowserControllerOptions["observer"];
  readonly #actuator: RoomBrowserControllerOptions["actuator"];
  readonly #browserChangePolicy: BrowserChangePolicy;
  #tail: Promise<void> = Promise.resolve();
  #status: RoomBrowserStatus = {
    state: "IDLE",
    reason: null,
    missingTabCount: 0,
    effectsApplied: 0,
  };

  public constructor(options: RoomBrowserControllerOptions) {
    this.#observer = options.observer;
    this.#actuator = options.actuator;
    this.#browserChangePolicy = options.browserChangePolicy ?? "AUTOMATIC";
  }

  public getStatus(): RoomBrowserStatus {
    return structuredClone(this.#status);
  }

  public readPendingPublication(tabId: unknown): PendingTabPublication | null {
    return this.#observer.readPendingPublication?.(tabId) ?? null;
  }

  public openSharedTab(logicalTabId: unknown): Promise<BrowserActuatorResult> {
    return this.#enqueue(async () => {
      if (this.#actuator.openSharedTab === undefined) throw new Error("ROOM_TAB_NOT_AVAILABLE");
      const result = await this.#actuator.openSharedTab(logicalTabId);
      this.#setActuatorResult(result);
      return result;
    });
  }

  public async handleBrowserEvent(eventInput: unknown): Promise<BrowserObserverResult> {
    return this.#enqueue(async () => {
      const result = await this.#observer.observe(eventInput);
      this.#setObserverResult(result);
      const event = BrowserObserverEventSchema.safeParse(eventInput);
      if (
        this.#browserChangePolicy === "MANUAL" &&
        event.success &&
        event.data.type === "TAB_UPDATED" &&
        (result.kind === "EFFECT_CONSUMED" ||
          (result.kind === "IGNORED" && result.reason === "NO_CHANGE"))
      ) {
        // Browser navigation completes after the replica transition. Revalidate
        // the finished document without enqueueing another controller operation.
        this.#setActuatorResult(await this.#actuator.reconcile({ confirmedRecovery: false }));
      }
      return result;
    });
  }

  public async shareBrowserTab(
    tabIdInput: unknown,
    expectedUrl?: string,
  ): Promise<BrowserObserverResult> {
    return this.#enqueue(async () => {
      const result = await this.#observer.shareTab(
        tabIdInput,
        expectedUrl === undefined ? undefined : { expectedUrl },
      );
      this.#setObserverResult(result);
      return result;
    });
  }

  public async shareBrowserTabAsNew(
    tabIdInput: unknown,
    expectedUrl?: string,
  ): Promise<BrowserObserverResult> {
    return this.#enqueue(async () => {
      const result = await this.#observer.shareTab(tabIdInput, {
        asNew: true,
        ...(expectedUrl === undefined ? {} : { expectedUrl }),
      });
      this.#setObserverResult(result);
      return result;
    });
  }

  public async handleReplicaTransition(): Promise<BrowserActuatorResult> {
    return this.#reconcile(false);
  }

  public async confirmRecovery(): Promise<BrowserActuatorResult> {
    return this.#reconcile(true);
  }

  public async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.#tail;
      await observed;
    } while (observed !== this.#tail);
  }

  #reconcile(confirmedRecovery: boolean): Promise<BrowserActuatorResult> {
    return this.#enqueue(async () => {
      const result = await this.#actuator.reconcile({ confirmedRecovery });
      this.#setActuatorResult(result);
      return result;
    });
  }

  #setObserverResult(result: BrowserObserverResult): void {
    switch (result.kind) {
      case "INTENT_RECORDED":
      case "EFFECT_CONSUMED":
      case "LOCAL_STATE_CHANGED":
        this.#status = {
          state: "SYNCHRONIZED",
          reason: null,
          missingTabCount: 0,
          effectsApplied: 0,
        };
        return;
      case "RECOVERY_REQUIRED":
        this.#status = {
          state: "RECOVERY_REQUIRED",
          reason: result.reason,
          missingTabCount: 0,
          effectsApplied: 0,
        };
        return;
      case "BLOCKED":
        this.#status = {
          state: "BLOCKED",
          reason: result.reason,
          missingTabCount: 0,
          effectsApplied: 0,
        };
        return;
      case "IGNORED":
        return;
    }
  }

  #setActuatorResult(result: BrowserActuatorResult): void {
    switch (result.kind) {
      case "SYNCHRONIZED":
        this.#status = {
          state: "SYNCHRONIZED",
          reason: null,
          missingTabCount: 0,
          effectsApplied: result.effectsApplied,
        };
        return;
      case "CONFIRMATION_REQUIRED":
        this.#status = {
          state: "CONFIRMATION_REQUIRED",
          reason: null,
          missingTabCount: result.missingTabCount,
          effectsApplied: result.effectsApplied,
        };
        return;
      case "BLOCKED":
        this.#status = {
          state: "BLOCKED",
          reason: result.reason,
          missingTabCount: 0,
          effectsApplied: result.effectsApplied,
        };
        return;
    }
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
