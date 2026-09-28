import { createHash } from "node:crypto";
import { RoomIdSchema } from "@syncaction/protocol";
import { createReplicaRecord, replicaStorageKey } from "@syncaction/replica";
import { describe, expect, it, vi } from "vitest";
import { annotationReplicaStorageKey } from "../src/annotation-replica.js";
import {
  ChromeReplicaPersistence,
  type ChromeStorageArea,
} from "../src/chrome-replica-persistence.js";
import {
  ExtensionSessionManager,
  type ExtensionSessionStorageArea,
  type PublicSessionResponse,
} from "../src/product-session.js";
import {
  ORIGIN_CONSENT_STORAGE_KEY,
  OriginConsentStore,
  type OriginConsentStorageArea,
} from "../src/origin-consent.js";
import { serverScopedStorageKey } from "../src/scoped-storage.js";

const profiles = ["server-a", "server-b"] as const;
const userId = "10000000-0000-4000-8000-000000000001";
const roomId = RoomIdSchema.parse("20000000-0000-4000-8000-000000000001");
const logicalTabId = "30000000-0000-4000-8000-000000000001";
const sessionId = "40000000-0000-4000-8000-000000000001";
const deviceId = "50000000-0000-4000-8000-000000000001";
const notificationId = "60000000-0000-4000-8000-000000000001";
const pageKey = createHash("sha256").update("same-page").digest("base64url");

class MemoryArea
  implements ExtensionSessionStorageArea, ChromeStorageArea, OriginConsentStorageArea
{
  public readonly values: Record<string, unknown> = {};

  public async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: structuredClone(this.values[key]) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items));
  }

  public async remove(key: string): Promise<void> {
    delete this.values[key];
  }
}

function sessionResponse(marker: string): PublicSessionResponse {
  return {
    sessionId,
    accessToken: `access-${marker}`,
    refreshToken: marker.repeat(43),
    expiresInSeconds: 900,
    refreshExpiresInSeconds: 2_592_000,
    account: {
      id: userId,
      username: "same-user",
      displayName: `User ${marker}`,
      status: "ACTIVE",
      passwordResetRequired: false,
      createdAt: "2026-07-30T00:00:00.000Z",
    },
  };
}

describe("vNext two-profile isolation acceptance", () => {
  it("keeps reused remote IDs below the selected server profile through 100 switches", async () => {
    const area = new MemoryArea();
    const sessions = new ExtensionSessionManager({
      area,
      rotate: vi.fn(),
      now: () => 1_785_312_345_678,
    });
    const replicaLogicalKey = replicaStorageKey(roomId);
    const consent = new OriginConsentStore({
      area,
      permissions: { contains: async () => true },
      now: () => 1_785_312_345_678,
    });

    for (const [index, profileId] of profiles.entries()) {
      const marker = index === 0 ? "A" : "B";
      await sessions.establish({
        profileId,
        serverUrl: `https://${profileId}.example`,
        serverId: `${index + 7}0000000-0000-4000-8000-000000000001`,
        deviceId,
        response: sessionResponse(marker),
      });
      const persistence = new ChromeReplicaPersistence(area, { profileId });
      await persistence.write(replicaLogicalKey, createReplicaRecord(roomId, index + 1));
      const logicalRecords = {
        durableState: {
          key: serverScopedStorageKey(profileId, `durable-state:${roomId}`),
          value: {
            logicalTabId,
            snapshot: `snapshot-${marker}`,
            outbox: [`outbox-${marker}`],
            effectLedger: [`effect-${marker}`],
          },
        },
        annotation: {
          key: annotationReplicaStorageKey(profileId, userId, roomId, pageKey),
          value: `annotation-${marker}`,
        },
        notification: {
          key: serverScopedStorageKey(profileId, `notification-cursor:${userId}`),
          value: { notificationId, cursor: index + 1 },
        },
        selection: {
          key: serverScopedStorageKey(profileId, `room-selection:${userId}`),
          value: { roomId },
        },
        ui: {
          key: serverScopedStorageKey(profileId, `ui-snapshot:${userId}`),
          value: { marker, roomId, logicalTabId },
        },
      };
      await area.set(
        Object.fromEntries(
          Object.values(logicalRecords).map(({ key, value }) => [key, structuredClone(value)]),
        ),
      );
      await consent.recordAcceptance({
        profileId,
        origin: "https://same-page.example",
        serverTermsVersion: "2026-07-30",
      });
    }

    for (let switchIndex = 0; switchIndex < 100; switchIndex += 1) {
      const profileId = profiles[switchIndex % profiles.length]!;
      const marker = profileId === "server-a" ? "A" : "B";
      const persistence = new ChromeReplicaPersistence(area, { profileId });
      await expect(sessions.read(profileId)).resolves.toMatchObject({
        profileId,
        accessToken: `access-${marker}`,
        account: { id: userId, displayName: `User ${marker}` },
      });
      await expect(persistence.read(replicaLogicalKey)).resolves.toMatchObject({
        roomId,
        updatedAtMs: profileId === "server-a" ? 1 : 2,
      });
      expect(area.values[serverScopedStorageKey(profileId, `durable-state:${roomId}`)]).toEqual({
        logicalTabId,
        snapshot: `snapshot-${marker}`,
        outbox: [`outbox-${marker}`],
        effectLedger: [`effect-${marker}`],
      });
      expect(area.values[annotationReplicaStorageKey(profileId, userId, roomId, pageKey)]).toBe(
        `annotation-${marker}`,
      );
      expect(
        area.values[serverScopedStorageKey(profileId, `notification-cursor:${userId}`)],
      ).toMatchObject({ notificationId, cursor: profileId === "server-a" ? 1 : 2 });
      expect(area.values[serverScopedStorageKey(profileId, `room-selection:${userId}`)]).toEqual({
        roomId,
      });
      expect(area.values[serverScopedStorageKey(profileId, `ui-snapshot:${userId}`)]).toMatchObject(
        {
          marker,
        },
      );
      await expect(consent.listForProfile(profileId)).resolves.toEqual([
        expect.objectContaining({ profileId, origin: "https://same-page.example" }),
      ]);
    }

    const scopedKeys = Object.keys(area.values).filter((key) =>
      key.startsWith("syncaction.server."),
    );
    expect(scopedKeys).toHaveLength(12);
    for (const profileId of profiles) {
      expect(
        scopedKeys.filter((key) => key.startsWith(`syncaction.server.${profileId}.`)),
      ).toHaveLength(6);
    }
    const consentCollection = area.values[ORIGIN_CONSENT_STORAGE_KEY] as {
      records: Record<string, { profileId: string }>;
    };
    for (const profileId of profiles) {
      expect(
        Object.keys(consentCollection.records).some((key) =>
          key.startsWith(`syncaction.server.${profileId}.`),
        ),
      ).toBe(true);
    }
    expect(
      Object.values(consentCollection.records)
        .map(({ profileId }) => profileId)
        .sort(),
    ).toEqual([...profiles]);
  });
});
