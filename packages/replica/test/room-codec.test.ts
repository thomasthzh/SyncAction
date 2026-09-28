import { applyCommittedOperation, assertRoomInvariants } from "@syncaction/domain";
import {
  CommittedOperationSchema,
  RoomSnapshotStateSchema,
  type LogicalTabId,
} from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import { decodeSnapshot, encodeRoomState } from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const firstId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const secondId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const closedId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";

const snapshot = RoomSnapshotStateSchema.parse({
  roomId,
  roomEpoch: 2,
  serverSeq: 4,
  order: [secondId, firstId],
  tabs: [
    {
      id: firstId,
      url: "https://example.com/duplicate",
      title: "First",
      favIconUrl: null,
      createdAtSeq: 1,
      updatedAtSeq: 4,
      closedAtSeq: null,
    },
    {
      id: secondId,
      url: "https://example.com/duplicate",
      favIconUrl: "https://example.com/icon.png",
      createdAtSeq: 2,
      updatedAtSeq: 2,
      closedAtSeq: null,
    },
    {
      id: closedId,
      url: "https://example.com/closed",
      favIconUrl: null,
      createdAtSeq: 3,
      updatedAtSeq: 4,
      closedAtSeq: 4,
    },
  ],
});

describe("room snapshot codec", () => {
  it("preserves logical identity, duplicate URLs, order, metadata, and tombstones", () => {
    const state = decodeSnapshot(snapshot);

    expect(state.order).toEqual([secondId, firstId]);
    expect(Object.values(state.tabs)).toHaveLength(3);
    expect(state.tabs[firstId as LogicalTabId]).toMatchObject({
      id: firstId,
      url: "https://example.com/duplicate",
      title: "First",
      favIconUrl: null,
    });
    expect(state.tabs[closedId as LogicalTabId]?.closedAtSeq).toBe(4);
    expect(encodeRoomState(state)).toEqual(snapshot);
  });

  it("round-trips state after a pure committed operation", () => {
    const state = decodeSnapshot(snapshot);
    const committed = CommittedOperationSchema.parse({
      type: "op.committed",
      protocolVersion: 1,
      clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ac0",
      roomId,
      roomEpoch: 2,
      deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
      serverSeq: 5,
      operation: {
        type: "tab.navigate",
        logicalTabId: firstId,
        url: "https://example.com/changed",
      },
    });
    const next = applyCommittedOperation(state, committed);

    const decoded = decodeSnapshot(encodeRoomState(next));

    assertRoomInvariants(decoded);
    expect(decoded).toEqual(next);
  });

  it("rejects malformed or invariant-breaking snapshots", () => {
    expect(() =>
      decodeSnapshot({
        ...snapshot,
        order: [firstId],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_REMOTE_STATE" }));
  });
});
