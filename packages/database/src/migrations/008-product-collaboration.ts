import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("rooms")
    .addColumn("visibility", "varchar(16)", (column) => column.notNull().defaultTo("PRIVATE"))
    .execute();
  await db.schema
    .alterTable("rooms")
    .addColumn("join_policy", "varchar(16)", (column) => column.notNull().defaultTo("INVITE_ONLY"))
    .execute();
  await db.schema
    .alterTable("rooms")
    .addColumn("room_revision", "bigint", (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("rooms")
    .addCheckConstraint("rooms_visibility_check", sql`visibility in ('PRIVATE', 'PUBLIC')`)
    .execute();
  await db.schema
    .alterTable("rooms")
    .addCheckConstraint(
      "rooms_join_policy_check",
      sql`join_policy in ('OPEN', 'APPROVAL', 'INVITE_ONLY')`,
    )
    .execute();
  await db.schema
    .alterTable("rooms")
    .addCheckConstraint("rooms_room_revision_nonnegative_check", sql`room_revision >= 0`)
    .execute();

  await db.schema
    .createTable("server_metadata")
    .addColumn("id", "varchar(16)", (column) => column.primaryKey())
    .addColumn("server_id", "uuid", (column) => column.notNull().unique())
    .addColumn("display_name", "varchar(128)", (column) => column.notNull())
    .addColumn("protocol_version", "integer", (column) => column.notNull())
    .addColumn("terms_version", "varchar(64)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("server_metadata_global_id_check", sql`id = 'GLOBAL'`)
    .addCheckConstraint(
      "server_metadata_protocol_version_positive_check",
      sql`protocol_version > 0`,
    )
    .execute();
  await sql`
    insert into server_metadata (
      id,
      server_id,
      display_name,
      protocol_version,
      terms_version
    ) values (
      'GLOBAL',
      ${randomUUID()},
      'SyncAction',
      1,
      '2026-07-30'
    )
  `.execute(db);

  await db.schema
    .createTable("room_join_requests")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("room_id", "uuid", (column) =>
      column.notNull().references("rooms.id").onDelete("cascade"),
    )
    .addColumn("applicant_user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("restrict"),
    )
    .addColumn("status", "varchar(16)", (column) => column.notNull())
    .addColumn("decided_by_user_id", "uuid", (column) =>
      column.references("users.id").onDelete("restrict"),
    )
    .addColumn("decision_client_op_id", "uuid")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("decided_at", "timestamptz")
    .addCheckConstraint(
      "room_join_requests_status_check",
      sql`status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED')`,
    )
    .execute();
  await db.schema
    .createIndex("room_join_requests_single_pending_index")
    .unique()
    .on("room_join_requests")
    .columns(["room_id", "applicant_user_id"])
    .where(sql.ref("status"), "=", "PENDING")
    .execute();
  await db.schema
    .createIndex("room_join_requests_owner_queue_index")
    .on("room_join_requests")
    .columns(["room_id", "created_at", "id"])
    .where(sql.ref("status"), "=", "PENDING")
    .execute();
  await db.schema
    .createIndex("room_join_requests_decision_client_op_index")
    .unique()
    .on("room_join_requests")
    .columns(["room_id", "decision_client_op_id"])
    .where(sql.ref("decision_client_op_id"), "is not", null)
    .execute();

  await db.schema
    .createTable("notifications")
    .addColumn("sequence", "bigserial", (column) => column.primaryKey())
    .addColumn("id", "uuid", (column) => column.notNull().unique())
    .addColumn("recipient_user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("type", "varchar(64)", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("read_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("notifications_recipient_cursor_index")
    .on("notifications")
    .columns(["recipient_user_id", "sequence desc"])
    .execute();
  await db.schema
    .createIndex("notifications_recipient_unread_index")
    .on("notifications")
    .columns(["recipient_user_id", "sequence desc"])
    .where(sql.ref("read_at"), "is", null)
    .execute();

  await db.schema
    .createTable("policy_acceptances")
    .addColumn("user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("terms_version", "varchar(64)", (column) => column.notNull())
    .addColumn("client_version", "varchar(32)", (column) => column.notNull())
    .addColumn("accepted_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("policy_acceptances_primary", ["user_id", "terms_version"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("policy_acceptances").execute();
  await db.schema.dropTable("notifications").execute();
  await db.schema.dropTable("room_join_requests").execute();
  await db.schema.dropTable("server_metadata").execute();
  await db.schema
    .alterTable("rooms")
    .dropConstraint("rooms_room_revision_nonnegative_check")
    .execute();
  await db.schema.alterTable("rooms").dropConstraint("rooms_join_policy_check").execute();
  await db.schema.alterTable("rooms").dropConstraint("rooms_visibility_check").execute();
  await db.schema.alterTable("rooms").dropColumn("room_revision").execute();
  await db.schema.alterTable("rooms").dropColumn("join_policy").execute();
  await db.schema.alterTable("rooms").dropColumn("visibility").execute();
}
