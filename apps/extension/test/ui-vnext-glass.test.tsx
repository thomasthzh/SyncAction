// @vitest-environment happy-dom

import { act } from "preact/test-utils";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassMaterial } from "../src/ui-vnext/components/glass-material.js";
import { createGlassRefractionMap } from "../src/ui-vnext/glass-refraction.js";
import { renderPanel, unmountPanel } from "./ui-vnext-test-harness.js";

describe("glass refraction map", () => {
  const width = 96;
  const height = 64;
  const map = createGlassRefractionMap(width, height, 16);
  const pixel = (x: number, y: number): number[] => [
    ...map.slice((y * width + x) * 4, (y * width + x + 1) * 4),
  ];

  it.each([
    [420, 800, 22, "8e064f91f4276578e108d80a50902d77912f63b6f16ae46d6283674fe4ff099b"],
    [95, 47, 23.5, "6f36d04c18bd94442f11cd616e8368572ebb9436f3122b62d7eb79f74767549c"],
    [10, 11, 0, "7a7c361adbcac0bbd8a0ef53fb5c76817c08cd942563a0d7a55dda752b7ff97f"],
  ] as const)("preserves the original optical map at %i × %i, radius %i", (w, h, r, hash) => {
    expect(
      createHash("sha256")
        .update(createGlassRefractionMap(w, h, r))
        .digest("hex"),
    ).toBe(hash);
  });

  it("keeps the center and pixels outside rounded corners neutral and opaque", () => {
    expect(map).toHaveLength(width * height * 4);
    expect(pixel(48, 32)).toEqual([128, 128, 128, 255]);
    expect(pixel(0, 0)).toEqual([128, 128, 128, 255]);
    for (let index = 0; index < map.length; index += 4) {
      expect(map[index + 2]).toBe(128);
      expect(map[index + 3]).toBe(255);
    }
  });

  it("bends the opposing straight rims outward with symmetric displacement", () => {
    const left = pixel(5, 32);
    const right = pixel(90, 32);
    const top = pixel(48, 5);
    const bottom = pixel(48, 58);
    expect(left[0]).toBeLessThan(128);
    expect(right[0]).toBeGreaterThan(128);
    expect(left[0]! + right[0]!).toBe(256);
    expect([left[1], right[1]]).toEqual([128, 128]);
    expect(top[1]).toBeLessThan(128);
    expect(bottom[1]).toBeGreaterThan(128);
    expect(top[1]! + bottom[1]!).toBe(256);
    expect([top[0], bottom[0]]).toEqual([128, 128]);
  });

  it("bends both channels diagonally around the rounded corners", () => {
    const topLeft = pixel(8, 8);
    const topRight = pixel(87, 8);
    const bottomLeft = pixel(8, 55);
    const bottomRight = pixel(87, 55);
    expect(topLeft[0]).toBeLessThan(128);
    expect(topLeft[1]).toBe(topLeft[0]);
    expect(topRight).toEqual([256 - topLeft[0]!, topLeft[1], 128, 255]);
    expect(bottomLeft).toEqual([topLeft[0], 256 - topLeft[1]!, 128, 255]);
    expect(bottomRight).toEqual([256 - topLeft[0]!, 256 - topLeft[1]!, 128, 255]);
  });
});

describe("GlassMaterial lifecycle", () => {
  let width: number;
  let height: number;
  let preference: EventTarget & { matches: boolean };
  let observers: MockResizeObserver[];
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const createImageData = vi.fn((w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4),
  }));
  const putImageData = vi.fn();

  class MockResizeObserver {
    public readonly observe = vi.fn();
    public readonly disconnect = vi.fn();

    public constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }

    public resize(): void {
      this.callback([], this as unknown as ResizeObserver);
    }
  }

  function flushFrames(): void {
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    });
  }

  function setReducedTransparency(matches: boolean): void {
    act(() => {
      preference.matches = matches;
      preference.dispatchEvent(new Event("change"));
    });
  }

  beforeEach(() => {
    width = 96;
    height = 64;
    observers = [];
    frames = new Map();
    nextFrame = 0;
    preference = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => preference),
    );
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => frames.delete(id)),
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData,
      putImageData,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,map");
  });

  afterEach(() => {
    unmountPanel();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("waits for both dimensions before generating and attaching a map", () => {
    width = 0;
    const root = renderPanel(<GlassMaterial />);
    const surface = root.querySelector<HTMLElement>(".glass-material")!;
    expect(createImageData).not.toHaveBeenCalled();
    expect(surface.dataset.refracting).toBeUndefined();
    expect(observers[0]!.observe).toHaveBeenCalledWith(surface);

    width = 96;
    height = 0;
    observers[0]!.resize();
    flushFrames();
    expect(createImageData).not.toHaveBeenCalled();

    height = 64;
    surface.style.borderTopLeftRadius = "16px";
    observers[0]!.resize();
    flushFrames();
    expect(createImageData).toHaveBeenCalledExactlyOnceWith(96, 64);
    expect(putImageData).toHaveBeenCalledExactlyOnceWith(
      { data: createGlassRefractionMap(96, 64, 16) },
      0,
      0,
    );
    expect(root.querySelector("feImage")?.getAttribute("href")).toBe("data:image/png;base64,map");
    expect(root.querySelector("feImage")?.getAttribute("width")).toBe("96");
    expect(root.querySelector("feImage")?.getAttribute("height")).toBe("64");
    expect(root.querySelector("filter")?.getAttribute("color-interpolation-filters")).toBe("sRGB");
    expect(surface.dataset.refracting).toBe("true");
    expect(surface.getAttribute("aria-hidden")).toBe("true");
  });

  it("skips unchanged sizes and coalesces repeated resize notifications", () => {
    renderPanel(<GlassMaterial />);
    observers[0]!.resize();
    flushFrames();
    expect(createImageData).toHaveBeenCalledTimes(1);

    width = 120;
    observers[0]!.resize();
    observers[0]!.resize();
    expect(frames.size).toBe(1);
    flushFrames();
    expect(createImageData).toHaveBeenCalledTimes(2);
    expect(createImageData).toHaveBeenLastCalledWith(120, 64);
  });

  it("disconnects its observer, pending frame and preference listener on unmount", () => {
    const removeListener = vi.spyOn(preference, "removeEventListener");
    renderPanel(<GlassMaterial />);
    width = 120;
    observers[0]!.resize();
    const pendingFrame = nextFrame;
    unmountPanel();

    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingFrame);
    expect(frames.size).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("change", expect.any(Function));
    setReducedTransparency(true);
    setReducedTransparency(false);
    expect(observers).toHaveLength(1);
    expect(createImageData).toHaveBeenCalledTimes(1);
  });

  it("disables refraction while reduced transparency is requested and resumes on change", () => {
    preference.matches = true;
    const root = renderPanel(<GlassMaterial />);
    const surface = root.querySelector<HTMLElement>(".glass-material")!;
    expect(matchMedia).toHaveBeenCalledWith(
      "(prefers-reduced-transparency: reduce), (forced-colors: active)",
    );
    expect(createImageData).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);

    setReducedTransparency(false);
    expect(surface.dataset.refracting).toBe("true");
    expect(createImageData).toHaveBeenCalledTimes(1);
    observers[0]!.resize();
    setReducedTransparency(true);
    expect(surface.dataset.refracting).toBeUndefined();
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);

    setReducedTransparency(false);
    expect(surface.dataset.refracting).toBe("true");
    expect(createImageData).toHaveBeenCalledTimes(2);
    expect(observers).toHaveLength(2);
  });
});
