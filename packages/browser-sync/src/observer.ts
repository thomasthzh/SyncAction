import {
  LogicalTabIdSchema,
  RoomIdSchema,
  DurableOperationSchema,
  type DurableOperation,
  type LogicalTabId,
} from "@syncaction/protocol";
import {
  ReplicaPermanentOperationError,
  type AfterLocalOperationPersisted,
  type DurableReplica,
  projectOptimisticState,
} from "@syncaction/replica";
import { z } from "zod";
import type { BrowserPort } from "./actuator.js";
import type { EffectLedger } from "./effect-ledger.js";
import {
  BrowserStateSchema,
  BrowserTabSchema,
  discoverRoomGroup,
  type BrowserState,
  type BrowserTab,
} from "./model.js";
import { canonicalizeSharedUrl } from "./url-policy.js";

const BrowserObjectIdSchema = z.number().int().nonnegative().safe();
const BrowserIndexSchema = z.number().int().nonnegative().safe();

export const BrowserObserverEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("TAB_CREATED"),
      tabId: BrowserObjectIdSchema,
      url: z.string().max(4_096).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_UPDATED"),
      tabId: BrowserObjectIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_MOVED"),
      tabId: BrowserObjectIdSchema,
      windowId: BrowserObjectIdSchema,
      index: BrowserIndexSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_REMOVED"),
      tabId: BrowserObjectIdSchema,
      windowId: BrowserObjectIdSchema,
      isWindowClosing: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_GROUP_CHANGED"),
      tabId: BrowserObjectIdSchema,
      groupId: BrowserObjectIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_DETACHED"),
      tabId: BrowserObjectIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_ATTACHED"),
      tabId: BrowserObjectIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_REPLACED"),
      addedTabId: BrowserObjectIdSchema,
      removedTabId: BrowserObjectIdSchema,
    })
    .strict(),
]);

export type BrowserObserverEvent = z.infer<typeof BrowserObserverEventSchema>;

export interface LocalOperationWriter {
  enqueueLocalOperation(
    operation: unknown,
    afterPersist?: AfterLocalOperationPersisted,
  ): Promise<void>;
}

export interface BrowserObserverOptions {
  roomId: unknown;
  replica: DurableReplica;
  browser: Pick<BrowserPort, "readState" | "ungroupTab">;
  ledger: EffectLedger;
  writer: LocalOperationWriter;
  isActuatable: () => boolean;
  now?: () => number;
  createLogicalTabId?: () => string;
}

export type BrowserObserverResult =
  | {
      kind: "IGNORED";
      reason: "EARLY_EVENT" | "LOADING" | "PERSONAL_TAB" | "NO_CHANGE";
    }
  | {
      kind: "EFFECT_CONSUMED";
      effectId: string;
      logicalTabId: LogicalTabId;
    }
  | {
      kind: "INTENT_RECORDED";
      operation: DurableOperation;
    }
  | {
      kind: "BLOCKED";
      reason: "REPLICA_NOT_ACTUATABLE" | "ROOM_TAB_LIMIT_REACHED";
    }
  | {
      kind: "RECOVERY_REQUIRED";
      reason:
        | "AMBIGUOUS_ROOM_GROUP"
        | "UNSAFE_ROOM_GROUP"
        | "STALE_BROWSER_SESSION"
        | "UNBOUND_ROOM_TABS"
        | "UNSUPPORTED_ROOM_TAB"
        | "BOUND_TAB_OUTSIDE_ROOM_GROUP"
        | "MISSING_BOUND_TAB"
        | "WINDOW_CLOSING"
        | "TAB_DETACHED"
        | "TAB_ATTACHED"
        | "TAB_REPLACED";
    };

export class BrowserObserver {
  readonly #roomId: ReturnType<typeof RoomIdSchema.parse>;
  readonly #replica: DurableReplica;
  readonly #browserPort: Pick<BrowserPort, "readState" | "ungroupTab">;
  readonly #ledger: EffectLedger;
  readonly #writer: LocalOperationWriter;
  readonly #isActuatable: () => boolean;
  readonly #now: () => number;
  readonly #createLogicalTabId: () => string;

  public constructor(options: BrowserObserverOptions) {
    this.#roomId = RoomIdSchema.parse(options.roomId);
    this.#replica = options.replica;
    this.#browserPort = options.browser;
    this.#ledger = options.ledger;
    this.#writer = options.writer;
    this.#isActuatable = options.isActuatable;
    this.#now = options.now ?? Date.now;
    this.#createLogicalTabId = options.createLogicalTabId ?? (() => crypto.randomUUID());
  }

