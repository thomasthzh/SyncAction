import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import { applyCommittedOperation, createEmptyRoomState } from "@syncaction/domain";
import {
  CommittedOperationSchema,
  DurableOperationSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  type ClientOperationEnvelope,
  type DurableOperation,
  type RoomId,
} from "@syncaction/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RoomSequencer } from "../src/room-sequencer.js";
import { decodeMaterializedState, encodeSnapshotState } from "../src/state-codec.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-27T00:00:00.000Z");
const ownerId = "018f8f8e-4b5c-7d6e-8f90-123456789e30";
const memberId = "018f8f8e-4b5c-7d6e-8f90-123456789e31";
const outsiderId = "018f8f8e-4b5c-7d6e-8f90-123456789e32";
const ownerDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789e33";
const memberDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789e34";
const outsiderDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789e35";
const spoofedDeviceId = "018f8f8e-4b5c-7d6e-8f90-123456789e36";
const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789e37" as RoomId;
const firstTabId = "018f8f8e-4b5c-7d6e-8f90-123456789e38";
const secondTabId = "018f8f8e-4b5c-7d6e-8f90-123456789e39";
const administratorId = "018f8f8e-4b5c-7d6e-8f90-123456789e3a";

let db: ReturnType<typeof createDatabase>;
let sequencer: RoomSequencer;

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  sequencer = new RoomSequencer({ db, now: () => now });
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await db
    .updateTable("serverPolicies")
    .set({ ordinaryOpenTabLimit: 20 })
    .where("id", "=", "GLOBAL")
    .execute();
  await db
    .insertInto("users")
    .values([
      {
        id: ownerId,
        username: "SequenceOwner",
        usernameNormalized: "sequenceowner",
        displayName: "Sequence Owner",
        passwordHash: "hash",
        status: "ACTIVE",
      },
      {
        id: memberId,
        username: "SequenceMember",
        usernameNormalized: "sequencemember",
        displayName: "Sequence Member",
        passwordHash: "hash",
        status: "ACTIVE",
      },
      {
        id: outsiderId,
        username: "SequenceOutsider",
        usernameNormalized: "sequenceoutsider",
        displayName: "Sequence Outsider",
        passwordHash: "hash",
        status: "ACTIVE",
      },
    ])
    .execute();
  await db
    .insertInto("rooms")
    .values({ id: roomId, name: "Sequence Room", ownerUserId: ownerId, deletedAt: null })
    .execute();
  await db
    .insertInto("roomMemberships")
    .values([
      { roomId, userId: ownerId, role: "OWNER", createdAt: now },
      { roomId, userId: memberId, role: "MEMBER", createdAt: now },
    ])
    .execute();
});

async function linkAdministrator(userId: string): Promise<void> {
  await db
    .insertInto("administrators")
    .values({
      id: administratorId,
      username: "SequenceAdministrator",
      usernameNormalized: "sequenceadministrator",
      passwordHash: "hash",
      totpSecretCiphertext: "ciphertext",
      linkedUserId: userId,
    })
    .execute();
}

function envelope(
  operation: DurableOperation,
  options: {
    clientOpId?: string;
    deviceId?: string;
    roomEpoch?: number;
    baseServerSeq?: number;
  } = {},
): ClientOperationEnvelope {
  return {
    protocolVersion: 1,
    clientOpId: (options.clientOpId ?? randomUUID()) as ClientOperationEnvelope["clientOpId"],
    roomId,
    roomEpoch: options.roomEpoch ?? 0,
    deviceId: (options.deviceId ?? memberDeviceId) as ClientOperationEnvelope["deviceId"],
    baseServerSeq: options.baseServerSeq ?? 0,
    operation,
  };
}

