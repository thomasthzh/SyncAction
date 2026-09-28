import { z } from "zod";
import { ServerProfileIdSchema } from "./server-profile.js";
import { serverScopedStorageKey } from "./scoped-storage.js";

export const PAGE_COLLABORATION_DISCLOSURE_VERSION = 1 as const;
export const ORIGIN_CONSENT_STORAGE_KEY = "syncaction.origin-consent.v1";

const ServerTermsVersionSchema = z.string().min(1).max(64);
const AcceptedAtClientMsSchema = z.number().int().positive().safe();

const StoredOriginConsentRecordSchema = z
  .object({
    profileId: ServerProfileIdSchema,
    origin: z.string().min(1).max(2_048),
    serverTermsVersion: ServerTermsVersionSchema,
    disclosureVersion: z.number().int().positive().safe(),
    acceptedAtClientMs: AcceptedAtClientMsSchema,
    bundle: z.literal("PAGE_COLLABORATION"),
    policySyncPending: z.boolean(),
  })
  .strict();

const OriginConsentRecordSchema = StoredOriginConsentRecordSchema.extend({
  disclosureVersion: z.literal(PAGE_COLLABORATION_DISCLOSURE_VERSION),
}).strict();

const OriginConsentCollectionSchema = z
  .object({
    version: z.literal(1),
    records: z.record(z.string().min(1).max(512), StoredOriginConsentRecordSchema),
  })
  .strict();

type OriginConsentCollection = z.infer<typeof OriginConsentCollectionSchema>;

export interface OriginConsentRecord {
  profileId: string;
  origin: string;
  serverTermsVersion: string;
  disclosureVersion: 1;
  acceptedAtClientMs: number;
  bundle: "PAGE_COLLABORATION";
  policySyncPending: boolean;
}

export interface OriginConsentStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface PageOriginPermissionPort {
  contains(input: { origins: string[] }): Promise<boolean>;
}

export interface OriginConsentStoreOptions {
  area: OriginConsentStorageArea;
  permissions: PageOriginPermissionPort;
  now?: () => number;
  subtle?: SubtleCrypto;
}

export interface OriginConsentIdentity {
  profileId: unknown;
  origin: unknown;
  serverTermsVersion: unknown;
}

export interface EffectiveOriginGrant {
  record: OriginConsentRecord | null;
  browserPermissionGranted: boolean;
  termsAccepted: boolean;
  effective: boolean;
}

function emptyCollection(): OriginConsentCollection {
  return { version: 1, records: {} };
}

export function normalizePageOrigin(originInput: unknown): string {
  if (typeof originInput !== "string" || originInput.length < 1 || originInput.length > 2_048) {
    throw new Error("INVALID_PAGE_ORIGIN");
  }
  try {
    const url = new URL(originInput);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hostname.includes("*") ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("INVALID_PAGE_ORIGIN");
    }
    return url.origin;
  } catch (cause) {
    throw new Error("INVALID_PAGE_ORIGIN", { cause });
  }
}

export function pageOriginPattern(originInput: unknown): string {
  return `${normalizePageOrigin(originInput)}/*`;
}

export class OriginConsentStore {
  readonly #area: OriginConsentStorageArea;
  readonly #permissions: PageOriginPermissionPort;
  readonly #now: () => number;
  readonly #subtle: SubtleCrypto;
  #mutationTail: Promise<void> = Promise.resolve();

  public constructor(options: OriginConsentStoreOptions) {
    this.#area = options.area;
    this.#permissions = options.permissions;
    this.#now = options.now ?? Date.now;
    const subtle = options.subtle ?? globalThis.crypto?.subtle;
    if (subtle === undefined) {
      throw new Error("WEB_CRYPTO_UNAVAILABLE");
    }
    this.#subtle = subtle;
  }

