import { ServerMetaSchema } from "@syncaction/protocol";
import { z } from "zod";
import { PRODUCTION_PUBLIC_SERVER_ORIGIN, parsePublicServerOrigin } from "./server-origin.js";

export const DEFAULT_SERVER_PROFILE_ID = "syncaction-production";
export const SERVER_PROFILE_STORAGE_KEY = "syncaction.server-profiles.v1";

export const ServerProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

const NormalizedServerOriginSchema = z.string().transform((value, context) => {
  try {
    return parsePublicServerOrigin(value);
  } catch {
    context.addIssue({ code: "custom", message: "INVALID_SERVER_URL" });
    return z.NEVER;
  }
});

export const ServerProfileSchema = z
  .object({
    profileId: ServerProfileIdSchema,
    baseUrl: NormalizedServerOriginSchema,
    mode: z.enum(["UNVERIFIED", "VNEXT", "LEGACY_V081"]),
    metadata: ServerMetaSchema.nullable(),
    lastHealthyAt: z.number().int().positive().safe().nullable(),
  })
  .strict()
  .superRefine((profile, context) => {
    if ((profile.mode === "VNEXT") !== (profile.metadata !== null)) {
      context.addIssue({
        code: "custom",
        path: ["metadata"],
        message: "profile mode/metadata mismatch",
      });
    }
  });

const ServerProfileStateSchema = z
  .object({
    version: z.literal(1),
    selectedProfileId: ServerProfileIdSchema,
    profiles: z.array(ServerProfileSchema).min(1).max(20),
  })
  .strict()
  .superRefine((state, context) => {
    const profileIds = new Set(state.profiles.map(({ profileId }) => profileId));
    const baseUrls = new Set(state.profiles.map(({ baseUrl }) => baseUrl));
    if (profileIds.size !== state.profiles.length) {
      context.addIssue({ code: "custom", path: ["profiles"], message: "duplicate profile id" });
    }
    if (baseUrls.size !== state.profiles.length) {
      context.addIssue({ code: "custom", path: ["profiles"], message: "duplicate profile URL" });
    }
    if (!profileIds.has(state.selectedProfileId)) {
      context.addIssue({
        code: "custom",
        path: ["selectedProfileId"],
        message: "selected profile does not exist",
      });
    }
    if (!profileIds.has(DEFAULT_SERVER_PROFILE_ID)) {
      context.addIssue({
        code: "custom",
        path: ["profiles"],
        message: "default profile is required",
      });
    }
  });

export const VerifiedServerCandidateSchema = z
  .object({
    baseUrl: NormalizedServerOriginSchema,
    mode: z.enum(["VNEXT", "LEGACY_V081"]),
    metadata: ServerMetaSchema.nullable(),
    healthyAt: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if ((candidate.mode === "VNEXT") !== (candidate.metadata !== null)) {
      context.addIssue({
        code: "custom",
        path: ["metadata"],
        message: "candidate mode/metadata mismatch",
      });
    }
  });

export type ServerProfile = z.infer<typeof ServerProfileSchema>;
export type ServerProfileState = z.infer<typeof ServerProfileStateSchema>;
export type VerifiedServerCandidate = z.infer<typeof VerifiedServerCandidateSchema>;

export interface ServerProfileStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ServerProfileStoreOptions {
  area: ServerProfileStorageArea;
  now?: () => number;
  createProfileId?: () => string;
}

function defaultState(): ServerProfileState {
  return ServerProfileStateSchema.parse({
    version: 1,
    selectedProfileId: DEFAULT_SERVER_PROFILE_ID,
    profiles: [
      {
        profileId: DEFAULT_SERVER_PROFILE_ID,
        baseUrl: PRODUCTION_PUBLIC_SERVER_ORIGIN,
        mode: "UNVERIFIED",
        metadata: null,
        lastHealthyAt: null,
      },
    ],
  });
}

function invalidUrlError(cause: unknown): Error {
  return new Error("INVALID_SERVER_URL", { cause });
}

export class ServerProfileStore {
  readonly #area: ServerProfileStorageArea;
  readonly #now: () => number;
  readonly #createProfileId: () => string;
  #initialization: Promise<void> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  #state: ServerProfileState | undefined;

  public constructor(options: ServerProfileStoreOptions) {
    this.#area = options.area;
    this.#now = options.now ?? (() => Date.now());
    this.#createProfileId = options.createProfileId ?? (() => globalThis.crypto.randomUUID());
  }

  public initialize(): Promise<void> {
    this.#initialization ??= this.#load();
    return this.#initialization;
  }

