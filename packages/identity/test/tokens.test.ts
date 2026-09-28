import { describe, expect, it } from "vitest";
import { createAccessTokenCodec, createOpaqueToken, hashOpaqueToken } from "../src/tokens.js";

const userId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ab2";
const sessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab3";

describe("access tokens", () => {
  it("signs and verifies the required SyncAction principal", async () => {
    const tokens = createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(7),
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });

    const token = await tokens.sign({ userId, deviceId, sessionId });

    await expect(tokens.verify(token)).resolves.toEqual({
      userId,
      deviceId,
      sessionId,
    });
  });

  it("expires after fifteen minutes", async () => {
    let now = new Date("2026-07-26T00:00:00.000Z");
    const tokens = createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(7),
      now: () => now,
    });
    const token = await tokens.sign({ userId, deviceId, sessionId });

    now = new Date("2026-07-26T00:14:59.000Z");
    await expect(tokens.verify(token)).resolves.toMatchObject({ userId });
    now = new Date("2026-07-26T00:15:01.000Z");
    await expect(tokens.verify(token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects a wrong audience, key, or malformed principal", async () => {
    const now = () => new Date("2026-07-26T00:00:00.000Z");
    const tokens = createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(7),
      now,
    });
    const wrongAudience = createAccessTokenCodec({
      issuer: "syncaction",
      audience: "another-client",
      secret: new Uint8Array(32).fill(7),
      now,
    });
    const wrongKey = createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(8),
      now,
    });
    const token = await tokens.sign({ userId, deviceId, sessionId });

    await expect(wrongAudience.verify(token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(wrongKey.verify(token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(
      tokens.sign({ userId: "not-a-user-id", deviceId, sessionId }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("opaque tokens", () => {
  it("generates 256-bit base64url secrets and deterministic SHA-256 hashes", () => {
    const token = createOpaqueToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(hashOpaqueToken(token)).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
    expect(hashOpaqueToken(createOpaqueToken())).not.toBe(hashOpaqueToken(token));
  });
});
