import type { MediaTarget } from "@syncaction/protocol";
import { createBilibiliMediaAdapter } from "./bilibili.js";
import {
  createHtmlMediaAdapter,
  isKnownEncryptedMedia,
  isMediaMetadataPending,
  isPlayingMedia,
  isVisibleMedia,
  readMediaDurationMs,
  visibleMediaArea,
} from "./html-media.js";
import type {
  MediaAdapterFactoryOptions,
  MediaDiscoveryOptions,
  MediaDiscoveryResult,
} from "./types.js";
import { createYoutubeMediaAdapter } from "./youtube.js";

export type {
  MediaDiscoveryOptions,
  MediaDiscoveryResult,
  MediaDiscoveryResultCode,
} from "./types.js";

const BILIBILI_PREVIEW_SELECTOR = ".video-page-card-small, .feed-card";
const BILIBILI_PLAYER_SELECTOR =
  "#bilibili-player, #bilibiliPlayer, #playerWrap, .bpx-player-container";

export function discoverMediaAdapter(options: MediaDiscoveryOptions): MediaDiscoveryResult {
  let mediaElements: HTMLMediaElement[];
  try {
    mediaElements = [...options.document.querySelectorAll<HTMLMediaElement>("video, audio")].filter(
      (media) => isVisibleMedia(media, options.window),
    );
    mediaElements = pageMediaCandidates(mediaElements, options.context.pageUrl);
  } catch {
    return { adapter: null, code: "MEDIA_FRAME_UNAUTHORIZED" };
  }

  if (options.target !== undefined) {
    for (const candidate of mediaElements) {
      const result = createCandidateAdapter(candidate, options);
      if (result.adapter !== null && sameTarget(result.adapter.target, options.target)) {
        return result;
      }
    }
    return { adapter: null, code: "MEDIA_NOT_FOUND" };
  }

  const media = selectMediaElement(mediaElements);
  if (media === null) {
    return { adapter: null, code: "MEDIA_NOT_FOUND" };
  }
  return createCandidateAdapter(media, options);
}

function pageMediaCandidates(
  mediaElements: HTMLMediaElement[],
  pageUrl: string,
): HTMLMediaElement[] {
  let hostname: string;
  try {
    hostname = new URL(pageUrl).hostname;
  } catch {
    return mediaElements;
  }
  if (hostname !== "bilibili.com" && !hostname.endsWith(".bilibili.com")) {
    return mediaElements;
  }
  // A playing recommendation must not replace the paused principal player,
  // including when its provider/key/duration happen to match an explicit target.
  const candidates = mediaElements.filter(
    (media) => media.closest(BILIBILI_PREVIEW_SELECTOR) === null,
  );
  const principalPlayers = candidates.filter(
    (media) => media.closest(BILIBILI_PLAYER_SELECTOR) !== null,
  );
  return principalPlayers.length > 0 ? principalPlayers : candidates;
}

function createCandidateAdapter(
  media: HTMLMediaElement,
  options: MediaDiscoveryOptions,
): MediaDiscoveryResult {
  if (isKnownEncryptedMedia(media)) {
    return { adapter: null, code: "MEDIA_DRM_UNSUPPORTED" };
  }
  const durationMs = readMediaDurationMs(media);
  if (durationMs === null) {
    return {
      adapter: null,
      code: isMediaMetadataPending(media) ? "MEDIA_METADATA_PENDING" : "MEDIA_LIVE_UNSUPPORTED",
    };
  }

  const factoryOptions: MediaAdapterFactoryOptions = {
    media,
    window: options.window,
    context: options.context,
    durationMs,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const providerAdapter =
    createYoutubeMediaAdapter(factoryOptions) ?? createBilibiliMediaAdapter(factoryOptions);
  return {
    adapter: providerAdapter ?? createHtmlMediaAdapter(factoryOptions),
    code: null,
  };
}

function sameTarget(left: MediaTarget, right: MediaTarget): boolean {
  return (
    left.logicalTabId === right.logicalTabId &&
    left.documentRevision.roomEpoch === right.documentRevision.roomEpoch &&
    left.documentRevision.tabUpdatedAtSeq === right.documentRevision.tabUpdatedAtSeq &&
    left.frameKey === right.frameKey &&
    left.provider === right.provider &&
    left.mediaKey === right.mediaKey &&
    left.durationMs === right.durationMs
  );
}

function selectMediaElement(mediaElements: readonly HTMLMediaElement[]): HTMLMediaElement | null {
  let selected: HTMLMediaElement | null = null;
  let selectedPlaying = false;
  let selectedArea = -1;
  for (const media of mediaElements) {
    const playing = isPlayingMedia(media);
    const area = visibleMediaArea(media);
    if (
      selected === null ||
      (playing && !selectedPlaying) ||
      (playing === selectedPlaying && area > selectedArea)
    ) {
      selected = media;
      selectedPlaying = playing;
      selectedArea = area;
    }
  }
  return selected;
}
