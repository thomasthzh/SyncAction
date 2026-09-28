import {
  IdentityError,
  type AccountActivationGrantService,
  type AdminPrincipal,
  type AdminService,
} from "@syncaction/identity";
import type { createDatabase } from "@syncaction/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RoomService } from "@syncaction/rooms";
import { z } from "zod";
import type { AdminCookieConfig } from "./config.js";
import {
  type AdminReadService,
  type RoomLifecycle,
  type RoomQuotaClass,
  type UserStatus,
} from "./read-service.js";

type AdminDatabase = ReturnType<typeof createDatabase>;

const loginSchema = z.object({
  username: z.unknown(),
  password: z.unknown(),
  totp: z.unknown().optional(),
});
const onboardingCompletionSchema = z
  .object({
    newPassword: z.unknown().optional(),
    totp: z.unknown(),
  })
  .strict();
const userParamsSchema = z.object({ userId: z.string() });
const deviceParamsSchema = z.object({
  userId: z.string(),
  deviceId: z.string(),
});
const roomParamsSchema = z.object({ roomId: z.string() });
const activationGrantParamsSchema = z.object({ grantId: z.string() }).strict();
const activationGrantCreateSchema = z.object({ note: z.unknown() }).strict();
const reasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u);
const roomMutationSchema = z.object({ reasonCode: reasonCodeSchema }).strict();
const ownershipTransferSchema = z
  .object({
    newOwnerUserId: z.unknown(),
    reasonCode: reasonCodeSchema,
  })
  .strict();
