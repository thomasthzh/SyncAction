import { describe, expect, it } from "vitest";
import { RoomIdSchema } from "@syncaction/protocol";
import {
  PageToolShortcutIntentStore,
  type PageToolShortcutIntentStorageArea,
} from "../src/page-tool-shortcut-intent.js";

const context = {
  profileId: "test",
  serverOrigin: "https://syncaction.example.com",
  serverId: null,
  accountId: "00000000-0000-4000-8000-000000000001",
  roomId: RoomIdSchema.parse("00000000-0000-4000-8000-000000000002"),
  tabId: 42,
  windowId: 1,
  url: "https://video.example/watch",
  documentRevision: null,
};

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

    await store.enqueue("danmaku", context);
    await store.enqueue("pen", context);

    await expect(store.consume(1)).resolves.toMatchObject({ intent: "pen", context });
    await expect(store.consume(1)).resolves.toBeNull();
  });

  it("serializes concurrent consumers so one shortcut cannot open twice", async () => {
    const area = new MemoryArea();
    const store = new PageToolShortcutIntentStore({ area, now: () => 1_000 });
    await store.enqueue("danmaku", context);

    await expect(Promise.all([store.consume(1), store.consume(1)])).resolves.toEqual([
      expect.objectContaining({ intent: "danmaku", context }),
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

    await expect(store.consume(1)).resolves.toBeNull();
    expect(area.values.size).toBe(0);
  });
});

it("does not let another window steal a queued tool and serializes an overlapping enqueue", async () => {
  const area = new MemoryArea();
  const store = new PageToolShortcutIntentStore({ area, now: () => 1000 });
  const queued = store.enqueue("pen", context);
  const wrong = store.consume(2);
  const right = store.consume(1);
  await queued;
  await expect(wrong).resolves.toBeNull();
  await expect(right).resolves.toMatchObject({ intent: "pen", context });
});
