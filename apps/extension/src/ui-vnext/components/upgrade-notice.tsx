import { useState } from "preact/hooks";
import type { UiStore } from "../store.js";
import { ActionableStatus } from "./actionable-status.js";

export interface UpgradeNoticeProps {
  readonly store: UiStore;
}

export function UpgradeNotice({ store }: UpgradeNoticeProps): preact.JSX.Element {
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  async function dismiss(): Promise<void> {
    setPending(true);
    setErrorCode(null);
    const result = await store.command({ name: "ONBOARDING_DISMISS" });
    if (!result.ok) {
      setErrorCode(result.errorCode);
    }
    setPending(false);
  }

  return (
    <aside class="upgrade-notice" aria-label="新版提示">
      <div>
        <strong>房间现在集中在一个页面</strong>
        <span>按网站授权光标、弹幕与画笔</span>
      </div>
      <button class="text-button" type="button" disabled={pending} onClick={() => void dismiss()}>
        {pending ? "正在保存…" : "知道了"}
      </button>
      <ActionableStatus errorCode={errorCode} />
    </aside>
  );
}
