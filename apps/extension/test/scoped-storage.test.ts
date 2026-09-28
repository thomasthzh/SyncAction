import { describe, expect, it } from "vitest";
import { serverScopedStorageKey } from "../src/scoped-storage.js";

describe("serverScopedStorageKey", () => {
  it("places an already-versioned logical key below one server profile", () => {
    expect(serverScopedStorageKey("server-a", "syncaction.replica.v1.room")).toBe(
      "syncaction.server.server-a.syncaction.replica.v1.room",
    );
  });

  it.each([
    ["", "key"],
    ["UPPERCASE", "key"],
    ["server-a", ""],
    ["server-a", "contains a space"],
    ["server-a", "contains/a/slash"],
    ["server-a", "x".repeat(513)],
  ])("rejects an invalid profile or logical key", (profileId, key) => {
    expect(() => serverScopedStorageKey(profileId, key)).toThrow();
  });
});