const linkedUserSchema = z.object({ userId: z.unknown() }).strict();
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const userListQuerySchema = z.object({
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const roomListQuerySchema = z.object({
  lifecycle: z.enum(["ACTIVE", "DELETED"]).optional(),
  quotaClass: z.enum(["ORDINARY", "EXEMPT"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new IdentityError("INVALID_INPUT", { cause: result.error });
  }
  return result.data;
}

export interface AdminRouteOptions {
  db: AdminDatabase;
  administrators: AdminService;
  rooms: RoomService;
  reads: AdminReadService;
  activationGrants: AccountActivationGrantService;
  cookie: AdminCookieConfig;
  authRateLimitMax: number;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  const setSessionCookie = (
    reply: FastifyReply,
    sessionToken: string,
    maxAgeSeconds: number,
  ): void => {
    reply.setCookie(options.cookie.name, sessionToken, {
      httpOnly: options.cookie.httpOnly,
      sameSite: options.cookie.sameSite,
      path: options.cookie.path,
      maxAge: maxAgeSeconds,
      secure: options.cookie.secure,
    });
  };
  const authenticate = async (request: FastifyRequest): Promise<AdminPrincipal> => {
    return options.administrators.authenticateSession(request.cookies[options.cookie.name]);
  };
  const authenticateEnrolled = async (request: FastifyRequest): Promise<AdminPrincipal> => {
    const principal = await authenticate(request);
    if (principal.passwordChangeRequired || principal.totpEnrollmentRequired) {
      throw new IdentityError("ADMIN_ONBOARDING_REQUIRED");
    }
    return principal;
  };

  app.post(
    "/v1/admin/auth/login",
    {
      config: {
        rateLimit: {
          max: options.authRateLimitMax,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const session = await options.administrators.login(parse(loginSchema, request.body));
      setSessionCookie(reply, session.sessionToken, session.expiresInSeconds);
      return {
        administrator: session.administrator,
        expiresInSeconds: session.expiresInSeconds,
        onboarding: session.onboarding,
      };
    },
  );

  app.post("/v1/admin/auth/logout", async (request, reply) => {
    await options.administrators.logout(request.cookies[options.cookie.name]);
    reply.clearCookie(options.cookie.name, {
      httpOnly: options.cookie.httpOnly,
      sameSite: options.cookie.sameSite,
      path: options.cookie.path,
      secure: options.cookie.secure,
    });
    return reply.status(204).send();
  });

  app.get("/v1/admin/onboarding", async (request) => {
    const principal = await authenticate(request);
    return {
      administrator: {
        id: principal.administratorId,
        username: principal.username,
        linkedUserId: principal.linkedUserId,
      },
      onboarding: {
        passwordChangeRequired: principal.passwordChangeRequired,
        totpEnrollmentRequired: principal.totpEnrollmentRequired,
      },
    };
  });

  app.get("/v1/admin/onboarding/totp", async (request) => {
    const principal = await authenticate(request);
    return options.administrators.getTotpEnrollment(principal);
  });

  app.post("/v1/admin/onboarding/complete", async (request, reply) => {
    const principal = await authenticate(request);
    const completed = await options.administrators.completeOnboarding(
      principal,
      parse(onboardingCompletionSchema, request.body),
    );
    const sessionToken = request.cookies[options.cookie.name];
    if (typeof sessionToken !== "string") {
      throw new IdentityError("ADMIN_SESSION_INVALID");
    }
    setSessionCookie(reply, sessionToken, options.cookie.maxAgeSeconds);
    return completed;
  });

  app.get("/v1/admin/me", async (request) => authenticateEnrolled(request));

  app.post("/v1/admin/account-activation-grants", async (request, reply) => {
    const principal = await authenticateEnrolled(request);
    const body = parse(activationGrantCreateSchema, request.body);
    const result = await options.activationGrants.issue({
      administratorId: principal.administratorId,
      note: body.note,
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/admin/account-activation-grants", async (request) => {
    await authenticateEnrolled(request);
    return { grants: await options.activationGrants.list() };
  });

  app.post("/v1/admin/account-activation-grants/:grantId/revoke", async (request) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(activationGrantParamsSchema, request.params);
    return options.activationGrants.revoke({
      administratorId: principal.administratorId,
      grantId: params.grantId,
    });
  });

  app.post("/v1/admin/me/linked-user", async (request) => {
    const principal = await authenticateEnrolled(request);
    const body = parse(linkedUserSchema, request.body);
    return options.administrators.bindLinkedUser({
      administratorId: principal.administratorId,
      userId: body.userId,
    });
  });

  app.get("/v1/admin/users", async (request) => {
    await authenticateEnrolled(request);
    const query = parse(userListQuerySchema, request.query);
    const input: { status?: UserStatus; limit: number } = { limit: query.limit };
    if (query.status !== undefined) {
      input.status = query.status;
    }
    return options.reads.listUsers(input);
  });

  app.get("/v1/admin/users/:userId/devices", async (request) => {
    await authenticateEnrolled(request);
    const params = parse(userParamsSchema, request.params);
    return options.reads.listUserDevices(params.userId);
  });

  app.post("/v1/admin/users/:userId/approve", async (request) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(userParamsSchema, request.params);
    return options.administrators.approveUser({
      administratorId: principal.administratorId,
      userId: params.userId,
    });
  });

  app.post("/v1/admin/users/:userId/suspend", async (request) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(userParamsSchema, request.params);
    return options.administrators.suspendUser({
      administratorId: principal.administratorId,
      userId: params.userId,
    });
  });

  app.post("/v1/admin/users/:userId/revoke", async (request) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(userParamsSchema, request.params);
    return options.administrators.revokeUser({
      administratorId: principal.administratorId,
      userId: params.userId,
    });
  });

  app.post("/v1/admin/users/:userId/sessions/revoke", async (request) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(userParamsSchema, request.params);
    const affectedCount = await options.administrators.revokeAllUserSessions({
      administratorId: principal.administratorId,
      userId: params.userId,
    });
    return { affectedCount };
  });

  app.post("/v1/admin/users/:userId/devices/:deviceId/revoke", async (request) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(deviceParamsSchema, request.params);
    const affectedCount = await options.administrators.revokeDeviceSessions({
      administratorId: principal.administratorId,
      userId: params.userId,
      deviceId: params.deviceId,
    });
    return { affectedCount };
  });

  app.post("/v1/admin/users/:userId/password-reset", async (request, reply) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(userParamsSchema, request.params);
    const grant = await options.administrators.issuePasswordReset({
      administratorId: principal.administratorId,
      userId: params.userId,
    });
    return reply.status(201).send(grant);
  });

  app.get("/v1/admin/rooms", async (request) => {
    await authenticateEnrolled(request);
    const query = parse(roomListQuerySchema, request.query);
    const input: {
      lifecycle?: RoomLifecycle;
      quotaClass?: RoomQuotaClass;
      limit: number;
    } = { limit: query.limit };
    if (query.lifecycle !== undefined) {
      input.lifecycle = query.lifecycle;
    }
    if (query.quotaClass !== undefined) {
      input.quotaClass = query.quotaClass;
    }
    return options.reads.listRooms(input);
  });

  app.get("/v1/admin/rooms/:roomId/members", async (request) => {
    await authenticateEnrolled(request);
    const params = parse(roomParamsSchema, request.params);
    return options.reads.listRoomMembers(params.roomId);
  });

  app.post("/v1/admin/rooms/:roomId/soft-delete", async (request, reply) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(roomParamsSchema, request.params);
    const body = parse(roomMutationSchema, request.body);
    await options.rooms.administratorSoftDeleteRoom({
      administratorId: principal.administratorId,
      roomId: params.roomId,
      reasonCode: body.reasonCode,
    });
    return reply.status(204).send();
  });

  app.post("/v1/admin/rooms/:roomId/restore", async (request, reply) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(roomParamsSchema, request.params);
    const body = parse(roomMutationSchema, request.body);
    await options.rooms.administratorRestoreRoom({
      administratorId: principal.administratorId,
      roomId: params.roomId,
      reasonCode: body.reasonCode,
    });
    return reply.status(204).send();
  });

  app.post("/v1/admin/rooms/:roomId/ownership-transfer", async (request) => {
    const principal = await authenticateEnrolled(request);
    const params = parse(roomParamsSchema, request.params);
    const body = parse(ownershipTransferSchema, request.body);
    return options.rooms.administratorTransferOwnership({
      administratorId: principal.administratorId,
      roomId: params.roomId,
      newOwnerUserId: body.newOwnerUserId,
      reasonCode: body.reasonCode,
    });
  });

  app.get("/v1/admin/audit-events", async (request) => {
    await authenticateEnrolled(request);
    const { limit } = parse(auditQuerySchema, request.query);
    const events = await options.db
      .selectFrom("auditEvents")
      .selectAll()
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return { events };
  });

  app.get("/v1/admin/diagnostics", async (request) => {
    await authenticateEnrolled(request);
    return options.reads.diagnostics();
  });
}
