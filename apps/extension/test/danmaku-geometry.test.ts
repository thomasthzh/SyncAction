// @vitest-environment happy-dom

import {
  DanmakuEventMessageSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
} from "@syncaction/protocol";
import Danmaku from "danmaku";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDanmakuRenderingEngine,
  DanmakuPageRuntime,
} from "../src/page-collaboration/danmaku-runtime.js";
import { PageOverlayHost } from "../src/page-collaboration/page-overlay-host.js";

const context = {
  roomId: RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a01"),
  logicalTabId: LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a02"),
  documentRevision: { roomEpoch: 4, tabUpdatedAtSeq: 8 },
  frameKey: "top",
};
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function harness() {
  const host = new PageOverlayHost({ document });
  const surface = host.getSurface("danmaku");
  const dimensions = { width: 900, height: 600 };
  const emittedGeometry: Array<{
    active: string | undefined;
    width: string | undefined;
    height: string | undefined;
    speed: number;
  }> = [];
  const instances: Danmaku[] = [];
  let stage: HTMLElement | undefined;
  class CapturedDanmaku extends Danmaku {
    public constructor(options: ConstructorParameters<typeof Danmaku>[0]) {
      super(options);
      instances.push(this);
    }

    public override emit(comment: Parameters<Danmaku["emit"]>[0]): Danmaku {
      emittedGeometry.push({
        active: surface.dataset.active,
        width: stage?.style.width,
        height: stage?.style.height,
        speed: this.speed,
      });
      return super.emit(comment);
    }
  }
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const runtime = new DanmakuPageRuntime({
    document,
    window,
    surface,
    context,
    now: () => 1_785_160_000_000,
    reducedMotion: () => false,
    emitSubmit: () => {},
    scheduler: {
      setTimeout: (callback) => {
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    setInteraction: (interaction) => host.setSurfaceInteraction("danmaku", interaction),
    createEngine: (container) => {
      // happy-dom has no layout. Preserve the real host's inactive-zero rule,
      // while the real library reads these public element dimensions itself.
      const width = () => (surface.dataset.active === "true" ? dimensions.width : 0);
      const height = () => (surface.dataset.active === "true" ? dimensions.height : 0);
      Object.defineProperties(container, {
        clientWidth: { get: width },
        offsetWidth: { get: width },
        clientHeight: { get: height },
        offsetHeight: { get: height },
      });
      const engine = createDanmakuRenderingEngine(container, CapturedDanmaku);
      stage = container.firstElementChild as HTMLElement;
      return engine;
    },
  });
  cleanups.push(() => {
    runtime.dispose();
    host.dispose("BACKGROUND_STOPPED");
    expect(timers.size).toBe(0);
  });
  return { runtime, surface, dimensions, emittedGeometry, library: instances[0]!, stage: stage! };
}

function event(index: number) {
  return DanmakuEventMessageSchema.parse({
    type: "danmaku.event",
    protocolVersion: 1,
    messageId: `018f8f8e-4b5c-7d6e-8f90-723456789a${index.toString(16).padStart(2, "0")}`,
    ...context,
    sender: {
      userId: "018f8f8e-4b5c-7d6e-8f90-723456789a03",
      username: "remote",
      displayName: "Remote",
      deviceId: DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a04"),
    },
    text: `消息${index}`,
    sentAtServerMs: 1_785_160_000_000,
    expiresAtServerMs: 1_785_160_009_000,
  });
}

describe("real Danmaku engine geometry through the overlay host", () => {
  it("measures the activated surface before the first moving message", () => {
    const h = harness();
    expect(h.surface.dataset.active).toBe("false");
    expect(h.stage.style.width).toBe("0px");
    expect(h.stage.style.height).toBe("0px");
    expect(h.library.speed).toBe(48);

    h.runtime.render(event(1));

    expect(h.surface.dataset.active).toBe("true");
    expect.soft(h.stage.style.width).toBe("900px");
    expect.soft(h.stage.style.height).toBe("600px");
    expect.soft(h.library.speed).toBe(100);
    expect(h.emittedGeometry).toEqual([
      { active: "true", width: "900px", height: "600px", speed: 100 },
    ]);
  });

  it("refreshes hidden-to-visible geometry once for the retained message batch", () => {
    const h = harness();
    for (let index = 1; index <= 12; index++) h.runtime.render(event(index));
    h.runtime.setHidden(true);
    h.dimensions.width = 1080;
    h.dimensions.height = 720;
    h.runtime.handleResize();
    const resize = vi.spyOn(h.library, "resize");

    h.runtime.setHidden(false);

    expect(h.surface.dataset.active).toBe("true");
    expect.soft(h.stage.style.width).toBe("1080px");
    expect.soft(h.stage.style.height).toBe("720px");
    expect.soft(h.library.speed).toBe(120);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(h.emittedGeometry.slice(-12)).toEqual(
      Array.from({ length: 12 }, () => ({
        active: "true",
        width: "1080px",
        height: "720px",
        speed: 120,
      })),
    );
  });

  it("refreshes the first message after an empty hidden surface resized", () => {
    const h = harness();
    h.runtime.render(event(1));
    h.runtime.clear();
    expect(h.surface.dataset.active).toBe("false");
    h.dimensions.width = 1260;
    h.dimensions.height = 700;
    h.runtime.handleResize();

    h.runtime.render(event(2));

    expect.soft(h.stage.style.width).toBe("1260px");
    expect.soft(h.stage.style.height).toBe("700px");
    expect.soft(h.library.speed).toBe(140);
    expect(h.emittedGeometry.at(-1)).toEqual({
      active: "true",
      width: "1260px",
      height: "700px",
      speed: 140,
    });
  });
});
