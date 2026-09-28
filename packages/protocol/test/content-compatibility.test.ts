import { describe, expect, it } from "vitest";
import {
  AnnotationAckSchema,
  AnnotationAckV2Schema,
  AnnotationAnchorV2Schema,
  AnnotationCommittedOperationV2Schema,
  AnnotationDeltaV2MessageSchema,
  AnnotationSnapshotV2MessageSchema,
  AnnotationStrokeDraftV2Schema,
  AnnotationStrokeV2Schema,
  AnnotationSubmitSchema,
  AnnotationSubmitV2Schema,
  ContentCompatibilitySchema,
  ContentDigestSchema,
  ContentSignatureSchema,
  PageCompatibilityReportSchema,
  serializedAnnotationStrokeBytes,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-223456789a01";
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-223456789a02";
const userId = "018f8f8e-4b5c-7d6e-8f90-223456789a03";
const strokeId = "018f8f8e-4b5c-7d6e-8f90-223456789a04";
const legacyStrokeId = "018f8f8e-4b5c-7d6e-8f90-223456789a05";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-223456789a06";
const pageKey = "P".repeat(43);
const digest = "A".repeat(43);
const anchorDigest = "B".repeat(43);
const contentSignature = {
  signatureVersion: 1,
  digest,
} as const;
const documentIdentity = {
  roomId,
  logicalTabId,
  documentRevision: {
    roomEpoch: 3,
    tabUpdatedAtSeq: 7,
  },
  frameKey: "top",
} as const;
const elementAnchorV2 = {
  type: "element",
  path: [
    { tagName: "main", nthOfType: 1 },
    { tagName: "article", nthOfType: 2 },
  ],
  anchorSignature: {
    signatureVersion: 1,
    digest: anchorDigest,
  },
} as const;
const points = [
  { x: 0.1, y: 0.2, pressure: 0.5 },
  { x: 0.2, y: 0.3, pressure: 0.7 },
] as const;
const strokeDraftV2 = {
  strokeId,
  frameKey: "top",
  anchor: elementAnchorV2,
  points,
  rgb: { r: 20, g: 120, b: 240 },
  width: 5,
  contentSignature,
} as const;
const createOperationV2 = {
  type: "stroke.create",
  stroke: strokeDraftV2,
} as const;
const acceptedResult = {
  strokeId,
  accepted: true,
  code: null,
  version: 1,
} as const;
const committedV2 = {
  type: "annotation.committed.v2",
  protocolVersion: 1,
  clientOpId,
  roomId,
  pageKey,
  annotationSeq: 1,
  actorUserId: userId,
  operation: createOperationV2,
  results: [acceptedResult],
  createdAtServerMs: 1_785_120_000_000,
} as const;

describe("content compatibility contracts", () => {
  it("accepts only three compatibility states and a 43-character base64url digest", () => {
    for (const value of ["EXACT", "MISMATCH", "UNKNOWN"]) {
      expect(ContentCompatibilitySchema.parse(value)).toBe(value);
    }
    expect(() => ContentCompatibilitySchema.parse("PROBABLY")).toThrow();
    expect(ContentDigestSchema.parse(digest)).toBe(digest);
    for (const value of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}+`]) {
      expect(() => ContentDigestSchema.parse(value)).toThrow();
    }
  });

  it("uses a positive safe algorithm version and the existing known-media validator", () => {
    expect(
      ContentSignatureSchema.parse({
        signatureVersion: 2,
        digest,
      }),
    ).toEqual({
      signatureVersion: 2,
      digest,
    });
    for (const signatureVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        ContentSignatureSchema.parse({
          signatureVersion,
          digest,
        }),
      ).toThrow();
    }

    const report = compatibilityReport({
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
    });
    expect(PageCompatibilityReportSchema.parse(report)).toEqual(report);
    for (const media of [
      { provider: "YOUTUBE", mediaKey: "bilibili:av170001" },
      { provider: "BILIBILI", mediaKey: "youtube:dQw4w9WgXcQ" },
      { provider: "HTML5", mediaKey: "html5:space is invalid" },
    ]) {
      expect(() => PageCompatibilityReportSchema.parse(compatibilityReport(media))).toThrow();
    }
  });

  it("reports only the versioned digest, canonical identity, revision, and known media", () => {
    const report = compatibilityReport({
      provider: "HTML5",
      mediaKey: "html5:primary-video",
    });
    expect(PageCompatibilityReportSchema.parse(report)).toEqual(report);
    for (const privateSource of [
      { signatureSource: { headings: ["secret"] } },
      { bodyText: "private" },
      { dom: "<main>private</main>" },
      { urlFragment: "#account" },
    ]) {
      expect(() =>
        PageCompatibilityReportSchema.parse({
          ...report,
          ...privateSource,
        }),
      ).toThrow();
    }
  });
});

describe("additive annotation v2 contracts", () => {
  it("requires an anchor signature only for v2 element anchors", () => {
    expect(AnnotationAnchorV2Schema.parse(elementAnchorV2)).toEqual(elementAnchorV2);
    expect(() =>
      AnnotationAnchorV2Schema.parse({
        type: "element",
        path: elementAnchorV2.path,
      }),
    ).toThrow();
    for (const anchor of [
      {
        type: "document",
        layoutSignature: { widthCssPx: 1_440, heightCssPx: 4_000 },
      },
      {
        type: "media",
        provider: "YOUTUBE",
        mediaKey: "youtube:dQw4w9WgXcQ",
      },
    ]) {
      expect(AnnotationAnchorV2Schema.parse(anchor)).toEqual(anchor);
      expect(() =>
        AnnotationAnchorV2Schema.parse({
          ...anchor,
          anchorSignature: contentSignature,
        }),
      ).toThrow();
    }
  });

  it("requires signatures on new drafts while representing migrated legacy rows as null", () => {
    expect(AnnotationStrokeDraftV2Schema.parse(strokeDraftV2)).toEqual(strokeDraftV2);
    expect(() =>
      AnnotationStrokeDraftV2Schema.parse({
        ...strokeDraftV2,
        contentSignature: null,
      }),
    ).toThrow();
    expect(() =>
      AnnotationStrokeDraftV2Schema.parse({
        ...strokeDraftV2,
        anchor: {
          type: "element",
          path: elementAnchorV2.path,
        },
      }),
    ).toThrow();

    const migrated = materializedStroke({
      strokeId: legacyStrokeId,
      frameKey: "top",
      anchor: {
        type: "element",
        path: elementAnchorV2.path,
      },
      points,
      rgb: { r: 1, g: 2, b: 3 },
      width: 4,
      contentSignature: null,
    });
    expect(AnnotationStrokeV2Schema.parse(migrated)).toEqual(migrated);
    const signed = materializedStroke(strokeDraftV2);
    expect(AnnotationStrokeV2Schema.parse(signed)).toEqual(signed);
    expect(() =>
      AnnotationStrokeV2Schema.parse({
        ...signed,
        anchor: {
          type: "element",
          path: elementAnchorV2.path,
        },
      }),
    ).toThrow();
  });

  it("uses distinct strict v2 submit, snapshot, delta, committed, and ACK types", () => {
    const submit = {
      type: "annotation.submit.v2",
      protocolVersion: 1,
      clientOpId,
      ...documentIdentity,
      pageKey,
      baseAnnotationSeq: 0,
      operation: createOperationV2,
    } as const;
    const snapshot = {
      type: "annotation.snapshot.v2",
      protocolVersion: 1,
      ...documentIdentity,
      pageKey,
      annotationSeq: 1,
      strokes: [
        materializedStroke(strokeDraftV2),
        materializedStroke({
          strokeId: legacyStrokeId,
          anchor: {
            type: "document",
            layoutSignature: { widthCssPx: 1_440, heightCssPx: 4_000 },
          },
          contentSignature: null,
          points,
          frameKey: "top",
          rgb: { r: 1, g: 2, b: 3 },
          width: 4,
        }),
      ],
    } as const;
    const delta = {
      type: "annotation.delta.v2",
      protocolVersion: 1,
      ...documentIdentity,
      pageKey,
      fromAnnotationSeq: 0,
      toAnnotationSeq: 1,
      operations: [committedV2],
    } as const;
    const acknowledgement = {
      type: "annotation.ack.v2",
      protocolVersion: 1,
      clientOpId,
      roomId,
      accepted: true,
      code: null,
      pageKey,
      annotationSeq: 1,
      results: [acceptedResult],
    } as const;

    expect(AnnotationSubmitV2Schema.parse(submit)).toEqual(submit);
    expect(AnnotationCommittedOperationV2Schema.parse(committedV2)).toEqual(committedV2);
    expect(AnnotationSnapshotV2MessageSchema.parse(snapshot)).toEqual(snapshot);
    expect(AnnotationDeltaV2MessageSchema.parse(delta)).toEqual(delta);
    expect(AnnotationAckV2Schema.parse(acknowledgement)).toEqual(acknowledgement);

    expect(() => AnnotationSubmitSchema.parse(submit)).toThrow();
    expect(() => AnnotationAckSchema.parse(acknowledgement)).toThrow();
    expect(() =>
      AnnotationSubmitV2Schema.parse({
        ...submit,
        type: "annotation.submit",
      }),
    ).toThrow();
    expect(() =>
      AnnotationSnapshotV2MessageSchema.parse({
        ...snapshot,
        privateTitle: "reject",
      }),
    ).toThrow();
  });

  it("counts signature objects in the same 64 KiB serialized geometry budget", () => {
    const legacyShape = {
      ...strokeDraftV2,
    } as Record<string, unknown>;
    delete legacyShape.contentSignature;
    expect(serializedAnnotationStrokeBytes(strokeDraftV2)).toBeGreaterThan(
      serializedAnnotationStrokeBytes(
        legacyShape as Parameters<typeof serializedAnnotationStrokeBytes>[0],
      ),
    );
  });
});

function compatibilityReport(media: { provider: string; mediaKey: string }) {
  return {
    type: "page.compatibility.report",
    protocolVersion: 1,
    logicalTabId,
    contentContext: {
      documentRevision: documentIdentity.documentRevision,
      canonicalPageIdentity: "https://example.com/watch",
      contentSignature,
      media,
    },
  };
}

function materializedStroke(draft: {
  strokeId: string;
  frameKey: string;
  anchor: unknown;
  points: readonly { x: number; y: number; pressure: number }[];
  rgb: { r: number; g: number; b: number };
  width: number;
  contentSignature: typeof contentSignature | null;
}) {
  return {
    ...draft,
    authorUserId: userId,
    lockedAtServerMs: null,
    version: 1,
    createdAtServerMs: 1_785_120_000_000,
    deletedAtServerMs: null,
  };
}
