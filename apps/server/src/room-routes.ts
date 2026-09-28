import type { AccountService } from "@syncaction/identity";
import { RoomError, type RoomService } from "@syncaction/rooms";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticatePublicRequest } from "./auth-routes.js";

const roomParamsSchema = z.object({ roomId: z.unknown() }).strict();
const invitationParamsSchema = z.object({ invitationId: z.unknown() }).strict();
const roomInvitationParamsSchema = z
  .object({
    roomId: z.unknown(),
    invitationId: z.unknown(),
  })
  .strict();
const memberParamsSchema = z
  .object({
    roomId: z.unknown(),
    userId: z.unknown(),
  })
  .strict();
const roomNameSchema = z.object({ name: z.unknown() }).strict();
const createRoomSchema = z
  .object({
    name: z.unknown(),
    visibility: z.unknown().optional(),
    joinPolicy: z.unknown().optional(),
  })
  .strict();
const roomUpdateSchema = z.union([
  roomNameSchema,
  z
    .object({
      name: z.unknown(),
      visibility: z.unknown(),
      joinPolicy: z.unknown(),
    })
    .strict(),
]);
const invitationSchema = z.object({ username: z.unknown() }).strict();
const ownershipTransferSchema = z.object({ newOwnerUserId: z.unknown() }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RoomError("INVALID_ROOM_INPUT", { cause: result.error });
  }
  return result.data;
}

export interface PublicRoomRouteOptions {
  accounts: AccountService;
  rooms: RoomService;
  onRoomDeleted?: (roomId: unknown) => void | Promise<void>;
}

export function registerPublicRoomRoutes(
  app: FastifyInstance,
  options: PublicRoomRouteOptions,
): void {
  app.post("/v1/rooms", async (request, reply) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const body = parse(createRoomSchema, request.body);
    const room = await options.rooms.createRoom({
      actorUserId: principal.userId,
      name: body.name,
      ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
      ...(body.joinPolicy === undefined ? {} : { joinPolicy: body.joinPolicy }),
    });
    return reply.status(201).send(room);
  });

  app.get("/v1/rooms", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    return { rooms: await options.rooms.listRooms(principal.userId) };
  });

  app.get("/v1/rooms/:roomId", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(roomParamsSchema, request.params);
    return options.rooms.getRoom({
      actorUserId: principal.userId,
      roomId: params.roomId,
    });
  });

  app.patch("/v1/rooms/:roomId", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(roomParamsSchema, request.params);
    const body = parse(roomUpdateSchema, request.body);
    return "visibility" in body
      ? options.rooms.updateRoom({
          actorUserId: principal.userId,
          roomId: params.roomId,
          name: body.name,
          visibility: body.visibility,
          joinPolicy: body.joinPolicy,
        })
      : options.rooms.renameRoom({
          actorUserId: principal.userId,
          roomId: params.roomId,
          name: body.name,
        });
  });

  app.delete("/v1/rooms/:roomId", async (request, reply) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(roomParamsSchema, request.params);
    await options.rooms.softDeleteRoom({
      actorUserId: principal.userId,
      roomId: params.roomId,
    });
    await options.onRoomDeleted?.(params.roomId);
    return reply.status(204).send();
  });

  app.post("/v1/rooms/:roomId/invitations", async (request, reply) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(roomParamsSchema, request.params);
    const body = parse(invitationSchema, request.body);
    const invitation = await options.rooms.inviteByUsername({
      actorUserId: principal.userId,
      roomId: params.roomId,
      username: body.username,
    });
    return reply.status(201).send(invitation);
  });

  app.delete("/v1/rooms/:roomId/invitations/:invitationId", async (request, reply) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(roomInvitationParamsSchema, request.params);
    await options.rooms.revokeInvitation({
      actorUserId: principal.userId,
      roomId: params.roomId,
      invitationId: params.invitationId,
    });
    return reply.status(204).send();
  });

  app.get("/v1/invitations", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    return { invitations: await options.rooms.listInvitations(principal.userId) };
  });

  app.post("/v1/invitations/:invitationId/accept", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(invitationParamsSchema, request.params);
    return options.rooms.acceptInvitation({
      actorUserId: principal.userId,
      invitationId: params.invitationId,
    });
  });

  app.delete("/v1/rooms/:roomId/members/me", async (request, reply) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(roomParamsSchema, request.params);
    await options.rooms.leaveRoom({
      actorUserId: principal.userId,
      roomId: params.roomId,
    });
    return reply.status(204).send();
  });

  app.delete("/v1/rooms/:roomId/members/:userId", async (request, reply) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(memberParamsSchema, request.params);
    await options.rooms.removeMember({
      actorUserId: principal.userId,
      roomId: params.roomId,
      memberUserId: params.userId,
    });
    return reply.status(204).send();
  });

  app.post("/v1/rooms/:roomId/ownership-transfer", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const params = parse(roomParamsSchema, request.params);
    const body = parse(ownershipTransferSchema, request.body);
    return options.rooms.transferOwnership({
      actorUserId: principal.userId,
      roomId: params.roomId,
      newOwnerUserId: body.newOwnerUserId,
    });
  });
}
