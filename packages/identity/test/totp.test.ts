import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";
import {
  createTotpEnrollmentUri,
  generateTotpSecret,
  openTotpSecret,
  sealTotpSecret,
  verifyTotp,
} from "../src/totp.js";

const encryptionKey = new Uint8Array(32).fill(11);
const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

describe("TOTP secret encryption", () => {
  it("round-trips a Base32 secret without exposing it in storage", () => {
    const sealed = sealTotpSecret(secret, encryptionKey);

    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/u);
    expect(sealed).not.toContain(secret);
    expect(openTotpSecret(sealed, encryptionKey)).toBe(secret);
  });

  it("rejects a wrong encryption key and tampered ciphertext", () => {
    const sealed = sealTotpSecret(secret, encryptionKey);

    expect(() => openTotpSecret(sealed, new Uint8Array(32).fill(12))).toThrow();
    expect(() => openTotpSecret(`${sealed}x`, encryptionKey)).toThrow();
  });
});

describe("TOTP enrollment", () => {
  it("generates independent 160-bit Base32 secrets", () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();

    expect(first).not.toBe(second);
    expect(OTPAuth.Secret.fromBase32(first).buffer.byteLength).toBe(20);
    expect(OTPAuth.Secret.fromBase32(second).buffer.byteLength).toBe(20);
  });

  it("creates a SyncAction enrollment URI for the administrator", () => {
    const uri = new URL(createTotpEnrollmentUri("admin", secret));

    expect(uri.protocol).toBe("otpauth:");
    expect(uri.hostname).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/SyncAction:admin");
    expect(uri.searchParams.get("issuer")).toBe("SyncAction");
    expect(uri.searchParams.get("secret")).toBe(secret);
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");
  });
});

describe("TOTP counter verification", () => {
  it("accepts a valid counter exactly once", () => {
    const timestamp = new Date("2026-07-26T00:00:00.000Z").getTime();
    const totp = new OTPAuth.TOTP({ secret, digits: 6, period: 30 });
    const counter = totp.counter({ timestamp });
    const token = totp.generate({ timestamp });

    expect(
      verifyTotp({
        secret,
        token,
        timestamp,
        lastAcceptedCounter: counter - 1,
      }),
    ).toBe(counter);
    expect(() =>
      verifyTotp({
        secret,
        token,
        timestamp,
        lastAcceptedCounter: counter,
      }),
    ).toThrowError("ADMIN_TOTP_REPLAYED");
  });

  it("accepts only the adjacent counter window", () => {
    const timestamp = new Date("2026-07-26T00:00:00.000Z").getTime();
    const totp = new OTPAuth.TOTP({ secret, digits: 6, period: 30 });
    const previousToken = totp.generate({ timestamp: timestamp - 30_000 });
    const tooOldToken = totp.generate({ timestamp: timestamp - 60_000 });

    expect(
      verifyTotp({
        secret,
        token: previousToken,
        timestamp,
        lastAcceptedCounter: -1,
      }),
    ).toBe(totp.counter({ timestamp }) - 1);
    expect(() =>
      verifyTotp({
        secret,
        token: tooOldToken,
        timestamp,
        lastAcceptedCounter: -1,
      }),
    ).toThrowError("ADMIN_INVALID_CREDENTIALS");
  });
});
