import { ReplicaError, type DurableReplica, type ReplicaRecord } from "@syncaction/replica";
import { LogicalTabIdSchema } from "@syncaction/protocol";
import type { BrowserCircuitBreaker } from "./circuit-breaker.js";
import type { BrowserEffect, EffectLedger } from "./effect-ledger.js";
import {
  BrowserGroupSchema,
  BrowserStateSchema,
  BrowserTabSchema,
  roomGroupTitle,
  discoverRoomGroup,
  type BrowserGroup,
  type BrowserState,
  type BrowserTab,
  type BrowserChangePolicy,
} from "./model.js";
import {
  nextReconciliation,
  type BrowserReconciliationEffect,
  type ValidatedBrowserDocument,
} from "./reconciler.js";
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
  browserChangePolicy?: BrowserChangePolicy;
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
  readonly #browserChangePolicy: BrowserChangePolicy;
  readonly #validatedDocuments = new Map<string, ValidatedBrowserDocument>();

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
    this.#browserChangePolicy = options.browserChangePolicy ?? "AUTOMATIC";
  }

  public async openSharedTab(logicalTabIdInput: unknown): Promise<BrowserActuatorResult> {
    const logicalTabId = LogicalTabIdSchema.parse(logicalTabIdInput);
    if (!this.#isActuatable())
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE", effectsApplied: 0 };
    const record = await this.#replica.getRecord();
    const snapshot = record.confirmedSnapshot;
    if (record.mode !== "SYNCED" || snapshot === null)
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE", effectsApplied: 0 };
    const target = snapshot.tabs.find((tab) => tab.id === logicalTabId && tab.closedAtSeq === null);
    if (target === undefined)
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE", effectsApplied: 0 };
    const state = BrowserStateSchema.parse(await this.#browserPort.readState());
    const discovery = discoverRoomGroup(state, this.#roomId);
    if (discovery.kind === "AMBIGUOUS")
      return { kind: "BLOCKED", reason: "AMBIGUOUS_ROOM_GROUP", effectsApplied: 0 };
    if (discovery.kind === "UNSAFE")
      return { kind: "BLOCKED", reason: "UNSAFE_ROOM_GROUP", effectsApplied: 0 };
    if (record.bindings.some((binding) => binding.browserSessionId !== state.browserSessionId))
      return { kind: "BLOCKED", reason: "STALE_BINDINGS", effectsApplied: 0 };
    const binding = record.bindings.find((item) => item.logicalTabId === logicalTabId);
    const local =
      binding === undefined ? undefined : state.tabs.find((tab) => tab.tabId === binding.tabId);
    if (
      local !== undefined &&
      urlsEqual(local.url, target.url) &&
      binding?.windowId === local.windowId &&
      binding.groupId === local.groupId &&
      discovery.kind === "FOUND" &&
      local.groupId === discovery.group.groupId
    ) {
      this.#captureValidatedDocuments(record, state);
      await this.#refreshValidatedBindings(record, state);
      return { kind: "SYNCHRONIZED", effectsApplied: 0 };
    }
    if (binding !== undefined) await this.#replica.removeBinding(logicalTabId);
    const effect: BrowserReconciliationEffect = {
      kind: "CREATE",
      logicalTabId,
      url: target.url,
      index: state.tabs.length === 0 ? 0 : Math.max(...state.tabs.map((tab) => tab.index)) + 1,
      groupId: discovery.kind === "FOUND" ? discovery.group.groupId : null,
      serverSeq: snapshot.serverSeq,
      confirmedRecovery: true,
    };
    const breaker = this.#breaker.record({
      kind: "CREATE",
      logicalTabId,
      atMs: this.#now(),
      confirmedRecovery: true,
    });
    if (breaker.kind === "TRIPPED")
      return { kind: "BLOCKED", reason: "CIRCUIT_BREAKER", effectsApplied: 0 };
    try {
      await this.#applyEffect(effect, state);
      const latest = await this.#replica.getRecord();
      const latestTarget = latest.confirmedSnapshot?.tabs.find((tab) => tab.id === logicalTabId);
      if (
        !this.#isActuatable() ||
        latest.mode !== "SYNCED" ||
        latestTarget?.closedAtSeq !== null ||
        latestTarget.url !== target.url
      ) {
        await this.#replica.removeBinding(logicalTabId);
        return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE", effectsApplied: 1 };
      }
      await this.#refreshValidatedBindings(
        latest,
        BrowserStateSchema.parse(await this.#browserPort.readState()),
      );
      this.#captureValidatedDocuments(
        latest,
        BrowserStateSchema.parse(await this.#browserPort.readState()),
      );
      return { kind: "SYNCHRONIZED", effectsApplied: 1 };
    } catch (cause) {
      return {
        kind: "BLOCKED",
        reason:
          cause instanceof BrowserPostconditionError
            ? "POST_EFFECT_MISMATCH"
            : "BROWSER_API_FAILURE",
        effectsApplied: 0,
      };
    }
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
      this.#captureValidatedDocuments(record, browserState);
      const next = nextReconciliation({
        actuatable: true,
        record,
        browserState,
        confirmedRecovery: options.confirmedRecovery,
        browserChangePolicy: this.#browserChangePolicy,
        validatedDocuments: [...this.#validatedDocuments.values()],
      });
      if (next.kind === "NOOP") {
        await this.#refreshValidatedBindings(record, browserState);
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

  #captureValidatedDocuments(record: ReplicaRecord, browserState: BrowserState): void {
    const liveIds = new Set<string>(record.bindings.map((binding) => binding.logicalTabId));
    for (const id of this.#validatedDocuments.keys())
      if (!liveIds.has(id)) this.#validatedDocuments.delete(id);
    for (const binding of record.bindings) {
      const local = browserState.tabs.find((tab) => tab.tabId === binding.tabId);
      const canonical = record.confirmedSnapshot?.tabs.find(
        (tab) => tab.id === binding.logicalTabId,
      );
      if (
        binding.browserSessionId === browserState.browserSessionId &&
        local?.status === "complete" &&
        local.windowId === binding.windowId &&
        local.groupId === binding.groupId &&
        canonical !== undefined &&
        canonical.closedAtSeq === null &&
        urlsEqual(local.url, canonical.url)
      ) {
        this.#validatedDocuments.set(binding.logicalTabId, {
          logicalTabId: binding.logicalTabId,
          tabId: binding.tabId,
          browserSessionId: binding.browserSessionId,
          url: canonical.url,
          updatedAtSeq: canonical.updatedAtSeq,
        });
      }
    }
  }

  async #refreshValidatedBindings(
    record: ReplicaRecord,
    browserState: BrowserState,
  ): Promise<void> {
    const snapshot = record.confirmedSnapshot;
    if (snapshot === null || record.mode !== "SYNCED") return;
    for (const binding of record.bindings) {
      if (binding.validatedAtServerSeq === snapshot.serverSeq) continue;
      const local = browserState.tabs.find((tab) => tab.tabId === binding.tabId);
      const canonical = snapshot.tabs.find(
        (tab) => tab.id === binding.logicalTabId && tab.closedAtSeq === null,
      );
      if (
        binding.browserSessionId !== browserState.browserSessionId ||
        local?.status !== "complete" ||
        local.windowId !== binding.windowId ||
        local.groupId !== binding.groupId ||
        canonical === undefined ||
        !urlsEqual(local.url, canonical.url)
      )
        continue;
      const latest = await this.#replica.getRecord();
      if (
        !this.#isActuatable() ||
        latest.mode !== "SYNCED" ||
        latest.confirmedSnapshot?.serverSeq !== snapshot.serverSeq ||
        !latest.bindings.some(
          (candidate) =>
            candidate.logicalTabId === binding.logicalTabId &&
            candidate.tabId === binding.tabId &&
            candidate.windowId === binding.windowId &&
            candidate.groupId === binding.groupId &&
            candidate.browserSessionId === binding.browserSessionId,
        )
      )
        return;
      try {
        await this.#replica.bindTab({ ...binding, validatedAtServerSeq: snapshot.serverSeq });
      } catch (cause) {
        if (cause instanceof ReplicaError && cause.code === "INVALID_REPLICA_TRANSITION") return;
        throw cause;
      }
    }
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
        await this.#rememberEffectDocument(effect, created.tabId, browserState.browserSessionId);
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
        await this.#rememberEffectDocument(effect, updated.tabId, browserState.browserSessionId);
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

  async #rememberEffectDocument(
    effect: Extract<BrowserReconciliationEffect, { kind: "CREATE" | "NAVIGATE" }>,
    tabId: number,
    browserSessionId: string,
  ): Promise<void> {
    const record = await this.#replica.getRecord();
    const canonical = record.confirmedSnapshot?.tabs.find((tab) => tab.id === effect.logicalTabId);
    if (
      canonical !== undefined &&
      canonical.closedAtSeq === null &&
      urlsEqual(canonical.url, effect.url)
    ) {
      this.#validatedDocuments.set(effect.logicalTabId, {
        logicalTabId: effect.logicalTabId,
        tabId,
        browserSessionId,
        url: canonical.url,
        updatedAtSeq: canonical.updatedAtSeq,
      });
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
