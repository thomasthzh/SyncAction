import {
  CommittedOperationSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  RoomSnapshotStateSchema,
  type LogicalTabId,
} from "@syncaction/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DurableReplica,
  MemoryReplicaPersistence,
  ReplicaRepository,
  type OrphanedOutboxItem,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const otherRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";

const snapshot = RoomSnapshotStateSchema.parse({
  roomId,
  roomEpoch: 3,
  serverSeq: 2,
  order: [firstId],
  tabs: [
    {
      id: firstId,
      url: "https://example.com/original",
      favIconUrl: null,
      createdAtSeq: 1,
      updatedAtSeq: 2,
      closedAtSeq: null,
    },
  ],
});

let now: number;
let persistence: MemoryReplicaPersistence;
let repository: ReplicaRepository;
let replica: DurableReplica;

beforeEach(() => {
  now = 1_000;
  persistence = new MemoryReplicaPersistence();
  repository = new ReplicaRepository({ persistence, now: () => now });
  replica = new DurableReplica({
    repository,
    roomId,
    deviceId,
    now: () => now,
    createClientOpId: () => clientOpId,
  });
});

async function seedSynced(): Promise<void> {
  await repository.update(roomId, (record) => ({
    ...record,
    mode: "SYNCED",
    confirmedSnapshot: snapshot,
  }));
}

function snapshotMessage(state = snapshot) {
  return RoomSnapshotMessageSchema.parse({
    type: "room.snapshot",
    protocolVersion: 1,
    state,
  });
}

function navigateCommitted(
  serverSeq: number,
  targetRoomId = roomId,
  url = "https://example.com/remote",
) {
  return CommittedOperationSchema.parse({
    type: "op.committed",
    protocolVersion: 1,
    clientOpId,
    roomId: targetRoomId,
    roomEpoch: 3,
    deviceId,
    serverSeq,
    operation: {
      type: "tab.navigate",
      logicalTabId: firstId,
      url,
    },
  });
}

