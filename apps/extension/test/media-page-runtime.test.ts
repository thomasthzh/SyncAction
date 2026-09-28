// @vitest-environment happy-dom

import { MediaTargetSchema } from "@syncaction/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mediaRegistry from "../src/media-adapters/registry.js";
import type { MediaAdapter } from "../src/media-adapters/types.js";
import {
  MediaCommandMessageSchema,
  MediaObservedMessageSchema,
  type MediaObservedMessage,
} from "../src/page-collaboration/messages.js";
import { MediaPageRuntime } from "../src/page-collaboration/media-page-runtime.js";

const context = {
  roomId: "018f8f8e-4b5c-4d6e-8f90-123456789a01",
  logicalTabId: "018f8f8e-4b5c-4d6e-8f90-123456789a02",
  documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 4 },
  frameKey: "top" as const,
};
const applyToken = "00000000-0000-4000-8000-000000000003";
const secondApplyToken = "00000000-0000-4000-8000-000000000004";
const fixedNow = 1_700_000_000_000;
const target = {
  logicalTabId: context.logicalTabId,
  documentRevision: context.documentRevision,
  frameKey: context.frameKey,
  provider: "YOUTUBE" as const,
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 100_000,
};
const observed = {
  observedAtClientMs: fixedNow,
  positionMs: 10_000,
  paused: true,
  playbackRate: 1,
  ended: false,
  buffering: false,
};

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("media page message contract", () => {
  it("binds APPLY commands to the exact context, target, and target duration", () => {
    const observe = {
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    };
    expect(MediaCommandMessageSchema.parse(observe)).toEqual(observe);
    const targetedObserve = {
      ...observe,
      operation: { type: "OBSERVE", target },
    };
    expect(MediaCommandMessageSchema.parse(targetedObserve)).toEqual(targetedObserve);
    expect(
      MediaCommandMessageSchema.safeParse({
        ...targetedObserve,
        operation: {
          ...targetedObserve.operation,
          target: {
            ...target,
            documentRevision: { ...target.documentRevision, tabUpdatedAtSeq: 5 },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      MediaCommandMessageSchema.safeParse({
        ...observe,
        pageUrl: "https://private.example/watch",
      }).success,
    ).toBe(false);

    const lock = {
      type: "syncaction.media.command",
      context,
      operation: { type: "SET_FOLLOWER_LOCK", locked: true, target },
    };
    expect(MediaCommandMessageSchema.parse(lock)).toEqual(lock);
    expect(
      MediaCommandMessageSchema.safeParse({
        ...lock,
        operation: { type: "SET_FOLLOWER_LOCK", locked: true },
      }).success,
    ).toBe(false);
    expect(
      MediaCommandMessageSchema.safeParse({
        ...lock,
        operation: { ...lock.operation, rawUrl: "https://private.example" },
      }).success,
    ).toBe(false);

    const apply = {
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target,
        action: { type: "SEEK", positionMs: target.durationMs },
      },
    };
    expect(MediaCommandMessageSchema.parse(apply)).toEqual(apply);
    for (const invalid of [
      {
        ...apply,
        operation: {
          ...apply.operation,
          target: {
            ...target,
            logicalTabId: "018f8f8e-4b5c-4d6e-8f90-123456789aff",
          },
        },
      },
      {
        ...apply,
        operation: {
          ...apply.operation,
          target: {
            ...target,
            documentRevision: { ...target.documentRevision, tabUpdatedAtSeq: 5 },
          },
        },
      },
      {
        ...apply,
        operation: {
          ...apply.operation,
          target: { ...target, frameKey: "frame:other-document" },
        },
      },
      {
        ...apply,
        operation: {
          ...apply.operation,
          action: { type: "SEEK", positionMs: target.durationMs + 1 },
        },
      },
    ]) {
      expect(MediaCommandMessageSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("uses strict event variants with exact context and bounded result semantics", () => {
    const discovered = {
      type: "syncaction.media.observed",
      event: "DISCOVERED",
      context,
      target,
      observed,
      applyToken: null,
      resultCode: null,
    };
    expect(MediaObservedMessageSchema.parse(discovered)).toEqual(discovered);
    const visibilityChanged = {
      ...discovered,
      event: "VISIBILITY_CHANGED",
      visibilityState: "hidden",
    };
    expect(MediaObservedMessageSchema.parse(visibilityChanged)).toEqual(visibilityChanged);

    const unsupported = {
      type: "syncaction.media.observed",
      event: "UNSUPPORTED",
      context,
      target: null,
      observed: null,
      applyToken: null,
      resultCode: "MEDIA_NOT_FOUND",
    };
    expect(MediaObservedMessageSchema.parse(unsupported)).toEqual(unsupported);
    expect(
      MediaObservedMessageSchema.safeParse({ ...unsupported, pageTitle: "private" }).success,
    ).toBe(false);
    for (const invalid of [
      { ...discovered, context: { ...context, frameKey: "frame:other-document" } },
      { ...discovered, applyToken },
      {
        ...discovered,
        event: "TARGET_CHANGED",
        target: null,
        observed: null,
        resultCode: "MEDIA_NOT_FOUND",
      },
      {
        ...unsupported,
        resultCode: "AUTOPLAY_BLOCKED",
      },
      {
        ...discovered,
        event: "APPLY_RESULT",
        target: null,
        observed: null,
        applyToken,
      },
      {
        ...discovered,
        event: "APPLY_RESULT",
        applyToken: null,
        resultCode: "AUTOPLAY_BLOCKED",
      },
      {
        ...discovered,
        observed: { ...observed, positionMs: target.durationMs + 1 },
      },
    ]) {
      expect(MediaObservedMessageSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      MediaObservedMessageSchema.safeParse({
        ...discovered,
        event: "STATE_CHANGED",
        applyToken,
        trigger: "SEEKED",
      }).success,
    ).toBe(true);
    expect(
      MediaObservedMessageSchema.safeParse({
        ...discovered,
        event: "STATE_CHANGED",
        trigger: "TIMEUPDATE",
      }).success,
    ).toBe(false);
    expect(
      MediaObservedMessageSchema.safeParse({
        ...discovered,
        event: "APPLY_RESULT",
        applyToken,
        resultCode: "AUTOPLAY_BLOCKED",
      }).success,
    ).toBe(true);
    expect(
      MediaObservedMessageSchema.safeParse({
        ...discovered,
        event: "APPLY_RESULT",
        target: null,
        observed: null,
        applyToken,
        resultCode: "TARGET_MISMATCH",
      }).success,
    ).toBe(true);

    const applyFailures = [
      "AUTOPLAY_BLOCKED",
      "MEDIA_NOT_SUPPORTED",
      "MEDIA_PLAY_ABORTED",
      "MEDIA_APPLY_FAILED",
      "MEDIA_NOT_FOUND",
      "MEDIA_DRM_UNSUPPORTED",
    ] as const;
    for (const resultCode of applyFailures) {
      expect(
        MediaObservedMessageSchema.safeParse({
          ...discovered,
          event: "APPLY_RESULT",
          target: null,
          observed: null,
          applyToken,
          resultCode,
        }).success,
      ).toBe(false);
      expect(
        MediaObservedMessageSchema.safeParse({
          ...discovered,
          event: "APPLY_RESULT",
          applyToken,
          resultCode,
        }).success,
      ).toBe(true);
    }

    expect(
      MediaObservedMessageSchema.safeParse({
        ...unsupported,
        resultCode: "MEDIA_METADATA_PENDING",
      }).success,
    ).toBe(true);
  });
});

describe("MediaPageRuntime", () => {
  it("reports page visibility transitions for the currently observed media route", () => {
    const surface = document.createElement("section");
    const video = createVideo(100, 10);
    document.body.append(video, surface);
    const emitted: MediaObservedMessage[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface,
      now: () => fixedNow,
      readPageUrl: () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      emitObserved: (message) => emitted.push(message),
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const beforeVisibilityChange = emitted.length;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(emitted).toHaveLength(beforeVisibilityChange + 1);
    expect(emitted.at(-1)).toMatchObject({
      event: "VISIBILITY_CHANGED",
      context,
      target,
      visibilityState: "hidden",
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(emitted.at(-1)).toMatchObject({
      event: "VISIBILITY_CHANGED",
      visibilityState: "visible",
    });

    runtime.dispose();
    const afterDispose = emitted.length;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(emitted).toHaveLength(afterDispose);
  });

  it("intercepts common mouse and keyboard media gestures only while follower-locked", () => {
    const surface = document.createElement("section");
    const video = createVideo(100, 10);
    const videoClick = vi.fn();
    video.addEventListener("click", videoClick);
    document.body.append(video, surface);
    const emitted: MediaObservedMessage[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface,
      now: () => fixedNow,
      readPageUrl: () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      emitObserved: (message) => emitted.push(message),
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "SET_FOLLOWER_LOCK", locked: true, target },
    });
    expect(surface.dataset.followerLock).toBe("true");
    const interceptor = surface.querySelector<HTMLElement>(
      "[data-syncaction-follower-interceptor]",
    );
    expect(interceptor).not.toBeNull();
    expect(interceptor?.style.pointerEvents).toBe("auto");
    expect(interceptor?.style.width).toBe("640px");
    expect(Number.parseFloat(interceptor?.style.height ?? "0")).toBeLessThan(360);

    const countBeforeUnfocusedKey = emitted.length;
    expect(
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(true);
    expect(emitted).toHaveLength(countBeforeUnfocusedKey);

    const downstreamPointer = vi.fn();
    interceptor?.addEventListener("pointerdown", downstreamPointer);
    expect(
      interceptor?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
      ),
    ).toBe(false);
    expect(downstreamPointer).not.toHaveBeenCalled();
    expect(
      interceptor?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true })),
    ).toBe(true);

    const input = document.createElement("input");
    document.body.append(input);
    const countBeforeEditableKey = emitted.length;
    expect(
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(true);
    expect(emitted).toHaveLength(countBeforeEditableKey);

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    expect(interceptor?.dispatchEvent(click)).toBe(false);
    expect(videoClick).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({
      event: "STATE_CHANGED",
      target,
      observed: { paused: false },
      applyToken: null,
    });

    for (const key of [" ", "k", "MediaPlayPause"]) {
      const before = emitted.length;
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      expect(document.dispatchEvent(event)).toBe(false);
      expect(emitted).toHaveLength(before + 1);
      expect(emitted.at(-1)).toMatchObject({
        event: "STATE_CHANGED",
        observed: { paused: false },
      });
    }

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "SET_FOLLOWER_LOCK", locked: false, target },
    });
    expect(surface.dataset.followerLock).toBe("false");
    expect(surface.querySelector("[data-syncaction-follower-interceptor]")).toBeNull();
    const countAfterUnlock = emitted.length;
    expect(
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(true);
    expect(emitted).toHaveLength(countAfterUnlock);

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "SET_FOLLOWER_LOCK", locked: true, target },
    });
    runtime.handle({
      type: "syncaction.media.command",
      context: {
        ...context,
        documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 5 },
      },
      operation: { type: "OBSERVE" },
    });
    expect(surface.dataset.followerLock).toBe("false");
    expect(surface.querySelector("[data-syncaction-follower-interceptor]")).toBeNull();

    runtime.dispose();
    expect(surface.dataset.followerLock).toBe("false");
  });

  it("leaves native controls below the follower play-surface lock and observes seek/rate input", () => {
    const surface = document.createElement("section");
    const video = createVideo(100, 10);
    document.body.append(video, surface);
    const emitted: MediaObservedMessage[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface,
      now: () => fixedNow,
      readPageUrl: () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      emitObserved: (message) => emitted.push(message),
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "SET_FOLLOWER_LOCK",
        locked: true,
        target: discoveredTarget,
      },
    });

    const interceptor = surface.querySelector<HTMLElement>(
      "[data-syncaction-follower-interceptor]",
    );
    const interceptedHeight = Number.parseFloat(interceptor?.style.height ?? "0");
    expect(interceptedHeight).toBeGreaterThan(0);
    expect(360 - interceptedHeight).toBeGreaterThanOrEqual(48);

    video.currentTime = 25.25;
    video.dispatchEvent(new Event("seeked"));
    expect(emitted.at(-1)).toMatchObject({
      event: "STATE_CHANGED",
      trigger: "SEEKED",
      target: discoveredTarget,
      observed: {
        positionMs: 25_250,
        playbackRate: 1,
      },
      applyToken: null,
    });

    video.playbackRate = 1.25;
    video.dispatchEvent(new Event("ratechange"));
    expect(emitted.at(-1)).toMatchObject({
      event: "STATE_CHANGED",
      trigger: "RATE_CHANGED",
      target: discoveredTarget,
      observed: {
        positionMs: 25_250,
        playbackRate: 1.25,
      },
      applyToken: null,
    });

    runtime.dispose();
  });

  it("clears a target-bound follower lock when rediscovery selects another media", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const surface = document.createElement("section");
    const firstMedia = createVideo(100, 10);
    const secondMedia = createVideo(100, 20);
    document.body.append(firstMedia, secondMedia, surface);
    const firstTarget = MediaTargetSchema.parse(target);
    const secondTarget = MediaTargetSchema.parse({
      ...target,
      mediaKey: "youtube:9bZkp7q19f0",
    });
    const makeAdapter = (
      adapterTarget: typeof firstTarget,
      media: HTMLMediaElement,
    ): MediaAdapter => ({
      target: adapterTarget,
      getMediaElement: () => media,
      isUsable: () => true,
      read: () => observed,
      apply: async () => ({ applied: true, code: null, observed }),
      subscribe: () => () => undefined,
    });
    vi.spyOn(mediaRegistry, "discoverMediaAdapter")
      .mockReturnValueOnce({
        adapter: makeAdapter(firstTarget, firstMedia),
        code: null,
      })
      .mockReturnValue({
        adapter: makeAdapter(secondTarget, secondMedia),
        code: null,
      });
    const emitted: MediaObservedMessage[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface,
      now: () => fixedNow,
      readPageUrl: () => "https://example.com/watch",
      emitObserved: (message) => emitted.push(message),
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "SET_FOLLOWER_LOCK",
        locked: true,
        target: firstTarget,
      },
    });
    expect(surface.dataset.followerLock).toBe("true");
    expect(surface.querySelector("[data-syncaction-follower-interceptor]")).not.toBeNull();

    firstMedia.append(document.createElement("source"));
    await flushMutations();
    await vi.advanceTimersByTimeAsync(300);

    expect(emitted.at(-1)).toMatchObject({
      event: "TARGET_CHANGED",
      target: secondTarget,
    });
    expect(surface.dataset.followerLock).toBe("false");
    expect(surface.querySelector("[data-syncaction-follower-interceptor]")).toBeNull();

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "SET_FOLLOWER_LOCK",
        locked: false,
        target: firstTarget,
      },
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "SET_FOLLOWER_LOCK",
        locked: true,
        target: secondTarget,
      },
    });
    expect(surface.dataset.followerLock).toBe("true");
    expect(surface.querySelector("[data-syncaction-follower-interceptor]")).not.toBeNull();
    runtime.dispose();
  });

  it("selects an exact second HTML5 target and reports a missing requested target", () => {
    const first = createVideo(100, 10);
    first.id = "primary-player";
    const second = createVideo(200, 20);
    second.id = "secondary-player";
    document.body.append(first, second);

    first.hidden = true;
    const secondDiscovery = mediaRegistry.discoverMediaAdapter({
      document,
      window,
      context: {
        logicalTabId: context.logicalTabId,
        documentRevision: context.documentRevision,
        frameKey: context.frameKey,
        pageUrl: "https://example.com/watch",
      },
      now: () => fixedNow,
    });
    if (secondDiscovery.adapter === null) {
      throw new Error("expected second media target");
    }
    const secondTarget = secondDiscovery.adapter.target;
    first.hidden = false;

    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    expect(emitted.at(-1)?.target?.mediaKey).not.toBe(secondTarget.mediaKey);

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE", target: secondTarget },
    });
    expect(emitted.at(-1)).toMatchObject({
      event: "TARGET_CHANGED",
      target: secondTarget,
      observed: { positionMs: 20_000 },
    });

    const afterSelection = emitted.length;
    first.dispatchEvent(new Event("seeked"));
    expect(emitted).toHaveLength(afterSelection);
    second.dispatchEvent(new Event("seeked"));
    expect(emitted.at(-1)).toMatchObject({
      event: "STATE_CHANGED",
      trigger: "SEEKED",
      target: secondTarget,
    });

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "OBSERVE",
        target: { ...secondTarget, mediaKey: `${secondTarget.mediaKey}-missing` },
      },
    });
    expect(emitted.at(-1)).toMatchObject({
      event: "UNSUPPORTED",
      target: null,
      observed: null,
      resultCode: "MEDIA_NOT_FOUND",
    });
    runtime.dispose();
  });

  it("restores a temporary follower rate locally on timeout and unlock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const surface = document.createElement("section");
    const video = createVideo(100, 10);
    document.body.append(video, surface);
    const emitted: MediaObservedMessage[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface,
      now: () => fixedNow,
      readPageUrl: () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      emitObserved: (message) => emitted.push(message),
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "SET_FOLLOWER_LOCK",
        locked: true,
        target: discoveredTarget,
      },
    });
    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discoveredTarget,
        action: {
          type: "SET_RATE_TEMPORARY",
          playbackRate: 1.05,
          restoreRate: 1,
          durationMs: 3_000,
        },
      },
    });
    expect(video.playbackRate).toBe(1.05);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(video.playbackRate).toBe(1.05);
    await vi.advanceTimersByTimeAsync(1);
    expect(video.playbackRate).toBe(1);

    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken: secondApplyToken,
        target: discoveredTarget,
        action: {
          type: "SET_RATE_TEMPORARY",
          playbackRate: 1.05,
          restoreRate: 1,
          durationMs: 3_000,
        },
      },
    });
    expect(video.playbackRate).toBe(1.05);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "SET_FOLLOWER_LOCK",
        locked: false,
        target: discoveredTarget,
      },
    });
    expect(video.playbackRate).toBe(1);
    runtime.dispose();
  });

  it("discovers a provider target and replaces it after SPA navigation and DOM replacement", async () => {
    let pageUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const first = createVideo(212, 42);
    document.body.append(first);
    const emitted: MediaObservedMessage[] = [];
    const capabilities: unknown[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface: document.createElement("section"),
      now: () => fixedNow,
      readPageUrl: () => pageUrl,
      emitObserved: (message) => emitted.push(message),
      emitCapability: (message) => capabilities.push(message),
    });

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    expect(emitted.at(-1)).toMatchObject({
      event: "DISCOVERED",
      context,
      target: {
        provider: "YOUTUBE",
        mediaKey: "youtube:dQw4w9WgXcQ",
        durationMs: 212_000,
      },
      resultCode: null,
    });
    expect(capabilities.at(-1)).toMatchObject({
      capability: "MEDIA",
      state: "AVAILABLE",
    });

    pageUrl = "https://www.bilibili.com/video/BV17x411w7KC";
    first.replaceWith(createVideo(100, 5));

    await vi.waitFor(() =>
      expect(emitted.at(-1)).toMatchObject({
        event: "TARGET_CHANGED",
        context,
        target: {
          provider: "BILIBILI",
          mediaKey: "bilibili:av170001",
        },
      }),
    );
    expect(JSON.stringify(emitted)).not.toMatch(/youtube\.com|bilibili\.com|pageTitle/iu);
    runtime.dispose();
  });

  it("reports autoplay rejection and refuses an apply for another target", async () => {
    const video = createVideo(100, 10, new DOMException("gesture required", "NotAllowedError"));
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface: document.createElement("section"),
      now: () => fixedNow,
      readPageUrl: () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      emitObserved: (message) => emitted.push(message),
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const target = emitted.at(-1)?.target;
    if (target === null || target === undefined) {
      throw new Error("expected discovered target");
    }

    const countBeforeInvalidBinding = emitted.length;
    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: {
          ...target,
          logicalTabId: "018f8f8e-4b5c-4d6e-8f90-123456789aff",
        },
        action: { type: "PAUSE" },
      },
    });
    expect(emitted).toHaveLength(countBeforeInvalidBinding);
    expect(video.pause).not.toHaveBeenCalled();

    const otherContext = {
      ...context,
      logicalTabId: "018f8f8e-4b5c-4d6e-8f90-123456789aff",
    };
    await runtime.handle({
      type: "syncaction.media.command",
      context: otherContext,
      operation: {
        type: "APPLY",
        applyToken,
        target: {
          ...target,
          logicalTabId: otherContext.logicalTabId,
        },
        action: { type: "PAUSE" },
      },
    });
    expect(emitted.at(-1)).toEqual({
      type: "syncaction.media.observed",
      event: "APPLY_RESULT",
      context: otherContext,
      target: null,
      observed: null,
      applyToken,
      resultCode: "TARGET_MISMATCH",
    });
    expect(video.pause).not.toHaveBeenCalled();

    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target,
        action: { type: "PLAY" },
      },
    });
    expect(emitted.at(-1)).toMatchObject({
      event: "APPLY_RESULT",
      context,
      target,
      applyToken,
      resultCode: "AUTOPLAY_BLOCKED",
    });

    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: {
          ...target,
          mediaKey: "youtube:9bZkp7q19f0",
        },
        action: { type: "PAUSE" },
      },
    });
    expect(emitted.at(-1)).toMatchObject({
      event: "APPLY_RESULT",
      context,
      target,
      applyToken,
      resultCode: "TARGET_MISMATCH",
    });
    runtime.dispose();
  });

  it("revalidates a cached provider adapter before applying after player visibility switches", async () => {
    const first = createVideo(100, 10);
    const second = createVideo(100, 20);
    second.hidden = true;
    document.body.append(first, second);
    const emitted: MediaObservedMessage[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface: document.createElement("section"),
      now: () => fixedNow,
      readPageUrl: () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      emitObserved: (message) => emitted.push(message),
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);

    first.hidden = true;
    second.hidden = false;
    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discoveredTarget,
        action: { type: "PAUSE" },
      },
    });

    expect(first.pause).not.toHaveBeenCalled();
    expect(second.pause).toHaveBeenCalledOnce();
    expect(emitted.at(-1)).toMatchObject({
      event: "APPLY_RESULT",
      applyToken,
      resultCode: null,
    });
    runtime.dispose();
  });

  it("returns mismatch instead of controlling a hidden cached generic player", async () => {
    const first = createVideo(100, 10);
    const second = createVideo(100, 20);
    first.id = "first-player";
    second.id = "second-player";
    second.hidden = true;
    document.body.append(first, second);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);

    first.hidden = true;
    second.hidden = false;
    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discoveredTarget,
        action: { type: "PAUSE" },
      },
    });

    expect(first.pause).not.toHaveBeenCalled();
    expect(second.pause).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({
      event: "APPLY_RESULT",
      applyToken,
      resultCode: "TARGET_MISMATCH",
    });
    runtime.dispose();
  });

  it("keeps a rendered cached player usable when it is only outside the viewport", async () => {
    const video = createVideo(100, 10);
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);

    video.getBoundingClientRect = () => domRect(10_000, 10_000, 640, 360);
    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discoveredTarget,
        action: { type: "PAUSE" },
      },
    });

    expect(video.pause).toHaveBeenCalledOnce();
    expect(emitted.at(-1)?.resultCode).toBeNull();
    runtime.dispose();
  });

  it("rediscovers after media visibility attributes switch without an apply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const first = createVideo(100, 10);
    const second = createVideo(100, 20);
    second.hidden = true;
    document.body.append(first, second);
    const emitted: MediaObservedMessage[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface: document.createElement("section"),
      now: () => fixedNow,
      readPageUrl: () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      emitObserved: (message) => emitted.push(message),
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });

    first.hidden = true;
    second.hidden = false;
    await flushMutations();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(emitted.at(-1)).toMatchObject({
      event: "STATE_CHANGED",
      observed: { positionMs: 20_000 },
    });
    runtime.dispose();
  });

  it("emits an APPLY_RESULT for deferred PLAY and an immediate PAUSE", async () => {
    let resolvePlay!: () => void;
    const deferredPlay = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    const video = createVideo(100, 10);
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn(() => deferredPlay),
    });
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = emitted.at(-1)?.target;
    if (discoveredTarget === null || discoveredTarget === undefined) {
      throw new Error("expected discovered target");
    }

    const playApply = runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discoveredTarget,
        action: { type: "PLAY" },
      },
    });
    const pauseApply = runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken: secondApplyToken,
        target: discoveredTarget,
        action: { type: "PAUSE" },
      },
    });

    await pauseApply;
    resolvePlay();
    await playApply;

    expect(
      emitted
        .filter((message) => message.event === "APPLY_RESULT")
        .map((message) => message.applyToken)
        .sort(),
    ).toEqual([applyToken, secondApplyToken].sort());
    runtime.dispose();
  });

  it("keeps the deferred PLAY token when it later rejects as autoplay-blocked", async () => {
    const deferredPlay = createDeferred<void>();
    const video = createVideo(100, 10);
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn(() => deferredPlay.promise),
    });
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);

    const playApply = runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discoveredTarget,
        action: { type: "PLAY" },
      },
    });
    const pauseApply = runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken: secondApplyToken,
        target: discoveredTarget,
        action: { type: "PAUSE" },
      },
    });

    await pauseApply;
    deferredPlay.reject(new DOMException("gesture required", "NotAllowedError"));
    await playApply;
    video.dispatchEvent(new Event("pause"));

    expect(
      emitted
        .filter((message) => message.event === "APPLY_RESULT")
        .map((message) => ({
          applyToken: message.applyToken,
          resultCode: message.resultCode,
        })),
    ).toEqual(
      expect.arrayContaining([
        { applyToken, resultCode: "AUTOPLAY_BLOCKED" },
        { applyToken: secondApplyToken, resultCode: null },
      ]),
    );
    expect(emitted.findLast((message) => message.event === "STATE_CHANGED")?.applyToken).toBe(
      secondApplyToken,
    );
    runtime.dispose();
  });

  it("correlates concurrent play and pause events without crossing tokens", async () => {
    const deferredPlay = createDeferred<void>();
    const video = createVideo(100, 10);
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn(() => deferredPlay.promise),
    });
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);

    const playApply = runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discoveredTarget,
        action: { type: "PLAY" },
      },
    });
    const pauseApply = runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken: secondApplyToken,
        target: discoveredTarget,
        action: { type: "PAUSE" },
      },
    });
    video.dispatchEvent(new Event("play"));
    video.dispatchEvent(new Event("pause"));

    await pauseApply;
    deferredPlay.resolve();
    await playApply;

    expect(
      emitted
        .filter((message) => message.event === "STATE_CHANGED")
        .slice(-2)
        .map((message) => message.applyToken),
    ).toEqual([applyToken, secondApplyToken]);
    runtime.dispose();
  });

  it("returns TARGET_MISMATCH when a pending apply outlives DOM adapter replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const deferredPlay = createDeferred<void>();
    const video = createVideo(100, 10);
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn(() => deferredPlay.promise),
    });
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);
    const baselineTimerCount = vi.getTimerCount();

    const playApply = runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken,
        target: discoveredTarget,
        action: { type: "PLAY" },
      },
    });
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);

    video.replaceWith(createVideo(100, 20));
    await flushMutations();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(baselineTimerCount);

    deferredPlay.resolve();
    await playApply;

    expect(
      emitted.find(
        (message) => message.event === "APPLY_RESULT" && message.applyToken === applyToken,
      ),
    ).toMatchObject({
      resultCode: "TARGET_MISMATCH",
    });
    runtime.dispose();
  });

  it("rejects overflow before apply and preserves the released FIFO slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const deferredPlays = Array.from({ length: 32 }, () => createDeferred<void>());
    let playIndex = 0;
    const video = createVideo(100, 10);
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn(() => deferredPlays[playIndex++]!.promise),
    });
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const discoveredTarget = requireDiscoveredTarget(emitted);
    const baselineTimerCount = vi.getTimerCount();

    const handles = Array.from({ length: 32 }, (_, index) =>
      runtime.handle({
        type: "syncaction.media.command",
        context,
        operation: {
          type: "APPLY",
          applyToken: applyTokenFor(index),
          target: discoveredTarget,
          action: { type: "PLAY" },
        },
      }),
    );

    expect(vi.getTimerCount()).toBe(baselineTimerCount + 32);
    const overflowToken = applyTokenFor(32);
    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken: overflowToken,
        target: discoveredTarget,
        action: { type: "PAUSE" },
      },
    });

    expect(video.pause).not.toHaveBeenCalled();
    expect(
      emitted.find(
        (message) => message.event === "APPLY_RESULT" && message.applyToken === overflowToken,
      ),
    ).toMatchObject({
      target: discoveredTarget,
      observed: expect.any(Object),
      resultCode: "MEDIA_APPLY_FAILED",
    });
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 32);

    video.dispatchEvent(new Event("play"));
    expect(emitted.findLast((message) => message.event === "STATE_CHANGED")?.applyToken).toBe(
      applyTokenFor(0),
    );
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 31);

    const nextToken = applyTokenFor(33);
    await runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: {
        type: "APPLY",
        applyToken: nextToken,
        target: discoveredTarget,
        action: { type: "PAUSE" },
      },
    });
    expect(video.pause).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 32);

    video.dispatchEvent(new Event("pause"));
    expect(emitted.findLast((message) => message.event === "STATE_CHANGED")?.applyToken).toBe(
      nextToken,
    );
    expect(
      emitted.some(
        (message) => message.event === "STATE_CHANGED" && message.applyToken === overflowToken,
      ),
    ).toBe(false);

    runtime.dispose();
    expect(vi.getTimerCount()).toBe(0);
    for (const deferredPlay of deferredPlays) {
      deferredPlay.resolve();
    }
    await Promise.all(handles);
  });

  it("clears every correlation timer on context reset and disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const deferredPlays = Array.from({ length: 4 }, () => createDeferred<void>());
    let playIndex = 0;
    const video = createVideo(100, 10);
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn(() => deferredPlays[playIndex++]!.promise),
    });
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const originalTarget = requireDiscoveredTarget(emitted);
    const baselineTimerCount = vi.getTimerCount();
    const handles = [0, 1].map((index) =>
      runtime.handle({
        type: "syncaction.media.command",
        context,
        operation: {
          type: "APPLY",
          applyToken: applyTokenFor(index),
          target: originalTarget,
          action: { type: "PLAY" },
        },
      }),
    );
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 2);

    const nextContext = {
      ...context,
      documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 5 },
    };
    runtime.handle({
      type: "syncaction.media.command",
      context: nextContext,
      operation: { type: "OBSERVE" },
    });
    expect(vi.getTimerCount()).toBe(baselineTimerCount);
    const replacementTarget = requireDiscoveredTarget(emitted);
    handles.push(
      ...[2, 3].map((index) =>
        runtime.handle({
          type: "syncaction.media.command",
          context: nextContext,
          operation: {
            type: "APPLY",
            applyToken: applyTokenFor(index),
            target: replacementTarget,
            action: { type: "PLAY" },
          },
        }),
      ),
    );
    expect(vi.getTimerCount()).toBe(baselineTimerCount + 2);

    runtime.dispose();
    expect(vi.getTimerCount()).toBe(0);
    for (const deferredPlay of deferredPlays) {
      deferredPlay.resolve();
    }
    await Promise.all(handles);
    expect(emitted.some((message) => message.event === "APPLY_RESULT")).toBe(false);
  });

  it("maps an unexpected adapter rejection to MEDIA_APPLY_FAILED", async () => {
    const adapterMedia = document.createElement("video");
    const rejectingAdapter: MediaAdapter = {
      target: MediaTargetSchema.parse(target),
      getMediaElement: () => adapterMedia,
      isUsable: () => true,
      read: () => observed,
      apply: vi.fn(async () => {
        throw new Error("unexpected adapter rejection");
      }),
      subscribe: () => () => undefined,
    };
    vi.spyOn(mediaRegistry, "discoverMediaAdapter").mockReturnValue({
      adapter: rejectingAdapter,
      code: null,
    });
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });

    await expect(
      runtime.handle({
        type: "syncaction.media.command",
        context,
        operation: {
          type: "APPLY",
          applyToken,
          target,
          action: { type: "PLAY" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(emitted.at(-1)).toMatchObject({
      event: "APPLY_RESULT",
      applyToken,
      target,
      observed: expect.any(Object),
      resultCode: "MEDIA_APPLY_FAILED",
    });
    runtime.dispose();
  });

  it("degrades live media and stops observing after disposal", async () => {
    const live = createVideo(Number.POSITIVE_INFINITY, 0);
    document.body.append(live);
    const emitted: MediaObservedMessage[] = [];
    const capabilities: unknown[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface: document.createElement("section"),
      now: () => fixedNow,
      emitObserved: (message) => emitted.push(message),
      emitCapability: (message) => capabilities.push(message),
      readPageUrl: () => "https://example.com/live",
    });

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    expect(emitted.at(-1)).toMatchObject({
      event: "UNSUPPORTED",
      context,
      target: null,
      resultCode: "MEDIA_LIVE_UNSUPPORTED",
    });
    expect(capabilities.at(-1)).toMatchObject({
      capability: "MEDIA",
      state: "DEGRADED",
      errorCode: "MEDIA_LIVE_UNSUPPORTED",
    });

    const count = emitted.length;
    runtime.dispose();
    live.replaceWith(createVideo(100, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(emitted).toHaveLength(count);
  });

  it("automatically discovers ordinary media when delayed metadata becomes finite", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const metadata = { duration: Number.NaN, readyState: 0 };
    const video = createVideoWithMetadata(metadata, 0);
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const capabilities: unknown[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface: document.createElement("section"),
      now: () => fixedNow,
      emitObserved: (message) => emitted.push(message),
      emitCapability: (message) => capabilities.push(message),
      readPageUrl: () => "https://example.com/watch",
    });

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    expect(emitted.at(-1)).toMatchObject({
      event: "UNSUPPORTED",
      resultCode: "MEDIA_METADATA_PENDING",
    });
    expect(capabilities.at(-1)).toMatchObject({
      capability: "MEDIA",
      state: "DEGRADED",
      errorCode: "MEDIA_METADATA_PENDING",
    });

    metadata.duration = 100;
    metadata.readyState = 1;
    video.dispatchEvent(new Event("loadedmetadata"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(emitted.at(-1)).toMatchObject({
      event: "DISCOVERED",
      context,
      target: { durationMs: 100_000 },
      resultCode: null,
    });
    expect(capabilities.at(-1)).toMatchObject({
      capability: "MEDIA",
      state: "AVAILABLE",
      errorCode: null,
    });
    runtime.dispose();
  });

  it("bounds invalid metadata wakeups and emits nothing after disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const metadata = { duration: Number.NaN, readyState: 0 };
    const video = createVideoWithMetadata(metadata, 0);
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const capabilities: unknown[] = [];
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface: document.createElement("section"),
      now: () => fixedNow,
      readPageUrl: () => "https://example.com/watch",
      emitObserved: (message) => emitted.push(message),
      emitCapability: (message) => capabilities.push(message),
    });

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    expect(emitted.at(-1)?.resultCode).toBe("MEDIA_METADATA_PENDING");
    const count = emitted.length;

    metadata.readyState = 1;
    for (let index = 0; index < 12; index += 1) {
      video.dispatchEvent(new Event("durationchange"));
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emitted).toHaveLength(count + 1);
    expect(emitted.at(-1)).toMatchObject({
      event: "UNSUPPORTED",
      resultCode: "MEDIA_LIVE_UNSUPPORTED",
    });
    expect(capabilities.at(-1)).toMatchObject({
      capability: "MEDIA",
      state: "DEGRADED",
      errorCode: "MEDIA_LIVE_UNSUPPORTED",
    });
    const invalidCount = emitted.length;

    runtime.dispose();
    metadata.duration = 100;
    video.dispatchEvent(new Event("loadedmetadata"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emitted).toHaveLength(invalidCount);
  });

  it("replaces metadata wake listeners on context reset and removes them on dispose", () => {
    const metadata = { duration: Number.NaN, readyState: 0 };
    document.body.append(createVideoWithMetadata(metadata, 0));
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const runtime = createRuntime([]);

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    expect(
      addEventListener.mock.calls.filter(([eventType]) => eventType === "loadedmetadata"),
    ).toHaveLength(1);
    expect(
      addEventListener.mock.calls.filter(([eventType]) => eventType === "durationchange"),
    ).toHaveLength(1);

    runtime.handle({
      type: "syncaction.media.command",
      context: {
        ...context,
        documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 5 },
      },
      operation: { type: "OBSERVE" },
    });
    expect(
      removeEventListener.mock.calls.filter(([eventType]) => eventType === "loadedmetadata"),
    ).toHaveLength(1);
    expect(
      addEventListener.mock.calls.filter(([eventType]) => eventType === "loadedmetadata"),
    ).toHaveLength(2);

    runtime.dispose();
    expect(
      removeEventListener.mock.calls.filter(([eventType]) => eventType === "loadedmetadata"),
    ).toHaveLength(2);
    expect(
      removeEventListener.mock.calls.filter(([eventType]) => eventType === "durationchange"),
    ).toHaveLength(2);
  });

  it("cancels a queued metadata wake when rediscovery already ran synchronously", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const metadata = { duration: Number.NaN, readyState: 0 };
    const video = createVideoWithMetadata(metadata, 0);
    const addEventListener = vi.spyOn(video, "addEventListener");
    document.body.append(video);
    const runtime = createRuntime([]);

    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    metadata.duration = 100;
    metadata.readyState = 1;
    video.dispatchEvent(new Event("loadedmetadata"));
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const subscriptionCount = addEventListener.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(addEventListener).toHaveBeenCalledTimes(subscriptionCount);
    runtime.dispose();
  });

  it("emits UNSUPPORTED when the current target disappears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const video = createVideo(100, 10);
    document.body.append(video);
    const emitted: MediaObservedMessage[] = [];
    const runtime = createRuntime(emitted);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });

    video.remove();
    await flushMutations();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(emitted.at(-1)).toEqual({
      type: "syncaction.media.observed",
      event: "UNSUPPORTED",
      context,
      target: null,
      observed: null,
      applyToken: null,
      resultCode: "MEDIA_NOT_FOUND",
    });
    runtime.dispose();
  });

  it("ignores irrelevant DOM churn without rebuilding the media adapter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const video = createVideo(100, 10);
    const addEventListener = vi.spyOn(video, "addEventListener");
    document.body.append(video);
    const runtime = createRuntime([]);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const initialSubscriptions = addEventListener.mock.calls.length;

    for (let index = 0; index < 20; index += 1) {
      const noise = document.createElement("div");
      noise.textContent = String(index);
      document.body.append(noise);
    }
    await flushMutations();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(addEventListener).toHaveBeenCalledTimes(initialSubscriptions);
    runtime.dispose();
  });

  it("coalesces media topology bursts and bounds sustained rediscovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const video = createVideo(100, 10);
    const addEventListener = vi.spyOn(video, "addEventListener");
    document.body.append(video);
    const runtime = createRuntime([]);
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const subscriptionSize = addEventListener.mock.calls.length;

    for (let index = 0; index < 12; index += 1) {
      const source = document.createElement("source");
      source.src = `/media-${String(index)}.mp4`;
      video.append(source);
    }
    await flushMutations();
    await vi.advanceTimersByTimeAsync(300);
    expect(addEventListener.mock.calls.length - subscriptionSize).toBe(subscriptionSize);

    for (let index = 0; index < 12; index += 1) {
      const source = document.createElement("source");
      source.src = `/sustained-${String(index)}.mp4`;
      video.append(source);
      await flushMutations();
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(500);

    const rebuilds = (addEventListener.mock.calls.length - subscriptionSize) / subscriptionSize;
    expect(rebuilds).toBeLessThanOrEqual(4);
    runtime.dispose();
  });

  it("stops topology and URL monitoring after dispose", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    let pageUrl = "https://example.com/watch";
    const video = createVideo(100, 10);
    const addEventListener = vi.spyOn(video, "addEventListener");
    document.body.append(video);
    const runtime = new MediaPageRuntime({
      document,
      window,
      surface: document.createElement("section"),
      now: () => fixedNow,
      readPageUrl: () => pageUrl,
      emitObserved: () => undefined,
    });
    runtime.handle({
      type: "syncaction.media.command",
      context,
      operation: { type: "OBSERVE" },
    });
    const initialSubscriptions = addEventListener.mock.calls.length;
    runtime.dispose();

    pageUrl = "https://example.com/after-navigation";
    video.append(document.createElement("source"));
    await flushMutations();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(addEventListener).toHaveBeenCalledTimes(initialSubscriptions);
  });
});

