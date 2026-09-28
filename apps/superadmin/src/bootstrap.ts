import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AdminService } from "@syncaction/identity";
import { parseAdminBootstrapConfig } from "./bootstrap-config.js";

const config = parseAdminBootstrapConfig(process.env);
const db = createDatabase(config.databaseUrl);

try {
  await migrateToLatest(db);
  const administrators = new AdminService({
    db,
    totpEncryptionKey: config.totpEncryptionKey,
  });
  const administrator = await administrators.bootstrap({
    username: config.username,
    password: config.password,
    totpSecret: config.totpSecret,
    passwordChangeRequired: config.passwordChangeRequired,
    totpEnrollmentRequired: config.totpEnrollmentRequired,
  });
  process.stdout.write(
    `${JSON.stringify({
      administratorId: administrator.id,
      username: administrator.username,
    })}\n`,
  );
} finally {
  await db.destroy();
}
