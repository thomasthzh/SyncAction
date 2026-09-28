import { describe, expect, it } from "vitest";
import {
  PointerAckSchema,
  PointerClearMessageSchema,
  PointerEventMessageSchema,
  PointerSnapshotMessageSchema,
  PointerUpdateSchema,
  PresenceAckSchema,
  PresenceSnapshotMessageSchema,
  PresenceUpdateSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  RoomSyncRequestSchema,
  ServerMessageSchema,
  SyncErrorMessageSchema,
  SupportedUrlSchema,
  type SyncErrorCode,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789d00";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789d01";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789d02";
const activeTabId = "018f8f8e-4b5c-7d6e-8f90-123456789d03";
const closedTabId = "018f8f8e-4b5c-7d6e-8f90-123456789d04";

const snapshotState = {
  roomId,
  roomEpoch: 2,
  serverSeq: 4,
  order: [activeTabId],
  tabs: [
    {
      id: activeTabId,
      url: "https://example.com/current",
      title: "Current",
      createdAtSeq: 1,
      updatedAtSeq: 4,
      closedAtSeq: null,
    },
    {
      id: closedTabId,
      url: "https://example.com/closed",
      createdAtSeq: 2,
      updatedAtSeq: 3,
      closedAtSeq: 3,
    },
  ],
};

function committed(serverSeq: number, operation: Record<string, unknown>) {
  return {
    type: "op.committed" as const,
    protocolVersion: 1 as const,
    roomId,
    roomEpoch: 2,
    deviceId,
    clientOpId: serverSeq === 1 ? clientOpId : "018f8f8e-4b5c-7d6e-8f90-123456789d05",
    serverSeq,
    operation,
  };
}

describe("room synchronization contracts", () => {
  it("parses a sync request and a complete snapshot including tombstones", () => {
    expect(
      RoomSyncRequestSchema.parse({
        protocolVersion: 1,
        roomId,
        roomEpoch: 2,
        lastServerSeq: 4,
        hasConfirmedSnapshot: true,
      }),
    ).toMatchObject({ roomId, lastServerSeq: 4 });

    const message = {
      type: "room.snapshot",
      protocolVersion: 1,
      state: snapshotState,
    };
    expect(RoomSnapshotMessageSchema.parse(message)).toEqual(message);
    expect(ServerMessageSchema.parse(message)).toEqual(message);
  });

  it("parses a sequence-zero empty snapshot", () => {
    expect(
      RoomSnapshotMessageSchema.parse({
        type: "room.snapshot",
        protocolVersion: 1,
        state: {
          roomId,
          roomEpoch: 0,
          serverSeq: 0,
          order: [],
          tabs: [],
        },
      }),
    ).toMatchObject({ state: { serverSeq: 0, tabs: [] } });
  });

  it("parses a contiguous multi-operation delta and an empty delta", () => {
    const operations = [
      committed(1, {
        type: "tab.create",
        logicalTabId: activeTabId,
        url: "https://example.com",
        after: null,
      }),
      committed(2, {
        type: "tab.navigate",
        logicalTabId: activeTabId,
        url: "https://example.com/next",
      }),
    ];
    expect(
      RoomDeltaMessageSchema.parse({
        type: "room.delta",
        protocolVersion: 1,
        roomId,
        roomEpoch: 2,
        fromServerSeq: 0,
        toServerSeq: 2,
        operations,
      }),
    ).toMatchObject({ fromServerSeq: 0, toServerSeq: 2 });
    expect(
      RoomDeltaMessageSchema.parse({
        type: "room.delta",
        protocolVersion: 1,
        roomId,
        roomEpoch: 2,
        fromServerSeq: 4,
        toServerSeq: 4,
        operations: [],
      }),
    ).toMatchObject({ operations: [] });
  });

  it.each([
    "INVALID_SYNC_MESSAGE",
    "SYNC_AUTH_REQUIRED",
    "ROOM_NOT_FOUND",
    "ROOM_EPOCH_MISMATCH",
    "DEVICE_MISMATCH",
    "BASE_SEQUENCE_AHEAD",
    "OPERATION_REJECTED",
    "CLIENT_OP_REUSE",
    "RECOVERY_REQUIRED",
    "OPERATION_RATE_LIMITED",
    "ROOM_TAB_LIMIT_REACHED",
  ] satisfies SyncErrorCode[])("parses stable error code %s", (code) => {
    const message = {
      type: "sync.error",
      protocolVersion: 1,
      code,
      roomId,
      clientOpId,
    };
    expect(SyncErrorMessageSchema.parse(message)).toEqual(message);
    expect(ServerMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects unknown fields and inconsistent delta bounds", () => {
    expect(() =>
      RoomSyncRequestSchema.parse({
        protocolVersion: 1,
        roomId,
        roomEpoch: 2,
        lastServerSeq: 4,
        hasConfirmedSnapshot: true,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      RoomDeltaMessageSchema.parse({
        type: "room.delta",
        protocolVersion: 1,
        roomId,
        roomEpoch: 2,
        fromServerSeq: 0,
        toServerSeq: 3,
        operations: [
          committed(1, {
            type: "tab.create",
            logicalTabId: activeTabId,
            url: "https://example.com",
            after: null,
          }),
        ],
      }),
    ).toThrow();
    expect(() =>
      RoomDeltaMessageSchema.parse({
        type: "room.delta",
        protocolVersion: 1,
        roomId,
        roomEpoch: 2,
        fromServerSeq: 0,
        toServerSeq: 2,
        operations: [
          committed(1, {
            type: "tab.create",
            logicalTabId: activeTabId,
            url: "https://example.com",
            after: null,
          }),
          committed(3, {
            type: "tab.navigate",
            logicalTabId: activeTabId,
            url: "https://example.com/next",
          }),
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate snapshot identities and order references to tombstones", () => {
    expect(() =>
      RoomSnapshotMessageSchema.parse({
        type: "room.snapshot",
        protocolVersion: 1,
        state: {
          ...snapshotState,
          tabs: [snapshotState.tabs[0], snapshotState.tabs[0]],
        },
      }),
    ).toThrow();
    expect(() =>
      RoomSnapshotMessageSchema.parse({
        type: "room.snapshot",
        protocolVersion: 1,
        state: {
          ...snapshotState,
          order: [activeTabId, activeTabId],
        },
      }),
    ).toThrow();
    expect(() =>
      RoomSnapshotMessageSchema.parse({
        type: "room.snapshot",
        protocolVersion: 1,
        state: {
          ...snapshotState,
          order: [activeTabId, closedTabId],
        },
      }),
    ).toThrow();
  });

  it("rejects supported URLs longer than 4096 characters", () => {
    expect(() => SupportedUrlSchema.parse(`https://example.com/${"a".repeat(4_100)}`)).toThrow();
  });
});

describe("active-tab presence contracts", () => {
  const userId = "018f8f8e-4b5c-7d6e-8f90-123456789d06";

  it("parses an online update both inside and outside shared tabs", () => {
    expect(
      PresenceUpdateSchema.parse({
        type: "presence.update",
        protocolVersion: 1,
        roomId,
        logicalTabId: activeTabId,
      }),
    ).toMatchObject({ roomId, logicalTabId: activeTabId });
    expect(
      PresenceUpdateSchema.parse({
        type: "presence.update",
        protocolVersion: 1,
        roomId,
        logicalTabId: null,
      }),
    ).toMatchObject({ logicalTabId: null });
  });

  it("parses a server-issued acknowledgement and presence snapshot", () => {
    const acknowledgement = {
      type: "presence.ack" as const,
      protocolVersion: 1 as const,
      roomId,
      expiresAt: 1_785_104_030_000,
    };
    const snapshot = {
      type: "presence.snapshot" as const,
      protocolVersion: 1 as const,
      roomId,
      presences: [
        {
          userId,
          username: "alex",
          displayName: "Alex",
          deviceId,
          logicalTabId: activeTabId,
          expiresAt: 1_785_104_030_000,
        },
      ],
    };

    expect(PresenceAckSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(PresenceSnapshotMessageSchema.parse(snapshot)).toEqual(snapshot);
    expect(ServerMessageSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(ServerMessageSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects client-supplied identities, duplicate devices, and oversized snapshots", () => {
    expect(() =>
      PresenceUpdateSchema.parse({
        type: "presence.update",
        protocolVersion: 1,
        roomId,
        logicalTabId: activeTabId,
        username: "spoofed",
      }),
    ).toThrow();
    const presence = {
      userId,
      username: "alex",
      displayName: "Alex",
      deviceId,
      logicalTabId: null,
      expiresAt: 1_785_104_030_000,
    };
    expect(() =>
      PresenceSnapshotMessageSchema.parse({
        type: "presence.snapshot",
        protocolVersion: 1,
        roomId,
        presences: [presence, presence],
      }),
    ).toThrow();
    expect(() =>
      PresenceSnapshotMessageSchema.parse({
        type: "presence.snapshot",
        protocolVersion: 1,
        roomId,
        presences: Array.from({ length: 257 }, (_, index) => ({
          ...presence,
          userId: `018f8f8e-4b5c-7d6e-8f90-${String(index).padStart(12, "0")}`,
        })),
      }),
    ).toThrow();
  });
});

describe("same-page pointer contracts", () => {
  const userId = "018f8f8e-4b5c-7d6e-8f90-123456789d06";
  const secondDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789d07";
  const documentRevision = {
    roomEpoch: 2,
    tabUpdatedAtSeq: 4,
  };
  const anchor = {
    path: [
      { tagName: "html", nthOfType: 1 },
      { tagName: "body", nthOfType: 1 },
      { tagName: "button", nthOfType: 2 },
    ],
    x: 0.25,
    y: 0.75,
  };
  const update = {
    type: "pointer.update" as const,
    protocolVersion: 1 as const,
    roomId,
    logicalTabId: activeTabId,
    documentRevision,
    anchor,
    viewport: { x: 0.4, y: 0.6 },
  };
  const pointer = {
    userId,
    username: "alex",
    displayName: "Alex",
    deviceId,
    color: "#155fe8",
    logicalTabId: activeTabId,
    documentRevision,
    anchor,
    viewport: { x: 0.4, y: 0.6 },
    expiresAt: 1_785_104_003_000,
  };

  it("parses privacy-safe anchored updates and server-derived messages", () => {
    const acknowledgement = {
      type: "pointer.ack" as const,
      protocolVersion: 1 as const,
      roomId,
      accepted: true as const,
      expiresAt: pointer.expiresAt,
    };
    const event = {
      type: "pointer.event" as const,
      protocolVersion: 1 as const,
      roomId,
      pointer,
    };
    const clear = {
      type: "pointer.clear" as const,
      protocolVersion: 1 as const,
      roomId,
      userId,
      deviceId,
    };
    const snapshot = {
      type: "pointer.snapshot" as const,
      protocolVersion: 1 as const,
      roomId,
      pointers: [pointer],
    };

    expect(PointerUpdateSchema.parse(update)).toEqual(update);
    expect(PointerAckSchema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(PointerEventMessageSchema.parse(event)).toEqual(event);
    expect(PointerClearMessageSchema.parse(clear)).toEqual(clear);
    expect(PointerSnapshotMessageSchema.parse(snapshot)).toEqual(snapshot);
    for (const message of [acknowledgement, event, clear, snapshot]) {
      expect(ServerMessageSchema.parse(message)).toEqual(message);
    }
    expect(
      PointerAckSchema.parse({
        ...acknowledgement,
        accepted: false,
        expiresAt: null,
      }),
    ).toMatchObject({ accepted: false, expiresAt: null });
  });

  it("rejects page data, invalid paths, and invalid normalized coordinates", () => {
    for (const forbidden of [
      { selector: "#secret" },
      { id: "account-number" },
      { className: "private-form" },
      { text: "secret answer" },
      { url: "https://example.com/?token=secret" },
    ]) {
      expect(() => PointerUpdateSchema.parse({ ...update, ...forbidden })).toThrow();
    }
    expect(() =>
      PointerUpdateSchema.parse({
        ...update,
        anchor: { ...anchor, path: [...anchor.path, { tagName: "Button", nthOfType: 1 }] },
      }),
    ).toThrow();
    expect(() =>
      PointerUpdateSchema.parse({
        ...update,
        anchor: {
          ...anchor,
          path: Array.from({ length: 13 }, () => ({ tagName: "div", nthOfType: 1 })),
        },
      }),
    ).toThrow();
    for (const coordinate of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        PointerUpdateSchema.parse({
          ...update,
          viewport: { x: coordinate, y: 0.5 },
        }),
      ).toThrow();
    }
  });

  it("rejects spoofed identity, contradictory ACKs, duplicate devices, and oversized snapshots", () => {
    expect(() => PointerUpdateSchema.parse({ ...update, userId })).toThrow();
    expect(() =>
      PointerAckSchema.parse({
        type: "pointer.ack",
        protocolVersion: 1,
        roomId,
        accepted: true,
        expiresAt: null,
      }),
    ).toThrow();
    expect(() =>
      PointerSnapshotMessageSchema.parse({
        type: "pointer.snapshot",
        protocolVersion: 1,
        roomId,
        pointers: [pointer, pointer],
      }),
    ).toThrow();
    expect(() =>
      PointerSnapshotMessageSchema.parse({
        type: "pointer.snapshot",
        protocolVersion: 1,
        roomId,
        pointers: Array.from({ length: 257 }, (_, index) => ({
          ...pointer,
          userId:
            index === 0 ? userId : `018f8f8e-4b5c-7d6e-8f90-${String(index).padStart(12, "0")}`,
          deviceId: index === 1 ? secondDeviceId : deviceId,
        })),
      }),
    ).toThrow();
  });
});
