import { randomUUID } from "node:crypto";
import type { createDatabase } from "@syncaction/database";
import { sql } from "kysely";
import type { PublicAccount } from "./account-service.js";
import { IdentityError } from "./errors.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { parseDeviceId, parsePassword, parseUsername } from "./policy.js";
import { createOpaqueToken, hashOpaqueToken } from "./tokens.js";
import { createTotpEnrollmentUri, openTotpSecret, sealTotpSecret, verifyTotp } from "./totp.js";

type IdentityDatabase = ReturnType<typeof createDatabase>;

export interface AdminServiceOptions {
  db: IdentityDatabase;
  totpEncryptionKey: Uint8Array;
  now?: () => Date;
}

export interface BootstrapAdministratorInput {
  username: unknown;
  password: unknown;
  totpSecret: string;
  passwordChangeRequired?: boolean;
  totpEnrollmentRequired?: boolean;
}

export interface PublicAdministrator {
  id: string;
  username: string;
  linkedUserId: string | null;
  passwordChangeRequired: boolean;
  totpEnrollmentRequired: boolean;
  createdAt: Date;
}

export interface AdminLoginInput {
  username: unknown;
  password: unknown;
  totp?: unknown;
}

export interface AdministratorOnboardingState {
  passwordChangeRequired: boolean;
  totpEnrollmentRequired: boolean;
}

export interface AdminSession {
  sessionId: string;
  sessionToken: string;
  expiresInSeconds: number;
  administrator: PublicAdministrator;
  onboarding: AdministratorOnboardingState;
}

export interface AdminPrincipal extends AdministratorOnboardingState {
  administratorId: string;
  username: string;
  linkedUserId: string | null;
  sessionId: string;
}

export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
}

export interface CompleteAdministratorOnboardingInput {
  newPassword?: unknown;
  totp: unknown;
}

export interface AdministratorUserActionInput {
  administratorId: unknown;
  userId: unknown;
}

export interface AdministratorUserBinding {
  administratorId: string;
  linkedUserId: string;
}

export interface AdministratorDeviceActionInput extends AdministratorUserActionInput {
  deviceId: unknown;
}

export interface PasswordResetGrant {
  grantId: string;
  resetToken: string;
  expiresInSeconds: 3_600;
}

type AccountStatus = PublicAccount["status"];

function parseOptionalBoolean(value: boolean | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new IdentityError("INVALID_INPUT");
  }
  return value;
}

function parseAuthenticationPassword(input: unknown): string {
  if (typeof input !== "string") {
    throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
  }
  const length = Array.from(input).length;
  if (length < 1 || length > 128) {
    throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
  }
  return input;
}

function parseAuthenticationUsername(input: unknown): string {
  try {
    return parseUsername(input).usernameNormalized;
  } catch (cause) {
    if (cause instanceof IdentityError && cause.code === "INVALID_INPUT") {
      throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
    }
    throw cause;
  }
}

export class AdminService {
  readonly #db: IdentityDatabase;
  readonly #totpEncryptionKey: Uint8Array;
  readonly #now: () => Date;
  readonly #dummyPasswordHash: Promise<string>;

  public constructor(options: AdminServiceOptions) {
    if (options.totpEncryptionKey.byteLength !== 32) {
      throw new IdentityError("INVALID_INPUT");
    }
    this.#db = options.db;
    this.#totpEncryptionKey = options.totpEncryptionKey.slice();
    this.#now = options.now ?? (() => new Date());
    this.#dummyPasswordHash = hashPassword(randomUUID());
  }

