import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65_535);
const secretSchema = z.string().refine((value) => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
});

const environmentSchema = z.object({
  SYNC_ACTION_PUBLIC_HOST: z.string().min(1).default("127.0.0.1"),
  SYNC_ACTION_PUBLIC_PORT: portSchema.default(29_373),
  SYNC_ACTION_DATABASE_URL: z.string().url(),
  SYNC_ACTION_ACCESS_TOKEN_SECRET: secretSchema,
  SYNC_ACTION_ACCESS_TOKEN_ISSUER: z.string().min(1).default("syncaction"),
  SYNC_ACTION_ACCESS_TOKEN_AUDIENCE: z.string().min(1).default("syncaction-extension"),
});

export interface PublicServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  accessTokenSecret: Uint8Array;
  accessTokenIssuer: string;
  accessTokenAudience: string;
  annotationHmacKey: Uint8Array;
}

export function parsePublicServerConfig(
  environment: Record<string, string | undefined>,
): PublicServerConfig {
  const annotationHmacKey = parseNamedSecret(
    environment.SYNC_ACTION_ANNOTATION_HMAC_KEY,
    "SYNC_ACTION_ANNOTATION_HMAC_KEY",
  );
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error("Invalid public service configuration", { cause: result.error });
  }
  return {
    host: result.data.SYNC_ACTION_PUBLIC_HOST,
    port: result.data.SYNC_ACTION_PUBLIC_PORT,
    databaseUrl: result.data.SYNC_ACTION_DATABASE_URL,
    accessTokenSecret: Buffer.from(result.data.SYNC_ACTION_ACCESS_TOKEN_SECRET, "base64url"),
    accessTokenIssuer: result.data.SYNC_ACTION_ACCESS_TOKEN_ISSUER,
    accessTokenAudience: result.data.SYNC_ACTION_ACCESS_TOKEN_AUDIENCE,
    annotationHmacKey,
  };
}

function parseNamedSecret(input: unknown, name: string): Uint8Array {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]+$/u.test(input)) {
    throw new Error(`Invalid public service configuration: ${name}`);
  }
  const decoded = Buffer.from(input, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== input) {
    throw new Error(`Invalid public service configuration: ${name}`);
  }
  return decoded;
}
