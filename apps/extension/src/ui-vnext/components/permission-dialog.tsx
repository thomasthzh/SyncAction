import { useLayoutEffect, useRef, useState } from "preact/hooks";
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
  readonly continuation?: "CREATE_MEDIA_GROUP" | "JOIN_MEDIA_GROUP";
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
  continuation,
  ready = true,
  externalErrorCode = null,
  onConfirm,
  onClose,
}: PermissionDialogProps): JSX.Element {
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [permissionSaved, setPermissionSaved] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const nextAction =
    feature === "MEDIA_CONTROL"
      ? continuation === "JOIN_MEDIA_GROUP"
        ? "加入原播放组，跟随领播者播放"
        : "从当前视频创建播放组"
      : feature === "DANMAKU"
        ? "打开当前页面的弹幕输入框"
        : feature === "DRAWING"
          ? "启用当前页面的画笔"
          : "启用当前页面的同页光标";

  function confirm(): void {
    if (!agreed || inFlight.current || !ready) {
      return;
    }
    inFlight.current = true;
    let outcome: PermissionConfirmation | Promise<PermissionConfirmation>;
    try {
      outcome = onConfirm(agreed);
    } catch {
      inFlight.current = false;
      setErrorCode("PAGE_PERMISSION_REQUEST_FAILED");
      return;
    }
    setPending(true);
    setErrorCode(null);
    void Promise.resolve(outcome).then(
      (result) => {
        if (!mounted.current) return;
        inFlight.current = false;
        setPending(false);
        setPermissionSaved(result.granted);
        if (result.granted && result.errorCode === null) {
          onClose();
        } else {
          setErrorCode(result.errorCode ?? "PAGE_PERMISSION_DENIED");
        }
      },
      () => {
        if (!mounted.current) return;
        inFlight.current = false;
        setPending(false);
        setErrorCode("PAGE_PERMISSION_REQUEST_FAILED");
      },
    );
  }

  const titleId = "syncaction-permission-title";
  const effectiveErrorCode = externalErrorCode ?? errorCode;
  const stale =
    effectiveErrorCode === "PAGE_PERMISSION_INTENT_STALE" ||
    effectiveErrorCode === "PAGE_CHANGED_DURING_PERMISSION";
  return (
    <ModalDialog titleId={titleId} pending={pending} onClose={onClose}>
      <header class="dialog-header">
        <div>
          <p class="eyebrow">按网站授权</p>
          <h2 id={titleId}>允许页面协作</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="关闭"
          title="关闭"
          disabled={pending}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div class="permission-task">
        <strong>允许后继续：{nextAction}</strong>
        <p>只继续本次操作。服务器、房间或页面变化后，需要从当前页面重新发起。</p>
      </div>
      <div class="permission-scope">
        <span>当前网站</span>
        <strong>{origin}</strong>
        <p>授权覆盖此网站的页面，并按当前服务器与条款版本隔离；其他网站需另行允许。</p>
      </div>
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
      <details class="permission-technical-details">
        <summary>权限与条款详情</summary>
        <dl class="permission-summary">
          <div>
            <dt>本次功能</dt>
            <dd>{FEATURE_LABELS[feature]}</dd>
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
      </details>
      <label class="agreement-row">
        <input
          name="agreement"
          type="checkbox"
          disabled={pending || !ready}
          checked={agreed}
          onChange={(event) => setAgreed(event.currentTarget.checked)}
        />
        <span>我已阅读并同意页面协作说明与当前服务条款</span>
      </label>
      <ActionableStatus errorCode={effectiveErrorCode} />
      <footer class="dialog-actions">
        <button class="secondary-button" type="button" disabled={pending} onClick={onClose}>
          取消
        </button>
        <button
          class="primary-button"
          type="button"
          disabled={!agreed || pending || !ready || stale}
          onClick={confirm}
        >
          {pending
            ? "正在启用…"
            : !ready
              ? "正在检查…"
              : stale
                ? "请重新发起授权"
                : permissionSaved
                  ? "重试启用"
                  : "允许当前站点"}
        </button>
      </footer>
    </ModalDialog>
  );
}
