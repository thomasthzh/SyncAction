import { describe, expect, it, vi } from "vitest";
import {
  AuthenticatedOriginPolicyRetry,
  type OriginPolicyRetryStatus,
} from "../src/origin-policy-retry.js";
import type { OriginConsentRecord } from "../src/origin-consent.js";

const pendingRecord: OriginConsentRecord = {
  profileId: "server-a",
  origin: "https://video.example",
  serverTermsVersion: "2026-07-30",
  disclosureVersion: 1,
  acceptedAtClientMs: 1,
  bundle: "PAGE_COLLABORATION",
  policySyncPending: true,
};

function authenticated(): OriginPolicyRetryStatus {
  return {
    phase: "AUTHENTICATED_NO_ROOM",
    accountId: "00000000-0000-4000-8000-000000000001",
    profileId: "server-a",
    serverTermsVersion: "2026-07-30",
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

describe("AuthenticatedOriginPolicyRetry", () => {
  it("retries pending policy records once when an authenticated session is restored", async () => {
    let status = authenticated();
    let listener: (() => void) | undefined;
    const listForProfile = vi.fn(async () => [pendingRecord]);
    const recordCurrentPolicyAcceptance = vi.fn(async () => ({
      profileId: "server-a",
      serverTermsVersion: "2026-07-30",
    }));
    const markPolicySynchronized = vi.fn(async () => []);
    const retry = new AuthenticatedOriginPolicyRetry({
      source: {
        readStatus: async () => status,
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        recordCurrentPolicyAcceptance,
        notifyChanged: vi.fn(async () => undefined),
      },
      consents: { listForProfile, markPolicySynchronized },
    });

    retry.start();
    await settle();

    expect(recordCurrentPolicyAcceptance).toHaveBeenCalledOnce();
    expect(markPolicySynchronized).toHaveBeenCalledWith({
      profileId: "server-a",
      serverTermsVersion: "2026-07-30",
    });

    listener?.();
    await settle();
    expect(recordCurrentPolicyAcceptance).toHaveBeenCalledOnce();

    status = {
      phase: "SIGNED_OUT",
      accountId: null,
      profileId: "server-a",
      serverTermsVersion: "2026-07-30",
    };
    listener?.();
    await settle();
    status = authenticated();
    listener?.();
    await settle();
    expect(recordCurrentPolicyAcceptance).toHaveBeenCalledTimes(2);
    retry.dispose();
  });

  it("does not retry later-created pending records until the next authenticated session", async () => {
    let status = authenticated();
    let listener: (() => void) | undefined;
    let records: OriginConsentRecord[] = [];
    const recordCurrentPolicyAcceptance = vi.fn(async () => ({
      profileId: "server-a",
      serverTermsVersion: "2026-07-30",
    }));
    const retry = new AuthenticatedOriginPolicyRetry({
      source: {
        readStatus: async () => status,
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
        recordCurrentPolicyAcceptance,
        notifyChanged: async () => undefined,
      },
      consents: {
        listForProfile: async () => structuredClone(records),
        markPolicySynchronized: async () => [],
      },
    });
    retry.start();
    await settle();
    records = [pendingRecord];
    listener?.();
    await settle();
    expect(recordCurrentPolicyAcceptance).not.toHaveBeenCalled();

    status = { ...authenticated(), accountId: null, phase: "SIGNED_OUT" };
    listener?.();
    await settle();
    status = authenticated();
    listener?.();
    await settle();
    expect(recordCurrentPolicyAcceptance).toHaveBeenCalledOnce();
  });

  it("does not create a retry loop when the server call fails", async () => {
    let listener: (() => void) | undefined;
    const recordCurrentPolicyAcceptance = vi.fn(async () => {
      throw new Error("NETWORK_ERROR");
    });
    const retry = new AuthenticatedOriginPolicyRetry({
      source: {
        readStatus: async () => authenticated(),
        subscribe: (next) => {
          listener = next;
          return () => undefined;
        },
        recordCurrentPolicyAcceptance,
        notifyChanged: async () => undefined,
      },
      consents: {
        listForProfile: async () => [pendingRecord],
        markPolicySynchronized: async () => [],
      },
    });

    retry.start();
    await settle();
    listener?.();
    listener?.();
    await settle();

    expect(recordCurrentPolicyAcceptance).toHaveBeenCalledOnce();
  });
});
