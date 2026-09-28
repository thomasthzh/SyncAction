import { z } from "zod";
import { parseAdminServerConfig } from "./config.js";

const strictEnvironmentBoolean = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

const credentialsSchema = z.object({
  SYNC_ACTION_ADMIN_BOOTSTRAP_USERNAME: z.string().min(1),
  SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD: z.string().min(1),
  SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_SECRET: z.string().min(1),
  SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD_CHANGE_REQUIRED: strictEnvironmentBoolean,
  SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_ENROLLMENT_REQUIRED: strictEnvironmentBoolean,
});

export interface AdminBootstrapConfig {
  databaseUrl: string;
  totpEncryptionKey: Uint8Array;
  username: string;
  password: string;
  totpSecret: string;
  passwordChangeRequired: boolean;
  totpEnrollmentRequired: boolean;
}

export function parseAdminBootstrapConfig(
  environment: Record<string, string | undefined>,
): AdminBootstrapConfig {
  try {
    const server = parseAdminServerConfig(environment);
    const credentials = credentialsSchema.parse(environment);
    return {
      databaseUrl: server.databaseUrl,
      totpEncryptionKey: server.totpEncryptionKey,
      username: credentials.SYNC_ACTION_ADMIN_BOOTSTRAP_USERNAME,
      password: credentials.SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD,
      totpSecret: credentials.SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_SECRET,
      passwordChangeRequired: credentials.SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD_CHANGE_REQUIRED,
      totpEnrollmentRequired: credentials.SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_ENROLLMENT_REQUIRED,
    };
  } catch (cause) {
    throw new Error("Invalid administrator bootstrap configuration", { cause });
  }
}
