import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { VerifiedServerCandidate } from "../../server-profile.js";
import { DEFAULT_SERVER_PROFILE_ID } from "../../server-profile.js";
import { parsePublicServerOrigin } from "../../server-origin.js";
import type { UiStore } from "../store.js";
import { Icon } from "../icons.js";
import { ActionableStatus } from "./actionable-status.js";
import { ModalDialog } from "./modal-dialog.js";

export interface ServerVerifier {
  verifyFromClick(baseUrl: unknown): Promise<VerifiedServerCandidate>;
}

export interface ServerProfileDialogProps {
  readonly store: UiStore;
  readonly verifier?: ServerVerifier;
  readonly onClose: () => void;
  readonly onSelected: () => void;
  readonly onOpenAuthorizedSites: () => void;
}

function profileLabel(profile: UiStore["shell"]["value"]["profiles"][number]): string {
  if (profile.metadata !== null) {
    return profile.metadata.displayName;
  }
  try {
    return new URL(profile.baseUrl).host;
  } catch {
    return profile.baseUrl;
  }
}

function errorCodeOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "SERVER_VERIFICATION_FAILED";
}

export function ServerProfileDialog({
  store,
  verifier,
  onClose,
  onSelected,
  onOpenAuthorizedSites,
}: ServerProfileDialogProps): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [candidate, setCandidate] = useState<VerifiedServerCandidate | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectingProfileId, setSelectingProfileId] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const shell = store.shell.value;
  const existingProfile =
    candidate === null
      ? null
      : (shell.profiles.find((profile) => profile.baseUrl === candidate.baseUrl) ?? null);
  const identityChanged =
    candidate?.mode === "VNEXT" &&
    candidate.metadata !== null &&
    existingProfile?.mode === "VNEXT" &&
    existingProfile.metadata !== null &&
    existingProfile.metadata.serverId !== candidate.metadata.serverId;

  async function verify(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setCandidate(null);
    setErrorCode(null);
    let normalized: string;
    try {
      normalized = parsePublicServerOrigin(baseUrl);
    } catch {
      setErrorCode("INVALID_SERVER_URL");
      return;
    }
    if (verifier === undefined) {
      setErrorCode("SERVER_VERIFIER_UNAVAILABLE");
      return;
    }
    let verification: Promise<VerifiedServerCandidate>;
    try {
      verification = verifier.verifyFromClick(normalized);
    } catch (error) {
      setErrorCode(errorCodeOf(error));
      return;
    }
    setVerifying(true);
    try {
      setCandidate(await verification);
    } catch (error) {
      setErrorCode(errorCodeOf(error));
    } finally {
      setVerifying(false);
    }
  }

  async function save(): Promise<void> {
    if (candidate === null || identityChanged) {
      return;
    }
    setSaving(true);
    setErrorCode(null);
    const result = await store.command({
      name: "SERVER_ADD",
      payload: { baseUrl: candidate.baseUrl },
    });
    if (!result.ok) {
      setErrorCode(result.errorCode);
    } else {
      setAdding(false);
      setCandidate(null);
      setBaseUrl("");
    }
    setSaving(false);
  }

  async function select(profileId: string): Promise<void> {
    setSelectingProfileId(profileId);
    setErrorCode(null);
    const result = await store.command({
      name: "SERVER_SELECT",
      payload: { profileId },
    });
    if (result.ok) {
      onSelected();
    } else {
      setErrorCode(result.errorCode);
    }
    setSelectingProfileId(null);
  }

  const titleId = "syncaction-server-profile-title";
  return (
    <ModalDialog
      titleId={titleId}
      pending={verifying || saving || selectingProfileId !== null}
      onClose={onClose}
    >
      <header class="dialog-header">
        <div>
          <p class="eyebrow">账号和房间按服务器隔离</p>
          <h2 id={titleId}>服务器</h2>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {!adding ? (
        <>
          <div class="server-profile-list">
            {shell.profiles.map((profile) => {
              const selected = profile.profileId === shell.selectedProfileId;
              const label = profileLabel(profile);
              return (
                <article
                  class={selected ? "server-profile-row is-selected" : "server-profile-row"}
                  key={profile.profileId}
                >
                  <div>
                    <strong>{label}</strong>
                    <span>{new URL(profile.baseUrl).host}</span>
                    <small>
                      {profile.profileId === DEFAULT_SERVER_PROFILE_ID ? "默认服务器 · " : ""}
                      {profile.mode === "VNEXT"
                        ? "已验证"
                        : profile.mode === "LEGACY_V081"
                          ? "旧版基础协作"
                          : "待验证"}
                    </small>
                  </div>
                  {selected ? (
                    <span class="selected-label">当前</span>
                  ) : (
                    <button
                      class="compact-button"
                      type="button"
                      aria-label={`选择 ${label}`}
                      disabled={selectingProfileId !== null}
                      onClick={() => void select(profile.profileId)}
                    >
                      {selectingProfileId === profile.profileId ? "切换中…" : "选择"}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
          <div class="dialog-actions">
            <button class="secondary-button" type="button" onClick={onOpenAuthorizedSites}>
              已授权站点
            </button>
            <button class="primary-button" type="button" onClick={() => setAdding(true)}>
              添加服务器
            </button>
          </div>
        </>
      ) : (
        <div class="server-add-flow">
          <form class="dialog-form" onSubmit={(event) => void verify(event)}>
            <label>
              服务器地址
              <input
                name="serverUrl"
                type="url"
                placeholder="https://team.example"
                required
                value={baseUrl}
                onInput={(event) => {
                  setBaseUrl(event.currentTarget.value);
                  setCandidate(null);
                  setErrorCode(null);
                }}
              />
            </label>
            <p class="subtle-copy">
              仅支持 HTTPS；本机调试可使用 http://localhost 或 http://127.0.0.1。
            </p>
            <div class="dialog-actions">
              <button
                class="secondary-button"
                type="button"
                onClick={() => {
                  setAdding(false);
                  setCandidate(null);
                  setErrorCode(null);
                }}
              >
                返回
              </button>
              <button class="primary-button" type="submit" disabled={verifying}>
                {verifying ? "正在验证…" : "验证服务器"}
              </button>
            </div>
          </form>

          {candidate !== null ? (
            <section class="server-preview" aria-label="服务器验证结果">
              {candidate.mode === "LEGACY_V081" ? (
                <p class="legacy-warning">旧版服务器，仅基础协作</p>
              ) : (
                <>
                  <header>
                    <strong>{candidate.metadata!.displayName}</strong>
                    <span>健康检查通过</span>
                  </header>
                  <dl>
                    <div>
                      <dt>服务器 ID</dt>
                      <dd>{candidate.metadata!.serverId}</dd>
                    </div>
                    <div>
                      <dt>协议</dt>
                      <dd>协议 {candidate.metadata!.protocolVersion}</dd>
                    </div>
                    <div>
                      <dt>最低客户端</dt>
                      <dd>最低客户端 {candidate.metadata!.minimumClientVersion}</dd>
                    </div>
                    <div>
                      <dt>能力</dt>
                      <dd>{candidate.metadata!.capabilities.join(" · ") || "基础协作"}</dd>
                    </div>
                  </dl>
                </>
              )}
              {identityChanged ? (
                <p class="identity-warning">服务器身份已变化，已阻止连接</p>
              ) : existingProfile !== null ? (
                <p class="subtle-copy">此服务器已在列表中，无需重复保存。</p>
              ) : (
                <button
                  class="primary-button"
                  type="button"
                  aria-label="保存服务器"
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? "正在保存…" : "保存服务器"}
                </button>
              )}
            </section>
          ) : null}
        </div>
      )}
      <ActionableStatus errorCode={errorCode ?? shell.errorCode} />
    </ModalDialog>
  );
}
