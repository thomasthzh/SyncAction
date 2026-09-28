import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("rooms")
    .addCheckConstraint("rooms_server_seq_nonnegative_check", sql`server_seq >= 0`)
    .execute();

  await db.schema
    .alterTable("room_operations")
    .addCheckConstraint("room_operations_sequence_positive_check", sql`server_seq > 0`)
    .execute();

  await db.schema
    .alterTable("room_operations")
    .addCheckConstraint("room_operations_epoch_nonnegative_check", sql`room_epoch >= 0`)
    .execute();

  await db.schema
    .createIndex("room_tabs_active_position_unique")
    .unique()
    .on("room_tabs")
    .columns(["room_id", "position"])
    .where(sql.ref("closed_at_seq"), "is", null)
    .execute();

  await db.schema
    .createIndex("room_operations_client_operation_unique")
    .unique()
    .on("room_operations")
    .columns(["room_id", "device_id", "client_op_id"])
    .execute();

  await db.schema
    .createIndex("room_operations_room_created_index")
    .on("room_operations")
    .columns(["room_id", "created_at"])
    .execute();

  await db.schema
    .createIndex("client_operations_room_sequence_index")
    .on("client_operations")
    .columns(["room_id", "server_seq"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("client_operations_room_sequence_index").ifExists().execute();
  await db.schema.dropIndex("room_operations_room_created_index").ifExists().execute();
  await db.schema.dropIndex("room_operations_client_operation_unique").ifExists().execute();
  await db.schema.dropIndex("room_tabs_active_position_unique").ifExists().execute();
  await db.schema
    .alterTable("room_operations")
    .dropConstraint("room_operations_epoch_nonnegative_check")
    .execute();
  await db.schema
    .alterTable("room_operations")
    .dropConstraint("room_operations_sequence_positive_check")
    .execute();
  await db.schema
    .alterTable("rooms")
    .dropConstraint("rooms_server_seq_nonnegative_check")
    .execute();
}
