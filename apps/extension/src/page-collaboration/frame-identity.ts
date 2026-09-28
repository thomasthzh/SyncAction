import { canonicalSharedPageIdentity } from "@syncaction/protocol";

const YOUTUBE_EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const YOUTUBE_MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const BILIBILI_PLAYER_HOSTS = new Set(["player.bilibili.com", "www.bilibili.com"]);
const BILIBILI_AV_ID_PATTERN = /^[0-9]{1,20}$/u;

export function canonicalMediaFrameDocumentIdentity(input: unknown): string | null {
  if (typeof input !== "string" || input.length < 1 || input.length > 8_192) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return null;
  }

  const youtubeId = youtubeEmbedMediaId(url);
  if (youtubeId !== null) {
    return `youtube:${youtubeId}`;
  }

  const bilibiliId = bilibiliPlayerMediaId(url);
  if (bilibiliId !== null) {
    try {
      return canonicalSharedPageIdentity(`https://www.bilibili.com/video/${bilibiliId}`);
    } catch {
      return null;
    }
  }

  try {
    return canonicalSharedPageIdentity(input);
  } catch {
    return null;
  }
}

export async function stableMediaFrameKey(
  frameIdInput: unknown,
  documentUrlInput: unknown,
): Promise<string | null> {
  if (typeof frameIdInput !== "number" || !Number.isSafeInteger(frameIdInput) || frameIdInput < 0) {
    throw new Error("INVALID_FRAME_ID");
  }
  if (frameIdInput === 0) {
    return "top";
  }

  const identity = canonicalMediaFrameDocumentIdentity(documentUrlInput);
  if (identity === null) {
    return null;
  }
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  );
  const token = [...digest.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `frame:sha256-${token}`;
}

function youtubeEmbedMediaId(url: URL): string | null {
  if (!YOUTUBE_EMBED_HOSTS.has(url.hostname)) {
    return null;
  }
  const match = /^\/embed\/([^/]+)\/?$/u.exec(url.pathname);
  if (match?.[1] === undefined) {
    return null;
  }
  let candidate: string;
  try {
    candidate = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return YOUTUBE_MEDIA_ID_PATTERN.test(candidate) ? candidate : null;
}

function bilibiliPlayerMediaId(url: URL): string | null {
  if (!BILIBILI_PLAYER_HOSTS.has(url.hostname) || url.pathname !== "/player.html") {
    return null;
  }
  const bvid = url.searchParams.get("bvid");
  if (bvid !== null && /^BV[A-Za-z0-9]{10}$/u.test(bvid)) {
    return bvid;
  }
  const aid = url.searchParams.get("aid");
  return aid !== null && BILIBILI_AV_ID_PATTERN.test(aid) ? `av${aid}` : null;
}
