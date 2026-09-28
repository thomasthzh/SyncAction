// @vitest-environment happy-dom

import type { MediaTarget } from "@syncaction/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverMediaAdapter, type MediaDiscoveryResult } from "../src/media-adapters/registry.js";
import type { MediaApplyCommand, MediaDiscoveryContext } from "../src/media-adapters/types.js";

const context: MediaDiscoveryContext = {
  logicalTabId: "018f8f8e-4b5c-4d6e-8f90-123456789a02",
  documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 4 },
  frameKey: "top",
  pageUrl: "https://example.com/watch",
};
const applyToken = "00000000-0000-4000-8000-000000000003";
const fixedNow = 1_700_000_000_000;

beforeEach(() => {
  document.body.replaceChildren();
});

describe("public HTML media adapters", () => {
  it("discovers, observes, controls, and subscribes to a visible HTML5 video", async () => {
    const video = document.createElement("video");
    const state = installMediaState(video, {
      duration: 212,
      currentTime: 42,
      paused: false,
      playbackRate: 1,
      readyState: 4,
    });
    video.getBoundingClientRect = () => domRect(40, 80, 960, 540);
    document.body.append(video);

    const result = discover({ context, now: () => fixedNow });
    expect(result.code).toBeNull();
    const adapter = requireAdapter(result);
    expect(adapter.target).toMatchObject({
      logicalTabId: context.logicalTabId,
      documentRevision: context.documentRevision,
      frameKey: "top",
      provider: "HTML5",
      durationMs: 212_000,
    });
    expect(adapter.target.mediaKey).toMatch(/^html5:[a-z0-9]+$/u);
    expect(JSON.stringify(adapter.target)).not.toContain("https://example.com");
    expect(adapter.read()).toEqual({
      observedAtClientMs: fixedNow,
      positionMs: 42_000,
      paused: false,
      playbackRate: 1,
      ended: false,
      buffering: false,
    });

    const events: unknown[] = [];
    const unsubscribe = adapter.subscribe((event) => events.push(event));
    video.dispatchEvent(new Event("seeked"));
    video.dispatchEvent(new Event("ratechange"));
    expect(events).toEqual([{ type: "SEEKED" }, { type: "RATE_CHANGED" }]);
    unsubscribe();
    video.dispatchEvent(new Event("ended"));
    expect(events).toHaveLength(2);

    await expect(
      adapter.apply(command({ type: "SEEK", positionMs: 84_000 })),
    ).resolves.toMatchObject({ applied: true, code: null });
    await adapter.apply(command({ type: "SET_RATE", playbackRate: 1.25 }));
    await adapter.apply(command({ type: "PAUSE" }));
    await adapter.apply(command({ type: "PLAY" }));
    expect(state.currentTime).toBe(84);
    expect(state.playbackRate).toBe(1.25);
    expect(state.play).toHaveBeenCalledOnce();
    expect(state.pause).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "YouTube",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=40",
      "YOUTUBE",
      "youtube:dQw4w9WgXcQ",
    ],
    [
      "Bilibili",
      "https://www.bilibili.com/video/BV17x411w7KC?p=2",
      "BILIBILI",
      "bilibili:av170001",
    ],
  ])(
    "fully controls and observes %s through public media APIs",
    async (_, pageUrl, provider, mediaKey) => {
      const video = document.createElement("video");
      const state = installMediaState(video, {
        duration: 100,
        currentTime: 10,
        paused: false,
        playbackRate: 1,
      });
      video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
      document.body.append(video);

      const adapter = requireAdapter(
        discover({
          context: {
            ...context,
            pageUrl,
            frameKey: "frame:document-1",
          },
          now: () => fixedNow,
        }),
      );

      expect(adapter.target).toMatchObject({
        provider,
        mediaKey,
        frameKey: "frame:document-1",
      });
      expect(adapter.read()).toEqual({
        observedAtClientMs: fixedNow,
        positionMs: 10_000,
        paused: false,
        playbackRate: 1,
        ended: false,
        buffering: false,
      });

      const events: unknown[] = [];
      const unsubscribe = adapter.subscribe((event) => events.push(event));
      video.dispatchEvent(new Event("seeked"));
      video.dispatchEvent(new Event("ratechange"));
      expect(events).toEqual([{ type: "SEEKED" }, { type: "RATE_CHANGED" }]);

      await adapter.apply(command({ type: "SEEK", positionMs: 25_000 }));
      await adapter.apply(command({ type: "SET_RATE", playbackRate: 1.5 }));
      await adapter.apply(command({ type: "PAUSE" }));
      await adapter.apply(command({ type: "PLAY" }));
      expect(state.currentTime).toBe(25);
      expect(state.playbackRate).toBe(1.5);
      expect(state.pause).toHaveBeenCalledOnce();
      expect(state.play).toHaveBeenCalledOnce();

      unsubscribe();
      video.dispatchEvent(new Event("ended"));
      expect(events).toHaveLength(2);
    },
  );

  it("keeps a generic media key stable across unrelated same-tag sibling insertion and reorder", () => {
    const region = document.createElement("section");
    region.id = "private-course-player";
    region.setAttribute("aria-label", "Private Course Lesson 42");
    const video = document.createElement("video");
    video.id = "lesson-video";
    video.setAttribute("data-player-id", "private-player-42");
    video.src = "https://private.example/media/lesson-42.mp4?token=secret";
    installMediaState(video, { duration: 100, paused: false });
    video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    region.append(video);
    document.body.append(region);

    const initialTarget = requireAdapter(discover({ now: () => fixedNow })).target;
    const sibling = document.createElement("video");
    sibling.src = "https://private.example/media/unrelated.mp4";
    installMediaState(sibling, { duration: 200, paused: true });
    sibling.getBoundingClientRect = () => domRect(0, 0, 320, 180);
    region.prepend(sibling);
    const afterInsertion = requireAdapter(discover({ now: () => fixedNow })).target;
    region.append(sibling);
    const afterReorder = requireAdapter(discover({ now: () => fixedNow })).target;

    expect(afterInsertion.mediaKey).toBe(initialTarget.mediaKey);
    expect(afterReorder.mediaKey).toBe(initialTarget.mediaKey);
    expect(JSON.stringify([initialTarget, afterInsertion, afterReorder])).not.toMatch(
      /private-course|lesson-video|private-player|private\.example|token=secret/iu,
    );
  });

  it("binds an ordinary same-origin frame without traversing another document", () => {
    const video = document.createElement("video");
    installMediaState(video, { duration: 100 });
    video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    document.body.append(video);

    expect(
      requireAdapter(
        discover({
          context: {
            ...context,
            frameKey: "frame:same-origin-document",
          },
          now: () => fixedNow,
        }),
      ).target.frameKey,
    ).toBe("frame:same-origin-document");
  });

  it("prefers a playing candidate, then the largest visible candidate", () => {
    const smallPlaying = document.createElement("video");
    installMediaState(smallPlaying, { duration: 100, currentTime: 5, paused: false });
    smallPlaying.getBoundingClientRect = () => domRect(0, 0, 320, 180);
    const largePaused = document.createElement("video");
    installMediaState(largePaused, { duration: 200, currentTime: 20, paused: true });
    largePaused.getBoundingClientRect = () => domRect(0, 0, 1280, 720);
    document.body.append(smallPlaying, largePaused);

    expect(requireAdapter(discover()).target.durationMs).toBe(100_000);
    smallPlaying.remove();
    expect(requireAdapter(discover()).target.durationMs).toBe(200_000);
  });

  it("selects an exact visible candidate without changing default ranking", () => {
    const primary = document.createElement("video");
    primary.id = "primary-player";
    installMediaState(primary, { duration: 100, currentTime: 5, paused: false });
    primary.getBoundingClientRect = () => domRect(0, 0, 320, 180);
    const secondary = document.createElement("video");
    secondary.id = "secondary-player";
    installMediaState(secondary, { duration: 200, currentTime: 20, paused: true });
    secondary.getBoundingClientRect = () => domRect(0, 0, 1280, 720);
    document.body.append(primary, secondary);

    primary.hidden = true;
    const secondaryTarget = requireAdapter(discover()).target;
    primary.hidden = false;

    expect(requireAdapter(discover()).target.durationMs).toBe(100_000);
    expect(requireAdapter(discover({ target: secondaryTarget })).target).toEqual(secondaryTarget);
    expect(
      discover({
        target: {
          ...secondaryTarget,
          mediaKey: `${secondaryTarget.mediaKey}-missing`,
        },
      }),
    ).toEqual({ adapter: null, code: "MEDIA_NOT_FOUND" });
  });

  it("degrades live and encrypted media instead of exposing an unsafe adapter", () => {
    const live = document.createElement("video");
    installMediaState(live, { duration: Number.POSITIVE_INFINITY, readyState: 0 });
    live.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    document.body.append(live);
    expect(discover()).toEqual({ adapter: null, code: "MEDIA_LIVE_UNSUPPORTED" });

    live.remove();
    const encrypted = document.createElement("video");
    installMediaState(encrypted, { duration: 100, mediaKeys: {} });
    encrypted.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    document.body.append(encrypted);
    expect(discover()).toEqual({ adapter: null, code: "MEDIA_DRM_UNSUPPORTED" });
  });

  it("keeps ordinary media pending until finite duration metadata becomes available", () => {
    const video = document.createElement("video");
    const metadata = { duration: Number.NaN, readyState: 0 };
    installMediaState(video, metadata);
    video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    document.body.append(video);

    expect(discover()).toEqual({ adapter: null, code: "MEDIA_METADATA_PENDING" });

    metadata.duration = 100;
    metadata.readyState = 1;
    expect(requireAdapter(discover()).target.durationMs).toBe(100_000);
  });

  it("marks an encrypted event as DRM and removes its listener on unsubscribe", () => {
    const video = document.createElement("video");
    installMediaState(video, { duration: 100 });
    video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = requireAdapter(discover({ now: () => fixedNow }));
    const events: unknown[] = [];
    const unsubscribe = adapter.subscribe((event) => events.push(event));

    video.dispatchEvent(new Event("encrypted"));
    expect(events).toEqual([{ type: "UNSUPPORTED", code: "MEDIA_DRM_UNSUPPORTED" }]);
    expect(discover()).toEqual({ adapter: null, code: "MEDIA_DRM_UNSUPPORTED" });

    unsubscribe();
    video.dispatchEvent(new Event("encrypted"));
    expect(events).toHaveLength(1);
  });

  it.each([
    ["NotAllowedError", "AUTOPLAY_BLOCKED"],
    ["NotSupportedError", "MEDIA_NOT_SUPPORTED"],
    ["AbortError", "MEDIA_PLAY_ABORTED"],
  ])("maps %s play rejection to %s", async (errorName, resultCode) => {
    const video = document.createElement("video");
    installMediaState(video, {
      duration: 100,
      playError: new DOMException("bounded failure", errorName),
    });
    video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
    document.body.append(video);
    const adapter = requireAdapter(discover({ now: () => fixedNow }));
    const capturedObservation = adapter.read();

    await expect(adapter.apply(command({ type: "PLAY" }))).resolves.toEqual({
      applied: false,
      code: resultCode,
      observed: capturedObservation,
    });
  });

  it("returns bounded missing and unauthorized-frame discovery results", () => {
    expect(discover()).toEqual({ adapter: null, code: "MEDIA_NOT_FOUND" });

    const unauthorizedDocument = {
      querySelectorAll: () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Document;
    expect(
      discoverMediaAdapter({
        document: unauthorizedDocument,
        window,
        context,
        now: () => fixedNow,
      }),
    ).toEqual({ adapter: null, code: "MEDIA_FRAME_UNAUTHORIZED" });
  });
});

