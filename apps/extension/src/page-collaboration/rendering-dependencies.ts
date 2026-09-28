import type Danmaku from "danmaku";
import type { getStroke } from "perfect-freehand";

type DanmakuRenderingDependency = typeof Danmaku;
type DrawingRenderingDependency = typeof getStroke;

let danmakuDependency: Promise<DanmakuRenderingDependency> | undefined;
let drawingDependency: Promise<DrawingRenderingDependency> | undefined;

export function loadDanmakuRenderingDependency(): Promise<DanmakuRenderingDependency> {
  danmakuDependency ??= import("danmaku").then((module) => module.default);
  return danmakuDependency;
}

export function loadDrawingRenderingDependency(): Promise<DrawingRenderingDependency> {
  drawingDependency ??= import("perfect-freehand").then((module) => module.getStroke);
  return drawingDependency;
}
