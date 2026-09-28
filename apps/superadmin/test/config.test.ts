import { describe, expect, it } from "vitest";
import { parseAdminServerConfig } from "../src/config.js";

const totpEncryptionKey = Buffer.alloc(32, 11).toString("base64url");
const requiredEnvironment = {
  SYNC_ACTION_DATABASE_URL: "postgresql://syncaction:secret@127.0.0.1:5432/syncaction",
  SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY: totpEncryptionKey,
};

describe("administrator service configuration", () => {
  it("defaults to the approved loopback address, port, and hardened cookie", () => {
    expect(parseAdminServerConfig(requiredEnvironment)).toMatchObject({
      host: "127.0.0.1",
      port: 29_374,
      publicOrigin: "http://127.0.0.1:29374",
      databaseUrl: requiredEnvironment.SYNC_ACTION_DATABASE_URL,
      cookie: {
        name: "syncaction_admin_session",
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAgeSeconds: 28_800,
        secure: false,
      },
    });
  });

  it("enables Secure cookies in production", () => {
    expect(
      parseAdminServerConfig({
        ...requiredEnvironment,
        NODE_ENV: "production",
        SYNC_ACTION_ADMIN_PUBLIC_ORIGIN: "https://admin.syncaction.example.com",
      }).cookie.secure,
    ).toBe(true);
  });

  it("requires the exact administrator HTTPS origin in production", () => {
    expect(
      parseAdminServerConfig({
        ...requiredEnvironment,
        NODE_ENV: "production",
        SYNC_ACTION_ADMIN_PUBLIC_ORIGIN: "https://admin.syncaction.example.com",
      }).publicOrigin,
    ).toBe("https://admin.syncaction.example.com");

    expect(() =>
      parseAdminServerConfig({
        ...requiredEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrowError("Invalid administrator service configuration");
  });

  it.each([
    "ftp://admin.syncaction.example.com",
    "https://user:password@admin.syncaction.example.com",
    "https://admin.syncaction.example.com/path",
    "https://admin.syncaction.example.com?query=1",
    "https://admin.syncaction.example.com#fragment",
  ])("rejects noncanonical administrator origin %s", (origin) => {
    expect(() =>
      parseAdminServerConfig({
        ...requiredEnvironment,
        SYNC_ACTION_ADMIN_PUBLIC_ORIGIN: origin,
      }),
    ).toThrowError("Invalid administrator service configuration");
  });

  it.each(["0", "65536", "29373", "29374.5", "not-a-port"])(
    "rejects unsafe administrator port %s",
    (port) => {
      expect(() =>
        parseAdminServerConfig({
          ...requiredEnvironment,
          SYNC_ACTION_ADMIN_PORT: port,
        }),
      ).toThrowError("Invalid administrator service configuration");
    },
  );

  it("requires an exact 32-byte base64url TOTP encryption key", () => {
    expect(() =>
      parseAdminServerConfig({
        ...requiredEnvironment,
        SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY: Buffer.alloc(31, 11).toString("base64url"),
      }),
    ).toThrowError("Invalid administrator service configuration");
  });
});
