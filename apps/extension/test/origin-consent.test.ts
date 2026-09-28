import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ORIGIN_CONSENT_STORAGE_KEY,
  PAGE_COLLABORATION_DISCLOSURE_VERSION,
  OriginConsentStore,
  normalizePageOrigin,
  type OriginConsentStorageArea,
  type PageOriginPermissionPort,
} from "../src/origin-consent.js";
import { serverScopedStorageKey } from "../src/scoped-storage.js";

class MemoryArea implements OriginConsentStorageArea {
  public readonly values: Record<string, unknown> = {};
  public readonly writes: Record<string, unknown>[] = [];

  public async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    this.writes.push(structuredClone(items));
    Object.assign(this.values, structuredClone(items));
  }
}

class MemoryPermissions implements PageOriginPermissionPort {
  public readonly granted = new Set<string>();
  public readonly containsCalls: string[][] = [];

  public async contains(input: { origins: string[] }): Promise<boolean> {
    this.containsCalls.push([...input.origins]);
    return input.origins.every((origin) => this.granted.has(origin));
  }
}

const now = 1_785_312_345_678;
const profileA = "server-a";
const profileB = "server-b";
const originA = "https://video.example";
const originB = "https://news.example:8443";
const termsV1 = "2026-07-30";
const termsV2 = "2026-08-15";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function storedRecords(area: MemoryArea): Record<string, unknown> {
  const collection = area.values[ORIGIN_CONSENT_STORAGE_KEY] as
    { records?: Record<string, unknown> } | undefined;
  return collection?.records ?? {};
}

function createHarness(options: { now?: () => number } = {}) {
  const area = new MemoryArea();
  const permissions = new MemoryPermissions();
  const store = new OriginConsentStore({
    area,
    permissions,
    now: options.now ?? (() => now),
  });
  return { area, permissions, store };
}

