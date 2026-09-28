import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("account_activation_grants")
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("note", "varchar(120)", (column) => column.notNull())
    .addColumn("token_hash", "varchar(64)", (column) => column.notNull())
    .addColumn("token_tail", "varchar(8)", (column) => column.notNull())
    .addColumn("issued_by_administrator_id", "uuid", (column) =>
      column.notNull().references("administrators.id").onDelete("restrict"),
    )
    .addColumn("user_id", "uuid", (column) => column.references("users.id").onDelete("restrict"))
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("account_activation_grants_token_hash_unique", ["token_hash"])
    .addUniqueConstraint("account_activation_grants_user_id_unique", ["user_id"])
    .addCheckConstraint(
      "account_activation_grants_note_check",
      sql`char_length(note) between 1 and 120 and note ~ '[^[:space:]]'`,
    )
    .addCheckConstraint(
      "account_activation_grants_token_hash_check",
      sql`token_hash ~ '^[a-f0-9]{64}$'`,
    )
    .addCheckConstraint(
      "account_activation_grants_token_tail_check",
      sql`token_tail ~ '^[A-Za-z0-9_-]{8}$'`,
    )
    .addCheckConstraint("account_activation_grants_expiry_check", sql`expires_at > created_at`)
    .addCheckConstraint(
      "account_activation_grants_terminal_state_check",
      sql`
        not (used_at is not null and revoked_at is not null)
        and ((used_at is null) = (user_id is null))
      `,
    )
    .execute();

  await db.schema
    .createIndex("account_activation_grants_issued_by_index")
    .on("account_activation_grants")
    .column("issued_by_administrator_id")
    .execute();
  await db.schema
    .createIndex("account_activation_grants_created_at_index")
    .on("account_activation_grants")
    .column("created_at")
    .execute();
  await db.schema
    .createIndex("account_activation_grants_token_tail_index")
    .on("account_activation_grants")
    .column("token_tail")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("account_activation_grants").ifExists().execute();
}
