const MAX_LATENCY_SAMPLES = 256;

export type RealtimeTransportName = "websocket" | "polling";
export type RealtimeLatencyName = "roomEventToUi" | "presenceDeltaToUi" | "reconnectRecovery";

export interface RealtimeLatencySummary {
  readonly sampleCount: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

export interface RealtimeMetricsSnapshot {
  readonly pointerFrames: {
    readonly emitted: number;
    readonly dropped: number;
  };
  readonly mediaHeartbeatsEmitted: number;
  readonly presence: {
    readonly snapshots: number;
    readonly deltas: number;
    readonly gaps: number;
  };
  readonly reconnectAttempts: number;
  readonly selectedTransport: RealtimeTransportName | null;
  readonly maximumPointerDomNodes: number;
  readonly latency: Record<RealtimeLatencyName, RealtimeLatencySummary>;
}

export class RealtimeMetrics {
  #pointerFramesEmitted = 0;
  #pointerFramesDropped = 0;
  #mediaHeartbeatsEmitted = 0;
  #presenceSnapshots = 0;
  #presenceDeltas = 0;
  #presenceGaps = 0;
  #reconnectAttempts = 0;
  #selectedTransport: RealtimeTransportName | null = null;
  #maximumPointerDomNodes = 0;
  readonly #latencySamples: Record<RealtimeLatencyName, number[]> = {
    roomEventToUi: [],
    presenceDeltaToUi: [],
    reconnectRecovery: [],
  };

  public recordPointerFrame(dropped: boolean): void {
    this.#pointerFramesEmitted = increment(this.#pointerFramesEmitted);
    if (dropped) {
      this.#pointerFramesDropped = increment(this.#pointerFramesDropped);
    }
  }

  public recordMediaHeartbeat(): void {
    this.#mediaHeartbeatsEmitted = increment(this.#mediaHeartbeatsEmitted);
  }

  public recordPresenceSnapshot(): void {
    this.#presenceSnapshots = increment(this.#presenceSnapshots);
  }

  public recordPresenceDelta(): void {
    this.#presenceDeltas = increment(this.#presenceDeltas);
  }

  public recordPresenceGap(): void {
    this.#presenceGaps = increment(this.#presenceGaps);
  }

  public recordReconnectAttempt(): void {
    this.#reconnectAttempts = increment(this.#reconnectAttempts);
  }

  public setSelectedTransport(transport: RealtimeTransportName): void {
    if (transport === "websocket" || transport === "polling") {
      this.#selectedTransport = transport;
    }
  }

  public observePointerDomNodes(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      return;
    }
    this.#maximumPointerDomNodes = Math.max(this.#maximumPointerDomNodes, count);
  }

  public recordLatency(name: RealtimeLatencyName, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    const samples = this.#latencySamples[name];
    samples.push(durationMs);
    if (samples.length > MAX_LATENCY_SAMPLES) {
      samples.splice(0, samples.length - MAX_LATENCY_SAMPLES);
    }
  }

  public snapshot(): Readonly<RealtimeMetricsSnapshot> {
    return {
      pointerFrames: {
        emitted: this.#pointerFramesEmitted,
        dropped: this.#pointerFramesDropped,
      },
      mediaHeartbeatsEmitted: this.#mediaHeartbeatsEmitted,
      presence: {
        snapshots: this.#presenceSnapshots,
        deltas: this.#presenceDeltas,
        gaps: this.#presenceGaps,
      },
      reconnectAttempts: this.#reconnectAttempts,
      selectedTransport: this.#selectedTransport,
      maximumPointerDomNodes: this.#maximumPointerDomNodes,
      latency: {
        roomEventToUi: summarize(this.#latencySamples.roomEventToUi),
        presenceDeltaToUi: summarize(this.#latencySamples.presenceDeltaToUi),
        reconnectRecovery: summarize(this.#latencySamples.reconnectRecovery),
      },
    };
  }

  public reset(): void {
    this.#pointerFramesEmitted = 0;
    this.#pointerFramesDropped = 0;
    this.#mediaHeartbeatsEmitted = 0;
    this.#presenceSnapshots = 0;
    this.#presenceDeltas = 0;
    this.#presenceGaps = 0;
    this.#reconnectAttempts = 0;
    this.#selectedTransport = null;
    this.#maximumPointerDomNodes = 0;
    for (const samples of Object.values(this.#latencySamples)) {
      samples.length = 0;
    }
  }
}

export const realtimeMetrics = new RealtimeMetrics();

function increment(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function summarize(samples: readonly number[]): RealtimeLatencySummary {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    };
  }
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    sampleCount: ordered.length,
    p50Ms: percentile(ordered, 0.5),
    p95Ms: percentile(ordered, 0.95),
    maxMs: ordered.at(-1) ?? null,
  };
}

function percentile(ordered: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index]!;
}
