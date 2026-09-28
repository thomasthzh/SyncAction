import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AdminService } from "@syncaction/identity";
import { RoomService } from "@syncaction/rooms";
import { buildAdminApp } from "./app.js";
import { parseAdminServerConfig } from "./config.js";

const config = parseAdminServerConfig(process.env);
const db = createDatabase(config.databaseUrl);

try {
  await migrateToLatest(db);
  const administrators = new AdminService({
    db,
    totpEncryptionKey: config.totpEncryptionKey,
  });
  await administrators.requireExistingAdministrator();
  const rooms = new RoomService({ db });
  const app = await buildAdminApp({
    db,
    administrators,
    rooms,
    cookie: config.cookie,
    publicOrigin: config.publicOrigin,
  });
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, "Stopping administrator service");
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