function discover(
  overrides: {
    context?: MediaDiscoveryContext;
    now?: () => number;
    target?: MediaTarget;
  } = {},
): MediaDiscoveryResult {
  return discoverMediaAdapter({
    document,
    window,
    context: overrides.context ?? context,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.target === undefined ? {} : { target: overrides.target }),
  });
}

function requireAdapter(result: MediaDiscoveryResult) {
  if (result.adapter === null) {
    throw new Error(result.code);
  }
  return result.adapter;
}

function command(action: MediaApplyCommand["action"]): MediaApplyCommand {
  return { applyToken, action };
}

function installMediaState(
  media: HTMLMediaElement,
  initial: {
    duration?: number;
    currentTime?: number;
    paused?: boolean;
    playbackRate?: number;
    readyState?: number;
    ended?: boolean;
    mediaKeys?: object | null;
    playError?: Error;
  },
) {
  let currentTime = initial.currentTime ?? 0;
  let paused = initial.paused ?? true;
  let playbackRate = initial.playbackRate ?? 1;
  const play = vi.fn(async () => {
    if (initial.playError !== undefined) {
      throw initial.playError;
    }
    paused = false;
  });
  const pause = vi.fn(() => {
    paused = true;
  });
  Object.defineProperties(media, {
    duration: { configurable: true, get: () => initial.duration ?? 60 },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    },
    paused: { configurable: true, get: () => paused },
    playbackRate: {
      configurable: true,
      get: () => playbackRate,
      set: (value: number) => {
        playbackRate = value;
      },
    },
    readyState: { configurable: true, get: () => initial.readyState ?? 4 },
    ended: { configurable: true, get: () => initial.ended ?? false },
    mediaKeys: { configurable: true, get: () => initial.mediaKeys ?? null },
    play: { configurable: true, value: play },
    pause: { configurable: true, value: pause },
  });
  return {
    get currentTime() {
      return currentTime;
    },
    get playbackRate() {
      return playbackRate;
    },
    play,
    pause,
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
