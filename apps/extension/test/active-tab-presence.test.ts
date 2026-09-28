import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  PageCompatibilityReportSchema,
  PresenceAckSchema,
  PresenceDeltaMessageSchema,
  PresenceSnapshotMessageSchema,
  PresenceSnapshotV2MessageSchema,
  RoomSnapshotStateSchema,
  type PresenceDeltaMessage,
  type ContentSignature,
  type MediaIdentity,
  type PresenceRecordV2,
  type PresenceSnapshotMessage,
  type PresenceSnapshotV2Message,
  type PresenceUpdate,
  type PresenceUpdateV2,
} from "@syncaction/protocol";
import { ReplicaRecordSchema, type ReplicaRecord } from "@syncaction/replica";
import { beforeEach, describe, expect, it } from "vitest";
import { ActiveTabPresenceController, type PresenceScheduler } from "../src/active-tab-presence.js";
import type { PresenceMessageHandler, PresenceTransport } from "../src/socket-transport.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789b01";
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b02");
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789b03";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b04");
const remoteUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b05";
const localUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b06";
let now = 1_785_104_000_000;

function record(
  overrides: {
    browserSessionId?: string;
    tabId?: number;
    mode?: ReplicaRecord["mode"];
  } = {},
): ReplicaRecord {
  const snapshot = RoomSnapshotStateSchema.parse({
    roomId,
    roomEpoch: 0,
    serverSeq: 1,
    order: [logicalTabId],
    tabs: [
      {
        id: logicalTabId,
        url: "https://example.com/",
        createdAtSeq: 1,
        updatedAtSeq: 1,
        closedAtSeq: null,
      },
    ],
  });
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId,
    mode: overrides.mode ?? "SYNCED",
    confirmedSnapshot: snapshot,
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: [
      {
        logicalTabId,
        tabId: overrides.tabId ?? 7,
        windowId: 1,
        groupId: 2,
        browserSessionId: overrides.browserSessionId ?? browserSessionId,
        validatedAtServerSeq: 1,
      },
    ],
    quarantineReason: null,
    updatedAtMs: now,
  });
}

class FakeScheduler implements PresenceScheduler {
  public callback: (() => void) | undefined;
  public intervalMs: number | undefined;
  public clearCount = 0;

  public setInterval(callback: () => void, intervalMs: number): unknown {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return 1;
  }

  public clearInterval(): void {
    this.clearCount += 1;
    this.callback = undefined;
  }

  public tick(): void {
    this.callback?.();
  }
}

class FakePresenceTransport implements PresenceTransport {
  public handler: PresenceMessageHandler | undefined;
  public readonly updates: Array<PresenceUpdate | PresenceUpdateV2> = [];
  public failure: Error | undefined;

  public setPresenceHandler(handler: PresenceMessageHandler | undefined): void {
    this.handler = handler;
  }

  public async publishPresence(update: PresenceUpdate | PresenceUpdateV2) {
    this.updates.push(update);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return PresenceAckSchema.parse({
      type: "presence.ack",
      protocolVersion: 1,
      roomId,
      expiresAt: now + 30_000,
    });
  }
}

let currentRecord: ReplicaRecord;
let scheduler: FakeScheduler;
let transport: FakePresenceTransport;
let presence: ActiveTabPresenceController;
let roomSyncRequests: number;
let remotePresenceChanges: string[][];

beforeEach(() => {
  now = 1_785_104_000_000;
  currentRecord = record();
  scheduler = new FakeScheduler();
  transport = new FakePresenceTransport();
  roomSyncRequests = 0;
  remotePresenceChanges = [];
  presence = new ActiveTabPresenceController({
    roomId,
    browserSessionId,
    userId: localUserId,
    deviceId,
    replica: { getRecord: async () => currentRecord },
    transport,
    scheduler,
    now: () => now,
    requestRoomSync: async () => {
      roomSyncRequests += 1;
    },
    onRemotePresenceChanged: async (logicalTabIds) => {
      remotePresenceChanges.push([...logicalTabIds]);
    },
  });
});

