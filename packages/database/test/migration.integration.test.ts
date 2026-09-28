import { sql, type Kysely, type QueryExecutorProvider, type Selectable } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { createDatabase, migrateToLatest, type Database } from "../src/index.js";
import * as administratorCapacity from "../src/migrations/005-administrator-capacity.js";
import * as pageAnnotations from "../src/migrations/006-page-annotations.js";
import * as administratorOnboarding from "../src/migrations/007-administrator-onboarding.js";
import * as productCollaboration from "../src/migrations/008-product-collaboration.js";
import * as annotationContentSignatures from "../src/migrations/009-annotation-content-signatures.js";
import * as accountActivation from "../src/migrations/010-account-activation.js";
import * as accountKeyLogin from "../src/migrations/011-account-key-login.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

let db: Kysely<Database>;

interface BaselineSchemaSnapshot {
  administratorColumns: Array<{ columnName: string }>;
  constraints: Array<{
    constraintName: string;
    constraintType: string;
    tableName: string;
  }>;
  indexes: Array<{ indexName: string; tableName: string }>;
  tables: Array<{ tableName: string }>;
}

async function captureBaselineSchemaSnapshot(
  executor: QueryExecutorProvider,
): Promise<BaselineSchemaSnapshot> {
  const tables = await sql<{ tableName: string }>`
    select table_name as table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name <> 'server_policies'
    order by table_name
  `.execute(executor);
  const administratorColumns = await sql<{ columnName: string }>`
    select column_name as column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'administrators'
      and column_name <> 'linked_user_id'
    order by column_name
  `.execute(executor);
  const indexes = await sql<{ indexName: string; tableName: string }>`
    select indexname as index_name, tablename as table_name
    from pg_indexes
    where schemaname = 'public'
      and tablename <> 'server_policies'
      and indexname <> 'administrators_linked_user_id_unique'
    order by tablename, indexname
  `.execute(executor);
  const constraints = await sql<{
    constraintName: string;
    constraintType: string;
    tableName: string;
  }>`
    select
      tc.constraint_name as constraint_name,
      tc.constraint_type as constraint_type,
      tc.table_name as table_name
    from information_schema.table_constraints tc
    where tc.constraint_schema = 'public'
      and tc.table_name <> 'server_policies'
      and not exists (
        select 1
        from information_schema.key_column_usage kcu
        where kcu.constraint_schema = tc.constraint_schema
          and kcu.constraint_name = tc.constraint_name
          and kcu.table_name = tc.table_name
          and kcu.column_name = 'linked_user_id'
      )
    order by tc.table_name, tc.constraint_name
  `.execute(executor);

  return {
    administratorColumns: administratorColumns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    tables: tables.rows,
  };
}

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("accountActivationGrants").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

