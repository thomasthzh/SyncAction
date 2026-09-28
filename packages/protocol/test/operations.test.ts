import { describe, expect, it } from "vitest";
import { DurableOperationSchema } from "../src/index.js";

const tabId = "018f8f8e-4b5c-7d6e-8f90-123456789abc";
const otherId = "018f8f8e-4b5c-7d6e-8f90-123456789abd";

describe("DurableOperationSchema", () => {
  it("parses every durable operation", () => {
    const operations = [
      { type: "tab.create", logicalTabId: tabId, url: "https://example.com", after: null },
      { type: "tab.navigate", logicalTabId: tabId, url: "https://example.com/two" },
      { type: "tab.close", logicalTabId: tabId },
      {
        type: "tab.move",
        logicalTabId: tabId,
        predecessor: null,
        successor: otherId,
      },
      {
        type: "tab.updateMetadata",
        logicalTabId: tabId,
        title: "Example",
        favIconUrl: "https://example.com/favicon.ico",
      },
    ];

    for (const operation of operations) {
      expect(DurableOperationSchema.parse(operation)).toEqual(operation);
    }
  });

  it("rejects unsupported navigation schemes and unknown fields", () => {
    expect(() =>
      DurableOperationSchema.parse({
        type: "tab.navigate",
        logicalTabId: tabId,
        url: "file:///secret",
      }),
    ).toThrow();
    expect(() =>
      DurableOperationSchema.parse({
        type: "tab.close",
        logicalTabId: tabId,
        unexpected: true,
      }),
    ).toThrow();
  });
});
