import { describe, expect, it } from "vitest";
import { ClientOperationEnvelopeSchema, ServerMessageSchema } from "../src/index.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789abc";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789abd";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789abe";
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789abf";

const envelope = {
  protocolVersion: 1,
  clientOpId,
  roomId,
  roomEpoch: 0,
  deviceId,
  baseServerSeq: 0,
  operation: {
    type: "tab.create",
    logicalTabId,
    url: "https://example.com",
    after: null,
  },
};

describe("client envelope", () => {
  it("parses a versioned operation", () => {
    expect(ClientOperationEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects unsupported protocol versions", () => {
    expect(() =>
      ClientOperationEnvelopeSchema.parse({ ...envelope, protocolVersion: 2 }),
    ).toThrow();
  });
});

describe("server messages", () => {
  it("parses ACK and committed operation messages", () => {
    expect(
      ServerMessageSchema.parse({
        type: "op.ack",
        protocolVersion: 1,
        clientOpId,
        roomId,
        roomEpoch: 0,
        serverSeq: 1,
      }),
    ).toMatchObject({ type: "op.ack", serverSeq: 1 });

    expect(
      ServerMessageSchema.parse({
        type: "op.committed",
        protocolVersion: 1,
        roomId,
        roomEpoch: 0,
        deviceId,
        clientOpId,
        serverSeq: 1,
        operation: envelope.operation,
      }),
    ).toMatchObject({ type: "op.committed", serverSeq: 1 });
  });
});
