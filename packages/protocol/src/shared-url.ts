export const MAX_SHARED_URL_LENGTH = 4_096;

export function parseSharedUrl(input: unknown): URL {
  if (typeof input !== "string" || input.length > MAX_SHARED_URL_LENGTH) {
    throw new Error("UNSUPPORTED_SHARED_URL");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new Error("UNSUPPORTED_SHARED_URL", { cause });
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.href.length > MAX_SHARED_URL_LENGTH
  ) {
    throw new Error("UNSUPPORTED_SHARED_URL");
  }

  return url;
}

export function canonicalizeSharedUrl(input: unknown): string {
  return parseSharedUrl(input).href;
}

export function isSupportedSharedUrl(input: unknown): input is string {
  try {
    parseSharedUrl(input);
    return true;
  } catch {
    return false;
  }
}
