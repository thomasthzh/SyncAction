import { randomUUID, timingSafeEqual } from "node:crypto";
import type { createDatabase } from "@syncaction/database";
import { z } from "zod";
import type { AccountSession, AccountService } from "./account-service.js";
import { IdentityError } from "./errors.js";
import { hashPassword } from "./passwords.js";
import { parseDeviceId, parseDisplayName, parsePassword, parseUsername } from "./policy.js";
import { createOpaqueToken, hashOpaqueToken } from "./tokens.js";

type IdentityDatabase = ReturnType<typeof createDatabase>;
type ActivationGrantStatus = "ACTIVE" | "CLAIMED" | "USED" | "REVOKED" | "EXPIRED";

export interface AccountActivationGrantServiceOptions {
  db: IdentityDatabase;
  now?: () => Date;
}

export interface AccountActivationServiceOptions extends AccountActivationGrantServiceOptions {
  accounts: AccountService;
}

export interface RedactedActivationGrant {
  id: string;
  note: string;
  keyTail: string;
  status: ActivationGrantStatus;
  account: { id: string; username: string; displayName: string } | null;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface IssueActivationGrantInput {
  administratorId: string;
  note: unknown;
}

export interface RevokeActivationGrantInput {
  administratorId: string;
  grantId: unknown;
}

export interface ActivateAccountInput {
  activationKey: unknown;
  username: unknown;
  displayName: unknown;
  password: unknown;
  deviceId: unknown;
}

export interface LoginWithAccountKeyInput {
  activationKey: unknown;
  deviceId: unknown;
}

interface DatabaseError {
  code?: unknown;
  constraint?: unknown;
}

const uuidSchema = z.uuid();

function parseNote(value: unknown): string {
  if (typeof value !== "string") {
    throw new IdentityError("INVALID_INPUT");
  }
  const note = value.trim().replace(/\s+/gu, " ");
  if (Array.from(note).length < 1 || Array.from(note).length > 120) {
    throw new IdentityError("INVALID_INPUT");
  }
  return note;
}

function parseGrantId(value: unknown): string {
  const result = uuidSchema.safeParse(value);
  if (!result.success) {
    throw new IdentityError("INVALID_INPUT", { cause: result.error });
  }
  return result.data;
}

function parseActivationKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new IdentityError("ACTIVATION_KEY_INVALID");
  }
  const key = value.trim();
  if (!/^sak_[A-Za-z0-9_-]{43}$/u.test(key)) {
    throw new IdentityError("ACTIVATION_KEY_INVALID");
  }
  return key;
}

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function isUsernameConflict(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  const error = cause as DatabaseError;
  return (
    error.code === "23505" &&
    (error.constraint === "users_username_normalized_key" ||
      error.constraint === "users_username_normalized_unique")
  );
}

function deriveStatus(
  grant: {
    usedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
    passwordResetRequired: boolean | null;
  },
  now: Date,
): ActivationGrantStatus {
  if (grant.revokedAt !== null) {
    return "REVOKED";
  }
  if (grant.expiresAt.getTime() <= now.getTime()) {
    return "EXPIRED";
  }
  if (grant.usedAt === null) {
    return "ACTIVE";
  }
  return grant.passwordResetRequired === true ? "CLAIMED" : "USED";
}

function provisionalUsername(userId: string): string {
  const value = BigInt(`0x${userId.replaceAll("-", "")}`)
    .toString(36)
    .padStart(25, "0");
  return `s${value}`;
}

