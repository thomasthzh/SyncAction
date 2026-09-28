import { z } from "zod";
import { LogicalTabIdSchema, SupportedUrlSchema } from "./identifiers.js";

const metadataFields = {
  title: z.string().max(512).optional(),
  favIconUrl: z.string().url().nullable().optional(),
};

export const TabCreateSchema = z
  .object({
    type: z.literal("tab.create"),
    logicalTabId: LogicalTabIdSchema,
    url: SupportedUrlSchema,
    after: LogicalTabIdSchema.nullable(),
    ...metadataFields,
  })
  .strict();

export const TabNavigateSchema = z
  .object({
    type: z.literal("tab.navigate"),
    logicalTabId: LogicalTabIdSchema,
    url: SupportedUrlSchema,
  })
  .strict();

export const TabCloseSchema = z
  .object({
    type: z.literal("tab.close"),
    logicalTabId: LogicalTabIdSchema,
  })
  .strict();

export const TabMoveSchema = z
  .object({
    type: z.literal("tab.move"),
    logicalTabId: LogicalTabIdSchema,
    predecessor: LogicalTabIdSchema.nullable(),
    successor: LogicalTabIdSchema.nullable(),
  })
  .strict();

export const TabUpdateMetadataSchema = z
  .object({
    type: z.literal("tab.updateMetadata"),
    logicalTabId: LogicalTabIdSchema,
    ...metadataFields,
  })
  .strict();

export const DurableOperationSchema = z.discriminatedUnion("type", [
  TabCreateSchema,
  TabNavigateSchema,
  TabCloseSchema,
  TabMoveSchema,
  TabUpdateMetadataSchema,
]);

export type DurableOperation = z.infer<typeof DurableOperationSchema>;
