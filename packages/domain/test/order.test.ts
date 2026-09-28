import type { LogicalTabId } from "@syncaction/protocol";
import { describe, expect, it } from "vitest";
import { insertAfter, moveBetween } from "../src/index.js";

const a = "018f8f8e-4b5c-7d6e-8f90-123456789ab1" as LogicalTabId;
const b = "018f8f8e-4b5c-7d6e-8f90-123456789ab2" as LogicalTabId;
const c = "018f8f8e-4b5c-7d6e-8f90-123456789ab3" as LogicalTabId;

describe("anchor ordering", () => {
  it("inserts after a live anchor and appends after a missing anchor", () => {
    expect(insertAfter([a, c], b, a)).toEqual([a, b, c]);
    expect(insertAfter([a], b, c)).toEqual([a, b]);
  });

  it("prefers a live successor, then predecessor, then append", () => {
    expect(moveBetween([a, b, c], c, null, a)).toEqual([c, a, b]);
    expect(moveBetween([a, b, c], a, b, null)).toEqual([b, a, c]);
    expect(moveBetween([a, b], a, c, c)).toEqual([b, a]);
  });
});
