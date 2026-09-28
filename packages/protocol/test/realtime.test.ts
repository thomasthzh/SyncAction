import { describe, expect, it } from "vitest";
import {
  ContentSignatureSchema,
  PointerFrameEventSchema,
  PointerFrameSchema,
  PointerLeaseAckSchema,
  PointerLeaseClearSchema,
  PointerLeaseEventSchema,
  PointerLeaseSnapshotSchema,
  PointerLeaseUpdateSchema,
  PresenceDeltaMessageSchema,
  PresenceSnapshotV2MessageSchema,
  PresenceUpdateV2Schema,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-4d6e-8f90-123456789e01";
const logicalTabId = "018f8f8e-4b5c-4d6e-8f90-123456789e02";
const userId = "018f8f8e-4b5c-4d6e-8f90-123456789e03";
const otherUserId = "018f8f8e-4b5c-4d6e-8f90-123456789e04";
const deviceId = "018f8f8e-4b5c-4d6e-8f90-123456789e05";
const otherDeviceId = "018f8f8e-4b5c-4d6e-8f90-123456789e06";
const leaseId = "018f8f8e-4b5c-4d6e-8f90-123456789e07";
const otherLeaseId = "018f8f8e-4b5c-4d6e-8f90-123456789e08";
const documentRevision = { roomEpoch: 0, tabUpdatedAtSeq: 12 };
const anchor = {
  path: [{ tagName: "main", nthOfType: 1 }],
  x: 0.25,
  y: 0.75,
};
const contentSignature = {
  signatureVersion: 1 as const,
  digest: "A".repeat(43),
};
const contentContext = {
  documentRevision,
  canonicalPageIdentity: "youtube:watch:dQw4w9WgXcQ",
  contentSignature,
  media: {
    provider: "YOUTUBE" as const,
    mediaKey: "youtube:dQw4w9WgXcQ",
  },
};
const presence = {
  userId,
  username: "alex",
  displayName: "Alex",
  deviceId,
  logicalTabId,
  expiresAt: 1_800_000_000_000,
  contentContext,
};
const otherPresence = {
  ...presence,
  userId: otherUserId,
  username: "lin",
  displayName: "林岚",
  deviceId: otherDeviceId,
  contentContext: {
    ...contentContext,
    contentSignature: null,
    media: null,
  },
};
const lease = {
  userId,
  deviceId,
  leaseId,
  username: "alex",
  displayName: "Alex",
  color: "#246bfd",
  logicalTabId,
  documentRevision,
  anchor,
  expiresAt: 1_800_000_000_000,
};

describe("presence v2 realtime contracts", () => {
  it("parses strict updates, snapshots, and contiguous upsert/remove deltas", () => {
    const update = {
      type: "presence.update.v2" as const,
      protocolVersion: 1 as const,
      roomId,
      logicalTabId,
      contentContext,
    };
    const snapshot = {
      type: "presence.snapshot.v2" as const,
      protocolVersion: 1 as const,
      roomId,
      presenceSeq: 4,
      presences: [presence, otherPresence],
    };
    const delta = {
      type: "presence.delta.v2" as const,
      protocolVersion: 1 as const,
      roomId,
      fromPresenceSeq: 4,
      toPresenceSeq: 6,
      changes: [
        { kind: "UPSERT" as const, presence },
        {
          kind: "REMOVE" as const,
          userId: otherUserId,
          deviceId: otherDeviceId,
        },
      ],
    };

    expect(PresenceUpdateV2Schema.parse(update)).toEqual(update);
    expect(PresenceSnapshotV2MessageSchema.parse(snapshot)).toEqual(snapshot);
    expect(PresenceDeltaMessageSchema.parse(delta)).toEqual(delta);
    expect(ContentSignatureSchema.parse(contentSignature)).toEqual(contentSignature);
  });

  it("requires matching active-tab context and privacy-limited strict fields", () => {
    expect(() =>
      PresenceUpdateV2Schema.parse({
        type: "presence.update.v2",
        protocolVersion: 1,
        roomId,
        logicalTabId: null,
        contentContext,
      }),
    ).toThrow();
    expect(() =>
      PresenceUpdateV2Schema.parse({
        type: "presence.update.v2",
        protocolVersion: 1,
        roomId,
        logicalTabId,
        contentContext: null,
      }),
    ).toThrow();
    expect(() =>
      PresenceUpdateV2Schema.parse({
        type: "presence.update.v2",
        protocolVersion: 1,
        roomId,
        logicalTabId,
        contentContext: { ...contentContext, rawUrl: "https://private.example/watch" },
      }),
    ).toThrow();
    expect(() =>
      ContentSignatureSchema.parse({ ...contentSignature, digest: "A".repeat(42) }),
    ).toThrow();
    expect(() =>
      ContentSignatureSchema.parse({ ...contentSignature, digest: `${"A".repeat(42)}+` }),
    ).toThrow();
  });

  it("rejects duplicate identities and noncontiguous or reversed sequence bounds", () => {
    expect(() =>
      PresenceSnapshotV2MessageSchema.parse({
        type: "presence.snapshot.v2",
        protocolVersion: 1,
        roomId,
        presenceSeq: 1,
        presences: [presence, presence],
      }),
    ).toThrow();
    expect(() =>
      PresenceDeltaMessageSchema.parse({
        type: "presence.delta.v2",
        protocolVersion: 1,
        roomId,
        fromPresenceSeq: 5,
        toPresenceSeq: 4,
        changes: [{ kind: "UPSERT", presence }],
      }),
    ).toThrow();
    expect(() =>
      PresenceDeltaMessageSchema.parse({
        type: "presence.delta.v2",
        protocolVersion: 1,
        roomId,
        fromPresenceSeq: 4,
        toPresenceSeq: 7,
        changes: [{ kind: "UPSERT", presence }],
      }),
    ).toThrow();
    expect(() =>
      PresenceDeltaMessageSchema.parse({
        type: "presence.delta.v2",
        protocolVersion: 1,
        roomId,
        fromPresenceSeq: 4,
        toPresenceSeq: 5,
        changes: [
          {
            kind: "REMOVE",
            userId,
            deviceId,
            expiresAt: 1_800_000_000_000,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("pointer lease and volatile frame contracts", () => {
  it("parses reliable lease lifecycle messages and lease-only snapshots", () => {
    const update = {
      type: "pointer.lease" as const,
      protocolVersion: 1 as const,
      roomId,
      deviceId,
      leaseId,
      logicalTabId,
      documentRevision,
      anchor,
    };
    const acknowledgement = {
      type: "pointer.lease.ack" as const,
      protocolVersion: 1 as const,
      roomId,
      leaseId,
      accepted: true,
      expiresAt: lease.expiresAt,
    };
    const event = {
      type: "pointer.lease.event" as const,
      protocolVersion: 1 as const,
      roomId,
      lease,
    };
    const clear = {
      type: "pointer.lease.clear" as const,
      protocolVersion: 1 as const,
      roomId,
      userId,
      deviceId,
      leaseId,
    };
    const snapshot = {
      type: "pointer.lease.snapshot" as const,
      protocolVersion: 1 as const,
      roomId,
      leases: [lease],
    };

    expect(PointerLeaseUpdateSchema.parse(update)).toEqual(update);
    expect(PointerLeaseAckSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(PointerLeaseEventSchema.parse(event)).toEqual(event);
    expect(PointerLeaseClearSchema.parse(clear)).toEqual(clear);
    expect(PointerLeaseSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("parses quantized client frames and authenticated server frame events", () => {
    const frame = {
      type: "pointer.frame" as const,
      protocolVersion: 1 as const,
      roomId,
      leaseId,
      seq: 12,
      xQuantized: 1_024,
      yQuantized: 3_071,
      viewport: { widthBucket: 8, heightBucket: 5 },
      sentAtClientMs: 1_700_000_000_000,
    };
    const event = {
      ...frame,
      userId,
      deviceId,
      receivedAtServerMs: 1_700_000_000_125,
    };
    delete (event as Partial<typeof frame>).sentAtClientMs;

    expect(PointerFrameSchema.parse(frame)).toEqual(frame);
    expect(PointerFrameEventSchema.parse(event)).toEqual(event);
  });

  it("rejects invalid frames, contradictory acknowledgements, and unknown fields", () => {
    const frame = {
      type: "pointer.frame",
      protocolVersion: 1,
      roomId,
      leaseId,
      seq: 1,
      xQuantized: 0,
      yQuantized: 4_095,
      viewport: { widthBucket: 1, heightBucket: 64 },
      sentAtClientMs: 1_700_000_000_000,
    };
    expect(() => PointerFrameSchema.parse({ ...frame, seq: 0 })).toThrow();
    expect(() => PointerFrameSchema.parse({ ...frame, xQuantized: -1 })).toThrow();
    expect(() => PointerFrameSchema.parse({ ...frame, yQuantized: 4_096 })).toThrow();
    expect(() =>
      PointerFrameSchema.parse({ ...frame, viewport: { widthBucket: 0, heightBucket: 64 } }),
    ).toThrow();
    expect(() => PointerFrameSchema.parse({ ...frame, x: 0.5 })).toThrow();
    expect(() =>
      PointerLeaseAckSchema.parse({
        type: "pointer.lease.ack",
        protocolVersion: 1,
        roomId,
        leaseId,
        accepted: false,
        expiresAt: 1_800_000_000_000,
      }),
    ).toThrow();
  });

  it("rejects duplicate account/device or lease identities in a snapshot", () => {
    expect(() =>
      PointerLeaseSnapshotSchema.parse({
        type: "pointer.lease.snapshot",
        protocolVersion: 1,
        roomId,
        leases: [lease, { ...lease, leaseId: otherLeaseId }],
      }),
    ).toThrow();
    expect(() =>
      PointerLeaseSnapshotSchema.parse({
        type: "pointer.lease.snapshot",
        protocolVersion: 1,
        roomId,
        leases: [
          lease,
          {
            ...lease,
            userId: otherUserId,
            deviceId: otherDeviceId,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      PointerLeaseSnapshotSchema.parse({
        type: "pointer.lease.snapshot",
        protocolVersion: 1,
        roomId,
        leases: [{ ...lease, expiresAt: 0 }],
      }),
    ).toThrow();
  });
});
