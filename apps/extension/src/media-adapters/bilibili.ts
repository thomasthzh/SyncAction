import { canonicalSharedPageIdentity } from "@syncaction/protocol";
import { createAdapter } from "./html-media.js";
import type { MediaAdapter, MediaAdapterFactoryOptions } from "./types.js";

export function createBilibiliMediaAdapter(
  options: MediaAdapterFactoryOptions,
): MediaAdapter | null {
  const mediaKey = canonicalProviderKey(options.context.pageUrl, "bilibili:");
  return mediaKey === null ? null : createAdapter(options, "BILIBILI", mediaKey);
}

function canonicalProviderKey(pageUrl: string, prefix: string): string | null {
  try {
    const identity = canonicalSharedPageIdentity(pageUrl);
    return identity.startsWith(prefix) ? identity : null;
  } catch {
    return null;
  }
}
