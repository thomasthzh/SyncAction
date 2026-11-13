import { CanonicalUuidSchema, MediaTargetSchema } from "@syncaction/protocol";
import { z } from "zod";
import { ServerProfileIdSchema } from "./server-profile.js";
import { MediaDeviceTakeoverSourceSchema } from "./media-controller-model.js";
import type { PageToolShortcutIntentStorageArea } from "./page-tool-shortcut-intent.js";

const STORAGE_KEY = "syncaction.watch-preparation.v1";
export const WatchPreparationSchema = z
  .object({
    id: CanonicalUuidSchema,
    profileId: ServerProfileIdSchema,
    serverOrigin: z.string().url().max(2_048),
    serverId: CanonicalUuidSchema.nullable(),
    accountId: CanonicalUuidSchema,
    roomId: CanonicalUuidSchema,
    groupId: CanonicalUuidSchema,
    target: MediaTargetSchema,
    title: z.string().min(1).max(512),
    action: z.enum(["JOIN", "ALIGN", "TAKEOVER"]),
    takeoverFrom: MediaDeviceTakeoverSourceSchema.optional(),
    stage: z.enum(["PREPARING", "SUBMITTED"]),
  })
  .strict()
  .refine((task) => (task.action === "TAKEOVER") === (task.takeoverFrom !== undefined), {
    message: "Device continuation requires its original participant device",
  });
export type WatchPreparation = z.infer<typeof WatchPreparationSchema>;
export interface WatchPreparationStorage {
  read(): Promise<WatchPreparation | null>;
  write(preparation: WatchPreparation | null): Promise<void>;
}

/** A passive, session-only destination. The App command queue owns every write. */
export function createWatchPreparationStorage(
  area: PageToolShortcutIntentStorageArea,
): WatchPreparationStorage {
  return {
    async read() {
      const parsed = WatchPreparationSchema.safeParse((await area.get(STORAGE_KEY))[STORAGE_KEY]);
      return parsed.success ? parsed.data : null;
    },
    async write(preparation) {
      if (preparation === null) await area.remove(STORAGE_KEY);
      else await area.set({ [STORAGE_KEY]: WatchPreparationSchema.parse(preparation) });
    },
  };
}
