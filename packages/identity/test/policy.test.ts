import { describe, expect, it } from "vitest";
import { parseDeviceId, parseDisplayName, parsePassword, parseUsername } from "../src/policy.js";

describe("credential policy", () => {
  it("normalizes an accepted username without changing its display casing", () => {
    expect(parseUsername(" Alex ")).toEqual({
      username: "Alex",
      usernameNormalized: "alex",
    });
  });

  it.each(["ab", "a b", "-alex", "alex-", "张三三"])("rejects invalid username %s", (username) => {
    expect(() => parseUsername(username)).toThrowError("INVALID_INPUT");
  });

  it("normalizes display-name whitespace and preserves Unicode", () => {
    expect(parseDisplayName("  Alex   张  ")).toBe("Alex 张");
  });

  it.each(["", " ".repeat(4), "x".repeat(65)])("rejects invalid display name", (displayName) => {
    expect(() => parseDisplayName(displayName)).toThrowError("INVALID_INPUT");
  });

  it.each(["short", "x".repeat(129)])("rejects password outside 12–128 characters", (password) => {
    expect(() => parsePassword(password)).toThrowError("INVALID_INPUT");
  });

  it("accepts a password at both policy boundaries", () => {
    expect(parsePassword("x".repeat(12))).toBe("x".repeat(12));
    expect(parsePassword("x".repeat(128))).toBe("x".repeat(128));
  });

  it("accepts UUID device identities only", () => {
    const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789abc";
    expect(parseDeviceId(deviceId)).toBe(deviceId);
    expect(() => parseDeviceId("browser-one")).toThrowError("INVALID_INPUT");
  });
});
