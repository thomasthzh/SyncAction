import {
  MediaObservedStateSchema,
  MediaTargetSchema,
  type MediaProvider,
  type MediaTarget,
} from "@syncaction/protocol";
import type {
  MediaAdapter,
  MediaAdapterFactoryOptions,
  MediaApplyResult,
  MediaApplyResultCode,
  MediaDiscreteEvent,
} from "./types.js";

export const MAX_MEDIA_DURATION_MS = 604_800_000;
export const MIN_MEDIA_PLAYBACK_RATE = 0.25;
export const MAX_MEDIA_PLAYBACK_RATE = 4;

const knownEncryptedMedia = new WeakSet<HTMLMediaElement>();
const STABLE_SEMANTIC_ATTRIBUTES = [
  "id",
  "role",
  "aria-label",
  "aria-labelledby",
  "data-testid",
  "data-player-id",
  "data-video-id",
  "name",
  "itemprop",
] as const;

export class HtmlMediaAdapter implements MediaAdapter {
  public readonly target: MediaTarget;

  readonly #media: HTMLMediaElement;
  readonly #window: Window;
  readonly #now: () => number;

  public constructor(options: {
    media: HTMLMediaElement;
    window: Window;
    target: MediaTarget;
    now?: () => number;
  }) {
    this.#media = options.media;
    this.#window = options.window;
    this.target = MediaTargetSchema.parse(options.target);
    this.#now = options.now ?? Date.now;
  }

  public getMediaElement(): HTMLMediaElement {
    return this.#media;
  }

