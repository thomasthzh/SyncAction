import { IdentityError, type IdentityErrorCode } from "@syncaction/identity";
import { RoomError, type RoomErrorCode } from "@syncaction/rooms";
import { errorCodes, type FastifyInstance } from "fastify";
import { AdminReadError } from "./read-service.js";

const statusByCode: Record<IdentityErrorCode, number> = {
  INVALID_INPUT: 400,
  USERNAME_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_PENDING: 409,
  ACCOUNT_SUSPENDED: 409,
  ACCOUNT_REVOKED: 409,
  SESSION_INVALID: 401,
  SESSION_REPLAYED: 401,
  RESET_GRANT_INVALID: 400,
  ACTIVATION_KEY_INVALID: 400,
  ACTIVATION_KEY_EXPIRED: 409,
  ACTIVATION_KEY_USED: 409,
  ACTIVATION_KEY_REVOKED: 409,
  ACTIVATION_GRANT_NOT_FOUND: 404,
  ACTIVATION_GRANT_NOT_ACTIVE: 409,
  CURRENT_PASSWORD_INVALID: 403,
  PASSWORD_ALREADY_CONFIGURED: 409,
  ADMIN_INVALID_CREDENTIALS: 401,
  ADMIN_SESSION_INVALID: 401,
  ADMIN_ONBOARDING_REQUIRED: 403,
  ADMIN_TOTP_REPLAYED: 401,
  ADMIN_LINK_ALREADY_SET: 409,
  ADMIN_LINK_TARGET_INVALID: 409,
  INVALID_ACCOUNT_TRANSITION: 409,
};

const roomStatusByCode: Record<RoomErrorCode, number> = {
  INVALID_ROOM_INPUT: 400,
  ROOM_NOT_FOUND: 404,
  ROOM_OWNER_REQUIRED: 403,
  USER_NOT_INVITABLE: 409,
  INVITATION_NOT_FOUND: 404,
  INVITATION_EXPIRED: 409,
  INVITATION_CONFLICT: 409,
  MEMBERSHIP_CONFLICT: 409,
  OWNER_MUST_TRANSFER: 409,
  ORDINARY_ROOM_LIMIT_REACHED: 409,
  ROOM_TAB_LIMIT_REACHED: 409,
  NOTIFICATION_NOT_FOUND: 404,
  ROOM_NOT_PUBLIC: 404,
  ROOM_JOIN_POLICY_MISMATCH: 409,
  JOIN_REQUEST_NOT_FOUND: 404,
  JOIN_REQUEST_CONFLICT: 409,
  POLICY_VERSION_MISMATCH: 409,
  INVALID_ROOM_TRANSITION: 409,
};

function trustedFastifyClientError(
  error: unknown,
): { code: keyof typeof errorCodes; statusCode: number } | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const candidate = error as Error & { code?: unknown; statusCode?: unknown };
  if (
    typeof candidate.code !== "string" ||
    !Object.prototype.hasOwnProperty.call(errorCodes, candidate.code) ||
    typeof candidate.statusCode !== "number" ||
    !Number.isInteger(candidate.statusCode) ||
    candidate.statusCode < 400 ||
    candidate.statusCode > 499
  ) {
    return undefined;
  }
  const code = candidate.code as keyof typeof errorCodes;
  const FastifyErrorConstructor = errorCodes[code];
  if (!(error instanceof FastifyErrorConstructor)) {
    return undefined;
  }
  return { code, statusCode: candidate.statusCode };
}

export class AdminRateLimitError extends Error {
  public constructor() {
    super("RATE_LIMITED");
    this.name = "AdminRateLimitError";
  }
}

export function registerAdminErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AdminReadError) {
      return reply.status(404).send({
        code: error.code,
        message: error.code,
        requestId: request.id,
      });
    }
    if (error instanceof IdentityError) {
      return reply.status(statusByCode[error.code]).send({
        code: error.code,
        message: error.code,
        requestId: request.id,
      });
    }
    if (error instanceof RoomError) {
      return reply.status(roomStatusByCode[error.code]).send({
        code: error.code,
        message: error.code,
        requestId: request.id,
      });
    }
    const fastifyClientError = trustedFastifyClientError(error);
    if (fastifyClientError !== undefined) {
      return reply.status(fastifyClientError.statusCode).send({
        code: fastifyClientError.code,
        message: fastifyClientError.code,
        requestId: request.id,
      });
    }
    if (error instanceof AdminRateLimitError) {
      return reply.status(429).send({
        code: "RATE_LIMITED",
        message: "RATE_LIMITED",
        requestId: request.id,
      });
    }
    const normalizedError = error instanceof Error ? error : new Error("Non-Error value thrown");
    request.log.error(
      {
        error: {
          name: normalizedError.name,
          message: normalizedError.message,
          stack: normalizedError.stack,
        },
      },
      "Unhandled administrator request error",
    );
    return reply.status(500).send({
      code: "INTERNAL_ERROR",
      message: "INTERNAL_ERROR",
      requestId: request.id,
    });
  });
}
