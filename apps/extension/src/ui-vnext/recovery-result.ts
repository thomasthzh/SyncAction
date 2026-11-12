import type { UiCommandResult } from "../ui/ui-protocol.js";

/** An accepted extension command may still leave browser recovery blocked. */
export function recoveryResult(result: UiCommandResult): UiCommandResult {
  if (!result.ok) return result;
  const value = result.value;
  let errorCode = "BROWSER_RECOVERY_RESULT_UNKNOWN";
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "effectsApplied" in value &&
    Number.isSafeInteger(value.effectsApplied) &&
    Number(value.effectsApplied) >= 0
  ) {
    if (value.kind === "SYNCHRONIZED") return result;
    if (
      value.kind === "CONFIRMATION_REQUIRED" &&
      "missingTabCount" in value &&
      Number.isSafeInteger(value.missingTabCount) &&
      Number(value.missingTabCount) >= 0
    )
      errorCode = "BROWSER_RECOVERY_CONFIRMATION_REQUIRED";
    if (value.kind === "BLOCKED" && "reason" in value) {
      errorCode =
        value.reason === "BROWSER_API_FAILURE"
          ? "BROWSER_RECOVERY_API_FAILURE"
          : value.reason === "CIRCUIT_BREAKER"
            ? "BROWSER_RECOVERY_CIRCUIT_BREAKER"
            : "BROWSER_RECOVERY_BLOCKED";
    }
  }
  return { type: result.type, commandId: result.commandId, ok: false, errorCode };
}