function redactGrant(
  row: {
    id: string;
    note: string;
    tokenTail: string;
    expiresAt: Date;
    usedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    userId: string | null;
    username: string | null;
    displayName: string | null;
    passwordResetRequired: boolean | null;
  },
  now: Date,
): RedactedActivationGrant {
  return {
    id: row.id,
    note: row.note,
    keyTail: row.tokenTail,
    status: deriveStatus(row, now),
    account:
      row.userId === null
        ? null
        : {
            id: row.userId,
            username: row.username ?? "",
            displayName: row.displayName ?? "",
          },
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export class AccountActivationGrantService {
  protected readonly db: IdentityDatabase;
  protected readonly now: () => Date;

  public constructor(options: AccountActivationGrantServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  public async issue(
    input: IssueActivationGrantInput,
  ): Promise<{ grant: RedactedActivationGrant; activationKey: string }> {
    const note = parseNote(input.note);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
    const activationKey = `sak_${createOpaqueToken()}`;
    const tokenTail = activationKey.slice(-8);
    const id = randomUUID();
    const row = await this.db.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto("accountActivationGrants")
        .values({
          id,
          note,
          tokenHash: hashOpaqueToken(activationKey),
          tokenTail,
          issuedByAdministratorId: input.administratorId,
          userId: null,
          expiresAt,
          usedAt: null,
          revokedAt: null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning([
          "id",
          "note",
          "tokenTail",
          "expiresAt",
          "usedAt",
          "revokedAt",
          "createdAt",
          "userId",
        ])
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: input.administratorId,
          eventType: "account_activation_grant.issued",
          targetType: "account_activation_grant",
          targetId: id,
          details: { note, keyTail: tokenTail },
          createdAt,
        })
        .execute();
      return inserted;
    });

    return {
      activationKey,
      grant: redactGrant(
        { ...row, username: null, displayName: null, passwordResetRequired: null },
        createdAt,
      ),
    };
  }

  public async list(): Promise<RedactedActivationGrant[]> {
    const now = this.now();
    const rows = await this.db
      .selectFrom("accountActivationGrants")
      .leftJoin("users", "users.id", "accountActivationGrants.userId")
      .select([
        "accountActivationGrants.id",
        "accountActivationGrants.note",
        "accountActivationGrants.tokenTail",
        "accountActivationGrants.expiresAt",
        "accountActivationGrants.usedAt",
        "accountActivationGrants.revokedAt",
        "accountActivationGrants.createdAt",
        "accountActivationGrants.userId",
        "users.username",
        "users.displayName",
        "users.passwordResetRequired",
      ])
      .orderBy("accountActivationGrants.createdAt", "desc")
      .execute();
    return rows.map((row) => redactGrant(row, now));
  }

  public async revoke(input: RevokeActivationGrantInput): Promise<RedactedActivationGrant> {
    const grantId = parseGrantId(input.grantId);
    const revokedAt = this.now();
    const row = await this.db.transaction().execute(async (transaction) => {
      const grant = await transaction
        .selectFrom("accountActivationGrants")
        .leftJoin("users", "users.id", "accountActivationGrants.userId")
        .select([
          "accountActivationGrants.id",
          "accountActivationGrants.note",
          "accountActivationGrants.tokenTail",
          "accountActivationGrants.expiresAt",
          "accountActivationGrants.usedAt",
          "accountActivationGrants.revokedAt",
          "accountActivationGrants.createdAt",
          "accountActivationGrants.userId",
          "users.username",
          "users.displayName",
          "users.passwordResetRequired",
        ])
        .where("accountActivationGrants.id", "=", grantId)
        .forUpdate("accountActivationGrants")
        .executeTakeFirst();
      if (grant === undefined) {
        throw new IdentityError("ACTIVATION_GRANT_NOT_FOUND");
      }
      const status = deriveStatus(grant, revokedAt);
      if (status !== "ACTIVE" && status !== "CLAIMED") {
        throw new IdentityError("ACTIVATION_GRANT_NOT_ACTIVE");
      }
      const updated = await transaction
        .updateTable("accountActivationGrants")
        .set({ revokedAt, updatedAt: revokedAt })
        .where("id", "=", grant.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: input.administratorId,
          eventType: "account_activation_grant.revoked",
          targetType: "account_activation_grant",
          targetId: grant.id,
          details: { note: grant.note, keyTail: grant.tokenTail },
          createdAt: revokedAt,
        })
        .execute();
      return {
        ...updated,
        username: grant.username,
        displayName: grant.displayName,
        passwordResetRequired: grant.passwordResetRequired,
      };
    });

    return redactGrant(row, revokedAt);
  }
}

export class AccountActivationService extends AccountActivationGrantService {
  readonly #accounts: AccountService;

  public constructor(options: AccountActivationServiceOptions) {
    super(options);
    this.#accounts = options.accounts;
  }

