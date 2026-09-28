import { describe, expect, it } from "vitest";
import { planCorrection } from "../src/index.js";

describe("stable playback correction", () => {
  it("does nothing below 300 ms absolute drift", () => {
    expect(planCorrection({ driftMs: 299, leaderRate: 1 })).toEqual({ kind: "NONE" });
    expect(planCorrection({ driftMs: -299, leaderRate: 1 })).toEqual({ kind: "NONE" });
  });

  it("uses a bounded three-second rate adjustment through 1500 ms", () => {
    expect(planCorrection({ driftMs: 800, leaderRate: 1 })).toEqual({
      kind: "RATE",
      playbackRate: 1.05,
      restoreRate: 1,
      durationMs: 3_000,
    });
    expect(planCorrection({ driftMs: -800, leaderRate: 1 })).toEqual({
      kind: "RATE",
      playbackRate: 0.95,
      restoreRate: 1,
      durationMs: 3_000,
    });
    expect(planCorrection({ driftMs: 300, leaderRate: 2 })).toMatchObject({
      kind: "RATE",
      playbackRate: 2.1,
    });
    expect(planCorrection({ driftMs: 1_500, leaderRate: 0.5 })).toMatchObject({
      kind: "RATE",
      playbackRate: 0.525,
    });
  });

  it("seeks above 1500 ms and clamps legal correction rates", () => {
    expect(planCorrection({ driftMs: 1_501, leaderRate: 1 })).toEqual({ kind: "SEEK" });
    expect(planCorrection({ driftMs: -1_501, leaderRate: 1 })).toEqual({ kind: "SEEK" });
    expect(planCorrection({ driftMs: 500, leaderRate: 4 })).toMatchObject({
      kind: "RATE",
      playbackRate: 4,
      restoreRate: 4,
    });
    expect(planCorrection({ driftMs: -500, leaderRate: 0.25 })).toMatchObject({
      kind: "RATE",
      playbackRate: 0.25,
      restoreRate: 0.25,
    });
  });

  it("rejects non-finite drift and out-of-range leader rates", () => {
    expect(() => planCorrection({ driftMs: Number.NaN, leaderRate: 1 })).toThrow();
    expect(() => planCorrection({ driftMs: 500, leaderRate: 0.24 })).toThrow();
    expect(() => planCorrection({ driftMs: Number.POSITIVE_INFINITY, leaderRate: 1 })).toThrow();
  });
});
