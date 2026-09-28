import { CanonicalUuidSchema } from "@syncaction/protocol";
import { z } from "zod";

const MediaMemberJumpMessageSchema = z
  .object({
    type: z.literal("syncaction.media.member.jump"),
    userId: CanonicalUuidSchema,
  })
  .strict();

const MediaGroupAlignOnceMessageSchema = z
  .object({
    type: z.literal("syncaction.media.group.align-once"),
    playbackGroupId: CanonicalUuidSchema,
  })
  .strict();

const MediaGroupJoinMessageSchema = z
  .object({
    type: z.literal("syncaction.media.group.join"),
    playbackGroupId: CanonicalUuidSchema,
  })
  .strict();

const MediaProposalDecideMessageSchema = z
  .object({
    type: z.literal("syncaction.media.proposal.decide"),
    playbackGroupId: CanonicalUuidSchema,
    proposalId: CanonicalUuidSchema,
    decision: z.enum(["APPROVE", "REJECT"]),
  })
  .strict();

export const MediaActionMessageSchema = z.discriminatedUnion("type", [
  MediaMemberJumpMessageSchema,
  MediaGroupAlignOnceMessageSchema,
  MediaGroupJoinMessageSchema,
  MediaProposalDecideMessageSchema,
]);

export type MediaActionMessage = z.infer<typeof MediaActionMessageSchema>;

const mediaActionTypes = new Set<MediaActionMessage["type"]>([
  "syncaction.media.member.jump",
  "syncaction.media.group.align-once",
  "syncaction.media.group.join",
  "syncaction.media.proposal.decide",
]);

export function readMediaActionMessage(input: unknown): MediaActionMessage | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("type" in input) ||
    typeof input.type !== "string" ||
    !mediaActionTypes.has(input.type as MediaActionMessage["type"])
  ) {
    return null;
  }
  const result = MediaActionMessageSchema.safeParse(input);
  if (!result.success) {
    throw new Error("MEDIA_ACTION_MESSAGE_INVALID", { cause: result.error });
  }
  return result.data;
}
