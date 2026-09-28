import {
  CommittedOperationSchema,
  RoomSnapshotMessageSchema,
  RoomSnapshotStateSchema,
} from "@syncaction/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { DurableReplica, MemoryReplicaPersistence, ReplicaRepository } from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const secondId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const firstSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const secondSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
const optimisticId = "018f8f8e-4b5c-7d6e-8f90-123456789ab7";

const snapshot = RoomSnapshotStateSchema.parse({
  roomId,
  roomEpoch: 0,
  serverSeq: 2,
  order: [firstId, secondId],
  tabs: [
    {
      id: firstId,
      url: "https://example.com/first",
      createdAtSeq: 1,
      updatedAtSeq: 1,
      closedAtSeq: null,
    },
    {
      id: secondId,
      url: "https://example.com/second",
      createdAtSeq: 2,
      updatedAtSeq: 2,
      closedAtSeq: null,
    },
  ],
});

let repository: ReplicaRepository;
let replica: DurableReplica;

beforeEach(async () => {
  repository = new ReplicaRepository({
    persistence: new MemoryReplicaPersistence(),
    now: () => 1_000,
  });
  replica = new DurableReplica({
    repository,
    roomId,
    deviceId,
    createClientOpId: () => "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
  });
  await replica.applySnapshot(
    RoomSnapshotMessageSchema.parse({
      type: "room.snapshot",
      protocolVersion: 1,
      state: snapshot,
    }),
  );
});

function binding(
  logicalTabId: string,
  tabId: number,
  browserSessionId = firstSessionId,
  validatedAtServerSeq = 2,
) {
  return {
    logicalTabId,
    tabId,
    windowId: 4,
    groupId: 7,
    browserSessionId,
    validatedAtServerSeq,
  };
}

describe("durable local tab bindings", () => {
  it("binds and rebinds one active logical tab at the current confirmed sequence", async () => {
    await replica.bindTab(binding(firstId, 10));
    await replica.bindTab(binding(firstId, 11));

    expect((await replica.getRecord()).bindings).toEqual([binding(firstId, 11)]);
  });

  it("persists a binding for a locally created optimistic tab before server confirmation", async () => {
    await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticId,
      url: "https://example.com/optimistic",
      after: secondId,
    });

    await replica.bindTab(binding(optimisticId, 12));

    expect((await replica.getRecord()).bindings).toEqual([binding(optimisticId, 12)]);
  });

  it("rejects stale, inactive, cross-session, and duplicate local tab bindings", async () => {
    await replica.bindTab(binding(firstId, 10));

    await expect(replica.bindTab(binding(secondId, 11, firstSessionId, 1))).rejects.toMatchObject({
      code: "INVALID_REPLICA_TRANSITION",
    });
    await expect(
      replica.bindTab(binding("018f8f8e-4b5c-7d6e-8f90-123456789aff", 11, firstSessionId)),
    ).rejects.toMatchObject({ code: "INVALID_REPLICA_TRANSITION" });
    await expect(replica.bindTab(binding(secondId, 11, secondSessionId))).rejects.toMatchObject({
      code: "INVALID_REPLICA_TRANSITION",
    });
    await expect(replica.bindTab(binding(secondId, 10))).rejects.toMatchObject({
      code: "INVALID_REPLICA_TRANSITION",
    });

    expect((await replica.getRecord()).bindings).toEqual([binding(firstId, 10)]);
  });

  it("atomically replaces every active binding after exact new-session discovery", async () => {
    await replica.replaceBindings([binding(firstId, 10), binding(secondId, 11)]);

    await replica.replaceBindings([
      binding(firstId, 20, secondSessionId),
      binding(secondId, 21, secondSessionId),
    ]);

    expect((await replica.getRecord()).bindings).toEqual([
      binding(firstId, 20, secondSessionId),
      binding(secondId, 21, secondSessionId),
    ]);
  });

  it("rebuilds an exact optimistic group after restart without losing a local create", async () => {
    await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticId,
      url: "https://example.com/optimistic",
      after: secondId,
    });

    await replica.replaceBindings([
      binding(firstId, 20, secondSessionId),
      binding(secondId, 21, secondSessionId),
      binding(optimisticId, 22, secondSessionId),
    ]);

    expect((await replica.getRecord()).bindings).toEqual([
      binding(firstId, 20, secondSessionId),
      binding(secondId, 21, secondSessionId),
      binding(optimisticId, 22, secondSessionId),
    ]);
  });

  it("rejects incomplete or stale replacement without changing stored bindings", async () => {
    const initial = [binding(firstId, 10), binding(secondId, 11)];
    await replica.replaceBindings(initial);

    await expect(
      replica.replaceBindings([binding(firstId, 20, secondSessionId)]),
    ).rejects.toMatchObject({ code: "INVALID_REPLICA_TRANSITION" });
    await expect(
      replica.replaceBindings([
        binding(firstId, 20, secondSessionId, 1),
        binding(secondId, 21, secondSessionId, 1),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REPLICA_TRANSITION" });

    expect((await replica.getRecord()).bindings).toEqual(initial);
  });

  it("removes one binding idempotently", async () => {
    await replica.replaceBindings([binding(firstId, 10), binding(secondId, 11)]);

    await replica.removeBinding(firstId);
    await replica.removeBinding(firstId);

    expect((await replica.getRecord()).bindings).toEqual([binding(secondId, 11)]);
  });

  it("retains a tombstone binding until the exact local tab is closed", async () => {
    await replica.replaceBindings([binding(firstId, 10), binding(secondId, 11)]);

    await replica.applyCommitted(
      CommittedOperationSchema.parse({
        type: "op.committed",
        protocolVersion: 1,
        clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ac0",
        roomId,
        roomEpoch: 0,
        deviceId,
        serverSeq: 3,
        operation: {
          type: "tab.close",
          logicalTabId: firstId,
        },
      }),
    );

    expect((await replica.getRecord()).bindings).toEqual([
      binding(firstId, 10),
      binding(secondId, 11),
    ]);
  });

  it("quarantines ambiguous browser discovery without deleting confirmed state", async () => {
    await replica.bindTab(binding(firstId, 10));

    const record = await replica.quarantineBrowserAmbiguity();

    expect(record).toMatchObject({
      mode: "QUARANTINED",
      quarantineReason: "AMBIGUOUS_BINDING",
      confirmedSnapshot: snapshot,
      bindings: [binding(firstId, 10)],
    });
  });
});
