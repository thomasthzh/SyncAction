import {
  CommittedOperationSchema,
  OperationAckSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  RoomSnapshotStateSchema,
  type ClientOperationEnvelope,
  type CommittedOperation,
  type OperationAck,
  type RoomDeltaMessage,
  type RoomSnapshotMessage,
  type RoomSyncRequest,
} from "@syncaction/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DurableReplica,
  MemoryReplicaPersistence,
  ReplicaCoordinator,
  ReplicaPermanentOperationError,
  ReplicaRepository,
  type ReplicaCoordinatorState,
  type ReplicaTransition,
  type ReplicaTransport,
  type ReplicaTransportHandlers,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const optimisticId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const clientOpIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789ac0",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac2",
];

const confirmedSnapshot = RoomSnapshotStateSchema.parse({
  roomId,
  roomEpoch: 0,
  serverSeq: 1,
  order: [firstId],
  tabs: [
    {
      id: firstId,
      url: "https://example.com/confirmed",
      favIconUrl: null,
      createdAtSeq: 1,
      updatedAtSeq: 1,
      closedAtSeq: null,
    },
  ],
});

const initialSnapshotMessage = RoomSnapshotMessageSchema.parse({
  type: "room.snapshot",
  protocolVersion: 1,
  state: confirmedSnapshot,
});

class FakeTransport implements ReplicaTransport {
  public connectCount = 0;
  public disconnectCount = 0;
  public readonly syncRequests: RoomSyncRequest[] = [];
  public readonly submissions: ClientOperationEnvelope[] = [];
  public syncResponse: RoomSnapshotMessage | RoomDeltaMessage = initialSnapshotMessage;
  public submitImplementation: (envelope: ClientOperationEnvelope) => Promise<OperationAck> =
    async (envelope) =>
      OperationAckSchema.parse({
        type: "op.ack",
        protocolVersion: 1,
        clientOpId: envelope.clientOpId,
        roomId: envelope.roomId,
        roomEpoch: envelope.roomEpoch,
        serverSeq: envelope.baseServerSeq + this.submissions.length,
      });
  #handlers: ReplicaTransportHandlers | undefined;

  public async connect(handlers: ReplicaTransportHandlers): Promise<void> {
    this.connectCount += 1;
    this.#handlers = handlers;
  }

  public async synchronize(request: RoomSyncRequest) {
    this.syncRequests.push(request);
    return this.syncResponse;
  }

  public async submit(envelope: ClientOperationEnvelope): Promise<OperationAck> {
    this.submissions.push(envelope);
    return this.submitImplementation(envelope);
  }

  public async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.#handlers = undefined;
  }

  public emitCommitted(operation: CommittedOperation): void {
    this.#handlers?.onCommitted(operation);
  }

  public emitDisconnect(): void {
    this.#handlers?.onDisconnect();
  }

  public emitReconnect(): void {
    this.#handlers?.onReconnect();
  }
}

class DisconnectDuringRejectReplica extends DurableReplica {
  public onRejectStarted: (() => void) | undefined;

  public override reject(clientOpIdInput: unknown) {
    const result = super.reject(clientOpIdInput);
    this.onRejectStarted?.();
    return result;
  }
}

let persistence: MemoryReplicaPersistence;
let repository: ReplicaRepository;
let replica: DurableReplica;
let transport: FakeTransport;
let nextClientOpIndex: number;
let states: ReplicaCoordinatorState[];
let transitions: ReplicaTransition[];

beforeEach(() => {
  persistence = new MemoryReplicaPersistence();
  repository = new ReplicaRepository({ persistence, now: () => 1_000 });
  nextClientOpIndex = 0;
  replica = createReplica(repository);
  transport = new FakeTransport();
  states = [];
  transitions = [];
});

function createReplica(targetRepository: ReplicaRepository): DurableReplica {
  return new DurableReplica({
    repository: targetRepository,
    roomId,
    deviceId,
    now: () => 1_000,
    createClientOpId: () => clientOpIds[nextClientOpIndex++]!,
  });
}

function createDisconnectDuringRejectReplica(
  targetRepository: ReplicaRepository,
): DisconnectDuringRejectReplica {
  return new DisconnectDuringRejectReplica({
    repository: targetRepository,
    roomId,
    deviceId,
    now: () => 1_000,
    createClientOpId: () => clientOpIds[nextClientOpIndex++]!,
  });
}

