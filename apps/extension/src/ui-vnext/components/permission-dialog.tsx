import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { PermissionConfirmation } from "../../origin-permission-coordinator.js";
import type { PageFeature } from "../../ui/ui-protocol.js";
import { Icon } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";
import { ModalDialog } from "./modal-dialog.js";

export interface PermissionDialogProps {
  readonly feature: PageFeature;
  readonly origin: string;
  readonly browserPermission: string;
  readonly termsVersion: string;
  readonly privacyPageUrl: string;
  readonly ready?: boolean;
  readonly externalErrorCode?: string | null;
  readonly onConfirm: (agreed: boolean) => PermissionConfirmation | Promise<PermissionConfirmation>;
  readonly onClose: () => void;
}

const FEATURE_LABELS: Record<PageFeature, string> = {
  POINTER: "同页光标",
  DANMAKU: "页面弹幕",
  DRAWING: "页面画笔",
  MEDIA_CONTROL: "媒体同步控制",
};

export function PermissionDialog({
  feature,
  origin,
  browserPermission,
  termsVersion,
  privacyPageUrl,
  ready = true,
  externalErrorCode = null,
  onConfirm,
  onClose,
}: PermissionDialogProps): JSX.Element {
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  function confirm(): void {
    if (!agreed || pending || !ready) {
      return;
    }
    let outcome: PermissionConfirmation | Promise<PermissionConfirmation>;
    try {
      outcome = onConfirm(agreed);
    } catch {
      setErrorCode("PAGE_PERMISSION_REQUEST_FAILED");
      return;
    }
    setPending(true);
    setErrorCode(null);
    void Promise.resolve(outcome).then(
      (result) => {
        setPending(false);
        if (result.granted) {
          onClose();
        } else {
          setErrorCode(result.errorCode ?? "PAGE_PERMISSION_DENIED");
        }
      },
      () => {
        setPending(false);
        setErrorCode("PAGE_PERMISSION_REQUEST_FAILED");
      },
    );
  }

  const titleId = "syncaction-permission-title";
  return (
    <ModalDialog titleId={titleId} pending={pending} onClose={onClose}>
      <header class="dialog-header">
        <div>
          <p class="eyebrow">按网站授权</p>
          <h2 id={titleId}>允许页面协作</h2>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <dl class="permission-summary">
        <div>
          <dt>功能</dt>
          <dd>{FEATURE_LABELS[feature]}</dd>
        </div>
        <div>
          <dt>网站</dt>
          <dd>{origin}</dd>
        </div>
        <div>
          <dt>浏览器权限</dt>
          <dd>{browserPermission}</dd>
        </div>
        <div>
          <dt>协议版本</dt>
          <dd>{termsVersion}</dd>
        </div>
      </dl>
      <section class="permission-disclosure" aria-label="页面协作数据说明">
        <h3>启用后可能发送</h3>
        <ul>
          <li>逻辑标签页标识与页面兼容性摘要</li>
          <li>量化后的光标与画笔坐标</li>
          <li>已识别媒体的播放状态</li>
          <li>你主动发送的弹幕与画笔内容</li>
        </ul>
        <h3>明确不会发送</h3>
        <ul>
          <li>不会发送 Cookie、密码或表单输入</li>
          <li>不会发送页面文字、DOM、截图或视频流</li>
          <li>不会发送浏览历史或无关标签页</li>
        </ul>
        <p class="subtle-copy">
          授权仅适用于上方精确网站，并按当前服务器配置和条款版本隔离。
          <a href={privacyPageUrl} target="_blank" rel="noreferrer">
            查看本地隐私说明
          </a>
        </p>
      </section>
      <label class="agreement-row">
        <input
          name="agreement"
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.currentTarget.checked)}
        />
        <span>我已阅读并同意页面协作说明与当前服务条款</span>
      </label>
      <ActionableStatus errorCode={externalErrorCode ?? errorCode} />
      <footer class="dialog-actions">
        <button class="secondary-button" type="button" onClick={onClose}>
          取消
        </button>
        <button
          class="primary-button"
          type="button"
          disabled={!agreed || pending || !ready}
          onClick={confirm}
        >
          {pending ? "正在请求…" : !ready ? "正在检查…" : "允许当前站点"}
        </button>
      </footer>
    </ModalDialog>
  );
}
