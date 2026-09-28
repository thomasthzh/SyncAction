import type {
  ClientOpId,
  DeviceId,
  DurableOperation,
  LogicalTabId,
  RoomId,
} from "@syncaction/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyCommittedOperation,
  assertRoomInvariants,
  createEmptyRoomState,
  DomainInvariantError,
} from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789abc" as RoomId;
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789abd" as DeviceId;
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789abe" as ClientOpId;
const ids = [
  "018f8f8e-4b5c-7d6e-8f90-123456789a01",
  "018f8f8e-4b5c-7d6e-8f90-123456789a02",
  "018f8f8e-4b5c-7d6e-8f90-123456789a03",
  "018f8f8e-4b5c-7d6e-8f90-123456789a04",
] as const;

const idArb = fc.constantFrom(...ids).map((id) => id as LogicalTabId);
const operationArb: fc.Arbitrary<DurableOperation> = fc.oneof(
  idArb.map((logicalTabId) => ({
    type: "tab.create" as const,
    logicalTabId,
    url: "https://example.com",
    after: null,
  })),
  idArb.map((logicalTabId) => ({
    type: "tab.navigate" as const,
    logicalTabId,
    url: "https://example.com/next",
  })),
  idArb.map((logicalTabId) => ({
    type: "tab.close" as const,
    logicalTabId,
  })),
  fc.tuple(idArb, idArb, idArb).map(([logicalTabId, predecessor, successor]) => ({
    type: "tab.move" as const,
    logicalTabId,
    predecessor,
    successor,
  })),
);

describe("room reducer properties", () => {
  it("preserves order, activity, tombstone, and sequence invariants", () => {
    fc.assert(
      fc.property(fc.array(operationArb, { maxLength: 100 }), (operations) => {
        let state = createEmptyRoomState(roomId, 0);
        for (const operation of operations) {
          try {
            state = applyCommittedOperation(state, {
              type: "op.committed",
              protocolVersion: 1,
              clientOpId,
              roomId,
              roomEpoch: 0,
              deviceId,
              serverSeq: state.serverSeq + 1,
              operation,
            });
          } catch (error) {
            expect(error).toBeInstanceOf(DomainInvariantError);
          }
          assertRoomInvariants(state);
        }
      }),
      { numRuns: 500 },
    );
  });
});
