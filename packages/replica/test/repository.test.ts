import { RoomSnapshotStateSchema, type LogicalTabId } from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import {
  DurableReplica,
  MemoryReplicaPersistence,
  ReplicaRepository,
  createReplicaRecord,
  replicaStorageKey,
  type ReplicaError,
  type ReplicaPersistence,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const otherRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const confirmedTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const optimisticTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
const clientOpIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789ac0",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac2",
];

const confirmedSnapshot = RoomSnapshotStateSchema.parse({
  roomId,
  roomEpoch: 0,
  serverSeq: 1,
  order: [confirmedTabId],
  tabs: [
    {
      id: confirmedTabId,
      url: "https://example.com/confirmed",
      createdAtSeq: 1,
      updatedAtSeq: 1,
      closedAtSeq: null,
    },
  ],
});

async function createSyncedReplica(persistence = new MemoryReplicaPersistence()) {
  const repository = new ReplicaRepository({ persistence, now: () => 100 });
  let clientOpIndex = 0;
  const replica = new DurableReplica({
    repository,
    roomId,
    deviceId,
    now: () => 100,
    createClientOpId: () => clientOpIds[clientOpIndex++]!,
  });
  await repository.update(roomId, (record) => ({
    ...record,
    mode: "SYNCED",
    confirmedSnapshot,
  }));
  return { persistence, repository, replica };
}

