import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import * as OTPAuth from "otpauth";
import { IdentityError } from "./errors.js";

const version = "v1";
const authenticatedContext = Buffer.from("syncaction:totp:v1", "utf8");
const periodSeconds = 30;

function parseEncryptionKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) {
    throw new IdentityError("INVALID_INPUT");
  }
  return Buffer.from(key);
}

function parseBase32Secret(secret: string): string {
  const normalized = secret.trim().toUpperCase();
  try {
    OTPAuth.Secret.fromBase32(normalized);
    return normalized;
  } catch (cause) {
    throw new IdentityError("INVALID_INPUT", { cause });
  }
}

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function createTotpEnrollmentUri(username: string, secret: string): string {
  return new OTPAuth.TOTP({
    issuer: "SyncAction",
    label: username,
    secret: parseBase32Secret(secret),
    digits: 6,
    period: periodSeconds,
  }).toString();
}

export function sealTotpSecret(secret: string, key: Uint8Array): string {
  const normalized = parseBase32Secret(secret);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseEncryptionKey(key), nonce);
  cipher.setAAD(authenticatedContext);
  const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  return [
    version,
    nonce.toString("base64url"),
    authenticationTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openTotpSecret(sealed: string, key: Uint8Array): string {
  try {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== version) {
      throw new Error("Unsupported TOTP ciphertext");
    }
    const nonce = Buffer.from(parts[1] ?? "", "base64url");
    const authenticationTag = Buffer.from(parts[2] ?? "", "base64url");
    const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
    if (nonce.byteLength !== 12 || authenticationTag.byteLength !== 16 || ciphertext.length === 0) {
      throw new Error("Malformed TOTP ciphertext");
    }
    const decipher = createDecipheriv("aes-256-gcm", parseEncryptionKey(key), nonce);
    decipher.setAAD(authenticatedContext);
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    return parseBase32Secret(plaintext);
  } catch (cause) {
    if (cause instanceof IdentityError && cause.code === "INVALID_INPUT") {
      throw cause;
    }
    throw new IdentityError("ADMIN_INVALID_CREDENTIALS", { cause });
  }
}

export interface VerifyTotpInput {
  secret: string;
  token: string;
  timestamp: number;
  lastAcceptedCounter: number;
}

export function verifyTotp(input: VerifyTotpInput): number {
  if (!/^\d{6}$/u.test(input.token) || !Number.isFinite(input.timestamp)) {
    throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
  }
  const totp = new OTPAuth.TOTP({
    secret: parseBase32Secret(input.secret),
    digits: 6,
    period: periodSeconds,
  });
  const currentCounter = totp.counter({ timestamp: input.timestamp });
  const presented = Buffer.from(input.token, "ascii");
  const matchingCounters: number[] = [];
  for (const offset of [-1, 0, 1]) {
    const counter = currentCounter + offset;
    if (counter < 0) {
      continue;
    }
    const candidate = Buffer.from(
      totp.generate({ timestamp: counter * periodSeconds * 1_000 }),
      "ascii",
    );
    if (candidate.byteLength === presented.byteLength && timingSafeEqual(candidate, presented)) {
      matchingCounters.push(counter);
    }
  }
  const matchedCounter = matchingCounters.length === 0 ? undefined : Math.max(...matchingCounters);
  if (matchedCounter === undefined) {
    throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
  }
  if (matchedCounter <= input.lastAcceptedCounter) {
    throw new IdentityError("ADMIN_TOTP_REPLAYED");
  }
  return matchedCounter;
}