  public async bootstrap(input: BootstrapAdministratorInput): Promise<PublicAdministrator> {
    const { username, usernameNormalized } = parseUsername(input.username);
    const passwordChangeRequired = parseOptionalBoolean(input.passwordChangeRequired);
    const totpEnrollmentRequired = parseOptionalBoolean(input.totpEnrollmentRequired);
    const password = parsePassword(input.password);
    return this.#db.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(193733, 8071)`.execute(transaction);
      const existing = await transaction
        .selectFrom("administrators")
        .select([
          "id",
          "username",
          "usernameNormalized",
          "linkedUserId",
          "passwordChangeRequired",
          "totpEnrollmentRequired",
          "createdAt",
        ])
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.usernameNormalized !== usernameNormalized) {
          throw new IdentityError("INVALID_ACCOUNT_TRANSITION");
        }
        return {
          id: existing.id,
          username: existing.username,
          linkedUserId: existing.linkedUserId,
          passwordChangeRequired: existing.passwordChangeRequired,
          totpEnrollmentRequired: existing.totpEnrollmentRequired,
          createdAt: existing.createdAt,
        };
      }

      const passwordHash = await hashPassword(password);
      const totpSecretCiphertext = sealTotpSecret(input.totpSecret, this.#totpEncryptionKey);
      return transaction
        .insertInto("administrators")
        .values({
          id: randomUUID(),
          username,
          usernameNormalized,
          passwordHash,
          totpSecretCiphertext,
          passwordChangeRequired,
          totpEnrollmentRequired,
        })
        .returning([
          "id",
          "username",
          "linkedUserId",
          "passwordChangeRequired",
          "totpEnrollmentRequired",
          "createdAt",
        ])
        .executeTakeFirstOrThrow();
    });
  }

  public async requireExistingAdministrator(): Promise<void> {
    const existing = await this.#db.selectFrom("administrators").select("id").executeTakeFirst();
    if (existing === undefined) {
      throw new Error("ADMIN_BOOTSTRAP_REQUIRED");
    }
  }

  public async login(input: AdminLoginInput): Promise<AdminSession> {
    const usernameNormalized = parseAuthenticationUsername(input.username);
    const password = parseAuthenticationPassword(input.password);
    const administrator = await this.#db
      .selectFrom("administrators")
      .selectAll()
      .where("usernameNormalized", "=", usernameNormalized)
      .executeTakeFirst();
    const passwordHash = administrator?.passwordHash ?? (await this.#dummyPasswordHash);
    if (!(await verifyPassword(passwordHash, password)) || administrator === undefined) {
      throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
    }

    const sessionId = randomUUID();
    const sessionToken = createOpaqueToken();
    const issuedAt = this.#now();
    const authenticated = await this.#db.transaction().execute(async (transaction) => {
      const locked = await transaction
        .selectFrom("administrators")
        .selectAll()
        .where("id", "=", administrator.id)
        .forUpdate()
        .executeTakeFirst();
      if (locked === undefined || !(await verifyPassword(locked.passwordHash, password))) {
        throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
      }
      const onboarding = {
        passwordChangeRequired: locked.passwordChangeRequired,
        totpEnrollmentRequired: locked.totpEnrollmentRequired,
      };
      const onboardingRequired =
        onboarding.passwordChangeRequired || onboarding.totpEnrollmentRequired;
      if (!onboardingRequired) {
        if (typeof input.totp !== "string") {
          throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
        }
        const secret = openTotpSecret(locked.totpSecretCiphertext, this.#totpEncryptionKey);
        const acceptedCounter = verifyTotp({
          secret,
          token: input.totp,
          timestamp: issuedAt.getTime(),
          lastAcceptedCounter: locked.lastTotpCounter,
        });
        await transaction
          .updateTable("administrators")
          .set({
            lastTotpCounter: acceptedCounter,
            updatedAt: issuedAt,
          })
          .where("id", "=", locked.id)
          .execute();
      }
      const expiresInSeconds = onboardingRequired ? 600 : 28_800;
      const expiresAt = new Date(issuedAt.getTime() + expiresInSeconds * 1_000);
      await transaction
        .insertInto("adminSessions")
        .values({
          id: sessionId,
          administratorId: locked.id,
          sessionTokenHash: hashOpaqueToken(sessionToken),
          expiresAt,
          revokedAt: null,
          createdAt: issuedAt,
        })
        .execute();
      return {
        administrator: {
          id: locked.id,
          username: locked.username,
          linkedUserId: locked.linkedUserId,
          passwordChangeRequired: locked.passwordChangeRequired,
          totpEnrollmentRequired: locked.totpEnrollmentRequired,
          createdAt: locked.createdAt,
        },
        expiresInSeconds,
        onboarding,
      };
    });

    return {
      sessionId,
      sessionToken,
      expiresInSeconds: authenticated.expiresInSeconds,
      administrator: authenticated.administrator,
      onboarding: authenticated.onboarding,
    };
  }

  public async authenticateSession(sessionToken: unknown): Promise<AdminPrincipal> {
    if (typeof sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(sessionToken)) {
      throw new IdentityError("ADMIN_SESSION_INVALID");
    }
    const result = await this.#db
      .selectFrom("adminSessions")
      .innerJoin("administrators", "administrators.id", "adminSessions.administratorId")
      .select([
        "adminSessions.id as sessionId",
        "adminSessions.administratorId",
        "adminSessions.expiresAt",
        "adminSessions.revokedAt",
        "administrators.username",
        "administrators.linkedUserId",
        "administrators.passwordChangeRequired",
        "administrators.totpEnrollmentRequired",
      ])
      .where("adminSessions.sessionTokenHash", "=", hashOpaqueToken(sessionToken))
      .executeTakeFirst();
    if (
      result === undefined ||
      result.revokedAt !== null ||
      result.expiresAt.getTime() <= this.#now().getTime()
    ) {
      throw new IdentityError("ADMIN_SESSION_INVALID");
    }
    return {
      administratorId: result.administratorId,
      username: result.username,
      linkedUserId: result.linkedUserId,
      sessionId: result.sessionId,
      passwordChangeRequired: result.passwordChangeRequired,
      totpEnrollmentRequired: result.totpEnrollmentRequired,
    };
  }

  public async getTotpEnrollment(principal: AdminPrincipal): Promise<TotpEnrollment> {
    const administrator = await this.#db
      .selectFrom("administrators")
      .select(["username", "totpSecretCiphertext", "totpEnrollmentRequired"])
      .where("id", "=", principal.administratorId)
      .executeTakeFirst();
    if (administrator === undefined) {
      throw new IdentityError("ADMIN_SESSION_INVALID");
    }
    if (!administrator.totpEnrollmentRequired) {
      throw new IdentityError("INVALID_ACCOUNT_TRANSITION");
    }
    const secret = openTotpSecret(administrator.totpSecretCiphertext, this.#totpEncryptionKey);
    return {
      secret,
      otpauthUri: createTotpEnrollmentUri(administrator.username, secret),
    };
  }

  public async completeOnboarding(
    principal: AdminPrincipal,
    input: CompleteAdministratorOnboardingInput,
  ): Promise<AdminPrincipal> {
    if (typeof input.totp !== "string") {
      throw new IdentityError("ADMIN_INVALID_CREDENTIALS");
    }
    const totp = input.totp;
    const completedAt = this.#now();
    return this.#db.transaction().execute(async (transaction) => {
      const locked = await transaction
        .selectFrom("administrators")
        .selectAll()
        .where("id", "=", principal.administratorId)
        .forUpdate()
        .executeTakeFirst();
      const currentSession = await transaction
        .selectFrom("adminSessions")
        .select(["id", "expiresAt", "revokedAt"])
        .where("id", "=", principal.sessionId)
        .where("administratorId", "=", principal.administratorId)
        .forUpdate()
        .executeTakeFirst();
      if (
        locked === undefined ||
        currentSession === undefined ||
        currentSession.revokedAt !== null ||
        currentSession.expiresAt.getTime() <= completedAt.getTime()
      ) {
        throw new IdentityError("ADMIN_SESSION_INVALID");
      }
      if (!locked.passwordChangeRequired && !locked.totpEnrollmentRequired) {
        throw new IdentityError("INVALID_ACCOUNT_TRANSITION");
      }
      let passwordHash: string | undefined;
      if (locked.passwordChangeRequired) {
        passwordHash = await hashPassword(parsePassword(input.newPassword));
      } else if (input.newPassword !== undefined) {
        throw new IdentityError("INVALID_INPUT");
      }
      const secret = openTotpSecret(locked.totpSecretCiphertext, this.#totpEncryptionKey);
      const acceptedCounter = verifyTotp({
        secret,
        token: totp,
        timestamp: completedAt.getTime(),
        lastAcceptedCounter: locked.lastTotpCounter,
      });
      await transaction
        .updateTable("administrators")
        .set({
          ...(passwordHash === undefined ? {} : { passwordHash }),
          lastTotpCounter: acceptedCounter,
          passwordChangeRequired: false,
          totpEnrollmentRequired: false,
          updatedAt: completedAt,
        })
        .where("id", "=", locked.id)
        .execute();
      await transaction
        .updateTable("adminSessions")
        .set({ revokedAt: completedAt })
        .where("administratorId", "=", locked.id)
        .where("id", "!=", currentSession.id)
        .where("revokedAt", "is", null)
        .execute();
      await transaction
        .updateTable("adminSessions")
        .set({
          expiresAt: new Date(completedAt.getTime() + 28_800_000),
          revokedAt: null,
        })
        .where("id", "=", currentSession.id)
        .execute();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: locked.id,
          eventType: "administrator.onboarding_completed",
          targetType: "administrator",
          targetId: locked.id,
          details: {
            passwordChanged: locked.passwordChangeRequired,
            totpEnrolled: locked.totpEnrollmentRequired,
          },
          createdAt: completedAt,
        })
        .execute();
      return {
        administratorId: locked.id,
        username: locked.username,
        linkedUserId: locked.linkedUserId,
        sessionId: currentSession.id,
        passwordChangeRequired: false,
        totpEnrollmentRequired: false,
      };
    });
  }

  public async logout(sessionToken: unknown): Promise<void> {
    if (typeof sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(sessionToken)) {
      return;
    }
    const revokedAt = this.#now();
    await this.#db
      .updateTable("adminSessions")
      .set({ revokedAt })
      .where("sessionTokenHash", "=", hashOpaqueToken(sessionToken))
      .where("revokedAt", "is", null)
      .execute();
  }

  public async bindLinkedUser(
    input: AdministratorUserActionInput,
  ): Promise<AdministratorUserBinding> {
    const administratorId = parseDeviceId(input.administratorId);
    const userId = parseDeviceId(input.userId);
    const linkedAt = this.#now();
    return this.#db.transaction().execute(async (transaction) => {
      const administrator = await transaction
        .selectFrom("administrators")
        .select(["id", "linkedUserId"])
        .where("id", "=", administratorId)
        .forUpdate()
        .executeTakeFirst();
      if (administrator === undefined) {
        throw new IdentityError("ADMIN_SESSION_INVALID");
      }
      if (administrator.linkedUserId !== null) {
        throw new IdentityError("ADMIN_LINK_ALREADY_SET");
      }
      const user = await transaction
        .selectFrom("users")
        .select(["id", "status"])
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined || user.status !== "ACTIVE") {
        throw new IdentityError("ADMIN_LINK_TARGET_INVALID");
      }
      await transaction
        .updateTable("administrators")
        .set({ linkedUserId: user.id, updatedAt: linkedAt })
        .where("id", "=", administrator.id)
        .execute();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: administrator.id,
          eventType: "administrator.user_linked",
          targetType: "administrator",
          targetId: administrator.id,
          details: { administratorId: administrator.id, userId: user.id },
          createdAt: linkedAt,
        })
        .execute();
      return { administratorId: administrator.id, linkedUserId: user.id };
    });
  }

  public async approveUser(input: AdministratorUserActionInput): Promise<PublicAccount> {
    return this.#transitionUser(input, ["PENDING"], "ACTIVE", "user.approved", false);
  }

  public async suspendUser(input: AdministratorUserActionInput): Promise<PublicAccount> {
    return this.#transitionUser(input, ["ACTIVE"], "SUSPENDED", "user.suspended", true);
  }

  public async revokeUser(input: AdministratorUserActionInput): Promise<PublicAccount> {
    return this.#transitionUser(
      input,
      ["PENDING", "ACTIVE", "SUSPENDED"],
      "REVOKED",
      "user.revoked",
      true,
    );
  }

  public async revokeAllUserSessions(input: AdministratorUserActionInput): Promise<number> {
    return this.#revokeUserSessions(input, undefined);
  }

  public async revokeDeviceSessions(input: AdministratorDeviceActionInput): Promise<number> {
    return this.#revokeUserSessions(input, parseDeviceId(input.deviceId));
  }

  public async issuePasswordReset(
    input: AdministratorUserActionInput,
  ): Promise<PasswordResetGrant> {
    const administratorId = parseDeviceId(input.administratorId);
    const userId = parseDeviceId(input.userId);
    const issuedAt = this.#now();
    const expiresAt = new Date(issuedAt.getTime() + 60 * 60 * 1_000);
    const grantId = randomUUID();
    const resetToken = createOpaqueToken();
    await this.#db.transaction().execute(async (transaction) => {
      const administrator = await transaction
        .selectFrom("administrators")
        .select("id")
        .where("id", "=", administratorId)
        .executeTakeFirst();
      if (administrator === undefined) {
        throw new IdentityError("ADMIN_SESSION_INVALID");
      }
      const user = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined) {
        throw new IdentityError("INVALID_ACCOUNT_TRANSITION");
      }
      await transaction
        .updateTable("passwordResetGrants")
        .set({ usedAt: issuedAt })
        .where("userId", "=", user.id)
        .where("usedAt", "is", null)
        .execute();
      await transaction
        .updateTable("users")
        .set({
          passwordResetRequired: true,
          updatedAt: issuedAt,
        })
        .where("id", "=", user.id)
        .execute();
      await transaction
        .insertInto("passwordResetGrants")
        .values({
          id: grantId,
          userId: user.id,
          tokenHash: hashOpaqueToken(resetToken),
          issuedByAdministratorId: administrator.id,
          expiresAt,
          usedAt: null,
          createdAt: issuedAt,
        })
        .execute();
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: administrator.id,
          eventType: "user.password_reset.issued",
          targetType: "user",
          targetId: user.id,
          details: {
            expiresAt: expiresAt.toISOString(),
          },
          createdAt: issuedAt,
        })
        .execute();
    });
    return {
      grantId,
      resetToken,
      expiresInSeconds: 3_600,
    };
  }

  async #revokeUserSessions(
    input: AdministratorUserActionInput,
    deviceId: string | undefined,
  ): Promise<number> {
    const administratorId = parseDeviceId(input.administratorId);
    const userId = parseDeviceId(input.userId);
    const revokedAt = this.#now();
    return this.#db.transaction().execute(async (transaction) => {
      const administrator = await transaction
        .selectFrom("administrators")
        .select("id")
        .where("id", "=", administratorId)
        .executeTakeFirst();
      if (administrator === undefined) {
        throw new IdentityError("ADMIN_SESSION_INVALID");
      }
      const user = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .executeTakeFirst();
      if (user === undefined) {
        throw new IdentityError("INVALID_ACCOUNT_TRANSITION");
      }
      let update = transaction
        .updateTable("deviceSessions")
        .set({
          revokedAt,
          updatedAt: revokedAt,
        })
        .where("userId", "=", user.id)
        .where("revokedAt", "is", null);
      if (deviceId !== undefined) {
        update = update.where("deviceId", "=", deviceId);
      }
      const result = await update.executeTakeFirst();
      const affectedCount = Number(result.numUpdatedRows);
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: administrator.id,
          eventType:
            deviceId === undefined ? "user.sessions.revoked" : "user.device_sessions.revoked",
          targetType: "user",
          targetId: user.id,
          details:
            deviceId === undefined
              ? { affectedCount }
              : {
                  affectedCount,
                  deviceId,
                },
          createdAt: revokedAt,
        })
        .execute();
      return affectedCount;
    });
  }

  async #transitionUser(
    input: AdministratorUserActionInput,
    allowedStatuses: AccountStatus[],
    newStatus: AccountStatus,
    eventType: string,
    revokeSessions: boolean,
  ): Promise<PublicAccount> {
    const administratorId = parseDeviceId(input.administratorId);
    const userId = parseDeviceId(input.userId);
    const changedAt = this.#now();
    return this.#db.transaction().execute(async (transaction) => {
      const administrator = await transaction
        .selectFrom("administrators")
        .select("id")
        .where("id", "=", administratorId)
        .executeTakeFirst();
      if (administrator === undefined) {
        throw new IdentityError("ADMIN_SESSION_INVALID");
      }
      const user = await transaction
        .selectFrom("users")
        .selectAll()
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined || !allowedStatuses.includes(user.status)) {
        throw new IdentityError("INVALID_ACCOUNT_TRANSITION");
      }
      const updated = await transaction
        .updateTable("users")
        .set({
          status: newStatus,
          updatedAt: changedAt,
        })
        .where("id", "=", user.id)
        .returning([
          "id",
          "username",
          "displayName",
          "status",
          "passwordResetRequired",
          "createdAt",
        ])
        .executeTakeFirstOrThrow();
      if (revokeSessions) {
        await transaction
          .updateTable("deviceSessions")
          .set({
            revokedAt: changedAt,
            updatedAt: changedAt,
          })
          .where("userId", "=", user.id)
          .where("revokedAt", "is", null)
          .execute();
      }
      await transaction
        .insertInto("auditEvents")
        .values({
          actorUserId: null,
          actorAdministratorId: administrator.id,
          eventType,
          targetType: "user",
          targetId: user.id,
          details: {
            previousStatus: user.status,
            newStatus,
          },
          createdAt: changedAt,
        })
        .execute();
      return updated;
    });
  }
}
