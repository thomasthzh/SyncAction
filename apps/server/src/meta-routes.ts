import type { createDatabase } from "@syncaction/database";
import type { AccountService } from "@syncaction/identity";
import { ServerMetaSchema } from "@syncaction/protocol";
import { RoomError } from "@syncaction/rooms";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import serverPackage from "../package.json" with { type: "json" };
import { authenticatePublicRequest } from "./auth-routes.js";

type PublicDatabase = ReturnType<typeof createDatabase>;

const PolicyAcceptanceBodySchema = z
  .object({
    termsVersion: z.string().min(1).max(64),
    clientVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    accepted: z.literal(true),
  })
  .strict();

export interface MetaRouteOptions {
  db: PublicDatabase;
  accounts: AccountService;
}

export function registerMetaRoutes(app: FastifyInstance, options: MetaRouteOptions): void {
  app.get("/v1/meta", async () => {
    const [metadata, policy] = await Promise.all([
      options.db
        .selectFrom("serverMetadata")
        .select(["serverId", "displayName", "protocolVersion", "termsVersion"])
        .where("id", "=", "GLOBAL")
        .executeTakeFirstOrThrow(),
      options.db
        .selectFrom("serverPolicies")
        .select(["ordinaryActiveRoomLimit", "ordinaryOpenTabLimit"])
        .where("id", "=", "GLOBAL")
        .executeTakeFirstOrThrow(),
    ]);
    return ServerMetaSchema.parse({
      serverId: metadata.serverId,
      displayName: metadata.displayName,
      softwareVersion: serverPackage.version,
      protocolVersion: String(metadata.protocolVersion),
      minimumClientVersion: "0.8.1",
      termsVersion: metadata.termsVersion,
      capabilities: [
        "public-rooms",
        "join-requests",
        "notifications",
        "volatile-pointer-v2",
        "content-compatibility-v1",
        "account-activation-v1",
        "account-key-login-v1",
      ],
      limits: {
        ordinaryActiveRooms: policy.ordinaryActiveRoomLimit,
        ordinaryOpenTabs: policy.ordinaryOpenTabLimit,
      },
    });
  });

  app.get("/v1/policy-acceptances/current", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const metadata = await options.db
      .selectFrom("serverMetadata")
      .select("termsVersion")
      .where("id", "=", "GLOBAL")
      .executeTakeFirstOrThrow();
    const acceptance = await options.db
      .selectFrom("policyAcceptances")
      .select("userId")
      .where("userId", "=", principal.userId)
      .where("termsVersion", "=", metadata.termsVersion)
      .executeTakeFirst();
    return {
      termsVersion: metadata.termsVersion,
      accepted: acceptance !== undefined,
    };
  });

  app.post("/v1/policy-acceptances", async (request) => {
    const principal = await authenticatePublicRequest(request, options.accounts);
    const parsed = PolicyAcceptanceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new RoomError("INVALID_ROOM_INPUT", { cause: parsed.error });
    }
    const metadata = await options.db
      .selectFrom("serverMetadata")
      .select("termsVersion")
      .where("id", "=", "GLOBAL")
      .executeTakeFirstOrThrow();
    if (parsed.data.termsVersion !== metadata.termsVersion) {
      throw new RoomError("POLICY_VERSION_MISMATCH");
    }
    const acceptedAt = new Date();
    await options.db
      .insertInto("policyAcceptances")
      .values({
        userId: principal.userId,
        termsVersion: metadata.termsVersion,
        clientVersion: parsed.data.clientVersion,
        acceptedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["userId", "termsVersion"]).doUpdateSet({
          clientVersion: parsed.data.clientVersion,
          acceptedAt,
        }),
      )
      .execute();
    return { termsVersion: metadata.termsVersion, accepted: true };
  });
}
