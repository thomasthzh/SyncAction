import { DurableReplica, MemoryReplicaPersistence, ReplicaRepository } from "@syncaction/replica";
import { RoomIdSchema } from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import { isConfirmedPageDocument } from "../src/confirmed-page-document.js";
import { resolveMediaRoute } from "../src/media-controller-model.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789ab1");
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const otherTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab5";
const firstUrl = "https://example.com/first";

async function fixture() {
  const replica = new DurableReplica({
    repository: new ReplicaRepository({ persistence: new MemoryReplicaPersistence() }),
    roomId,
    deviceId,
  });
  await replica.applySnapshot({
    type: "room.snapshot",
    protocolVersion: 1,
    state: {
      roomId,
      roomEpoch: 0,
      serverSeq: 2,
      order: [logicalTabId, otherTabId],
      tabs: [
        { id: logicalTabId, url: firstUrl, createdAtSeq: 1, updatedAtSeq: 1, closedAtSeq: null },
        {
          id: otherTabId,
          url: "https://example.com/other",
          createdAtSeq: 2,
          updatedAtSeq: 2,
          closedAtSeq: null,
        },
      ],
    },
  });
  await replica.bindTab({
    logicalTabId,
    tabId: 7,
    windowId: 1,
    groupId: 2,
    browserSessionId,
    validatedAtServerSeq: 2,
  });
  return replica;
}

describe("confirmed page documents", () => {
  it.each(["outbox", "acknowledged"] as const)(
    "blocks navigation, including an unchanged URL, while %s",
    async (stage) => {
      for (const url of [firstUrl, "https://example.com/new"]) {
        const replica = await fixture();
        const item = await replica.enqueueLocalOperation({
          type: "tab.navigate",
          logicalTabId,
          url,
        });
        if (stage === "acknowledged")
          await replica.acknowledge({
            type: "op.ack",
            protocolVersion: 1,
            roomId,
            roomEpoch: 0,
            clientOpId: item.envelope.clientOpId,
            serverSeq: 3,
          });
        const record = await replica.getRecord();
        expect(isConfirmedPageDocument(record, logicalTabId)).toBe(false);
        expect(resolveMediaRoute(record, roomId, browserSessionId, 7, 0, "top")).toBeNull();
        await replica.applyCommitted({
          type: "op.committed",
          protocolVersion: 1,
          roomId,
          roomEpoch: 0,
          deviceId,
          clientOpId: item.envelope.clientOpId,
          operation: item.envelope.operation,
          serverSeq: 3,
        });
        expect(isConfirmedPageDocument(await replica.getRecord(), logicalTabId)).toBe(true);
      }
    },
  );

  it("blocks pending close and unconfirmed creates while keeping unrelated confirmed pages usable", async () => {
    const replica = await fixture();
    await replica.enqueueLocalOperation({ type: "tab.close", logicalTabId });
    expect(isConfirmedPageDocument(await replica.getRecord(), logicalTabId)).toBe(false);
    expect(isConfirmedPageDocument(await replica.getRecord(), otherTabId)).toBe(true);
    const newId = "018f8f8e-4b5c-7d6e-8f90-123456789ab6";
    await replica.enqueueLocalOperation({
      type: "tab.create",
      logicalTabId: newId,
      url: "https://example.com/new",
      after: otherTabId,
    });
    expect(isConfirmedPageDocument(await replica.getRecord(), newId)).toBe(false);
  });

  it("allows pending metadata and reorder, and fails closed without usable confirmed state", async () => {
    const replica = await fixture();
    await replica.enqueueLocalOperation({
      type: "tab.updateMetadata",
      logicalTabId,
      title: "New title",
    });
    await replica.enqueueLocalOperation({
      type: "tab.move",
      logicalTabId,
      predecessor: otherTabId,
      successor: null,
    });
    expect(isConfirmedPageDocument(await replica.getRecord(), logicalTabId)).toBe(true);
    await replica.beginSynchronization();
    expect(isConfirmedPageDocument(await replica.getRecord(), logicalTabId)).toBe(false);
  });
});
