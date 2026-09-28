import { describe, expect, it } from "vitest";
import { ReplicaRecordSchema, createReplicaRecord } from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";

const snapshot = {
  roomId,
  roomEpoch: 0,
  serverSeq: 1,
  order: [logicalTabId],
  tabs: [
    {
      id: logicalTabId,
      url: "https://example.com/",
      favIconUrl: null,
      createdAtSeq: 1,
      updatedAtSeq: 1,
      closedAtSeq: null,
    },
  ],
};

const outboxItem = {
  outboxSeq: 1,
  envelope: {
    protocolVersion: 1,
    clientOpId,
    roomId,
    roomEpoch: 0,
    deviceId,
    baseServerSeq: 1,
    operation: {
      type: "tab.navigate",
      logicalTabId,
      url: "https://example.com/next",
    },
  },
  enqueuedAtMs: 100,
};

function syncedRecord() {
  return {
    schemaVersion: 1,
    roomId,
    mode: "SYNCED",
    confirmedSnapshot: snapshot,
    nextOutboxSeq: 2,
    outbox: [outboxItem],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: [
      {
        logicalTabId,
        tabId: 7,
        windowId: 3,
        groupId: 2,
        browserSessionId,
        validatedAtServerSeq: 1,
      },
    ],
    quarantineReason: null,
    updatedAtMs: 100,
  };
}

describe("ReplicaRecordSchema", () => {
  it("creates a strict uninitialized record", () => {
    expect(createReplicaRecord(roomId, 123)).toEqual({
      schemaVersion: 1,
      roomId,
      mode: "UNINITIALIZED",
      confirmedSnapshot: null,
      nextOutboxSeq: 1,
      outbox: [],
      pendingConfirmations: [],
      orphanedOutbox: [],
      bindings: [],
      quarantineReason: null,
      updatedAtMs: 123,
    });
    expect(() =>
      ReplicaRecordSchema.parse({ ...createReplicaRecord(roomId, 123), unexpected: true }),
    ).toThrow();
  });

  it("accepts a complete synced replica with an outbox and binding", () => {
    expect(ReplicaRecordSchema.parse(syncedRecord())).toEqual(syncedRecord());
  });

  it("rejects duplicate or nonmonotonic outbox identities", () => {
    const record = syncedRecord();
    expect(() =>
      ReplicaRecordSchema.parse({
        ...record,
        nextOutboxSeq: 3,
        outbox: [
          { ...outboxItem, outboxSeq: 2 },
          { ...outboxItem, outboxSeq: 1, envelope: { ...outboxItem.envelope, clientOpId } },
        ],
      }),
    ).toThrow();
    expect(() =>
      ReplicaRecordSchema.parse({
        ...record,
        nextOutboxSeq: 3,
        outbox: [outboxItem, { ...outboxItem, outboxSeq: 2 }],
      }),
    ).toThrow();
  });

  it("rejects mismatched room or epoch identity", () => {
    const otherRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789ac0";
    expect(() =>
      ReplicaRecordSchema.parse({
        ...syncedRecord(),
        confirmedSnapshot: { ...snapshot, roomId: otherRoomId },
      }),
    ).toThrow();
    expect(() =>
      ReplicaRecordSchema.parse({
        ...syncedRecord(),
        outbox: [
          {
            ...outboxItem,
            envelope: { ...outboxItem.envelope, roomEpoch: 2 },
          },
        ],
      }),
    ).toThrow();
  });

  it("requires one-to-one valid local bindings", () => {
    const record = syncedRecord();
    expect(() =>
      ReplicaRecordSchema.parse({
        ...record,
        bindings: [record.bindings[0], { ...record.bindings[0] }],
      }),
    ).toThrow();
    expect(() =>
      ReplicaRecordSchema.parse({
        ...record,
        bindings: [{ ...record.bindings[0], tabId: -1 }],
      }),
    ).toThrow();
  });

  it("enforces legal mode, snapshot, and quarantine combinations", () => {
    expect(() =>
      ReplicaRecordSchema.parse({
        ...syncedRecord(),
        mode: "UNINITIALIZED",
      }),
    ).toThrow();
    expect(() =>
      ReplicaRecordSchema.parse({
        ...syncedRecord(),
        confirmedSnapshot: null,
      }),
    ).toThrow();
    expect(() =>
      ReplicaRecordSchema.parse({
        ...syncedRecord(),
        mode: "QUARANTINED",
      }),
    ).toThrow();
    expect(
      ReplicaRecordSchema.parse({
        ...syncedRecord(),
        mode: "QUARANTINED",
        quarantineReason: "ROOM_EPOCH_CHANGED",
      }),
    ).toMatchObject({ mode: "QUARANTINED" });
  });

  it("accepts a permanent-rejection quarantine without losing retained outbox intent", () => {
    const quarantined = {
      ...syncedRecord(),
      mode: "QUARANTINED",
      outbox: [],
      orphanedOutbox: [
        {
          ...outboxItem,
          orphanedReason: "PERMANENT_OPERATION_REJECTED",
          orphanedAtMs: 200,
        },
      ],
      bindings: [],
      quarantineReason: "PERMANENT_OPERATION_REJECTED",
    };

    expect(ReplicaRecordSchema.parse(quarantined)).toEqual(quarantined);
  });

  it("requires nextOutboxSeq to exceed all live and orphaned entries", () => {
    expect(() =>
      ReplicaRecordSchema.parse({
        ...syncedRecord(),
        nextOutboxSeq: 1,
      }),
    ).toThrow();
    expect(() =>
      ReplicaRecordSchema.parse({
        ...syncedRecord(),
        nextOutboxSeq: 2,
        outbox: [],
        orphanedOutbox: [
          {
            ...outboxItem,
            outboxSeq: 2,
            orphanedReason: "ROOM_EPOCH_CHANGED",
            orphanedAtMs: 200,
          },
        ],
      }),
    ).toThrow();
  });
});
