import { canonicalSharedPageIdentity } from "@syncaction/protocol";
import { createAdapter } from "./html-media.js";
import type { MediaAdapter, MediaAdapterFactoryOptions } from "./types.js";

export function createYoutubeMediaAdapter(
  options: MediaAdapterFactoryOptions,
): MediaAdapter | null {
  const mediaKey = canonicalProviderKey(options.context.pageUrl, "youtube:");
  return mediaKey === null ? null : createAdapter(options, "YOUTUBE", mediaKey);
}

function canonicalProviderKey(pageUrl: string, prefix: string): string | null {
  try {
    const identity = canonicalSharedPageIdentity(pageUrl);
    return identity.startsWith(prefix) ? identity : null;
  } catch {
    return null;
  }
}