describe("ReplicaRepository", () => {
  it("loads or atomically creates one complete record", async () => {
    const persistence = new MemoryReplicaPersistence();
    const repository = new ReplicaRepository({ persistence, now: () => 100 });

    const first = await repository.load(roomId);
    const second = await repository.load(roomId);

    expect(first).toEqual(createReplicaRecord(roomId, 100));
    expect(second).toEqual(first);
    expect(persistence.writes).toEqual([
      {
        key: replicaStorageKey(roomId),
        value: first,
      },
    ]);
  });

  it("validates and writes one complete value per mutation", async () => {
    const persistence = new MemoryReplicaPersistence();
    let now = 100;
    const repository = new ReplicaRepository({ persistence, now: () => now });
    await repository.load(roomId);
    persistence.writes.length = 0;
    now = 200;

    const result = await repository.update(roomId, (record) => ({
      ...record,
      mode: "WAITING_SNAPSHOT",
    }));

    expect(result).toMatchObject({ mode: "WAITING_SNAPSHOT", updatedAtMs: 200 });
    expect(persistence.writes).toEqual([{ key: replicaStorageKey(roomId), value: result }]);
  });

  it("serializes concurrent room mutations without a lost update", async () => {
    const persistence = new MemoryReplicaPersistence();
    const repository = new ReplicaRepository({ persistence, now: () => 100 });

    const [first, second] = await Promise.all([
      repository.update(roomId, async (record) => {
        await Promise.resolve();
        return { ...record, nextOutboxSeq: record.nextOutboxSeq + 1 };
      }),
      repository.update(roomId, (record) => ({
        ...record,
        nextOutboxSeq: record.nextOutboxSeq + 1,
      })),
    ]);

    expect([first.nextOutboxSeq, second.nextOutboxSeq]).toEqual([2, 3]);
    expect((await repository.load(roomId)).nextOutboxSeq).toBe(3);
  });

  it("fails closed on corrupt persisted JSON without overwriting it", async () => {
    const key = replicaStorageKey(roomId);
    const corrupt = { schemaVersion: 1, roomId, mode: "SYNCED" };
    const persistence = new MemoryReplicaPersistence({ [key]: corrupt });
    const repository = new ReplicaRepository({ persistence, now: () => 100 });

    await expect(repository.load(roomId)).rejects.toMatchObject({
      code: "CORRUPT_REPLICA",
    });
    expect(persistence.writes).toEqual([]);
    expect(persistence.peek(key)).toEqual(corrupt);
  });

  it("maps storage read and write failures without returning an unpersisted mutation", async () => {
    const readFailure: ReplicaPersistence = {
      read: () => Promise.reject(new Error("read failed")),
      write: () => Promise.resolve(),
    };
    await expect(new ReplicaRepository({ persistence: readFailure }).load(roomId)).rejects.toEqual(
      expect.objectContaining<Partial<ReplicaError>>({ code: "STORAGE_FAILURE" }),
    );

    const persistence = new MemoryReplicaPersistence();
    const repository = new ReplicaRepository({ persistence });
    await repository.load(roomId);
    persistence.failNextWrite = true;
    await expect(
      repository.update(roomId, (record) => ({
        ...record,
        mode: "WAITING_SNAPSHOT",
      })),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect((await repository.load(roomId)).mode).toBe("UNINITIALIZED");
  });

  it("uses independent stable keys and queues for different rooms", async () => {
    const persistence = new MemoryReplicaPersistence();
    const repository = new ReplicaRepository({ persistence, now: () => 100 });

    await Promise.all([
      repository.update(roomId, (record) => ({ ...record, mode: "WAITING_SNAPSHOT" })),
      repository.update(otherRoomId, (record) => ({ ...record, mode: "WAITING_SNAPSHOT" })),
    ]);

    expect(await repository.load(roomId)).toMatchObject({ roomId, mode: "WAITING_SNAPSHOT" });
    expect(await repository.load(otherRoomId)).toMatchObject({
      roomId: otherRoomId,
      mode: "WAITING_SNAPSHOT",
    });
    expect(new Set(persistence.writes.map((write) => write.key))).toEqual(
      new Set([replicaStorageKey(roomId), replicaStorageKey(otherRoomId)]),
    );
  });
});

describe("DurableReplica permanent operation rejection", () => {
  it("atomically removes only the rejected create and all of its local bindings", async () => {
    const { persistence, replica } = await createSyncedReplica();
    await replica.bindTab({
      logicalTabId: confirmedTabId,
      tabId: 10,
      windowId: 1,
      groupId: 2,
      browserSessionId,
      validatedAtServerSeq: 1,
    });
    const rejected = await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticTabId,
      url: "https://example.com/optimistic",
      after: confirmedTabId,
    });
    await replica.bindTab({
      logicalTabId: optimisticTabId,
      tabId: 11,
      windowId: 1,
      groupId: 2,
      browserSessionId,
      validatedAtServerSeq: 1,
    });
    const retained = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: confirmedTabId,
      url: "https://example.com/retained",
    });
    persistence.writes.length = 0;

    const record = await replica.reject(rejected.envelope.clientOpId);

    expect(record).toMatchObject({
      mode: "SYNCED",
      nextOutboxSeq: 3,
      outbox: [retained],
      bindings: [expect.objectContaining({ logicalTabId: confirmedTabId, tabId: 10 })],
    });
    expect(record.bindings).not.toContainEqual(
      expect.objectContaining({ logicalTabId: optimisticTabId }),
    );
    expect((await replica.getOptimisticState()).tabs[confirmedTabId as LogicalTabId]?.url).toBe(
      "https://example.com/retained",
    );
    expect(persistence.writes).toEqual([{ key: replicaStorageKey(roomId), value: record }]);
  });

  it("rejects invalid, missing, acknowledged, and non-create operation identities without writes", async () => {
    const { persistence, replica } = await createSyncedReplica();
    const navigate = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: confirmedTabId,
      url: "https://example.com/navigation",
    });

    const before = await replica.getRecord();
    persistence.writes.length = 0;
    await expect(replica.reject("not-a-client-operation-id")).rejects.toMatchObject({
      code: "INVALID_REPLICA_TRANSITION",
    });
    await expect(replica.reject("018f8f8e-4b5c-7d6e-8f90-123456789aff")).rejects.toMatchObject({
      code: "OUTBOX_OPERATION_NOT_FOUND",
    });
    await expect(replica.reject(navigate.envelope.clientOpId)).rejects.toMatchObject({
      code: "INVALID_REPLICA_TRANSITION",
    });
    expect(await replica.getRecord()).toEqual(before);
    expect(persistence.writes).toEqual([]);

    await replica.acknowledge({
      type: "op.ack",
      protocolVersion: 1,
      clientOpId: navigate.envelope.clientOpId,
      roomId,
      roomEpoch: 0,
      serverSeq: 2,
    });
    const acknowledgedCreate = await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticTabId,
      url: "https://example.com/acknowledged-create",
      after: confirmedTabId,
    });
    await replica.acknowledge({
      type: "op.ack",
      protocolVersion: 1,
      clientOpId: acknowledgedCreate.envelope.clientOpId,
      roomId,
      roomEpoch: 0,
      serverSeq: 3,
    });
    const acknowledged = await replica.getRecord();
    persistence.writes.length = 0;
    await expect(replica.reject(acknowledgedCreate.envelope.clientOpId)).rejects.toMatchObject({
      code: "OUTBOX_OPERATION_NOT_FOUND",
    });
    expect(await replica.getRecord()).toEqual(acknowledged);
    expect(persistence.writes).toEqual([]);
  });

  it("durably quarantines dependent retained operations without orphaning the rejected create", async () => {
    const { persistence, replica } = await createSyncedReplica();
    const rejected = await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticTabId,
      url: "https://example.com/optimistic",
      after: confirmedTabId,
    });
    await replica.bindTab({
      logicalTabId: optimisticTabId,
      tabId: 11,
      windowId: 1,
      groupId: 2,
      browserSessionId,
      validatedAtServerSeq: 1,
    });
    const dependent = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: optimisticTabId,
      url: "https://example.com/dependent",
    });
    persistence.writes.length = 0;

    const record = await replica.reject(rejected.envelope.clientOpId);

    expect(record).toMatchObject({
      mode: "QUARANTINED",
      confirmedSnapshot,
      nextOutboxSeq: 3,
      outbox: [],
      pendingConfirmations: [],
      orphanedOutbox: [
        {
          ...dependent,
          orphanedReason: "PERMANENT_OPERATION_REJECTED",
          orphanedAtMs: 100,
        },
      ],
      bindings: [],
      quarantineReason: "PERMANENT_OPERATION_REJECTED",
    });
    expect(record.orphanedOutbox).not.toContainEqual(
      expect.objectContaining({
        envelope: expect.objectContaining({ clientOpId: rejected.envelope.clientOpId }),
      }),
    );
    expect(persistence.writes).toEqual([{ key: replicaStorageKey(roomId), value: record }]);
  });

  it("does not return an unpersisted rejection when durable storage fails", async () => {
    const { persistence, replica } = await createSyncedReplica();
    const rejected = await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticTabId,
      url: "https://example.com/optimistic",
      after: confirmedTabId,
    });
    const before = await replica.getRecord();
    persistence.failNextWrite = true;

    await expect(replica.reject(rejected.envelope.clientOpId)).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
    });
    expect(await replica.getRecord()).toEqual(before);
  });
});
