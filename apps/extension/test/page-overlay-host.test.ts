// @vitest-environment happy-dom

import { PointerRecordSchema, RoomIdSchema } from "@syncaction/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_OVERLAY_HOST_ATTRIBUTE,
  PageOverlayHost,
  installPageCollaborationRuntime,
  type PageSurfaceName,
} from "../src/page-collaboration/page-overlay-host.js";
import { PointerPageRuntime, type PointerPageScheduler } from "../src/pointer-page.js";
import type { PointerLocalSample, PointerPageContext } from "../src/pointer-controller.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a01");
const otherRoomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789a02");
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789a03";
const remoteUserId = "018f8f8e-4b5c-7d6e-8f90-123456789a04";
const remoteDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789a05";
const surfaces: readonly PageSurfaceName[] = ["pointer", "media", "danmaku", "drawing"];
let now = 1_785_140_000_000;

const context: PointerPageContext = {
  roomId,
  logicalTabId: logicalTabId as PointerPageContext["logicalTabId"],
  documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 4 },
};

class FakeScheduler implements PointerPageScheduler {
  public readonly timers = new Map<number, () => void>();
  #nextId = 1;

  public setTimeout(callback: () => void): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.timers.set(id, callback);
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  public requestAnimationFrame(callback: () => void): unknown {
    callback();
    return 1;
  }

  public cancelAnimationFrame(): void {}
}

beforeEach(() => {
  now = 1_785_140_000_000;
  document.querySelectorAll(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`).forEach((node) => node.remove());
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

describe("PageOverlayHost", () => {
  it("mounts one closed host with four independent inert surfaces", () => {
    const host = new PageOverlayHost({ document });

    expect(document.querySelectorAll(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`)).toHaveLength(1);
    expect(host.element.shadowRoot).toBeNull();
    expect(host.element.style.pointerEvents).toBe("none");
    expect(surfaces.map((name) => host.getSurface(name).dataset.surface)).toEqual(surfaces);
    for (const name of surfaces) {
      const surface = host.getSurface(name);
      expect(surface.dataset.active).toBe("false");
      expect(surface.style.pointerEvents).toBe("none");
    }

    host.getSurface("pointer").append(document.createElement("span"));
    host.getSurface("danmaku").append(document.createElement("span"));
    host.clearSurface("pointer");
    expect(host.getSurface("pointer").childNodes).toHaveLength(0);
    expect(host.getSurface("danmaku").childNodes).toHaveLength(1);

    host.dispose("BACKGROUND_STOPPED");
  });

  it("returns the same installed runtime on repeat injection", () => {
    const scope: Record<string, unknown> = {};
    const create = vi.fn(() => ({ id: Symbol("runtime") }));

    const first = installPageCollaborationRuntime(scope, create);
    const second = installPageCollaborationRuntime(scope, create);

    expect(first.runtime).toBe(second.runtime);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(create).toHaveBeenCalledOnce();
    first.uninstall();
  });

  it("lets each delegated runtime activate only its own input boundary", () => {
    const host = new PageOverlayHost({ document });

    host.setSurfaceInteraction("danmaku", { active: true, capturesInput: true });
    expect(host.getSurface("danmaku").dataset.active).toBe("true");
    expect(host.getSurface("danmaku").style.pointerEvents).toBe("auto");
    expect(host.getSurface("drawing").dataset.active).toBe("false");
    expect(host.getSurface("drawing").style.pointerEvents).toBe("none");

    host.setSurfaceInteraction("danmaku", { active: true, capturesInput: false });
    expect(host.getSurface("danmaku").dataset.active).toBe("true");
    expect(host.getSurface("danmaku").style.pointerEvents).toBe("none");

    host.setSurfaceInteraction("danmaku", { active: false, capturesInput: true });
    expect(host.getSurface("danmaku").dataset.active).toBe("false");
    expect(host.getSurface("danmaku").style.pointerEvents).toBe("none");
    host.dispose("BACKGROUND_STOPPED");
  });

  it("disposes every surface controller on room, revision, and origin lifecycle changes", () => {
    const host = new PageOverlayHost({ document });
    const disposed: string[] = [];
    const bindAll = (): void => {
      for (const name of surfaces) {
        host.getSurface(name).append(document.createElement("span"));
        host.registerSurfaceController(name, (reason) => {
          disposed.push(`${name}:${reason}`);
        });
      }
    };

    bindAll();
    host.updateContext({
      roomId,
      logicalTabId,
      documentRevision: context.documentRevision,
    });
    host.updateContext({
      roomId: otherRoomId,
      logicalTabId,
      documentRevision: context.documentRevision,
    });
    expect(disposed).toEqual(surfaces.map((name) => `${name}:ROOM_SWITCHED`));
    expect(surfaces.every((name) => host.getSurface(name).childNodes.length === 0)).toBe(true);

    disposed.length = 0;
    bindAll();
    host.updateContext({
      roomId: otherRoomId,
      logicalTabId,
      documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 5 },
    });
    expect(disposed).toEqual(surfaces.map((name) => `${name}:REVISION_CHANGED`));

    disposed.length = 0;
    bindAll();
    host.dispose("ORIGIN_REVOKED");
    expect(disposed).toEqual(surfaces.map((name) => `${name}:ORIGIN_REVOKED`));
    expect(host.element.isConnected).toBe(false);
  });

  it("disposes every surface when the physical page is rebound to another logical tab", () => {
    const host = new PageOverlayHost({ document });
    const disposed: string[] = [];
    host.updateContext({
      roomId,
      logicalTabId,
      documentRevision: context.documentRevision,
    });
    for (const name of surfaces) {
      host.registerSurfaceController(name, (reason) => disposed.push(`${name}:${reason}`));
    }

    host.updateContext({
      roomId,
      logicalTabId: "018f8f8e-4b5c-7d6e-8f90-123456789aff",
      documentRevision: context.documentRevision,
    });

    expect(disposed).toEqual(surfaces.map((name) => `${name}:REVISION_CHANGED`));
    host.dispose("BACKGROUND_STOPPED");
  });

  it("disposes delegated tools when an exact frame identity changes", () => {
    const host = new PageOverlayHost({ document });
    const disposed: string[] = [];
    host.updateContext({
      roomId,
      logicalTabId,
      documentRevision: context.documentRevision,
      frameKey: "top",
    });
    host.registerSurfaceController("drawing", (reason) => disposed.push(reason));

    host.updateContext({
      roomId,
      logicalTabId,
      documentRevision: context.documentRevision,
      frameKey: "frame:sha256-0123456789abcdef0123456789abcdef",
    });

    expect(disposed).toEqual(["REVISION_CHANGED"]);
    host.dispose("BACKGROUND_STOPPED");
  });

  it("rebuilds once after external removal, then pauses and reports one degraded capability", async () => {
    const capabilities: unknown[] = [];
    const disposed: string[] = [];
    const host = new PageOverlayHost({
      document,
      onCapability: (capability) => {
        capabilities.push(capability);
      },
    });
    expect(host.getPageHostCapability()).toEqual({
      type: "syncaction.page.capability",
      capability: "PAGE_HOST",
      state: "AVAILABLE",
      errorCode: null,
    });
    host.registerSurfaceController("pointer", (reason) => {
      disposed.push(reason);
    });

    host.element.remove();
    await vi.waitFor(() => expect(host.element.isConnected).toBe(true));
    expect(host.state).toBe("ACTIVE");

    host.element.remove();
    await vi.waitFor(() => expect(host.state).toBe("PAUSED"));
    expect(host.element.isConnected).toBe(false);
    expect(disposed).toEqual(["BACKGROUND_STOPPED"]);
    expect(capabilities).toEqual([
      {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      },
    ]);

    document.documentElement.append(host.element);
    host.element.remove();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(capabilities).toHaveLength(1);
  });
});

