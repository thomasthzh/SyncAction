import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // SyncAction has not reached a production deployment. Foundation session rows did not contain
  // enough data to migrate safely into replay-aware refresh sessions, so fail closed by removing
  // them before required identity columns are added.
  await sql`delete from device_sessions`.execute(db);

  await db.schema
    .alterTable("device_sessions")
    .addColumn("device_id", "uuid", (column) => column.notNull())
    .addColumn("generation", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("used_at", "timestamptz")
    .addColumn("replaced_by_session_id", "uuid")
    .execute();

  await db.schema
    .alterTable("device_sessions")
    .addUniqueConstraint("device_sessions_refresh_token_hash_unique", ["refresh_token_hash"])
    .execute();

  await db.schema
    .alterTable("device_sessions")
    .addForeignKeyConstraint(
      "device_sessions_replaced_by_session_id_foreign",
      ["replaced_by_session_id"],
      "device_sessions",
      ["id"],
    )
    .onDelete("set null")
    .execute();

  await db.schema
    .createIndex("device_sessions_user_device_index")
    .on("device_sessions")
    .columns(["user_id", "device_id"])
    .execute();

  await db.schema
    .createIndex("device_sessions_token_family_index")
    .on("device_sessions")
    .column("token_family_id")
    .execute();

  await db.schema
    .alterTable("users")
    .addColumn("password_reset_required", "boolean", (column) => column.notNull().defaultTo(false))
    .execute();

  await db.schema
    .createTable("administrators")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("username", "varchar(64)", (column) => column.notNull())
    .addColumn("username_normalized", "varchar(64)", (column) => column.notNull().unique())
    .addColumn("password_hash", "text", (column) => column.notNull())
    .addColumn("totp_secret_ciphertext", "text", (column) => column.notNull())
    .addColumn("last_totp_counter", "bigint", (column) => column.notNull().defaultTo(-1))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("admin_sessions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("administrator_id", "uuid", (column) =>
      column.notNull().references("administrators.id").onDelete("cascade"),
    )
    .addColumn("session_token_hash", "text", (column) => column.notNull().unique())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("admin_sessions_administrator_id_index")
    .on("admin_sessions")
    .column("administrator_id")
    .execute();

  await db.schema
    .createTable("password_reset_grants")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("token_hash", "text", (column) => column.notNull().unique())
    .addColumn("issued_by_administrator_id", "uuid", (column) =>
      column.notNull().references("administrators.id").onDelete("restrict"),
    )
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("password_reset_grants_user_id_index")
    .on("password_reset_grants")
    .column("user_id")
    .execute();

  await db.schema.alterTable("audit_events").addColumn("actor_administrator_id", "uuid").execute();

  await db.schema
    .alterTable("audit_events")
    .addForeignKeyConstraint(
      "audit_events_actor_administrator_id_foreign",
      ["actor_administrator_id"],
      "administrators",
      ["id"],
    )
    .onDelete("set null")
    .execute();

  await db.schema
    .alterTable("audit_events")
    .addCheckConstraint(
      "audit_events_single_actor_check",
      sql`not (actor_user_id is not null and actor_administrator_id is not null)`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("audit_events")
    .dropConstraint("audit_events_single_actor_check")
    .execute();
  await db.schema
    .alterTable("audit_events")
    .dropConstraint("audit_events_actor_administrator_id_foreign")
    .execute();
  await db.schema.alterTable("audit_events").dropColumn("actor_administrator_id").execute();
  await db.schema.dropTable("password_reset_grants").ifExists().execute();
  await db.schema.dropTable("admin_sessions").ifExists().execute();
  await db.schema.dropTable("administrators").ifExists().execute();
  await db.schema.alterTable("users").dropColumn("password_reset_required").execute();
  await db.schema.dropIndex("device_sessions_token_family_index").ifExists().execute();
  await db.schema.dropIndex("device_sessions_user_device_index").ifExists().execute();
  await db.schema
    .alterTable("device_sessions")
    .dropConstraint("device_sessions_replaced_by_session_id_foreign")
    .execute();
  await db.schema
    .alterTable("device_sessions")
    .dropConstraint("device_sessions_refresh_token_hash_unique")
    .execute();
  await db.schema
    .alterTable("device_sessions")
    .dropColumn("replaced_by_session_id")
    .dropColumn("used_at")
    .dropColumn("generation")
    .dropColumn("device_id")
    .execute();
}
