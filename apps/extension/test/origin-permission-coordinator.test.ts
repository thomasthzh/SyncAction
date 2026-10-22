import { describe, expect, it, vi } from "vitest";
import {
  OriginPermissionCoordinator,
  type OriginPermissionBrowserPort,
  type OriginPermissionConsentPort,
  type PermissionIntent,
} from "../src/origin-permission-coordinator.js";
import type { UiPageAccessSlice } from "../src/ui/ui-protocol.js";

const profileId = "server-a";
const roomId = "10000000-0000-4000-8000-000000000001";
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
    policyResult?: boolean | Promise<boolean>;
    refreshResult?: Promise<void>;
    containsResult?: Promise<boolean>;
    consentBarrier?: Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  let current = pageAccess();
  let selectedProfileId = profileId;
  let selectedRoomId: string | null = roomId;
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
        return options.containsResult ?? permissionPreviouslyGranted;
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
      await options.consentBarrier;
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
  const getSelectedRoomId = vi.fn(() => selectedRoomId);
  const resumeFeature = vi.fn(
    async (feature: PermissionIntent["feature"], intent: PermissionIntent) => {
      void intent;
      calls.push(`feature:resume:${feature}`);
    },
  );
  const coordinator = new OriginPermissionCoordinator({
    browser,
    consents,
    getCurrentPageAccess: () => {
      calls.push("page-access:read");
      return structuredClone(current);
    },
    getSelectedProfileId: () => selectedProfileId,
    getSelectedRoomId,
    recordPolicyAcceptance: async () => {
      calls.push("policy:record");
      return options.policyResult ?? true;
    },
    refreshPageAccess: async () => {
      calls.push("page-access:refresh");
      await options.refreshResult;
    },
    resumeFeature,
  });
  return {
    browser,
    calls,
    consents,
    coordinator,
    getSelectedRoomId,
    resumeFeature,
    get current() {
      return current;
    },
    set current(value: UiPageAccessSlice) {
      current = value;
    },
    set selectedProfileId(value: string) {
      selectedProfileId = value;
    },
    set selectedRoomId(value: string | null) {
      selectedRoomId = value;
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
  it("captures the original room before awaiting permission inspection", async () => {
    let resolveContains!: (granted: boolean) => void;
    const harness = createHarness({
      containsResult: new Promise((resolve) => {
        resolveContains = resolve;
      }),
    });
    const pending = harness.coordinator.capture("MEDIA_CONTROL");
    harness.selectedRoomId = "10000000-0000-4000-8000-000000000002";
    resolveContains(false);
    const intent = await pending;
    expect(intent.roomId).toBe(roomId);
    expect(harness.getSelectedRoomId).toHaveBeenCalledTimes(1);
    await expect(harness.coordinator.confirm(intent, true)).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_PERMISSION_INTENT_STALE",
    });
    expect(harness.browser.permissions.request).not.toHaveBeenCalled();
  });

  it("does not start policy logging in a new profile after local consent persistence was delayed", async () => {
    let releaseConsent!: () => void;
    const harness = createHarness({
      consentBarrier: new Promise((resolve) => {
        releaseConsent = resolve;
      }),
    });
    const intent = await harness.coordinator.capture("MEDIA_CONTROL");
    const pending = harness.coordinator.confirm(intent, true);
    await vi.waitFor(() => expect(harness.consents.recordAcceptance).toHaveBeenCalledOnce());
    harness.selectedProfileId = "server-b";
    releaseConsent();
    await expect(pending).resolves.toEqual({
      granted: true,
      errorCode: "PAGE_PERMISSION_INTENT_STALE",
      policySyncPending: true,
    });
    expect(harness.calls).not.toContain("policy:record");
    expect(harness.resumeFeature).not.toHaveBeenCalled();
  });

  for (const stage of ["policy", "refresh"] as const) {
    it.each([
      "profile",
      "room",
      "same-tab origin",
      "document revision",
      "live tab origin",
      "same-origin live URL",
      "live active tab",
    ] as const)(`does not resume a changed %s while awaiting ${stage}`, async (change) => {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const harness = createHarness(
        stage === "policy"
          ? { policyResult: barrier.then(() => true) }
          : { refreshResult: barrier },
      );
      const intent = await harness.coordinator.capture("MEDIA_CONTROL", `${origin}/watch/1`);
      const pending = harness.coordinator.confirm(intent, true);
      await vi.waitFor(() =>
        expect(harness.calls).toContain(
          stage === "policy" ? "policy:record" : "page-access:refresh",
        ),
      );
      if (change === "profile") harness.selectedProfileId = "server-b";
      else if (change === "room") harness.selectedRoomId = "10000000-0000-4000-8000-000000000002";
      else if (change === "same-tab origin")
        harness.current = pageAccess({ origin: "https://other.example" });
      else if (change === "document revision")
        harness.current = pageAccess({
          documentRevision: { ...revision, tabUpdatedAtSeq: revision.tabUpdatedAtSeq + 1 },
        });
      else if (change === "live tab origin")
        harness.activeTab = { id: 42, url: "https://other.example/watch" };
      else if (change === "same-origin live URL")
        harness.activeTab = { id: 42, url: `${origin}/watch/2` };
      else harness.activeTab = { id: 43, url: `${origin}/watch/1` };
      release();
      await expect(pending).resolves.toEqual({
        granted: true,
        errorCode: "PAGE_PERMISSION_INTENT_STALE",
        policySyncPending: false,
      });
      expect(harness.resumeFeature).not.toHaveBeenCalled();
      expect(harness.consents.recordAcceptance).toHaveBeenCalledOnce();
      expect(harness.browser.permissions.remove).not.toHaveBeenCalled();
    });
  }

  it.each([undefined, "10000000-0000-4000-8000-000000000099"])(
    "passes the captured media context and optional join group %s to successful resumption",
    async (mediaJoinGroupId) => {
      const harness = createHarness();
      const captured = await harness.coordinator.capture("MEDIA_CONTROL", `${origin}/watch/1`);
      const intent = {
        ...captured,
        ...(mediaJoinGroupId === undefined ? {} : { mediaJoinGroupId }),
      };
      await expect(harness.coordinator.confirm(intent, true)).resolves.toMatchObject({
        granted: true,
        errorCode: null,
      });
      expect(harness.resumeFeature).toHaveBeenCalledExactlyOnceWith("MEDIA_CONTROL", {
        ...intent,
        roomId,
        url: `${origin}/watch/1`,
      });
    },
  );

  it("rejects a frozen URL that changed during capture even when origin and cached revision stayed the same", async () => {
    let resolveContains!: (granted: boolean) => void;
    const harness = createHarness({
      containsResult: new Promise((resolve) => {
        resolveContains = resolve;
      }),
    });
    const pending = harness.coordinator.capture("MEDIA_CONTROL", `${origin}/watch/1`);
    harness.activeTab = { id: 42, url: `${origin}/watch/2` };
    resolveContains(false);
    await expect(pending).rejects.toThrow("PAGE_PERMISSION_INTENT_STALE");
    expect(harness.browser.permissions.request).not.toHaveBeenCalled();
    expect(harness.resumeFeature).not.toHaveBeenCalled();
  });

  it("rejects a same-origin URL changed during the native prompt before saving consent", async () => {
    let resolveRequest!: (granted: boolean) => void;
    const harness = createHarness({
      requestResult: new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    });
    const intent = await harness.coordinator.capture("MEDIA_CONTROL", `${origin}/watch/1`);
    const pending = harness.coordinator.confirm(intent, true);
    harness.activeTab = { id: 42, url: `${origin}/watch/2` };
    resolveRequest(true);
    await expect(pending).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_CHANGED_DURING_PERMISSION",
    });
    expect(harness.consents.recordAcceptance).not.toHaveBeenCalled();
    expect(harness.resumeFeature).not.toHaveBeenCalled();
    expect(harness.browser.permissions.remove).toHaveBeenCalledWith({ origins: [`${origin}/*`] });
  });

  it("does not capture a media creation task without a selected room", async () => {
    const harness = createHarness();
    harness.selectedRoomId = null;
    await expect(harness.coordinator.capture("MEDIA_CONTROL")).rejects.toThrow(
      "PAGE_PERMISSION_UNAVAILABLE",
    );
    expect(harness.browser.permissions.contains).not.toHaveBeenCalled();
    expect(harness.resumeFeature).not.toHaveBeenCalled();
  });
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
      "page-access:read",
      "policy:record",
      "page-access:refresh",
      "tabs:query",
      "page-access:read",
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