describe("ActiveTabPresenceController", () => {
  it("publishes online-outside immediately and renews every ten seconds", async () => {
    await presence.setSynchronized(true);

    expect(transport.updates).toEqual([expect.objectContaining({ roomId, logicalTabId: null })]);
    expect(scheduler.intervalMs).toBe(10_000);
    scheduler.tick();
    await presence.whenIdle();
    expect(transport.updates).toHaveLength(2);
    expect(presence.getStatus()).toMatchObject({
      state: "ONLINE",
      lastAckExpiresAt: now + 30_000,
    });
  });

  it("maps only an exact current-session tab binding to a logical tab", async () => {
    await presence.handleActiveTabChanged(7);
    await presence.setSynchronized(true);
    expect(transport.updates.at(-1)?.logicalTabId).toBe(logicalTabId);

    currentRecord = record({
      browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789b06",
    });
    await presence.handleBindingsChanged();
    expect(transport.updates.at(-1)?.logicalTabId).toBeNull();

    currentRecord = record({ tabId: 8 });
    await presence.handleBindingsChanged();
    expect(transport.updates.at(-1)?.logicalTabId).toBeNull();
  });

  it("publishes a v2 private content context only after an authorized current report", async () => {
    await presence.handleActiveTabChanged(7);
    await presence.setSynchronized(true);
    expect(transport.updates.at(-1)).toMatchObject({
      type: "presence.update",
      logicalTabId,
    });

    await expect(
      presence.handlePageCompatibilityReport(7, compatibilityReport("A".repeat(43))),
    ).resolves.toBe(true);
    expect(transport.updates.at(-1)).toEqual({
      type: "presence.update.v2",
      protocolVersion: 1,
      roomId,
      logicalTabId,
      contentContext: {
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
        canonicalPageIdentity: "https://example.com/",
        contentSignature: {
          signatureVersion: 1,
          digest: "A".repeat(43),
        },
        media: null,
      },
    });

    await expect(
      presence.handlePageCompatibilityReport(8, compatibilityReport("B".repeat(43))),
    ).resolves.toBe(false);
    await expect(
      presence.handlePageCompatibilityReport(
        7,
        compatibilityReport("B".repeat(43), { roomEpoch: 0, tabUpdatedAtSeq: 2 }),
      ),
    ).resolves.toBe(false);
    expect(transport.updates.at(-1)?.type).toBe("presence.update.v2");
  });

  it("exposes only the exact current local content signature as a clone", async () => {
    await presence.handleActiveTabChanged(7);
    await presence.setSynchronized(true);
    expect(
      presence.getLocalContentSignature({
        roomId,
        logicalTabId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      }),
    ).toBeNull();

    await presence.handlePageCompatibilityReport(7, compatibilityReport("A".repeat(43)));
    const signature = presence.getLocalContentSignature({
      roomId,
      logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
    });
    expect(signature).toEqual({ signatureVersion: 1, digest: "A".repeat(43) });
    if (signature !== null) {
      signature.digest = "B".repeat(43);
    }
    expect(
      presence.getLocalContentSignature({
        roomId,
        logicalTabId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      }),
    ).toEqual({ signatureVersion: 1, digest: "A".repeat(43) });
    expect(
      presence.getLocalContentSignature({
        roomId,
        logicalTabId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 2 },
      }),
    ).toBeNull();
  });

  it("classifies each remote account/device against the current authorized report", async () => {
    await presence.handleActiveTabChanged(7);
    await presence.setSynchronized(true);
    await presence.handlePageCompatibilityReport(7, compatibilityReport("A".repeat(43)));
    transport.handler?.(
      snapshotV2(4, now + 30_000, {
        contentSignature: { signatureVersion: 1, digest: "A".repeat(43) },
      }),
    );
    expect(presence.getStatus().compatibilities).toEqual([
      {
        userId: remoteUserId,
        deviceId,
        logicalTabId,
        compatibility: "EXACT",
        warning: false,
      },
    ]);

    transport.handler?.(
      snapshotV2(5, now + 30_000, {
        contentSignature: { signatureVersion: 1, digest: "B".repeat(43) },
      }),
    );
    expect(presence.getStatus().compatibilities?.[0]).toMatchObject({
      compatibility: "MISMATCH",
      warning: true,
    });

    transport.handler?.(
      snapshotV2(6, now + 30_000, {
        contentSignature: null,
      }),
    );
    expect(presence.getStatus().compatibilities?.[0]).toMatchObject({
      compatibility: "UNKNOWN",
      warning: true,
    });
  });

  it("serializes remote presence change notifications for compatibility reconciliation", async () => {
    await presence.setSynchronized(true);

    transport.handler?.(
      snapshotV2(4, now + 30_000, {
        contentSignature: { signatureVersion: 1, digest: "A".repeat(43) },
      }),
    );
    await presence.whenIdle();
    expect(remotePresenceChanges).toEqual([[logicalTabId]]);

    transport.handler?.(
      deltaV2(4, {
        kind: "REMOVE",
        userId: remoteUserId,
        deviceId,
      }),
    );
    await presence.whenIdle();
    expect(remotePresenceChanges).toEqual([[logicalTabId], [logicalTabId]]);
  });

  it("does not treat the local account/device presence as a compatible remote observer", async () => {
    await presence.handleActiveTabChanged(7);
    await presence.setSynchronized(true);
    await presence.handlePageCompatibilityReport(7, compatibilityReport("A".repeat(43)));
    transport.handler?.(
      PresenceSnapshotV2MessageSchema.parse({
        type: "presence.snapshot.v2",
        protocolVersion: 1,
        roomId,
        presenceSeq: 4,
        presences: [
          {
            ...v2Presence(now + 30_000, {
              contentSignature: { signatureVersion: 1, digest: "A".repeat(43) },
            }),
            userId: localUserId,
          },
        ],
      }),
    );
    await presence.whenIdle();

    expect(presence.getStatus().presences).toHaveLength(1);
    expect(presence.getStatus().compatibilities).toEqual([]);
    expect(remotePresenceChanges).toEqual([]);
    expect(
      presence.hasCompatibleRemotePointerObserver({
        logicalTabId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      }),
    ).toBe(false);
    expect(
      presence.canRenderRemotePointer({
        logicalTabId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
        remoteUserId: localUserId,
        remoteDeviceId: deviceId,
      }),
    ).toBe(false);
  });

  it("allows known matching media across randomized page content while blocking positional data", async () => {
    const media: MediaIdentity = {
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
    };
    await presence.handleActiveTabChanged(7);
    await presence.setSynchronized(true);
    await presence.handlePageCompatibilityReport(
      7,
      compatibilityReport("A".repeat(43), undefined, media),
    );
    transport.handler?.(
      snapshotV2(4, now + 30_000, {
        contentSignature: { signatureVersion: 1, digest: "B".repeat(43) },
        media,
      }),
    );

    expect(
      presence.canRenderRemotePointer({
        logicalTabId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
        remoteUserId,
        remoteDeviceId: deviceId,
      }),
    ).toBe(false);
    expect(
      presence.canSynchronizeKnownMedia({
        target: {
          logicalTabId,
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
          frameKey: "top",
          provider: "YOUTUBE",
          mediaKey: media.mediaKey,
          durationMs: 212_000,
        },
        remoteUserId,
        remoteDeviceId: deviceId,
      }),
    ).toBe(true);
    expect(
      presence.canSynchronizeKnownMedia({
        target: {
          logicalTabId,
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
          frameKey: "top",
          provider: "YOUTUBE",
          mediaKey: "youtube:9bZkp7q19f0",
          durationMs: 212_000,
        },
        remoteUserId,
        remoteDeviceId: deviceId,
      }),
    ).toBe(false);
  });

  it("revokes local compatibility before permission-boundary cleanup", async () => {
    await presence.handleActiveTabChanged(7);
    await presence.setSynchronized(true);
    await presence.handlePageCompatibilityReport(7, compatibilityReport("A".repeat(43)));

    await presence.handlePermissionBoundaryChanged();

    expect(transport.updates.at(-1)).toEqual({
      type: "presence.update",
      protocolVersion: 1,
      roomId,
      logicalTabId,
    });
    expect(presence.getStatus().compatibilities).toEqual([]);
  });

  it("accepts only current, matching-room snapshots and prunes expired leases", async () => {
    await presence.setSynchronized(true);
    const valid = snapshot(roomId, now + 30_000);
    transport.handler?.(valid);
    expect(presence.getStatus().presences).toHaveLength(1);

    transport.handler?.(snapshot("018f8f8e-4b5c-7d6e-8f90-123456789b07", now + 30_000));
    expect(presence.getStatus().presences).toHaveLength(1);
    now += 30_000;
    expect(presence.getStatus().presences).toEqual([]);
  });

  it("applies contiguous v2 upserts and removals by account and device", async () => {
    await presence.setSynchronized(true);
    transport.handler?.(snapshotV2(4, now + 30_000));
    expect(presence.getStatus().presences).toEqual([
      expect.objectContaining({
        userId: remoteUserId,
        deviceId,
        logicalTabId,
      }),
    ]);

    transport.handler?.(
      deltaV2(4, {
        kind: "UPSERT",
        presence: {
          ...v2Presence(now + 40_000),
          logicalTabId: null,
          contentContext: null,
        },
      }),
    );
    expect(presence.getStatus().presences).toEqual([
      expect.objectContaining({
        userId: remoteUserId,
        deviceId,
        logicalTabId: null,
        expiresAt: now + 40_000,
      }),
    ]);

    transport.handler?.(
      deltaV2(5, {
        kind: "REMOVE",
        userId: remoteUserId,
        deviceId,
      }),
    );
    expect(presence.getStatus().presences).toEqual([]);
    expect(roomSyncRequests).toBe(0);
  });

  it("keeps visible state on a delta gap and requests one snapshot before accepting deltas", async () => {
    await presence.setSynchronized(true);
    transport.handler?.(snapshotV2(2, now + 30_000));
    const beforeGap = presence.getStatus().presences;

    transport.handler?.(
      deltaV2(3, {
        kind: "REMOVE",
        userId: remoteUserId,
        deviceId,
      }),
    );
    transport.handler?.(
      deltaV2(4, {
        kind: "REMOVE",
        userId: remoteUserId,
        deviceId,
      }),
    );
    await presence.whenIdle();
    expect(presence.getStatus().presences).toEqual(beforeGap);
    expect(roomSyncRequests).toBe(1);

    transport.handler?.(snapshotV2(5, now + 40_000));
    transport.handler?.(
      deltaV2(5, {
        kind: "REMOVE",
        userId: remoteUserId,
        deviceId,
      }),
    );
    expect(presence.getStatus().presences).toEqual([]);
  });

  it("stops and clears presence before a room becomes non-actuatable", async () => {
    await presence.setSynchronized(true);
    transport.handler?.(snapshot(roomId, now + 30_000));

    await presence.setSynchronized(false);

    expect(scheduler.clearCount).toBe(1);
    expect(presence.getStatus()).toEqual({
      state: "OFFLINE",
      presences: [],
      compatibilities: [],
      lastAckExpiresAt: null,
      errorCode: null,
    });
    scheduler.tick();
    await presence.whenIdle();
    expect(transport.updates).toHaveLength(1);
  });

  it("degrades presence without throwing into the durable replica path", async () => {
    const failure = Object.assign(new Error("rejected"), { code: "ROOM_NOT_FOUND" });
    transport.failure = failure;

    await expect(presence.setSynchronized(true)).resolves.toBeUndefined();

    expect(presence.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "ROOM_NOT_FOUND",
    });
  });

  it("rejects invalid active numeric tab IDs without publishing", async () => {
    await expect(presence.handleActiveTabChanged(-1)).rejects.toThrow("INVALID_ACTIVE_TAB_ID");
    expect(transport.updates).toEqual([]);
  });
});

