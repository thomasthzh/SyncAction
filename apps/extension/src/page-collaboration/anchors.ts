import {
  AnnotationAnchorSchema,
  AnnotationLayoutSignatureSchema,
  CollaborationFrameKeySchema,
  NormalizedPointSchema,
  type AnnotationAnchor,
  type AnnotationLayoutSignature,
  type MediaProvider,
  type NormalizedPoint,
} from "@syncaction/protocol";
import { structuralMediaFingerprint } from "../media-adapters/html-media.js";
import { buildPointerPath, resolvePointerPath } from "../pointer-page.js";

type AnnotationMediaAnchor = Extract<AnnotationAnchor, { type: "media" }>;

export interface AnnotationAnchorEnvironment {
  document: Document;
  window: Window;
  frameKey: string;
  identifyMedia?: (element: Element) => Pick<AnnotationMediaAnchor, "provider" | "mediaKey"> | null;
  resolveMedia?: (provider: MediaProvider, mediaKey: string) => Element | null;
}

export interface AnnotationRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type AnnotationAnchorUnlocatableReason =
  | "INVALID_ANCHOR"
  | "WRONG_FRAME"
  | "TARGET_MISSING"
  | "TARGET_HIDDEN"
  | "MEDIA_NOT_FOUND"
  | "LAYOUT_AXIS_DRIFT"
  | "LAYOUT_ASPECT_DRIFT";

export type AnnotationAnchorResolution =
  | {
      state: "LOCATED";
      anchor: AnnotationAnchor;
      rectangle: AnnotationRectangle;
    }
  | {
      state: "UNLOCATABLE";
      reason: AnnotationAnchorUnlocatableReason;
    };

export function captureAnnotationAnchor(
  environment: AnnotationAnchorEnvironment,
  target: Element | null,
): AnnotationAnchor | null {
  if (
    target === null ||
    target === environment.document.documentElement ||
    target === environment.document.body
  ) {
    const parsed = AnnotationAnchorSchema.safeParse({
      type: "document",
      layoutSignature: readDocumentLayoutSignature(environment.document, environment.window),
    });
    return parsed.success ? parsed.data : null;
  }
  if (target.getRootNode() !== environment.document || !target.isConnected) {
    return null;
  }
  const mediaIdentity = environment.identifyMedia?.(target) ?? defaultHtmlMediaIdentity(target);
  if (mediaIdentity !== null) {
    const parsed = AnnotationAnchorSchema.safeParse({
      type: "media",
      ...mediaIdentity,
    });
    return parsed.success ? parsed.data : null;
  }
  const path = buildPointerPath(environment.document, target);
  if (path === null) {
    return null;
  }
  const parsed = AnnotationAnchorSchema.safeParse({ type: "element", path });
  return parsed.success ? parsed.data : null;
}

export function resolveAnnotationAnchor(
  environment: AnnotationAnchorEnvironment,
  input: { anchor: AnnotationAnchor; frameKey: string },
): AnnotationAnchorResolution {
  const currentFrame = CollaborationFrameKeySchema.safeParse(environment.frameKey);
  const requestedFrame = CollaborationFrameKeySchema.safeParse(input.frameKey);
  const anchor = AnnotationAnchorSchema.safeParse(input.anchor);
  if (!currentFrame.success || !requestedFrame.success || !anchor.success) {
    return { state: "UNLOCATABLE", reason: "INVALID_ANCHOR" };
  }
  if (currentFrame.data !== requestedFrame.data) {
    return { state: "UNLOCATABLE", reason: "WRONG_FRAME" };
  }

  if (anchor.data.type === "document") {
    const current = readDocumentLayoutSignature(environment.document, environment.window);
    const expected = anchor.data.layoutSignature;
    if (
      relativeDifference(current.widthCssPx, expected.widthCssPx) > 0.1 ||
      relativeDifference(current.heightCssPx, expected.heightCssPx) > 0.1
    ) {
      return { state: "UNLOCATABLE", reason: "LAYOUT_AXIS_DRIFT" };
    }
    if (
      relativeDifference(
        current.widthCssPx / current.heightCssPx,
        expected.widthCssPx / expected.heightCssPx,
      ) > 0.05
    ) {
      return { state: "UNLOCATABLE", reason: "LAYOUT_ASPECT_DRIFT" };
    }
    return {
      state: "LOCATED",
      anchor: anchor.data,
      rectangle: {
        left: -finiteScroll(environment.window.scrollX),
        top: -finiteScroll(environment.window.scrollY),
        width: current.widthCssPx,
        height: current.heightCssPx,
      },
    };
  }

  let target: Element | null;
  if (anchor.data.type === "media") {
    target =
      environment.resolveMedia?.(anchor.data.provider, anchor.data.mediaKey) ??
      resolveDefaultHtmlMedia(environment.document, anchor.data.provider, anchor.data.mediaKey);
    if (target === null) {
      return { state: "UNLOCATABLE", reason: "MEDIA_NOT_FOUND" };
    }
  } else {
    target = resolvePointerPath(environment.document, anchor.data.path);
    if (target === null) {
      return { state: "UNLOCATABLE", reason: "TARGET_MISSING" };
    }
  }
  if (!target.isConnected || target.getRootNode() !== environment.document) {
    return { state: "UNLOCATABLE", reason: "TARGET_MISSING" };
  }
  const rectangle = target.getBoundingClientRect();
  if (!isVisibleTarget(environment.window, target, rectangle)) {
    return { state: "UNLOCATABLE", reason: "TARGET_HIDDEN" };
  }
  return {
    state: "LOCATED",
    anchor: anchor.data,
    rectangle: copyRectangle(rectangle),
  };
}

