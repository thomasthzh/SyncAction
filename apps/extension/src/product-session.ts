import { CanonicalUuidSchema, DeviceIdSchema } from "@syncaction/protocol";
import { z } from "zod";
import {
  PublicAccountSchema,
  PublicSessionResponseSchema,
  SyncActionApiError,
  type PublicAccount,
  type PublicSessionResponse,
} from "./api-client.js";
import {
  DEFAULT_SERVER_PROFILE_ID,
  ServerProfileIdSchema,
  ServerProfileSchema,
  type ServerProfile,
} from "./server-profile.js";
import { parsePublicServerOrigin } from "./server-origin.js";

export type { PublicSessionResponse } from "./api-client.js";

export const PRODUCT_SESSION_STORAGE_KEY = "syncaction.product-sessions.v2";
export const LEGACY_PRODUCT_SESSION_STORAGE_KEY = "syncaction.product-session.v1";
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

const ProductServerOriginSchema = z.string().transform((value, context) => {
  try {
    return parsePublicServerOrigin(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Product sessions require HTTPS or a loopback HTTP origin",
    });
    return z.NEVER;
  }
});

const SessionFields = {
  serverUrl: ProductServerOriginSchema,
  deviceId: DeviceIdSchema,
  sessionId: CanonicalUuidSchema,
  accessToken: z.string().min(1).max(8_192),
  accessTokenExpiresAt: z.number().int().positive().safe(),
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  refreshTokenExpiresAt: z.number().int().positive().safe(),
  account: PublicAccountSchema.refine((account) => account.status === "ACTIVE", {
    message: "Stored sessions must belong to an active account",
  }),
} as const;

function validateExpiryOrder(
  session: {
    accessTokenExpiresAt: number;
    refreshTokenExpiresAt: number;
  },
  context: z.core.$RefinementCtx,
): void {
  if (session.refreshTokenExpiresAt <= session.accessTokenExpiresAt) {
    context.addIssue({
      code: "custom",
      message: "Refresh expiry must follow access expiry",
      path: ["refreshTokenExpiresAt"],
    });
  }
}

const LegacyExtensionProductSessionSchema = z
  .object({
    version: z.literal(1),
    ...SessionFields,
  })
  .strict()
  .superRefine(validateExpiryOrder);

export const ExtensionProductSessionSchema = z
  .object({
    version: z.literal(2),
    profileId: ServerProfileIdSchema,
    serverId: CanonicalUuidSchema.nullable(),
    ...SessionFields,
  })
  .strict()
  .superRefine(validateExpiryOrder);

const ProductSessionCollectionSchema = z
  .object({
    version: z.literal(2),
    sessions: z.record(ServerProfileIdSchema, ExtensionProductSessionSchema),
  })
  .strict()
  .superRefine((collection, context) => {
    for (const [profileId, session] of Object.entries(collection.sessions)) {
      if (session.profileId !== profileId) {
        context.addIssue({
          code: "custom",
          path: ["sessions", profileId, "profileId"],
          message: "session key/profile mismatch",
        });
      }
    }
  });

type ProductSessionCollection = z.infer<typeof ProductSessionCollectionSchema>;
export type ExtensionProductSession = z.infer<typeof ExtensionProductSessionSchema>;

export interface ExtensionSessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SessionRotationInput {
  serverUrl: string;
  refreshToken: string;
}

export type SessionRotator = (input: SessionRotationInput) => Promise<PublicSessionResponse>;

export type ExtensionSessionStatus =
  | { kind: "SIGNED_OUT" }
  | {
      kind: "AUTHENTICATED";
      account: PublicAccount;
      deviceId: string;
      accessTokenExpiresAt: number;
      refreshTokenExpiresAt: number;
    };

export class ExtensionSessionRequiredError extends Error {
  public readonly code = "SESSION_REQUIRED";

  public constructor() {
    super("SESSION_REQUIRED");
    this.name = "ExtensionSessionRequiredError";
  }
}

export class ExtensionSessionPersistenceError extends Error {
  public readonly code = "SESSION_PERSIST_FAILED";

  public constructor(options?: ErrorOptions) {
    super("SESSION_PERSIST_FAILED", options);
    this.name = "ExtensionSessionPersistenceError";
  }
}

export interface ExtensionSessionManagerOptions {
  area: ExtensionSessionStorageArea;
  rotate: SessionRotator;
  now?: () => number;
  key?: string;
  legacyKey?: string;
}

function emptyCollection(): ProductSessionCollection {
  return { version: 2, sessions: {} };
}

export class ExtensionSessionManager {
  readonly #area: ExtensionSessionStorageArea;
  readonly #rotate: SessionRotator;
  readonly #now: () => number;
  readonly #key: string;
  readonly #legacyKey: string;
  readonly #refreshPromises = new Map<string, Promise<ExtensionProductSession>>();
  #mutationTail: Promise<void> = Promise.resolve();

