import type { OriginConsentRecord } from "./origin-consent.js";

export interface OriginPolicyRetryStatus {
  phase: string;
  accountId: string | null;
  profileId: string;
  serverTermsVersion: string | null;
}

export interface OriginPolicyRetrySource {
  readStatus(): Promise<OriginPolicyRetryStatus>;
  subscribe(listener: () => void): () => void;
  recordCurrentPolicyAcceptance(): Promise<{
    profileId: string;
    serverTermsVersion: string;
  }>;
  notifyChanged(): Promise<void>;
}

export interface OriginPolicyRetryConsentPort {
  listForProfile(profileId: unknown): Promise<OriginConsentRecord[]>;
  markPolicySynchronized(input: {
    profileId: unknown;
    serverTermsVersion: unknown;
  }): Promise<unknown>;
}

export interface AuthenticatedOriginPolicyRetryOptions {
  source: OriginPolicyRetrySource;
  consents: OriginPolicyRetryConsentPort;
}

export class AuthenticatedOriginPolicyRetry {
  readonly #source: OriginPolicyRetrySource;
  readonly #consents: OriginPolicyRetryConsentPort;
  #unsubscribe: (() => void) | undefined;
  #tail: Promise<void> = Promise.resolve();
  #scheduled = false;
  #disposed = false;
  #attemptedSessionKey: string | null = null;

  public constructor(options: AuthenticatedOriginPolicyRetryOptions) {
    this.#source = options.source;
    this.#consents = options.consents;
  }

  public start(): void {
    if (this.#unsubscribe !== undefined || this.#disposed) {
      return;
    }
    this.#unsubscribe = this.#source.subscribe(() => this.#schedule());
    this.#schedule();
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #schedule(): void {
    if (this.#scheduled || this.#disposed) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#disposed) {
        return;
      }
      const operation = this.#tail.then(() => this.#check());
      this.#tail = operation.catch(() => undefined);
    });
  }

  async #check(): Promise<void> {
    const status = await this.#source.readStatus();
    if (
      status.accountId === null ||
      status.serverTermsVersion === null ||
      status.phase === "SIGNED_OUT" ||
      status.phase === "ACCOUNT_PENDING" ||
      status.phase === "SESSION_EXPIRED"
    ) {
      this.#attemptedSessionKey = null;
      return;
    }
    const sessionKey = `${status.profileId}:${status.accountId}:${status.serverTermsVersion}`;
    if (this.#attemptedSessionKey === sessionKey) {
      return;
    }
    this.#attemptedSessionKey = sessionKey;
    const records = await this.#consents.listForProfile(status.profileId);
    if (
      !records.some(
        (record) =>
          record.serverTermsVersion === status.serverTermsVersion && record.policySyncPending,
      )
    ) {
      return;
    }
    try {
      const acceptance = await this.#source.recordCurrentPolicyAcceptance();
      if (
        acceptance.profileId !== status.profileId ||
        acceptance.serverTermsVersion !== status.serverTermsVersion
      ) {
        return;
      }
      await this.#consents.markPolicySynchronized(acceptance);
      await this.#source.notifyChanged();
    } catch {
      // A failed retry remains represented by the existing local message-center item.
    }
  }
}
