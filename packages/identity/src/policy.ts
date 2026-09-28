import { z } from "zod";
import { IdentityError } from "./errors.js";

const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])$/u);
const displayNameSchema = z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= 1 && length <= 64;
});
const passwordSchema = z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= 12 && length <= 128;
});
const deviceIdSchema = z.uuid();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new IdentityError("INVALID_INPUT", { cause: result.error });
  }
  return result.data;
}

export interface ParsedUsername {
  username: string;
  usernameNormalized: string;
}

export function parseUsername(input: unknown): ParsedUsername {
  if (typeof input !== "string") {
    throw new IdentityError("INVALID_INPUT");
  }
  const username = parseOrThrow(usernameSchema, input.trim().normalize("NFKC"));
  return {
    username,
    usernameNormalized: username.toLowerCase(),
  };
}

export function parseDisplayName(input: unknown): string {
  if (typeof input !== "string") {
    throw new IdentityError("INVALID_INPUT");
  }
  const normalized = input.trim().replace(/\s+/gu, " ");
  return parseOrThrow(displayNameSchema, normalized);
}

export function parsePassword(input: unknown): string {
  return parseOrThrow(passwordSchema, input);
}

export function parseDeviceId(input: unknown): string {
  return parseOrThrow(deviceIdSchema, input);
}
