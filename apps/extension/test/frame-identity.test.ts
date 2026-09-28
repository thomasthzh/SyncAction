import { describe, expect, it } from "vitest";
import {
  canonicalMediaFrameDocumentIdentity,
  stableMediaFrameKey,
} from "../src/page-collaboration/frame-identity.js";

describe("cross-client media frame identity", () => {
  it("keeps the top frame independent of its local document URL", async () => {
    await expect(stableMediaFrameKey(0, null)).resolves.toBe("top");
    await expect(stableMediaFrameKey(0, "chrome://settings")).resolves.toBe("top");
  });

  it("normalizes YouTube embed variants before hashing", async () => {
    const first = "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1#player";
    const second = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?widget_referrer=private";

    expect(canonicalMediaFrameDocumentIdentity(first)).toBe("youtube:dQw4w9WgXcQ");
    expect(canonicalMediaFrameDocumentIdentity(second)).toBe("youtube:dQw4w9WgXcQ");
    await expect(stableMediaFrameKey(17, first)).resolves.toBe(
      await stableMediaFrameKey(3, second),
    );
  });

  it("normalizes equivalent Bilibili player identifiers before hashing", async () => {
    const byBvid = "https://player.bilibili.com/player.html?bvid=BV17x411w7KC&cid=1";
    const byAid = "https://player.bilibili.com/player.html?aid=170001&cid=2";

    expect(canonicalMediaFrameDocumentIdentity(byBvid)).toBe("bilibili:av170001");
    expect(canonicalMediaFrameDocumentIdentity(byAid)).toBe("bilibili:av170001");
    await expect(stableMediaFrameKey(9, byBvid)).resolves.toBe(await stableMediaFrameKey(2, byAid));
  });

  it("uses a canonical fragment-free identity for ordinary frame documents", async () => {
    const first = "HTTPS://Frame.Example:443/a/../player?q=1#private";
    const second = "https://frame.example/player?q=1#other";

    expect(canonicalMediaFrameDocumentIdentity(first)).toBe("url:https://frame.example/player?q=1");
    await expect(stableMediaFrameKey(4, first)).resolves.toBe(
      await stableMediaFrameKey(88, second),
    );
    await expect(stableMediaFrameKey(4, first)).resolves.not.toBe(
      await stableMediaFrameKey(4, "https://frame.example/player?q=2"),
    );
  });

  it("never places a raw frame URL in the wire key", async () => {
    const key = await stableMediaFrameKey(
      7,
      "https://private.example/account/123?session=secret#position",
    );

    expect(key).toMatch(/^frame:sha256-[a-f0-9]{32}$/u);
    expect(key).not.toContain("private");
    expect(key).not.toContain("secret");
  });

  it.each([
    null,
    "",
    "not a URL",
    "chrome://settings",
    "file:///C:/private.txt",
    "https://user:password@example.com/player",
  ])("rejects unsupported child document identity %s", async (input) => {
    expect(canonicalMediaFrameDocumentIdentity(input)).toBeNull();
    await expect(stableMediaFrameKey(1, input)).resolves.toBeNull();
  });
});
