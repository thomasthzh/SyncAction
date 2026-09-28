import { z } from "zod";

export const BROWSER_SESSION_STORAGE_KEY = "syncaction.browser-session.v1";

export interface BrowserSessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function getOrCreateBrowserSessionId(
  area: BrowserSessionStorageArea,
  createId: () => string = () => crypto.randomUUID(),
): Promise<string> {
  const stored = (await area.get(BROWSER_SESSION_STORAGE_KEY))[BROWSER_SESSION_STORAGE_KEY];
  if (stored !== undefined) {
    const parsed = z.string().uuid().safeParse(stored);
    if (!parsed.success) {
      throw new Error("CORRUPT_BROWSER_SESSION_ID");
    }
    return parsed.data;
  }
  const browserSessionId = z.string().uuid().parse(createId());
  await area.set({
    [BROWSER_SESSION_STORAGE_KEY]: browserSessionId,
  });
  return browserSessionId;
}
