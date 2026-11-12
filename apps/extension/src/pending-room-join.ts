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
    stage: z.enum(["READY", "REQUESTED"]).optional(),
    requestId: CanonicalUuidSchema.optional(),
    accountId: CanonicalUuidSchema.optional(),
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      intent.stage === "REQUESTED" &&
      (intent.requestId === undefined ||
        intent.accountId === undefined ||
        intent.joinPolicy !== "APPROVAL")
    )
      context.addIssue({
        code: "custom",
        message: "Requested destination requires its account and request identity",
      });
  });

export type PendingRoomJoin = z.infer<typeof PendingRoomJoinSchema>;

export interface PendingRoomJoinStorage {
  read(): Promise<PendingRoomJoin | null>;
  write(intent: PendingRoomJoin | null): Promise<void>;
  subscribe?(listener: (intent: PendingRoomJoin | null) => void): () => void;
}

export function pendingJoinMatchesServer(intent: PendingRoomJoin, profile: ServerProfile): boolean {
  return (
    intent.profileId === profile.profileId &&
    intent.serverOrigin === profile.baseUrl &&
    intent.serverId === (profile.metadata?.serverId ?? null)
  );
}

/** Only destination/approval identity is stored, never credentials or commands. */
export function createPendingRoomJoinStorage(
  area: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  },
  subscribeToChanges?: (listener: (value: unknown) => void) => () => void,
): PendingRoomJoinStorage {
  let tail: Promise<void> = Promise.resolve();
  return {
    ...(subscribeToChanges === undefined
      ? {}
      : {
          subscribe: (listener: (intent: PendingRoomJoin | null) => void) =>
            subscribeToChanges((value) => {
              const parsed = PendingRoomJoinSchema.safeParse(value);
              listener(parsed.success ? parsed.data : null);
            }),
        }),
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
