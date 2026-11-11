import { canonicalSharedPageIdentity } from "@syncaction/protocol";
import {
  createAdapter,
  HtmlMediaAdapter,
  isKnownEncryptedMedia,
  isRenderedMedia,
  readMediaDurationMs,
} from "./html-media.js";
import type { MediaAdapter, MediaAdapterFactoryOptions, MediaDiscreteEvent } from "./types.js";

const PLAYER_SELECTOR = "#bilibili-player, #bilibiliPlayer, #playerWrap, .bpx-player-container";

export function createBilibiliMediaAdapter(
  options: MediaAdapterFactoryOptions,
): MediaAdapter | null {
  const mediaKey = canonicalProviderKey(options.context.pageUrl, "bilibili:");
  if (mediaKey === null) return null;
  const adapter = createAdapter(options, "BILIBILI", mediaKey);
  const piece = explicitPiece(options.context.pageUrl);
  const player = options.media.closest(PLAYER_SELECTOR);
  // Without original local piece evidence, duration matching stays exact.
  if (
    piece === null ||
    player === null ||
    options.readPageUrl === undefined ||
    options.isCurrentPrincipal === undefined
  )
    return adapter;
  return new BilibiliMediaAdapter(options, adapter.target, piece, player);
}

class BilibiliMediaAdapter extends HtmlMediaAdapter {
  readonly #options: MediaAdapterFactoryOptions;
  readonly #piece: string;
  readonly #player: Element;
  readonly #source: string;
  #invalidated = false;
  #completedDurationMs: number | null = null;

  constructor(
    options: MediaAdapterFactoryOptions,
    target: MediaAdapter["target"],
    piece: string,
    player: Element,
  ) {
    super({ ...options, target });
    this.#options = options;
    this.#piece = piece;
    this.#player = player;
    this.#source = resourceDescription(options.media);
  }

  public isResourceInvalidated(): boolean {
    if (this.#invalidated) return true;
    const media = this.getMediaElement();
    try {
      this.#invalidated =
        !media.isConnected ||
        !this.#options.isCurrentPrincipal!() ||
        media.closest(PLAYER_SELECTOR) !== this.#player ||
        explicitPiece(this.#options.readPageUrl!()) !== this.#piece ||
        resourceDescription(media) !== this.#source ||
        isKnownEncryptedMedia(media);
    } catch {
      this.#invalidated = true;
    }
    return this.#invalidated;
  }

  public override isUsable(): boolean {
    if (this.isResourceInvalidated()) return false;
    const media = this.getMediaElement();
    const duration = readMediaDurationMs(media);
    return (
      isRenderedMedia(media, this.#options.window) &&
      duration !== null &&
      (duration === this.target.durationMs ||
        this.#completedDurationMs === null ||
        duration === this.#completedDurationMs)
    );
  }

  public override async apply(command: Parameters<MediaAdapter["apply"]>[0]) {
    if (!this.isUsable())
      return { applied: false, code: "MEDIA_NOT_FOUND" as const, observed: this.read() };
    return super.apply(command);
  }

  public override subscribe(listener: (event: MediaDiscreteEvent) => void): () => void {
    const unsubscribe = super.subscribe(listener);
    const media = this.getMediaElement();
    const invalidate = () => {
      this.#invalidated = true;
    };
    const complete = () => {
      this.#completedDurationMs = readMediaDurationMs(media);
    };
    media.addEventListener("loadstart", invalidate);
    media.addEventListener("emptied", invalidate);
    media.addEventListener("ended", complete);
    return () => {
      unsubscribe();
      media.removeEventListener("loadstart", invalidate);
      media.removeEventListener("emptied", invalidate);
      media.removeEventListener("ended", complete);
    };
  }
}

function explicitPiece(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    const key = canonicalProviderKey(pageUrl, "bilibili:");
    const part = url.searchParams.getAll("p");
    const cid = url.searchParams.getAll("cid");
    if (
      key === null ||
      part.length > 1 ||
      cid.length > 1 ||
      part.length + cid.length === 0 ||
      [...part, ...cid].some((value) => !/^[1-9][0-9]{0,19}$/u.test(value))
    )
      return null;
    return JSON.stringify([url.origin, key, part[0] ?? null, cid[0] ?? null]);
  } catch {
    return null;
  }
}

function resourceDescription(media: HTMLMediaElement): string {
  return JSON.stringify([
    media.currentSrc,
    media.getAttribute("src"),
    [...media.querySelectorAll("source")].map((source) => [
      source.getAttribute("src"),
      source.getAttribute("type"),
    ]),
  ]);
}

function canonicalProviderKey(pageUrl: string, prefix: string): string | null {
  try {
    const identity = canonicalSharedPageIdentity(pageUrl);
    return identity.startsWith(prefix) ? identity : null;
  } catch {
    return null;
  }
}
