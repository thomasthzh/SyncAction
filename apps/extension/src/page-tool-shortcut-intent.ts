import { z } from "zod";

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

const StoredIntentSchema = z
  .object({
    version: z.literal(1),
    intent: PageToolShortcutIntentSchema,
    queuedAtMs: z.number().int().nonnegative().safe(),
  })
  .strict();

export interface PageToolShortcutIntentStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class PageToolShortcutIntentStore {
  readonly #area: PageToolShortcutIntentStorageArea;
  readonly #now: () => number;
  #consumeTail: Promise<void> = Promise.resolve();

  public constructor(options: { area: PageToolShortcutIntentStorageArea; now?: () => number }) {
    this.#area = options.area;
    this.#now = options.now ?? Date.now;
  }

  public async enqueue(intentInput: unknown): Promise<void> {
    const intent = PageToolShortcutIntentSchema.parse(intentInput);
    await this.#area.set({
      [STORAGE_KEY]: {
        version: 1,
        intent,
        queuedAtMs: this.#now(),
      },
    });
  }

  public consume(): Promise<PageToolShortcutIntent | null> {
    const result = this.#consumeTail.then(() => this.#consumeStored());
    this.#consumeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #consumeStored(): Promise<PageToolShortcutIntent | null> {
    const stored = (await this.#area.get(STORAGE_KEY))[STORAGE_KEY];
    await this.#area.remove(STORAGE_KEY);
    const parsed = StoredIntentSchema.safeParse(stored);
    if (
      !parsed.success ||
      parsed.data.queuedAtMs > this.#now() ||
      this.#now() - parsed.data.queuedAtMs > MAX_INTENT_AGE_MS
    ) {
      return null;
    }
    return parsed.data.intent;
  }
}
