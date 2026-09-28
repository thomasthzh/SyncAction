import { z } from "zod";
import { parseSharedUrl } from "./shared-url.js";

export const CanonicalUuidSchema = z
  .string()
  .uuid()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

export const RoomIdSchema = CanonicalUuidSchema.brand<"RoomId">();
export const DeviceIdSchema = CanonicalUuidSchema.brand<"DeviceId">();
export const LogicalTabIdSchema = CanonicalUuidSchema.brand<"LogicalTabId">();
export const ClientOpIdSchema = CanonicalUuidSchema.brand<"ClientOpId">();

export type RoomId = z.infer<typeof RoomIdSchema>;
export type DeviceId = z.infer<typeof DeviceIdSchema>;
export type LogicalTabId = z.infer<typeof LogicalTabIdSchema>;
export type ClientOpId = z.infer<typeof ClientOpIdSchema>;

export const SupportedUrlSchema = z.string().superRefine((value, context) => {
  try {
    parseSharedUrl(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Only canonicalizable HTTP and HTTPS URLs without credentials are supported",
    });
  }
});

export type SupportedUrl = z.infer<typeof SupportedUrlSchema>;