function createCoordinator(
  targetReplica = replica,
  targetTransport: ReplicaTransport = transport,
): ReplicaCoordinator {
  return new ReplicaCoordinator({
    replica: targetReplica,
    transport: targetTransport,
    roomId,
    onStateChange: (state) => states.push(state),
    onTransition: (transition) => transitions.push(transition),
  });
}

async function seedSynced(targetRepository = repository): Promise<void> {
  await targetRepository.update(roomId, (record) => ({
    ...record,
    mode: "SYNCED",
    confirmedSnapshot,
  }));
}

function committedFromEnvelope(
  envelope: ClientOperationEnvelope,
  serverSeq: number,
): CommittedOperation {
  return CommittedOperationSchema.parse({
    type: "op.committed",
    protocolVersion: 1,
    clientOpId: envelope.clientOpId,
    roomId: envelope.roomId,
    roomEpoch: envelope.roomEpoch,
    deviceId: envelope.deviceId,
    serverSeq,
    operation: envelope.operation,
  });
}

describe("ReplicaCoordinator", () => {
  it("connects, persists a snapshot, and exposes connected SYNCED state", async () => {
    const coordinator = createCoordinator();

    await coordinator.start();

    expect(transport.connectCount).toBe(1);
    expect(transport.syncRequests).toEqual([
      {
        protocolVersion: 1,
        roomId,
        roomEpoch: 0,
        lastServerSeq: 0,
        hasConfirmedSnapshot: false,
      },
    ]);
    expect(states).toEqual(["AUTHENTICATING", "WAITING_SNAPSHOT", "SYNCED"]);
    expect(coordinator.state).toBe("SYNCED");
    expect(coordinator.isActuatable()).toBe(true);
    expect(await replica.getRecord()).toMatchObject({
      mode: "SYNCED",
      confirmedSnapshot,
    });
  });

  it("recovers a contiguous delta and reports only persisted confirmed operations", async () => {
    await seedSynced();
    const committed = CommittedOperationSchema.parse({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId: clientOpIds[0],
      roomId,
      roomEpoch: 0,
      deviceId,
      serverSeq: 2,
      operation: {
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/reconnected",
      },
    });
    transport.syncResponse = RoomDeltaMessageSchema.parse({
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: 0,
      fromServerSeq: 1,
      toServerSeq: 2,
      operations: [committed],
    });
    const coordinator = createCoordinator();

    await coordinator.start();

    expect(transport.syncRequests[0]).toMatchObject({ lastServerSeq: 1 });
    expect(transitions.at(-1)).toMatchObject({
      kind: "DELTA",
      confirmedOperations: [committed],
      record: { confirmedSnapshot: { serverSeq: 2 } },
    });
    expect(persistence.writes.at(-1)?.value).toEqual(transitions.at(-1)?.record);
  });

  it("persists local intent before submit and retains ACKed intent until broadcast", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    let persistedBeforeSubmit = false;
    let afterPersistRan = false;
    transport.submitImplementation = async (envelope) => {
      const record = await repository.load(roomId);
      persistedBeforeSubmit = record.outbox.some(
        (item) => item.envelope.clientOpId === envelope.clientOpId,
      );
      expect(afterPersistRan).toBe(true);
      return OperationAckSchema.parse({
        type: "op.ack",
        protocolVersion: 1,
        clientOpId: envelope.clientOpId,
        roomId,
        roomEpoch: 0,
        serverSeq: 2,
      });
    };

    await coordinator.enqueueLocalOperation(
      {
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/local",
      },
      async (item) => {
        expect((await repository.load(roomId)).outbox).toContainEqual(item);
        afterPersistRan = true;
      },
    );

    expect(persistedBeforeSubmit).toBe(true);
    expect(afterPersistRan).toBe(true);
    expect(transport.submissions).toHaveLength(1);
    expect(await replica.getRecord()).toMatchObject({
      outbox: [],
      pendingConfirmations: [
        {
          acknowledgedServerSeq: 2,
          envelope: { clientOpId: clientOpIds[0] },
        },
      ],
    });
  });

  it("prevents submission when persistence fails and retains outbox when submit fails", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    persistence.failNextWrite = true;

    await expect(
      coordinator.enqueueLocalOperation({
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/storage-failed",
      }),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(transport.submissions).toEqual([]);

    await coordinator.start();
    transport.submitImplementation = () => Promise.reject(new Error("ACK lost"));
    await expect(
      coordinator.enqueueLocalOperation({
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/submit-failed",
      }),
    ).rejects.toThrow("ACK lost");
    expect((await replica.getRecord()).outbox).toHaveLength(1);
    expect(coordinator.state).toBe("DISCONNECTED");
  });

  it("durably rejects a permanent create failure without disconnecting", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    const serverFailure = Object.assign(new Error("ordinary room is full"), {
      code: "ROOM_TAB_LIMIT_REACHED",
    });
    transport.submitImplementation = () => Promise.reject(serverFailure);

    const rejected = coordinator.enqueueLocalOperation(
      {
        type: "tab.create",
        logicalTabId: optimisticId,
        url: "https://example.com/retained-local-tab",
        after: firstId,
      },
      async () => {
        await replica.bindTab({
          logicalTabId: optimisticId,
          tabId: 22,
          windowId: 1,
          groupId: 3,
          browserSessionId,
          validatedAtServerSeq: 1,
        });
      },
    );

    await expect(rejected).rejects.toBeInstanceOf(ReplicaPermanentOperationError);
    await expect(rejected).rejects.toMatchObject({
      code: "PERMANENT_OPERATION_REJECTED",
      serverCode: "ROOM_TAB_LIMIT_REACHED",
      cause: serverFailure,
    });
    expect(await replica.getRecord()).toMatchObject({
      mode: "SYNCED",
      outbox: [],
      pendingConfirmations: [],
      bindings: [],
    });
    expect(coordinator.state).toBe("SYNCED");
    expect(transport.disconnectCount).toBe(0);
  });

  it("uses an immediate rejection record to enter durable quarantine", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    transport.submitImplementation = () => Promise.reject({ code: "ROOM_TAB_LIMIT_REACHED" });

    await expect(
      coordinator.enqueueLocalOperation(
        {
          type: "tab.create",
          logicalTabId: optimisticId,
          url: "https://example.com/rejected-with-dependent-intent",
          after: firstId,
        },
        async () => {
          await replica.bindTab({
            logicalTabId: optimisticId,
            tabId: 22,
            windowId: 1,
            groupId: 3,
            browserSessionId,
            validatedAtServerSeq: 1,
          });
          await replica.enqueueLocalOperation({
            type: "tab.navigate",
            logicalTabId: optimisticId,
            url: "https://example.com/dependent-intent",
          });
        },
      ),
    ).rejects.toMatchObject({
      code: "PERMANENT_OPERATION_REJECTED",
      serverCode: "ROOM_TAB_LIMIT_REACHED",
    });

    expect(await replica.getRecord()).toMatchObject({
      mode: "QUARANTINED",
      outbox: [],
      orphanedOutbox: [
        expect.objectContaining({
          orphanedReason: "PERMANENT_OPERATION_REJECTED",
          envelope: expect.objectContaining({
            operation: expect.objectContaining({
              type: "tab.navigate",
              logicalTabId: optimisticId,
            }),
          }),
        }),
      ],
      bindings: [],
      quarantineReason: "PERMANENT_OPERATION_REJECTED",
    });
    expect(coordinator.state).toBe("QUARANTINED");
    expect(transport.disconnectCount).toBe(0);
  });

  it("preserves a disconnect that races an immediate durable rejection", async () => {
    await seedSynced();
    const raceReplica = createDisconnectDuringRejectReplica(repository);
    const coordinator = createCoordinator(raceReplica);
    await coordinator.start();
    raceReplica.onRejectStarted = () => transport.emitDisconnect();
    transport.submitImplementation = () => Promise.reject({ code: "ROOM_TAB_LIMIT_REACHED" });

    await expect(
      coordinator.enqueueLocalOperation({
        type: "tab.create",
        logicalTabId: optimisticId,
        url: "https://example.com/disconnected-during-rejection",
        after: firstId,
      }),
    ).rejects.toMatchObject({
      code: "PERMANENT_OPERATION_REJECTED",
      serverCode: "ROOM_TAB_LIMIT_REACHED",
    });

    expect(await raceReplica.getRecord()).toMatchObject({
      mode: "SYNCED",
      outbox: [],
    });
    expect(coordinator.state).toBe("DISCONNECTED");
    expect(transport.submissions).toHaveLength(1);
    expect(transport.syncRequests).toHaveLength(1);

    transport.emitReconnect();
    await coordinator.whenIdle();

    expect(coordinator.state).toBe("SYNCED");
    expect(transport.syncRequests).toHaveLength(2);
    expect(transport.submissions).toHaveLength(1);
  });

  it("disconnects and retains durable intent for non-permanent or merely similar failures", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    const serverFailure = {
      code: "RECOVERY_REQUIRED",
      message: "ROOM_TAB_LIMIT_REACHED",
    };
    transport.submitImplementation = () => Promise.reject(serverFailure);

    await expect(
      coordinator.enqueueLocalOperation({
        type: "tab.create",
        logicalTabId: optimisticId,
        url: "https://example.com/retry-after-reconnect",
        after: firstId,
      }),
    ).rejects.toBe(serverFailure);

    expect((await replica.getRecord()).outbox).toHaveLength(1);
    expect(coordinator.state).toBe("DISCONNECTED");
    expect(transport.disconnectCount).toBe(1);
  });

  it("does not trust a permanent-error instance thrown before transport submission", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    const callbackFailure = new ReplicaPermanentOperationError("ROOM_TAB_LIMIT_REACHED");

    await expect(
      coordinator.enqueueLocalOperation(
        {
          type: "tab.create",
          logicalTabId: optimisticId,
          url: "https://example.com/persisted-before-callback-failure",
          after: firstId,
        },
        () => Promise.reject(callbackFailure),
      ),
    ).rejects.toBe(callbackFailure);

    expect(transport.submissions).toEqual([]);
    expect((await replica.getRecord()).outbox).toHaveLength(1);
    expect(coordinator.state).toBe("DISCONNECTED");
    expect(transport.disconnectCount).toBe(1);
  });

  it("serializes broadcast-before-ACK and applies the confirmed operation once", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    transport.submitImplementation = async (envelope) => {
      transport.emitCommitted(committedFromEnvelope(envelope, 2));
      await Promise.resolve();
      return OperationAckSchema.parse({
        type: "op.ack",
        protocolVersion: 1,
        clientOpId: envelope.clientOpId,
        roomId,
        roomEpoch: 0,
        serverSeq: 2,
      });
    };

    await coordinator.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/broadcast-first",
    });
    await coordinator.whenIdle();

    expect(await replica.getRecord()).toMatchObject({
      confirmedSnapshot: {
        serverSeq: 2,
        tabs: [expect.objectContaining({ url: "https://example.com/broadcast-first" })],
      },
      outbox: [],
    });
    expect(transitions.filter((transition) => transition.kind === "COMMITTED")).toHaveLength(1);
  });

  it("replays persisted outbox in original order after a worker-style restart", async () => {
    await seedSynced();
    const first = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/one",
    });
    const second = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/two",
    });
    const restartedRepository = new ReplicaRepository({
      persistence,
      now: () => 2_000,
    });
    const restartedReplica = createReplica(restartedRepository);
    const restartedCoordinator = createCoordinator(restartedReplica);

    await restartedCoordinator.start();

    expect(transport.submissions.map((envelope) => envelope.clientOpId)).toEqual([
      first.envelope.clientOpId,
      second.envelope.clientOpId,
    ]);
    expect((await restartedReplica.getRecord()).outbox).toEqual([]);
  });

  it("drops a persisted permanent rejection and continues replay after restart", async () => {
    await seedSynced();
    const rejected = await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticId,
      url: "https://example.com/rejected-after-restart",
      after: firstId,
    });
    await replica.bindTab({
      logicalTabId: optimisticId,
      tabId: 22,
      windowId: 1,
      groupId: 3,
      browserSessionId,
      validatedAtServerSeq: 1,
    });
    const retained = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/replayed-after-rejection",
    });
    const restartedRepository = new ReplicaRepository({
      persistence,
      now: () => 2_000,
    });
    const restartedReplica = createReplica(restartedRepository);
    const restartedTransport = new FakeTransport();
    restartedTransport.submitImplementation = async (submitted) => {
      if (submitted.clientOpId === rejected.envelope.clientOpId) {
        throw { code: "ROOM_TAB_LIMIT_REACHED" };
      }
      return OperationAckSchema.parse({
        type: "op.ack",
        protocolVersion: 1,
        clientOpId: submitted.clientOpId,
        roomId,
        roomEpoch: 0,
        serverSeq: 2,
      });
    };
    const restartedCoordinator = createCoordinator(restartedReplica, restartedTransport);

    await expect(restartedCoordinator.start()).resolves.toBeUndefined();

    expect(restartedTransport.submissions.map((item) => item.clientOpId)).toEqual([
      rejected.envelope.clientOpId,
      retained.envelope.clientOpId,
    ]);
    expect(await restartedReplica.getRecord()).toMatchObject({
      mode: "SYNCED",
      outbox: [],
      pendingConfirmations: [
        expect.objectContaining({
          envelope: expect.objectContaining({ clientOpId: retained.envelope.clientOpId }),
        }),
      ],
      bindings: [],
    });
    expect(restartedCoordinator.state).toBe("SYNCED");
    expect(restartedTransport.disconnectCount).toBe(0);
  });

  it("quarantines dependent replay intent and never resubmits it after reconnect or restart", async () => {
    await seedSynced();
    const rejected = await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticId,
      url: "https://example.com/permanently-rejected",
      after: firstId,
    });
    await replica.bindTab({
      logicalTabId: optimisticId,
      tabId: 22,
      windowId: 1,
      groupId: 3,
      browserSessionId,
      validatedAtServerSeq: 1,
    });
    const dependent = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: optimisticId,
      url: "https://example.com/dependent",
    });
    const restartedRepository = new ReplicaRepository({
      persistence,
      now: () => 2_000,
    });
    const restartedReplica = createReplica(restartedRepository);
    const restartedTransport = new FakeTransport();
    restartedTransport.submitImplementation = async (submitted) => {
      if (submitted.clientOpId === rejected.envelope.clientOpId) {
        throw { code: "ROOM_TAB_LIMIT_REACHED" };
      }
      throw new Error(`unexpected replay ${submitted.clientOpId}`);
    };
    const restartedCoordinator = createCoordinator(restartedReplica, restartedTransport);

    await expect(restartedCoordinator.start()).resolves.toBeUndefined();

    expect(restartedTransport.submissions.map((item) => item.clientOpId)).toEqual([
      rejected.envelope.clientOpId,
    ]);
    expect(await restartedReplica.getRecord()).toMatchObject({
      mode: "QUARANTINED",
      outbox: [],
      orphanedOutbox: [
        {
          ...dependent,
          orphanedReason: "PERMANENT_OPERATION_REJECTED",
          orphanedAtMs: 1_000,
        },
      ],
      bindings: [],
      quarantineReason: "PERMANENT_OPERATION_REJECTED",
    });
    expect(restartedCoordinator.state).toBe("QUARANTINED");
    expect(restartedTransport.disconnectCount).toBe(0);

    restartedTransport.emitDisconnect();
    restartedTransport.emitReconnect();
    await restartedCoordinator.whenIdle();
    expect(restartedCoordinator.state).toBe("QUARANTINED");
    expect(restartedTransport.submissions).toHaveLength(1);

    await restartedCoordinator.stop();
    await restartedCoordinator.start();
    expect(restartedCoordinator.state).toBe("QUARANTINED");
    expect(restartedTransport.submissions).toHaveLength(1);
    expect(restartedTransport.syncRequests).toHaveLength(1);
  });

  it("preserves a disconnect that races replay quarantine and reconnects without resubmission", async () => {
    await seedSynced();
    const rejected = await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: optimisticId,
      url: "https://example.com/replay-race",
      after: firstId,
    });
    const dependent = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: optimisticId,
      url: "https://example.com/replay-race-dependent",
    });
    const restartedRepository = new ReplicaRepository({
      persistence,
      now: () => 2_000,
    });
    const restartedReplica = createDisconnectDuringRejectReplica(restartedRepository);
    const restartedTransport = new FakeTransport();
    restartedTransport.submitImplementation = () =>
      Promise.reject({ code: "ROOM_TAB_LIMIT_REACHED" });
    restartedReplica.onRejectStarted = () => restartedTransport.emitDisconnect();
    const restartedCoordinator = createCoordinator(restartedReplica, restartedTransport);

    await expect(restartedCoordinator.start()).resolves.toBeUndefined();

    expect(await restartedReplica.getRecord()).toMatchObject({
      mode: "QUARANTINED",
      outbox: [],
      orphanedOutbox: [
        {
          ...dependent,
          orphanedReason: "PERMANENT_OPERATION_REJECTED",
          orphanedAtMs: 1_000,
        },
      ],
      quarantineReason: "PERMANENT_OPERATION_REJECTED",
    });
    expect(restartedCoordinator.state).toBe("DISCONNECTED");
    expect(restartedTransport.submissions.map((item) => item.clientOpId)).toEqual([
      rejected.envelope.clientOpId,
    ]);

    restartedTransport.emitReconnect();
    await restartedCoordinator.whenIdle();

    expect(restartedCoordinator.state).toBe("QUARANTINED");
    expect(restartedTransport.syncRequests).toHaveLength(1);
    expect(restartedTransport.submissions).toHaveLength(1);
  });

  it("recovers commit-before-ACK through delta without a duplicate resubmission", async () => {
    await seedSynced();
    const firstTransport = new FakeTransport();
    firstTransport.submitImplementation = () => Promise.reject(new Error("ACK lost"));
    const firstCoordinator = createCoordinator(replica, firstTransport);
    await firstCoordinator.start();
    await expect(
      firstCoordinator.enqueueLocalOperation({
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/committed",
      }),
    ).rejects.toThrow("ACK lost");
    const pending = (await replica.getRecord()).outbox[0]!;

    const restartedRepository = new ReplicaRepository({ persistence });
    const restartedReplica = createReplica(restartedRepository);
    const restartedTransport = new FakeTransport();
    restartedTransport.syncResponse = RoomDeltaMessageSchema.parse({
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: 0,
      fromServerSeq: 1,
      toServerSeq: 2,
      operations: [committedFromEnvelope(pending.envelope, 2)],
    });
    const restartedCoordinator = createCoordinator(restartedReplica, restartedTransport);

    await restartedCoordinator.start();

    expect(restartedTransport.submissions).toEqual([]);
    expect(await restartedReplica.getRecord()).toMatchObject({
      confirmedSnapshot: { serverSeq: 2 },
      outbox: [],
    });
  });

  it("recovers ACK-before-broadcast after restart without resubmitting the operation", async () => {
    await seedSynced();
    const pending = await replica.enqueueLocalOperation({
      type: "tab.navigate",
      logicalTabId: firstId,
      url: "https://example.com/acknowledged",
    });
    await replica.acknowledge({
      type: "op.ack",
      protocolVersion: 1,
      clientOpId: pending.envelope.clientOpId,
      roomId,
      roomEpoch: 0,
      serverSeq: 2,
    });

    const restartedRepository = new ReplicaRepository({ persistence });
    const restartedReplica = createReplica(restartedRepository);
    const restartedTransport = new FakeTransport();
    restartedTransport.syncResponse = RoomDeltaMessageSchema.parse({
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: 0,
      fromServerSeq: 1,
      toServerSeq: 2,
      operations: [committedFromEnvelope(pending.envelope, 2)],
    });
    const restartedCoordinator = createCoordinator(restartedReplica, restartedTransport);

    await restartedCoordinator.start();

    expect(restartedTransport.submissions).toEqual([]);
    expect(await restartedReplica.getRecord()).toMatchObject({
      confirmedSnapshot: {
        serverSeq: 2,
        tabs: [expect.objectContaining({ url: "https://example.com/acknowledged" })],
      },
      outbox: [],
      pendingConfirmations: [],
    });
  });

  it("ignores committed and disconnect callbacks from a stopped coordinator", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    await coordinator.stop();
    transport.emitCommitted(
      CommittedOperationSchema.parse({
        type: "op.committed",
        protocolVersion: 1,
        clientOpId: clientOpIds[0],
        roomId,
        roomEpoch: 0,
        deviceId,
        serverSeq: 2,
        operation: {
          type: "tab.navigate",
          logicalTabId: firstId,
          url: "https://example.com/stale-callback",
        },
      }),
    );
    transport.emitDisconnect();
    await coordinator.whenIdle();

    expect(coordinator.state).toBe("DISCONNECTED");
    expect((await replica.getRecord()).confirmedSnapshot?.serverSeq).toBe(1);
  });

  it("synchronizes missed commits when the transport reconnects", async () => {
    await seedSynced();
    const coordinator = createCoordinator();
    await coordinator.start();
    transport.emitDisconnect();
    transport.syncResponse = RoomDeltaMessageSchema.parse({
      type: "room.delta",
      protocolVersion: 1,
      roomId,
      roomEpoch: 0,
      fromServerSeq: 1,
      toServerSeq: 2,
      operations: [
        CommittedOperationSchema.parse({
          type: "op.committed",
          protocolVersion: 1,
          clientOpId: clientOpIds[0],
          roomId,
          roomEpoch: 0,
          deviceId,
          serverSeq: 2,
          operation: {
            type: "tab.navigate",
            logicalTabId: firstId,
            url: "https://example.com/reconnected",
          },
        }),
      ],
    });

    transport.emitReconnect();
    await coordinator.whenIdle();

    expect(coordinator.state).toBe("SYNCED");
    expect(transport.syncRequests).toHaveLength(2);
    expect((await replica.getRecord()).confirmedSnapshot).toMatchObject({
      serverSeq: 2,
      tabs: [expect.objectContaining({ url: "https://example.com/reconnected" })],
    });
  });
});
