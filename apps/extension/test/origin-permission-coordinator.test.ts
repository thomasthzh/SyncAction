import { describe, expect, it, vi } from "vitest";
import {
  OriginPermissionCoordinator,
  type OriginPermissionBrowserPort,
  type OriginPermissionConsentPort,
  type PermissionIntent,
} from "../src/origin-permission-coordinator.js";
import type { UiPageAccessSlice } from "../src/ui/ui-protocol.js";

const profileId = "server-a";
const origin = "https://video.example";
const termsVersion = "2026-07-30";
const revision = { roomEpoch: 3, tabUpdatedAtSeq: 18 };

function pageAccess(overrides: Partial<UiPageAccessSlice> = {}): UiPageAccessSlice {
  return {
    bindings: null,
    tabId: 42,
    documentRevision: revision,
    contentCompatibility: "EXACT",
    origin,
    supported: true,
    browserPermissionGranted: false,
    termsAccepted: false,
    serverTermsVersion: termsVersion,
    disclosureVersion: 1,
    enabledFeatures: [],
    policySyncPendingCount: 0,
    reason: "BROWSER_PERMISSION_REQUIRED",
    ...overrides,
  };
}

function createHarness(
  options: {
    permissionPreviouslyGranted?: boolean;
    requestResult?: boolean | Promise<boolean>;
    policyResult?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let current = pageAccess();
  let selectedProfileId = profileId;
  let activeTab = { id: 42, url: `${origin}/watch/1` };
  const permissionPreviouslyGranted = options.permissionPreviouslyGranted ?? false;
  const browser: OriginPermissionBrowserPort = {
    tabs: {
      query: vi.fn(async () => {
        calls.push("tabs:query");
        return [structuredClone(activeTab)];
      }),
    },
    permissions: {
      contains: vi.fn(async (input) => {
        calls.push(`permissions:contains:${input.origins.join(",")}`);
        return permissionPreviouslyGranted;
      }),
      request: vi.fn((input) => {
        calls.push(`permissions:request:${input.origins.join(",")}`);
        return Promise.resolve(options.requestResult ?? true);
      }),
      remove: vi.fn(async (input) => {
        calls.push(`permissions:remove:${input.origins.join(",")}`);
        return true;
      }),
    },
  };
  const consents: OriginPermissionConsentPort = {
    recordAcceptance: vi.fn(async (input) => {
      calls.push(`consent:record:${input.profileId}:${input.origin}:${input.serverTermsVersion}`);
      return {
        profileId: String(input.profileId),
        origin: String(input.origin),
        serverTermsVersion: String(input.serverTermsVersion),
        disclosureVersion: 1 as const,
        acceptedAtClientMs: 1,
        bundle: "PAGE_COLLABORATION" as const,
        policySyncPending: true,
      };
    }),
  };
  const coordinator = new OriginPermissionCoordinator({
    browser,
    consents,
    getCurrentPageAccess: () => {
      calls.push("page-access:read");
      return structuredClone(current);
    },
    getSelectedProfileId: () => selectedProfileId,
    recordPolicyAcceptance: async () => {
      calls.push("policy:record");
      return options.policyResult ?? true;
    },
    refreshPageAccess: async () => {
      calls.push("page-access:refresh");
    },
    resumeFeature: async (feature) => {
      calls.push(`feature:resume:${feature}`);
    },
  });
  return {
    browser,
    calls,
    consents,
    coordinator,
    get current() {
      return current;
    },
    set current(value: UiPageAccessSlice) {
      current = value;
    },
    set selectedProfileId(value: string) {
      selectedProfileId = value;
    },
    set activeTab(value: { id: number; url: string }) {
      activeTab = value;
    },
  };
}

async function capture(harness: ReturnType<typeof createHarness>): Promise<PermissionIntent> {
  return harness.coordinator.capture("DANMAKU");
}

describe("OriginPermissionCoordinator", () => {
  it("keeps the native request in the click stack and follows the exact safe call order", async () => {
    let resolveRequest: (value: boolean) => void = () => undefined;
    const requestResult = new Promise<boolean>((resolve) => {
      resolveRequest = resolve;
    });
    const harness = createHarness({ requestResult });
    const intent = await capture(harness);

    expect(harness.calls).toEqual(["page-access:read", `permissions:contains:${origin}/*`]);

    const confirmation = harness.coordinator.confirm(intent, true);
    expect(harness.calls.at(-2)).toBe("page-access:read");
    expect(harness.calls.at(-1)).toBe(`permissions:request:${origin}/*`);

    resolveRequest(true);
    await expect(confirmation).resolves.toEqual({
      granted: true,
      errorCode: null,
      policySyncPending: false,
    });
    expect(harness.calls).toEqual([
      "page-access:read",
      `permissions:contains:${origin}/*`,
      "page-access:read",
      `permissions:request:${origin}/*`,
      "tabs:query",
      "page-access:read",
      `consent:record:${profileId}:${origin}:${termsVersion}`,
      "policy:record",
      "page-access:refresh",
      "feature:resume:DANMAKU",
    ]);
  });

  it("never requests permission without a checked agreement or with stale cached context", async () => {
    const unchecked = createHarness();
    const uncheckedIntent = await capture(unchecked);
    await expect(unchecked.coordinator.confirm(uncheckedIntent, false)).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_PERMISSION_AGREEMENT_REQUIRED",
    });
    expect(unchecked.browser.permissions.request).not.toHaveBeenCalled();

    const changed = createHarness();
    const changedIntent = await capture(changed);
    changed.current = pageAccess({ tabId: 43 });
    await expect(changed.coordinator.confirm(changedIntent, true)).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_PERMISSION_INTENT_STALE",
    });
    expect(changed.browser.permissions.request).not.toHaveBeenCalled();
  });

  it("records nothing when the user denies the native browser prompt", async () => {
    const harness = createHarness({ requestResult: false });
    const intent = await capture(harness);

    await expect(harness.coordinator.confirm(intent, true)).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_PERMISSION_DENIED",
    });

    expect(harness.consents.recordAcceptance).not.toHaveBeenCalled();
    expect(harness.browser.permissions.remove).not.toHaveBeenCalled();
  });

  it("removes only a newly granted wrong-origin permission after the prompt", async () => {
    let resolveRequest: (value: boolean) => void = () => undefined;
    const harness = createHarness({
      requestResult: new Promise<boolean>((resolve) => {
        resolveRequest = resolve;
      }),
    });
    const intent = await capture(harness);
    const confirmation = harness.coordinator.confirm(intent, true);
    harness.activeTab = { id: 42, url: "https://other.example/watch" };
    harness.current = pageAccess({
      origin: "https://other.example",
    });
    resolveRequest(true);

    await expect(confirmation).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_CHANGED_DURING_PERMISSION",
    });
    expect(harness.browser.permissions.remove).toHaveBeenCalledWith({
      origins: [`${origin}/*`],
    });
    expect(harness.consents.recordAcceptance).not.toHaveBeenCalled();
  });

  it("does not request or later remove a permission that existed before the intent", async () => {
    const harness = createHarness({ permissionPreviouslyGranted: true });
    const intent = await capture(harness);
    harness.activeTab = { id: 43, url: `${origin}/other` };

    await expect(harness.coordinator.confirm(intent, true)).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_CHANGED_DURING_PERMISSION",
    });

    expect(harness.browser.permissions.request).not.toHaveBeenCalled();
    expect(harness.browser.permissions.remove).not.toHaveBeenCalled();
    expect(harness.consents.recordAcceptance).not.toHaveBeenCalled();
  });

  it("keeps a valid local grant usable when server policy logging fails", async () => {
    const harness = createHarness({ policyResult: false });
    const intent = await capture(harness);

    await expect(harness.coordinator.confirm(intent, true)).resolves.toEqual({
      granted: true,
      errorCode: null,
      policySyncPending: true,
    });

    expect(harness.consents.recordAcceptance).toHaveBeenCalledOnce();
    expect(harness.calls).toContain("page-access:refresh");
    expect(harness.calls).toContain("feature:resume:DANMAKU");
  });

  it("fails closed for protected pages, missing document identity, or a changed profile", async () => {
    const protectedPage = createHarness();
    protectedPage.current = pageAccess({
      origin: null,
      supported: false,
      browserPermissionGranted: false,
      documentRevision: null,
      enabledFeatures: [],
      reason: "UNSUPPORTED_ORIGIN",
    });
    await expect(protectedPage.coordinator.capture("POINTER")).rejects.toThrow(
      "PAGE_PERMISSION_UNAVAILABLE",
    );
    expect(protectedPage.browser.permissions.request).not.toHaveBeenCalled();

    const missingDocument = createHarness();
    missingDocument.current = pageAccess({
      documentRevision: null,
      reason: "ROOM_DOCUMENT_UNAVAILABLE",
    });
    await expect(missingDocument.coordinator.capture("DRAWING")).rejects.toThrow(
      "PAGE_PERMISSION_UNAVAILABLE",
    );

    const changedProfile = createHarness();
    const intent = await capture(changedProfile);
    changedProfile.selectedProfileId = "server-b";
    await expect(changedProfile.coordinator.confirm(intent, true)).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_PERMISSION_INTENT_STALE",
    });
    expect(changedProfile.browser.permissions.request).not.toHaveBeenCalled();
  });
});
