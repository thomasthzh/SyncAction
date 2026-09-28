import { z } from "zod";

const adminPortSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(65_535)
  .refine((port) => port !== 29_373);
const encryptionKeySchema = z.string().refine((value) => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
});
const canonicalOriginSchema = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
});
const environmentSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    SYNC_ACTION_ADMIN_HOST: z.string().min(1).default("127.0.0.1"),
    SYNC_ACTION_ADMIN_PORT: adminPortSchema.default(29_374),
    SYNC_ACTION_ADMIN_PUBLIC_ORIGIN: canonicalOriginSchema.optional(),
    SYNC_ACTION_DATABASE_URL: z.string().url(),
    SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY: encryptionKeySchema,
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && value.SYNC_ACTION_ADMIN_PUBLIC_ORIGIN === undefined) {
      context.addIssue({
        code: "custom",
        message: "Administrator public origin is required in production",
        path: ["SYNC_ACTION_ADMIN_PUBLIC_ORIGIN"],
      });
    }
  });

export interface AdminCookieConfig {
  name: "syncaction_admin_session";
  httpOnly: true;
  sameSite: "strict";
  path: "/";
  maxAgeSeconds: 28_800;
  secure: boolean;
}

export interface AdminServerConfig {
  host: string;
  port: number;
  publicOrigin: string;
  databaseUrl: string;
  totpEncryptionKey: Uint8Array;
  cookie: AdminCookieConfig;
}

export function parseAdminServerConfig(
  environment: Record<string, string | undefined>,
): AdminServerConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error("Invalid administrator service configuration", { cause: result.error });
  }
  return {
    host: result.data.SYNC_ACTION_ADMIN_HOST,
    port: result.data.SYNC_ACTION_ADMIN_PORT,
    publicOrigin: result.data.SYNC_ACTION_ADMIN_PUBLIC_ORIGIN ?? "http://127.0.0.1:29374",
    databaseUrl: result.data.SYNC_ACTION_DATABASE_URL,
    totpEncryptionKey: Buffer.from(result.data.SYNC_ACTION_ADMIN_TOTP_ENCRYPTION_KEY, "base64url"),
    cookie: {
      name: "syncaction_admin_session",
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAgeSeconds: 28_800,
      secure: result.data.NODE_ENV === "production",
    },
  };
}