  public async list(): Promise<ServerProfile[]> {
    await this.#readyForRead();
    return structuredClone(this.#stateOrThrow().profiles);
  }

  public async get(profileIdInput: unknown): Promise<ServerProfile | null> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    await this.#readyForRead();
    const profile = this.#stateOrThrow().profiles.find(
      (candidate) => candidate.profileId === profileId,
    );
    return profile === undefined ? null : structuredClone(profile);
  }

  public async getSelected(): Promise<ServerProfile> {
    await this.#readyForRead();
    const state = this.#stateOrThrow();
    return structuredClone(
      state.profiles.find(({ profileId }) => profileId === state.selectedProfileId)!,
    );
  }

  public addCandidate(
    input: VerifiedServerCandidate,
    options: { select?: boolean } = {},
  ): Promise<ServerProfile> {
    let baseUrl: string;
    try {
      baseUrl = parsePublicServerOrigin(input.baseUrl);
    } catch (cause) {
      return Promise.reject(invalidUrlError(cause));
    }
    const parsed = VerifiedServerCandidateSchema.safeParse({ ...input, baseUrl });
    if (!parsed.success) {
      return Promise.reject(new Error("INVALID_SERVER_CANDIDATE", { cause: parsed.error }));
    }
    if (options.select !== undefined && typeof options.select !== "boolean") {
      return Promise.reject(new Error("INVALID_SERVER_CANDIDATE"));
    }
    return this.#mutate(async (state) => {
      if (state.profiles.some((profile) => profile.baseUrl === parsed.data.baseUrl)) {
        throw new Error("SERVER_PROFILE_URL_EXISTS");
      }
      if (state.profiles.length >= 20) {
        throw new Error("SERVER_PROFILE_LIMIT_REACHED");
      }
      const profileId = ServerProfileIdSchema.parse(this.#createProfileId());
      if (state.profiles.some((profile) => profile.profileId === profileId)) {
        throw new Error("SERVER_PROFILE_ID_EXISTS");
      }
      const profile = ServerProfileSchema.parse({
        profileId,
        baseUrl: parsed.data.baseUrl,
        mode: parsed.data.mode,
        metadata: parsed.data.metadata,
        lastHealthyAt: parsed.data.healthyAt,
      });
      state.profiles.push(profile);
      if (options.select === true) {
        state.selectedProfileId = profile.profileId;
      }
      return structuredClone(profile);
    });
  }

  public verify(profileIdInput: unknown, metadataInput: unknown): Promise<ServerProfile> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    const metadata = ServerMetaSchema.parse(metadataInput);
    return this.#mutate(async (state) => {
      const profile = state.profiles.find((candidate) => candidate.profileId === profileId);
      if (profile === undefined) {
        throw new Error("SERVER_PROFILE_NOT_FOUND");
      }
      if (profile.mode === "LEGACY_V081") {
        throw new Error("SERVER_PROFILE_MODE_CONFLICT");
      }
      if (
        profile.mode === "VNEXT" &&
        profile.metadata !== null &&
        profile.metadata.serverId !== metadata.serverId
      ) {
        throw new Error("SERVER_IDENTITY_CHANGED");
      }
      const verified = ServerProfileSchema.parse({
        ...profile,
        mode: "VNEXT",
        metadata,
        lastHealthyAt: this.#currentTime(),
      });
      Object.assign(profile, verified);
      return structuredClone(verified);
    });
  }

  public select(profileIdInput: unknown): Promise<ServerProfile> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    return this.#mutate(async (state) => {
      const profile = state.profiles.find((candidate) => candidate.profileId === profileId);
      if (profile === undefined) {
        throw new Error("SERVER_PROFILE_NOT_FOUND");
      }
      if (profile.mode === "UNVERIFIED") {
        throw new Error("SERVER_PROFILE_UNVERIFIED");
      }
      state.selectedProfileId = profile.profileId;
      return structuredClone(profile);
    });
  }

  public remove(profileIdInput: unknown): Promise<void> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    return this.#mutate(async (state) => {
      if (profileId === DEFAULT_SERVER_PROFILE_ID) {
        throw new Error("DEFAULT_SERVER_PROFILE_REQUIRED");
      }
      if (profileId === state.selectedProfileId) {
        throw new Error("SELECTED_SERVER_PROFILE_REQUIRED");
      }
      const index = state.profiles.findIndex((profile) => profile.profileId === profileId);
      if (index < 0) {
        throw new Error("SERVER_PROFILE_NOT_FOUND");
      }
      state.profiles.splice(index, 1);
    });
  }

  async #load(): Promise<void> {
    const stored = await this.#area.get(SERVER_PROFILE_STORAGE_KEY);
    const value = stored[SERVER_PROFILE_STORAGE_KEY];
    if (value === undefined) {
      const state = defaultState();
      await this.#area.set({ [SERVER_PROFILE_STORAGE_KEY]: state });
      this.#state = state;
      return;
    }
    const parsed = ServerProfileStateSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("SERVER_PROFILE_STATE_INVALID", { cause: parsed.error });
    }
    this.#state = parsed.data;
  }

  async #readyForRead(): Promise<void> {
    await this.initialize();
    await this.#mutationTail;
  }

  #stateOrThrow(): ServerProfileState {
    if (this.#state === undefined) {
      throw new Error("SERVER_PROFILE_STATE_UNINITIALIZED");
    }
    return this.#state;
  }

  #currentTime(): number {
    return z.number().int().positive().safe().parse(this.#now());
  }

  #mutate<T>(mutation: (draft: ServerProfileState) => Promise<T>): Promise<T> {
    const operation = this.#mutationTail.then(async () => {
      await this.initialize();
      const draft = structuredClone(this.#stateOrThrow());
      const result = await mutation(draft);
      const parsed = ServerProfileStateSchema.parse(draft);
      await this.#area.set({ [SERVER_PROFILE_STORAGE_KEY]: parsed });
      this.#state = parsed;
      return result;
    });
    this.#mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