function createRuntime(emitted: MediaObservedMessage[]): MediaPageRuntime {
  return new MediaPageRuntime({
    document,
    window,
    surface: document.createElement("section"),
    now: () => fixedNow,
    readPageUrl: () => "https://example.com/watch",
    emitObserved: (message) => emitted.push(message),
  });
}

function requireDiscoveredTarget(emitted: MediaObservedMessage[]) {
  const discoveredTarget = emitted.at(-1)?.target;
  if (discoveredTarget === null || discoveredTarget === undefined) {
    throw new Error("expected discovered target");
  }
  return discoveredTarget;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function applyTokenFor(index: number): string {
  const suffix = (0x123456789b00n + BigInt(index)).toString(16);
  return `018f8f8e-4b5c-4d6e-8f90-${suffix}`;
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createVideo(duration: number, currentTime: number, playError?: Error): HTMLVideoElement {
  return createVideoWithMetadata({ duration, readyState: 4 }, currentTime, playError);
}

function createVideoWithMetadata(
  metadata: { duration: number; readyState: number },
  currentTime: number,
  playError?: Error,
): HTMLVideoElement {
  const video = document.createElement("video");
  let paused = true;
  Object.defineProperties(video, {
    duration: { configurable: true, get: () => metadata.duration },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    },
    paused: { configurable: true, get: () => paused },
    playbackRate: { configurable: true, writable: true, value: 1 },
    readyState: { configurable: true, get: () => metadata.readyState },
    ended: { configurable: true, get: () => false },
    mediaKeys: { configurable: true, get: () => null },
    play: {
      configurable: true,
      value: vi.fn(async () => {
        if (playError !== undefined) {
          throw playError;
        }
        paused = false;
      }),
    },
    pause: {
      configurable: true,
      value: vi.fn(() => {
        paused = true;
      }),
    },
  });
  video.getBoundingClientRect = () => domRect(0, 0, 640, 360);
  return video;
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