async function persistedSummary() {
  const [room, operations, clientOperations, tabs] = await Promise.all([
    db
      .selectFrom("rooms")
      .select(["serverSeq", "roomEpoch"])
      .where("id", "=", roomId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("roomOperations")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("clientOperations")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("roomTabs")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    serverSeq: room.serverSeq,
    roomEpoch: room.roomEpoch,
    operationCount: Number(operations.count),
    clientOperationCount: Number(clientOperations.count),
    tabCount: Number(tabs.count),
  };
}

async function capacityBusinessSummary() {
  const [summary, openTabs, snapshots] = await Promise.all([
    persistedSummary(),
    db
      .selectFrom("roomTabs")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .where("closedAtSeq", "is", null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("roomSnapshots")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    ...summary,
    openTabCount: Number(openTabs.count),
    snapshotCount: Number(snapshots.count),
  };
}

async function exactCapacityBusinessState() {
  const [room, operations, clientOperations, tabs, snapshots] = await Promise.all([
    db
      .selectFrom("rooms")
      .select(["serverSeq", "roomEpoch", "updatedAt"])
      .where("id", "=", roomId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("roomOperations")
      .selectAll()
      .where("roomId", "=", roomId)
      .orderBy("serverSeq", "asc")
      .execute(),
    db
      .selectFrom("clientOperations")
      .selectAll()
      .where("roomId", "=", roomId)
      .orderBy("serverSeq", "asc")
      .execute(),
    db
      .selectFrom("roomTabs")
      .selectAll()
      .where("roomId", "=", roomId)
      .orderBy("logicalTabId", "asc")
      .execute(),
    db
      .selectFrom("roomSnapshots")
      .selectAll()
      .where("roomId", "=", roomId)
      .orderBy("serverSeq", "asc")
      .execute(),
  ]);
  return { room, operations, clientOperations, tabs, snapshots };
}

function createTab(logicalTabId = randomUUID()): DurableOperation {
  return {
    type: "tab.create",
    logicalTabId: logicalTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
    url: `https://example.com/tabs/${logicalTabId}`,
    after: null,
  };
}

describe("durable room operation sequencing", () => {
  it("commits every durable tab operation to one canonical materialized state", async () => {
    const operations: DurableOperation[] = [
      {
        type: "tab.create",
        logicalTabId: firstTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
        url: "https://example.com/first",
        after: null,
      },
      {
        type: "tab.create",
        logicalTabId: secondTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
        url: "https://example.com/second",
        after: firstTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
      },
      {
        type: "tab.move",
        logicalTabId: secondTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
        predecessor: null,
        successor: firstTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
      },
      {
        type: "tab.navigate",
        logicalTabId: firstTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
        url: "https://example.com/first/next",
      },
      {
        type: "tab.updateMetadata",
        logicalTabId: secondTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
        title: "Second",
        favIconUrl: "https://example.com/favicon.ico",
      },
      {
        type: "tab.close",
        logicalTabId: firstTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
      },
    ];

    for (const [index, operation] of operations.entries()) {
      const result = await sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(operation, { baseServerSeq: index }),
      });
      expect(result).toMatchObject({
        ack: { type: "op.ack", serverSeq: index + 1 },
        committed: { type: "op.committed", serverSeq: index + 1, operation },
        deduplicated: false,
      });
    }

    expect(await persistedSummary()).toEqual({
      serverSeq: 6,
      roomEpoch: 0,
      operationCount: 6,
      clientOperationCount: 6,
      tabCount: 2,
    });
    const rows = await db.selectFrom("roomTabs").selectAll().where("roomId", "=", roomId).execute();
    const state = decodeMaterializedState({ id: roomId, roomEpoch: 0, serverSeq: 6 }, rows);
    expect(state.order).toEqual([secondTabId]);
    expect(state.tabs[firstTabId as keyof typeof state.tabs]).toMatchObject({
      url: "https://example.com/first/next",
      closedAtSeq: 6,
    });
    expect(state.tabs[secondTabId as keyof typeof state.tabs]).toMatchObject({
      title: "Second",
      favIconUrl: "https://example.com/favicon.ico",
    });
  });

  it("returns the original result for exact replay and rejects changed intent reuse", async () => {
    const clientOpId = randomUUID();
    const original = envelope(
      {
        type: "tab.create",
        logicalTabId: firstTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
        url: "https://example.com/original",
        after: null,
      },
      { clientOpId },
    );
    const first = await sequencer.commitOperation({
      principal: { userId: memberId, deviceId: memberDeviceId },
      envelope: original,
    });
    const replay = await sequencer.commitOperation({
      principal: { userId: memberId, deviceId: memberDeviceId },
      envelope: original,
    });

    expect(replay).toEqual({ ...first, deduplicated: true });
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: {
          ...original,
          operation: { ...original.operation, url: "https://example.com/changed" },
        },
      }),
    ).rejects.toMatchObject({ code: "CLIENT_OP_REUSE" });
    expect(await persistedSummary()).toEqual({
      serverSeq: 1,
      roomEpoch: 0,
      operationCount: 1,
      clientOperationCount: 1,
      tabCount: 1,
    });
  });

  it("rejects spoofing, unauthorized rooms, stale epochs, future bases, and invalid transitions without writes", async () => {
    const create = {
      type: "tab.create" as const,
      logicalTabId: firstTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
      url: "https://example.com",
      after: null,
    };
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(create, { deviceId: spoofedDeviceId }),
      }),
    ).rejects.toMatchObject({ code: "DEVICE_MISMATCH" });
    await expect(
      sequencer.commitOperation({
        principal: { userId: outsiderId, deviceId: outsiderDeviceId },
        envelope: envelope(create, { deviceId: outsiderDeviceId }),
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(create, { roomEpoch: 1 }),
      }),
    ).rejects.toMatchObject({ code: "ROOM_EPOCH_MISMATCH" });
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(create, { baseServerSeq: 1 }),
      }),
    ).rejects.toMatchObject({ code: "BASE_SEQUENCE_AHEAD" });
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope({
          type: "tab.navigate",
          logicalTabId: firstTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
          url: "https://example.com/missing",
        }),
      }),
    ).rejects.toMatchObject({ code: "OPERATION_REJECTED" });
    expect(await persistedSummary()).toEqual({
      serverSeq: 0,
      roomEpoch: 0,
      operationCount: 0,
      clientOperationCount: 0,
      tabCount: 0,
    });

    await db.updateTable("rooms").set({ deletedAt: now }).where("id", "=", roomId).execute();
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(create),
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect((await persistedSummary()).serverSeq).toBe(0);
  });

  it("serializes 100 concurrent creates and reconstructs the same state from the operation log", async () => {
    await linkAdministrator(ownerId);
    const submissions = Array.from({ length: 100 }, (_, index) => {
      const deviceId = index % 2 === 0 ? ownerDeviceId : memberDeviceId;
      const userId = index % 2 === 0 ? ownerId : memberId;
      return sequencer.commitOperation({
        principal: { userId, deviceId },
        envelope: envelope(
          {
            type: "tab.create",
            logicalTabId: randomUUID() as ClientOperationEnvelope["operation"]["logicalTabId"],
            url: `https://example.com/concurrent/${index}`,
            after: null,
          },
          { deviceId },
        ),
      });
    });

    const results = await Promise.all(submissions);

    expect(results.map((result) => result.ack.serverSeq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(new Set(results.map((result) => result.committed.operation.logicalTabId)).size).toBe(
      100,
    );
    const operationRows = await db
      .selectFrom("roomOperations")
      .selectAll()
      .where("roomId", "=", roomId)
      .orderBy("serverSeq", "asc")
      .execute();
    let replayed = createEmptyRoomState(roomId, 0);
    for (const row of operationRows) {
      replayed = applyCommittedOperation(
        replayed,
        CommittedOperationSchema.parse({
          type: "op.committed",
          protocolVersion: 1,
          roomId: row.roomId,
          roomEpoch: row.roomEpoch,
          deviceId: row.deviceId,
          clientOpId: row.clientOpId,
          serverSeq: row.serverSeq,
          operation: DurableOperationSchema.parse(row.payload),
        }),
      );
    }
    const tabRows = await db
      .selectFrom("roomTabs")
      .selectAll()
      .where("roomId", "=", roomId)
      .execute();
    const materialized = decodeMaterializedState(
      { id: roomId, roomEpoch: 0, serverSeq: 100 },
      tabRows,
    );
    expect(encodeSnapshotState(materialized)).toEqual(encodeSnapshotState(replayed));
    expect(await persistedSummary()).toEqual({
      serverSeq: 100,
      roomEpoch: 0,
      operationCount: 100,
      clientOperationCount: 100,
      tabCount: 100,
    });
    const snapshots = await db
      .selectFrom("roomSnapshots")
      .select(["serverSeq", "state"])
      .where("roomId", "=", roomId)
      .execute();
    expect(snapshots).toEqual([
      expect.objectContaining({ serverSeq: 100, state: encodeSnapshotState(materialized) }),
    ]);
  }, 60_000);
});