describe("DurableReplica remote state", () => {
  it("persists an initial snapshot before returning a synchronized transition", async () => {
    persistence.writes.length = 0;

    const transition = await replica.applySnapshot(snapshotMessage());

    expect(transition).toMatchObject({
      kind: "SNAPSHOT",
      confirmedOperations: [],
      record: { mode: "SYNCED", confirmedSnapshot: snapshot },
    });
    expect(persistence.writes).toHaveLength(1);
    expect(persistence.writes[0]?.value).toEqual(transition.record);
  });

  it("accepts an identical current snapshot and rejects a stale snapshot without downgrade", async () => {
    await seedSynced();
    expect(await replica.applySnapshot(snapshotMessage())).toMatchObject({
      kind: "SNAPSHOT",
      record: { mode: "SYNCED", confirmedSnapshot: { serverSeq: 2 } },
    });
    const stale = RoomSnapshotStateSchema.parse({
      roomId,
      roomEpoch: 3,
      serverSeq: 0,
      order: [],
      tabs: [],
    });

    await expect(replica.applySnapshot(snapshotMessage(stale))).rejects.toMatchObject({
      code: "SEQUENCE_GAP",
    });
    expect(await repository.load(roomId)).toMatchObject({
      mode: "RECOVERING",
      confirmedSnapshot: { serverSeq: 2 },
    });
  });

  it("atomically applies a contiguous delta and removes broadcast-before-ACK outbox intent", async () => {
    await seedSynced();
    const pending = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/remote",
    });
    const committed = navigateCommitted(3);
    const delta = RoomDeltaMessageSchema.parse({
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: 3,
      fromServerSeq: 2,
      toServerSeq: 3,
      operations: [committed],
    });
    persistence.writes.length = 0;

    const transition = await replica.applyDelta(delta);

    expect(transition).toMatchObject({
      kind: "DELTA",
      confirmedOperations: [committed],
      record: {
        mode: "SYNCED",
        confirmedSnapshot: { serverSeq: 3 },
        outbox: [],
      },
    });
    expect(transition.record.confirmedSnapshot?.tabs[0]?.url).toBe("https://example.com/remote");
    expect(persistence.writes.at(-1)?.value).toEqual(transition.record);
    expect(pending.envelope.clientOpId).toBe(committed.clientOpId);
  });

  it("removes an ACKed pending confirmation only when its exact delta arrives", async () => {
    await seedSynced();
    const pending = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/remote",
    });
    await replica.acknowledge({
      type: "op.ack",
      protocolVersion: 1,
      clientOpId: pending.envelope.clientOpId,
      roomId,
      roomEpoch: 3,
      serverSeq: 3,
    });
    expect(await repository.load(roomId)).toMatchObject({
      confirmedSnapshot: { serverSeq: 2 },
      outbox: [],
      pendingConfirmations: [
        {
          acknowledgedServerSeq: 3,
          envelope: { clientOpId: pending.envelope.clientOpId },
        },
      ],
    });

    const committed = navigateCommitted(3);
    const transition = await replica.applyDelta({
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: 3,
      fromServerSeq: 2,
      toServerSeq: 3,
      operations: [committed],
    });

    expect(transition.record).toMatchObject({
      confirmedSnapshot: {
        serverSeq: 3,
        tabs: [expect.objectContaining({ url: "https://example.com/remote" })],
      },
      outbox: [],
      pendingConfirmations: [],
    });
  });

  it("accepts an empty current delta", async () => {
    await seedSynced();

    const transition = await replica.applyDelta({
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: 3,
      fromServerSeq: 2,
      toServerSeq: 2,
      operations: [],
    });

    expect(transition).toMatchObject({
      kind: "DELTA",
      confirmedOperations: [],
      record: { mode: "SYNCED", confirmedSnapshot: { serverSeq: 2 } },
    });
  });

  it("rejects a committed identity whose intent differs from the persisted outbox", async () => {
    await seedSynced();
    await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/expected",
    });

    await expect(
      replica.applyCommitted(navigateCommitted(3, roomId, "https://example.com/different")),
    ).rejects.toMatchObject({ code: "INVALID_REMOTE_STATE" });

    expect(await repository.load(roomId)).toMatchObject({
      mode: "RECOVERING",
      confirmedSnapshot: snapshot,
      outbox: [
        expect.objectContaining({
          envelope: expect.objectContaining({
            operation: expect.objectContaining({ url: "https://example.com/expected" }),
          }),
        }),
      ],
    });
  });

  it("applies one next broadcast and treats an older broadcast as an idempotent duplicate", async () => {
    await seedSynced();
    const committed = navigateCommitted(3);

    expect(await replica.applyCommitted(committed)).toMatchObject({
      kind: "COMMITTED",
      confirmedOperations: [committed],
      record: { confirmedSnapshot: { serverSeq: 3 } },
    });
    const duplicate = await replica.applyCommitted(committed);

    expect(duplicate).toMatchObject({
      kind: "DUPLICATE",
      confirmedOperations: [],
      record: { confirmedSnapshot: { serverSeq: 3 } },
    });
  });

  it("preserves confirmed state and enters recovery on a sequence gap or corrupt transition", async () => {
    await seedSynced();
    const gap = {
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: 3,
      fromServerSeq: 3,
      toServerSeq: 4,
      operations: [navigateCommitted(4)],
    };
    await expect(replica.applyDelta(gap)).rejects.toMatchObject({ code: "SEQUENCE_GAP" });
    expect(await repository.load(roomId)).toMatchObject({
      mode: "RECOVERING",
      confirmedSnapshot: snapshot,
    });

    await repository.update(roomId, (record) => ({
      ...record,
      mode: "SYNCED",
    }));
    const invalid = CommittedOperationSchema.parse({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId,
      roomId,
      roomEpoch: 3,
      deviceId,
      serverSeq: 3,
      operation: {
        type: "tab.close",
        logicalTabId: "018f8f8e-4b5c-7d6e-8f90-123456789aff",
      },
    });
    await expect(replica.applyCommitted(invalid)).rejects.toMatchObject({
      code: "INVALID_REMOTE_STATE",
    });
    expect(await repository.load(roomId)).toMatchObject({
      mode: "RECOVERING",
      confirmedSnapshot: snapshot,
    });
  });

  it("quarantines a mismatched room instead of applying it", async () => {
    await seedSynced();
    const otherSnapshot = RoomSnapshotStateSchema.parse({
      roomId: otherRoomId,
      roomEpoch: 0,
      serverSeq: 0,
      order: [],
      tabs: [],
    });

    await expect(replica.applySnapshot(snapshotMessage(otherSnapshot))).rejects.toMatchObject({
      code: "INVALID_REMOTE_STATE",
    });
    expect(await repository.load(roomId)).toMatchObject({
      mode: "QUARANTINED",
      quarantineReason: "INVALID_REMOTE_STATE",
      confirmedSnapshot: snapshot,
    });
  });

  it("orphans stale intent and bindings when a new room epoch snapshot arrives", async () => {
    await seedSynced();
    const pending = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/pending",
    });
    await repository.update(roomId, (record) => ({
      ...record,
      bindings: [
        {
          logicalTabId: firstId as LogicalTabId,
          tabId: 10,
          windowId: 2,
          groupId: 4,
          browserSessionId,
          validatedAtServerSeq: 2,
        },
      ],
    }));
    now = 2_000;
    const nextEpoch = RoomSnapshotStateSchema.parse({
      roomId,
      roomEpoch: 4,
      serverSeq: 0,
      order: [],
      tabs: [],
    });

    const transition = await replica.applySnapshot(snapshotMessage(nextEpoch));

    expect(transition).toMatchObject({
      kind: "EPOCH_CHANGED",
      confirmedOperations: [],
      record: {
        mode: "QUARANTINED",
        quarantineReason: "ROOM_EPOCH_CHANGED",
        confirmedSnapshot: nextEpoch,
        outbox: [],
        bindings: [],
        orphanedOutbox: [
          expect.objectContaining<Partial<OrphanedOutboxItem>>({
            outboxSeq: pending.outboxSeq,
            envelope: pending.envelope,
            orphanedAtMs: 2_000,
          }),
        ],
      },
    });
  });
});