  public async shareTab(tabIdInput: unknown): Promise<BrowserObserverResult> {
    const tabId = BrowserObjectIdSchema.parse(tabIdInput);
    if (!this.#isActuatable()) {
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" };
    }
    const [browserState, record] = await Promise.all([
      this.#browserPort.readState().then((state) => BrowserStateSchema.parse(state)),
      this.#replica.getRecord(),
    ]);
    if (record.mode !== "SYNCED" || record.confirmedSnapshot === null) {
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" };
    }
    if (
      record.bindings.some((binding) => binding.browserSessionId !== browserState.browserSessionId)
    ) {
      return { kind: "RECOVERY_REQUIRED", reason: "STALE_BROWSER_SESSION" };
    }
    if (record.bindings.some((binding) => binding.tabId === tabId)) {
      return { kind: "IGNORED", reason: "NO_CHANGE" };
    }
    const browserTab = browserState.tabs.find((tab) => tab.tabId === tabId);
    if (browserTab === undefined) {
      return { kind: "IGNORED", reason: "PERSONAL_TAB" };
    }
    const browserWindow = browserState.windows.find(
      (window) => window.windowId === browserTab.windowId,
    );
    if (
      browserWindow === undefined ||
      browserWindow.type !== "normal" ||
      browserWindow.incognito ||
      browserTab.pinned
    ) {
      return { kind: "RECOVERY_REQUIRED", reason: "UNSAFE_ROOM_GROUP" };
    }
    if (browserTab.status !== "complete") {
      return { kind: "IGNORED", reason: "LOADING" };
    }
    const url = canonicalRoomUrl(browserTab.url);
    if (url === undefined) {
      return { kind: "RECOVERY_REQUIRED", reason: "UNSUPPORTED_ROOM_TAB" };
    }
    const discovery = discoverRoomGroup(browserState, this.#roomId);
    if (discovery.kind === "AMBIGUOUS") {
      return { kind: "RECOVERY_REQUIRED", reason: "AMBIGUOUS_ROOM_GROUP" };
    }
    if (discovery.kind === "UNSAFE") {
      return { kind: "RECOVERY_REQUIRED", reason: "UNSAFE_ROOM_GROUP" };
    }
    if (
      discovery.kind === "FOUND" &&
      discovery.tabs.some((tab) => !record.bindings.some((binding) => binding.tabId === tab.tabId))
    ) {
      return { kind: "RECOVERY_REQUIRED", reason: "UNBOUND_ROOM_TABS" };
    }

    const optimistic = projectOptimisticState(record);
    const logicalTabId = LogicalTabIdSchema.parse(this.#createLogicalTabId());
    const operation = DurableOperationSchema.parse({
      type: "tab.create",
      logicalTabId,
      url,
      after: optimistic.order.at(-1) ?? null,
      ...(browserTab.title === null ? {} : { title: browserTab.title }),
    });
    const roomGroupId =
      discovery.kind === "FOUND" && browserTab.groupId === discovery.group.groupId
        ? discovery.group.groupId
        : null;
    try {
      await this.#writer.enqueueLocalOperation(operation, async () => {
        await this.#replica.bindTab({
          logicalTabId,
          tabId: browserTab.tabId,
          windowId: browserTab.windowId,
          groupId: roomGroupId,
          browserSessionId: browserState.browserSessionId,
          validatedAtServerSeq: record.confirmedSnapshot!.serverSeq,
        });
      });
    } catch (cause) {
      if (isRoomTabCapacityRejection(cause)) {
        return this.#cleanUpRejectedCreate(logicalTabId, browserTab.tabId);
      }
      throw cause;
    }
    return { kind: "INTENT_RECORDED", operation };
  }

  public async observe(eventInput: unknown): Promise<BrowserObserverResult> {
    const event = BrowserObserverEventSchema.parse(eventInput);
    if (event.type === "TAB_DETACHED") {
      return { kind: "RECOVERY_REQUIRED", reason: "TAB_DETACHED" };
    }
    if (event.type === "TAB_ATTACHED") {
      return { kind: "RECOVERY_REQUIRED", reason: "TAB_ATTACHED" };
    }
    if (event.type === "TAB_REPLACED") {
      return { kind: "RECOVERY_REQUIRED", reason: "TAB_REPLACED" };
    }
    if (event.type === "TAB_REMOVED") {
      return this.#observeRemoved(event);
    }

    const browserState = BrowserStateSchema.parse(await this.#browserPort.readState());
    const browserTab = browserState.tabs.find((tab) => tab.tabId === event.tabId);
    const consumed = this.#consumeEffect(event, browserTab);
    if (consumed !== undefined) {
      return {
        kind: "EFFECT_CONSUMED",
        effectId: consumed.effectId,
        logicalTabId: consumed.logicalTabId,
      };
    }
    if (event.type === "TAB_CREATED") {
      return { kind: "IGNORED", reason: "EARLY_EVENT" };
    }
    if (!this.#isActuatable()) {
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" };
    }

    const record = await this.#replica.getRecord();
    if (record.mode !== "SYNCED" || record.confirmedSnapshot === null) {
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" };
    }
    if (
      record.bindings.some((binding) => binding.browserSessionId !== browserState.browserSessionId)
    ) {
      return { kind: "RECOVERY_REQUIRED", reason: "STALE_BROWSER_SESSION" };
    }
    if (browserTab === undefined) {
      return { kind: "RECOVERY_REQUIRED", reason: "MISSING_BOUND_TAB" };
    }
    if (event.type === "TAB_UPDATED" && browserTab.status === "loading") {
      return { kind: "IGNORED", reason: "LOADING" };
    }

    const discovery = discoverRoomGroup(browserState, this.#roomId);
    if (discovery.kind === "AMBIGUOUS") {
      return { kind: "RECOVERY_REQUIRED", reason: "AMBIGUOUS_ROOM_GROUP" };
    }
    if (discovery.kind === "UNSAFE") {
      return { kind: "RECOVERY_REQUIRED", reason: "UNSAFE_ROOM_GROUP" };
    }

    const binding = record.bindings.find((candidate) => candidate.tabId === browserTab.tabId);
    if (discovery.kind === "MISSING") {
      return binding === undefined
        ? { kind: "IGNORED", reason: "PERSONAL_TAB" }
        : { kind: "RECOVERY_REQUIRED", reason: "BOUND_TAB_OUTSIDE_ROOM_GROUP" };
    }
    if (browserTab.groupId !== discovery.group.groupId) {
      return binding === undefined
        ? { kind: "IGNORED", reason: "PERSONAL_TAB" }
        : { kind: "RECOVERY_REQUIRED", reason: "BOUND_TAB_OUTSIDE_ROOM_GROUP" };
    }
    if (binding === undefined) {
      return this.#observeUnboundRoomTab(browserState, browserTab, discovery.tabs, record);
    }
    if (binding.groupId !== discovery.group.groupId || binding.windowId !== browserTab.windowId) {
      return { kind: "RECOVERY_REQUIRED", reason: "BOUND_TAB_OUTSIDE_ROOM_GROUP" };
    }

    const optimistic = projectOptimisticState(record);
    const logicalTab = optimistic.tabs[binding.logicalTabId];
    if (logicalTab === undefined || logicalTab.closedAtSeq !== null) {
      return { kind: "RECOVERY_REQUIRED", reason: "MISSING_BOUND_TAB" };
    }
    if (event.type === "TAB_UPDATED") {
      const url = canonicalRoomUrl(browserTab.url);
      if (url === undefined) {
        return { kind: "RECOVERY_REQUIRED", reason: "UNSUPPORTED_ROOM_TAB" };
      }
      if (canonicalRoomUrl(logicalTab.url) === url) {
        return { kind: "IGNORED", reason: "NO_CHANGE" };
      }
      return this.#recordIntent({
        type: "tab.navigate",
        logicalTabId: binding.logicalTabId,
        url,
      });
    }
    if (event.type === "TAB_MOVED") {
      const orderedBindings = discovery.tabs.map((tab) =>
        record.bindings.find((candidate) => candidate.tabId === tab.tabId),
      );
      if (orderedBindings.some((candidate) => candidate === undefined)) {
        return { kind: "RECOVERY_REQUIRED", reason: "UNBOUND_ROOM_TABS" };
      }
      const localOrder = orderedBindings.map((candidate) => candidate!.logicalTabId);
      if (
        localOrder.length !== optimistic.order.length ||
        localOrder.some((logicalTabId) => optimistic.tabs[logicalTabId]?.closedAtSeq !== null)
      ) {
        return { kind: "RECOVERY_REQUIRED", reason: "UNBOUND_ROOM_TABS" };
      }
      if (arraysEqual(localOrder, optimistic.order)) {
        return { kind: "IGNORED", reason: "NO_CHANGE" };
      }
      const movedIndex = localOrder.indexOf(binding.logicalTabId);
      if (movedIndex === -1) {
        return { kind: "RECOVERY_REQUIRED", reason: "UNBOUND_ROOM_TABS" };
      }
      return this.#recordIntent({
        type: "tab.move",
        logicalTabId: binding.logicalTabId,
        predecessor: localOrder[movedIndex - 1] ?? null,
        successor: localOrder[movedIndex + 1] ?? null,
      });
    }
    return { kind: "IGNORED", reason: "NO_CHANGE" };
  }

  async #observeRemoved(
    event: Extract<BrowserObserverEvent, { type: "TAB_REMOVED" }>,
  ): Promise<BrowserObserverResult> {
    const consumed = this.#ledger.consume({ type: "TAB_CLOSED", tabId: event.tabId }, this.#now());
    if (consumed !== undefined) {
      return {
        kind: "EFFECT_CONSUMED",
        effectId: consumed.effectId,
        logicalTabId: consumed.logicalTabId,
      };
    }
    if (event.isWindowClosing) {
      return { kind: "RECOVERY_REQUIRED", reason: "WINDOW_CLOSING" };
    }
    if (!this.#isActuatable()) {
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" };
    }
    const [browserState, record] = await Promise.all([
      this.#browserPort.readState().then((state) => BrowserStateSchema.parse(state)),
      this.#replica.getRecord(),
    ]);
    if (record.mode !== "SYNCED" || record.confirmedSnapshot === null) {
      return { kind: "BLOCKED", reason: "REPLICA_NOT_ACTUATABLE" };
    }
    const binding = record.bindings.find((candidate) => candidate.tabId === event.tabId);
    if (binding === undefined) {
      return { kind: "IGNORED", reason: "PERSONAL_TAB" };
    }
    if (
      binding.browserSessionId !== browserState.browserSessionId ||
      binding.windowId !== event.windowId
    ) {
      return { kind: "RECOVERY_REQUIRED", reason: "STALE_BROWSER_SESSION" };
    }
    const optimistic = projectOptimisticState(record);
    const logicalTab = optimistic.tabs[binding.logicalTabId];
    if (logicalTab === undefined || logicalTab.closedAtSeq !== null) {
      return { kind: "IGNORED", reason: "NO_CHANGE" };
    }
    const operation = DurableOperationSchema.parse({
      type: "tab.close",
      logicalTabId: binding.logicalTabId,
    });
    await this.#writer.enqueueLocalOperation(operation, async () => {
      await this.#replica.removeBinding(binding.logicalTabId);
    });
    return { kind: "INTENT_RECORDED", operation };
  }

  async #observeUnboundRoomTab(
    browserState: BrowserState,
    browserTab: BrowserTab,
    roomTabs: readonly BrowserTab[],
    record: Awaited<ReturnType<DurableReplica["getRecord"]>>,
  ): Promise<BrowserObserverResult> {
    const bindingsByTabId = new Map(record.bindings.map((binding) => [binding.tabId, binding]));
    const unboundTabs = roomTabs.filter((tab) => !bindingsByTabId.has(tab.tabId));
    if (unboundTabs.length !== 1 || unboundTabs[0]?.tabId !== browserTab.tabId) {
      return { kind: "RECOVERY_REQUIRED", reason: "UNBOUND_ROOM_TABS" };
    }
    if (browserTab.status !== "complete") {
      return { kind: "IGNORED", reason: "LOADING" };
    }
    const url = canonicalRoomUrl(browserTab.url);
    if (url === undefined || browserTab.pinned) {
      return { kind: "RECOVERY_REQUIRED", reason: "UNSUPPORTED_ROOM_TAB" };
    }
    const tabIndex = roomTabs.findIndex((tab) => tab.tabId === browserTab.tabId);
    const predecessor = roomTabs
      .slice(0, tabIndex)
      .toReversed()
      .map((tab) => bindingsByTabId.get(tab.tabId)?.logicalTabId)
      .find((logicalTabId) => logicalTabId !== undefined);
    const logicalTabId = LogicalTabIdSchema.parse(this.#createLogicalTabId());
    const operation = DurableOperationSchema.parse({
      type: "tab.create",
      logicalTabId,
      url,
      after: predecessor ?? null,
      ...(browserTab.title === null ? {} : { title: browserTab.title }),
    });
    try {
      await this.#writer.enqueueLocalOperation(operation, async () => {
        await this.#replica.bindTab({
          logicalTabId,
          tabId: browserTab.tabId,
          windowId: browserTab.windowId,
          groupId: browserTab.groupId,
          browserSessionId: browserState.browserSessionId,
          validatedAtServerSeq: record.confirmedSnapshot!.serverSeq,
        });
      });
    } catch (cause) {
      if (isRoomTabCapacityRejection(cause)) {
        return this.#cleanUpRejectedCreate(logicalTabId, browserTab.tabId);
      }
      throw cause;
    }
    return { kind: "INTENT_RECORDED", operation };
  }

  async #recordIntent(operationInput: unknown): Promise<BrowserObserverResult> {
    const operation = DurableOperationSchema.parse(operationInput);
    await this.#writer.enqueueLocalOperation(operation);
    return { kind: "INTENT_RECORDED", operation };
  }

  async #cleanUpRejectedCreate(
    logicalTabId: LogicalTabId,
    localTabId: number,
  ): Promise<BrowserObserverResult> {
    const recordBeforeCleanup = await this.#replica.getRecord();
    if (recordBeforeCleanup.bindings.some((binding) => binding.logicalTabId === logicalTabId)) {
      await this.#replica.removeBinding(logicalTabId);
    }
    const browserState = BrowserStateSchema.parse(await this.#browserPort.readState());
    const localTab = browserState.tabs.find((tab) => tab.tabId === localTabId);
    if (localTab !== undefined && localTab.groupId !== null) {
      try {
        const ungrouped = BrowserTabSchema.parse(await this.#browserPort.ungroupTab(localTabId));
        if (ungrouped.tabId !== localTabId || ungrouped.groupId !== null) {
          throw new Error("UNGROUP_TAB_POSTCONDITION_FAILED");
        }
      } catch (cause) {
        const latestState = BrowserStateSchema.parse(await this.#browserPort.readState());
        const latestLocalTab = latestState.tabs.find((tab) => tab.tabId === localTabId);
        if (latestLocalTab !== undefined && latestLocalTab.groupId !== null) {
          throw cause;
        }
      }
    }
    const recordAfterCleanup = await this.#replica.getRecord();
    if (recordAfterCleanup.bindings.some((binding) => binding.logicalTabId === logicalTabId)) {
      throw new Error("REJECTED_CREATE_BINDING_REMAINS");
    }
    return { kind: "BLOCKED", reason: "ROOM_TAB_LIMIT_REACHED" };
  }

  #consumeEffect(
    event: Exclude<BrowserObserverEvent, { type: "TAB_REMOVED" }>,
    browserTab: BrowserTab | undefined,
  ) {
    switch (event.type) {
      case "TAB_CREATED": {
        const url = canonicalRoomUrl(event.url);
        return url === undefined
          ? undefined
          : this.#ledger.consume({ type: "TAB_CREATED", tabId: event.tabId, url }, this.#now());
      }
      case "TAB_UPDATED": {
        if (browserTab?.status !== "complete") {
          return undefined;
        }
        const url = canonicalRoomUrl(browserTab.url);
        if (url !== undefined) {
          const navigation = this.#ledger.consume(
            { type: "TAB_NAVIGATED", tabId: event.tabId, url },
            this.#now(),
          );
          if (navigation !== undefined) {
            return navigation;
          }
        }
        return this.#ledger.consume(
          {
            type: "TAB_METADATA",
            tabId: event.tabId,
            title: browserTab.title,
          },
          this.#now(),
        );
      }
      case "TAB_MOVED":
        return this.#ledger.consume(
          {
            type: "TAB_MOVED",
            tabId: event.tabId,
            windowId: event.windowId,
            index: event.index,
          },
          this.#now(),
        );
      case "TAB_GROUP_CHANGED":
        return event.groupId === null
          ? undefined
          : this.#ledger.consume(
              {
                type: "TAB_GROUPED",
                tabId: event.tabId,
                groupId: event.groupId,
              },
              this.#now(),
            );
      case "TAB_DETACHED":
      case "TAB_ATTACHED":
      case "TAB_REPLACED":
        return undefined;
    }
  }
}

function canonicalRoomUrl(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) {
    return undefined;
  }
  try {
    return canonicalizeSharedUrl(url);
  } catch {
    return undefined;
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRoomTabCapacityRejection(cause: unknown): cause is ReplicaPermanentOperationError {
  return (
    cause instanceof ReplicaPermanentOperationError && cause.serverCode === "ROOM_TAB_LIMIT_REACHED"
  );
}
