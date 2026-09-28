import { describe, expect, it } from "vitest";
import { AnnotationPageKeyDeriver } from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789a01";
const otherRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789a02";
const canonicalPageIdentity = "youtube:dQw4w9WgXcQ";

describe("AnnotationPageKeyDeriver", () => {
  it("derives a deterministic 32-byte HMAC as unpadded base64url", () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const deriver = new AnnotationPageKeyDeriver(key);

    expect(deriver.derive({ roomId, canonicalPageIdentity })).toBe(
      "4NwOZtGsp1VmyyOocy0c667LcBZgRJmpNkif9aiSRv4",
    );
    expect(deriver.derive({ roomId, canonicalPageIdentity })).toHaveLength(43);

    key.fill(255);
    expect(deriver.derive({ roomId, canonicalPageIdentity })).toBe(
      "4NwOZtGsp1VmyyOocy0c667LcBZgRJmpNkif9aiSRv4",
    );
  });

  it("separates rooms and canonical page identities", () => {
    const deriver = new AnnotationPageKeyDeriver(new Uint8Array(32).fill(7));
    const base = deriver.derive({ roomId, canonicalPageIdentity });

    expect(deriver.derive({ roomId: otherRoomId, canonicalPageIdentity })).not.toBe(base);
    expect(
      deriver.derive({
        roomId,
        canonicalPageIdentity: "youtube:9bZkp7q19f0",
      }),
    ).not.toBe(base);
  });

  it.each([new Uint8Array(0), new Uint8Array(31), new Uint8Array(33), "not-key-material"])(
    "rejects key material that is not exactly 32 bytes",
    (key) => {
      expect(() => new AnnotationPageKeyDeriver(key)).toThrow("INVALID_ANNOTATION_HMAC_KEY");
    },
  );

  it("rejects noncanonical room and page identity input", () => {
    const deriver = new AnnotationPageKeyDeriver(new Uint8Array(32).fill(9));

    expect(() =>
      deriver.derive({
        roomId: "not-a-room",
        canonicalPageIdentity,
      }),
    ).toThrow("INVALID_ANNOTATION_PAGE_IDENTITY");
    expect(() =>
      deriver.derive({
        roomId,
        canonicalPageIdentity: "https://example.com/private",
      }),
    ).toThrow("INVALID_ANNOTATION_PAGE_IDENTITY");
  });
});
