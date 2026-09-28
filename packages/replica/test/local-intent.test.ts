import {
  RoomSnapshotStateSchema,
  type DurableOperation,
  type LogicalTabId,
} from "@syncaction/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DurableReplica,
  MemoryReplicaPersistence,
  ReplicaRepository,
  replicaStorageKey,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const secondId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const thirdId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const clientOpIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789ac0",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac2",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac3",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac4",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac5",
];

const snapshot = RoomSnapshotStateSchema.parse({
  roomId,
  roomEpoch: 3,
  serverSeq: 2,
  order: [firstId, secondId],
  tabs: [
    {
      id: firstId,
      url: "https://example.com/duplicate",
      favIconUrl: null,
      createdAtSeq: 1,
      updatedAtSeq: 1,
      closedAtSeq: null,
    },
    {
      id: secondId,
      url: "https://example.com/second",
      favIconUrl: null,
      createdAtSeq: 2,
      updatedAtSeq: 2,
      closedAtSeq: null,
    },
  ],
});

let persistence: MemoryReplicaPersistence;
let repository: ReplicaRepository;
let replica: DurableReplica;
let nextClientOpIndex: number;
let now: number;

beforeEach(() => {
  persistence = new MemoryReplicaPersistence();
  now = 1_000;
  repository = new ReplicaRepository({ persistence, now: () => now });
  nextClientOpIndex = 0;
  replica = new DurableReplica({
    repository,
    roomId,
    deviceId,
    now: () => now,
    createClientOpId: () => clientOpIds[nextClientOpIndex++]!,
  });
});

async function makeSynced(): Promise<void> {
  await repository.update(roomId, (record) => ({
    ...record,
    mode: "SYNCED",
    confirmedSnapshot: snapshot,
  }));
}

describe("DurableReplica local intent", () => {
  it("rejects local intent outside SYNCED without creating an outbox entry", async () => {
    await expect(
      replica.enqueueLocalOperation({
        type: "tab.close",
        logicalTabId: firstId,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_INTENT_NOT_ALLOWED" });
    expect((await repository.load(roomId)).outbox).toEqual([]);
  });

  it("persists a complete envelope before returning accepted local intent", async () => {
    await makeSynced();
    persistence.writes.length = 0;

    const item = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/next",
    });

    expect(item).toMatchObject({
      outboxSeq: 1,
      enqueuedAtMs: 1_000,
      envelope: {
        protocolVersion: 1,
        clientOpId: clientOpIds[0],
        roomId,
        roomEpoch: 3,
        deviceId,
        baseServerSeq: 2,
      },
    });
    expect(persistence.writes).toHaveLength(1);
    expect(persistence.peek(replicaStorageKey(roomId))).toMatchObject({
      nextOutboxSeq: 2,
      outbox: [item],
    });
  });

  it("assigns monotonic outbox order and replays every durable operation optimistically", async () => {
    await makeSynced();
    const operations: DurableOperation[] = [
      {
        type: "tab.create",
        logicalTabId: thirdId as LogicalTabId,
        url: "https://example.com/duplicate",
        after: firstId as LogicalTabId,
      },
      {
        type: "tab.navigate",
        logicalTabId: firstId as LogicalTabId,
        url: "https://example.com/changed",
      },
      {
        type: "tab.move",
        logicalTabId: secondId as LogicalTabId,
        predecessor: null,
        successor: firstId as LogicalTabId,
      },
      {
        type: "tab.updateMetadata",
        logicalTabId: thirdId as LogicalTabId,
        title: "Third",
      },
      {
        type: "tab.close",
        logicalTabId: firstId as LogicalTabId,
      },
    ];
    for (const operation of operations) {
      now += 1;
      await replica.enqueueLocalOperation(operation);
    }

    const record = await repository.load(roomId);
    const optimistic = await replica.getOptimisticState();

    expect(record.outbox.map((item) => item.outboxSeq)).toEqual([1, 2, 3, 4, 5]);
    expect(record.nextOutboxSeq).toBe(6);
    expect(optimistic.serverSeq).toBe(7);
    expect(optimistic.order).toEqual([secondId, thirdId]);
    expect(optimistic.tabs[firstId as LogicalTabId]).toMatchObject({
      url: "https://example.com/changed",
      closedAtSeq: 7,
    });
    expect(optimistic.tabs[thirdId as LogicalTabId]).toMatchObject({
      url: "https://example.com/duplicate",
      title: "Third",
    });
  });

  it("persists the conflicting operation and quarantines instead of deleting confirmed state", async () => {
    await makeSynced();
    const unknownId = "018f8f8e-4b5c-7d6e-8f90-123456789aff";

    await expect(
      replica.enqueueLocalOperation({
        type: "tab.close",
        logicalTabId: unknownId,
      }),
    ).rejects.toMatchObject({ code: "OPTIMISTIC_CONFLICT" });

    const record = await repository.load(roomId);
    expect(record).toMatchObject({
      mode: "QUARANTINED",
      quarantineReason: "OPTIMISTIC_CONFLICT",
      confirmedSnapshot: snapshot,
      outbox: [
        expect.objectContaining({
          envelope: expect.objectContaining({
            operation: { type: "tab.close", logicalTabId: unknownId },
          }),
        }),
      ],
    });
  });

  it("ACK stops retrying but keeps the intent pending until committed state arrives", async () => {
    await makeSynced();
    const first = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/one",
    });
    const second = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: secondId,
      url: "https://example.com/two",
    });

    await replica.acknowledge({
      type: "op.ack",
      protocolVersion: 1,
      clientOpId: first.envelope.clientOpId,
      roomId,
      roomEpoch: 3,
      serverSeq: 3,
    });

    const record = await repository.load(roomId);
    expect(record.confirmedSnapshot?.serverSeq).toBe(2);
    expect(record.outbox).toEqual([second]);
    expect(record.pendingConfirmations).toEqual([
      {
        ...first,
        acknowledgedServerSeq: 3,
        acknowledgedAtMs: 1_000,
      },
    ]);
    expect((await replica.getOptimisticState()).tabs[firstId as LogicalTabId]?.url).toBe(
      "https://example.com/one",
    );
  });

  it("ignores a late ACK for an operation already removed by a broadcast", async () => {
    await makeSynced();
    const before = await repository.load(roomId);

    await replica.acknowledge({
      type: "op.ack",
      protocolVersion: 1,
      clientOpId: clientOpIds[0],
      roomId,
      roomEpoch: 3,
      serverSeq: 3,
    });

    expect(await repository.load(roomId)).toEqual(before);
  });

  it("rejects mismatched ACK identity without removing the retry", async () => {
    await makeSynced();
    const item = await replica.enqueueLocalOperation({
      type: "tab.close",
      logicalTabId: firstId,
    });

    await expect(
      replica.acknowledge({
        type: "op.ack",
        protocolVersion: 1,
        clientOpId: item.envelope.clientOpId,
        roomId,
        roomEpoch: 99,
        serverSeq: 3,
      }),
    ).rejects.toMatchObject({ code: "ACK_MISMATCH" });
    expect((await repository.load(roomId)).outbox).toEqual([item]);
  });
});
