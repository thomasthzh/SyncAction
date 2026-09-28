import { describe, expect, it } from "vitest";
import {
  AnnotationAckSchema,
  AnnotationAnchorSchema,
  AnnotationCommittedOperationSchema,
  AnnotationDeltaMessageSchema,
  AnnotationOperationSchema,
  AnnotationSnapshotMessageSchema,
  AnnotationStrokeSchema,
  AnnotationSubmitSchema,
  AnnotationSyncRequestSchema,
  DanmakuAckSchema,
  DanmakuEventMessageSchema,
  DanmakuSendSchema,
  DurableOperationSchema,
  ExactDocumentIdentitySchema,
  NormalizedPointSchema,
  ServerMessageSchema,
  serializedAnnotationStrokeBytes,
  StrokePreviewClearMessageSchema,
  StrokePreviewClearSchema,
  StrokePreviewEventMessageSchema,
  StrokePreviewUpdateSchema,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789a01";
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789a02";
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789a03";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789a04";
const strokeId = "018f8f8e-4b5c-7d6e-8f90-123456789a05";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789a06";
const previewId = "018f8f8e-4b5c-7d6e-8f90-123456789a07";
const messageId = "018f8f8e-4b5c-7d6e-8f90-123456789a08";
const secondStrokeId = "018f8f8e-4b5c-7d6e-8f90-123456789a09";
const pageKey = "A".repeat(43);
const serverTimestamp = 1_722_000_000_000;

const documentIdentity = {
  roomId,
  logicalTabId,
  documentRevision: {
    roomEpoch: 2,
    tabUpdatedAtSeq: 7,
  },
  frameKey: "top",
} as const;

const elementAnchor = {
  type: "element",
  path: [
    { tagName: "main", nthOfType: 1 },
    { tagName: "article", nthOfType: 2 },
  ],
} as const;
const mediaAnchor = {
  type: "media",
  provider: "YOUTUBE",
  mediaKey: "youtube:dQw4w9WgXcQ",
} as const;
const documentAnchor = {
  type: "document",
  layoutSignature: {
    widthCssPx: 1_440,
    heightCssPx: 5_000,
  },
} as const;
const points = [
  { x: 0.1, y: 0.2, pressure: 0.5 },
  { x: 0.2, y: 0.3, pressure: 0.7 },
] as const;
const rgb = { r: 31, g: 140, b: 255 } as const;
const strokeDraft = {
  strokeId,
  frameKey: "top",
  anchor: elementAnchor,
  points,
  rgb,
  width: 5,
} as const;
const stroke = {
  ...strokeDraft,
  authorUserId: userId,
  lockedAtServerMs: null,
  version: 1,
  createdAtServerMs: serverTimestamp,
  deletedAtServerMs: null,
} as const;
const createOperation = {
  type: "stroke.create",
  stroke: strokeDraft,
} as const;
const acceptedCreateResult = {
  strokeId,
  accepted: true,
  code: null,
  version: 1,
} as const;
const committed = {
  type: "annotation.committed",
  protocolVersion: 1,
  clientOpId,
  roomId,
  pageKey,
  annotationSeq: 1,
  actorUserId: userId,
  operation: createOperation,
  results: [acceptedCreateResult],
  createdAtServerMs: serverTimestamp,
} as const;

const sender = {
  userId,
  username: "alex",
  displayName: "Alex",
  deviceId,
} as const;

describe("exact collaboration document identity", () => {
  it("accepts only a server-reconcilable room, tab, revision, and stable frame", () => {
    expect(ExactDocumentIdentitySchema.parse(documentIdentity)).toEqual(documentIdentity);
    expect(() =>
      ExactDocumentIdentitySchema.parse({
        ...documentIdentity,
        url: "https://example.com/private",
      }),
    ).toThrow();
    expect(() =>
      ExactDocumentIdentitySchema.parse({
        ...documentIdentity,
        pageTitle: "private title",
      }),
    ).toThrow();
    expect(() =>
      ExactDocumentIdentitySchema.parse({
        ...documentIdentity,
        frameKey: "frame:2",
      }),
    ).toThrow();
  });
});

describe("annotation geometry", () => {
  it("uses one UTF-8 geometry byte count for drafts and confirmed strokes", () => {
    const expected = new TextEncoder().encode(JSON.stringify(strokeDraft)).byteLength;
    expect(serializedAnnotationStrokeBytes(strokeDraft)).toBe(expected);
    expect(serializedAnnotationStrokeBytes(stroke)).toBe(expected);
  });

  it("accepts media, privacy-safe element, and document-root anchors", () => {
    for (const anchor of [mediaAnchor, elementAnchor, documentAnchor]) {
      expect(AnnotationAnchorSchema.parse(anchor)).toEqual(anchor);
    }
  });

  it("rejects content-bearing or over-deep element anchors", () => {
    expect(() =>
      AnnotationAnchorSchema.parse({
        type: "element",
        path: Array.from({ length: 13 }, () => ({ tagName: "div", nthOfType: 1 })),
      }),
    ).toThrow();

    for (const privateField of [
      { id: "account" },
      { className: "premium" },
      { text: "secret" },
      { ariaLabel: "private" },
    ]) {
      expect(() =>
        AnnotationAnchorSchema.parse({
          type: "element",
          path: [{ tagName: "div", nthOfType: 1, ...privateField }],
        }),
      ).toThrow();
    }
  });

  it.each([
    { x: -0.001, y: 0.5, pressure: 0.5 },
    { x: 1.001, y: 0.5, pressure: 0.5 },
    { x: 0.5, y: -0.001, pressure: 0.5 },
    { x: 0.5, y: 1.001, pressure: 0.5 },
    { x: 0.5, y: 0.5, pressure: -0.001 },
    { x: 0.5, y: 0.5, pressure: 1.001 },
  ])("rejects an out-of-range normalized point %#", (point) => {
    expect(() => NormalizedPointSchema.parse(point)).toThrow();
  });

  it("rejects point, color, width, and serialized-size overflow", () => {
    expect(() =>
      AnnotationOperationSchema.parse({
        ...createOperation,
        stroke: {
          ...strokeDraft,
          points: Array.from({ length: 2_049 }, () => ({
            x: 0.123_456_789,
            y: 0.987_654_321,
            pressure: 0.555_555_555,
          })),
        },
      }),
    ).toThrow();

    for (const invalidRgb of [
      { r: -1, g: 0, b: 0 },
      { r: 0, g: 256, b: 0 },
      { r: 0.5, g: 0, b: 0 },
    ]) {
      expect(() =>
        AnnotationOperationSchema.parse({
          ...createOperation,
          stroke: { ...strokeDraft, rgb: invalidRgb },
        }),
      ).toThrow();
    }

    for (const width of [0.99, 32.01, Number.POSITIVE_INFINITY]) {
      expect(() =>
        AnnotationOperationSchema.parse({
          ...createOperation,
          stroke: { ...strokeDraft, width },
        }),
      ).toThrow();
    }

    expect(() =>
      AnnotationOperationSchema.parse({
        ...createOperation,
        stroke: {
          ...strokeDraft,
          points: Array.from({ length: 2_048 }, (_, index) => ({
            x: index / 2_047,
            y: 0.987_654_321_012_345_6,
            pressure: 0.555_555_555_555_555_6,
          })),
        },
      }),
    ).toThrow();
  });

  it("parses a materialized stroke without accepting arbitrary page metadata", () => {
    expect(AnnotationStrokeSchema.parse(stroke)).toEqual(stroke);
    expect(() =>
      AnnotationStrokeSchema.parse({
        ...stroke,
        url: "https://example.com/private",
      }),
    ).toThrow();
  });
});

describe("durable page annotation protocol", () => {
  it("parses create and batch mutation operations with per-item versions", () => {
    expect(AnnotationOperationSchema.parse(createOperation)).toEqual(createOperation);
    for (const type of ["stroke.delete", "stroke.lock", "stroke.unlock"] as const) {
      const operation = {
        type,
        items: [
          { strokeId, expectedVersion: 1 },
          { strokeId: secondStrokeId, expectedVersion: 4 },
        ],
      };
      expect(AnnotationOperationSchema.parse(operation)).toEqual(operation);
    }
  });

  it("keeps annotation submission out of the durable tab operation family", () => {
    const submission = {
      protocolVersion: 1,
      clientOpId,
      ...documentIdentity,
      pageKey,
      baseAnnotationSeq: 0,
      operation: createOperation,
    } as const;

    expect(AnnotationSubmitSchema.parse(submission)).toEqual(submission);
    expect(() => DurableOperationSchema.parse(createOperation)).toThrow();
    expect(() =>
      AnnotationSubmitSchema.parse({
        ...submission,
        pageKey: "https://example.com/private",
      }),
    ).toThrow();
  });

  it("keeps every legacy annotation shape strict against v2 signature fields", () => {
    const submission = {
      protocolVersion: 1,
      clientOpId,
      ...documentIdentity,
      pageKey,
      baseAnnotationSeq: 0,
      operation: createOperation,
    } as const;

    expect(() =>
      AnnotationSubmitSchema.parse({
        ...submission,
        type: "annotation.submit.v2",
      }),
    ).toThrow();
    expect(() =>
      AnnotationSubmitSchema.parse({
        ...submission,
        operation: {
          ...createOperation,
          stroke: {
            ...strokeDraft,
            contentSignature: {
              signatureVersion: 1,
              digest: "A".repeat(43),
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      AnnotationAnchorSchema.parse({
        ...elementAnchor,
        anchorSignature: {
          signatureVersion: 1,
          digest: "B".repeat(43),
        },
      }),
    ).toThrow();
  });

  it("rejects duplicate batch targets", () => {
    expect(() =>
      AnnotationOperationSchema.parse({
        type: "stroke.lock",
        items: [
          { strokeId, expectedVersion: 1 },
          { strokeId, expectedVersion: 1 },
        ],
      }),
    ).toThrow();
  });

  it("parses sync, snapshot, contiguous delta, committed event, and ACK", () => {
    const sync = {
      protocolVersion: 1,
      ...documentIdentity,
      lastAnnotationSeq: 0,
      hasConfirmedSnapshot: false,
    } as const;
    const snapshot = {
      type: "annotation.snapshot",
      protocolVersion: 1,
      ...documentIdentity,
      pageKey,
      annotationSeq: 1,
      strokes: [stroke],
    } as const;
    const delta = {
      type: "annotation.delta",
      protocolVersion: 1,
      ...documentIdentity,
      pageKey,
      fromAnnotationSeq: 0,
      toAnnotationSeq: 1,
      operations: [committed],
    } as const;
    const acknowledgement = {
      type: "annotation.ack",
      protocolVersion: 1,
      clientOpId,
      roomId,
      accepted: true,
      code: null,
      pageKey,
      annotationSeq: 1,
      results: [acceptedCreateResult],
    } as const;

    expect(AnnotationSyncRequestSchema.parse(sync)).toEqual(sync);
    expect(AnnotationSnapshotMessageSchema.parse(snapshot)).toEqual(snapshot);
    expect(AnnotationDeltaMessageSchema.parse(delta)).toEqual(delta);
    expect(AnnotationCommittedOperationSchema.parse(committed)).toEqual(committed);
    expect(AnnotationAckSchema.parse(acknowledgement)).toEqual(acknowledgement);

    for (const message of [snapshot, delta, committed, acknowledgement]) {
      expect(ServerMessageSchema.parse(message)).toEqual(message);
    }
  });

  it("rejects duplicate stroke and operation identities", () => {
    expect(() =>
      AnnotationSnapshotMessageSchema.parse({
        type: "annotation.snapshot",
        protocolVersion: 1,
        ...documentIdentity,
        pageKey,
        annotationSeq: 1,
        strokes: [stroke, stroke],
      }),
    ).toThrow();

    expect(() =>
      AnnotationDeltaMessageSchema.parse({
        type: "annotation.delta",
        protocolVersion: 1,
        ...documentIdentity,
        pageKey,
        fromAnnotationSeq: 0,
        toAnnotationSeq: 2,
        operations: [committed, committed],
      }),
    ).toThrow();
  });

  it("models rejected ACK and item conflict states without impossible fields", () => {
    const rejected = {
      type: "annotation.ack",
      protocolVersion: 1,
      clientOpId,
      roomId,
      accepted: false,
      code: "ANNOTATION_PAGE_CAPACITY_REACHED",
      pageKey,
      annotationSeq: null,
      results: [],
    } as const;
    const conflict = {
      strokeId,
      accepted: false,
      code: "STROKE_VERSION_CONFLICT",
      version: 2,
    } as const;

    expect(AnnotationAckSchema.parse(rejected)).toEqual(rejected);
    expect(() =>
      AnnotationAckSchema.parse({
        ...rejected,
        accepted: true,
        code: "ANNOTATION_PAGE_CAPACITY_REACHED",
      }),
    ).toThrow();
    expect(() =>
      AnnotationAckSchema.parse({
        ...rejected,
        accepted: false,
        annotationSeq: 2,
      }),
    ).toThrow();

    expect(
      AnnotationCommittedOperationSchema.parse({
        ...committed,
        operation: {
          type: "stroke.lock",
          items: [{ strokeId, expectedVersion: 1 }],
        },
        results: [conflict],
      }).results,
    ).toEqual([conflict]);
  });
});

describe("ephemeral stroke preview protocol", () => {
  const previewUpdate = {
    type: "stroke.preview.update",
    protocolVersion: 1,
    previewId,
    ...documentIdentity,
    anchor: documentAnchor,
    points,
    rgb,
    width: 4,
  } as const;
  const previewClear = {
    type: "stroke.preview.clear",
    protocolVersion: 1,
    previewId,
    ...documentIdentity,
  } as const;
  const previewEvent = {
    type: "stroke.preview.event",
    protocolVersion: 1,
    previewId,
    ...documentIdentity,
    sender,
    anchor: documentAnchor,
    points,
    rgb,
    width: 4,
    expiresAtServerMs: serverTimestamp + 3_000,
  } as const;
  const previewClearMessage = {
    ...previewClear,
    sender: {
      userId,
      deviceId,
    },
  } as const;

  it("parses update, explicit clear, server event, and server clear", () => {
    expect(StrokePreviewUpdateSchema.parse(previewUpdate)).toEqual(previewUpdate);
    expect(StrokePreviewClearSchema.parse(previewClear)).toEqual(previewClear);
    expect(StrokePreviewEventMessageSchema.parse(previewEvent)).toEqual(previewEvent);
    expect(StrokePreviewClearMessageSchema.parse(previewClearMessage)).toEqual(previewClearMessage);
    expect(ServerMessageSchema.parse(previewEvent)).toEqual(previewEvent);
    expect(ServerMessageSchema.parse(previewClearMessage)).toEqual(previewClearMessage);
  });

  it("rejects author-supplied identity and unknown page content", () => {
    expect(() =>
      StrokePreviewUpdateSchema.parse({
        ...previewUpdate,
        sender,
      }),
    ).toThrow();
    expect(() =>
      StrokePreviewUpdateSchema.parse({
        ...previewUpdate,
        pageTitle: "secret",
      }),
    ).toThrow();
  });
});

describe("ephemeral danmaku protocol", () => {
  const send = {
    type: "danmaku.send",
    protocolVersion: 1,
    messageId,
    ...documentIdentity,
    text: "一起看",
  } as const;
  const acknowledgement = {
    type: "danmaku.ack",
    protocolVersion: 1,
    messageId,
    roomId,
    accepted: true,
    code: null,
    sentAtServerMs: serverTimestamp,
    expiresAtServerMs: serverTimestamp + 9_000,
  } as const;
  const event = {
    type: "danmaku.event",
    protocolVersion: 1,
    messageId,
    ...documentIdentity,
    sender,
    text: "一起看",
    sentAtServerMs: serverTimestamp,
    expiresAtServerMs: serverTimestamp + 9_000,
  } as const;

  it("accepts 120 Unicode code points and server-derived events", () => {
    const unicodeText = "😀".repeat(120);
    expect(DanmakuSendSchema.parse({ ...send, text: unicodeText }).text).toBe(unicodeText);
    expect(DanmakuAckSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(DanmakuEventMessageSchema.parse(event)).toEqual(event);
    expect(ServerMessageSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(ServerMessageSchema.parse(event)).toEqual(event);
  });

  it("rejects 121 Unicode code points, blank text, unknown fields, and client sender data", () => {
    for (const candidate of [
      { ...send, text: "😀".repeat(121) },
      { ...send, text: "   " },
      { ...send, sender },
      { ...send, url: "https://example.com/private" },
    ]) {
      expect(() => DanmakuSendSchema.parse(candidate)).toThrow();
    }
  });

  it("requires a fixed nine-second event lifetime and coherent ACK variants", () => {
    expect(() =>
      DanmakuEventMessageSchema.parse({
        ...event,
        expiresAtServerMs: serverTimestamp + 9_001,
      }),
    ).toThrow();
    expect(() =>
      DanmakuAckSchema.parse({
        ...acknowledgement,
        accepted: false,
        code: "DANMAKU_RATE_LIMITED",
      }),
    ).toThrow();

    const rejected = {
      type: "danmaku.ack",
      protocolVersion: 1,
      messageId,
      roomId,
      accepted: false,
      code: "DANMAKU_RATE_LIMITED",
      sentAtServerMs: null,
      expiresAtServerMs: null,
    } as const;
    expect(DanmakuAckSchema.parse(rejected)).toEqual(rejected);
  });
});
