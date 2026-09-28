import {
  ContentSignatureSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  PageCompatibilityReportSchema,
  RoomIdSchema,
  type ContentSignature,
  type DocumentRevision,
  type MediaIdentity,
  type PageCompatibilityReport,
} from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import {
  ContentCompatibilityController,
  type CapabilityDecision,
  type CompatibilityScope,
  type PositionalCapability,
} from "../src/content-compatibility-controller.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b01");
const otherRoomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b02");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b03");
const otherLogicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b04");
const remoteUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b05";
const remoteDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b06");
const otherDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b07");
const revision = { roomEpoch: 3, tabUpdatedAtSeq: 11 } satisfies DocumentRevision;
const newerRevision = { roomEpoch: 3, tabUpdatedAtSeq: 12 } satisfies DocumentRevision;
const media = { provider: "YOUTUBE", mediaKey: "youtube:dQw4w9WgXcQ" } satisfies MediaIdentity;
const otherMedia = {
  provider: "YOUTUBE",
  mediaKey: "youtube:aqz-KE-bpKQ",
} satisfies MediaIdentity;
const signatureA = ContentSignatureSchema.parse({
  signatureVersion: 1,
  digest: "A".repeat(43),
});
const signatureB = ContentSignatureSchema.parse({
  signatureVersion: 1,
  digest: "B".repeat(43),
});
const signatureV2 = ContentSignatureSchema.parse({
  signatureVersion: 2,
  digest: "A".repeat(43),
});
const anchorA = ContentSignatureSchema.parse({
  signatureVersion: 1,
  digest: "C".repeat(43),
});
const anchorB = ContentSignatureSchema.parse({
  signatureVersion: 1,
  digest: "D".repeat(43),
});

