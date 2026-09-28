import { LogicalTabIdSchema } from "@syncaction/protocol";
import { z } from "zod";

const DestructiveEffectSchema = z
  .object({
    kind: z.enum(["CREATE", "CLOSE"]),
    logicalTabId: LogicalTabIdSchema,
    atMs: z.number().int().nonnegative().safe(),
    confirmedRecovery: z.boolean().optional().default(false),
  })
  .strict();

export type BrowserBreakerResult =
  | { kind: "ALLOW" }
  | {
      kind: "TRIPPED";
      reason: "LOGICAL_TAB_OSCILLATION" | "DESTRUCTIVE_BURST";
    };

type DestructiveEffect = z.infer<typeof DestructiveEffectSchema>;

export class BrowserCircuitBreaker {
  #history: DestructiveEffect[] = [];
  #tripped: "LOGICAL_TAB_OSCILLATION" | "DESTRUCTIVE_BURST" | undefined;

  public record(effectInput: unknown): BrowserBreakerResult {
    if (this.#tripped !== undefined) {
      return { kind: "TRIPPED", reason: this.#tripped };
    }
    const effect = DestructiveEffectSchema.parse(effectInput);
    this.#history = this.#history.filter((candidate) => candidate.atMs >= effect.atMs - 10_000);
    this.#history.push(effect);
    const sameLogicalTab = this.#history.filter(
      (candidate) => candidate.logicalTabId === effect.logicalTabId,
    );
    const recentThree = sameLogicalTab.slice(-3);
    if (
      recentThree.length === 3 &&
      recentThree[0]!.kind === recentThree[2]!.kind &&
      recentThree[0]!.kind !== recentThree[1]!.kind
    ) {
      this.#tripped = "LOGICAL_TAB_OSCILLATION";
      return { kind: "TRIPPED", reason: this.#tripped };
    }
    const automaticBurst = this.#history.filter(
      (candidate) => !candidate.confirmedRecovery && candidate.atMs >= effect.atMs - 5_000,
    );
    if (automaticBurst.length > 8) {
      this.#tripped = "DESTRUCTIVE_BURST";
      return { kind: "TRIPPED", reason: this.#tripped };
    }
    return { kind: "ALLOW" };
  }
}

const RestoreDecisionInputSchema = z
  .object({
    missingTabCount: z.number().int().nonnegative().safe(),
    confirmed: z.boolean(),
  })
  .strict();

export type RestoreDecision =
  | { kind: "CONFIRMATION_REQUIRED"; missingTabCount: number }
  | { kind: "READY"; minCreateIntervalMs: number };

export function decideRestore(input: unknown): RestoreDecision {
  const parsed = RestoreDecisionInputSchema.parse(input);
  if (parsed.missingTabCount > 5 && !parsed.confirmed) {
    return {
      kind: "CONFIRMATION_REQUIRED",
      missingTabCount: parsed.missingTabCount,
    };
  }
  return {
    kind: "READY",
    minCreateIntervalMs: parsed.missingTabCount > 5 && parsed.confirmed ? 500 : 0,
  };
}
