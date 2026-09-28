import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { DEFAULT_SERVER_PROFILE_ID, type ServerProfile } from "../../server-profile.js";
import type { UiTransportState } from "../store.js";
import { Icon } from "../icons.js";

const PROBE_INTERVAL_MS = 30_000;

export interface ServiceStatusProbe {
  probe(baseUrl: string): Promise<{ readonly latencyMs: number }>;
}

export interface ServiceStatusCardProps {
  readonly profile: ServerProfile;
  readonly transport: UiTransportState;
  readonly probe?: ServiceStatusProbe;
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
}: ServiceStatusCardProps): JSX.Element {
  const health = useServiceProbe(profile.baseUrl, probe);
  const isDefaultProfile = profile.profileId === DEFAULT_SERVER_PROFILE_ID;
  const nodeName = isDefaultProfile ? "默认节点" : (profile.metadata?.displayName ?? "自定义节点");
  const host = serverHost(profile.baseUrl);
  const version = profile.metadata?.softwareVersion;
  const protocolVersion = profile.metadata?.protocolVersion;
  const transportRecovering = transport !== "CONNECTED";
  const tone = transportRecovering
    ? "checking"
    : health.state.kind === "ONLINE"
      ? "online"
      : health.state.kind === "OFFLINE"
        ? "offline"
        : "checking";
  const title = transportRecovering
    ? "连接正在恢复"
    : health.state.kind === "ONLINE"
      ? `${nodeName} 服务在线`
      : health.state.kind === "OFFLINE"
        ? "服务暂不可用"
        : health.state.kind === "CHECKING"
          ? "正在检测服务"
          : "服务状态待检测";
  const latency =
    health.state.kind === "ONLINE" ? `${String(health.state.latencyMs)} ms` : "延迟 —";

  return (
    <section
      class={`service-status-card service-status-card--${tone}`}
      aria-labelledby="service-status-title"
    >
      <header class="service-status-card__header">
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
        <span class="service-status-card__version">
          {version === null || version === undefined ? "版本未提供" : `v${version}`}
        </span>
      </header>

      <div class="service-status-card__metrics" aria-label="服务连接信息">
        <span>{protocolVersion === undefined ? "协议 —" : `协议 v${protocolVersion}`}</span>
        <span>{latency}</span>
        <span>{profile.mode === "VNEXT" ? "实时协作" : "兼容模式"}</span>
      </div>

      {health.state.kind === "OFFLINE" && !transportRecovering && probe !== undefined ? (
        <button class="service-status-card__retry" type="button" onClick={health.retry}>
          <Icon name="sync" size={16} />
          重新连接
        </button>
      ) : null}

      <details class="service-status-card__details">
        <summary>服务器信息</summary>
        <p>当前使用服务器 {host}</p>
        {health.state.kind === "OFFLINE" ? (
          <p>重试后仍失败时，请检查服务器地址、网络连接和服务器状态。</p>
        ) : null}
      </details>
    </section>
  );
}
