import { MediaIdentitySchema, PointerAnchorSchema, type PointerAnchor } from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import {
  buildMediaPointerAnchor,
  isReservedMediaPointerAnchor,
  matchesMediaPointerAnchor,
} from "../src/media-pointer-anchor.js";

describe("lossless media pointer anchors within the existing wire limit", () => {
  it.each([
    { provider: "YOUTUBE", mediaKey: "youtube:dQw4w9WgXcQ" },
    { provider: "BILIBILI", mediaKey: "bilibili:av170001" },
    { provider: "HTML5", mediaKey: `html5:${"Ab09._~-".repeat(24)}` },
  ])("encodes $provider identity without loss or document selectors", (input) => {
    const identity = MediaIdentitySchema.parse(input);
    const anchor = buildMediaPointerAnchor(identity, 0.3, 0.7)!;
    expect(PointerAnchorSchema.safeParse(anchor).success).toBe(true);
    expect(anchor.path.length).toBeLessThanOrEqual(12);
    expect(anchor.path[0]).toEqual({
      tagName: `syncaction-media-v1-${identity.provider.toLowerCase()}`,
      nthOfType: 2,
    });
    expect(isReservedMediaPointerAnchor(anchor.path)).toBe(true);
    expect(matchesMediaPointerAnchor(anchor, identity)).toBe(true);
    expect(decodeMediaKey(anchor)).toBe(identity.mediaKey);
    if (identity.provider === "HTML5") expect(anchor.path).toHaveLength(12);
  });

  it("does not conflate case, media identities, chunk boundaries or marker versions", () => {
    const identity = MediaIdentitySchema.parse({ provider: "HTML5", mediaKey: "html5:Clip_A" });
    const other = MediaIdentitySchema.parse({ provider: "HTML5", mediaKey: "html5:clip_A" });
    const anchor = buildMediaPointerAnchor(identity, 0.5, 0.5)!;
    expect(matchesMediaPointerAnchor(anchor, other)).toBe(false);
    for (const path of [
      [{ ...anchor.path[0]!, tagName: "syncaction-media-v2-html5" }, ...anchor.path.slice(1)],
      [{ ...anchor.path[0]!, nthOfType: 1 }, ...anchor.path.slice(1)],
      [anchor.path[0]!, { ...anchor.path[1]!, tagName: anchor.path[1]!.tagName + "a" }],
      [...anchor.path, { tagName: "ma", nthOfType: 1 }],
    ]) {
      expect(isReservedMediaPointerAnchor(path)).toBe(true);
      expect(matchesMediaPointerAnchor({ ...anchor, path }, identity)).toBe(false);
    }
    expect(
      isReservedMediaPointerAnchor([{ tagName: "syncaction-media-invalid", nthOfType: 2 }]),
    ).toBe(true);
    expect(isReservedMediaPointerAnchor([{ tagName: "html", nthOfType: 1 }])).toBe(false);
  });

  it("rejects invalid identities and non-normalized coordinates", () => {
    const identity = MediaIdentitySchema.parse({
      provider: "BILIBILI",
      mediaKey: "bilibili:av170001",
    });
    expect(
      buildMediaPointerAnchor(
        { ...identity, mediaKey: "https://private.example/secret" },
        0.5,
        0.5,
      ),
    ).toBeNull();
    expect(buildMediaPointerAnchor({ ...identity, mediaKey: "bilibili:av0" }, 0.5, 0.5)).toBeNull();
    for (const value of [-1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildMediaPointerAnchor(identity, value, 0.5)).toBeNull();
      expect(buildMediaPointerAnchor(identity, 0.5, value)).toBeNull();
    }
  });
});

// Independent test-only inverse: bit strings instead of the production buffer.
function decodeMediaKey(anchor: PointerAnchor): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bits = anchor.path
    .slice(1)
    .map((segment) =>
      [...segment.tagName.slice(1)]
        .map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0"))
        .join(""),
    )
    .join("");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return String.fromCharCode(...bytes);
}
