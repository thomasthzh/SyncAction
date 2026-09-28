import { describe, expect, it } from "vitest";
import { BrowserCircuitBreaker, decideRestore } from "../src/circuit-breaker.js";

const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";

describe("browser actuation circuit breakers", () => {
  it("trips on a repeated create/close cycle for one logical tab within ten seconds", () => {
    const breaker = new BrowserCircuitBreaker();

    expect(breaker.record({ kind: "CREATE", logicalTabId: firstId, atMs: 1_000 })).toEqual({
      kind: "ALLOW",
    });
    expect(breaker.record({ kind: "CLOSE", logicalTabId: firstId, atMs: 2_000 })).toEqual({
      kind: "ALLOW",
    });
    expect(breaker.record({ kind: "CREATE", logicalTabId: firstId, atMs: 3_000 })).toEqual({
      kind: "TRIPPED",
      reason: "LOGICAL_TAB_OSCILLATION",
    });
    expect(breaker.record({ kind: "CLOSE", logicalTabId: firstId, atMs: 20_000 })).toEqual({
      kind: "TRIPPED",
      reason: "LOGICAL_TAB_OSCILLATION",
    });
  });

  it("trips on the ninth automatic destructive effect in five seconds", () => {
    const breaker = new BrowserCircuitBreaker();

    for (let index = 0; index < 8; index += 1) {
      expect(
        breaker.record({
          kind: "CREATE",
          logicalTabId: `018f8f8e-4b5c-7d6e-8f90-${String(index).padStart(12, "0")}`,
          atMs: 1_000 + index,
        }),
      ).toEqual({ kind: "ALLOW" });
    }
    expect(
      breaker.record({
        kind: "CREATE",
        logicalTabId: "018f8f8e-4b5c-7d6e-8f90-999999999999",
        atMs: 1_100,
      }),
    ).toEqual({
      kind: "TRIPPED",
      reason: "DESTRUCTIVE_BURST",
    });
  });

  it("allows a confirmed recovery batch but still protects against oscillation", () => {
    const breaker = new BrowserCircuitBreaker();

    expect(
      breaker.record({
        kind: "CREATE",
        logicalTabId: firstId,
        atMs: 900,
        confirmedRecovery: true,
      }),
    ).toEqual({ kind: "ALLOW" });
    for (let index = 0; index < 12; index += 1) {
      expect(
        breaker.record({
          kind: "CREATE",
          logicalTabId: `018f8f8e-4b5c-7d6e-8f90-${String(index).padStart(12, "1")}`,
          atMs: 1_000 + index,
          confirmedRecovery: true,
        }),
      ).toEqual({ kind: "ALLOW" });
    }
    expect(
      breaker.record({
        kind: "CLOSE",
        logicalTabId: firstId,
        atMs: 2_000,
        confirmedRecovery: true,
      }),
    ).toEqual({ kind: "ALLOW" });
    expect(
      breaker.record({
        kind: "CREATE",
        logicalTabId: firstId,
        atMs: 3_000,
        confirmedRecovery: true,
      }),
    ).toEqual({
      kind: "TRIPPED",
      reason: "LOGICAL_TAB_OSCILLATION",
    });
  });

  it("requires confirmation above five missing tabs and paces confirmed restore", () => {
    expect(decideRestore({ missingTabCount: 5, confirmed: false })).toEqual({
      kind: "READY",
      minCreateIntervalMs: 0,
    });
    expect(decideRestore({ missingTabCount: 6, confirmed: false })).toEqual({
      kind: "CONFIRMATION_REQUIRED",
      missingTabCount: 6,
    });
    expect(decideRestore({ missingTabCount: 6, confirmed: true })).toEqual({
      kind: "READY",
      minCreateIntervalMs: 500,
    });
  });
});
