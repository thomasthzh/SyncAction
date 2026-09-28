export const PRODUCTION_PUBLIC_SERVER_ORIGIN = "https://syncaction.example.com";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parsePublicServerOrigin(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 2_048) {
    throw new Error("INVALID_SERVER_URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("INVALID_SERVER_URL");
  }
  const isSecure = parsed.protocol === "https:";
  const isLoopbackHttp =
    parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  if (
    (!isSecure && !isLoopbackHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("INVALID_SERVER_URL");
  }
  return parsed.origin;
}

export function resolvePublicServerOrigin(input: unknown): string {
  return parsePublicServerOrigin(input === undefined ? PRODUCTION_PUBLIC_SERVER_ORIGIN : input);
}

export function publicServerHostPermission(originInput: unknown): string {
  return `${parsePublicServerOrigin(originInput)}/*`;
}
