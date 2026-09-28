import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import type { createDatabase } from "@syncaction/database";
import { AccountActivationGrantService, type AdminService } from "@syncaction/identity";
import type { RoomService } from "@syncaction/rooms";
import Fastify, { type FastifyInstance } from "fastify";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdminCookieConfig } from "./config.js";
import { AdminRateLimitError, registerAdminErrorHandler } from "./error-handler.js";
import { registerAdminRoutes } from "./routes.js";
import { AdminReadService } from "./read-service.js";
import { registerAdminSecurity } from "./security.js";

type AdminDatabase = ReturnType<typeof createDatabase>;
const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
export const TRUSTED_PROXY_CIDRS = ["127.0.0.0/8", "::1/128"];

export interface BuildAdminAppOptions {
  db: AdminDatabase;
  administrators: AdminService;
  activationGrants?: AccountActivationGrantService;
  rooms: RoomService;
  cookie: AdminCookieConfig;
  publicOrigin: string;
  authRateLimitMax?: number;
  logger?: boolean;
  readinessCheck?: () => Promise<void>;
  now?: () => Date;
}

export async function buildAdminApp(options: BuildAdminAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: TRUSTED_PROXY_CIDRS,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new AdminRateLimitError(),
  });
  registerAdminSecurity(app, { publicOrigin: options.publicOrigin });
  registerAdminErrorHandler(app);
  const reads =
    options.now === undefined
      ? new AdminReadService({ db: options.db })
      : new AdminReadService({ db: options.db, now: options.now });
  const activationGrants =
    options.activationGrants ??
    new AccountActivationGrantService({
      db: options.db,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  registerAdminRoutes(app, {
    db: options.db,
    administrators: options.administrators,
    rooms: options.rooms,
    reads,
    activationGrants,
    cookie: options.cookie,
    authRateLimitMax: options.authRateLimitMax ?? 5,
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
  await app.register(staticFiles, {
    root: publicRoot,
    wildcard: false,
    index: false,
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));
  return app;
}