describe("ordinary room open-tab capacity", () => {
  it("commits only a privacy-safe audit when the twenty-first tab is rejected", async () => {
    let committedAtLimit: ClientOperationEnvelope | undefined;
    for (let index = 0; index < 20; index += 1) {
      const submitted = envelope(createTab(), { baseServerSeq: index });
      await sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: submitted,
      });
      committedAtLimit = submitted;
    }
    const rejectedLogicalTabId = randomUUID();
    const rejected = envelope(createTab(rejectedLogicalTabId), {
      baseServerSeq: 20,
    });
    await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: {
        protocolVersion: 1,
        roomId,
        roomEpoch: 0,
        lastServerSeq: 0,
        hasConfirmedSnapshot: false,
      },
    });
    const before = await exactCapacityBusinessState();

    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: rejected,
      }),
    ).rejects.toMatchObject({ code: "ROOM_TAB_LIMIT_REACHED" });

    expect(await exactCapacityBusinessState()).toEqual(before);
    expect(
      await db
        .selectFrom("roomTabs")
        .select("logicalTabId")
        .where("roomId", "=", roomId)
        .where("logicalTabId", "=", rejectedLogicalTabId)
        .executeTakeFirst(),
    ).toBeUndefined();
    const audits = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("eventType", "=", "room.tab_create_capacity_rejected")
      .execute();
    expect(audits).toEqual([
      expect.objectContaining({
        actorUserId: memberId,
        actorAdministratorId: null,
        targetType: "room",
        targetId: roomId,
        details: {
          deviceId: memberDeviceId,
          clientOpId: rejected.clientOpId,
          quotaClass: "ORDINARY",
          openTabCount: 20,
          ordinaryOpenTabLimit: 20,
          reasonCode: "ROOM_TAB_LIMIT_REACHED",
        },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toMatch(
      /https?:|url|title|favicon|payload|media|pointer|danmaku|anchor|points|stroke/i,
    );

    const replay = await sequencer.commitOperation({
      principal: { userId: memberId, deviceId: memberDeviceId },
      envelope: committedAtLimit!,
    });
    expect(replay.deduplicated).toBe(true);
    const auditCount = await db
      .selectFrom("auditEvents")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("eventType", "=", "room.tab_create_capacity_rejected")
      .executeTakeFirstOrThrow();
    expect(Number(auditCount.count)).toBe(1);

    await sequencer.commitOperation({
      principal: { userId: memberId, deviceId: memberDeviceId },
      envelope: envelope(
        {
          type: "tab.close",
          logicalTabId: committedAtLimit!.operation
            .logicalTabId as ClientOperationEnvelope["operation"]["logicalTabId"],
        },
        { baseServerSeq: 20 },
      ),
    });
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: rejected,
      }),
    ).resolves.toMatchObject({
      ack: { serverSeq: 22 },
      deduplicated: false,
    });
    expect((await capacityBusinessSummary()).openTabCount).toBe(20);
  });

  it("does not audit unauthorized or invalid create attempts at capacity", async () => {
    const existingLogicalTabId = randomUUID();
    for (let index = 0; index < 20; index += 1) {
      await sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(createTab(index === 0 ? existingLogicalTabId : undefined), {
          baseServerSeq: index,
        }),
      });
    }

    await expect(
      sequencer.commitOperation({
        principal: { userId: outsiderId, deviceId: outsiderDeviceId },
        envelope: envelope(createTab(), {
          deviceId: outsiderDeviceId,
          baseServerSeq: 20,
        }),
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: {
          ...envelope(createTab(), { baseServerSeq: 20 }),
          operation: {
            ...createTab(),
            url: "javascript:alert(document.cookie)",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_SYNC_MESSAGE" });
    await expect(
      sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(createTab(existingLogicalTabId), {
          baseServerSeq: 20,
        }),
      }),
    ).rejects.toMatchObject({ code: "OPERATION_REJECTED" });

    const auditCount = await db
      .selectFrom("auditEvents")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("eventType", "=", "room.tab_create_capacity_rejected")
      .executeTakeFirstOrThrow();
    expect(Number(auditCount.count)).toBe(0);
  });

  it("serializes the twentieth tab across distinct sequencers", async () => {
    for (let index = 0; index < 19; index += 1) {
      await sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(createTab(), { baseServerSeq: index }),
      });
    }
    const firstSequencer = new RoomSequencer({ db, now: () => now });
    const secondSequencer = new RoomSequencer({ db, now: () => now });

    const results = await Promise.allSettled([
      firstSequencer.commitOperation({
        principal: { userId: ownerId, deviceId: ownerDeviceId },
        envelope: envelope(createTab(), { deviceId: ownerDeviceId, baseServerSeq: 19 }),
      }),
      secondSequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(createTab(), { baseServerSeq: 19 }),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected").map((result) => result.reason),
    ).toEqual([expect.objectContaining({ code: "ROOM_TAB_LIMIT_REACHED" })]);
    expect(await capacityBusinessSummary()).toMatchObject({
      serverSeq: 20,
      operationCount: 20,
      clientOperationCount: 20,
      tabCount: 20,
      openTabCount: 20,
    });
  });

  it("allows an administrator-linked owner's room to exceed twenty tabs", async () => {
    await linkAdministrator(ownerId);

    for (let index = 0; index < 21; index += 1) {
      await sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope(createTab(), { baseServerSeq: index }),
      });
    }

    expect(await capacityBusinessSummary()).toMatchObject({
      serverSeq: 21,
      operationCount: 21,
      clientOperationCount: 21,
      tabCount: 21,
      openTabCount: 21,
    });
    expect(await db.selectFrom("auditEvents").selectAll().execute()).toEqual([]);
  });
});

