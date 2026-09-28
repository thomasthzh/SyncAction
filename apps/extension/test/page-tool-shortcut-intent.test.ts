import { describe, expect, it } from "vitest";
import {
  PageToolShortcutIntentStore,
  type PageToolShortcutIntentStorageArea,
} from "../src/page-tool-shortcut-intent.js";

class MemoryArea implements PageToolShortcutIntentStorageArea {
  readonly values = new Map<string, unknown>();

  public async get(key: string): Promise<Record<string, unknown>> {
    return this.values.has(key) ? { [key]: structuredClone(this.values.get(key)) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  public async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe("PageToolShortcutIntentStore", () => {
  it("queues only the newest shortcut intent and consumes it once", async () => {
    const area = new MemoryArea();
    const store = new PageToolShortcutIntentStore({ area, now: () => 1_000 });

    await store.enqueue("danmaku");
    await store.enqueue("pen");

    await expect(store.consume()).resolves.toBe("pen");
    await expect(store.consume()).resolves.toBeNull();
  });

  it("serializes concurrent consumers so one shortcut cannot open twice", async () => {
    const area = new MemoryArea();
    const store = new PageToolShortcutIntentStore({ area, now: () => 1_000 });
    await store.enqueue("danmaku");

    await expect(Promise.all([store.consume(), store.consume()])).resolves.toEqual([
      "danmaku",
      null,
    ]);
  });

  it("discards malformed and stale session intents", async () => {
    const area = new MemoryArea();
    const store = new PageToolShortcutIntentStore({ area, now: () => 100_000 });
    area.values.set("syncaction.pageToolShortcutIntent.v1", {
      version: 1,
      intent: "pen",
      queuedAtMs: 1,
    });

    await expect(store.consume()).resolves.toBeNull();
    expect(area.values.size).toBe(0);
  });
});
