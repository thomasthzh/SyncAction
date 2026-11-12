import { z } from "zod";
import { CanonicalUuidSchema, DocumentRevisionSchema, RoomIdSchema } from "@syncaction/protocol";
import { ServerProfileIdSchema } from "./server-profile.js";
import type { UiStore } from "./ui-vnext/store.js";

const STORAGE_KEY = "syncaction.pageToolShortcutIntent.v1";
const MAX_INTENT_AGE_MS = 30_000;

export const PageToolShortcutIntentSchema = z.enum(["danmaku", "pen"]);
export type PageToolShortcutIntent = z.infer<typeof PageToolShortcutIntentSchema>;

export const PageToolShortcutIntentMessageSchema = z
  .object({
    type: z.literal("syncaction.ui.page-tool-shortcut-intent"),
    intent: PageToolShortcutIntentSchema,
  })
  .strict();

export const PageToolShortcutContextSchema = z
  .object({
    profileId: ServerProfileIdSchema,
    serverOrigin: z.string().url(),
    serverId: CanonicalUuidSchema.nullable(),
    accountId: CanonicalUuidSchema,
    roomId: RoomIdSchema,
    tabId: z.number().int().nonnegative().safe(),
    windowId: z.number().int().nonnegative().safe(),
    url: z.string().url(),
    documentRevision: DocumentRevisionSchema.nullable(),
  })
  .strict();
export type PageToolShortcutContext = z.infer<typeof PageToolShortcutContextSchema>;

export const PageToolShortcutRequestSchema = z
  .object({
    id: CanonicalUuidSchema,
    intent: PageToolShortcutIntentSchema,
    queuedAtMs: z.number().int().nonnegative().safe(),
    context: PageToolShortcutContextSchema,
  })
  .strict();
export type PageToolShortcutRequest = z.infer<typeof PageToolShortcutRequestSchema>;

export function matchesPageToolShortcut(
  request: PageToolShortcutRequest,
  store: UiStore,
  now = Date.now(),
): boolean {
  const context = request.context;
  const shell = store.shell.value;
  const profile = shell.profiles.find(({ profileId }) => profileId === shell.selectedProfileId);
  const page = store.pageAccess.value;
  return (
    now >= request.queuedAtMs &&
    now - request.queuedAtMs <= MAX_INTENT_AGE_MS &&
    context.profileId === shell.selectedProfileId &&
    context.serverOrigin === profile?.baseUrl &&
    context.serverId === (profile?.metadata?.serverId ?? null) &&
    context.accountId === shell.account?.id &&
    context.roomId === store.room.value.selectedRoomId &&
    context.tabId === page.tabId &&
    context.url === page.url &&
    (context.documentRevision === null
      ? page.documentRevision === null
      : page.documentRevision !== null &&
        context.documentRevision.roomEpoch === page.documentRevision.roomEpoch &&
        context.documentRevision.tabUpdatedAtSeq === page.documentRevision.tabUpdatedAtSeq)
  );
}

export interface PageToolShortcutIntentStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class PageToolShortcutIntentStore {
  readonly #area: PageToolShortcutIntentStorageArea;
  readonly #now: () => number;
  #tail: Promise<void> = Promise.resolve();

  public constructor(options: { area: PageToolShortcutIntentStorageArea; now?: () => number }) {
    this.#area = options.area;
    this.#now = options.now ?? Date.now;
  }

  public enqueue(
    intentInput: unknown,
    context: PageToolShortcutContext,
    queuedAtMs = this.#now(),
  ): Promise<void> {
    const request = PageToolShortcutRequestSchema.parse({
      id: crypto.randomUUID(),
      intent: intentInput,
      queuedAtMs,
      context,
    });
    return this.#serialize(() => this.#area.set({ [STORAGE_KEY]: request }));
  }

  public consume(windowId: number): Promise<PageToolShortcutRequest | null> {
    return this.#serialize(() => this.#consumeStored(windowId));
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #consumeStored(windowId: number): Promise<PageToolShortcutRequest | null> {
    const stored = (await this.#area.get(STORAGE_KEY))[STORAGE_KEY];
    const parsed = PageToolShortcutRequestSchema.safeParse(stored);
    if (
      !parsed.success ||
      parsed.data.queuedAtMs > this.#now() ||
      this.#now() - parsed.data.queuedAtMs > MAX_INTENT_AGE_MS
    ) {
      await this.#area.remove(STORAGE_KEY);
      return null;
    }
    if (parsed.data.context.windowId !== windowId) return null;
    await this.#area.remove(STORAGE_KEY);
    return parsed.data;
  }
}
