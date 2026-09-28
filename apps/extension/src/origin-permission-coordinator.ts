import type { DocumentRevision } from "@syncaction/protocol";
import type { OriginConsentRecord, OriginConsentIdentity } from "./origin-consent.js";
import { normalizePageOrigin, pageOriginPattern } from "./origin-consent.js";
import { ServerProfileIdSchema } from "./server-profile.js";
import { PageFeatureSchema, type PageFeature, type UiPageAccessSlice } from "./ui/ui-protocol.js";

export interface OriginPermissionBrowserTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
}

export interface OriginPermissionBrowserPort {
  tabs: {
    query(input: {
      active: true;
      lastFocusedWindow: true;
    }): Promise<readonly OriginPermissionBrowserTab[]>;
  };
  permissions: {
    contains(input: { origins: string[] }): Promise<boolean>;
    request(input: { origins: string[] }): Promise<boolean>;
    remove(input: { origins: string[] }): Promise<boolean>;
  };
}

export interface OriginPermissionConsentPort {
  recordAcceptance(input: OriginConsentIdentity): Promise<OriginConsentRecord>;
}

export interface PermissionIntent {
  profileId: string;
  tabId: number;
  origin: string;
  documentRevision: DocumentRevision;
  feature: PageFeature;
  serverTermsVersion: string;
  disclosureVersion: 1;
  permissionPreviouslyGranted: boolean;
}

export interface PermissionConfirmation {
  granted: boolean;
  errorCode: string | null;
  policySyncPending: boolean;
}

export interface OriginPermissionCoordinatorOptions {
  browser: OriginPermissionBrowserPort;
  consents: OriginPermissionConsentPort;
  getCurrentPageAccess(): UiPageAccessSlice;
  getSelectedProfileId(): string;
  recordPolicyAcceptance(): Promise<boolean>;
  refreshPageAccess(): Promise<unknown>;
  resumeFeature(feature: PageFeature): Promise<unknown>;
}

function rejected(errorCode: string): PermissionConfirmation {
  return { granted: false, errorCode, policySyncPending: false };
}

function sameRevision(left: DocumentRevision, right: DocumentRevision | null): boolean {
  return (
    right !== null &&
    left.roomEpoch === right.roomEpoch &&
    left.tabUpdatedAtSeq === right.tabUpdatedAtSeq
  );
}

function tabOrigin(tab: OriginPermissionBrowserTab | undefined): string | null {
  const candidate = tab?.pendingUrl ?? tab?.url;
  if (candidate === undefined) {
    return null;
  }
  try {
    const url = new URL(candidate);
    return normalizePageOrigin(url.origin);
  } catch {
    return null;
  }
}

export class OriginPermissionCoordinator {
  readonly #browser: OriginPermissionBrowserPort;
  readonly #consents: OriginPermissionConsentPort;
  readonly #getCurrentPageAccess: () => UiPageAccessSlice;
  readonly #getSelectedProfileId: () => string;
  readonly #recordPolicyAcceptance: () => Promise<boolean>;
  readonly #refreshPageAccess: () => Promise<unknown>;
  readonly #resumeFeature: (feature: PageFeature) => Promise<unknown>;

  public constructor(options: OriginPermissionCoordinatorOptions) {
    this.#browser = options.browser;
    this.#consents = options.consents;
    this.#getCurrentPageAccess = options.getCurrentPageAccess;
    this.#getSelectedProfileId = options.getSelectedProfileId;
    this.#recordPolicyAcceptance = options.recordPolicyAcceptance;
    this.#refreshPageAccess = options.refreshPageAccess;
    this.#resumeFeature = options.resumeFeature;
  }

