import { canonicalBilibiliMediaId, YOUTUBE_MEDIA_ID_PATTERN } from "./media-identity.js";
import { canonicalizeSharedUrl, isSupportedSharedUrl, parseSharedUrl } from "./shared-url.js";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTUBE_EMBED_HOSTS = new Set([
  ...YOUTUBE_HOSTS,
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const BILIBILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com"]);
const BILIBILI_PLAYER_HOSTS = new Set(["player.bilibili.com", "www.bilibili.com"]);

export { canonicalizeSharedUrl, isSupportedSharedUrl };

function exactPathSegments(pathname: string): string[] | undefined {
  const rawSegments = pathname.slice(1).split("/");
  if (rawSegments.at(-1) === "") {
    rawSegments.pop();
  }
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) {
    return undefined;
  }

  try {
    const segments = rawSegments.map((segment) => decodeURIComponent(segment));
    return segments.every(
      (segment) => segment.length > 0 && !segment.includes("/") && !segment.includes("\\"),
    )
      ? segments
      : undefined;
  } catch {
    return undefined;
  }
}

function youtubeMediaId(url: URL): string | undefined {
  const segments = exactPathSegments(url.pathname);
  let candidate: string | null | undefined;
  if (url.hostname === "youtu.be") {
    candidate = segments?.length === 1 ? segments[0] : undefined;
  } else if (YOUTUBE_EMBED_HOSTS.has(url.hostname)) {
    if (segments?.length === 1 && segments[0] === "watch") {
      candidate = YOUTUBE_HOSTS.has(url.hostname) ? url.searchParams.get("v") : undefined;
    } else if (segments?.length === 2 && segments[0] === "shorts") {
      candidate = YOUTUBE_HOSTS.has(url.hostname) ? segments[1] : undefined;
    } else if (segments?.length === 2 && segments[0] === "embed") {
      candidate = segments[1];
    }
  }

  return candidate !== null && candidate !== undefined && YOUTUBE_MEDIA_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function bilibiliMediaId(url: URL): string | undefined {
  if (BILIBILI_HOSTS.has(url.hostname)) {
    const segments = exactPathSegments(url.pathname);
    const candidate = segments?.length === 2 && segments[0] === "video" ? segments[1] : undefined;
    if (candidate !== undefined) {
      return canonicalBilibiliMediaId(candidate);
    }
  }

  if (!BILIBILI_PLAYER_HOSTS.has(url.hostname) || url.pathname !== "/player.html") {
    return undefined;
  }
  const bvid = url.searchParams.get("bvid");
  const canonicalBvid = bvid === null ? undefined : canonicalBilibiliMediaId(bvid);
  if (canonicalBvid !== undefined) {
    return canonicalBvid;
  }
  const aid = url.searchParams.get("aid");
  return aid === null || !/^[0-9]{1,20}$/u.test(aid)
    ? undefined
    : canonicalBilibiliMediaId(`av${aid}`);
}

export function canonicalSharedPageIdentity(input: unknown): string {
  const url = parseSharedUrl(input);
  const youtubeId = youtubeMediaId(url);
  if (youtubeId !== undefined) {
    return `youtube:${youtubeId}`;
  }

  const bilibiliId = bilibiliMediaId(url);
  if (bilibiliId !== undefined) {
    return `bilibili:${bilibiliId}`;
  }

  url.hash = "";
  return `url:${url.href}`;
}
