import { describe, expect, it } from "vitest";
import {
  ClientOpIdSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  SupportedUrlSchema,
} from "../src/index.js";

const id = "018f8f8e-4b5c-7d6e-8f90-123456789abc";

describe("wire identifiers", () => {
  it.each([RoomIdSchema, DeviceIdSchema, LogicalTabIdSchema, ClientOpIdSchema])(
    "accepts UUID identifiers",
    (schema) => {
      expect(schema.parse(id)).toBe(id);
      expect(() => schema.parse("room-one")).toThrow();
      expect(() => schema.parse(id.toUpperCase())).toThrow();
    },
  );
});

describe("supported URLs", () => {
  it("accepts HTTP and HTTPS only", () => {
    expect(SupportedUrlSchema.parse("https://example.com/path")).toBe("https://example.com/path");
    expect(SupportedUrlSchema.parse("http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(() => SupportedUrlSchema.parse("file:///tmp/a")).toThrow();
    expect(() => SupportedUrlSchema.parse("chrome://settings")).toThrow();
  });

  it("shares credential and serialized-length rules with canonical URL parsing", () => {
    expect(() => SupportedUrlSchema.parse("https://user:password@example.com/")).toThrow();
    const expandsBeyondWireLimit = `https://example.com/${"é".repeat(680)}`;
    expect(expandsBeyondWireLimit.length).toBeLessThan(4_096);
    expect(() => SupportedUrlSchema.parse(expandsBeyondWireLimit)).toThrow();
  });
});
