import { randomUUID } from "node:crypto";
import type { createDatabase, Database, User } from "@syncaction/database";
import type { Transaction } from "kysely";
import type { AccessTokenCodec } from "./tokens.js";
import { IdentityError } from "./errors.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { parseDeviceId, parseDisplayName, parsePassword, parseUsername } from "./policy.js";
import { createOpaqueToken, hashOpaqueToken } from "./tokens.js";

type IdentityDatabase = ReturnType<typeof createDatabase>;

export interface AccountServiceOptions {
  db: IdentityDatabase;
  accessTokens: AccessTokenCodec;
  now?: () => Date;
}

export interface RegisterAccountInput {
  username: unknown;
  displayName: unknown;
  password: unknown;
}

export interface PublicAccount {
  id: string;
  username: string;
  displayName: string;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  passwordResetRequired: boolean;
  createdAt: Date;
}

export interface LoginInput {
  username: unknown;
  password: unknown;
  deviceId: unknown;
}

export interface AccountSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: 900;
  refreshExpiresInSeconds: 2_592_000;
  account: PublicAccount;
}

export interface RefreshInput {
  refreshToken: unknown;
}

export interface AuthenticatedPrincipal {
  userId: string;
  deviceId: string;
  sessionId: string;
  account: PublicAccount;
}

export interface CompletePasswordResetInput {
  resetToken: unknown;
  newPassword: unknown;
}

export interface UpdateProfileInput {
  userId: string;
  username: unknown;
  displayName: unknown;
}

export interface ChangePasswordInput {
  userId: string;
  sessionId: string;
  currentPassword: unknown;
  newPassword: unknown;
}

export interface InitializePasswordInput {
  userId: string;
  sessionId: string;
  newPassword: unknown;
}

interface DatabaseError {
  code?: unknown;
  constraint?: unknown;
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

function accountStatusError(
  status: "PENDING" | "SUSPENDED" | "REVOKED",
): "ACCOUNT_PENDING" | "ACCOUNT_SUSPENDED" | "ACCOUNT_REVOKED" {
  const errorByStatus = {
    PENDING: "ACCOUNT_PENDING",
    SUSPENDED: "ACCOUNT_SUSPENDED",
    REVOKED: "ACCOUNT_REVOKED",
  } as const;
  return errorByStatus[status];
}

export class AccountService {
  readonly #db: IdentityDatabase;
  readonly #accessTokens: AccessTokenCodec;
  readonly #now: () => Date;
  readonly #dummyPasswordHash: Promise<string>;

  public constructor(options: AccountServiceOptions) {
    this.#db = options.db;
    this.#accessTokens = options.accessTokens;
    this.#now = options.now ?? (() => new Date());
    this.#dummyPasswordHash = hashPassword(randomUUID());
  }

  public async register(input: RegisterAccountInput): Promise<PublicAccount> {
    const { username, usernameNormalized } = parseUsername(input.username);
    const displayName = parseDisplayName(input.displayName);
    const password = parsePassword(input.password);
    const passwordHash = await hashPassword(password);
    const id = randomUUID();

    try {
      const user = await this.#db
        .insertInto("users")
        .values({
          id,
          username,
          usernameNormalized,
          displayName,
          passwordHash,
          status: "PENDING",
        })
        .returning([
          "id",
          "username",
          "displayName",
          "status",
          "passwordResetRequired",
          "createdAt",
        ])
        .executeTakeFirstOrThrow();
      return user;
    } catch (cause) {
      if (isUsernameConflict(cause)) {
        throw new IdentityError("USERNAME_TAKEN", { cause });
      }
      throw cause;
    }
  }

  public async login(input: LoginInput): Promise<AccountSession> {
    const { usernameNormalized } = parseUsername(input.username);
    const password = parsePassword(input.password);
    const deviceId = parseDeviceId(input.deviceId);
    return this.#db.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .selectAll()
        .where("usernameNormalized", "=", usernameNormalized)
        .forUpdate()
        .executeTakeFirst();
      const passwordHash = user?.passwordHash ?? (await this.#dummyPasswordHash);
      const passwordMatches = await verifyPassword(passwordHash, password);
      if (user === undefined || !passwordMatches) {
        throw new IdentityError("INVALID_CREDENTIALS");
      }
      if (user.status !== "ACTIVE") {
        throw new IdentityError(accountStatusError(user.status));
      }
      return this.#establishSession(user, deviceId, transaction);
    });
  }

