import rateLimit from "@fastify/rate-limit";
import type { createDatabase } from "@syncaction/database";
import { AccountActivationService, type AccountService } from "@syncaction/identity";
import {
  NotificationService,
  RoomDiscoveryService,
  RoomProductEventBus,
  type RoomService,
} from "@syncaction/rooms";
import {
  AnnotationPageKeyDeriver,
  AnnotationService,
  DanmakuService,
  DocumentAuthorizationService,
  RoomMediaGroupService,
  RoomPointerService,
  RoomPresenceService,
  StrokePreviewService,
  type RoomSequencer,
} from "@syncaction/sync";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPublicAuthRoutes } from "./auth-routes.js";
import { registerPublicErrorHandler } from "./error-handler.js";
import { registerMetaRoutes } from "./meta-routes.js";
import { registerProductRoutes } from "./product-routes.js";
import { registerPublicRoomRoutes } from "./room-routes.js";
import { attachSyncSocket } from "./sync-socket.js";

type PublicDatabase = ReturnType<typeof createDatabase>;
export const TRUSTED_PROXY_CIDRS = ["127.0.0.0/8", "::1/128"];

export interface BuildPublicAppOptions {
  db: PublicDatabase;
  accounts: AccountService;
  activation?: AccountActivationService;
  rooms: RoomService;
  sequencer: RoomSequencer;
  annotationHmacKey: Uint8Array;
  presence?: RoomPresenceService;
  pointers?: RoomPointerService;
  media?: RoomMediaGroupService;
  annotations?: AnnotationService;
  danmaku?: DanmakuService;
  previews?: StrokePreviewService;
  productEvents?: RoomProductEventBus;
  notifications?: NotificationService;
  discovery?: RoomDiscoveryService;
  authRateLimitMax?: number;
  operationRateLimitMax?: number;
  presenceSweepIntervalMs?: number;
  logger?: boolean;
  readinessCheck?: () => Promise<void>;
  now?: () => Date;
}

export async function buildPublicApp(options: BuildPublicAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: TRUSTED_PROXY_CIDRS,
  });
  await app.register(rateLimit, { global: false });
  registerPublicErrorHandler(app);
  const activation =
    options.activation ??
    new AccountActivationService({ db: options.db, accounts: options.accounts });
  registerPublicAuthRoutes(app, {
    accounts: options.accounts,
    activation,
    authRateLimitMax: options.authRateLimitMax ?? 10,
  });
  registerMetaRoutes(app, {
    db: options.db,
    accounts: options.accounts,
  });
  const presence =
    options.presence ??
    new RoomPresenceService({
      db: options.db,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const pointers =
    options.pointers ??
    new RoomPointerService({
      authorization: presence,
    });
  const documentAuthorization = new DocumentAuthorizationService({
    db: options.db,
    presence,
  });
  const media =
    options.media ??
    new RoomMediaGroupService({
      authorization: documentAuthorization,
    });
  const annotations =
    options.annotations ??
    new AnnotationService({
      db: options.db,
      authorization: documentAuthorization,
      pageKeys: new AnnotationPageKeyDeriver(options.annotationHmacKey),
    });
  const danmaku =
    options.danmaku ??
    new DanmakuService({
      authorization: documentAuthorization,
    });
  const previews =
    options.previews ??
    new StrokePreviewService({
      authorization: documentAuthorization,
    });
  const productEvents = options.productEvents ?? new RoomProductEventBus();
  const notifications =
    options.notifications ??
    new NotificationService({
      db: options.db,
      events: productEvents,
    });
  const discovery =
    options.discovery ??
    new RoomDiscoveryService({
      db: options.db,
      notifications,
      events: productEvents,
      onlineUserIdsForRoom: (roomId) => presence.onlineUserIds(roomId),
      onlineUserIds: () => presence.onlineUserIds(),
      hasActivePlayback: (roomId) => media.hasActivePlayback(roomId),
    });
  const syncSocket = attachSyncSocket(app, {
    accounts: options.accounts,
    sequencer: options.sequencer,
    presence,
    pointers,
    media,
    annotations,
    danmaku,
    previews,
    productEvents,
    isPublicRoom: async (roomId) =>
      (await options.db
        .selectFrom("rooms")
        .select("id")
        .where("id", "=", roomId)
        .where("visibility", "=", "PUBLIC")
        .where("deletedAt", "is", null)
        .executeTakeFirst()) !== undefined,
    ...(options.operationRateLimitMax === undefined
      ? {}
      : { operationRateLimitMax: options.operationRateLimitMax }),
    ...(options.presenceSweepIntervalMs === undefined
      ? {}
      : { presenceSweepIntervalMs: options.presenceSweepIntervalMs }),
  });
  registerPublicRoomRoutes(app, {
    accounts: options.accounts,
    rooms: options.rooms,
    onRoomDeleted: (roomId) => syncSocket.closeMediaRoom(roomId),
  });
  registerProductRoutes(app, {
    accounts: options.accounts,
    discovery,
    notifications,
  });

  const readinessCheck =
    options.readinessCheck ??
    (async () => {
      await options.db
        .selectNoFrom((expression) => expression.val(1).as("ready"))
        .executeTakeFirstOrThrow();
    });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await readinessCheck();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "not-ready" });
    }
  });
  return app;
}