  public constructor(options: ExtensionSessionManagerOptions) {
    this.#area = options.area;
    this.#rotate = options.rotate;
    this.#now = options.now ?? Date.now;
    this.#key = options.key ?? PRODUCT_SESSION_STORAGE_KEY;
    this.#legacyKey = options.legacyKey ?? LEGACY_PRODUCT_SESSION_STORAGE_KEY;
  }

  public async establish(input: {
    profileId: unknown;
    serverUrl: unknown;
    serverId: unknown;
    deviceId: unknown;
    response: PublicSessionResponse;
  }): Promise<ExtensionProductSession> {
    const session = this.#toStoredSession(input);
    await this.#persistTargetOrClear(session.profileId, session);
    return session;
  }

  public async read(profileIdInput: unknown): Promise<ExtensionProductSession | null> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    await this.#mutationTail;
    const collection = await this.#loadCollection();
    const session = collection.sessions[profileId];
    return session === undefined ? null : structuredClone(session);
  }

  public async getStatus(profileIdInput: unknown): Promise<ExtensionSessionStatus> {
    const session = await this.read(profileIdInput);
    if (session === null) {
      return { kind: "SIGNED_OUT" };
    }
    return {
      kind: "AUTHENTICATED",
      account: session.account,
      deviceId: session.deviceId,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }

  public async updateAccount(profileIdInput: unknown, accountInput: PublicAccount): Promise<void> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    const account = PublicAccountSchema.parse(accountInput);
    await this.#mutateCollection((collection) => {
      const current = collection.sessions[profileId];
      if (current === undefined) {
        throw new ExtensionSessionRequiredError();
      }
      if (current.account.id !== account.id || account.status !== "ACTIVE") {
        throw new SyncActionApiError("SESSION_ACCOUNT_MISMATCH", 0);
      }
      collection.sessions[profileId] = ExtensionProductSessionSchema.parse({
        ...current,
        account,
      });
    });
  }

  public async getAccessToken(profileIdInput: unknown): Promise<string> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    const session = await this.#requireSession(profileId);
    if (session.refreshTokenExpiresAt <= this.#now()) {
      await this.clear(profileId);
      throw new ExtensionSessionRequiredError();
    }
    if (session.accessTokenExpiresAt - this.#now() <= ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return (await this.#refresh(profileId)).accessToken;
    }
    return session.accessToken;
  }

  public async runAuthenticated<T>(
    profileIdInput: unknown,
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    const accessToken = await this.getAccessToken(profileId);
    try {
      return await operation(accessToken);
    } catch (cause) {
      if (!(cause instanceof SyncActionApiError) || cause.code !== "SESSION_INVALID") {
        throw cause;
      }
      const successor = await this.#refresh(profileId);
      return operation(successor.accessToken);
    }
  }

  public clear(profileIdInput: unknown): Promise<void> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    this.#refreshPromises.delete(profileId);
    return this.#mutateCollection((collection) => {
      delete collection.sessions[profileId];
    });
  }

  public async migrateLegacyProductionSession(profileInput: ServerProfile): Promise<void> {
    const profile = ServerProfileSchema.parse(profileInput);
    const migrateLegacy = profile.profileId === DEFAULT_SERVER_PROFILE_ID;
    const legacyInput = migrateLegacy
      ? (await this.#area.get(this.#legacyKey))[this.#legacyKey]
      : undefined;
    try {
      await this.#mutateCollection((collection) => {
        const existing = collection.sessions[profile.profileId];
        const expectedServerId = profile.mode === "VNEXT" ? profile.metadata?.serverId : null;
        if (
          existing !== undefined &&
          (existing.serverUrl !== profile.baseUrl ||
            profile.mode === "UNVERIFIED" ||
            existing.serverId !== expectedServerId)
        ) {
          delete collection.sessions[profile.profileId];
        }

        if (
          legacyInput === undefined ||
          !migrateLegacy ||
          profile.mode === "UNVERIFIED" ||
          collection.sessions[profile.profileId] !== undefined
        ) {
          return;
        }
        const legacy = LegacyExtensionProductSessionSchema.safeParse(legacyInput);
        if (!legacy.success || legacy.data.serverUrl !== profile.baseUrl) {
          return;
        }
        collection.sessions[profile.profileId] = ExtensionProductSessionSchema.parse({
          ...legacy.data,
          version: 2,
          profileId: profile.profileId,
          serverId: expectedServerId,
        });
      });
    } finally {
      if (migrateLegacy) {
        await this.#area.remove(this.#legacyKey);
      }
    }
  }

  async #requireSession(profileId: string): Promise<ExtensionProductSession> {
    const session = await this.read(profileId);
    if (session === null) {
      throw new ExtensionSessionRequiredError();
    }
    return session;
  }

  #refresh(profileId: string): Promise<ExtensionProductSession> {
    const existing = this.#refreshPromises.get(profileId);
    if (existing !== undefined) {
      return existing;
    }
    const pending = this.#performRefresh(profileId);
    this.#refreshPromises.set(profileId, pending);
    const removePending = (): void => {
      if (this.#refreshPromises.get(profileId) === pending) {
        this.#refreshPromises.delete(profileId);
      }
    };
    void pending.then(removePending, removePending);
    return pending;
  }

  async #performRefresh(profileId: string): Promise<ExtensionProductSession> {
    const current = await this.#requireSession(profileId);
    if (current.refreshTokenExpiresAt <= this.#now()) {
      await this.clear(profileId);
      throw new ExtensionSessionRequiredError();
    }

    let response: PublicSessionResponse;
    try {
      response = PublicSessionResponseSchema.parse(
        await this.#rotate({
          serverUrl: current.serverUrl,
          refreshToken: current.refreshToken,
        }),
      );
    } catch (cause) {
      if (isTerminalSessionFailure(cause)) {
        await this.clear(profileId);
      }
      throw cause;
    }
    if (response.account.id !== current.account.id) {
      await this.clear(profileId);
      throw new SyncActionApiError("SESSION_ACCOUNT_MISMATCH", 0);
    }
    const successor = this.#toStoredSession({
      profileId: current.profileId,
      serverUrl: current.serverUrl,
      serverId: current.serverId,
      deviceId: current.deviceId,
      response,
    });
    try {
      await this.#replaceIfCurrent(current, successor);
    } catch (cause) {
      if (cause instanceof SyncActionApiError && cause.code === "SESSION_CHANGED") {
        throw cause;
      }
      try {
        await this.clear(profileId);
      } catch {
        // The caller still receives a closed persistence failure.
      }
      throw new ExtensionSessionPersistenceError({ cause });
    }
    return successor;
  }

  #toStoredSession(input: {
    profileId: unknown;
    serverUrl: unknown;
    serverId: unknown;
    deviceId: unknown;
    response: PublicSessionResponse;
  }): ExtensionProductSession {
    const response = PublicSessionResponseSchema.parse(input.response);
    const issuedAt = this.#now();
    return ExtensionProductSessionSchema.parse({
      version: 2,
      profileId: ServerProfileIdSchema.parse(input.profileId),
      serverUrl: ProductServerOriginSchema.parse(input.serverUrl),
      serverId: CanonicalUuidSchema.nullable().parse(input.serverId),
      deviceId: DeviceIdSchema.parse(input.deviceId),
      sessionId: response.sessionId,
      accessToken: response.accessToken,
      accessTokenExpiresAt: safeDeadline(issuedAt, response.expiresInSeconds),
      refreshToken: response.refreshToken,
      refreshTokenExpiresAt: safeDeadline(issuedAt, response.refreshExpiresInSeconds),
      account: response.account,
    });
  }

  async #replaceIfCurrent(
    expected: ExtensionProductSession,
    successor: ExtensionProductSession,
  ): Promise<void> {
    await this.#mutateCollection((collection) => {
      const latest = collection.sessions[expected.profileId];
      if (
        latest === undefined ||
        latest.profileId !== expected.profileId ||
        latest.serverUrl !== expected.serverUrl ||
        latest.serverId !== expected.serverId ||
        latest.account.id !== expected.account.id ||
        latest.sessionId !== expected.sessionId ||
        latest.refreshToken !== expected.refreshToken
      ) {
        throw new SyncActionApiError("SESSION_CHANGED", 0);
      }
      collection.sessions[expected.profileId] = successor;
    });
  }

  async #persistTargetOrClear(profileId: string, session: ExtensionProductSession): Promise<void> {
    try {
      await this.#mutateCollection((collection) => {
        collection.sessions[profileId] = session;
      });
    } catch (cause) {
      try {
        await this.clear(profileId);
      } catch {
        // The caller receives a closed failure even when storage remains unavailable.
      }
      throw new ExtensionSessionPersistenceError({ cause });
    }
  }

  async #loadCollection(): Promise<ProductSessionCollection> {
    const input = (await this.#area.get(this.#key))[this.#key];
    if (input === undefined) {
      return emptyCollection();
    }
    const parsed = ProductSessionCollectionSchema.safeParse(input);
    if (!parsed.success) {
      await this.#area.remove(this.#key);
      return emptyCollection();
    }
    return parsed.data;
  }

  #mutateCollection<T>(
    mutation: (collection: ProductSessionCollection) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.#mutationTail.then(async () => {
      const collection = structuredClone(await this.#loadCollection());
      const result = await mutation(collection);
      const parsed = ProductSessionCollectionSchema.parse(collection);
      await this.#area.set({ [this.#key]: parsed });
      return result;
    });
    this.#mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function safeDeadline(issuedAt: number, expiresInSeconds: number): number {
  const deadline = issuedAt + expiresInSeconds * 1_000;
  if (!Number.isSafeInteger(deadline) || deadline <= issuedAt) {
    throw new SyncActionApiError("INVALID_RESPONSE", 200);
  }
  return deadline;
}

function isTerminalSessionFailure(cause: unknown): boolean {
  return (
    cause instanceof SyncActionApiError &&
    (cause.code === "SESSION_INVALID" ||
      cause.code === "SESSION_REPLAYED" ||
      cause.code === "ACCOUNT_SUSPENDED" ||
      cause.code === "ACCOUNT_REVOKED")
  );
}
