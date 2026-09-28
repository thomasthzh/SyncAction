import type { AccountService } from "@syncaction/identity";
import {
  CanonicalUuidSchema,
  NotificationAfterCursorSchema,
  NotificationCursorSchema,
  RoomIdSchema,
  RoomJoinDecisionInputSchema,
} from "@syncaction/protocol";
import { RoomError, type NotificationService, type RoomDiscoveryService } from "@syncaction/rooms";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticatePublicRequest } from "./auth-routes.js";

const RoomParamsSchema = z.object({ roomId: RoomIdSchema }).strict();
const RequestParamsSchema = z.object({ requestId: CanonicalUuidSchema }).strict();
const NotificationParamsSchema = z.object({ notificationId: CanonicalUuidSchema }).strict();
const EmptyBodySchema = z.object({}).strict();
const PublicRoomQuerySchema = z
  .object({
    query: z.string().optional().default(""),
    cursor: z.string().min(1).max(1_024).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  })
  .strict();
const DirectoryQuerySchema = PublicRoomQuerySchema.extend({
  roomId: RoomIdSchema,
}).strict();
const NotificationQuerySchema = z
  .object({
    after: z.coerce.number().pipe(NotificationAfterCursorSchema).optional().default(0),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();
const BatchInvitationBodySchema = z
  .object({
    userIds: z.array(CanonicalUuidSchema).min(1).max(20),
  })
  .strict();
const ReadAllBodySchema = z
  .object({
    throughCursor: NotificationCursorSchema,
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RoomError("INVALID_ROOM_INPUT", { cause: result.error });
  }
  return result.data;
}

function authenticatedRateKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.length > 0 ? authorization : request.ip;
}

export interface ProductRouteOptions {
  accounts: AccountService;
  discovery: RoomDiscoveryService;
  notifications: NotificationService;
}

export function registerProductRoutes(app: FastifyInstance, options: ProductRouteOptions): void {
  app.get(
    "/v1/public-rooms",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
    },
    async (request) => {
      const query = parse(PublicRoomQuerySchema, request.query);
      return options.discovery.listPublicRooms({
        query: query.query,
        cursor: query.cursor ?? null,
        limit: query.limit,
      });
    },
  );

  app.get(
    "/v1/directory/users",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: authenticatedRateKey,
        },
      },
    },
    async (request) => {
      const principal = await authenticatePublicRequest(request, options.accounts);
      const query = parse(DirectoryQuerySchema, request.query);
      return options.discovery.searchUsers({
        actorUserId: principal.userId,
        roomId: query.roomId,
        query: query.query,
        cursor: query.cursor ?? null,
        limit: query.limit,
      });
    },
  );

  app.post(
    "/v1/rooms/:roomId/join",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          keyGenerator: authenticatedRateKey,
        },
      },
    },
    async (request) => {
      const principal = await authenticatePublicRequest(request, options.accounts);
      const params = parse(RoomParamsSchema, request.params);
      parse(EmptyBodySchema.optional(), request.body);
      return options.discovery.joinOpen({
        actorUserId: principal.userId,
        roomId: params.roomId,
      });
    },
  );

  app.post(
    "/v1/rooms/:roomId/join-requests",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          keyGenerator: authenticatedRateKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePublicRequest(request, options.accounts);
      const params = parse(RoomParamsSchema, request.params);
      parse(EmptyBodySchema.optional(), request.body);
      const result = await options.discovery.requestJoin({
        actorUserId: principal.userId,
        roomId: params.roomId,
      });
      return reply.status(201).send(result);
    },
  );

  app.delete(
    "/v1/room-join-requests/:requestId",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          keyGenerator: authenticatedRateKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePublicRequest(request, options.accounts);
      const params = parse(RequestParamsSchema, request.params);
      parse(EmptyBodySchema.optional(), request.body);
      await options.discovery.cancelJoinRequest({
        actorUserId: principal.userId,
        requestId: params.requestId,
      });
      return reply.status(204).send();
    },
  );

  app.post(
    "/v1/room-join-requests/:requestId/decision",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          keyGenerator: authenticatedRateKey,
        },
      },
    },
    async (request) => {
      const principal = await authenticatePublicRequest(request, options.accounts);
      const params = parse(RequestParamsSchema, request.params);
      const body = parse(RoomJoinDecisionInputSchema, request.body);
      return options.discovery.decideJoinRequest({
        actorUserId: principal.userId,
        requestId: params.requestId,
        decision: body.decision,
        clientOpId: body.clientOpId,
      });
    },
  );

  app.post(
    "/v1/rooms/:roomId/invitations/batch",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          keyGenerator: authenticatedRateKey,
        },
      },
    },
    async (request, reply) => {
      const principal = await authenticatePublicRequest(request, options.accounts);
      const params = parse(RoomParamsSchema, request.params);
      const body = parse(BatchInvitationBodySchema, request.body);
      const result = await options.discovery.batchInvite({
        actorUserId: principal.userId,
        roomId: params.roomId,
        userIds: body.userIds,
      });
      return reply.status(201).send(result);
    },
  );

  app.get("/v1/notifications", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const query = parse(NotificationQuerySchema, request.query);
    return options.notifications.list({
      recipientUserId: principal.userId,
      after: query.after,
      limit: query.limit,
    });
  });

  app.post("/v1/notifications/:notificationId/read", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(NotificationParamsSchema, request.params);
    parse(EmptyBodySchema.optional(), request.body);
    return options.notifications.markRead({
      recipientUserId: principal.userId,
      notificationId: params.notificationId,
    });
  });

  app.post("/v1/notifications/read-all", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const body = parse(ReadAllBodySchema, request.body);
    return options.notifications.markAllRead({
      recipientUserId: principal.userId,
      through: body.throughCursor,
    });
  });
}
