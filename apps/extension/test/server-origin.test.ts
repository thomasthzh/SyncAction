import { describe, expect, it } from "vitest";
import {
  PRODUCTION_PUBLIC_SERVER_ORIGIN,
  parsePublicServerOrigin,
  publicServerHostPermission,
  resolvePublicServerOrigin,
} from "../src/server-origin.js";

describe("public server origin", () => {
  it("uses the production HTTPS origin when no build override is present", () => {
    expect(PRODUCTION_PUBLIC_SERVER_ORIGIN).toBe("https://syncaction.example.com");
    expect(resolvePublicServerOrigin(undefined)).toBe(PRODUCTION_PUBLIC_SERVER_ORIGIN);
    expect(publicServerHostPermission(PRODUCTION_PUBLIC_SERVER_ORIGIN)).toBe(
      "https://syncaction.example.com/*",
    );
  });

  it("allows canonical loopback HTTP origins for local browser builds", () => {
    expect(parsePublicServerOrigin("http://127.0.0.1:29373")).toBe("http://127.0.0.1:29373");
    expect(parsePublicServerOrigin("http://localhost:29373/")).toBe("http://localhost:29373");
    expect(parsePublicServerOrigin("http://[::1]:29373")).toBe("http://[::1]:29373");
    expect(publicServerHostPermission("http://127.0.0.1:29373")).toBe("http://127.0.0.1:29373/*");
  });

  it("rejects insecure remote, credentialed, and non-origin URLs", () => {
    for (const candidate of [
      "http://192.0.2.10:29373",
      "http://syncaction.example.com",
      "https://user:secret@example.com",
      "https://example.com/api",
      "https://example.com?mode=local",
      "https://example.com/#fragment",
      "ws://127.0.0.1:29373",
      "",
      null,
    ]) {
      expect(() => parsePublicServerOrigin(candidate)).toThrow("INVALID_SERVER_URL");
    }
  });
});
