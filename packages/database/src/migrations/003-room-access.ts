import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("room_memberships_single_owner_index")
    .unique()
    .on("room_memberships")
    .column("room_id")
    .where(sql.ref("role"), "=", "OWNER")
    .execute();

  await db.schema
    .createIndex("room_memberships_user_id_index")
    .on("room_memberships")
    .column("user_id")
    .execute();

  await db.schema
    .createIndex("room_invitations_single_pending_index")
    .unique()
    .on("room_invitations")
    .columns(["room_id", "invited_user_id"])
    .where(sql.ref("status"), "=", "PENDING")
    .execute();

  await db.schema
    .createIndex("room_invitations_room_id_index")
    .on("room_invitations")
    .column("room_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("room_invitations_room_id_index").ifExists().execute();
  await db.schema.dropIndex("room_invitations_single_pending_index").ifExists().execute();
  await db.schema.dropIndex("room_memberships_user_id_index").ifExists().execute();
  await db.schema.dropIndex("room_memberships_single_owner_index").ifExists().execute();
}