  public async loginWithKey(input: LoginWithAccountKeyInput): Promise<AccountSession> {
    const activationKey = parseActivationKey(input.activationKey);
    const deviceId = parseDeviceId(input.deviceId);
    const passwordHash = await hashPassword(createOpaqueToken());
    const loggedInAt = this.now();

    try {
      return await this.db.transaction().execute(async (transaction) => {
        const presentedHash = hashOpaqueToken(activationKey);
        const candidates = await transaction
          .selectFrom("accountActivationGrants")
          .selectAll()
          .where("tokenTail", "=", activationKey.slice(-8))
          .forUpdate()
          .execute();
        const grant = candidates.find((candidate) =>
          hashesEqual(candidate.tokenHash, presentedHash),
        );
        if (grant === undefined) {
          throw new IdentityError("ACTIVATION_KEY_INVALID");
        }
        if (grant.revokedAt !== null) {
          throw new IdentityError("ACTIVATION_KEY_REVOKED");
        }
        if (grant.expiresAt.getTime() <= loggedInAt.getTime()) {
          throw new IdentityError("ACTIVATION_KEY_EXPIRED");
        }

        let userId = grant.userId;
        if (userId === null) {
          userId = randomUUID();
          const username = provisionalUsername(userId);
          await transaction
            .insertInto("users")
            .values({
              id: userId,
              username,
              usernameNormalized: username,
              displayName: "未命名用户",
              passwordHash,
              status: "ACTIVE",
              passwordResetRequired: true,
              createdAt: loggedInAt,
              updatedAt: loggedInAt,
            })
            .execute();
          await transaction
            .updateTable("accountActivationGrants")
            .set({ userId, usedAt: loggedInAt, updatedAt: loggedInAt })
            .where("id", "=", grant.id)
            .execute();
          await transaction
            .insertInto("auditEvents")
            .values({
              actorUserId: userId,
              actorAdministratorId: null,
              eventType: "account_activation_grant.claimed",
              targetType: "account_activation_grant",
              targetId: grant.id,
              details: { note: grant.note, keyTail: grant.tokenTail },
              createdAt: loggedInAt,
            })
            .execute();
        } else {
          const user = await transaction
            .selectFrom("users")
            .select("passwordResetRequired")
            .where("id", "=", userId)
            .executeTakeFirst();
          if (user === undefined || !user.passwordResetRequired) {
            throw new IdentityError("ACTIVATION_KEY_USED");
          }
        }

        return this.#accounts.establishSessionForUserId(userId, deviceId, transaction);
      });
    } catch (cause) {
      if (isUsernameConflict(cause)) {
        throw new IdentityError("USERNAME_TAKEN", { cause });
      }
      throw cause;
    }
  }

  public async activate(input: ActivateAccountInput): Promise<AccountSession> {
    const activationKey = parseActivationKey(input.activationKey);
    const { username, usernameNormalized } = parseUsername(input.username);
    const displayName = parseDisplayName(input.displayName);
    const password = parsePassword(input.password);
    const deviceId = parseDeviceId(input.deviceId);
    const passwordHash = await hashPassword(password);
    const activatedAt = this.now();
    const userId = randomUUID();

    try {
      return await this.db.transaction().execute(async (transaction) => {
        const presentedHash = hashOpaqueToken(activationKey);
        const candidates = await transaction
          .selectFrom("accountActivationGrants")
          .selectAll()
          .where("tokenTail", "=", activationKey.slice(-8))
          .forUpdate()
          .execute();
        const grant = candidates.find((candidate) =>
          hashesEqual(candidate.tokenHash, presentedHash),
        );
        if (grant === undefined) {
          throw new IdentityError("ACTIVATION_KEY_INVALID");
        }
        if (grant.usedAt !== null) {
          throw new IdentityError("ACTIVATION_KEY_USED");
        }
        if (grant.revokedAt !== null) {
          throw new IdentityError("ACTIVATION_KEY_REVOKED");
        }
        if (grant.expiresAt.getTime() <= activatedAt.getTime()) {
          throw new IdentityError("ACTIVATION_KEY_EXPIRED");
        }

        await transaction
          .insertInto("users")
          .values({
            id: userId,
            username,
            usernameNormalized,
            displayName,
            passwordHash,
            status: "ACTIVE",
            passwordResetRequired: false,
            createdAt: activatedAt,
            updatedAt: activatedAt,
          })
          .execute();
        await transaction
          .updateTable("accountActivationGrants")
          .set({ userId, usedAt: activatedAt, updatedAt: activatedAt })
          .where("id", "=", grant.id)
          .execute();
        await transaction
          .insertInto("auditEvents")
          .values({
            actorUserId: userId,
            actorAdministratorId: null,
            eventType: "account_activation_grant.redeemed",
            targetType: "account_activation_grant",
            targetId: grant.id,
            details: { note: grant.note, keyTail: grant.tokenTail },
            createdAt: activatedAt,
          })
          .execute();
        return this.#accounts.establishSessionForUserId(userId, deviceId, transaction);
      });
    } catch (cause) {
      if (isUsernameConflict(cause)) {
        throw new IdentityError("USERNAME_TAKEN", { cause });
      }
      throw cause;
    }
  }
}
