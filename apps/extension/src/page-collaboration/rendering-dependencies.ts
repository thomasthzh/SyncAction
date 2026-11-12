import type Danmaku from "danmaku";
import type { getStroke } from "perfect-freehand";

type DanmakuRenderingDependency = typeof Danmaku;
type DrawingRenderingDependency = typeof getStroke;

let danmakuDependency: Promise<DanmakuRenderingDependency> | undefined;
let drawingDependency: Promise<DrawingRenderingDependency> | undefined;

export function loadDanmakuRenderingDependency(): Promise<DanmakuRenderingDependency> {
  if (danmakuDependency === undefined) {
    const pending = import("danmaku").then((module) => module.default);
    danmakuDependency = pending;
    void pending.catch(() => {
      if (danmakuDependency === pending) danmakuDependency = undefined;
    });
  }
  return danmakuDependency;
}

export function loadDrawingRenderingDependency(): Promise<DrawingRenderingDependency> {
  if (drawingDependency === undefined) {
    const pending = import("perfect-freehand").then((module) => module.getStroke);
    drawingDependency = pending;
    void pending.catch(() => {
      if (drawingDependency === pending) drawingDependency = undefined;
    });
  }
  return drawingDependency;
}
