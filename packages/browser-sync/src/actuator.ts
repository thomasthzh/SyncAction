import type { DurableReplica } from "@syncaction/replica";
import type { BrowserCircuitBreaker } from "./circuit-breaker.js";
import type { BrowserEffect, EffectLedger } from "./effect-ledger.js";
import {
  BrowserGroupSchema,
  BrowserStateSchema,
  BrowserTabSchema,
  roomGroupTitle,
  type BrowserGroup,
  type BrowserState,
  type BrowserTab,
} from "./model.js";
import { nextReconciliation, type BrowserReconciliationEffect } from "./reconciler.js";
import { canonicalizeSharedUrl } from "./url-policy.js";

export interface BrowserPort {
  readState(): Promise<BrowserState>;
  createTab(input: { url: string; index: number; windowId: number | null }): Promise<BrowserTab>;
  groupTab(input: {
    tabId: number;
    groupId: number | null;
    title: string;
  }): Promise<{ tab: BrowserTab; group: BrowserGroup }>;
  ungroupTab(tabId: number): Promise<BrowserTab>;
  navigateTab(input: { tabId: number; url: string }): Promise<BrowserTab>;
  moveTab(input: { tabId: number; windowId: number; index: number }): Promise<BrowserTab>;
  closeTab(tabId: number): Promise<void>;
}

export interface BrowserActuatorOptions {
  roomId: string;
  replica: DurableReplica;
  browser: BrowserPort;
  ledger: EffectLedger;
  breaker: BrowserCircuitBreaker;
  isActuatable: () => boolean;
  now?: () => number;
  createEffectId?: () => string;
  wait?: (milliseconds: number) => Promise<void>;
}

export type BrowserActuatorResult =
  | { kind: "SYNCHRONIZED"; effectsApplied: number }
  | {
      kind: "CONFIRMATION_REQUIRED";
      missingTabCount: number;
      effectsApplied: number;
    }
  | {
      kind: "BLOCKED";
      reason:
        | "REPLICA_NOT_ACTUATABLE"
        | "AMBIGUOUS_ROOM_GROUP"
        | "UNSAFE_ROOM_GROUP"
        | "STALE_BINDINGS"
        | "UNBOUND_ROOM_TAB"
        | "BOUND_TAB_OUTSIDE_ROOM_GROUP"
        | "BROWSER_API_FAILURE"
        | "POST_EFFECT_MISMATCH"
        | "CIRCUIT_BREAKER";
      effectsApplied: number;
    };

export class BrowserActuator {
  readonly #roomId: string;
  readonly #replica: DurableReplica;
  readonly #browserPort: BrowserPort;
  readonly #ledger: EffectLedger;
  readonly #breaker: BrowserCircuitBreaker;
  readonly #isActuatable: () => boolean;
  readonly #now: () => number;
  readonly #createEffectId: () => string;
  readonly #wait: (milliseconds: number) => Promise<void>;

