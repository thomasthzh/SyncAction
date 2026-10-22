import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { DEFAULT_SERVER_PROFILE_ID, type ServerProfile } from "../../server-profile.js";
import type { UiTransportState } from "../store.js";
import { Icon } from "../icons.js";
import { GlassMaterial } from "./glass-material.js";
import type { UiCommandResult } from "../../ui/ui-protocol.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import { ActionableStatus, errorLabel } from "./actionable-status.js";

const PROBE_INTERVAL_MS = 30_000;

export interface ServiceStatusProbe {
  probe(baseUrl: string): Promise<{ readonly latencyMs: number }>;
}

export interface ServiceStatusCardProps {
  readonly profile: ServerProfile;
  readonly transport: UiTransportState;
  readonly probe?: ServiceStatusProbe;
  readonly connectionErrorCode?: string | null;
  readonly onReconnect?: () => Promise<UiCommandResult>;
  readonly onOpenServerProfiles?: () => void;
}

type ProbeState =
  | { readonly kind: "CHECKING"; readonly latencyMs: null }
  | { readonly kind: "ONLINE"; readonly latencyMs: number }
  | { readonly kind: "OFFLINE"; readonly latencyMs: null }
  | { readonly kind: "UNAVAILABLE"; readonly latencyMs: null };

function serverHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function useServiceProbe(
  baseUrl: string,
  probe: ServiceStatusProbe | undefined,
): {
  readonly state: ProbeState;
  readonly retry: () => void;
} {
  const [state, setState] = useState<ProbeState>(() =>
    probe === undefined
      ? { kind: "UNAVAILABLE", latencyMs: null }
      : { kind: "CHECKING", latencyMs: null },
  );
  const runRef = useRef<(showChecking: boolean) => void>(() => undefined);

  useEffect(() => {
    if (probe === undefined) {
      setState({ kind: "UNAVAILABLE", latencyMs: null });
      runRef.current = () => undefined;
      return undefined;
    }
    const activeProbe = probe;
    let disposed = false;
    let inFlight = false;

    async function run(showChecking: boolean): Promise<void> {
      if (disposed || inFlight) {
        return;
      }
      inFlight = true;
      if (showChecking) {
        setState({ kind: "CHECKING", latencyMs: null });
      }
      try {
        const sample = await activeProbe.probe(baseUrl);
        if (!disposed) {
          setState({ kind: "ONLINE", latencyMs: sample.latencyMs });
        }
      } catch {
        if (!disposed) {
          setState({ kind: "OFFLINE", latencyMs: null });
        }
      } finally {
        inFlight = false;
      }
    }

    runRef.current = (showChecking) => void run(showChecking);
    void run(true);

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void run(false);
      }
    }, PROBE_INTERVAL_MS);
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void run(false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [baseUrl, probe]);

  return {
    state,
    retry: () => runRef.current(true),
  };
}

export function ServiceStatusCard({
  profile,
  transport,
  probe,
  connectionErrorCode = null,
  onReconnect,
  onOpenServerProfiles,
}: ServiceStatusCardProps): JSX.Element {
  const health = useServiceProbe(profile.baseUrl, probe);
  const feedback = useCommandFeedback();
  const production = profile.profileId === DEFAULT_SERVER_PROFILE_ID;
  const nodeName = production ? "SyncAction" : (profile.metadata?.displayName ?? "自定义节点");
  const host = serverHost(profile.baseUrl);
  const version = profile.metadata?.softwareVersion;
  const protocolVersion = profile.metadata?.protocolVersion;
  const transportRecovering = transport !== "CONNECTED";
  const tone = transportRecovering
    ? "checking"
    : connectionErrorCode !== null
      ? "offline"
      : health.state.kind === "ONLINE"
        ? "online"
        : health.state.kind === "OFFLINE"
          ? "offline"
          : "checking";
  const title = transportRecovering
    ? "侧栏连接正在恢复"
    : connectionErrorCode !== null
      ? "服务器连接需要处理"
      : health.state.kind === "ONLINE"
        ? `${nodeName} 服务在线`
        : health.state.kind === "OFFLINE"
          ? "服务暂不可用"
          : health.state.kind === "CHECKING"
            ? "正在检测服务"
            : "服务状态待检测";
  const latency =
    health.state.kind === "ONLINE" ? `${String(health.state.latencyMs)} ms` : "延迟 —";
  const reason = transportRecovering
    ? "侧栏正在重新连接扩展，暂时显示上次读取的内容；连接恢复后会自动更新。"
    : connectionErrorCode !== null
      ? errorLabel(connectionErrorCode)
      : health.state.kind === "OFFLINE"
        ? "服务器健康检测未通过。请检查服务器地址和网络连接，仍失败时联系服务器管理员。"
        : null;

  return (
    <section
      class={`service-status-card service-status-card--compact service-status-card--${tone}`}
      aria-labelledby="service-status-title"
    >
      <GlassMaterial />
      <details class="service-status-card__details">
        <summary class="service-status-card__summary">
          <span class="service-status-card__icon" aria-hidden="true">
            <Icon name="server" size={18} />
            <span class={`service-status-card__dot service-status-card__dot--${tone}`} />
          </span>
          <div class="service-status-card__title">
            <strong id="service-status-title" aria-live="polite">
              {title}
            </strong>
            <small title={host}>{host}</small>
          </div>
          <Icon name="chevron" size={16} />
        </summary>

        <div class="service-status-card__metrics" aria-label="服务连接信息">
          <span class="service-status-card__version">
            {version === null || version === undefined ? "版本未提供" : `v${version}`}
          </span>
          <span>{protocolVersion === undefined ? "协议 —" : `协议 v${protocolVersion}`}</span>
          <span>{latency}</span>
          <span>{profile.mode === "VNEXT" ? "实时协作" : "兼容模式"}</span>
        </div>
        <p>{production ? `当前连接 SyncAction 服务器 ${host}` : `当前使用自定义服务器 ${host}`}</p>
        <p>此处检测服务器能否响应；进入房间后，可分别查看房间连接与视频跟随状态。</p>
      </details>

      {reason === null ? null : (
        <p class="service-status-card__reason" role="status">
          {reason}
        </p>
      )}
      {!transportRecovering && (connectionErrorCode !== null || health.state.kind === "OFFLINE") ? (
        <div class="service-status-card__actions">
          {connectionErrorCode !== null && onReconnect !== undefined ? (
            <button
              class="compact-button"
              type="button"
              disabled={feedback.pending !== null}
              onClick={() => void feedback.run("reconnect", onReconnect)}
            >
              {feedback.pending === null ? "重新连接服务器" : "正在连接…"}
            </button>
          ) : health.state.kind === "OFFLINE" && probe !== undefined ? (
            <button class="compact-button" type="button" onClick={health.retry}>
              重新检测服务
            </button>
          ) : null}
          {onOpenServerProfiles === undefined ? null : (
            <button
              class="text-button"
              type="button"
              disabled={feedback.pending !== null}
              onClick={onOpenServerProfiles}
            >
              检查服务器
            </button>
          )}
        </div>
      ) : null}
      <ActionableStatus errorCode={feedback.errorCode} />
    </section>
  );
}
