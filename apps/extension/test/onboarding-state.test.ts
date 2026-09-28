import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STORAGE_KEY,
  OnboardingStateStore,
  type OnboardingStorageArea,
} from "../src/onboarding-state.js";

class MemoryArea implements OnboardingStorageArea {
  public readonly values = new Map<string, unknown>();
  public readonly writes: Record<string, unknown>[] = [];

  public async get(key: string): Promise<Record<string, unknown>> {
    return this.values.has(key) ? { [key]: structuredClone(this.values.get(key)) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    this.writes.push(structuredClone(items));
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }
}

describe("OnboardingStateStore", () => {
  it("requires onboarding when no durable dismissal exists", async () => {
    const store = new OnboardingStateStore({
      area: new MemoryArea(),
      clientVersion: "0.9.0",
      now: () => 100,
    });

    await expect(store.isRequired()).resolves.toBe(true);
  });

  it("persists one global dismissal exactly once", async () => {
    const area = new MemoryArea();
    const store = new OnboardingStateStore({
      area,
      clientVersion: "0.9.0",
      now: () => 100,
    });

    await expect(Promise.all([store.dismiss(), store.dismiss()])).resolves.toEqual([true, false]);
    expect(area.writes).toEqual([
      {
        [ONBOARDING_STORAGE_KEY]: {
          version: 1,
          dismissedAtClientMs: 100,
          clientVersion: "0.9.0",
        },
      },
    ]);
    await expect(store.isRequired()).resolves.toBe(false);

    const upgraded = new OnboardingStateStore({
      area,
      clientVersion: "0.9.1",
      now: () => 200,
    });
    await expect(upgraded.isRequired()).resolves.toBe(false);
  });

  it("fails closed to required when the stored record is malformed", async () => {
    const area = new MemoryArea();
    area.values.set(ONBOARDING_STORAGE_KEY, {
      version: 1,
      dismissedAtClientMs: -1,
      clientVersion: "not-semver",
    });
    const store = new OnboardingStateStore({
      area,
      clientVersion: "0.9.0",
    });

    await expect(store.isRequired()).resolves.toBe(true);
  });
});