describe("room synchronization recovery", () => {
  async function commitRecoveryOperations(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await sequencer.commitOperation({
        principal: { userId: memberId, deviceId: memberDeviceId },
        envelope: envelope({
          type: "tab.create",
          logicalTabId: randomUUID() as ClientOperationEnvelope["operation"]["logicalTabId"],
          url: `https://example.com/recovery/${index}`,
          after: null,
        }),
      });
    }
  }

  function syncRequest(
    roomEpoch: number,
    lastServerSeq: number,
    hasConfirmedSnapshot = lastServerSeq > 0,
  ) {
    return {
      protocolVersion: 1,
      roomId,
      roomEpoch,
      lastServerSeq,
      hasConfirmedSnapshot,
    };
  }

  it("returns and stores one sequence-zero snapshot for an empty room", async () => {
    const first = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 0),
    });
    const second = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 0),
    });

    expect(RoomSnapshotMessageSchema.parse(first)).toMatchObject({
      type: "room.snapshot",
      state: { roomId, roomEpoch: 0, serverSeq: 0, order: [], tabs: [] },
    });
    expect(second).toEqual(first);
    const snapshots = await db
      .selectFrom("roomSnapshots")
      .selectAll()
      .where("roomId", "=", roomId)
      .execute();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ roomEpoch: 0, serverSeq: 0 });
  });

  it("returns contiguous missed operations, an empty current delta, and snapshots for incompatible cursors", async () => {
    await commitRecoveryOperations(3);

    const missed = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 1),
    });
    const current = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 3),
    });
    const unknownState = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 0),
    });
    const knownSequenceZero = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 0, true),
    });
    const epochMismatch = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(99, 0),
    });
    const futureCursor = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 99),
    });

    expect(RoomDeltaMessageSchema.parse(missed)).toMatchObject({
      type: "room.delta",
      fromServerSeq: 1,
      toServerSeq: 3,
      operations: [{ serverSeq: 2 }, { serverSeq: 3 }],
    });
    expect(RoomDeltaMessageSchema.parse(current)).toMatchObject({
      fromServerSeq: 3,
      toServerSeq: 3,
      operations: [],
    });
    expect(RoomSnapshotMessageSchema.parse(unknownState)).toMatchObject({
      state: { roomEpoch: 0, serverSeq: 3 },
    });
    expect(RoomDeltaMessageSchema.parse(knownSequenceZero)).toMatchObject({
      fromServerSeq: 0,
      toServerSeq: 3,
      operations: [{ serverSeq: 1 }, { serverSeq: 2 }, { serverSeq: 3 }],
    });
    expect(RoomSnapshotMessageSchema.parse(epochMismatch)).toMatchObject({
      state: { roomEpoch: 0, serverSeq: 3 },
    });
    expect(RoomSnapshotMessageSchema.parse(futureCursor)).toMatchObject({
      state: { roomEpoch: 0, serverSeq: 3 },
    });
  });

  it("uses a snapshot when the operation tail exceeds the configured recovery limit", async () => {
    await commitRecoveryOperations(4);
    const limitedSequencer = new RoomSequencer({ db, now: () => now, deltaLimit: 2 });

    const result = await limitedSequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 1),
    });

    expect(RoomSnapshotMessageSchema.parse(result)).toMatchObject({
      state: { serverSeq: 4, tabs: expect.arrayContaining([expect.any(Object)]) },
    });
  });

  it("falls back to a snapshot when the stored operation tail has a gap", async () => {
    await commitRecoveryOperations(3);
    await db
      .deleteFrom("roomOperations")
      .where("roomId", "=", roomId)
      .where("serverSeq", "=", 2)
      .execute();

    const result = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(0, 1),
    });

    expect(RoomSnapshotMessageSchema.parse(result)).toMatchObject({
      state: { serverSeq: 3 },
    });
  });

  it("fails closed when materialized state cannot form a valid snapshot", async () => {
    await commitRecoveryOperations(1);
    await db.updateTable("roomTabs").set({ position: 5 }).where("roomId", "=", roomId).execute();

    await expect(
      sequencer.synchronize({
        principal: { userId: memberId, deviceId: memberDeviceId },
        request: syncRequest(99, 0),
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  });

  it("reconstructs the exact current snapshot after the sequencer and database client restart", async () => {
    await commitRecoveryOperations(3);
    const beforeRestart = await sequencer.synchronize({
      principal: { userId: memberId, deviceId: memberDeviceId },
      request: syncRequest(99, 0),
    });
    const restartedDb = createDatabase(connectionString);
    const restartedSequencer = new RoomSequencer({ db: restartedDb, now: () => now });
    try {
      const afterRestart = await restartedSequencer.synchronize({
        principal: { userId: memberId, deviceId: memberDeviceId },
        request: syncRequest(99, 0),
      });
      expect(afterRestart).toEqual(beforeRestart);
    } finally {
      await restartedDb.destroy();
    }
  });
});
