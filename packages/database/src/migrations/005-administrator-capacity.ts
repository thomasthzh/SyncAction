import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("administrators")
    .addColumn("linked_user_id", "uuid", (column) =>
      column.references("users.id").onDelete("restrict"),
    )
    .execute();

  await db.schema
    .createIndex("administrators_linked_user_id_unique")
    .unique()
    .on("administrators")
    .column("linked_user_id")
    .where(sql.ref("linked_user_id"), "is not", null)
    .execute();

  await db.schema
    .createTable("server_policies")
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("ordinary_active_room_limit", "integer", (column) => column.notNull())
    .addColumn("ordinary_open_tab_limit", "integer", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("server_policies_global_id_check", sql`id = 'GLOBAL'`)
    .addCheckConstraint(
      "server_policies_ordinary_active_room_limit_positive_check",
      sql`ordinary_active_room_limit > 0`,
    )
    .addCheckConstraint(
      "server_policies_ordinary_open_tab_limit_positive_check",
      sql`ordinary_open_tab_limit > 0`,
    )
    .execute();

  await sql`
    insert into server_policies (
      id,
      ordinary_active_room_limit,
      ordinary_open_tab_limit
    ) values ('GLOBAL', 5, 20)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("administrators_linked_user_id_unique").ifExists().execute();
  await db.schema.alterTable("administrators").dropColumn("linked_user_id").execute();
  await db.schema.dropTable("server_policies").ifExists().execute();
}
