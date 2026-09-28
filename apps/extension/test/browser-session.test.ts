import { describe, expect, it } from "vitest";
import { getOrCreateBrowserSessionId } from "../src/browser-session.js";

class MemorySessionArea {
  public readonly values: Record<string, unknown> = {};
  public readonly writes: Record<string, unknown>[] = [];

  public async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: this.values[key] } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    this.writes.push(structuredClone(items));
    Object.assign(this.values, items);
  }
}

describe("browser session identity", () => {
  it("creates one UUID and reuses it across service-worker restarts", async () => {
    const area = new MemorySessionArea();
    let generated = 0;
    const createId = () => {
      generated += 1;
      return "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
    };

    const first = await getOrCreateBrowserSessionId(area, createId);
    const restarted = await getOrCreateBrowserSessionId(area, () => {
      throw new Error("must reuse storage.session identity");
    });

    expect(first).toBe("018f8f8e-4b5c-7d6e-8f90-123456789ab1");
    expect(restarted).toBe(first);
    expect(generated).toBe(1);
    expect(area.writes).toHaveLength(1);
  });

  it("fails closed on corrupt stored identity instead of silently trusting numeric tab IDs", async () => {
    const area = new MemorySessionArea();
    area.values["syncaction.browser-session.v1"] = "not-a-uuid";

    await expect(getOrCreateBrowserSessionId(area)).rejects.toThrow("CORRUPT_BROWSER_SESSION_ID");
    expect(area.writes).toEqual([]);
  });
});
