import { createDatabase, migrateToLatest } from "@syncaction/database";
import { applyCommittedOperation, createEmptyRoomState, type RoomState } from "@syncaction/domain";
import type {
  ClientOpId,
  DeviceId,
  DurableOperation,
  LogicalTabId,
  RoomId,
} from "@syncaction/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeMaterializedState } from "../src/materializer.js";
import { decodeMaterializedState, encodeSnapshotState } from "../src/state-codec.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789e10" as RoomId;
const ownerId = "018f8f8e-4b5c-7d6e-8f90-123456789e11";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789e12" as DeviceId;
const firstTabId = "018f8f8e-4b5c-7d6e-8f90-123456789e13" as LogicalTabId;
const secondTabId = "018f8f8e-4b5c-7d6e-8f90-123456789e14" as LogicalTabId;
const middleTabId = "018f8f8e-4b5c-7d6e-8f90-123456789e15" as LogicalTabId;
const clientOpIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789e20",
  "018f8f8e-4b5c-7d6e-8f90-123456789e21",
  "018f8f8e-4b5c-7d6e-8f90-123456789e22",
  "018f8f8e-4b5c-7d6e-8f90-123456789e23",
  "018f8f8e-4b5c-7d6e-8f90-123456789e24",
  "018f8f8e-4b5c-7d6e-8f90-123456789e25",
  "018f8f8e-4b5c-7d6e-8f90-123456789e26",
] as ClientOpId[];

let db: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await db
    .insertInto("users")
    .values({
      id: ownerId,
      username: "MaterializerOwner",
      usernameNormalized: "materializerowner",
      displayName: "Materializer Owner",
      passwordHash: "hash",
      status: "ACTIVE",
    })
    .execute();
  await db
    .insertInto("rooms")
    .values({ id: roomId, name: "Materializer", ownerUserId: ownerId, deletedAt: null })
    .execute();
});

function committed(serverSeq: number, operation: DurableOperation) {
  return {
    type: "op.committed" as const,
    protocolVersion: 1 as const,
    clientOpId: clientOpIds[serverSeq - 1]!,
    roomId,
    roomEpoch: 0,
    deviceId,
    serverSeq,
    operation,
  };
}

async function persistAndReconstruct(previous: RoomState, next: RoomState): Promise<RoomState> {
  await db
    .transaction()
    .execute((transaction) => writeMaterializedState(transaction, previous, next));
  const rows = await db.selectFrom("roomTabs").selectAll().where("roomId", "=", roomId).execute();
  const activePositions = rows.filter((row) => row.closedAtSeq === null).map((row) => row.position);
  expect(new Set(activePositions).size).toBe(activePositions.length);
  expect([...activePositions].sort((left, right) => left - right)).toEqual(
    next.order.map((_id, index) => index),
  );
  const reconstructed = decodeMaterializedState(
    { id: roomId, roomEpoch: next.roomEpoch, serverSeq: next.serverSeq },
    rows,
  );
  expect(encodeSnapshotState(reconstructed)).toEqual(encodeSnapshotState(next));
  return reconstructed;
}

describe("materialized room writer", () => {
  it("persists create, insert, swap, navigate, metadata, and close without position collisions", async () => {
    const operations: DurableOperation[] = [
      {
        type: "tab.create",
        logicalTabId: firstTabId,
        url: "https://example.com/first",
        after: null,
      },
      {
        type: "tab.create",
        logicalTabId: secondTabId,
        url: "https://example.com/second",
        after: firstTabId,
      },
      {
        type: "tab.create",
        logicalTabId: middleTabId,
        url: "https://example.com/middle",
        after: firstTabId,
      },
      {
        type: "tab.move",
        logicalTabId: secondTabId,
        predecessor: null,
        successor: firstTabId,
      },
      {
        type: "tab.navigate",
        logicalTabId: middleTabId,
        url: "https://example.com/middle/next",
      },
      {
        type: "tab.updateMetadata",
        logicalTabId: secondTabId,
        title: "Second",
        favIconUrl: "https://example.com/favicon.ico",
      },
      {
        type: "tab.close",
        logicalTabId: firstTabId,
      },
    ];

    let state = createEmptyRoomState(roomId, 0);
    for (const [index, operation] of operations.entries()) {
      const next = applyCommittedOperation(state, committed(index + 1, operation));
      state = await persistAndReconstruct(state, next);
    }

    expect(state.order).toEqual([secondTabId, middleTabId]);
    expect(state.tabs[firstTabId]?.closedAtSeq).toBe(7);
    expect(state.tabs[middleTabId]?.url).toBe("https://example.com/middle/next");
    expect(state.tabs[secondTabId]).toMatchObject({
      title: "Second",
      favIconUrl: "https://example.com/favicon.ico",
    });
  });
});