function snapshot(snapshotRoomId: string, expiresAt: number): PresenceSnapshotMessage {
  return PresenceSnapshotMessageSchema.parse({
    type: "presence.snapshot",
    protocolVersion: 1,
    roomId: snapshotRoomId,
    presences: [
      {
        userId: remoteUserId,
        username: "remote",
        displayName: "Remote",
        deviceId,
        logicalTabId,
        expiresAt,
      },
    ],
  });
}

function v2Presence(
  expiresAt: number,
  contentOverrides: {
    contentSignature?: ContentSignature | null;
    media?: MediaIdentity | null;
  } = {},
): PresenceRecordV2 {
  return {
    userId: remoteUserId,
    username: "remote",
    displayName: "Remote",
    deviceId,
    logicalTabId,
    contentContext: {
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      canonicalPageIdentity: "https://example.com/",
      contentSignature: contentOverrides.contentSignature ?? null,
      media: contentOverrides.media ?? null,
    },
    expiresAt,
  };
}

function snapshotV2(
  presenceSeq: number,
  expiresAt: number,
  contentOverrides: Parameters<typeof v2Presence>[1] = {},
): PresenceSnapshotV2Message {
  return PresenceSnapshotV2MessageSchema.parse({
    type: "presence.snapshot.v2",
    protocolVersion: 1,
    roomId,
    presenceSeq,
    presences: [v2Presence(expiresAt, contentOverrides)],
  });
}

function compatibilityReport(
  digest: string,
  documentRevision = { roomEpoch: 0, tabUpdatedAtSeq: 1 },
  media: MediaIdentity | null = null,
) {
  return PageCompatibilityReportSchema.parse({
    type: "page.compatibility.report",
    protocolVersion: 1,
    logicalTabId,
    contentContext: {
      documentRevision,
      canonicalPageIdentity: "https://example.com/",
      contentSignature: {
        signatureVersion: 1,
        digest,
      },
      media,
    },
  });
}

function deltaV2(
  fromPresenceSeq: number,
  change: PresenceDeltaMessage["changes"][number],
): PresenceDeltaMessage {
  return PresenceDeltaMessageSchema.parse({
    type: "presence.delta.v2",
    protocolVersion: 1,
    roomId,
    fromPresenceSeq,
    toPresenceSeq: fromPresenceSeq + 1,
    changes: [change],
  });
}
