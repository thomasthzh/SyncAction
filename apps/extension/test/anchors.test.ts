// @vitest-environment happy-dom

import type { AnnotationAnchor, NormalizedPoint } from "@syncaction/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureAnnotationAnchor,
  normalizeAnnotationPoint,
  projectAnnotationPoint,
  resolveAnnotationAnchor,
  type AnnotationAnchorEnvironment,
} from "../src/page-collaboration/anchors.js";

const frameKey = "top";

beforeEach(() => {
  document.body.replaceChildren();
  setDimension(document.documentElement, "scrollWidth", 1_200);
  setDimension(document.documentElement, "scrollHeight", 2_400);
  setDimension(document.documentElement, "clientWidth", 1_000);
  setDimension(document.documentElement, "clientHeight", 800);
  setDimension(document.body, "scrollWidth", 1_200);
  setDimension(document.body, "scrollHeight", 2_400);
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

describe("annotation anchors", () => {
  it("captures and resolves privacy-safe element anchors across scroll, zoom, and viewport changes", () => {
    const first = document.createElement("article");
    const second = document.createElement("article");
    const target = document.createElement("button");
    target.id = "private-account-id";
    target.className = "private-class";
    target.setAttribute("aria-label", "Private aria text");
    target.textContent = "Private visible text";
    (target as HTMLButtonElement).value = "Private input value";
    second.append(target);
    document.body.append(first, second);
    let rectangle = domRect(100, 200, 400, 160);
    target.getBoundingClientRect = () => rectangle;
    const environment = anchorEnvironment();

    const anchor = captureAnnotationAnchor(environment, target);

    expect(anchor).toEqual({
      type: "element",
      path: [
        { tagName: "html", nthOfType: 1 },
        { tagName: "body", nthOfType: 1 },
        { tagName: "article", nthOfType: 2 },
        { tagName: "button", nthOfType: 1 },
      ],
    });
    expect(JSON.stringify(anchor)).not.toMatch(
      /private-account-id|private-class|Private aria text|Private visible text|Private input value/u,
    );

    const point = normalizeAnnotationPoint(rectangle, 300, 240, 0.6);
    expect(point).toEqual({ x: 0.5, y: 0.25, pressure: 0.6 });
    expect(projectAnnotationPoint(requireLocated(environment, anchor!), point)).toEqual({
      x: 300,
      y: 240,
      pressure: 0.6,
    });

    rectangle = domRect(50, 80, 800, 320);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 600 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 480 });
    expect(projectAnnotationPoint(requireLocated(environment, anchor), point)).toEqual({
      x: 450,
      y: 160,
      pressure: 0.6,
    });
  });

  it("uses explicit media identities and never guesses through a ShadowRoot", () => {
    const video = document.createElement("video");
    const shadowHost = document.createElement("div");
    const shadow = shadowHost.attachShadow({ mode: "open" });
    const shadowTarget = document.createElement("span");
    shadow.append(shadowTarget);
    document.body.append(video, shadowHost);
    video.getBoundingClientRect = () => domRect(20, 30, 640, 360);
    const environment = anchorEnvironment({
      identifyMedia: (element) =>
        element === video ? { provider: "YOUTUBE", mediaKey: "youtube:dQw4w9WgXcQ" } : null,
      resolveMedia: (provider, mediaKey) =>
        provider === "YOUTUBE" && mediaKey === "youtube:dQw4w9WgXcQ" ? video : null,
    });

    const anchor = captureAnnotationAnchor(environment, video);

    expect(anchor).toEqual({
      type: "media",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
    });
    expect(requireLocated(environment, anchor).rectangle).toEqual({
      left: 20,
      top: 30,
      width: 640,
      height: 360,
    });
    expect(captureAnnotationAnchor(environment, shadowTarget)).toBeNull();

    const ordinaryVideo = document.createElement("video");
    ordinaryVideo.id = "private-video-id";
    ordinaryVideo.setAttribute("aria-label", "private video label");
    ordinaryVideo.getBoundingClientRect = () => domRect(40, 50, 320, 180);
    document.body.append(ordinaryVideo);
    const ordinaryAnchor = captureAnnotationAnchor(anchorEnvironment(), ordinaryVideo);
    expect(ordinaryAnchor).toMatchObject({ type: "media", provider: "HTML5" });
    expect(JSON.stringify(ordinaryAnchor)).not.toMatch(/private-video-id|private video label/u);
    expect(
      resolveAnnotationAnchor(anchorEnvironment(), {
        anchor: ordinaryAnchor!,
        frameKey,
      }),
    ).toMatchObject({ state: "LOCATED" });
  });

  it("reprojects document-root anchors and enforces aspect and per-axis layout tolerances", () => {
    const environment = anchorEnvironment();
    const anchor = captureAnnotationAnchor(environment, null);
    expect(anchor).toEqual({
      type: "document",
      layoutSignature: { widthCssPx: 1_200, heightCssPx: 2_400 },
    });
    const point: NormalizedPoint = { x: 0.5, y: 0.25, pressure: 0.4 };

    Object.defineProperty(window, "scrollX", { configurable: true, value: 100 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 300 });
    expect(projectAnnotationPoint(requireLocated(environment, anchor), point)).toEqual({
      x: 500,
      y: 300,
      pressure: 0.4,
    });

    setDimension(document.documentElement, "scrollWidth", 1_260);
    setDimension(document.documentElement, "scrollHeight", 2_520);
    setDimension(document.body, "scrollWidth", 1_260);
    setDimension(document.body, "scrollHeight", 2_520);
    expect(resolveAnnotationAnchor(environment, { anchor: anchor!, frameKey })).toMatchObject({
      state: "LOCATED",
    });

    setDimension(document.documentElement, "scrollWidth", 1_321);
    setDimension(document.body, "scrollWidth", 1_321);
    expect(resolveAnnotationAnchor(environment, { anchor: anchor!, frameKey })).toEqual({
      state: "UNLOCATABLE",
      reason: "LAYOUT_AXIS_DRIFT",
    });

    setDimension(document.documentElement, "scrollWidth", 1_200);
    setDimension(document.body, "scrollWidth", 1_200);
    setDimension(document.documentElement, "scrollHeight", 2_600);
    setDimension(document.body, "scrollHeight", 2_600);
    expect(resolveAnnotationAnchor(environment, { anchor: anchor!, frameKey })).toEqual({
      state: "UNLOCATABLE",
      reason: "LAYOUT_ASPECT_DRIFT",
    });
  });

  it("fails closed for wrong frames, missing and hidden targets, and invalid media resolution", () => {
    const visible = document.createElement("main");
    const hidden = document.createElement("aside");
    document.body.append(visible, hidden);
    visible.getBoundingClientRect = () => domRect(10, 20, 200, 100);
    hidden.getBoundingClientRect = () => domRect(10, 20, 0, 0);
    const environment = anchorEnvironment();
    const visibleAnchor = captureAnnotationAnchor(environment, visible);
    const hiddenAnchor = captureAnnotationAnchor(environment, hidden);

    expect(
      resolveAnnotationAnchor(environment, {
        anchor: visibleAnchor!,
        frameKey: "frame:sha256-00000000000000000000000000000000",
      }),
    ).toEqual({
      state: "UNLOCATABLE",
      reason: "WRONG_FRAME",
    });
    hidden.remove();
    expect(resolveAnnotationAnchor(environment, { anchor: hiddenAnchor!, frameKey })).toEqual({
      state: "UNLOCATABLE",
      reason: "TARGET_MISSING",
    });
    visible.remove();
    expect(resolveAnnotationAnchor(environment, { anchor: visibleAnchor!, frameKey })).toEqual({
      state: "UNLOCATABLE",
      reason: "TARGET_MISSING",
    });
    const mediaAnchor: AnnotationAnchor = {
      type: "media",
      provider: "BILIBILI",
      mediaKey: "bilibili:av170001",
    };
    expect(resolveAnnotationAnchor(environment, { anchor: mediaAnchor, frameKey })).toEqual({
      state: "UNLOCATABLE",
      reason: "MEDIA_NOT_FOUND",
    });
  });
});

function anchorEnvironment(
  overrides: Partial<AnnotationAnchorEnvironment> = {},
): AnnotationAnchorEnvironment {
  return {
    document,
    window,
    frameKey,
    ...overrides,
  };
}

function requireLocated(environment: AnnotationAnchorEnvironment, anchor: AnnotationAnchor | null) {
  if (anchor === null) {
    throw new Error("EXPECTED_ANCHOR");
  }
  const resolution = resolveAnnotationAnchor(environment, { anchor, frameKey });
  if (resolution.state !== "LOCATED") {
    throw new Error(`EXPECTED_LOCATED:${resolution.reason}`);
  }
  return resolution;
}

function setDimension(target: Element, property: string, value: number): void {
  Object.defineProperty(target, property, { configurable: true, value });
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