describe("initial migration", () => {
  it("creates secure account activation grant storage", async () => {
    const tables = await sql<{ tableName: string }>`
      select table_name as table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'account_activation_grants'
    `.execute(db);
    expect(tables.rows.map((row) => row.tableName)).toEqual(["account_activation_grants"]);

    const constraints = await sql<{ constraintName: string }>`
      select conname as constraint_name
      from pg_constraint
      where conname in (
        'account_activation_grants_token_hash_unique',
        'account_activation_grants_user_id_unique',
        'account_activation_grants_note_check',
        'account_activation_grants_token_tail_check',
        'account_activation_grants_expiry_check',
        'account_activation_grants_terminal_state_check'
      )
      order by conname
    `.execute(db);
    expect(constraints.rows.map((row) => row.constraintName)).toEqual([
      "account_activation_grants_expiry_check",
      "account_activation_grants_note_check",
      "account_activation_grants_terminal_state_check",
      "account_activation_grants_token_hash_unique",
      "account_activation_grants_token_tail_check",
      "account_activation_grants_user_id_unique",
    ]);

    const indexes = await sql<{ indexName: string }>`
      select indexname as index_name
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'account_activation_grants_issued_by_index',
          'account_activation_grants_created_at_index',
          'account_activation_grants_token_tail_index'
        )
      order by indexname
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexName)).toEqual([
      "account_activation_grants_created_at_index",
      "account_activation_grants_issued_by_index",
      "account_activation_grants_token_tail_index",
    ]);
  });

  it("rejects whitespace-only activation notes at the database boundary", async () => {
    await db
      .insertInto("administrators")
      .values({
        id: "018f8f8e-4b5c-7d6e-8f90-123456789a91",
        username: "NoteConstraintAdmin",
        usernameNormalized: "noteconstraintadmin",
        passwordHash: "hash",
        totpSecretCiphertext: "ciphertext",
        linkedUserId: null,
      })
      .execute();

    await expect(
      sql`
        insert into account_activation_grants (
          id, note, token_hash, token_tail, issued_by_administrator_id, expires_at
        ) values (
          '018f8f8e-4b5c-7d6e-8f90-123456789a92',
          E'\t\n',
          repeat('a', 64),
          'A1b2C3d4',
          '018f8f8e-4b5c-7d6e-8f90-123456789a91',
          now() + interval '7 days'
        )
      `.execute(db),
    ).rejects.toThrow(/account_activation_grants_note_check/u);
  });

  it("upgrades the activation constraint so a claimed key can be revoked", async () => {
    const administratorId = "018f8f8e-4b5c-7d6e-8f90-123456789a94";
    const userId = "018f8f8e-4b5c-7d6e-8f90-123456789a95";
    const grantId = "018f8f8e-4b5c-7d6e-8f90-123456789a96";
    const now = new Date("2026-08-31T00:00:00.000Z");
    await db
      .insertInto("users")
      .values({
        id: userId,
        username: "RevokedClaimedUser",
        usernameNormalized: "revokedclaimeduser",
        displayName: "Revoked Claimed User",
        passwordHash: "hash",
        status: "ACTIVE",
        passwordResetRequired: true,
      })
      .execute();
    await db
      .insertInto("administrators")
      .values({
        id: administratorId,
        username: "RevokedClaimedAdmin",
        usernameNormalized: "revokedclaimedadmin",
        passwordHash: "hash",
        totpSecretCiphertext: "ciphertext",
        linkedUserId: null,
      })
      .execute();

    await expect(
      db
        .insertInto("accountActivationGrants")
        .values({
          id: grantId,
          note: "Revoked claimed grant",
          tokenHash: "a".repeat(64),
          tokenTail: "A1b2C3d4",
          issuedByAdministratorId: administratorId,
          userId,
          expiresAt: new Date("2026-09-07T00:00:00.000Z"),
          usedAt: now,
          revokedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .execute(),
    ).resolves.toBeDefined();

    await db.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("accountActivationGrants").where("id", "=", grantId).execute();
      const migrationDb = transaction as unknown as Kysely<unknown>;
      await accountKeyLogin.down(migrationDb);
      await accountKeyLogin.up(migrationDb);
    });
  });

  it("upgrades a populated v0.9.5 schema with migration 010 without changing existing data", async () => {
    await db.transaction().execute(async (transaction) => {
      const existingUserId = "018f8f8e-4b5c-7d6e-8f90-123456789a93";
      await transaction
        .insertInto("users")
        .values({
          id: existingUserId,
          username: "ExistingV095User",
          usernameNormalized: "existingv095user",
          displayName: "Existing v0.9.5 User",
          passwordHash: "hash",
          status: "ACTIVE",
        })
        .execute();
      const migrationDb = transaction as unknown as Kysely<unknown>;
      await accountActivation.down(migrationDb);
      const beforeUpgrade = await sql<{ tableName: string }>`
        select table_name as table_name
        from information_schema.tables
        where table_schema = 'public' and table_name = 'account_activation_grants'
      `.execute(transaction);
      expect(beforeUpgrade.rows).toEqual([]);

      await accountActivation.up(migrationDb);
      await accountKeyLogin.up(migrationDb);

      await expect(
        transaction
          .selectFrom("users")
          .select(["username", "displayName", "status"])
          .where("id", "=", existingUserId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        username: "ExistingV095User",
        displayName: "Existing v0.9.5 User",
        status: "ACTIVE",
      });
      await transaction.deleteFrom("users").where("id", "=", existingUserId).execute();
    });
  });

  it("seeds the global server policy and rejects another policy id", async () => {
    expectTypeOf<Database["serverPolicies"]["id"]>().toEqualTypeOf<"GLOBAL">();

    const policies = await db
      .selectFrom("serverPolicies")
      .select(["id", "ordinaryActiveRoomLimit", "ordinaryOpenTabLimit"])
      .execute();
    expect(policies).toEqual([
      {
        id: "GLOBAL",
        ordinaryActiveRoomLimit: 5,
        ordinaryOpenTabLimit: 20,
      },
    ]);

    try {
      await expect(
        sql`
          insert into server_policies (
            id,
            ordinary_active_room_limit,
            ordinary_open_tab_limit
          ) values ('OTHER', 6, 21)
        `.execute(db),
      ).rejects.toThrow(/server_policies_global_id_check/);
    } finally {
      await sql`delete from server_policies where id = 'OTHER'`.execute(db);
    }

    await expect(
      db
        .selectFrom("serverPolicies")
        .select(["id", "ordinaryActiveRoomLimit", "ordinaryOpenTabLimit"])
        .execute(),
    ).resolves.toEqual(policies);
  });

  it("rejects duplicate non-null administrator links", async () => {
    const userId = "018f8f8e-4b5c-7d6e-8f90-123456789ab0";
    await db
      .insertInto("users")
      .values({
        id: userId,
        username: "LinkedUser",
        usernameNormalized: "linkeduser",
        displayName: "Linked User",
        passwordHash: "hash",
        status: "ACTIVE",
      })
      .execute();
    await db
      .insertInto("administrators")
      .values({
        id: "018f8f8e-4b5c-7d6e-8f90-123456789ab1",
        username: "LinkedAdmin",
        usernameNormalized: "linkedadmin",
        passwordHash: "hash",
        totpSecretCiphertext: "ciphertext",
        linkedUserId: userId,
      })
      .execute();

    await expect(
      db
        .insertInto("administrators")
        .values({
          id: "018f8f8e-4b5c-7d6e-8f90-123456789ab2",
          username: "DuplicateLinkAdmin",
          usernameNormalized: "duplicatelinkadmin",
          passwordHash: "hash",
          totpSecretCiphertext: "ciphertext",
          linkedUserId: userId,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("rejects an administrator link to a missing user", async () => {
    await expect(
      db
        .insertInto("administrators")
        .values({
          id: "018f8f8e-4b5c-7d6e-8f90-123456789ab3",
          username: "MissingUserAdmin",
          usernameNormalized: "missinguseradmin",
          passwordHash: "hash",
          totpSecretCiphertext: "ciphertext",
          linkedUserId: "018f8f8e-4b5c-7d6e-8f90-123456789ab4",
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("preserves and restores the migration schema transactionally", async () => {
    await db.transaction().execute(async (transaction) => {
      const baselineSchemaBeforeDown = await captureBaselineSchemaSnapshot(transaction);
      const migrationDb = transaction as unknown as Kysely<unknown>;
      await administratorCapacity.down(migrationDb);

      const serverPoliciesAfterDown = await sql<{ tableName: string }>`
        select table_name as table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name = 'server_policies'
      `.execute(transaction);
      const linkedUserColumnsAfterDown = await sql<{ columnName: string }>`
        select column_name as column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'administrators'
          and column_name = 'linked_user_id'
      `.execute(transaction);
      const linkedUserIndexesAfterDown = await sql<{ indexName: string }>`
        select indexname as index_name
        from pg_indexes
        where schemaname = 'public'
          and indexname = 'administrators_linked_user_id_unique'
      `.execute(transaction);
      const baselineSchemaAfterDown = await captureBaselineSchemaSnapshot(transaction);

      expect(serverPoliciesAfterDown.rows).toEqual([]);
      expect(linkedUserColumnsAfterDown.rows).toEqual([]);
      expect(linkedUserIndexesAfterDown.rows).toEqual([]);
      expect(baselineSchemaAfterDown).toEqual(baselineSchemaBeforeDown);

      await administratorCapacity.up(migrationDb);

      const restoredPolicies = await transaction
        .selectFrom("serverPolicies")
        .select(["id", "ordinaryActiveRoomLimit", "ordinaryOpenTabLimit"])
        .execute();
      const restoredLinkedUserColumn = await sql<{
        columnName: string;
        isNullable: string;
      }>`
        select column_name as column_name, is_nullable as is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'administrators'
          and column_name = 'linked_user_id'
      `.execute(transaction);
      const restoredLinkedUserForeignKey = await sql<{
        constraintType: string;
        deleteRule: string;
        referencedColumnName: string;
        referencedTableName: string;
      }>`
        select
          tc.constraint_type as constraint_type,
          rc.delete_rule as delete_rule,
          ccu.column_name as referenced_column_name,
          ccu.table_name as referenced_table_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_schema = tc.constraint_schema
          and kcu.constraint_name = tc.constraint_name
          and kcu.table_name = tc.table_name
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_schema = tc.constraint_schema
          and ccu.constraint_name = tc.constraint_name
        join information_schema.referential_constraints rc
          on rc.constraint_schema = tc.constraint_schema
          and rc.constraint_name = tc.constraint_name
        where tc.constraint_schema = 'public'
          and tc.table_name = 'administrators'
          and kcu.column_name = 'linked_user_id'
      `.execute(transaction);
      const restoredLinkedUserIndex = await sql<{
        indexName: string;
        isUnique: boolean;
        predicate: string | null;
      }>`
        select
          index_class.relname as index_name,
          index_relation.indisunique as is_unique,
          pg_get_expr(index_relation.indpred, index_relation.indrelid) as predicate
        from pg_index index_relation
        join pg_class index_class on index_class.oid = index_relation.indexrelid
        join pg_class table_class on table_class.oid = index_relation.indrelid
        join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
        where table_namespace.nspname = 'public'
          and table_class.relname = 'administrators'
          and index_class.relname = 'administrators_linked_user_id_unique'
      `.execute(transaction);

      expect(restoredPolicies).toEqual([
        {
          id: "GLOBAL",
          ordinaryActiveRoomLimit: 5,
          ordinaryOpenTabLimit: 20,
        },
      ]);
      expect(restoredLinkedUserColumn.rows).toEqual([
        { columnName: "linked_user_id", isNullable: "YES" },
      ]);
      expect(restoredLinkedUserForeignKey.rows).toEqual([
        {
          constraintType: "FOREIGN KEY",
          deleteRule: "RESTRICT",
          referencedColumnName: "id",
          referencedTableName: "users",
        },
      ]);
      expect(restoredLinkedUserIndex.rows).toHaveLength(1);
      expect(restoredLinkedUserIndex.rows[0]).toMatchObject({
        indexName: "administrators_linked_user_id_unique",
        isUnique: true,
      });
      expect(restoredLinkedUserIndex.rows[0]?.predicate).toContain("linked_user_id IS NOT NULL");
    });
  });

  it("creates every durable SyncAction table", async () => {
    const result = await sql<{ tableName: string }>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `.execute(db);

    expect(result.rows.map((row) => row.tableName)).toEqual(
      expect.arrayContaining([
        "audit_events",
        "annotation_operations",
        "annotation_pages",
        "annotation_strokes",
        "client_operations",
        "device_sessions",
        "room_invitations",
        "room_memberships",
        "room_operations",
        "room_snapshots",
        "room_tabs",
        "rooms",
        "users",
      ]),
    );
  });

  it("creates replay-safe identity and administrator storage", async () => {
    const result = await sql<{ tableName: string; columnName: string }>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'device_sessions',
          'administrators',
          'admin_sessions',
          'password_reset_grants',
          'audit_events'
        )
    `.execute(db);

    expect(result.rows).toEqual(
      expect.arrayContaining([
        { tableName: "device_sessions", columnName: "device_id" },
        { tableName: "device_sessions", columnName: "generation" },
        { tableName: "device_sessions", columnName: "used_at" },
        { tableName: "device_sessions", columnName: "replaced_by_session_id" },
        { tableName: "administrators", columnName: "totp_secret_ciphertext" },
        { tableName: "administrators", columnName: "last_totp_counter" },
        { tableName: "administrators", columnName: "password_change_required" },
        { tableName: "administrators", columnName: "totp_enrollment_required" },
        { tableName: "admin_sessions", columnName: "session_token_hash" },
        { tableName: "password_reset_grants", columnName: "token_hash" },
        { tableName: "audit_events", columnName: "actor_administrator_id" },
      ]),
    );
  });

  it("defaults administrator onboarding flags to completed", async () => {
    const administrator = await sql<{
      passwordChangeRequired: boolean;
      totpEnrollmentRequired: boolean;
    }>`
      insert into administrators (
        id,
        username,
        username_normalized,
        password_hash,
        totp_secret_ciphertext
      ) values (
        '018f8f8e-4b5c-7d6e-8f90-123456789ad0',
        'EnrolledAdmin',
        'enrolledadmin',
        'hash',
        'ciphertext'
      )
      returning
        password_change_required as password_change_required,
        totp_enrollment_required as totp_enrollment_required
    `.execute(db);

    expect(administrator.rows).toEqual([
      {
        passwordChangeRequired: false,
        totpEnrollmentRequired: false,
      },
    ]);
  });

  it("removes and restores administrator onboarding flags transactionally", async () => {
    await db.transaction().execute(async (transaction) => {
      const migrationDb = transaction as unknown as Kysely<unknown>;
      await administratorOnboarding.down(migrationDb);

      const afterDown = await sql<{ columnName: string }>`
        select column_name as column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'administrators'
          and column_name in (
            'password_change_required',
            'totp_enrollment_required'
          )
        order by column_name
      `.execute(transaction);
      expect(afterDown.rows).toEqual([]);

      await administratorOnboarding.up(migrationDb);

      const afterUp = await sql<{
        columnDefault: string | null;
        columnName: string;
        isNullable: string;
      }>`
        select
          column_default as column_default,
          column_name as column_name,
          is_nullable as is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'administrators'
          and column_name in (
            'password_change_required',
            'totp_enrollment_required'
          )
        order by column_name
      `.execute(transaction);
      expect(afterUp.rows).toEqual([
        {
          columnDefault: "false",
          columnName: "password_change_required",
          isNullable: "NO",
        },
        {
          columnDefault: "false",
          columnName: "totp_enrollment_required",
          isNullable: "NO",
        },
      ]);
    });
  });

  it("enforces refresh-token and administrator identity uniqueness", async () => {
    await sql`
      insert into administrators (
        id,
        username,
        username_normalized,
        password_hash,
        totp_secret_ciphertext
      ) values (
        '018f8f8e-4b5c-7d6e-8f90-123456789ac0',
        'Admin',
        'admin',
        'hash',
        'ciphertext'
      )
    `.execute(db);

    await expect(
      sql`
        insert into administrators (
          id,
          username,
          username_normalized,
          password_hash,
          totp_secret_ciphertext
        ) values (
          '018f8f8e-4b5c-7d6e-8f90-123456789ac1',
          'ADMIN',
          'admin',
          'other-hash',
          'other-ciphertext'
        )
      `.execute(db),
    ).rejects.toThrow();

    await sql`
      insert into users (
        id, username, username_normalized, display_name, password_hash, status
      ) values (
        '018f8f8e-4b5c-7d6e-8f90-123456789ac2',
        'SessionOwner',
        'sessionowner',
        'Session Owner',
        'hash',
        'ACTIVE'
      )
    `.execute(db);
    await sql`
      insert into device_sessions (
        id,
        user_id,
        device_id,
        refresh_token_hash,
        token_family_id,
        generation,
        expires_at
      ) values (
        '018f8f8e-4b5c-7d6e-8f90-123456789ac3',
        '018f8f8e-4b5c-7d6e-8f90-123456789ac2',
        '018f8f8e-4b5c-7d6e-8f90-123456789ac4',
        'same-refresh-hash',
        '018f8f8e-4b5c-7d6e-8f90-123456789ac5',
        0,
        now() + interval '30 days'
      )
    `.execute(db);

    await expect(
      sql`
        insert into device_sessions (
          id,
          user_id,
          device_id,
          refresh_token_hash,
          token_family_id,
          generation,
          expires_at
        ) values (
          '018f8f8e-4b5c-7d6e-8f90-123456789ac6',
          '018f8f8e-4b5c-7d6e-8f90-123456789ac2',
          '018f8f8e-4b5c-7d6e-8f90-123456789ac7',
          'same-refresh-hash',
          '018f8f8e-4b5c-7d6e-8f90-123456789ac8',
          0,
          now() + interval '30 days'
        )
      `.execute(db),
    ).rejects.toThrow();
  });

  it("enforces normalized username uniqueness", async () => {
    await sql`
      insert into users (
        id, username, username_normalized, display_name, password_hash, status
      ) values (
        '018f8f8e-4b5c-7d6e-8f90-123456789abc',
        'Alex',
        'alex',
        'Alex',
        'hash',
        'PENDING'
      )
    `.execute(db);

    await expect(
      sql`
        insert into users (
          id, username, username_normalized, display_name, password_hash, status
        ) values (
          '018f8f8e-4b5c-7d6e-8f90-123456789abd',
          'ALEX',
          'alex',
          'Other',
          'hash',
          'PENDING'
        )
      `.execute(db),
    ).rejects.toThrow();
  });

  it("creates room-access lookup indexes", async () => {
    const result = await sql<{ indexName: string }>`
      select indexname as index_name
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'room_memberships_single_owner_index',
          'room_memberships_user_id_index',
          'room_invitations_single_pending_index',
          'room_invitations_room_id_index'
        )
      order by indexname
    `.execute(db);

    expect(result.rows.map((row) => row.indexName)).toEqual([
      "room_invitations_room_id_index",
      "room_invitations_single_pending_index",
      "room_memberships_single_owner_index",
      "room_memberships_user_id_index",
    ]);
  });

  it("enforces one owner and one pending invitation per room", async () => {
    const ownerId = "018f8f8e-4b5c-7d6e-8f90-123456789ad0";
    const memberId = "018f8f8e-4b5c-7d6e-8f90-123456789ad1";
    const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ad2";
    await db
      .insertInto("users")
      .values([
        {
          id: ownerId,
          username: "RoomOwner",
          usernameNormalized: "roomowner",
          displayName: "Room Owner",
          passwordHash: "hash",
          status: "ACTIVE",
        },
        {
          id: memberId,
          username: "RoomMember",
          usernameNormalized: "roommember",
          displayName: "Room Member",
          passwordHash: "hash",
          status: "ACTIVE",
        },
      ])
      .execute();
    await db
      .insertInto("rooms")
      .values({ id: roomId, name: "Access", ownerUserId: ownerId, deletedAt: null })
      .execute();
    await db
      .insertInto("roomMemberships")
      .values({ roomId, userId: ownerId, role: "OWNER" })
      .execute();

    await expect(
      db
        .insertInto("roomMemberships")
        .values({ roomId, userId: memberId, role: "OWNER" })
        .execute(),
    ).rejects.toThrow();

    await db
      .insertInto("roomInvitations")
      .values({
        id: "018f8f8e-4b5c-7d6e-8f90-123456789ad3",
        roomId,
        invitedUserId: memberId,
        invitedByUserId: ownerId,
        status: "PENDING",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      })
      .execute();

    await expect(
      db
        .insertInto("roomInvitations")
        .values({
          id: "018f8f8e-4b5c-7d6e-8f90-123456789ad4",
          roomId,
          invitedUserId: memberId,
          invitedByUserId: ownerId,
          status: "PENDING",
          expiresAt: new Date("2099-01-02T00:00:00.000Z"),
        })
        .execute(),
    ).rejects.toThrow();

    await db
      .updateTable("roomInvitations")
      .set({ status: "REVOKED" })
      .where("id", "=", "018f8f8e-4b5c-7d6e-8f90-123456789ad3")
      .execute();
    await expect(
      db
        .insertInto("roomInvitations")
        .values({
          id: "018f8f8e-4b5c-7d6e-8f90-123456789ad4",
          roomId,
          invitedUserId: memberId,
          invitedByUserId: ownerId,
          status: "PENDING",
          expiresAt: new Date("2099-01-02T00:00:00.000Z"),
        })
        .execute(),
    ).resolves.toBeDefined();
  });

  it("creates durable sequencer indexes and checks", async () => {
    const indexes = await sql<{ indexName: string }>`
      select indexname as index_name
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'room_tabs_active_position_unique',
          'room_operations_client_operation_unique',
          'room_operations_room_created_index',
          'client_operations_room_sequence_index'
        )
      order by indexname
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexName)).toEqual([
      "client_operations_room_sequence_index",
      "room_operations_client_operation_unique",
      "room_operations_room_created_index",
      "room_tabs_active_position_unique",
    ]);

    const constraints = await sql<{ constraintName: string }>`
      select conname as constraint_name
      from pg_constraint
      where conname in (
        'rooms_server_seq_nonnegative_check',
        'room_operations_sequence_positive_check',
        'room_operations_epoch_nonnegative_check'
      )
      order by conname
    `.execute(db);
    expect(constraints.rows.map((row) => row.constraintName)).toEqual([
      "room_operations_epoch_nonnegative_check",
      "room_operations_sequence_positive_check",
      "rooms_server_seq_nonnegative_check",
    ]);
  });

  it("enforces active positions and durable operation identities", async () => {
    const userId = "018f8f8e-4b5c-7d6e-8f90-123456789ae0";
    const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ae1";
    const firstTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ae2";
    const secondTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ae3";
    const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789ae4";
    const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789ae5";
    await db
      .insertInto("users")
      .values({
        id: userId,
        username: "SequencerOwner",
        usernameNormalized: "sequencerowner",
        displayName: "Sequencer Owner",
        passwordHash: "hash",
        status: "ACTIVE",
      })
      .execute();
    await db
      .insertInto("rooms")
      .values({ id: roomId, name: "Sequencer", ownerUserId: userId, deletedAt: null })
      .execute();
    await db
      .insertInto("roomTabs")
      .values({
        roomId,
        logicalTabId: firstTabId,
        url: "https://example.com/first",
        title: null,
        favIconUrl: null,
        position: 0,
        createdAtSeq: 1,
        updatedAtSeq: 1,
        closedAtSeq: null,
      })
      .execute();

    await expect(
      db
        .insertInto("roomTabs")
        .values({
          roomId,
          logicalTabId: secondTabId,
          url: "https://example.com/second",
          title: null,
          favIconUrl: null,
          position: 0,
          createdAtSeq: 2,
          updatedAtSeq: 2,
          closedAtSeq: null,
        })
        .execute(),
    ).rejects.toThrow();

    await db
      .updateTable("roomTabs")
      .set({ closedAtSeq: 2, updatedAtSeq: 2 })
      .where("roomId", "=", roomId)
      .where("logicalTabId", "=", firstTabId)
      .execute();
    await expect(
      db
        .insertInto("roomTabs")
        .values({
          roomId,
          logicalTabId: secondTabId,
          url: "https://example.com/second",
          title: null,
          favIconUrl: null,
          position: 0,
          createdAtSeq: 2,
          updatedAtSeq: 2,
          closedAtSeq: null,
        })
        .execute(),
    ).resolves.toBeDefined();

    const operation = {
      roomId,
      roomEpoch: 0,
      clientOpId,
      deviceId,
      payload: { type: "tab.close", logicalTabId: firstTabId },
    };
    await db
      .insertInto("roomOperations")
      .values({ ...operation, serverSeq: 1 })
      .execute();
    await expect(
      db
        .insertInto("roomOperations")
        .values({ ...operation, serverSeq: 2 })
        .execute(),
    ).rejects.toThrow();

    await expect(
      db.updateTable("rooms").set({ serverSeq: -1 }).where("id", "=", roomId).execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto("roomOperations")
        .values({
          ...operation,
          clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ae6",
          serverSeq: 0,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto("roomOperations")
        .values({
          ...operation,
          clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789ae7",
          roomEpoch: -1,
          serverSeq: 2,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("enforces client-operation idempotency uniqueness", async () => {
    await db
      .insertInto("users")
      .values({
        id: "018f8f8e-4b5c-7d6e-8f90-123456789abc",
        username: "Alex",
        usernameNormalized: "alex",
        displayName: "Alex",
        passwordHash: "hash",
        status: "ACTIVE",
      })
      .execute();
    await db
      .insertInto("rooms")
      .values({
        id: "018f8f8e-4b5c-7d6e-8f90-123456789abd",
        name: "Foundation",
        ownerUserId: "018f8f8e-4b5c-7d6e-8f90-123456789abc",
        deletedAt: null,
      })
      .execute();

    const operation = {
      roomId: "018f8f8e-4b5c-7d6e-8f90-123456789abd",
      deviceId: "018f8f8e-4b5c-7d6e-8f90-123456789abe",
      clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789abf",
      serverSeq: 1,
    };
    await db.insertInto("clientOperations").values(operation).execute();
    await expect(db.insertInto("clientOperations").values(operation).execute()).rejects.toThrow();
  });

  it("stores page-scoped annotation state with camel-case typed reads", async () => {
    const ownerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b10";
    const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789b11";
    const strokeId = "018f8f8e-4b5c-7d6e-8f90-123456789b12";
    const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789b13";
    const pageKey = "A".repeat(43);
    const strokeByteSize = 512;
    const anchor = {
      type: "document",
      layoutSignature: { widthCssPx: 1440, heightCssPx: 5000 },
    };
    const points = [
      { x: 0.1, y: 0.2, pressure: 0.5 },
      { x: 0.2, y: 0.3, pressure: 0.7 },
    ];
    const rgb = { r: 31, g: 140, b: 255 };
    const operation = {
      type: "stroke.create",
      stroke: { strokeId, frameKey: "top", anchor, points, rgb, width: 5 },
    };

    await db
      .insertInto("users")
      .values({
        id: ownerUserId,
        username: "AnnotationOwner",
        usernameNormalized: "annotationowner",
        displayName: "Annotation Owner",
        passwordHash: "hash",
        status: "ACTIVE",
      })
      .execute();
    await db
      .insertInto("rooms")
      .values({ id: roomId, name: "Annotations", ownerUserId, deletedAt: null })
      .execute();
    await db
      .insertInto("annotationPages")
      .values({
        roomId,
        pageKey,
        annotationSeq: 1,
        liveStrokeCount: 1,
        liveStrokeBytes: strokeByteSize,
      })
      .execute();
    await db
      .insertInto("annotationStrokes")
      .values({
        roomId,
        pageKey,
        strokeId,
        authorUserId: ownerUserId,
        frameKey: "top",
        anchor,
        points: JSON.stringify(points),
        rgb,
        width: 5,
        byteSize: strokeByteSize,
        lockedAt: null,
        version: 1,
        deletedAt: null,
      })
      .execute();
    await db
      .insertInto("annotationOperations")
      .values({
        roomId,
        pageKey,
        annotationSeq: 1,
        clientOpId,
        actorUserId: ownerUserId,
        operation,
      })
      .execute();

    const page = await db
      .selectFrom("annotationPages")
      .selectAll()
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .executeTakeFirstOrThrow();
    const storedStroke = await db
      .selectFrom("annotationStrokes")
      .selectAll()
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .where("strokeId", "=", strokeId)
      .executeTakeFirstOrThrow();
    const storedOperation = await db
      .selectFrom("annotationOperations")
      .selectAll()
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .where("annotationSeq", "=", 1)
      .executeTakeFirstOrThrow();

    expect(page).toMatchObject({
      roomId,
      pageKey,
      annotationSeq: 1,
      liveStrokeCount: 1,
      liveStrokeBytes: strokeByteSize,
    });
    expect(storedStroke).toMatchObject({
      strokeId,
      authorUserId: ownerUserId,
      frameKey: "top",
      anchor,
      points,
      rgb,
      width: 5,
      byteSize: strokeByteSize,
      version: 1,
    });
    expect(storedOperation).toMatchObject({
      annotationSeq: 1,
      clientOpId,
      actorUserId: ownerUserId,
      operation,
    });
  });

  it("adds nullable paired annotation signatures without rewriting legacy rows", async () => {
    type AnnotationStrokeRow = Selectable<Database["annotationStrokes"]>;
    expectTypeOf<AnnotationStrokeRow["contentSignature"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AnnotationStrokeRow["signatureVersion"]>().toEqualTypeOf<number | null>();

    const columns = await sql<{
      columnName: string;
      dataType: string;
      characterMaximumLength: number | null;
      isNullable: string;
    }>`
      select
        column_name as column_name,
        data_type as data_type,
        character_maximum_length as character_maximum_length,
        is_nullable as is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'annotation_strokes'
        and column_name in ('content_signature', 'signature_version')
      order by column_name
    `.execute(db);
    expect(columns.rows).toEqual([
      {
        columnName: "content_signature",
        dataType: "character varying",
        characterMaximumLength: 43,
        isNullable: "YES",
      },
      {
        columnName: "signature_version",
        dataType: "smallint",
        characterMaximumLength: null,
        isNullable: "YES",
      },
    ]);

    const constraints = await sql<{ constraintName: string; definition: string }>`
      select
        conname as constraint_name,
        pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in (
        'annotation_strokes_content_signature_pair_check',
        'annotation_strokes_content_signature_format_check',
        'annotation_strokes_signature_version_positive_check'
      )
      order by conname
    `.execute(db);
    expect(constraints.rows.map(({ constraintName }) => constraintName)).toEqual([
      "annotation_strokes_content_signature_format_check",
      "annotation_strokes_content_signature_pair_check",
      "annotation_strokes_signature_version_positive_check",
    ]);
    expect(constraints.rows.map(({ definition }) => definition).join("\n")).toMatch(
      /content_signature.*signature_version/is,
    );
    expect(constraints.rows.map(({ definition }) => definition).join("\n")).toMatch(
      /\^\[A-Za-z0-9_-\]\{43\}\$/u,
    );

    await db.transaction().execute(async (transaction) => {
      const migrationDb = transaction as unknown as Kysely<unknown>;
      await annotationContentSignatures.down(migrationDb);
      const removed = await sql<{ columnName: string }>`
        select column_name as column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'annotation_strokes'
          and column_name in ('content_signature', 'signature_version')
      `.execute(transaction);
      expect(removed.rows).toEqual([]);

      const ownerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b30";
      const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789b31";
      const strokeId = "018f8f8e-4b5c-7d6e-8f90-123456789b32";
      const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789b33";
      const pageKey = "C".repeat(43);
      const anchor = {
        type: "document",
        layoutSignature: { widthCssPx: 1_440, heightCssPx: 5_000 },
      };
      const points = [
        { x: 0.1, y: 0.2, pressure: 0.5 },
        { x: 0.2, y: 0.3, pressure: 0.7 },
      ];
      const rgb = { r: 31, g: 140, b: 255 };
      const operation = {
        type: "stroke.create",
        stroke: { strokeId, frameKey: "top", anchor, points, rgb, width: 5 },
      };

      await transaction
        .insertInto("users")
        .values({
          id: ownerUserId,
          username: "SignatureMigrationOwner",
          usernameNormalized: "signaturemigrationowner",
          displayName: "Signature Migration Owner",
          passwordHash: "hash",
          status: "ACTIVE",
        })
        .execute();
      await transaction
        .insertInto("rooms")
        .values({
          id: roomId,
          name: "Signature Migration",
          ownerUserId,
          deletedAt: null,
        })
        .execute();
      await transaction
        .insertInto("annotationPages")
        .values({
          roomId,
          pageKey,
          annotationSeq: 1,
          liveStrokeCount: 1,
          liveStrokeBytes: 512,
        })
        .execute();
      await transaction
        .insertInto("annotationStrokes")
        .values({
          roomId,
          pageKey,
          strokeId,
          authorUserId: ownerUserId,
          frameKey: "top",
          anchor,
          points: JSON.stringify(points),
          rgb,
          width: 5,
          byteSize: 512,
          lockedAt: null,
          version: 1,
          deletedAt: null,
        })
        .execute();
      await transaction
        .insertInto("annotationOperations")
        .values({
          roomId,
          pageKey,
          annotationSeq: 1,
          clientOpId,
          actorUserId: ownerUserId,
          operation,
        })
        .execute();

      await annotationContentSignatures.up(migrationDb);
      const migrated = await transaction
        .selectFrom("annotationStrokes")
        .selectAll()
        .where("roomId", "=", roomId)
        .where("pageKey", "=", pageKey)
        .where("strokeId", "=", strokeId)
        .executeTakeFirstOrThrow();
      const storedOperation = await transaction
        .selectFrom("annotationOperations")
        .select(["operation"])
        .where("roomId", "=", roomId)
        .where("pageKey", "=", pageKey)
        .where("clientOpId", "=", clientOpId)
        .executeTakeFirstOrThrow();
      expect(migrated).toMatchObject({
        anchor,
        points,
        rgb,
        byteSize: 512,
        contentSignature: null,
        signatureVersion: null,
      });
      expect(storedOperation.operation).toEqual(operation);
    });
  });

  it("creates annotation lookup indexes and database checks", async () => {
    const indexes = await sql<{ indexName: string }>`
      select indexname as index_name
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'annotation_strokes_live_index',
          'annotation_operations_client_operation_unique'
        )
      order by indexname
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexName)).toEqual([
      "annotation_operations_client_operation_unique",
      "annotation_strokes_live_index",
    ]);

    const constraints = await sql<{ constraintName: string }>`
      select conname as constraint_name
      from pg_constraint
      where conname in (
        'annotation_pages_key_check',
        'annotation_pages_sequence_nonnegative_check',
        'annotation_pages_live_count_nonnegative_check',
        'annotation_pages_live_bytes_nonnegative_check',
        'annotation_strokes_page_foreign',
        'annotation_strokes_byte_size_check',
        'annotation_strokes_version_positive_check',
        'annotation_operations_page_foreign',
        'annotation_operations_sequence_positive_check'
      )
      order by conname
    `.execute(db);
    expect(constraints.rows.map((row) => row.constraintName)).toHaveLength(9);
  });

  it("drops and restores annotation storage in dependency order", async () => {
    await db.transaction().execute(async (transaction) => {
      const migrationDb = transaction as unknown as Kysely<unknown>;
      await annotationContentSignatures.down(migrationDb);
      await pageAnnotations.down(migrationDb);

      const afterDown = await sql<{ tableName: string }>`
        select table_name as table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'annotation_pages',
            'annotation_strokes',
            'annotation_operations'
          )
      `.execute(transaction);
      expect(afterDown.rows).toEqual([]);

      await pageAnnotations.up(migrationDb);
      await annotationContentSignatures.up(migrationDb);
      const afterUp = await sql<{ tableName: string }>`
        select table_name as table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'annotation_pages',
            'annotation_strokes',
            'annotation_operations'
          )
        order by table_name
      `.execute(transaction);
      expect(afterUp.rows.map((row) => row.tableName)).toEqual([
        "annotation_operations",
        "annotation_pages",
        "annotation_strokes",
      ]);
    });
  });

  it("enforces annotation dedupe, page sequence, counters, payload size, and page ownership", async () => {
    const ownerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b20";
    const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789b21";
    const pageKey = "B".repeat(43);
    const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789b22";
    const operation = { type: "stroke.delete", items: [] };

    await db
      .insertInto("users")
      .values({
        id: ownerUserId,
        username: "ConstraintOwner",
        usernameNormalized: "constraintowner",
        displayName: "Constraint Owner",
        passwordHash: "hash",
        status: "ACTIVE",
      })
      .execute();
    await db
      .insertInto("rooms")
      .values({ id: roomId, name: "Constraints", ownerUserId, deletedAt: null })
      .execute();
    await db
      .insertInto("annotationPages")
      .values({
        roomId,
        pageKey,
        annotationSeq: 2,
        liveStrokeCount: 0,
        liveStrokeBytes: 0,
      })
      .execute();
    await db
      .insertInto("annotationOperations")
      .values({
        roomId,
        pageKey,
        annotationSeq: 1,
        clientOpId,
        actorUserId: ownerUserId,
        operation,
      })
      .execute();

    await expect(
      db
        .insertInto("annotationOperations")
        .values({
          roomId,
          pageKey,
          annotationSeq: 2,
          clientOpId,
          actorUserId: ownerUserId,
          operation,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto("annotationOperations")
        .values({
          roomId,
          pageKey,
          annotationSeq: 1,
          clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789b23",
          actorUserId: ownerUserId,
          operation,
        })
        .execute(),
    ).rejects.toThrow();

    for (const invalidCounters of [
      { liveStrokeCount: -1, liveStrokeBytes: 0 },
      { liveStrokeCount: 0, liveStrokeBytes: -1 },
    ]) {
      await expect(
        db
          .insertInto("annotationPages")
          .values({
            roomId,
            pageKey: "C".repeat(42) + (invalidCounters.liveStrokeCount < 0 ? "1" : "2"),
            annotationSeq: 0,
            ...invalidCounters,
          })
          .execute(),
      ).rejects.toThrow();
    }

    const missingPageKey = "D".repeat(43);
    const baseStroke = {
      roomId,
      pageKey: missingPageKey,
      authorUserId: ownerUserId,
      frameKey: "top",
      anchor: { type: "document", layoutSignature: { widthCssPx: 100, heightCssPx: 200 } },
      points: JSON.stringify([{ x: 0.1, y: 0.2, pressure: 0.5 }]),
      rgb: { r: 0, g: 0, b: 0 },
      width: 1,
      lockedAt: null,
      version: 1,
      deletedAt: null,
    };
    await expect(
      db
        .insertInto("annotationStrokes")
        .values({
          ...baseStroke,
          strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789b24",
          byteSize: 1,
        })
        .execute(),
    ).rejects.toThrow();

    await db
      .insertInto("annotationPages")
      .values({
        roomId,
        pageKey: missingPageKey,
        annotationSeq: 0,
        liveStrokeCount: 0,
        liveStrokeBytes: 0,
      })
      .execute();
    for (const [index, byteSize] of [0, 65_537].entries()) {
      await expect(
        db
          .insertInto("annotationStrokes")
          .values({
            ...baseStroke,
            strokeId:
              index === 0
                ? "018f8f8e-4b5c-7d6e-8f90-123456789b25"
                : "018f8f8e-4b5c-7d6e-8f90-123456789b26",
            byteSize,
          })
          .execute(),
      ).rejects.toThrow();
    }
  });

  it("cascades annotation rows with a room while retaining author identity restrictions", async () => {
    const ownerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b30";
    const authorUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b31";
    const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789b32";
    const pageKey = "E".repeat(43);

    await db
      .insertInto("users")
      .values([
        {
          id: ownerUserId,
          username: "CascadeOwner",
          usernameNormalized: "cascadeowner",
          displayName: "Cascade Owner",
          passwordHash: "hash",
          status: "ACTIVE",
        },
        {
          id: authorUserId,
          username: "CascadeAuthor",
          usernameNormalized: "cascadeauthor",
          displayName: "Cascade Author",
          passwordHash: "hash",
          status: "ACTIVE",
        },
      ])
      .execute();
    await db
      .insertInto("rooms")
      .values({ id: roomId, name: "Cascade", ownerUserId, deletedAt: null })
      .execute();
    await db
      .insertInto("annotationPages")
      .values({
        roomId,
        pageKey,
        annotationSeq: 1,
        liveStrokeCount: 1,
        liveStrokeBytes: 128,
      })
      .execute();
    await db
      .insertInto("annotationStrokes")
      .values({
        roomId,
        pageKey,
        strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789b33",
        authorUserId,
        frameKey: "top",
        anchor: { type: "document", layoutSignature: { widthCssPx: 100, heightCssPx: 200 } },
        points: JSON.stringify([{ x: 0.1, y: 0.2, pressure: 0.5 }]),
        rgb: { r: 0, g: 0, b: 0 },
        width: 1,
        byteSize: 128,
        lockedAt: null,
        version: 1,
        deletedAt: null,
      })
      .execute();
    await db
      .insertInto("annotationOperations")
      .values({
        roomId,
        pageKey,
        annotationSeq: 1,
        clientOpId: "018f8f8e-4b5c-7d6e-8f90-123456789b34",
        actorUserId: authorUserId,
        operation: { type: "stroke.create" },
      })
      .execute();

    await expect(db.deleteFrom("users").where("id", "=", authorUserId).execute()).rejects.toThrow();

    await db.deleteFrom("rooms").where("id", "=", roomId).execute();
    await expect(
      db.selectFrom("annotationPages").selectAll().where("roomId", "=", roomId).execute(),
    ).resolves.toEqual([]);
    await expect(
      db.selectFrom("annotationStrokes").selectAll().where("roomId", "=", roomId).execute(),
    ).resolves.toEqual([]);
    await expect(
      db.selectFrom("annotationOperations").selectAll().where("roomId", "=", roomId).execute(),
    ).resolves.toEqual([]);
    await expect(
      db.deleteFrom("users").where("id", "=", authorUserId).execute(),
    ).resolves.toBeDefined();
  });

  it("creates collaboration defaults, metadata, storage, indexes, and constraints", async () => {
    type RoomRow = Selectable<Database["rooms"]>;
    type ServerMetadataRow = Selectable<Database["serverMetadata"]>;

    expectTypeOf<RoomRow["visibility"]>().toEqualTypeOf<"PRIVATE" | "PUBLIC">();
    expectTypeOf<RoomRow["joinPolicy"]>().toEqualTypeOf<"OPEN" | "APPROVAL" | "INVITE_ONLY">();
    expectTypeOf<RoomRow["roomRevision"]>().toEqualTypeOf<number>();
    expectTypeOf<ServerMetadataRow["id"]>().toEqualTypeOf<"GLOBAL">();

    const ownerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b40";
    const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789b41";
    await db
      .insertInto("users")
      .values({
        id: ownerUserId,
        username: "ProductOwner",
        usernameNormalized: "productowner",
        displayName: "Product Owner",
        passwordHash: "hash",
        status: "ACTIVE",
      })
      .execute();

    const room = await db
      .insertInto("rooms")
      .values({
        id: roomId,
        name: "Existing room",
        ownerUserId,
        deletedAt: null,
      })
      .returning(["visibility", "joinPolicy", "roomRevision"])
      .executeTakeFirstOrThrow();
    expect(room).toEqual({
      visibility: "PRIVATE",
      joinPolicy: "INVITE_ONLY",
      roomRevision: 0,
    });

    const metadata = await db.selectFrom("serverMetadata").selectAll().executeTakeFirstOrThrow();
    expect(metadata).toMatchObject({
      id: "GLOBAL",
      displayName: "SyncAction",
      protocolVersion: 1,
      termsVersion: "2026-07-30",
    });
    expect(metadata.serverId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    await expect(
      sql`
        insert into server_metadata (
          id,
          server_id,
          display_name,
          protocol_version,
          terms_version
        ) values (
          'OTHER',
          '018f8f8e-4b5c-7d6e-8f90-123456789b42',
          'Other',
          1,
          '2026-07-30'
        )
      `.execute(db),
    ).rejects.toThrow(/server_metadata_global_id_check/u);

    const tables = await sql<{ tableName: string }>`
      select table_name as table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'server_metadata',
          'room_join_requests',
          'notifications',
          'policy_acceptances'
        )
      order by table_name
    `.execute(db);
    expect(tables.rows.map((row) => row.tableName)).toEqual([
      "notifications",
      "policy_acceptances",
      "room_join_requests",
      "server_metadata",
    ]);

    const indexes = await sql<{ indexName: string }>`
      select indexname as index_name
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'room_join_requests_single_pending_index',
          'room_join_requests_owner_queue_index',
          'room_join_requests_decision_client_op_index',
          'notifications_recipient_cursor_index',
          'notifications_recipient_unread_index'
        )
      order by indexname
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexName)).toEqual([
      "notifications_recipient_cursor_index",
      "notifications_recipient_unread_index",
      "room_join_requests_decision_client_op_index",
      "room_join_requests_owner_queue_index",
      "room_join_requests_single_pending_index",
    ]);

    const constraints = await sql<{ constraintName: string }>`
      select conname as constraint_name
      from pg_constraint
      where conname in (
        'rooms_visibility_check',
        'rooms_join_policy_check',
        'rooms_room_revision_nonnegative_check',
        'server_metadata_global_id_check',
        'server_metadata_protocol_version_positive_check',
        'room_join_requests_status_check'
      )
      order by conname
    `.execute(db);
    expect(constraints.rows.map((row) => row.constraintName)).toEqual([
      "room_join_requests_status_check",
      "rooms_join_policy_check",
      "rooms_room_revision_nonnegative_check",
      "rooms_visibility_check",
      "server_metadata_global_id_check",
      "server_metadata_protocol_version_positive_check",
    ]);
  });

  it("removes and restores collaboration storage transactionally", async () => {
    await db.transaction().execute(async (transaction) => {
      const migrationDb = transaction as unknown as Kysely<unknown>;
      await productCollaboration.down(migrationDb);

      const tablesAfterDown = await sql<{ tableName: string }>`
        select table_name as table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'server_metadata',
            'room_join_requests',
            'notifications',
            'policy_acceptances'
          )
      `.execute(transaction);
      expect(tablesAfterDown.rows).toEqual([]);

      const roomColumnsAfterDown = await sql<{ columnName: string }>`
        select column_name as column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'rooms'
          and column_name in ('visibility', 'join_policy', 'room_revision')
      `.execute(transaction);
      expect(roomColumnsAfterDown.rows).toEqual([]);

      const legacyOwnerUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b50";
      const legacyRoomId = "018f8f8e-4b5c-7d6e-8f90-123456789b51";
      await transaction
        .insertInto("users")
        .values({
          id: legacyOwnerUserId,
          username: "LegacyProductOwner",
          usernameNormalized: "legacyproductowner",
          displayName: "Legacy Product Owner",
          passwordHash: "hash",
          status: "ACTIVE",
        })
        .execute();
      await transaction
        .insertInto("rooms")
        .values({
          id: legacyRoomId,
          name: "Pre-vNext room",
          ownerUserId: legacyOwnerUserId,
          deletedAt: null,
        })
        .execute();

      await productCollaboration.up(migrationDb);

      const tablesAfterUp = await sql<{ tableName: string }>`
        select table_name as table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'server_metadata',
            'room_join_requests',
            'notifications',
            'policy_acceptances'
          )
        order by table_name
      `.execute(transaction);
      expect(tablesAfterUp.rows.map((row) => row.tableName)).toEqual([
        "notifications",
        "policy_acceptances",
        "room_join_requests",
        "server_metadata",
      ]);

      const roomColumnsAfterUp = await sql<{ columnName: string }>`
        select column_name as column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'rooms'
          and column_name in ('visibility', 'join_policy', 'room_revision')
        order by column_name
      `.execute(transaction);
      expect(roomColumnsAfterUp.rows.map((row) => row.columnName)).toEqual([
        "join_policy",
        "room_revision",
        "visibility",
      ]);

      await expect(
        transaction
          .selectFrom("rooms")
          .select(["visibility", "joinPolicy", "roomRevision"])
          .where("id", "=", legacyRoomId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        visibility: "PRIVATE",
        joinPolicy: "INVITE_ONLY",
        roomRevision: 0,
      });
      await transaction.deleteFrom("rooms").where("id", "=", legacyRoomId).execute();
      await transaction.deleteFrom("users").where("id", "=", legacyOwnerUserId).execute();
    });
  });
});