  public async recordAcceptance(input: OriginConsentIdentity): Promise<OriginConsentRecord> {
    const identity = this.#parseIdentity(input);
    const key = await this.#recordKey(identity);
    let result: OriginConsentRecord | undefined;
    await this.#mutate((collection) => {
      result = OriginConsentRecordSchema.parse({
        ...identity,
        disclosureVersion: PAGE_COLLABORATION_DISCLOSURE_VERSION,
        acceptedAtClientMs: AcceptedAtClientMsSchema.parse(this.#now()),
        bundle: "PAGE_COLLABORATION",
        policySyncPending: true,
      });
      collection.records[key] = result;
    });
    return structuredClone(result!);
  }

  public async getEffectiveGrant(input: OriginConsentIdentity): Promise<EffectiveOriginGrant> {
    const identity = this.#parseIdentity(input);
    const [record, browserPermissionGranted] = await Promise.all([
      this.#readCurrentRecord(identity),
      this.#permissions.contains({ origins: [pageOriginPattern(identity.origin)] }),
    ]);
    const termsAccepted = record !== null;
    return {
      record: record === null ? null : structuredClone(record),
      browserPermissionGranted,
      termsAccepted,
      effective: termsAccepted && browserPermissionGranted,
    };
  }

  public async listForProfile(profileIdInput: unknown): Promise<OriginConsentRecord[]> {
    const profileId = ServerProfileIdSchema.parse(profileIdInput);
    await this.#mutationTail;
    const collection = await this.#loadCollection();
    return Object.values(collection.records)
      .flatMap((candidate) => {
        const parsed = OriginConsentRecordSchema.safeParse(candidate);
        return parsed.success && parsed.data.profileId === profileId
          ? [structuredClone(parsed.data)]
          : [];
      })
      .sort(
        (left, right) =>
          left.origin.localeCompare(right.origin) ||
          left.serverTermsVersion.localeCompare(right.serverTermsVersion) ||
          left.acceptedAtClientMs - right.acceptedAtClientMs,
      );
  }

  public async markPolicySynchronized(input: {
    profileId: unknown;
    serverTermsVersion: unknown;
  }): Promise<OriginConsentRecord[]> {
    const profileId = ServerProfileIdSchema.parse(input.profileId);
    const serverTermsVersion = ServerTermsVersionSchema.parse(input.serverTermsVersion);
    await this.#mutate((collection) => {
      for (const candidate of Object.values(collection.records)) {
        if (
          candidate.profileId === profileId &&
          candidate.serverTermsVersion === serverTermsVersion &&
          candidate.disclosureVersion === PAGE_COLLABORATION_DISCLOSURE_VERSION
        ) {
          candidate.policySyncPending = false;
        }
      }
    });
    return this.listForProfile(profileId);
  }

  async #readCurrentRecord(identity: {
    profileId: string;
    origin: string;
    serverTermsVersion: string;
  }): Promise<OriginConsentRecord | null> {
    await this.#mutationTail;
    const collection = await this.#loadCollection();
    const key = await this.#recordKey(identity);
    const parsed = OriginConsentRecordSchema.safeParse(collection.records[key]);
    if (
      !parsed.success ||
      parsed.data.profileId !== identity.profileId ||
      parsed.data.origin !== identity.origin ||
      parsed.data.serverTermsVersion !== identity.serverTermsVersion
    ) {
      return null;
    }
    return structuredClone(parsed.data);
  }

  #parseIdentity(input: OriginConsentIdentity): {
    profileId: string;
    origin: string;
    serverTermsVersion: string;
  } {
    return {
      profileId: ServerProfileIdSchema.parse(input.profileId),
      origin: normalizePageOrigin(input.origin),
      serverTermsVersion: ServerTermsVersionSchema.parse(input.serverTermsVersion),
    };
  }

  async #recordKey(identity: {
    profileId: string;
    origin: string;
    serverTermsVersion: string;
  }): Promise<string> {
    const [originHash, termsHash] = await Promise.all([
      this.#sha256(identity.origin),
      this.#sha256(identity.serverTermsVersion),
    ]);
    return serverScopedStorageKey(
      identity.profileId,
      `origin-consent:${originHash}:server-terms:${termsHash}:disclosure:${PAGE_COLLABORATION_DISCLOSURE_VERSION}`,
    );
  }

  async #sha256(value: string): Promise<string> {
    const bytes = new Uint8Array(
      await this.#subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
    return globalThis
      .btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  }

  async #loadCollection(): Promise<OriginConsentCollection> {
    const stored = await this.#area.get(ORIGIN_CONSENT_STORAGE_KEY);
    const value = stored[ORIGIN_CONSENT_STORAGE_KEY];
    if (value === undefined) {
      return emptyCollection();
    }
    const parsed = OriginConsentCollectionSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("ORIGIN_CONSENT_STATE_INVALID", { cause: parsed.error });
    }
    return parsed.data;
  }

  #mutate(mutation: (collection: OriginConsentCollection) => void): Promise<void> {
    const operation = this.#mutationTail.then(async () => {
      const collection = structuredClone(await this.#loadCollection());
      mutation(collection);
      const parsed = OriginConsentCollectionSchema.parse(collection);
      await this.#area.set({ [ORIGIN_CONSENT_STORAGE_KEY]: parsed });
    });
    this.#mutationTail = operation.catch(() => undefined);
    return operation;
  }
}