  public isUsable(): boolean {
    return (
      isRenderedMedia(this.#media, this.#window) &&
      !isKnownEncryptedMedia(this.#media) &&
      readMediaDurationMs(this.#media) === this.target.durationMs
    );
  }

  public read() {
    const positionMs = clampInteger(
      secondsToMilliseconds(readFiniteNumber(() => this.#media.currentTime, 0)),
      0,
      this.target.durationMs,
    );
    const playbackRate = clamp(
      readFiniteNumber(() => this.#media.playbackRate, 1),
      MIN_MEDIA_PLAYBACK_RATE,
      MAX_MEDIA_PLAYBACK_RATE,
    );
    const ended = readBoolean(() => this.#media.ended, false);
    const readyState = readFiniteNumber(() => this.#media.readyState, 0);

    return MediaObservedStateSchema.parse({
      observedAtClientMs: clampInteger(this.#now(), 0, Number.MAX_SAFE_INTEGER),
      positionMs,
      paused: readBoolean(() => this.#media.paused, true),
      playbackRate,
      ended,
      buffering: !ended && readyState < 3,
    });
  }

  public async apply(command: Parameters<MediaAdapter["apply"]>[0]): Promise<MediaApplyResult> {
    if (!this.#media.isConnected) {
      return this.#failure("MEDIA_NOT_FOUND");
    }
    if (isKnownEncryptedMedia(this.#media)) {
      return this.#failure("MEDIA_DRM_UNSUPPORTED");
    }

    try {
      switch (command.action.type) {
        case "PLAY":
          await Promise.resolve(this.#media.play());
          break;
        case "PAUSE":
          this.#media.pause();
          break;
        case "SEEK":
          this.#media.currentTime =
            clampInteger(command.action.positionMs, 0, this.target.durationMs) / 1_000;
          break;
        case "SET_RATE":
          this.#media.playbackRate = clamp(
            command.action.playbackRate,
            MIN_MEDIA_PLAYBACK_RATE,
            MAX_MEDIA_PLAYBACK_RATE,
          );
          break;
      }
    } catch (error) {
      return this.#failure(mapApplyError(error));
    }

    return {
      applied: true,
      code: null,
      observed: this.read(),
    };
  }

  public subscribe(listener: (event: MediaDiscreteEvent) => void): () => void {
    const bindings: ReadonlyArray<readonly [string, MediaDiscreteEvent]> = [
      ["play", { type: "PLAYED" }],
      ["pause", { type: "PAUSED" }],
      ["seeked", { type: "SEEKED" }],
      ["ratechange", { type: "RATE_CHANGED" }],
      ["ended", { type: "ENDED" }],
      ["waiting", { type: "BUFFERING" }],
      ["canplay", { type: "READY" }],
      ["durationchange", { type: "DURATION_CHANGED" }],
      ["loadedmetadata", { type: "DURATION_CHANGED" }],
    ];
    const removers = bindings.map(([type, event]) => {
      const handler = (): void => {
        listener(event);
      };
      this.#media.addEventListener(type, handler);
      return (): void => {
        this.#media.removeEventListener(type, handler);
      };
    });
    const encryptedHandler = (): void => {
      knownEncryptedMedia.add(this.#media);
      listener({ type: "UNSUPPORTED", code: "MEDIA_DRM_UNSUPPORTED" });
    };
    this.#media.addEventListener("encrypted", encryptedHandler);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      for (const remove of removers) {
        remove();
      }
      this.#media.removeEventListener("encrypted", encryptedHandler);
    };
  }

  #failure(code: MediaApplyResultCode): MediaApplyResult {
    return {
      applied: false,
      code,
      observed: this.read(),
    };
  }
}

export function createHtmlMediaAdapter(options: MediaAdapterFactoryOptions): MediaAdapter {
  return createAdapter(options, "HTML5", `html5:${structuralMediaFingerprint(options.media)}`);
}

export function createAdapter(
  options: MediaAdapterFactoryOptions,
  provider: MediaProvider,
  mediaKey: string,
): MediaAdapter {
  return new HtmlMediaAdapter({
    media: options.media,
    window: options.window,
    target: MediaTargetSchema.parse({
      logicalTabId: options.context.logicalTabId,
      documentRevision: options.context.documentRevision,
      frameKey: options.context.frameKey,
      provider,
      mediaKey,
      durationMs: options.durationMs,
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function isKnownEncryptedMedia(media: HTMLMediaElement): boolean {
  if (knownEncryptedMedia.has(media)) {
    return true;
  }
  try {
    return media.mediaKeys !== null && media.mediaKeys !== undefined;
  } catch {
    return true;
  }
}

export function readMediaDurationMs(media: HTMLMediaElement): number | null {
  const durationSeconds = readFiniteNumber(() => media.duration, Number.NaN);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  return clampInteger(secondsToMilliseconds(durationSeconds), 1, MAX_MEDIA_DURATION_MS);
}

export function isMediaMetadataPending(media: HTMLMediaElement): boolean {
  try {
    return Number.isNaN(media.duration) && media.readyState < 1;
  } catch {
    return false;
  }
}

export function isVisibleMedia(media: HTMLMediaElement, window: Window): boolean {
  const rectangle = readRenderedMediaRectangle(media, window);
  if (rectangle === null) {
    return false;
  }
  const viewportWidth = Math.max(0, window.innerWidth);
  const viewportHeight = Math.max(0, window.innerHeight);
  return (
    rectangle.right > 0 &&
    rectangle.bottom > 0 &&
    (viewportWidth === 0 || rectangle.left < viewportWidth) &&
    (viewportHeight === 0 || rectangle.top < viewportHeight)
  );
}

export function isRenderedMedia(media: HTMLMediaElement, window: Window): boolean {
  return readRenderedMediaRectangle(media, window) !== null;
}

function readRenderedMediaRectangle(media: HTMLMediaElement, window: Window): DOMRect | null {
  if (!media.isConnected) {
    return null;
  }
  try {
    for (let element: Element | null = media; element !== null; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (
        element.hasAttribute("hidden") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number.parseFloat(style.opacity || "1") <= 0
      ) {
        return null;
      }
    }
    const rectangle = media.getBoundingClientRect();
    return Number.isFinite(rectangle.width) &&
      Number.isFinite(rectangle.height) &&
      rectangle.width > 0 &&
      rectangle.height > 0
      ? rectangle
      : null;
  } catch {
    return null;
  }
}

export function visibleMediaArea(media: HTMLMediaElement): number {
  try {
    const rectangle = media.getBoundingClientRect();
    return Math.max(0, rectangle.width) * Math.max(0, rectangle.height);
  } catch {
    return 0;
  }
}

export function isPlayingMedia(media: HTMLMediaElement): boolean {
  try {
    return !media.paused && !media.ended;
  } catch {
    return false;
  }
}

export function structuralMediaFingerprint(media: HTMLMediaElement): string {
  const ancestors: string[] = [];
  let ancestor = media.parentElement;
  for (let depth = 0; ancestor !== null && depth < 12; depth += 1) {
    ancestors.push(elementSemantics(ancestor));
    ancestor = ancestor.parentElement;
  }
  const localCandidateIdentity = [
    `media:${elementSemantics(media)}`,
    `source:${mediaSourceSemantics(media)}`,
    `ancestors:${ancestors.reverse().join("/")}`,
  ].join("|");
  return `${hash32(localCandidateIdentity, 0x811c9dc5)}${hash32(
    localCandidateIdentity,
    0x9e3779b9,
  )}`;
}

function elementSemantics(element: Element): string {
  const attributes = STABLE_SEMANTIC_ATTRIBUTES.flatMap((name) => {
    const value = element.getAttribute(name);
    return value === null || value.length === 0
      ? []
      : [`${name}=${boundedLocalIdentityPart(value)}`];
  });
  return [element.tagName.toLowerCase(), ...attributes].join(";");
}

function mediaSourceSemantics(media: HTMLMediaElement): string {
  const currentSource = readString(() => media.currentSrc);
  const directSource = media.getAttribute("src") ?? "";
  const childSources = [...media.querySelectorAll("source")]
    .map((source) =>
      [
        source.getAttribute("src") ?? "",
        source.getAttribute("type") ?? "",
        source.getAttribute("media") ?? "",
      ].join(";"),
    )
    .filter((value) => value !== ";;");
  return [currentSource, directSource, ...childSources]
    .filter((value) => value.length > 0)
    .map(boundedLocalIdentityPart)
    .join("|");
}

function boundedLocalIdentityPart(value: string): string {
  return value.normalize("NFKC").slice(0, 2_048);
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

function readString(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}

function mapApplyError(error: unknown): MediaApplyResultCode {
  const name =
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
      ? error.name
      : "";
  switch (name) {
    case "NotAllowedError":
      return "AUTOPLAY_BLOCKED";
    case "NotSupportedError":
      return "MEDIA_NOT_SUPPORTED";
    case "AbortError":
      return "MEDIA_PLAY_ABORTED";
    default:
      return "MEDIA_APPLY_FAILED";
  }
}

function readFiniteNumber(read: () => number, fallback: number): number {
  try {
    const value = read();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readBoolean(read: () => boolean, fallback: boolean): boolean {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function secondsToMilliseconds(seconds: number): number {
  return seconds * 1_000;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.round(clamp(value, minimum, maximum));
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}
