import { describe, expect, it } from "vitest";
import {
  INSTALLATION_ID_STORAGE_KEY,
  getOrCreateInstallationId,
  type InstallationIdentityStorageArea,
} from "../src/installation-identity.js";

class MemoryArea implements InstallationIdentityStorageArea {
  public readonly values: Record<string, unknown> = {};

  public async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: this.values[key] } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }
}

describe("installation identity", () => {
  it("creates one stable device UUID in local storage", async () => {
    const area = new MemoryArea();
    let createCount = 0;
    const expectedId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
    const createId = () => {
      createCount += 1;
      return expectedId;
    };

    await expect(getOrCreateInstallationId(area, createId)).resolves.toBe(expectedId);
    await expect(getOrCreateInstallationId(area, createId)).resolves.toBe(expectedId);
    expect(createCount).toBe(1);
    expect(area.values[INSTALLATION_ID_STORAGE_KEY]).toBe(expectedId);
  });

  it("fails closed instead of silently replacing a corrupt device identity", async () => {
    const area = new MemoryArea();
    area.values[INSTALLATION_ID_STORAGE_KEY] = "corrupt";

    await expect(getOrCreateInstallationId(area)).rejects.toThrow("CORRUPT_INSTALLATION_ID");
  });
});
