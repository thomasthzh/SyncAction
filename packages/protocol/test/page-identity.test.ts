import { describe, expect, it } from "vitest";
import {
  canonicalizeSharedUrl,
  canonicalSharedPageIdentity,
  isSupportedSharedUrl,
} from "../src/index.js";

describe("canonical shared page identity", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=40#comments", "youtube:dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch/?v=dQw4w9WgXcQ&t=40", "youtube:dQw4w9WgXcQ"],
    ["https://www.youtube.com/%77atch?v=dQw4w9WgXcQ", "youtube:dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=12", "youtube:dQw4w9WgXcQ"],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share", "youtube:dQw4w9WgXcQ"],
    ["https://m.youtube.com/%73horts/dQw4w9WgXcQ", "youtube:dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1#player", "youtube:dQw4w9WgXcQ"],
    [
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?widget_referrer=private",
      "youtube:dQw4w9WgXcQ",
    ],
    ["https://www.bilibili.com/video/BV17x411w7KC?p=2#reply", "bilibili:av170001"],
    ["https://www.bilibili.com/%76ideo/BV17x411w7KC", "bilibili:av170001"],
    ["https://www.bilibili.com/video/BV1fsxmeHEpX", "bilibili:av113221780377760"],
    ["https://m.bilibili.com/video/av170001?from=search", "bilibili:av170001"],
    ["https://m.bilibili.com/video/av0170001?from=search", "bilibili:av170001"],
    ["https://m.bilibili.com/video/av0113221780377760", "bilibili:av113221780377760"],
    ["https://player.bilibili.com/player.html?bvid=BV17x411w7KC&cid=1", "bilibili:av170001"],
    ["https://player.bilibili.com/player.html?aid=170001&cid=2", "bilibili:av170001"],
    ["https://youtu.be/dQw4w9WgXc%51", "youtube:dQw4w9WgXcQ"],
  ])("derives a provider identity for %s", (input, expected) => {
    expect(canonicalSharedPageIdentity(input)).toBe(expected);
  });

  it("uses a fragment-free canonical URL identity for ordinary pages", () => {
    expect(canonicalSharedPageIdentity("HTTPS://Example.COM:443/a/../b?q=1#private")).toBe(
      "url:https://example.com/b?q=1",
    );
    expect(canonicalSharedPageIdentity("http://example.com:80/#one")).toBe(
      "url:http://example.com/",
    );
  });

  it("preserves the shared-navigation URL contract separately from page identity", () => {
    expect(canonicalizeSharedUrl("https://example.com/a#section")).toBe(
      "https://example.com/a#section",
    );
    expect(isSupportedSharedUrl("http://localhost:29373/room")).toBe(true);
  });

  it("rejects a URL whose serialized canonical form exceeds the shared limit", () => {
    const input = `https://example.com/${"é".repeat(680)}`;
    expect(input.length).toBeLessThan(4_096);
    expect(() => canonicalizeSharedUrl(input)).toThrow("UNSUPPORTED_SHARED_URL");
    expect(isSupportedSharedUrl(input)).toBe(false);
  });

  it.each([
    "chrome://settings/",
    "edge://extensions/",
    "file:///C:/secret.txt",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "https://user:password@example.com/",
    "not a URL",
    `https://example.com/${"a".repeat(4_100)}`,
  ])("rejects unsupported page identity input %s", (input) => {
    expect(() => canonicalSharedPageIdentity(input)).toThrow("UNSUPPORTED_SHARED_URL");
  });

  it("does not treat lookalike provider hosts or malformed provider IDs as provider pages", () => {
    expect(canonicalSharedPageIdentity("https://youtube.com.example/watch?v=dQw4w9WgXcQ")).toBe(
      "url:https://youtube.com.example/watch?v=dQw4w9WgXcQ",
    );
    expect(canonicalSharedPageIdentity("https://www.youtube.com/watch?v=%3Cscript%3E")).toBe(
      "url:https://www.youtube.com/watch?v=%3Cscript%3E",
    );
    expect(canonicalSharedPageIdentity("https://www.bilibili.com/video/not-a-video")).toBe(
      "url:https://www.bilibili.com/video/not-a-video",
    );
  });

  it.each([
    "https://www.youtube.com/WATCH?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch/extra?v=dQw4w9WgXcQ",
    "https://www.youtube.com/SHORTS/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ/extra",
    "https://youtu.be/dQw4w9WgXcQ/extra",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ/extra",
    "https://www.youtube.com/watch?v=abcdef",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQabc",
    "https://www.bilibili.com/VIDEO/av170001",
    "https://www.bilibili.com/video/av170001/extra",
    "https://www.bilibili.com/video/BV1oKMrd59eP",
    "https://player.bilibili.com/player.html?aid=0",
    "https://player.bilibili.com/player.html?bvid=not-a-video",
    "https://www.youtube.com/%77atch%2Fextra?v=dQw4w9WgXcQ",
    "https://www.youtube.com/%E0%A4%A?v=dQw4w9WgXcQ",
    "https://www.bilibili.com/%76ideo%2Fextra/av170001",
  ])("falls back to URL identity for unsupported provider route %s", (input) => {
    expect(canonicalSharedPageIdentity(input)).toBe(`url:${new URL(input).href}`);
  });
});
