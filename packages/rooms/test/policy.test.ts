import { describe, expect, it } from "vitest";
import { parseInvitationUsername, parseRoomId, parseRoomName } from "../src/policy.js";

describe("room input policy", () => {
  it("normalizes room names without changing meaningful Unicode", () => {
    expect(parseRoomName("  设计   协作  ")).toBe("设计 协作");
    expect(parseRoomName("Ａction")).toBe("Action");
  });

  it.each([undefined, null, 42, "", "   ", "a".repeat(101)])(
    "rejects invalid room name %j",
    (input) => {
      expect(() => parseRoomName(input)).toThrowError(
        expect.objectContaining({ code: "INVALID_ROOM_INPUT" }),
      );
    },
  );

  it("accepts UUIDs and rejects other identifiers", () => {
    expect(parseRoomId("018f8f8e-4b5c-7d6e-8f90-123456789abc")).toBe(
      "018f8f8e-4b5c-7d6e-8f90-123456789abc",
    );
    expect(() => parseRoomId("room-1")).toThrowError(
      expect.objectContaining({ code: "INVALID_ROOM_INPUT" }),
    );
  });

  it("normalizes an exact invitation username", () => {
    expect(parseInvitationUsername("  Ｔarget.User  ")).toBe("target.user");
    expect(() => parseInvitationUsername("not a username")).toThrowError(
      expect.objectContaining({ code: "INVALID_ROOM_INPUT" }),
    );
  });
});
