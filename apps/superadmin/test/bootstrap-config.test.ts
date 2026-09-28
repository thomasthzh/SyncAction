import { describe, expect, it } from "vitest";
import { parseAdminBootstrapConfig } from "../src/bootstrap-config.js";

const environment = {
  SYNC_ACTION_DATABASE_URL: "postgresql://syncaction:secret@127.0.0.1:5432/syncaction",
  SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64url"),
  SYNC_ACTION_ADMIN_BOOTSTRAP_USERNAME: "SyncAdmin",
  SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD: "administrator horse battery",
  SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_SECRET: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
};

describe("administrator bootstrap configuration", () => {
  it("reads credentials only from named environment variables", () => {
    expect(parseAdminBootstrapConfig(environment)).toMatchObject({
      databaseUrl: environment.SYNC_ACTION_DATABASE_URL,
      username: "SyncAdmin",
      password: "administrator horse battery",
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      passwordChangeRequired: false,
      totpEnrollmentRequired: false,
    });
  });

  it("parses explicit administrator onboarding flags", () => {
    expect(
      parseAdminBootstrapConfig({
        ...environment,
        SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD_CHANGE_REQUIRED: "false",
        SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_ENROLLMENT_REQUIRED: "true",
      }),
    ).toMatchObject({
      passwordChangeRequired: false,
      totpEnrollmentRequired: true,
    });
  });

  it.each([
    ["SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD_CHANGE_REQUIRED", "TRUE"],
    ["SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD_CHANGE_REQUIRED", "1"],
    ["SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_ENROLLMENT_REQUIRED", "yes"],
    ["SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_ENROLLMENT_REQUIRED", ""],
  ] as const)("rejects non-literal boolean %s=%s", (name, value) => {
    expect(() =>
      parseAdminBootstrapConfig({
        ...environment,
        [name]: value,
      }),
    ).toThrowError("Invalid administrator bootstrap configuration");
  });

  it.each([
    "SYNC_ACTION_ADMIN_BOOTSTRAP_USERNAME",
    "SYNC_ACTION_ADMIN_BOOTSTRAP_PASSWORD",
    "SYNC_ACTION_ADMIN_BOOTSTRAP_TOTP_SECRET",
  ] as const)("fails closed when %s is absent", (name) => {
    expect(() =>
      parseAdminBootstrapConfig({
        ...environment,
        [name]: undefined,
      }),
    ).toThrowError("Invalid administrator bootstrap configuration");
  });
});
