import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { OriginConsentRecord } from "../../origin-consent.js";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";
import { ModalDialog } from "./modal-dialog.js";

export interface AuthorizedSiteView {
  readonly record: OriginConsentRecord;
  readonly browserPermissionGranted: boolean;
}

export interface AuthorizedSitesDialogProps {
  readonly store: UiStore;
  readonly profileId: string;
  readonly load: (profileId: string) => Promise<readonly AuthorizedSiteView[]>;
  readonly onClose: () => void;
}

export function AuthorizedSitesDialog({
  store,
  profileId,
  load,
  onClose,
}: AuthorizedSitesDialogProps): JSX.Element {
  const [sites, setSites] = useState<readonly AuthorizedSiteView[] | null>(null);
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setSites(null);
    setErrorCode(null);
    void load(profileId).then(
      (next) => {
        if (current) {
          setSites(structuredClone(next));
        }
      },
      () => {
        if (current) {
          setSites([]);
          setErrorCode("AUTHORIZED_SITES_LOAD_FAILED");
        }
      },
    );
    return () => {
      current = false;
    };
  }, [load, profileId]);

  async function remove(origin: string): Promise<void> {
    setPendingOrigin(origin);
    setErrorCode(null);
    const result = await store.command({
      name: "PAGE_PERMISSION_REMOVE",
      payload: { origin },
    });
    if (!result.ok) {
      setErrorCode(result.errorCode);
      setPendingOrigin(null);
      return;
    }
    try {
      setSites(structuredClone(await load(profileId)));
    } catch {
      setErrorCode("AUTHORIZED_SITES_LOAD_FAILED");
    }
    setPendingOrigin(null);
  }

  const titleId = "syncaction-authorized-sites-title";
  return (
    <ModalDialog titleId={titleId} pending={pendingOrigin !== null} onClose={onClose}>
      <header class="dialog-header">
        <div>
          <p class="eyebrow">按服务器配置隔离</p>
          <h2 id={titleId}>已授权站点</h2>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <p class="subtle-copy">
        撤销只会关闭该精确站点的浏览器权限；历史同意记录仍保留，不会删除房间、标签页或消息。
      </p>
      <ActionableStatus errorCode={errorCode} />
      {sites === null ? (
        <div class="empty-state">
          <strong>正在读取站点…</strong>
        </div>
      ) : sites.length === 0 ? (
        <div class="empty-state">
          <strong>暂无已同意站点</strong>
          <span>在共享页面启用光标、弹幕、画笔或媒体控制后会显示在这里。</span>
        </div>
      ) : (
        <div class="authorized-site-list">
          {sites.map(({ record, browserPermissionGranted }) => (
            <article
              class={
                browserPermissionGranted
                  ? "authorized-site-row is-granted"
                  : "authorized-site-row is-revoked"
              }
              key={`${record.origin}:${record.serverTermsVersion}:${record.disclosureVersion}`}
            >
              <div>
                <strong>{record.origin}</strong>
                <span>
                  {browserPermissionGranted ? "已授权" : "已撤销"} · 条款{" "}
                  {record.serverTermsVersion}
                </span>
                <small>
                  披露版本 {record.disclosureVersion}
                  {record.policySyncPending ? " · 策略记录待同步" : ""}
                </small>
              </div>
              {browserPermissionGranted ? (
                <button
                  class="text-button"
                  type="button"
                  aria-label={`撤销 ${record.origin}`}
                  disabled={pendingOrigin !== null}
                  onClick={() => void remove(record.origin)}
                >
                  {pendingOrigin === record.origin ? "正在撤销…" : "撤销"}
                </button>
              ) : (
                <span class="selected-label">未启用</span>
              )}
            </article>
          ))}
        </div>
      )}
    </ModalDialog>
  );
}
