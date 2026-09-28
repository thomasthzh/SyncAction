import { sql, type Kysely } from "kysely";

const constraintName = "account_activation_grants_terminal_state_check";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("account_activation_grants").dropConstraint(constraintName).execute();
  await db.schema
    .alterTable("account_activation_grants")
    .addCheckConstraint(constraintName, sql`(used_at is null) = (user_id is null)`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("account_activation_grants").dropConstraint(constraintName).execute();
  await db.schema
    .alterTable("account_activation_grants")
    .addCheckConstraint(
      constraintName,
      sql`
        not (used_at is not null and revoked_at is not null)
        and ((used_at is null) = (user_id is null))
      `,
    )
    .execute();
}
