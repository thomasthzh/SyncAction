import { describe, expect, it } from "vitest";
import { projectDocumentFeatureAccess } from "../src/page-access-policy.js";

describe("projectDocumentFeatureAccess", () => {
  it("enables every page feature only for an exact consented document", () => {
    expect(
      projectDocumentFeatureAccess({
        grantEffective: true,
        documentRevision: { roomEpoch: 3, tabUpdatedAtSeq: 18 },
        contentCompatibility: "EXACT",
      }),
    ).toEqual({
      enabledFeatures: ["POINTER", "DANMAKU", "DRAWING", "MEDIA_CONTROL"],
      contentReason: null,
    });
  });

  it.each([
    ["MISMATCH", "CONTENT_MISMATCH"],
    ["UNKNOWN", "CONTENT_UNKNOWN"],
    [null, "CONTENT_UNKNOWN"],
  ] as const)(
    "keeps only non-positional danmaku available for %s content",
    (contentCompatibility, contentReason) => {
      expect(
        projectDocumentFeatureAccess({
          grantEffective: true,
          documentRevision: { roomEpoch: 3, tabUpdatedAtSeq: 18 },
          contentCompatibility,
        }),
      ).toEqual({
        enabledFeatures: ["DANMAKU"],
        contentReason,
      });
    },
  );

  it("enables nothing before both grant and room document are usable", () => {
    expect(
      projectDocumentFeatureAccess({
        grantEffective: false,
        documentRevision: { roomEpoch: 3, tabUpdatedAtSeq: 18 },
        contentCompatibility: "EXACT",
      }),
    ).toEqual({ enabledFeatures: [], contentReason: null });
    expect(
      projectDocumentFeatureAccess({
        grantEffective: true,
        documentRevision: null,
        contentCompatibility: null,
      }),
    ).toEqual({ enabledFeatures: [], contentReason: null });
  });
});
