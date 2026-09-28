import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("annotation_strokes")
    .addColumn("content_signature", "varchar(43)")
    .execute();
  await db.schema
    .alterTable("annotation_strokes")
    .addColumn("signature_version", "smallint")
    .execute();
  await db.schema
    .alterTable("annotation_strokes")
    .addCheckConstraint(
      "annotation_strokes_content_signature_pair_check",
      sql`(content_signature is null) = (signature_version is null)`,
    )
    .execute();
  await db.schema
    .alterTable("annotation_strokes")
    .addCheckConstraint(
      "annotation_strokes_content_signature_format_check",
      sql`content_signature is null or content_signature ~ '^[A-Za-z0-9_-]{43}$'`,
    )
    .execute();
  await db.schema
    .alterTable("annotation_strokes")
    .addCheckConstraint(
      "annotation_strokes_signature_version_positive_check",
      sql`signature_version is null or signature_version > 0`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("annotation_strokes")
    .dropConstraint("annotation_strokes_signature_version_positive_check")
    .execute();
  await db.schema
    .alterTable("annotation_strokes")
    .dropConstraint("annotation_strokes_content_signature_format_check")
    .execute();
  await db.schema
    .alterTable("annotation_strokes")
    .dropConstraint("annotation_strokes_content_signature_pair_check")
    .execute();
  await db.schema
    .alterTable("annotation_strokes")
    .dropColumn("signature_version")
    .dropColumn("content_signature")
    .execute();
}
