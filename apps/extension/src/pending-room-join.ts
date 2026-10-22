import { CanonicalUuidSchema } from "@syncaction/protocol";
import { z } from "zod";
import { ServerProfileIdSchema, type ServerProfile } from "./server-profile.js";
import { parsePublicServerOrigin } from "./server-origin.js";

export const PENDING_ROOM_JOIN_KEY = "syncaction.pending-room-join.v1";

const PendingRoomJoinSchema = z
  .object({
    version: z.literal(1),
    profileId: ServerProfileIdSchema,
    serverOrigin: z.string().transform((value, context) => {
      try {
        return parsePublicServerOrigin(value);
      } catch {
        context.addIssue({ code: "custom", message: "Invalid server origin" });
        return z.NEVER;
      }
    }),
    serverId: CanonicalUuidSchema.nullable(),
    roomId: CanonicalUuidSchema,
    roomName: z.string().min(1).max(100),
    joinPolicy: z.enum(["OPEN", "APPROVAL"]),
  })
  .strict();

export type PendingRoomJoin = z.infer<typeof PendingRoomJoinSchema>;

export interface PendingRoomJoinStorage {
  read(): Promise<PendingRoomJoin | null>;
  write(intent: PendingRoomJoin | null): Promise<void>;
}

export function pendingJoinMatchesServer(intent: PendingRoomJoin, profile: ServerProfile): boolean {
  return (
    intent.profileId === profile.profileId &&
    intent.serverOrigin === profile.baseUrl &&
    intent.serverId === (profile.metadata?.serverId ?? null)
  );
}

/** Only a room destination is stored. Credentials and executable commands are excluded. */
export function createPendingRoomJoinStorage(area: {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}): PendingRoomJoinStorage {
  let tail: Promise<void> = Promise.resolve();
  return {
    async read() {
      await tail;
      const value = (await area.get(PENDING_ROOM_JOIN_KEY))[PENDING_ROOM_JOIN_KEY];
      const parsed = PendingRoomJoinSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    write(intent) {
      const value = intent === null ? null : PendingRoomJoinSchema.parse(intent);
      const operation = tail.then(() =>
        value === null
          ? area.remove(PENDING_ROOM_JOIN_KEY)
          : area.set({ [PENDING_ROOM_JOIN_KEY]: value }),
      );
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
}
