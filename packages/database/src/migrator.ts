import type { Kysely } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import * as initial from "./migrations/001-initial.js";
import * as identitySecurity from "./migrations/002-identity-security.js";
import * as roomAccess from "./migrations/003-room-access.js";
import * as durableSequencer from "./migrations/004-durable-sequencer.js";
import * as administratorCapacity from "./migrations/005-administrator-capacity.js";
import * as pageAnnotations from "./migrations/006-page-annotations.js";
import * as administratorOnboarding from "./migrations/007-administrator-onboarding.js";
import * as productCollaboration from "./migrations/008-product-collaboration.js";
import * as annotationContentSignatures from "./migrations/009-annotation-content-signatures.js";
import * as accountActivation from "./migrations/010-account-activation.js";
import * as accountKeyLogin from "./migrations/011-account-key-login.js";
import type { Database } from "./schema.js";

class SyncActionMigrationProvider implements MigrationProvider {
  public async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "001-initial": initial,
      "002-identity-security": identitySecurity,
      "003-room-access": roomAccess,
      "004-durable-sequencer": durableSequencer,
      "005-administrator-capacity": administratorCapacity,
      "006-page-annotations": pageAnnotations,
      "007-administrator-onboarding": administratorOnboarding,
      "008-product-collaboration": productCollaboration,
      "009-annotation-content-signatures": annotationContentSignatures,
      "010-account-activation": accountActivation,
      "011-account-key-login": accountKeyLogin,
    };
  }
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new SyncActionMigrationProvider(),
  });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw result.error;
  }
  const failed = result.results?.find((migration) => migration.status === "Error");
  if (failed !== undefined) {
    throw new Error(`Migration ${failed.migrationName} failed`);
  }
}
