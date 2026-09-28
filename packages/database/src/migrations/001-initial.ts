import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("username", "varchar(64)", (column) => column.notNull())
    .addColumn("username_normalized", "varchar(64)", (column) => column.notNull().unique())
    .addColumn("display_name", "varchar(128)", (column) => column.notNull())
    .addColumn("password_hash", "text", (column) => column.notNull())
    .addColumn("status", "varchar(16)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "users_status_check",
      sql`status in ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED')`,
    )
    .execute();

  await db.schema
    .createTable("device_sessions")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("refresh_token_hash", "text", (column) => column.notNull())
    .addColumn("token_family_id", "uuid", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex("device_sessions_user_id_index")
    .on("device_sessions")
    .column("user_id")
    .execute();

  await db.schema
    .createTable("rooms")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("name", "varchar(128)", (column) => column.notNull())
    .addColumn("owner_user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("restrict"),
    )
    .addColumn("room_epoch", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("server_seq", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("room_memberships")
    .addColumn("room_id", "uuid", (column) =>
      column.notNull().references("rooms.id").onDelete("cascade"),
    )
    .addColumn("user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("role", "varchar(16)", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("room_memberships_primary", ["room_id", "user_id"])
    .addCheckConstraint("room_memberships_role_check", sql`role in ('OWNER', 'MEMBER')`)
    .execute();

  await db.schema
    .createTable("room_invitations")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("room_id", "uuid", (column) =>
      column.notNull().references("rooms.id").onDelete("cascade"),
    )
    .addColumn("invited_user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("invited_by_user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("restrict"),
    )
    .addColumn("status", "varchar(16)", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "room_invitations_status_check",
      sql`status in ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')`,
    )
    .execute();

  await db.schema
    .createIndex("room_invitations_invited_user_index")
    .on("room_invitations")
    .column("invited_user_id")
    .execute();

  await db.schema
    .createTable("room_tabs")
    .addColumn("room_id", "uuid", (column) =>
      column.notNull().references("rooms.id").onDelete("cascade"),
    )
    .addColumn("logical_tab_id", "uuid", (column) => column.notNull())
    .addColumn("url", "text", (column) => column.notNull())
    .addColumn("title", "varchar(512)")
    .addColumn("fav_icon_url", "text")
    .addColumn("position", "integer", (column) => column.notNull())
    .addColumn("created_at_seq", "bigint", (column) => column.notNull())
    .addColumn("updated_at_seq", "bigint", (column) => column.notNull())
    .addColumn("closed_at_seq", "bigint")
    .addPrimaryKeyConstraint("room_tabs_primary", ["room_id", "logical_tab_id"])
    .execute();

  await db.schema
    .createTable("room_operations")
    .addColumn("room_id", "uuid", (column) =>
      column.notNull().references("rooms.id").onDelete("cascade"),
    )
    .addColumn("server_seq", "bigint", (column) => column.notNull())
    .addColumn("room_epoch", "integer", (column) => column.notNull())
    .addColumn("client_op_id", "uuid", (column) => column.notNull())
    .addColumn("device_id", "uuid", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("room_operations_primary", ["room_id", "server_seq"])
    .execute();

  await db.schema
    .createTable("client_operations")
    .addColumn("room_id", "uuid", (column) =>
      column.notNull().references("rooms.id").onDelete("cascade"),
    )
    .addColumn("device_id", "uuid", (column) => column.notNull())
    .addColumn("client_op_id", "uuid", (column) => column.notNull())
    .addColumn("server_seq", "bigint", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("client_operations_primary", ["room_id", "device_id", "client_op_id"])
    .execute();

  await db.schema
    .createTable("room_snapshots")
    .addColumn("room_id", "uuid", (column) =>
      column.notNull().references("rooms.id").onDelete("cascade"),
    )
    .addColumn("room_epoch", "integer", (column) => column.notNull())
    .addColumn("server_seq", "bigint", (column) => column.notNull())
    .addColumn("state", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("room_snapshots_primary", ["room_id", "room_epoch", "server_seq"])
    .execute();

  await db.schema
    .createTable("audit_events")
    .addColumn("id", "bigserial", (column) => column.primaryKey())
    .addColumn("actor_user_id", "uuid", (column) =>
      column.references("users.id").onDelete("set null"),
    )
    .addColumn("event_type", "varchar(128)", (column) => column.notNull())
    .addColumn("target_type", "varchar(64)", (column) => column.notNull())
    .addColumn("target_id", "text")
    .addColumn("details", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "audit_events",
    "room_snapshots",
    "client_operations",
    "room_operations",
    "room_tabs",
    "room_invitations",
    "room_memberships",
    "rooms",
    "device_sessions",
    "users",
  ] as const) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}
