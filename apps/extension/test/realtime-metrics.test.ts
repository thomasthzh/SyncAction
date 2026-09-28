import { describe, expect, it } from "vitest";
import { RealtimeMetrics } from "../src/realtime-metrics.js";

describe("RealtimeMetrics", () => {
  it("keeps privacy-safe counters, bounded latency samples, and independent snapshots", () => {
    const metrics = new RealtimeMetrics();

    metrics.recordPointerFrame(false);
    metrics.recordPointerFrame(true);
    metrics.recordMediaHeartbeat();
    metrics.recordPresenceSnapshot();
    metrics.recordPresenceDelta();
    metrics.recordPresenceGap();
    metrics.recordReconnectAttempt();
    metrics.setSelectedTransport("polling");
    metrics.observePointerDomNodes(1);
    metrics.observePointerDomNodes(3);
    metrics.observePointerDomNodes(2);
    for (let durationMs = 0; durationMs < 300; durationMs += 1) {
      metrics.recordLatency("roomEventToUi", durationMs);
    }
    metrics.recordLatency("presenceDeltaToUi", 8);
    metrics.recordLatency("reconnectRecovery", 750);
    metrics.recordLatency("roomEventToUi", Number.NaN);
    metrics.recordLatency("roomEventToUi", -1);

    const first = metrics.snapshot();
    expect(first).toEqual({
      pointerFrames: {
        emitted: 2,
        dropped: 1,
      },
      mediaHeartbeatsEmitted: 1,
      presence: {
        snapshots: 1,
        deltas: 1,
        gaps: 1,
      },
      reconnectAttempts: 1,
      selectedTransport: "polling",
      maximumPointerDomNodes: 3,
      latency: {
        roomEventToUi: {
          sampleCount: 256,
          p50Ms: 171,
          p95Ms: 287,
          maxMs: 299,
        },
        presenceDeltaToUi: {
          sampleCount: 1,
          p50Ms: 8,
          p95Ms: 8,
          maxMs: 8,
        },
        reconnectRecovery: {
          sampleCount: 1,
          p50Ms: 750,
          p95Ms: 750,
          maxMs: 750,
        },
      },
    });
    expect(JSON.stringify(first)).not.toMatch(
      /accessToken|canonicalPageIdentity|coordinate|displayName|mediaKey|title|url|username/iu,
    );

    (first as { pointerFrames: { emitted: number } }).pointerFrames.emitted = 999;
    expect(metrics.snapshot().pointerFrames.emitted).toBe(2);

    metrics.reset();
    expect(metrics.snapshot()).toEqual({
      pointerFrames: {
        emitted: 0,
        dropped: 0,
      },
      mediaHeartbeatsEmitted: 0,
      presence: {
        snapshots: 0,
        deltas: 0,
        gaps: 0,
      },
      reconnectAttempts: 0,
      selectedTransport: null,
      maximumPointerDomNodes: 0,
      latency: {
        roomEventToUi: emptyLatency(),
        presenceDeltaToUi: emptyLatency(),
        reconnectRecovery: emptyLatency(),
      },
    });
  });
});

function emptyLatency() {
  return {
    sampleCount: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  };
}