  public async capture(featureInput: unknown): Promise<PermissionIntent> {
    const feature = PageFeatureSchema.parse(featureInput);
    const access = this.#getCurrentPageAccess();
    const profileId = ServerProfileIdSchema.parse(this.#getSelectedProfileId());
    if (
      access.tabId === null ||
      access.origin === null ||
      !access.supported ||
      access.documentRevision === null ||
      access.serverTermsVersion === null ||
      access.disclosureVersion !== 1
    ) {
      throw new Error("PAGE_PERMISSION_UNAVAILABLE");
    }
    const permissionPreviouslyGranted = await this.#browser.permissions.contains({
      origins: [pageOriginPattern(access.origin)],
    });
    return {
      profileId,
      tabId: access.tabId,
      origin: normalizePageOrigin(access.origin),
      documentRevision: structuredClone(access.documentRevision),
      feature,
      serverTermsVersion: access.serverTermsVersion,
      disclosureVersion: 1,
      permissionPreviouslyGranted,
    };
  }

  public confirm(intent: PermissionIntent, agreed: boolean): Promise<PermissionConfirmation> {
    if (!agreed) {
      return Promise.resolve(rejected("PAGE_PERMISSION_AGREEMENT_REQUIRED"));
    }
    if (!this.#matchesCurrent(intent)) {
      return Promise.resolve(rejected("PAGE_PERMISSION_INTENT_STALE"));
    }

    const originPattern = pageOriginPattern(intent.origin);
    let permissionResult: Promise<boolean>;
    try {
      permissionResult = intent.permissionPreviouslyGranted
        ? Promise.resolve(true)
        : this.#browser.permissions.request({ origins: [originPattern] });
    } catch {
      return Promise.resolve(rejected("PAGE_PERMISSION_REQUEST_FAILED"));
    }

    return permissionResult.then(
      (granted) =>
        granted
          ? this.#completeConfirmation(intent, originPattern)
          : rejected("PAGE_PERMISSION_DENIED"),
      () => rejected("PAGE_PERMISSION_REQUEST_FAILED"),
    );
  }

  #matchesCurrent(intent: PermissionIntent): boolean {
    let profileId: string;
    try {
      profileId = ServerProfileIdSchema.parse(this.#getSelectedProfileId());
    } catch {
      return false;
    }
    const access = this.#getCurrentPageAccess();
    return (
      profileId === intent.profileId &&
      access.tabId === intent.tabId &&
      access.origin === intent.origin &&
      access.supported &&
      access.serverTermsVersion === intent.serverTermsVersion &&
      access.disclosureVersion === intent.disclosureVersion &&
      sameRevision(intent.documentRevision, access.documentRevision)
    );
  }

  async #completeConfirmation(
    intent: PermissionIntent,
    originPattern: string,
  ): Promise<PermissionConfirmation> {
    const tab = (
      await this.#browser.tabs.query({
        active: true,
        lastFocusedWindow: true,
      })
    )[0];
    if (
      tab?.id !== intent.tabId ||
      tabOrigin(tab) !== intent.origin ||
      !this.#matchesCurrent(intent)
    ) {
      if (!intent.permissionPreviouslyGranted) {
        await this.#browser.permissions.remove({ origins: [originPattern] }).catch(() => false);
      }
      return rejected("PAGE_CHANGED_DURING_PERMISSION");
    }

    try {
      await this.#consents.recordAcceptance({
        profileId: intent.profileId,
        origin: intent.origin,
        serverTermsVersion: intent.serverTermsVersion,
      });
    } catch {
      if (!intent.permissionPreviouslyGranted) {
        await this.#browser.permissions.remove({ origins: [originPattern] }).catch(() => false);
      }
      return rejected("PAGE_CONSENT_PERSIST_FAILED");
    }

    let policySyncPending: boolean;
    try {
      policySyncPending = !(await this.#recordPolicyAcceptance());
    } catch {
      policySyncPending = true;
    }

    let activationError: string | null = null;
    try {
      await this.#refreshPageAccess();
      await this.#resumeFeature(intent.feature);
    } catch {
      activationError = "PAGE_PERMISSION_ACTIVATION_FAILED";
    }
    return {
      granted: true,
      errorCode: activationError,
      policySyncPending,
    };
  }
}