describe("ContentCompatibilityController", () => {
  it("classifies only matching canonical identities and current versioned digests", () => {
    const controller = controllerWithLocal(signatureA);

    expect(
      addRemoteAndClassify(controller, {
        deviceId: remoteDeviceId,
        signature: signatureA,
      }),
    ).toBe("EXACT");
    expect(
      addRemoteAndClassify(controller, {
        deviceId: otherDeviceId,
        signature: signatureB,
      }),
    ).toBe("MISMATCH");
    expect(
      addRemoteAndClassify(controller, {
        deviceId: remoteDeviceId,
        signature: null,
      }),
    ).toBe("UNKNOWN");
    expect(
      addRemoteAndClassify(controller, {
        deviceId: remoteDeviceId,
        signature: signatureV2,
      }),
    ).toBe("UNKNOWN");
    expect(
      addRemoteAndClassify(controller, {
        deviceId: remoteDeviceId,
        signature: signatureA,
        canonicalPageIdentity: "https://example.com/another",
      }),
    ).toBe("UNKNOWN");
  });

  it("applies the exact centralized capability matrix", () => {
    const controller = controllerWithLocal(signatureA);
    const exact = registerRemote(controller, remoteDeviceId, signatureA);
    const mismatch = registerRemote(controller, otherDeviceId, signatureB);
    const unknownDevice = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b08");
    const unknown = registerRemote(controller, unknownDevice, null);

    const capabilities: PositionalCapability[] = [
      "TAB_LIFECYCLE",
      "MEMBER_PAGE_PRESENCE",
      "KNOWN_MEDIA_SYNC",
      "REMOTE_POINTER",
      "ROOT_DRAWING",
      "ELEMENT_DRAWING",
      "BOTTOM_DANMAKU",
      "SCROLL_FOLLOW",
    ];
    const expected: Record<
      PositionalCapability,
      [CapabilityDecision, CapabilityDecision, CapabilityDecision]
    > = {
      TAB_LIFECYCLE: [
        decision(true, "EXACT", null),
        decision(true, "MISMATCH", null),
        decision(true, "UNKNOWN", null),
      ],
      MEMBER_PAGE_PRESENCE: [
        decision(true, "EXACT", null),
        decision(true, "MISMATCH", "CONTENT_MISMATCH"),
        decision(true, "UNKNOWN", "CONTENT_UNKNOWN"),
      ],
      KNOWN_MEDIA_SYNC: [
        decision(true, "EXACT", null),
        decision(true, "MISMATCH", "CONTENT_MISMATCH"),
        decision(true, "UNKNOWN", "CONTENT_UNKNOWN"),
      ],
      REMOTE_POINTER: [
        decision(true, "EXACT", null),
        decision(false, "MISMATCH", "CONTENT_MISMATCH"),
        decision(false, "UNKNOWN", "CONTENT_UNKNOWN"),
      ],
      ROOT_DRAWING: [
        decision(true, "EXACT", null),
        decision(false, "MISMATCH", "CONTENT_MISMATCH"),
        decision(false, "UNKNOWN", "CONTENT_UNKNOWN"),
      ],
      ELEMENT_DRAWING: [
        decision(true, "EXACT", null),
        decision(true, "MISMATCH", "CONTENT_MISMATCH"),
        decision(false, "UNKNOWN", "CONTENT_UNKNOWN"),
      ],
      BOTTOM_DANMAKU: [
        decision(true, "EXACT", null),
        decision(true, "MISMATCH", null),
        decision(true, "UNKNOWN", null),
      ],
      SCROLL_FOLLOW: [
        decision(true, "EXACT", null),
        decision(false, "MISMATCH", "CONTENT_MISMATCH"),
        decision(false, "UNKNOWN", "CONTENT_UNKNOWN"),
      ],
    };

    for (const capability of capabilities) {
      const evidence =
        capability === "ELEMENT_DRAWING"
          ? { localAnchorSignature: anchorA, remoteAnchorSignature: anchorA }
          : undefined;
      expect([
        controller.decide({
          capability,
          scope: exact,
          ...(evidence === undefined ? {} : { evidence }),
        }),
        controller.decide({
          capability,
          scope: mismatch,
          ...(evidence === undefined ? {} : { evidence }),
        }),
        controller.decide({
          capability,
          scope: unknown,
          ...(evidence === undefined ? {} : { evidence }),
        }),
      ]).toEqual(expected[capability]);
    }

    expect(
      controller.decide({
        capability: "ELEMENT_DRAWING",
        scope: exact,
        evidence: { localAnchorSignature: anchorA, remoteAnchorSignature: anchorB },
      }),
    ).toEqual(decision(false, "EXACT", "CONTENT_MISMATCH"));
  });

  it("allows only an exactly matching known media identity under every content state", () => {
    const controller = controllerWithLocal(signatureA, media);
    const exact = registerRemote(controller, remoteDeviceId, signatureA, media);
    const mismatch = registerRemote(controller, otherDeviceId, signatureB, media);
    const unknownDevice = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b08");
    const unknown = registerRemote(controller, unknownDevice, null, media);

    expect(controller.decide({ capability: "KNOWN_MEDIA_SYNC", scope: exact }).allowed).toBe(true);
    expect(controller.decide({ capability: "KNOWN_MEDIA_SYNC", scope: mismatch }).allowed).toBe(
      true,
    );
    expect(controller.decide({ capability: "KNOWN_MEDIA_SYNC", scope: unknown }).allowed).toBe(
      true,
    );

    const differentDevice = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b09");
    const different = registerRemote(controller, differentDevice, signatureA, otherMedia);
    expect(controller.decide({ capability: "KNOWN_MEDIA_SYNC", scope: different })).toEqual(
      decision(false, "EXACT", "MEDIA_MISMATCH"),
    );
  });

  it("scopes reports by room, tab, revision, account, and device", () => {
    const controller = controllerWithLocal(signatureA);
    const scope = registerRemote(controller, remoteDeviceId, signatureA);

    expect(controller.classify(scope)).toBe("EXACT");
    expect(controller.classify({ ...scope, roomId: otherRoomId })).toBe("UNKNOWN");
    expect(controller.classify({ ...scope, logicalTabId: otherLogicalTabId })).toBe("UNKNOWN");
    expect(controller.classify({ ...scope, documentRevision: newerRevision })).toBe("UNKNOWN");
    expect(
      controller.classify({
        ...scope,
        remoteUserId: "018f8f8e-4b5c-7d6e-8f90-123456789b10",
      }),
    ).toBe("UNKNOWN");
    expect(controller.classify({ ...scope, remoteDeviceId: otherDeviceId })).toBe("UNKNOWN");
  });

  it("purges replaced documents and rooms and ignores stale reports", () => {
    const controller = new ContentCompatibilityController();
    controller.upsertLocalReport({
      roomId,
      report: report(signatureA, newerRevision),
    });
    expect(
      controller.upsertRemoteReport({
        roomId,
        remoteUserId,
        remoteDeviceId,
        report: report(signatureA, newerRevision),
      }),
    ).toBe(true);
    expect(
      controller.upsertRemoteReport({
        roomId,
        remoteUserId,
        remoteDeviceId,
        report: report(signatureB, revision),
      }),
    ).toBe(false);

    const scope = compatibilityScope(remoteDeviceId, newerRevision);
    expect(controller.classify(scope)).toBe("EXACT");
    controller.clearDocument({ roomId, logicalTabId });
    expect(controller.classify(scope)).toBe("UNKNOWN");

    controller.upsertLocalReport({ roomId, report: report(signatureA, newerRevision) });
    controller.upsertRemoteReport({
      roomId,
      remoteUserId,
      remoteDeviceId,
      report: report(signatureA, newerRevision),
    });
    controller.leaveRoom(roomId);
    expect(controller.classify(scope)).toBe("UNKNOWN");
  });
});

