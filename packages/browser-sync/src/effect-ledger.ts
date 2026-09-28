import { LogicalTabIdSchema } from "@syncaction/protocol";
import { z } from "zod";

const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const SafePositiveIntegerSchema = z.number().int().positive().safe();
const BrowserObjectIdSchema = z.number().int().nonnegative().safe();

const CreatedExpectationSchema = z
  .object({
    type: z.literal("TAB_CREATED"),
    tabId: BrowserObjectIdSchema.nullable(),
    url: z.string().max(4_096),
  })
  .strict();

const GroupedExpectationSchema = z
  .object({
    type: z.literal("TAB_GROUPED"),
    tabId: BrowserObjectIdSchema,
    groupId: BrowserObjectIdSchema.nullable(),
  })
  .strict();

export const BrowserEffectExpectationSchema = z.discriminatedUnion("type", [
  CreatedExpectationSchema,
  GroupedExpectationSchema,
  z
    .object({
      type: z.literal("TAB_NAVIGATED"),
      tabId: BrowserObjectIdSchema,
      url: z.string().max(4_096),
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_MOVED"),
      tabId: BrowserObjectIdSchema,
      windowId: BrowserObjectIdSchema,
      index: SafeNonnegativeIntegerSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_CLOSED"),
      tabId: BrowserObjectIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("TAB_METADATA"),
      tabId: BrowserObjectIdSchema,
      title: z.string().max(512).nullable(),
    })
    .strict(),
]);

export const BrowserObservedEventSchema = z.discriminatedUnion("type", [
  CreatedExpectationSchema.extend({ tabId: BrowserObjectIdSchema }).strict(),
  GroupedExpectationSchema.extend({ groupId: BrowserObjectIdSchema }).strict(),
  ...BrowserEffectExpectationSchema.options.slice(2),
]);

export const BrowserEffectSchema = z
  .object({
    effectId: z.string().uuid(),
    logicalTabId: LogicalTabIdSchema,
    serverSeq: SafeNonnegativeIntegerSchema,
    expectation: BrowserEffectExpectationSchema,
    startedAtMs: SafeNonnegativeIntegerSchema,
    expiresAtMs: SafePositiveIntegerSchema,
  })
  .strict()
  .superRefine((effect, context) => {
    if (effect.expiresAtMs <= effect.startedAtMs) {
      context.addIssue({
        code: "custom",
        path: ["expiresAtMs"],
        message: "browser effect must expire after it starts",
      });
    }
  });

export type BrowserEffect = z.infer<typeof BrowserEffectSchema>;
export type BrowserObservedEvent = z.infer<typeof BrowserObservedEventSchema>;

export interface ConsumedBrowserEffect {
  effectId: string;
  logicalTabId: BrowserEffect["logicalTabId"];
  serverSeq: number;
}

export class EffectLedger {
  readonly #entries = new Map<string, BrowserEffect>();

  public get size(): number {
    return this.#entries.size;
  }

  public begin(effectInput: unknown): BrowserEffect {
    const effect = BrowserEffectSchema.parse(effectInput);
    if (this.#entries.has(effect.effectId)) {
      throw new Error("DUPLICATE_BROWSER_EFFECT");
    }
    if (this.#entries.size >= 1_000) {
      throw new Error("BROWSER_EFFECT_LIMIT");
    }
    this.#entries.set(effect.effectId, effect);
    return effect;
  }

  public attachCreatedTab(effectIdInput: unknown, tabIdInput: unknown): BrowserEffect {
    const effectId = z.string().uuid().parse(effectIdInput);
    const tabId = BrowserObjectIdSchema.parse(tabIdInput);
    const effect = this.#entries.get(effectId);
    if (
      effect === undefined ||
      effect.expectation.type !== "TAB_CREATED" ||
      effect.expectation.tabId !== null
    ) {
      throw new Error("INVALID_BROWSER_EFFECT");
    }
    const attached = BrowserEffectSchema.parse({
      ...effect,
      expectation: {
        ...effect.expectation,
        tabId,
      },
    });
    this.#entries.set(effectId, attached);
    return attached;
  }

  public attachGroup(effectIdInput: unknown, groupIdInput: unknown): BrowserEffect {
    const effectId = z.string().uuid().parse(effectIdInput);
    const groupId = BrowserObjectIdSchema.parse(groupIdInput);
    const effect = this.#entries.get(effectId);
    if (
      effect === undefined ||
      effect.expectation.type !== "TAB_GROUPED" ||
      effect.expectation.groupId !== null
    ) {
      throw new Error("INVALID_BROWSER_EFFECT");
    }
    const attached = BrowserEffectSchema.parse({
      ...effect,
      expectation: {
        ...effect.expectation,
        groupId,
      },
    });
    this.#entries.set(effectId, attached);
    return attached;
  }

  public consume(eventInput: unknown, nowMsInput: unknown): ConsumedBrowserEffect | undefined {
    const event = BrowserObservedEventSchema.parse(eventInput);
    const nowMs = SafeNonnegativeIntegerSchema.parse(nowMsInput);
    this.#purgeExpired(nowMs);
    for (const [effectId, effect] of this.#entries) {
      if (matches(effect.expectation, event)) {
        this.#entries.delete(effectId);
        return {
          effectId,
          logicalTabId: effect.logicalTabId,
          serverSeq: effect.serverSeq,
        };
      }
    }
    return undefined;
  }

  #purgeExpired(nowMs: number): void {
    for (const [effectId, effect] of this.#entries) {
      if (effect.expiresAtMs < nowMs) {
        this.#entries.delete(effectId);
      }
    }
  }
}

function matches(expectation: BrowserEffect["expectation"], event: BrowserObservedEvent): boolean {
  if (expectation.type !== event.type) {
    return false;
  }
  switch (expectation.type) {
    case "TAB_CREATED":
      return (
        event.type === "TAB_CREATED" &&
        expectation.tabId !== null &&
        expectation.tabId === event.tabId &&
        expectation.url === event.url
      );
    case "TAB_GROUPED":
      return (
        event.type === "TAB_GROUPED" &&
        expectation.groupId !== null &&
        expectation.tabId === event.tabId &&
        expectation.groupId === event.groupId
      );
    case "TAB_NAVIGATED":
      return (
        event.type === "TAB_NAVIGATED" &&
        expectation.tabId === event.tabId &&
        expectation.url === event.url
      );
    case "TAB_MOVED":
      return (
        event.type === "TAB_MOVED" &&
        expectation.tabId === event.tabId &&
        expectation.windowId === event.windowId &&
        expectation.index === event.index
      );
    case "TAB_CLOSED":
      return event.type === "TAB_CLOSED" && expectation.tabId === event.tabId;
    case "TAB_METADATA":
      return (
        event.type === "TAB_METADATA" &&
        expectation.tabId === event.tabId &&
        expectation.title === event.title
      );
  }
}
