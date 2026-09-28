import {
  IdentityError,
  type AccountActivationService,
  type AccountService,
  type AuthenticatedPrincipal,
} from "@syncaction/identity";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const registerSchema = z.object({
  username: z.unknown(),
  displayName: z.unknown(),
  password: z.unknown(),
});
const loginSchema = z.object({
  username: z.unknown(),
  password: z.unknown(),
  deviceId: z.unknown(),
});
const refreshSchema = z.object({
  refreshToken: z.unknown(),
});
const resetSchema = z.object({
  resetToken: z.unknown(),
  newPassword: z.unknown(),
});
const activationSchema = z
  .object({
    activationKey: z.unknown(),
    username: z.unknown(),
    displayName: z.unknown(),
    password: z.unknown(),
    deviceId: z.unknown(),
  })
  .strict();
const keyLoginSchema = z
  .object({
    activationKey: z.unknown(),
    deviceId: z.unknown(),
  })
  .strict();
const profileSchema = z
  .object({
    username: z.unknown(),
    displayName: z.unknown(),
  })
  .strict();
const passwordSchema = z
  .object({
    currentPassword: z.unknown(),
    newPassword: z.unknown(),
  })
  .strict();
const initializePasswordSchema = z
  .object({
    newPassword: z.unknown(),
  })
  .strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new IdentityError("INVALID_INPUT", { cause: result.error });
  }
  return result.data;
}

function readBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new IdentityError("SESSION_INVALID");
  }
  const token = authorization.slice("Bearer ".length);
  if (token.length === 0) {
    throw new IdentityError("SESSION_INVALID");
  }
  return token;
}

export async function authenticatePublicRequest(
  request: FastifyRequest,
  accounts: AccountService,
): Promise<AuthenticatedPrincipal> {
  return accounts.authenticateAccessToken(readBearerToken(request));
}

export interface PublicAuthRouteOptions {
  accounts: AccountService;
  activation: AccountActivationService;
  authRateLimitMax: number;
}

export function registerPublicAuthRoutes(
  app: FastifyInstance,
  options: PublicAuthRouteOptions,
): void {
  const authRateLimit = {
    config: {
      rateLimit: {
        max: options.authRateLimitMax,
        timeWindow: "1 minute",
      },
    },
  };

  app.post("/v1/auth/register", authRateLimit, async (request, reply) => {
    const body = parseBody(registerSchema, request.body);
    const account = await options.accounts.register(body);
    return reply.status(202).send({ account });
  });

  app.post("/v1/auth/login", authRateLimit, async (request) => {
    const body = parseBody(loginSchema, request.body);
    return options.accounts.login(body);
  });

  app.post("/v1/auth/activation/complete", authRateLimit, async (request) => {
    return options.activation.activate(parseBody(activationSchema, request.body));
  });

  app.post("/v1/auth/key-login", authRateLimit, async (request) => {
    return options.activation.loginWithKey(parseBody(keyLoginSchema, request.body));
  });

  app.post("/v1/auth/refresh", authRateLimit, async (request) => {
    const body = parseBody(refreshSchema, request.body);
    return options.accounts.refresh(body);
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const body = parseBody(refreshSchema, request.body);
    await options.accounts.logout(body);
    return reply.status(204).send();
  });

  app.post("/v1/auth/password-reset/complete", authRateLimit, async (request, reply) => {
    const body = parseBody(resetSchema, request.body);
    await options.accounts.completePasswordReset(body);
    return reply.status(204).send();
  });

  app.get("/v1/me", async (request) => {
    return authenticatePublicRequest(request, options.accounts);
  });

  app.patch("/v1/me/profile", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const body = parseBody(profileSchema, request.body);
    return options.accounts.updateProfile({ userId: principal.userId, ...body });
  });

  app.post("/v1/me/password", authRateLimit, async (request, reply) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const body = parseBody(passwordSchema, request.body);
    await options.accounts.changePassword({
      userId: principal.userId,
      sessionId: principal.sessionId,
      ...body,
    });
    return reply.status(204).send();
  });

  app.post("/v1/me/password/initialize", authRateLimit, async (request, reply) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const body = parseBody(initializePasswordSchema, request.body);
    await options.accounts.initializePassword({
      userId: principal.userId,
      sessionId: principal.sessionId,
      ...body,
    });
    return reply.status(204).send();
  });
}