export function normalizeAnnotationPoint(
  rectangle: AnnotationRectangle,
  clientX: number,
  clientY: number,
  pressureInput: number,
): NormalizedPoint {
  if (
    !isUsableRectangle(rectangle) ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !Number.isFinite(pressureInput)
  ) {
    throw new Error("INVALID_ANNOTATION_POINT");
  }
  return NormalizedPointSchema.parse({
    x: clamp((clientX - rectangle.left) / rectangle.width),
    y: clamp((clientY - rectangle.top) / rectangle.height),
    pressure: clamp(pressureInput),
  });
}

export function projectAnnotationPoint(
  resolution: Extract<AnnotationAnchorResolution, { state: "LOCATED" }>,
  pointInput: NormalizedPoint,
): { x: number; y: number; pressure: number } {
  const point = NormalizedPointSchema.parse(pointInput);
  return {
    x: resolution.rectangle.left + resolution.rectangle.width * point.x,
    y: resolution.rectangle.top + resolution.rectangle.height * point.y,
    pressure: point.pressure,
  };
}

export function readDocumentLayoutSignature(
  document: Document,
  window: Window,
): AnnotationLayoutSignature {
  const root = document.documentElement;
  const body = document.body;
  return AnnotationLayoutSignatureSchema.parse({
    widthCssPx: positiveMaximum(
      root.scrollWidth,
      root.clientWidth,
      body?.scrollWidth,
      body?.clientWidth,
      window.innerWidth,
    ),
    heightCssPx: positiveMaximum(
      root.scrollHeight,
      root.clientHeight,
      body?.scrollHeight,
      body?.clientHeight,
      window.innerHeight,
    ),
  });
}

function isVisibleTarget(window: Window, target: Element, rectangle: DOMRect): boolean {
  if (!isUsableRectangle(rectangle)) {
    return false;
  }
  const style = window.getComputedStyle(target);
  return (
    style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
  );
}

function isUsableRectangle(rectangle: AnnotationRectangle): boolean {
  return (
    Number.isFinite(rectangle.left) &&
    Number.isFinite(rectangle.top) &&
    Number.isFinite(rectangle.width) &&
    Number.isFinite(rectangle.height) &&
    rectangle.width > 0 &&
    rectangle.height > 0
  );
}

function copyRectangle(rectangle: DOMRect): AnnotationRectangle {
  return {
    left: rectangle.left,
    top: rectangle.top,
    width: rectangle.width,
    height: rectangle.height,
  };
}

function positiveMaximum(...values: Array<number | undefined>): number {
  const finite = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return Math.max(1, ...finite);
}

function relativeDifference(current: number, expected: number): number {
  return Math.abs(current - expected) / expected;
}

function finiteScroll(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function defaultHtmlMediaIdentity(
  element: Element,
): Pick<AnnotationMediaAnchor, "provider" | "mediaKey"> | null {
  if (!isHtmlMediaElement(element)) {
    return null;
  }
  const fingerprint = structuralMediaFingerprint(element);
  const matches = [
    ...element.ownerDocument.querySelectorAll<HTMLMediaElement>("video, audio"),
  ].filter((candidate) => structuralMediaFingerprint(candidate) === fingerprint);
  if (matches.length !== 1 || matches[0] !== element) {
    return null;
  }
  return {
    provider: "HTML5",
    mediaKey: `html5:${fingerprint}`,
  };
}

function resolveDefaultHtmlMedia(
  document: Document,
  provider: MediaProvider,
  mediaKey: string,
): Element | null {
  if (provider !== "HTML5") {
    return null;
  }
  const matches = [...document.querySelectorAll<HTMLMediaElement>("video, audio")].filter(
    (candidate) => `html5:${structuralMediaFingerprint(candidate)}` === mediaKey,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function isHtmlMediaElement(element: Element): element is HTMLMediaElement {
  const tagName = element.tagName.toLowerCase();
  return tagName === "video" || tagName === "audio";
}
