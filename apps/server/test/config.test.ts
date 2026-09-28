import { describe, expect, it } from "vitest";
import { parsePublicServerConfig } from "../src/config.js";

const accessTokenSecret = Buffer.alloc(32, 7).toString("base64url");
const annotationHmacKey = Buffer.alloc(32, 11).toString("base64url");
const requiredEnvironment = {
  SYNC_ACTION_DATABASE_URL: "postgresql://syncaction:secret@127.0.0.1:5432/syncaction",
  SYNC_ACTION_ACCESS_TOKEN_SECRET: accessTokenSecret,
  SYNC_ACTION_ANNOTATION_HMAC_KEY: annotationHmacKey,
};

describe("public service configuration", () => {
  it("defaults to the approved loopback address and public port", () => {
    expect(parsePublicServerConfig(requiredEnvironment)).toMatchObject({
      host: "127.0.0.1",
      port: 29_373,
      databaseUrl: requiredEnvironment.SYNC_ACTION_DATABASE_URL,
      accessTokenIssuer: "syncaction",
      accessTokenAudience: "syncaction-extension",
    });
    expect(parsePublicServerConfig(requiredEnvironment).annotationHmacKey).toEqual(
      Buffer.alloc(32, 11),
    );
  });

  it.each(["0", "65536", "29373.5", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() =>
      parsePublicServerConfig({
        ...requiredEnvironment,
        SYNC_ACTION_PUBLIC_PORT: port,
      }),
    ).toThrowError("Invalid public service configuration");
  });

  it.each([
    "",
    Buffer.alloc(31, 7).toString("base64url"),
    Buffer.alloc(33, 7).toString("base64url"),
    "not+base64url",
  ])("requires an exact 32-byte base64url access-token secret", (secret) => {
    expect(() =>
      parsePublicServerConfig({
        ...requiredEnvironment,
        SYNC_ACTION_ACCESS_TOKEN_SECRET: secret,
      }),
    ).toThrowError("Invalid public service configuration");
  });

  it.each([
    undefined,
    "",
    Buffer.alloc(31, 11).toString("base64url"),
    Buffer.alloc(33, 11).toString("base64url"),
    "not+base64url",
  ])("requires an exact 32-byte base64url annotation HMAC key", (key) => {
    let thrown: Error | undefined;
    try {
      parsePublicServerConfig({
        ...requiredEnvironment,
        SYNC_ACTION_ANNOTATION_HMAC_KEY: key,
      });
    } catch (cause) {
      thrown = cause as Error;
    }
    expect(thrown?.message).toContain("SYNC_ACTION_ANNOTATION_HMAC_KEY");
    if (typeof key === "string" && key.length > 0) {
      expect(thrown?.message).not.toContain(key);
    }
  });
});