function controllerWithLocal(
  signature: ContentSignature | null,
  mediaIdentity: MediaIdentity | null = media,
): ContentCompatibilityController {
  const controller = new ContentCompatibilityController();
  controller.upsertLocalReport({
    roomId,
    report: report(signature, revision, mediaIdentity),
  });
  return controller;
}

function registerRemote(
  controller: ContentCompatibilityController,
  deviceId: typeof remoteDeviceId,
  signature: ContentSignature | null,
  mediaIdentity: MediaIdentity | null = media,
): CompatibilityScope {
  controller.upsertRemoteReport({
    roomId,
    remoteUserId,
    remoteDeviceId: deviceId,
    report: report(signature, revision, mediaIdentity),
  });
  return compatibilityScope(deviceId, revision);
}

function addRemoteAndClassify(
  controller: ContentCompatibilityController,
  options: {
    deviceId: typeof remoteDeviceId;
    signature: ContentSignature | null;
    canonicalPageIdentity?: string;
  },
) {
  controller.upsertRemoteReport({
    roomId,
    remoteUserId,
    remoteDeviceId: options.deviceId,
    report: report(
      options.signature,
      revision,
      media,
      options.canonicalPageIdentity ?? "https://example.com/article",
    ),
  });
  return controller.classify(compatibilityScope(options.deviceId, revision));
}

function compatibilityScope(
  deviceId: typeof remoteDeviceId,
  documentRevision: DocumentRevision,
): CompatibilityScope {
  return {
    roomId,
    logicalTabId,
    documentRevision,
    remoteUserId,
    remoteDeviceId: deviceId,
  };
}

function report(
  signature: ContentSignature | null,
  documentRevision: DocumentRevision,
  mediaIdentity: MediaIdentity | null = media,
  canonicalPageIdentity = "https://example.com/article",
): PageCompatibilityReport {
  return PageCompatibilityReportSchema.parse({
    type: "page.compatibility.report",
    protocolVersion: 1,
    logicalTabId,
    contentContext: {
      documentRevision,
      canonicalPageIdentity,
      contentSignature: signature,
      media: mediaIdentity,
    },
  });
}

function decision(
  allowed: boolean,
  compatibility: CapabilityDecision["compatibility"],
  reason: CapabilityDecision["reason"],
): CapabilityDecision {
  return { allowed, compatibility, reason };
}