describe("normalizePageOrigin", () => {
  it.each([
    ["https://example.com", "https://example.com"],
    ["https://example.com:443", "https://example.com"],
    ["http://example.com:80", "http://example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
  ])("normalizes exact HTTP/HTTPS origin %s", (input, expected) => {
    expect(normalizePageOrigin(input)).toBe(expected);
  });

  it.each([
    "https://example.com/path",
    "https://example.com?query=1",
    "https://example.com#fragment",
    "https://user@example.com",
    "https://user:secret@example.com",
    "https://*.example.com",
    "*://example.com",
    "ftp://example.com",
    "file:///tmp/example",
    "chrome://settings",
    "not a url",
  ])("rejects non-origin or unsupported input %s", (input) => {
    expect(() => normalizePageOrigin(input)).toThrow("INVALID_PAGE_ORIGIN");
  });
});

describe("OriginConsentStore", () => {
  it("keys records by profile, exact normalized origin, terms, and disclosure version", async () => {
    const { area, store } = createHarness();

    const record = await store.recordAcceptance({
      profileId: profileA,
      origin: "https://video.example:443",
      serverTermsVersion: termsV1,
    });

    const expectedKey = serverScopedStorageKey(
      profileA,
      `origin-consent:${digest(originA)}:server-terms:${digest(termsV1)}:disclosure:${PAGE_COLLABORATION_DISCLOSURE_VERSION}`,
    );
    expect(Object.keys(storedRecords(area))).toEqual([expectedKey]);
    expect(record).toEqual({
      profileId: profileA,
      origin: originA,
      serverTermsVersion: termsV1,
      disclosureVersion: 1,
      acceptedAtClientMs: now,
      bundle: "PAGE_COLLABORATION",
      policySyncPending: true,
    });
  });

  it("requires both current versioned consent and the browser host grant", async () => {
    const { permissions, store } = createHarness();
    permissions.granted.add(`${originA}/*`);
    await store.recordAcceptance({
      profileId: profileA,
      origin: originA,
      serverTermsVersion: termsV1,
    });

    await expect(
      store.getEffectiveGrant({
        profileId: profileA,
        origin: originA,
        serverTermsVersion: termsV1,
      }),
    ).resolves.toMatchObject({
      effective: true,
      browserPermissionGranted: true,
      termsAccepted: true,
    });
    await expect(
      store.getEffectiveGrant({
        profileId: profileA,
        origin: originA,
        serverTermsVersion: termsV2,
      }),
    ).resolves.toMatchObject({
      effective: false,
      browserPermissionGranted: true,
      termsAccepted: false,
    });
    await expect(
      store.getEffectiveGrant({
        profileId: profileB,
        origin: originA,
        serverTermsVersion: termsV1,
      }),
    ).resolves.toMatchObject({
      effective: false,
      browserPermissionGranted: true,
      termsAccepted: false,
    });
  });

  it("does not inherit a record written for another local disclosure version", async () => {
    const { area, permissions, store } = createHarness();
    permissions.granted.add(`${originA}/*`);
    await store.recordAcceptance({
      profileId: profileA,
      origin: originA,
      serverTermsVersion: termsV1,
    });
    const collection = area.values[ORIGIN_CONSENT_STORAGE_KEY] as {
      records: Record<string, { disclosureVersion: number }>;
    };
    const stored = Object.values(collection.records)[0];
    if (stored === undefined) {
      throw new Error("missing test record");
    }
    stored.disclosureVersion = PAGE_COLLABORATION_DISCLOSURE_VERSION + 1;

    await expect(
      store.getEffectiveGrant({
        profileId: profileA,
        origin: originA,
        serverTermsVersion: termsV1,
      }),
    ).resolves.toMatchObject({
      effective: false,
      termsAccepted: false,
    });
  });

  it("keeps historical consent after an external permission removal", async () => {
    const { permissions, store } = createHarness();
    permissions.granted.add(`${originA}/*`);
    await store.recordAcceptance({
      profileId: profileA,
      origin: originA,
      serverTermsVersion: termsV1,
    });
    permissions.granted.delete(`${originA}/*`);

    await expect(
      store.getEffectiveGrant({
        profileId: profileA,
        origin: originA,
        serverTermsVersion: termsV1,
      }),
    ).resolves.toMatchObject({
      effective: false,
      browserPermissionGranted: false,
      termsAccepted: true,
    });
    await expect(store.listForProfile(profileA)).resolves.toHaveLength(1);
    expect(permissions.containsCalls.at(-1)).toEqual([`${originA}/*`]);
  });

  it("stores no token, page digest, or unrelated page data", async () => {
    const { area, store } = createHarness();
    await store.recordAcceptance({
      profileId: profileA,
      origin: originA,
      serverTermsVersion: termsV1,
    });

    const serialized = JSON.stringify(area.values[ORIGIN_CONSENT_STORAGE_KEY]);
    expect(serialized).not.toMatch(
      /access.?token|refresh.?token|page.?digest|content.?signature|dom/iu,
    );
    expect(serialized).not.toContain("secret-token");
  });

  it("lists cloned profile-only records sorted by exact origin", async () => {
    let timestamp = now;
    const { store } = createHarness({ now: () => timestamp++ });
    await store.recordAcceptance({
      profileId: profileA,
      origin: originB,
      serverTermsVersion: termsV1,
    });
    await store.recordAcceptance({
      profileId: profileB,
      origin: "https://private.example",
      serverTermsVersion: termsV1,
    });
    await store.recordAcceptance({
      profileId: profileA,
      origin: originA,
      serverTermsVersion: termsV1,
    });

    const listed = await store.listForProfile(profileA);
    expect(listed.map(({ origin }) => origin)).toEqual([originB, originA].sort());
    listed[0]!.origin = "https://mutated.example";
    expect((await store.listForProfile(profileA)).map(({ origin }) => origin)).toEqual(
      [originB, originA].sort(),
    );
  });

  it("marks every matching profile and terms record synchronized without touching others", async () => {
    const { store } = createHarness();
    await store.recordAcceptance({
      profileId: profileA,
      origin: originA,
      serverTermsVersion: termsV1,
    });
    await store.recordAcceptance({
      profileId: profileA,
      origin: originB,
      serverTermsVersion: termsV1,
    });
    await store.recordAcceptance({
      profileId: profileA,
      origin: "https://future.example",
      serverTermsVersion: termsV2,
    });
    await store.recordAcceptance({
      profileId: profileB,
      origin: originA,
      serverTermsVersion: termsV1,
    });

    await store.markPolicySynchronized({
      profileId: profileA,
      serverTermsVersion: termsV1,
    });

    expect(
      (await store.listForProfile(profileA)).map(
        ({ origin, serverTermsVersion, policySyncPending }) => ({
          origin,
          serverTermsVersion,
          policySyncPending,
        }),
      ),
    ).toEqual([
      { origin: "https://future.example", serverTermsVersion: termsV2, policySyncPending: true },
      { origin: originB, serverTermsVersion: termsV1, policySyncPending: false },
      { origin: originA, serverTermsVersion: termsV1, policySyncPending: false },
    ]);
    expect((await store.listForProfile(profileB))[0]?.policySyncPending).toBe(true);
  });
});
