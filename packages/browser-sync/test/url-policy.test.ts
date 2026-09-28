import { describe, expect, it } from "vitest";
import {
  canonicalizeSharedUrl,
  canonicalSharedPageIdentity,
  isSupportedSharedUrl,
} from "../src/url-policy.js";

describe("shared browser URL policy", () => {
  it("canonicalizes top-level HTTP and HTTPS navigation", () => {
    expect(canonicalizeSharedUrl("HTTPS://Example.COM:443/a/../b?q=1#part")).toBe(
      "https://example.com/b?q=1#part",
    );
    expect(isSupportedSharedUrl("http://localhost:29373/room")).toBe(true);
  });

  it.each([
    "chrome://settings/",
    "edge://extensions/",
    "file:///C:/secret.txt",
    "view-source:https://example.com/",
    "devtools://devtools/bundled/",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "chrome-extension://extension-id/page.html",
  ])("rejects unsupported browser URL %s", (url) => {
    expect(isSupportedSharedUrl(url)).toBe(false);
    expect(() => canonicalizeSharedUrl(url)).toThrow();
  });

  it("rejects credentials, malformed values, and oversized URLs", () => {
    expect(isSupportedSharedUrl("https://user:password@example.com/")).toBe(false);
    expect(isSupportedSharedUrl("not a URL")).toBe(false);
    expect(isSupportedSharedUrl(`https://example.com/${"a".repeat(4_100)}`)).toBe(false);
  });

  it("delegates canonical page identity to the shared protocol contract", () => {
    expect(canonicalSharedPageIdentity("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe(
      "youtube:dQw4w9WgXcQ",
    );
    expect(canonicalSharedPageIdentity("https://example.com/a?b=1#private")).toBe(
      "url:https://example.com/a?b=1",
    );
  });
});
