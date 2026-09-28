import { z } from "zod";
import { RoomError } from "./errors.js";

const roomNameSchema = z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= 1 && length <= 100;
});
const roomIdSchema = z.uuid();
const roomVisibilitySchema = z.enum(["PRIVATE", "PUBLIC"]);
const roomJoinPolicySchema = z.enum(["OPEN", "APPROVAL", "INVITE_ONLY"]);
const invitationUsernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30}[A-Za-z0-9])$/u);

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RoomError("INVALID_ROOM_INPUT", { cause: result.error });
  }
  return result.data;
}

export function parseRoomName(input: unknown): string {
  if (typeof input !== "string") {
    throw new RoomError("INVALID_ROOM_INPUT");
  }
  const normalized = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return parseOrThrow(roomNameSchema, normalized);
}

export function parseRoomId(input: unknown): string {
  return parseOrThrow(roomIdSchema, input);
}

export function parseInvitationUsername(input: unknown): string {
  if (typeof input !== "string") {
    throw new RoomError("INVALID_ROOM_INPUT");
  }
  const username = input.trim().normalize("NFKC");
  return parseOrThrow(invitationUsernameSchema, username).toLowerCase();
}

export function parseRoomVisibility(input: unknown): "PRIVATE" | "PUBLIC" {
  return parseOrThrow(roomVisibilitySchema, input);
}

export function parseRoomJoinPolicy(input: unknown): "OPEN" | "APPROVAL" | "INVITE_ONLY" {
  return parseOrThrow(roomJoinPolicySchema, input);
}
