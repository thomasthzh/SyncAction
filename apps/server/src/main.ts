import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AccountService, createAccessTokenCodec } from "@syncaction/identity";
import { NotificationService, RoomProductEventBus, RoomService } from "@syncaction/rooms";
import { RoomSequencer } from "@syncaction/sync";
import { buildPublicApp } from "./app.js";
import { parsePublicServerConfig } from "./config.js";

const config = parsePublicServerConfig(process.env);
const db = createDatabase(config.databaseUrl);

try {
  await migrateToLatest(db);
  const accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: config.accessTokenIssuer,
      audience: config.accessTokenAudience,
      secret: config.accessTokenSecret,
    }),
  });
  const productEvents = new RoomProductEventBus();
  const notifications = new NotificationService({
    db,
    events: productEvents,
  });
  const rooms = new RoomService({
    db,
    notifications,
    events: productEvents,
  });
  const sequencer = new RoomSequencer({ db });
  const app = await buildPublicApp({
    db,
    accounts,
    rooms,
    productEvents,
    notifications,
    sequencer,
    annotationHmacKey: config.annotationHmacKey,
  });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, "Stopping public service");
    await app.close();
    await db.destroy();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ host: config.host, port: config.port });
} catch (cause) {
  await db.destroy();
  throw cause;
}
