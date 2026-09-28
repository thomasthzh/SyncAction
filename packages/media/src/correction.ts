export type CorrectionPlan =
  | { readonly kind: "NONE" }
  | { readonly kind: "SEEK" }
  | {
      readonly kind: "RATE";
      readonly playbackRate: number;
      readonly restoreRate: number;
      readonly durationMs: 3_000;
    };

export interface CorrectionInput {
  readonly driftMs: number;
  readonly leaderRate: number;
}

export function planCorrection(input: CorrectionInput): CorrectionPlan {
  if (
    !Number.isFinite(input.driftMs) ||
    !Number.isFinite(input.leaderRate) ||
    input.leaderRate < 0.25 ||
    input.leaderRate > 4
  ) {
    throw new Error("INVALID_CORRECTION_INPUT");
  }

  const absoluteDriftMs = Math.abs(input.driftMs);
  if (absoluteDriftMs < 300) {
    return { kind: "NONE" };
  }
  if (absoluteDriftMs > 1_500) {
    return { kind: "SEEK" };
  }

  const multiplier = input.driftMs > 0 ? 1.05 : 0.95;
  const playbackRate = Math.min(4, Math.max(0.25, input.leaderRate * multiplier));
  return {
    kind: "RATE",
    playbackRate,
    restoreRate: input.leaderRate,
    durationMs: 3_000,
  };
}
