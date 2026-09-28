import { z } from "zod";

export const PageCapabilityNameSchema = z.enum([
  "PAGE_HOST",
  "POINTER",
  "MEDIA",
  "DANMAKU",
  "DRAWING",
]);

export const PageCapabilityMessageSchema = z.discriminatedUnion("state", [
  z
    .object({
      type: z.literal("syncaction.page.capability"),
      capability: PageCapabilityNameSchema,
      state: z.literal("AVAILABLE"),
      errorCode: z.null(),
    })
    .strict(),
  z
    .object({
      type: z.literal("syncaction.page.capability"),
      capability: PageCapabilityNameSchema,
      state: z.literal("DEGRADED"),
      errorCode: z.string().min(1).max(128),
    })
    .strict(),
]);

export const PageCapabilityReportSchema = z
  .object({
    tabId: z.number().int().nonnegative().safe(),
    frameId: z.number().int().nonnegative().safe(),
    message: PageCapabilityMessageSchema,
  })
  .strict();

export type PageCapabilityMessage = z.infer<typeof PageCapabilityMessageSchema>;
export type PageCapabilityReport = z.infer<typeof PageCapabilityReportSchema>;
