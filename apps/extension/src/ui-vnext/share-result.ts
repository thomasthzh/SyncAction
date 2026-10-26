import type { UiCommandResult } from "../ui/ui-protocol.js";

/** Transport success is not proof that a browser share intent was recorded. */
export function shareResult(result: UiCommandResult): {
  result: UiCommandResult;
  message: string | null;
} {
  if (!result.ok) return { result, message: null };
  let errorCode = "SHARE_RESULT_UNKNOWN";
  const value = result.value;
  if (typeof value === "object" && value !== null && "kind" in value) {
    const reason = "reason" in value ? value.reason : null;
    switch (value.kind) {
      case "INTENT_RECORDED":
        return {
          result,
          message:
            "operation" in value &&
            typeof value.operation === "object" &&
            value.operation !== null &&
            "type" in value.operation &&
            value.operation.type === "tab.navigate"
              ? "页面更新已提交"
              : "当前页面已提交分享",
        };
      case "IGNORED":
        if (reason === "NO_CHANGE") return { result, message: "当前页面已在共享列表中" };
        errorCode = reason === "LOADING" ? "SHARE_PAGE_LOADING" : "SHARE_NOT_SUBMITTED";
        break;
      case "BLOCKED":
        errorCode =
          reason === "PAGE_CONTEXT_CHANGED"
            ? "PAGE_TOOL_CONTEXT_CHANGED"
            : reason === "ROOM_TAB_LIMIT_REACHED" || reason === "PAGE_PUBLICATION_STALE"
              ? reason
              : "SHARE_NOT_READY";
        break;
      case "RECOVERY_REQUIRED":
        errorCode = "SHARE_RECOVERY_REQUIRED";
        break;
    }
  }
  return {
    result: { type: result.type, commandId: result.commandId, ok: false, errorCode },
    message: null,
  };
}
