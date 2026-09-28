import type { ClientOpId, DeviceId, LogicalTabId, RoomId } from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import {
  applyCommittedOperation,
  createEmptyRoomState,
  DomainInvariantError,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789abc" as RoomId;
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789abd" as DeviceId;
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789abe" as ClientOpId;
const tabId = "018f8f8e-4b5c-7d6e-8f90-123456789abf" as LogicalTabId;

function committed(
  serverSeq: number,
  operation: Parameters<typeof applyCommittedOperation>[1]["operation"],
) {
  return {
    type: "op.committed" as const,
    protocolVersion: 1 as const,
    clientOpId,
    roomId,
    roomEpoch: 0,
    deviceId,
    serverSeq,
    operation,
  };
}

describe("applyCommittedOperation", () => {
  it("creates, navigates, updates, and closes a logical tab", () => {
    let state = createEmptyRoomState(roomId, 0);
    state = applyCommittedOperation(
      state,
      committed(1, {
        type: "tab.create",
        logicalTabId: tabId,
        url: "https://example.com",
        after: null,
      }),
    );
    state = applyCommittedOperation(
      state,
      committed(2, {
        type: "tab.navigate",
        logicalTabId: tabId,
        url: "https://example.com/two",
      }),
    );
    state = applyCommittedOperation(
      state,
      committed(3, {
        type: "tab.updateMetadata",
        logicalTabId: tabId,
        title: "Two",
      }),
    );
    state = applyCommittedOperation(
      state,
      committed(4, { type: "tab.close", logicalTabId: tabId }),
    );

    expect(state.serverSeq).toBe(4);
    expect(state.order).toEqual([]);
    expect(state.tabs[tabId]).toMatchObject({
      url: "https://example.com/two",
      title: "Two",
      closedAtSeq: 4,
    });
  });

  it("rejects sequence gaps and logical-tab resurrection", () => {
    const empty = createEmptyRoomState(roomId, 0);
    expect(() =>
      applyCommittedOperation(
        empty,
        committed(2, {
          type: "tab.create",
          logicalTabId: tabId,
          url: "https://example.com",
          after: null,
        }),
      ),
    ).toThrow(DomainInvariantError);

    const created = applyCommittedOperation(
      empty,
      committed(1, {
        type: "tab.create",
        logicalTabId: tabId,
        url: "https://example.com",
        after: null,
      }),
    );
    const closed = applyCommittedOperation(
      created,
      committed(2, { type: "tab.close", logicalTabId: tabId }),
    );
    expect(() =>
      applyCommittedOperation(
        closed,
        committed(3, {
          type: "tab.create",
          logicalTabId: tabId,
          url: "https://example.com/reborn",
          after: null,
        }),
      ),
    ).toThrow(DomainInvariantError);
  });
});