describe("PointerPageRuntime compatibility inside the shared host", () => {
  it("preserves context, render, clear, and sample payloads without touching another surface", () => {
    const host = new PageOverlayHost({ document });
    const scheduler = new FakeScheduler();
    const samples: PointerLocalSample[] = [];
    const runtime = new PointerPageRuntime({
      document,
      window,
      surface: host.getSurface("pointer"),
      now: () => now,
      scheduler,
      emitSample: (sample) => {
        samples.push(sample);
      },
    });
    host.registerSurfaceController("pointer", () => runtime.dispose());
    const target = document.createElement("main");
    target.getBoundingClientRect = () => domRect(100, 100, 400, 200);
    document.body.append(target);
    host.getSurface("danmaku").append(document.createElement("span"));
    const pointer = PointerRecordSchema.parse({
      userId: remoteUserId,
      username: "remote",
      displayName: "Remote",
      deviceId: remoteDeviceId,
      color: "#22c55e",
      logicalTabId,
      documentRevision: context.documentRevision,
      anchor: {
        path: [
          { tagName: "html", nthOfType: 1 },
          { tagName: "body", nthOfType: 1 },
          { tagName: "main", nthOfType: 1 },
        ],
        x: 0.5,
        y: 0.5,
      },
      viewport: { x: 0.9, y: 0.1 },
      expiresAt: now + 3_000,
    });

    runtime.setContext(context);
    runtime.render(pointer);
    expect(host.getSurface("pointer").childNodes.length).toBeGreaterThan(0);
    expect(document.querySelector("[data-syncaction-pointer-host]")).toBeNull();
    runtime.handlePointerMove({
      clientX: 300,
      clientY: 200,
      composedPath: () => [target, document.body, document.documentElement, document, window],
    });

    expect(runtime.getPointerPosition(remoteUserId, remoteDeviceId)).toEqual({
      x: 300,
      y: 200,
      source: "anchor",
    });
    expect(samples).toEqual([
      {
        type: "pointer.sample",
        documentRevision: context.documentRevision,
        anchor: {
          path: [
            { tagName: "html", nthOfType: 1 },
            { tagName: "body", nthOfType: 1 },
            { tagName: "main", nthOfType: 1 },
          ],
          x: 0.5,
          y: 0.5,
        },
        viewport: { x: 0.3, y: 0.25 },
        viewportDimensions: { widthCssPx: 1_000, heightCssPx: 800 },
        documentVisible: true,
      },
    ]);
    runtime.clear({ userId: remoteUserId, deviceId: remoteDeviceId });
    expect(runtime.getPointerPosition(remoteUserId, remoteDeviceId)).toBeNull();
    expect(host.getSurface("danmaku").childNodes).toHaveLength(1);

    host.dispose("BACKGROUND_STOPPED");
  });
});

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
