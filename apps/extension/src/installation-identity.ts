import { DeviceIdSchema } from "@syncaction/protocol";

export const INSTALLATION_ID_STORAGE_KEY = "syncaction.installation-id.v1";

export interface InstallationIdentityStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function getOrCreateInstallationId(
  area: InstallationIdentityStorageArea,
  createId: () => string = () => crypto.randomUUID(),
): Promise<string> {
  const stored = (await area.get(INSTALLATION_ID_STORAGE_KEY))[INSTALLATION_ID_STORAGE_KEY];
  if (stored !== undefined) {
    const parsed = DeviceIdSchema.safeParse(stored);
    if (!parsed.success) {
      throw new Error("CORRUPT_INSTALLATION_ID");
    }
    return parsed.data;
  }
  const deviceId = DeviceIdSchema.parse(createId());
  await area.set({ [INSTALLATION_ID_STORAGE_KEY]: deviceId });
  return deviceId;
}
