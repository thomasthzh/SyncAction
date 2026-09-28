import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("annotation_pages")
    .addColumn("room_id", "uuid", (column) =>
      column.notNull().references("rooms.id").onDelete("cascade"),
    )
    .addColumn("page_key", "varchar(43)", (column) => column.notNull())
    .addColumn("annotation_seq", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("live_stroke_count", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("live_stroke_bytes", "bigint", (column) => column.notNull().defaultTo(0))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("annotation_pages_primary", ["room_id", "page_key"])
    .addCheckConstraint("annotation_pages_key_check", sql`page_key ~ '^[A-Za-z0-9_-]{43}$'`)
    .addCheckConstraint("annotation_pages_sequence_nonnegative_check", sql`annotation_seq >= 0`)
    .addCheckConstraint(
      "annotation_pages_live_count_nonnegative_check",
      sql`live_stroke_count >= 0`,
    )
    .addCheckConstraint(
      "annotation_pages_live_bytes_nonnegative_check",
      sql`live_stroke_bytes >= 0`,
    )
    .execute();

  await db.schema
    .createTable("annotation_strokes")
    .addColumn("room_id", "uuid", (column) => column.notNull())
    .addColumn("page_key", "varchar(43)", (column) => column.notNull())
    .addColumn("stroke_id", "uuid", (column) => column.notNull())
    .addColumn("author_user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("restrict"),
    )
    .addColumn("frame_key", "varchar(64)", (column) => column.notNull())
    .addColumn("anchor", "jsonb", (column) => column.notNull())
    .addColumn("points", "jsonb", (column) => column.notNull())
    .addColumn("rgb", "jsonb", (column) => column.notNull())
    .addColumn("width", "double precision", (column) => column.notNull())
    .addColumn("byte_size", "integer", (column) => column.notNull())
    .addColumn("locked_at", "timestamptz")
    .addColumn("version", "integer", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addPrimaryKeyConstraint("annotation_strokes_primary", ["room_id", "page_key", "stroke_id"])
    .addForeignKeyConstraint(
      "annotation_strokes_page_foreign",
      ["room_id", "page_key"],
      "annotation_pages",
      ["room_id", "page_key"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addCheckConstraint(
      "annotation_strokes_frame_key_check",
      sql`frame_key ~ '^(top|frame:sha256-[0-9a-f]{32})$'`,
    )
    .addCheckConstraint(
      "annotation_strokes_anchor_object_check",
      sql`jsonb_typeof(anchor) = 'object'`,
    )
    .addCheckConstraint(
      "annotation_strokes_points_array_check",
      sql`jsonb_typeof(points) = 'array' and jsonb_array_length(points) between 1 and 2048`,
    )
    .addCheckConstraint("annotation_strokes_rgb_object_check", sql`jsonb_typeof(rgb) = 'object'`)
    .addCheckConstraint("annotation_strokes_width_check", sql`width between 1 and 32`)
    .addCheckConstraint("annotation_strokes_byte_size_check", sql`byte_size between 1 and 65536`)
    .addCheckConstraint("annotation_strokes_version_positive_check", sql`version > 0`)
    .addCheckConstraint(
      "annotation_strokes_timestamp_order_check",
      sql`
        (locked_at is null or locked_at >= created_at)
        and (deleted_at is null or deleted_at >= created_at)
      `,
    )
    .execute();

  await db.schema
    .createIndex("annotation_strokes_live_index")
    .on("annotation_strokes")
    .columns(["room_id", "page_key", "created_at", "stroke_id"])
    .where(sql.ref("deleted_at"), "is", null)
    .execute();

  await db.schema
    .createTable("annotation_operations")
    .addColumn("room_id", "uuid", (column) => column.notNull())
    .addColumn("page_key", "varchar(43)", (column) => column.notNull())
    .addColumn("annotation_seq", "bigint", (column) => column.notNull())
    .addColumn("client_op_id", "uuid", (column) => column.notNull())
    .addColumn("actor_user_id", "uuid", (column) =>
      column.notNull().references("users.id").onDelete("restrict"),
    )
    .addColumn("operation", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("annotation_operations_primary", [
      "room_id",
      "page_key",
      "annotation_seq",
    ])
    .addForeignKeyConstraint(
      "annotation_operations_page_foreign",
      ["room_id", "page_key"],
      "annotation_pages",
      ["room_id", "page_key"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addCheckConstraint("annotation_operations_sequence_positive_check", sql`annotation_seq > 0`)
    .addCheckConstraint(
      "annotation_operations_payload_object_check",
      sql`jsonb_typeof(operation) = 'object'`,
    )
    .execute();

  await db.schema
    .createIndex("annotation_operations_client_operation_unique")
    .unique()
    .on("annotation_operations")
    .columns(["room_id", "page_key", "client_op_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("annotation_operations").ifExists().execute();
  await db.schema.dropTable("annotation_strokes").ifExists().execute();
  await db.schema.dropTable("annotation_pages").ifExists().execute();
}
