import { ServerProfileIdSchema } from "./server-profile.js";

export function serverScopedStorageKey(profileIdInput: unknown, keyInput: unknown): string {
  const profileId = ServerProfileIdSchema.parse(profileIdInput);
  if (
    typeof keyInput !== "string" ||
    keyInput.length < 1 ||
    keyInput.length > 512 ||
    !/^[A-Za-z0-9._:-]+$/u.test(keyInput)
  ) {
    throw new Error("INVALID_SCOPED_STORAGE_KEY");
  }
  return `syncaction.server.${profileId}.${keyInput}`;
}