  public async establishSessionForUserId(
    userId: string,
    rawDeviceId: unknown,
    transaction?: Transaction<Database>,
  ): Promise<AccountSession> {
    const deviceId = parseDeviceId(rawDeviceId);
    const executor = transaction ?? this.#db;
    const user = await executor
      .selectFrom("users")
      .selectAll()
      .where("id", "=", userId)
      .executeTakeFirst();
    if (user === undefined) {
      throw new IdentityError("SESSION_INVALID");
    }
    if (user.status !== "ACTIVE") {
      throw new IdentityError(accountStatusError(user.status));
    }

    return this.#establishSession(user, deviceId, transaction);
  }

  async #establishSession(
    user: User,
    deviceId: string,
    existingTransaction?: Transaction<Database>,
  ): Promise<AccountSession> {
    const sessionId = randomUUID();
    const tokenFamilyId = randomUUID();
    const refreshToken = createOpaqueToken();
    const issuedAt = this.#now();
    const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1_000);
    const accessToken = await this.#accessTokens.sign({
      userId: user.id,
      deviceId,
      sessionId,
    });

    const persist = async (transaction: Transaction<Database>): Promise<void> => {
      await transaction
        .updateTable("deviceSessions")
        .set({
          revokedAt: issuedAt,
          updatedAt: issuedAt,
        })
        .where("userId", "=", user.id)
        .where("deviceId", "=", deviceId)
        .where("revokedAt", "is", null)
        .execute();
      await transaction
        .insertInto("deviceSessions")
        .values({
          id: sessionId,
          userId: user.id,
          deviceId,
          refreshTokenHash: hashOpaqueToken(refreshToken),
          tokenFamilyId,
          generation: 0,
          expiresAt,
          usedAt: null,
          revokedAt: null,
          replacedBySessionId: null,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        })
        .execute();
    };
    if (existingTransaction === undefined) {
      await this.#db.transaction().execute(persist);
    } else {
      await persist(existingTransaction);
    }

    return {
      sessionId,
      accessToken,
      refreshToken,
      expiresInSeconds: 900,
      refreshExpiresInSeconds: 2_592_000,
      account: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        status: user.status,
        passwordResetRequired: user.passwordResetRequired,
        createdAt: user.createdAt,
      },
    };
  }

  public async updateProfile(input: UpdateProfileInput): Promise<PublicAccount> {
    const { username, usernameNormalized } = parseUsername(input.username);
    const displayName = parseDisplayName(input.displayName);
    const updatedAt = this.#now();
    try {
      return await this.#db.transaction().execute(async (transaction) => {
        const user = await transaction
          .updateTable("users")
          .set({ username, usernameNormalized, displayName, updatedAt })
          .where("id", "=", input.userId)
          .returning([
            "id",
            "username",
            "displayName",
            "status",
            "passwordResetRequired",
            "createdAt",
          ])
          .executeTakeFirst();
        if (user === undefined) {
          throw new IdentityError("SESSION_INVALID");
        }
        await transaction
          .insertInto("auditEvents")
          .values({
            actorUserId: user.id,
            actorAdministratorId: null,
            eventType: "user.profile.updated",
            targetType: "user",
            targetId: user.id,
            details: { username: user.username, displayName: user.displayName },
            createdAt: updatedAt,
          })
          .execute();
        return user;
      });
    } catch (cause) {
      if (isUsernameConflict(cause)) {
        throw new IdentityError("USERNAME_TAKEN", { cause });
      }
      throw cause;
    }
  }

  public async initializePassword(input: InitializePasswordInput): Promise<void> {
    const newPassword = parsePassword(input.newPassword);
    const passwordHash = await hashPassword(newPassword);
    const changedAt = this.#now();

    await this.#db.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .select(["id", "status", "passwordResetRequired"])
        .where("id", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined) {
        throw new IdentityError("SESSION_INVALID");
      }
      if (user.status !== "ACTIVE") {
        throw new IdentityError(accountStatusError(user.status));
      }
      if (!user.passwordResetRequired) {
        throw new IdentityError("PASSWORD_ALREADY_CONFIGURED");
      }
      const session = await transaction
        .selectFrom("deviceSessions")
        .select(["tokenFamilyId", "revokedAt", "expiresAt"])
        .where("id", "=", input.sessionId)
        .where("userId", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (
        session === undefined ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= changedAt.getTime()
      ) {
        throw new IdentityError("SESSION_INVALID");
      }

      await transaction
        .updateTable("users")
        .set({ passwordHash, passwordResetRequired: false, updatedAt: changedAt })
        .where("id", "=", user.id)
        .execute();
      await transaction
        .updateTable("deviceSessions")
        .set({ revokedAt: changedAt, updatedAt: changedAt })
        .where("userId", "=", user.id)
        .where("tokenFamilyId", "!=", session.tokenFamilyId)
        .where("revokedAt", "is", null)
        .execute();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: user.id,
          actorAdministratorId: null,
          eventType: "user.password.initialized",
          targetType: "user",
          targetId: user.id,
          details: { otherSessionFamiliesRevoked: true },
          createdAt: changedAt,
        })
        .execute();
    });
  }

  public async changePassword(input: ChangePasswordInput): Promise<void> {
    const currentPassword = parsePassword(input.currentPassword);
    const newPassword = parsePassword(input.newPassword);
    const changedAt = this.#now();

    await this.#db.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .select(["id", "passwordHash", "status"])
        .where("id", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined) {
        throw new IdentityError("SESSION_INVALID");
      }
      if (user.status !== "ACTIVE") {
        throw new IdentityError(accountStatusError(user.status));
      }
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        throw new IdentityError("CURRENT_PASSWORD_INVALID");
      }
      const session = await transaction
        .selectFrom("deviceSessions")
        .select(["tokenFamilyId", "revokedAt", "expiresAt"])
        .where("id", "=", input.sessionId)
        .where("userId", "=", input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (
        session === undefined ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= changedAt.getTime()
      ) {
        throw new IdentityError("SESSION_INVALID");
      }
      const passwordHash = await hashPassword(newPassword);

      await transaction
        .updateTable("users")
        .set({ passwordHash, passwordResetRequired: false, updatedAt: changedAt })
        .where("id", "=", user.id)
        .execute();
      await transaction
        .updateTable("deviceSessions")
        .set({ revokedAt: changedAt, updatedAt: changedAt })
        .where("userId", "=", user.id)
        .where("tokenFamilyId", "!=", session.tokenFamilyId)
        .where("revokedAt", "is", null)
        .execute();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: user.id,
          actorAdministratorId: null,
          eventType: "user.password.changed",
          targetType: "user",
          targetId: user.id,
          details: { otherSessionFamiliesRevoked: true },
          createdAt: changedAt,
        })
        .execute();
    });
  }

  public async refresh(input: RefreshInput): Promise<AccountSession> {
    if (
      typeof input.refreshToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.refreshToken)
    ) {
      throw new IdentityError("SESSION_INVALID");
    }

    const issuedAt = this.#now();
    const successorId = randomUUID();
    const successorToken = createOpaqueToken();
    const successorHash = hashOpaqueToken(successorToken);
    const presentedHash = hashOpaqueToken(input.refreshToken);
    const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1_000);

    const candidate = await this.#db
      .selectFrom("deviceSessions")
      .select(["id", "userId"])
      .where("refreshTokenHash", "=", presentedHash)
      .executeTakeFirst();
    if (candidate === undefined) {
      throw new IdentityError("SESSION_INVALID");
    }

    const outcome = await this.#db.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .selectAll()
        .where("id", "=", candidate.userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined) {
        return { kind: "invalid" } as const;
      }
      const predecessor = await transaction
        .selectFrom("deviceSessions")
        .selectAll()
        .where("id", "=", candidate.id)
        .where("refreshTokenHash", "=", presentedHash)
        .forUpdate()
        .executeTakeFirst();
      if (predecessor === undefined) {
        return { kind: "invalid" } as const;
      }
      if (predecessor.usedAt !== null) {
        await transaction
          .updateTable("deviceSessions")
          .set({ revokedAt: issuedAt, updatedAt: issuedAt })
          .where("tokenFamilyId", "=", predecessor.tokenFamilyId)
          .where("revokedAt", "is", null)
          .execute();
        return { kind: "replayed" } as const;
      }
      if (predecessor.revokedAt !== null || predecessor.expiresAt.getTime() <= issuedAt.getTime()) {
        return { kind: "invalid" } as const;
      }

      if (user.status !== "ACTIVE") {
        return {
          kind: "account-status",
          code: accountStatusError(user.status),
        } as const;
      }

      await transaction
        .insertInto("deviceSessions")
        .values({
          id: successorId,
          userId: predecessor.userId,
          deviceId: predecessor.deviceId,
          refreshTokenHash: successorHash,
          tokenFamilyId: predecessor.tokenFamilyId,
          generation: predecessor.generation + 1,
          expiresAt,
          usedAt: null,
          revokedAt: null,
          replacedBySessionId: null,
          createdAt: issuedAt,
          updatedAt: issuedAt,
        })
        .execute();
      await transaction
        .updateTable("deviceSessions")
        .set({
          usedAt: issuedAt,
          replacedBySessionId: successorId,
          updatedAt: issuedAt,
        })
        .where("id", "=", predecessor.id)
        .execute();
      return {
        kind: "rotated",
        user,
        deviceId: predecessor.deviceId,
      } as const;
    });

    if (outcome.kind === "invalid") {
      throw new IdentityError("SESSION_INVALID");
    }
    if (outcome.kind === "replayed") {
      throw new IdentityError("SESSION_REPLAYED");
    }
    if (outcome.kind === "account-status") {
      throw new IdentityError(outcome.code);
    }

    const accessToken = await this.#accessTokens.sign({
      userId: outcome.user.id,
      deviceId: outcome.deviceId,
      sessionId: successorId,
    });
    return {
      sessionId: successorId,
      accessToken,
      refreshToken: successorToken,
      expiresInSeconds: 900,
      refreshExpiresInSeconds: 2_592_000,
      account: {
        id: outcome.user.id,
        username: outcome.user.username,
        displayName: outcome.user.displayName,
        status: outcome.user.status,
        passwordResetRequired: outcome.user.passwordResetRequired,
        createdAt: outcome.user.createdAt,
      },
    };
  }

  public async logout(input: RefreshInput): Promise<void> {
    if (
      typeof input.refreshToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.refreshToken)
    ) {
      return;
    }
    const revokedAt = this.#now();
    const refreshTokenHash = hashOpaqueToken(input.refreshToken);
    await this.#db.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("deviceSessions")
        .select(["tokenFamilyId"])
        .where("refreshTokenHash", "=", refreshTokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) {
        return;
      }
      await transaction
        .updateTable("deviceSessions")
        .set({ revokedAt, updatedAt: revokedAt })
        .where("tokenFamilyId", "=", session.tokenFamilyId)
        .where("revokedAt", "is", null)
        .execute();
    });
  }

  public async authenticateAccessToken(token: string): Promise<AuthenticatedPrincipal> {
    const principal = await this.#accessTokens.verify(token);
    const result = await this.#db
      .selectFrom("deviceSessions")
      .innerJoin("users", "users.id", "deviceSessions.userId")
      .select([
        "deviceSessions.userId",
        "deviceSessions.deviceId",
        "deviceSessions.id as sessionId",
        "deviceSessions.expiresAt",
        "deviceSessions.revokedAt",
        "users.username",
        "users.displayName",
        "users.status",
        "users.passwordResetRequired",
        "users.createdAt",
      ])
      .where("deviceSessions.id", "=", principal.sessionId)
      .where("deviceSessions.userId", "=", principal.userId)
      .where("deviceSessions.deviceId", "=", principal.deviceId)
      .executeTakeFirst();
    if (
      result === undefined ||
      result.revokedAt !== null ||
      result.expiresAt.getTime() <= this.#now().getTime()
    ) {
      throw new IdentityError("SESSION_INVALID");
    }
    if (result.status !== "ACTIVE") {
      throw new IdentityError(accountStatusError(result.status));
    }
    return {
      userId: result.userId,
      deviceId: result.deviceId,
      sessionId: result.sessionId,
      account: {
        id: result.userId,
        username: result.username,
        displayName: result.displayName,
        status: result.status,
        passwordResetRequired: result.passwordResetRequired,
        createdAt: result.createdAt,
      },
    };
  }

  public async completePasswordReset(input: CompletePasswordResetInput): Promise<void> {
    if (typeof input.resetToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.resetToken)) {
      throw new IdentityError("RESET_GRANT_INVALID");
    }
    const password = parsePassword(input.newPassword);
    const passwordHash = await hashPassword(password);
    const resetAt = this.#now();
    const tokenHash = hashOpaqueToken(input.resetToken);
    await this.#db.transaction().execute(async (transaction) => {
      const grant = await transaction
        .selectFrom("passwordResetGrants")
        .selectAll()
        .where("tokenHash", "=", tokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (
        grant === undefined ||
        grant.usedAt !== null ||
        grant.expiresAt.getTime() <= resetAt.getTime()
      ) {
        throw new IdentityError("RESET_GRANT_INVALID");
      }
      await transaction
        .updateTable("users")
        .set({
          passwordHash,
          passwordResetRequired: false,
          updatedAt: resetAt,
        })
        .where("id", "=", grant.userId)
        .execute();
      await transaction
        .updateTable("passwordResetGrants")
        .set({ usedAt: resetAt })
        .where("id", "=", grant.id)
        .execute();
      await transaction
        .updateTable("deviceSessions")
        .set({
          revokedAt: resetAt,
          updatedAt: resetAt,
        })
        .where("userId", "=", grant.userId)
        .where("revokedAt", "is", null)
        .execute();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: grant.userId,
          actorAdministratorId: null,
          eventType: "user.password_reset.completed",
          targetType: "user",
          targetId: grant.userId,
          details: {},
          createdAt: resetAt,
        })
        .execute();
    });
  }
}
