import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("administrators")
    .addColumn("password_change_required", "boolean", (column) => column.notNull().defaultTo(false))
    .addColumn("totp_enrollment_required", "boolean", (column) => column.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("administrators")
    .dropColumn("totp_enrollment_required")
    .dropColumn("password_change_required")
    .execute();
}
