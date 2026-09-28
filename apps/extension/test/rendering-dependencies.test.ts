import { describe, expect, it } from "vitest";
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
