import { describe, expect, it, vi } from "vitest";
import {
  loadDanmakuRenderingDependency,
  loadDrawingRenderingDependency,
} from "../src/page-collaboration/rendering-dependencies.js";

describe("page rendering dependencies", () => {
  it("loads the pinned danmaku and freehand implementations from local modules", async () => {
    const [danmaku, drawing] = await Promise.all([
      loadDanmakuRenderingDependency(),
      loadDrawingRenderingDependency(),
    ]);

    expect(danmaku).toBeTypeOf("function");
    expect(drawing).toBeTypeOf("function");
    expect(
      drawing(
        [
          [0, 0, 0.5],
          [10, 10, 0.5],
        ],
        { size: 5 },
      ),
    ).not.toEqual([]);
  });
});

it("releases a failed import so the next explicit request can load the dependency", async () => {
  vi.resetModules();
  vi.doMock("danmaku", () => {
    throw new Error("transient import failure");
  });
  try {
    const loader = await import("../src/page-collaboration/rendering-dependencies.js");
    const first = loader.loadDanmakuRenderingDependency();
    await expect(first).rejects.toThrow();
    class Dependency {}
    vi.doMock("danmaku", () => ({ default: Dependency }));
    const retry = loader.loadDanmakuRenderingDependency();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toBe(Dependency);
    expect(loader.loadDanmakuRenderingDependency()).toBe(retry);
  } finally {
    vi.doUnmock("danmaku");
    vi.resetModules();
  }
});
