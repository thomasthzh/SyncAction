import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { IdentityError } from "./errors.js";

const uuidSchema = z.uuid();
const accessTokenLifetimeSeconds = 15 * 60;

export interface AccessTokenPrincipal {
  userId: string;
  deviceId: string;
  sessionId: string;
}

export interface AccessTokenCodec {
  sign(principal: AccessTokenPrincipal): Promise<string>;
  verify(token: string): Promise<AccessTokenPrincipal>;
}

export interface AccessTokenCodecOptions {
  issuer: string;
  audience: string;
  secret: Uint8Array;
  now?: () => Date;
}

function parsePrincipal(
  principal: AccessTokenPrincipal,
  errorCode: "INVALID_INPUT" | "SESSION_INVALID",
): AccessTokenPrincipal {
  const result = z
    .object({
      userId: uuidSchema,
      deviceId: uuidSchema,
      sessionId: uuidSchema,
    })
    .safeParse(principal);
  if (!result.success) {
    throw new IdentityError(errorCode, { cause: result.error });
  }
  return result.data;
}

export function createAccessTokenCodec(options: AccessTokenCodecOptions): AccessTokenCodec {
  if (
    options.issuer.length === 0 ||
    options.audience.length === 0 ||
    options.secret.byteLength !== 32
  ) {
    throw new IdentityError("INVALID_INPUT");
  }
  const secret = options.secret.slice();
  const now = options.now ?? (() => new Date());

  return {
    async sign(principal) {
      const parsed = parsePrincipal(principal, "INVALID_INPUT");
      const issuedAt = Math.floor(now().getTime() / 1_000);
      return new SignJWT({
        deviceId: parsed.deviceId,
        sessionId: parsed.sessionId,
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setSubject(parsed.userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + accessTokenLifetimeSeconds)
        .sign(secret);
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, {
          algorithms: ["HS256"],
          audience: options.audience,
          issuer: options.issuer,
          currentDate: now(),
          requiredClaims: ["sub", "deviceId", "sessionId", "iat", "exp"],
        });
        return parsePrincipal(
          {
            userId: payload.sub ?? "",
            deviceId: typeof payload.deviceId === "string" ? payload.deviceId : "",
            sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
          },
          "SESSION_INVALID",
        );
      } catch (cause) {
        if (cause instanceof IdentityError && cause.code === "SESSION_INVALID") {
          throw cause;
        }
        throw new IdentityError("SESSION_INVALID", { cause });
      }
    },
  };
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
