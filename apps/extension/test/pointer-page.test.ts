// @vitest-environment happy-dom

import {
  PointerLeaseEventSchema,
  PointerRecordSchema,
  RoomIdSchema,
  type PointerFrameEvent,
  type PointerLeaseRecord,
  type PointerRecord,
} from "@syncaction/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PointerPageRuntime,
  buildPointerAnchor,
  buildPointerPath,
  locatePointer,
  resolvePointerPath,
  type PointerPageScheduler,
} from "../src/pointer-page.js";
import type { PointerLocalSample, PointerPageContext } from "../src/pointer-controller.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789d01");
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789d02";
const remoteUserId = "018f8f8e-4b5c-7d6e-8f90-123456789d03";
const remoteDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789d04";
let now = 1_785_120_000_000;

const context: PointerPageContext = {
  roomId,
  logicalTabId: logicalTabId as PointerPageContext["logicalTabId"],
  documentRevision: {
    roomEpoch: 2,
    tabUpdatedAtSeq: 4,
  },
};

class FakeScheduler implements PointerPageScheduler {
  public readonly timers = new Map<number, { callback: () => void; delayMs: number }>();
  public readonly animationFrames = new Map<number, () => void>();
  public cancelledAnimationFrames = 0;
  private nextId = 1;

  public setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  public requestAnimationFrame(callback: () => void): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.animationFrames.set(id, callback);
    return id;
  }

  public cancelAnimationFrame(handle: unknown): void {
    if (this.animationFrames.delete(handle as number)) {
      this.cancelledAnimationFrames += 1;
    }
  }

  public runAll(): void {
    const timers = [...this.timers.values()];
    this.timers.clear();
    for (const timer of timers) {
      timer.callback();
    }
  }

  public flushAnimationFrame(): void {
    const callbacks = [...this.animationFrames.values()];
    this.animationFrames.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

beforeEach(() => {
  now = 1_785_120_000_000;
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

describe("privacy-safe pointer paths and geometry", () => {
  it("uses only tag/nth-of-type segments and resolves duplicate siblings", () => {
    document.body.innerHTML = `
      <main id="private-id" class="secret">
        <section><button>ignore this text</button></section>
        <section>
          <button>first</button>
          <button data-account="hidden">target</button>
        </section>
      </main>
    `;
    const target = document.querySelectorAll("button")[2]!;

    const path = buildPointerPath(document, target);

    expect(path).toEqual([
      { tagName: "html", nthOfType: 1 },
      { tagName: "body", nthOfType: 1 },
      { tagName: "main", nthOfType: 1 },
      { tagName: "section", nthOfType: 2 },
      { tagName: "button", nthOfType: 2 },
    ]);
    expect(resolvePointerPath(document, path!)).toBe(target);
    expect(JSON.stringify(path)).not.toMatch(/private-id|secret|account|hidden|target|first/iu);
  });

  it("rejects shadow-root paths and paths deeper than the wire limit", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const shadowButton = document.createElement("button");
    shadow.append(shadowButton);
    expect(buildPointerPath(document, shadowButton)).toBeNull();

    let parent: Element = document.body;
    for (let index = 0; index < 11; index += 1) {
      const child = document.createElement("div");
      parent.append(child);
      parent = child;
    }
    expect(buildPointerPath(document, parent)).toBeNull();
  });

  it("anchors inside a target, falls back for zero-area targets, and hides offscreen anchors", () => {
    const target = document.createElement("article");
    document.body.append(target);
    let rectangle = domRect(100, 200, 400, 200);
    target.getBoundingClientRect = () => rectangle;
    const anchor = buildPointerAnchor(document, target, 300, 250);
    const pointer = remotePointer({ anchor, viewport: { x: 0.9, y: 0.1 } });

    expect(locatePointer(document, window, pointer)).toEqual({
      x: 300,
      y: 250,
      source: "anchor",
    });

    rectangle = domRect(100, 200, 0, 0);
    expect(locatePointer(document, window, pointer)).toEqual({
      x: 900,
      y: 80,
      source: "viewport",
    });

    rectangle = domRect(-600, 200, 400, 200);
    expect(locatePointer(document, window, pointer)).toBeNull();
  });
});

describe("PointerPageRuntime", () => {
  it("mounts in its assigned surface, repositions, expires, and fully disposes", () => {
    const target = document.createElement("main");
    document.body.append(target);
    let rectangle = domRect(100, 100, 400, 200);
    target.getBoundingClientRect = () => rectangle;
    const scheduler = new FakeScheduler();
    const surface = document.createElement("section");
    document.documentElement.append(surface);
    const runtime = new PointerPageRuntime({
      document,
      window,
      surface,
      now: () => now,
      scheduler,
      emitSample: vi.fn(),
    });
    const pointer = remotePointer({
      anchor: buildPointerAnchor(document, target, 300, 200),
    });

    runtime.setContext(context);
    runtime.render(pointer);

    expect(surface.dataset.active).toBe("true");
    expect(surface.childNodes.length).toBeGreaterThan(0);
    expect(document.querySelector("[data-syncaction-pointer-host]")).toBeNull();
    expect(runtime.getPointerPosition(remoteUserId, remoteDeviceId)).toEqual({
      x: 300,
      y: 200,
      source: "anchor",
    });

    rectangle = domRect(200, 150, 400, 200);
    window.dispatchEvent(new Event("scroll"));
    scheduler.flushAnimationFrame();
    expect(runtime.getPointerPosition(remoteUserId, remoteDeviceId)).toEqual({
      x: 400,
      y: 250,
      source: "anchor",
    });

    now += 3_000;
    scheduler.runAll();
    expect(runtime.getPointerPosition(remoteUserId, remoteDeviceId)).toBeNull();

    runtime.dispose();
    expect(surface.dataset.active).toBe("false");
    expect(surface.childNodes).toHaveLength(0);
  });

  it("reuses one node and interpolates latest v2 frames without replaying stale motion", () => {
    const scheduler = new FakeScheduler();
    const surface = document.createElement("section");
    document.documentElement.append(surface);
    const runtime = new PointerPageRuntime({
      document,
      window,
      surface,
      now: () => now,
      scheduler,
      emitSample: vi.fn(),
    });
    const lease = remoteLease();
    runtime.setContext(context);
    runtime.renderLease(lease);
    const element = surface.querySelector(".syncaction-pointer");
    expect(element).not.toBeNull();

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      runtime.renderFrame(remoteFrame(sequence, sequence * 30, sequence * 20));
    }
    expect(surface.querySelectorAll(".syncaction-pointer")).toHaveLength(1);
    expect(surface.querySelector(".syncaction-pointer")).toBe(element);
    expect(runtime.getPointerPosition(remoteUserId, remoteDeviceId)).not.toEqual({
      x: (100 * 30 * 1_000) / 4_095,
      y: (100 * 20 * 800) / 4_095,
      source: "viewport",
    });

    now += 20;
    scheduler.flushAnimationFrame();
    const interpolated = runtime.getPointerPosition(remoteUserId, remoteDeviceId);
    expect(interpolated?.x).toBeCloseTo(((30 + 100 * 30) * 1_000) / 4_095 / 2, 5);
    expect(interpolated?.y).toBeCloseTo(((20 + 100 * 20) * 800) / 4_095 / 2, 5);
    expect(surface.querySelectorAll(".syncaction-pointer-label")).toHaveLength(1);

    const beforeGap = runtime.getPointerPosition(remoteUserId, remoteDeviceId);
    now += 250;
    runtime.renderFrame(remoteFrame(101, 4_095, 4_095, 350));
    expect(runtime.getPointerPosition(remoteUserId, remoteDeviceId)).not.toEqual(beforeGap);
    expect(runtime.getPointerPosition(remoteUserId, remoteDeviceId)).toEqual({
      x: 1_000,
      y: 800,
      source: "viewport",
    });

    runtime.renderLease({ ...lease, displayName: "Renamed" });
    expect(surface.querySelector(".syncaction-pointer-label")?.textContent).toBe("Renamed");
    expect(surface.querySelector(".syncaction-pointer")).toBe(element);
    runtime.dispose();
    expect(scheduler.cancelledAnimationFrames).toBeGreaterThan(0);
    expect(surface.querySelectorAll(".syncaction-pointer")).toHaveLength(0);
  });

  it("emits strict visible-page samples for controller-side 25 Hz coalescing", () => {
    const target = document.createElement("button");
    target.id = "private";
    target.className = "secret";
    target.textContent = "never transmit";
    document.body.append(target);
    target.getBoundingClientRect = () => domRect(20, 40, 100, 80);
    const samples: PointerLocalSample[] = [];
    const surface = document.createElement("section");
    document.documentElement.append(surface);
    const runtime = new PointerPageRuntime({
      document,
      window,
      surface,
      now: () => now,
      scheduler: new FakeScheduler(),
      emitSample: (sample) => {
        samples.push(sample);
      },
    });
    runtime.setContext(context);

    runtime.handlePointerMove(pointerMove(target, 70, 80));
    now += 50;
    runtime.handlePointerMove(pointerMove(target, 80, 90));
    now += 50;
    runtime.handlePointerMove(pointerMove(target, 90, 100));

    expect(samples).toHaveLength(3);
    expect(samples[0]).toMatchObject({
      type: "pointer.sample",
      documentRevision: context.documentRevision,
      anchor: {
        path: expect.arrayContaining([{ tagName: "button", nthOfType: 1 }]),
        x: 0.5,
        y: 0.5,
      },
      viewport: { x: 0.07, y: 0.1 },
      viewportDimensions: { widthCssPx: 1_000, heightCssPx: 800 },
    });
    expect(samples[2]!.viewport).toEqual({ x: 0.09, y: 0.125 });
    expect(JSON.stringify(samples)).not.toMatch(
      /private|secret|never transmit|roomId|logicalTabId/iu,
    );
  });

  it("does not emit pointer samples while the document is hidden", () => {
    const target = document.createElement("button");
    document.body.append(target);
    target.getBoundingClientRect = () => domRect(20, 40, 100, 80);
    const samples: PointerLocalSample[] = [];
    const surface = document.createElement("section");
    document.documentElement.append(surface);
    const runtime = new PointerPageRuntime({
      document,
      window,
      surface,
      now: () => now,
      scheduler: new FakeScheduler(),
      emitSample: (sample) => {
        samples.push(sample);
      },
    });
    runtime.setContext(context);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    runtime.handlePointerMove(pointerMove(target, 70, 80));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    runtime.handlePointerMove(pointerMove(target, 70, 80));

    expect(samples).toHaveLength(2);
    expect(samples[1]).toMatchObject({
      type: "pointer.sample",
      documentRevision: context.documentRevision,
      documentVisible: false,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    runtime.dispose();
  });
});

function remotePointer(
  overrides: Partial<Pick<PointerRecord, "anchor" | "viewport">> = {},
): PointerRecord {
  return PointerRecordSchema.parse({
    userId: remoteUserId,
    username: "remote",
    displayName: "Remote",
    deviceId: remoteDeviceId as PointerFrameEvent["deviceId"],
    color: "#22c55e",
    logicalTabId,
    documentRevision: context.documentRevision,
    anchor:
      overrides.anchor === undefined
        ? {
            path: [
              { tagName: "html", nthOfType: 1 },
              { tagName: "body", nthOfType: 1 },
            ],
            x: 0.5,
            y: 0.5,
          }
        : overrides.anchor,
    viewport: overrides.viewport ?? { x: 0.5, y: 0.5 },
    expiresAt: now + 3_000,
  });
}

function remoteLease(): PointerLeaseRecord {
  return PointerLeaseEventSchema.parse({
    type: "pointer.lease.event",
    protocolVersion: 1,
    roomId,
    lease: {
      userId: remoteUserId,
      username: "remote",
      displayName: "Remote",
      deviceId: remoteDeviceId,
      leaseId: "018f8f8e-4b5c-7d6e-8f90-123456789d05",
      color: "#22c55e",
      logicalTabId,
      documentRevision: context.documentRevision,
      anchor: null,
      expiresAt: now + 3_000,
    },
  }).lease;
}

function remoteFrame(
  sequence: number,
  xQuantized: number,
  yQuantized: number,
  serverGapMs = 40,
): PointerFrameEvent {
  return {
    type: "pointer.frame",
    protocolVersion: 1,
    roomId,
    userId: remoteUserId,
    deviceId: remoteDeviceId as PointerFrameEvent["deviceId"],
    leaseId: remoteLease().leaseId,
    seq: sequence,
    xQuantized,
    yQuantized,
    viewport: { widthBucket: 7, heightBucket: 5 },
    receivedAtServerMs: 1_785_120_000_000 + sequence * serverGapMs,
  };
}

function pointerMove(target: Element, clientX: number, clientY: number) {
  return {
    clientX,
    clientY,
    composedPath: () => [target, document.body, document.documentElement, document, window],
  };
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  };
}
