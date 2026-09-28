import { SyncActionApiClient, SyncActionApiError } from "./api-client.js";
import { type VerifiedServerCandidate, VerifiedServerCandidateSchema } from "./server-profile.js";
import {
  PRODUCTION_PUBLIC_SERVER_ORIGIN,
  parsePublicServerOrigin,
  publicServerHostPermission,
} from "./server-origin.js";

export interface ServerHostPermissionApi {
  request(permissions: { origins: string[] }): Promise<boolean>;
}

export interface CustomServerVerifierOptions {
  permissions: ServerHostPermissionApi;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export type { VerifiedServerCandidate };

export interface ServerHealthSample {
  readonly latencyMs: number;
}

export class CustomServerVerifier {
  readonly #permissions: ServerHostPermissionApi;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  public constructor(options: CustomServerVerifierOptions) {
    this.#permissions = options.permissions;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  public async probe(baseUrlInput: unknown): Promise<ServerHealthSample> {
    let baseUrl: string;
    try {
      baseUrl = parsePublicServerOrigin(baseUrlInput);
    } catch (cause) {
      throw new Error("INVALID_SERVER_URL", { cause });
    }
    const startedAt = this.#now();
    const api = new SyncActionApiClient({
      serverUrl: baseUrl,
      fetch: this.#fetch,
    });
    await api.getHealth();
    return { latencyMs: Math.max(0, Math.round(this.#now() - startedAt)) };
  }

  public verifyFromClick(baseUrlInput: unknown): Promise<VerifiedServerCandidate> {
    let baseUrl: string;
    try {
      baseUrl = parsePublicServerOrigin(baseUrlInput);
    } catch (cause) {
      return Promise.reject(new Error("INVALID_SERVER_URL", { cause }));
    }

    let permission: Promise<boolean>;
    try {
      permission =
        baseUrl === PRODUCTION_PUBLIC_SERVER_ORIGIN
          ? Promise.resolve(true)
          : this.#permissions.request({
              origins: [publicServerHostPermission(baseUrl)],
            });
    } catch (cause) {
      return Promise.reject(new Error("SERVER_HOST_PERMISSION_DENIED", { cause }));
    }
    return this.#verifyAfterPermission(baseUrl, permission);
  }

  async #verifyAfterPermission(
    baseUrl: string,
    permission: Promise<boolean>,
  ): Promise<VerifiedServerCandidate> {
    if (!(await permission)) {
      throw new Error("SERVER_HOST_PERMISSION_DENIED");
    }
    const api = new SyncActionApiClient({
      serverUrl: baseUrl,
      fetch: this.#fetch,
    });
    await api.getHealth();
    const healthyAt = this.#now();
    try {
      const metadata = await api.getMeta();
      return VerifiedServerCandidateSchema.parse({
        baseUrl,
        mode: "VNEXT",
        metadata,
        healthyAt,
      });
    } catch (cause) {
      if (cause instanceof SyncActionApiError && cause.status === 404) {
        return VerifiedServerCandidateSchema.parse({
          baseUrl,
          mode: "LEGACY_V081",
          metadata: null,
          healthyAt,
        });
      }
      throw cause;
    }
  }
}