  public constructor(options: BrowserActuatorOptions) {
    this.#roomId = options.roomId;
    this.#replica = options.replica;
    this.#browserPort = options.browser;
    this.#ledger = options.ledger;
    this.#breaker = options.breaker;
    this.#isActuatable = options.isActuatable;
    this.#now = options.now ?? Date.now;
    this.#createEffectId = options.createEffectId ?? (() => crypto.randomUUID());
    this.#wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  public async reconcile(options: { confirmedRecovery: boolean }): Promise<BrowserActuatorResult> {
    let effectsApplied = 0;
    let previousEffectKey: string | undefined;
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      if (!this.#isActuatable()) {
        return {
          kind: "BLOCKED",
          reason: "REPLICA_NOT_ACTUATABLE",
          effectsApplied,
        };
      }
      const record = await this.#replica.getRecord();
      if (record.mode !== "SYNCED") {
        return {
          kind: "BLOCKED",
          reason: "REPLICA_NOT_ACTUATABLE",
          effectsApplied,
        };
      }
      const browserState = BrowserStateSchema.parse(await this.#browserPort.readState());
      const next = nextReconciliation({
        actuatable: true,
        record,
        browserState,
        confirmedRecovery: options.confirmedRecovery,
      });
      if (next.kind === "NOOP") {
        return { kind: "SYNCHRONIZED", effectsApplied };
      }
      if (next.kind === "BLOCKED") {
        return {
          ...next,
          effectsApplied,
        };
      }
      if (next.kind === "CONFIRMATION_REQUIRED") {
        return {
          ...next,
          effectsApplied,
        };
      }
      if (next.kind === "REBUILD_BINDINGS") {
        try {
          await this.#replica.replaceBindings(next.bindings);
        } catch {
          return {
            kind: "BLOCKED",
            reason: "BROWSER_API_FAILURE",
            effectsApplied,
          };
        }
        previousEffectKey = undefined;
        continue;
      }
      const effectKey = JSON.stringify(next.effect);
      if (effectKey === previousEffectKey) {
        return {
          kind: "BLOCKED",
          reason: "POST_EFFECT_MISMATCH",
          effectsApplied,
        };
      }
      const breakerResult =
        next.effect.kind === "CREATE" || next.effect.kind === "CLOSE"
          ? this.#breaker.record({
              kind: next.effect.kind,
              logicalTabId: next.effect.logicalTabId,
              atMs: this.#now(),
              confirmedRecovery: next.effect.confirmedRecovery,
            })
          : { kind: "ALLOW" as const };
      if (breakerResult.kind === "TRIPPED") {
        return {
          kind: "BLOCKED",
          reason: "CIRCUIT_BREAKER",
          effectsApplied,
        };
      }
      try {
        await this.#applyEffect(next.effect, browserState);
      } catch (cause) {
        if (cause instanceof BrowserPostconditionError) {
          return {
            kind: "BLOCKED",
            reason: "POST_EFFECT_MISMATCH",
            effectsApplied: effectsApplied + 1,
          };
        }
        return {
          kind: "BLOCKED",
          reason: "BROWSER_API_FAILURE",
          effectsApplied,
        };
      }
      effectsApplied += 1;
      previousEffectKey = effectKey;
    }
    return {
      kind: "BLOCKED",
      reason: "POST_EFFECT_MISMATCH",
      effectsApplied,
    };
  }

  async #applyEffect(
    effect: BrowserReconciliationEffect,
    browserState: BrowserState,
  ): Promise<void> {
    switch (effect.kind) {
      case "CREATE": {
        const group =
          effect.groupId === null
            ? undefined
            : browserState.groups.find((candidate) => candidate.groupId === effect.groupId);
        const createEffectId = this.#beginEffect(effect.logicalTabId, effect.serverSeq, {
          type: "TAB_CREATED",
          tabId: null,
          url: canonicalizeSharedUrl(effect.url),
        });
        const created = BrowserTabSchema.parse(
          await this.#browserPort.createTab({
            url: effect.url,
            index: effect.index,
            windowId: group?.windowId ?? null,
          }),
        );
        if (created.groupId !== null || !urlsEqual(created.url, effect.url)) {
          throw new BrowserPostconditionError();
        }
        this.#ledger.attachCreatedTab(createEffectId, created.tabId);
        await this.#replica.bindTab({
          logicalTabId: effect.logicalTabId,
          tabId: created.tabId,
          windowId: created.windowId,
          groupId: null,
          browserSessionId: browserState.browserSessionId,
          validatedAtServerSeq: effect.serverSeq,
        });
        await this.#groupBoundTab(
          effect.logicalTabId,
          created.tabId,
          effect.groupId,
          effect.serverSeq,
          browserState.browserSessionId,
        );
        if (effect.confirmedRecovery) {
          await this.#wait(500);
        }
        return;
      }
      case "GROUP":
        await this.#groupBoundTab(
          effect.logicalTabId,
          effect.tabId,
          effect.groupId,
          effect.serverSeq,
          browserState.browserSessionId,
        );
        return;
      case "NAVIGATE": {
        this.#beginEffect(effect.logicalTabId, effect.serverSeq, {
          type: "TAB_NAVIGATED",
          tabId: effect.tabId,
          url: canonicalizeSharedUrl(effect.url),
        });
        const updated = BrowserTabSchema.parse(
          await this.#browserPort.navigateTab({
            tabId: effect.tabId,
            url: effect.url,
          }),
        );
        if (updated.tabId !== effect.tabId || !urlsEqual(updated.url, effect.url)) {
          throw new BrowserPostconditionError();
        }
        return;
      }
      case "MOVE": {
        this.#beginEffect(effect.logicalTabId, effect.serverSeq, {
          type: "TAB_MOVED",
          tabId: effect.tabId,
          windowId: effect.windowId,
          index: effect.index,
        });
        const moved = BrowserTabSchema.parse(
          await this.#browserPort.moveTab({
            tabId: effect.tabId,
            windowId: effect.windowId,
            index: effect.index,
          }),
        );
        if (
          moved.tabId !== effect.tabId ||
          moved.windowId !== effect.windowId ||
          moved.index !== effect.index
        ) {
          throw new BrowserPostconditionError();
        }
        return;
      }
      case "CLOSE":
        this.#beginEffect(effect.logicalTabId, effect.serverSeq, {
          type: "TAB_CLOSED",
          tabId: effect.tabId,
        });
        await this.#browserPort.closeTab(effect.tabId);
        await this.#replica.removeBinding(effect.logicalTabId);
        return;
      case "FORGET_BINDING":
        await this.#replica.removeBinding(effect.logicalTabId);
        return;
    }
  }

  async #groupBoundTab(
    logicalTabId: string,
    tabId: number,
    groupId: number | null,
    serverSeq: number,
    browserSessionId: string,
  ): Promise<void> {
    const groupEffectId = this.#beginEffect(logicalTabId, serverSeq, {
      type: "TAB_GROUPED",
      tabId,
      groupId,
    });
    const groupedResult = await this.#browserPort.groupTab({
      tabId,
      groupId,
      title: roomGroupTitle(this.#roomId),
    });
    const tab = BrowserTabSchema.parse(groupedResult.tab);
    const group = BrowserGroupSchema.parse(groupedResult.group);
    if (groupId === null) {
      this.#ledger.attachGroup(groupEffectId, group.groupId);
    }
    if (
      tab.tabId !== tabId ||
      tab.groupId !== group.groupId ||
      group.title !== roomGroupTitle(this.#roomId) ||
      tab.windowId !== group.windowId
    ) {
      throw new BrowserPostconditionError();
    }
    await this.#replica.bindTab({
      logicalTabId,
      tabId,
      windowId: tab.windowId,
      groupId: group.groupId,
      browserSessionId,
      validatedAtServerSeq: serverSeq,
    });
  }

  #beginEffect(
    logicalTabId: string,
    serverSeq: number,
    expectation: BrowserEffect["expectation"],
  ): string {
    const effectId = this.#createEffectId();
    const startedAtMs = this.#now();
    this.#ledger.begin({
      effectId,
      logicalTabId,
      serverSeq,
      expectation,
      startedAtMs,
      expiresAtMs: startedAtMs + 5_000,
    });
    return effectId;
  }
}

class BrowserPostconditionError extends Error {
  public constructor() {
    super("BROWSER_POSTCONDITION_FAILED");
    this.name = "BrowserPostconditionError";
  }
}

function urlsEqual(left: string | null | undefined, right: string): boolean {
  return (
    left !== null &&
    left !== undefined &&
    canonicalizeSharedUrl(left) === canonicalizeSharedUrl(right)
  );
}
