import {
  AnnotationAckV2Schema as AnnotationAckSchema,
  AnnotationCommittedOperationV2Schema as AnnotationCommittedOperationSchema,
  AnnotationDeltaV2MessageSchema as AnnotationDeltaMessageSchema,
  AnnotationSnapshotV2MessageSchema as AnnotationSnapshotMessageSchema,
  AnnotationStrokeDraftSchema as LegacyAnnotationStrokeDraftSchema,
  AnnotationStrokeDraftV2Schema as AnnotationStrokeDraftSchema,
  type AnnotationOperationV2 as AnnotationOperation,
} from "@syncaction/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AnnotationReplica,
  annotationReplicaStorageKey,
  type AnnotationReplicaStorageArea,
} from "../src/annotation-replica.js";
import { DEFAULT_SERVER_PROFILE_ID } from "../src/server-profile.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789d01";
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789d02";
const actorUserId = "018f8f8e-4b5c-7d6e-8f90-123456789d03";
const otherUserId = "018f8f8e-4b5c-7d6e-8f90-123456789d08";
const strokeId = "018f8f8e-4b5c-7d6e-8f90-123456789d04";
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789d05";
const secondClientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789d06";
const pageKey = "A".repeat(43);
const otherPageKey = "B".repeat(43);
const now = 1_785_120_000_000;
const contentSignature = {
  signatureVersion: 1,
  digest: "S".repeat(43),
};

const context = {
  roomId,
  logicalTabId,
  documentRevision: {
    roomEpoch: 2,
    tabUpdatedAtSeq: 4,
  },
  frameKey: "top",
} as const;

const draft = AnnotationStrokeDraftSchema.parse({
  strokeId,
  frameKey: "top",
  anchor: {
    type: "document",
    layoutSignature: {
      widthCssPx: 1440,
      heightCssPx: 2400,
    },
  },
  points: [
    { x: 0.1, y: 0.2, pressure: 0.5 },
    { x: 0.2, y: 0.3, pressure: 0.7 },
  ],
  rgb: { r: 12, g: 34, b: 56 },
  width: 6,
  contentSignature,
});

const createOperation: AnnotationOperation = {
  type: "stroke.create",
  stroke: draft,
};
const legacyDraftInput: Record<string, unknown> = structuredClone(draft);
Reflect.deleteProperty(legacyDraftInput, "contentSignature");
const legacyDraft = LegacyAnnotationStrokeDraftSchema.parse(legacyDraftInput);

class MemoryArea implements AnnotationReplicaStorageArea {
  public readonly values = new Map<string, unknown>();
  public readonly writes: Array<{ key: string; value: unknown }> = [];

  public async get(key: string): Promise<Record<string, unknown>> {
    return this.values.has(key) ? { [key]: structuredClone(this.values.get(key)) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
      this.writes.push({ key, value: structuredClone(value) });
    }
  }
}

function snapshot(
  input: {
    key?: string;
    annotationSeq?: number;
    includeStroke?: boolean;
  } = {},
) {
  return AnnotationSnapshotMessageSchema.parse({
    type: "annotation.snapshot.v2",
    protocolVersion: 1,
    ...context,
    pageKey: input.key ?? pageKey,
    annotationSeq: input.annotationSeq ?? 0,
    strokes:
      input.includeStroke === true
        ? [
            {
              ...draft,
              authorUserId: actorUserId,
              lockedAtServerMs: null,
              version: 1,
              createdAtServerMs: now,
              deletedAtServerMs: null,
            },
          ]
        : [],
  });
}

function committed(input: { sequence?: number; operationId?: string } = {}) {
  return AnnotationCommittedOperationSchema.parse({
    type: "annotation.committed.v2",
    protocolVersion: 1,
    clientOpId: input.operationId ?? clientOpId,
    roomId,
    pageKey,
    annotationSeq: input.sequence ?? 1,
    actorUserId,
    operation: createOperation,
    results: [
      {
        strokeId,
        accepted: true,
        code: null,
        version: 1,
      },
    ],
    createdAtServerMs: now,
  });
}

let area: MemoryArea;
let replica: AnnotationReplica;

beforeEach(() => {
  area = new MemoryArea();
  replica = new AnnotationReplica({
    area,
    profileId: DEFAULT_SERVER_PROFILE_ID,
    userId: actorUserId,
    now: () => now,
  });
});

describe("AnnotationReplica durable final-operation lifecycle", () => {
  it("persists the local draft and operation before returning it for submission", async () => {
    await replica.applySnapshot(snapshot());

    const queued = await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId,
      operation: createOperation,
      localDraft: draft,
    });

    expect(queued.outbox).toHaveLength(1);
    expect(queued.localDrafts).toEqual([
      {
        clientOpId,
        draft,
        status: "PENDING",
        errorCode: null,
      },
    ]);
    expect(area.writes.at(-1)).toMatchObject({
      key: annotationReplicaStorageKey(DEFAULT_SERVER_PROFILE_ID, actorUserId, roomId, pageKey),
      value: {
        outbox: [{ clientOpId, operation: createOperation, state: "QUEUED" }],
        localDrafts: [{ clientOpId, draft }],
      },
    });
  });

  it("durably retries and discards a failed local draft with its outbox operation", async () => {
    await replica.applySnapshot(snapshot());
    await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId,
      operation: createOperation,
      localDraft: draft,
    });
    const failed = await replica.markTransportFailure(roomId, pageKey, clientOpId);
    expect(failed.localDrafts[0]).toMatchObject({
      status: "ERROR",
      errorCode: "ANNOTATION_OFFLINE",
    });

    const retried = await replica.retryLocalDraft(roomId, pageKey, strokeId);
    expect(retried.localDrafts[0]).toMatchObject({
      status: "PENDING",
      errorCode: null,
    });
    expect(retried.outbox[0]).toMatchObject({
      state: "QUEUED",
      acknowledgement: null,
      errorCode: null,
    });

    const discarded = await replica.discardLocalDraft(roomId, pageKey, strokeId);
    expect(discarded.localDrafts).toEqual([]);
    expect(discarded.outbox).toEqual([]);
    expect((await replica.load(roomId, pageKey)).localDrafts).toEqual([]);
  });

  it("does not retry a terminal server rejection with the same operation ID", async () => {
    await replica.applySnapshot(snapshot());
    await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId,
      operation: createOperation,
      localDraft: draft,
    });
    await replica.applyAcknowledgement(
      pageKey,
      AnnotationAckSchema.parse({
        type: "annotation.ack.v2",
        protocolVersion: 1,
        clientOpId,
        roomId,
        accepted: false,
        code: "ANNOTATION_CLIENT_OP_REUSE",
        pageKey,
        annotationSeq: null,
        results: [],
      }),
    );

    await expect(replica.retryLocalDraft(roomId, pageKey, strokeId)).rejects.toThrow(
      "ANNOTATION_DRAFT_NOT_RETRYABLE",
    );
    expect((await replica.load(roomId, pageKey)).localDrafts).toMatchObject([
      {
        status: "ERROR",
        errorCode: "ANNOTATION_CLIENT_OP_REUSE",
      },
    ]);
  });

  it("keeps an accepted draft until a committed operation or covering snapshot confirms it", async () => {
    await replica.applySnapshot(snapshot());
    await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId,
      operation: createOperation,
      localDraft: draft,
    });
    const acknowledgement = AnnotationAckSchema.parse({
      type: "annotation.ack.v2",
      protocolVersion: 1,
      clientOpId,
      roomId,
      accepted: true,
      code: null,
      pageKey,
      annotationSeq: 1,
      results: [
        {
          strokeId,
          accepted: true,
          code: null,
          version: 1,
        },
      ],
    });

    const acknowledged = await replica.applyAcknowledgement(pageKey, acknowledgement);
    expect(acknowledged.outbox).toMatchObject([
      {
        clientOpId,
        state: "ACKNOWLEDGED",
        acknowledgement: {
          accepted: true,
          annotationSeq: 1,
        },
      },
    ]);
    expect(acknowledged.localDrafts).toHaveLength(1);

    const confirmed = await replica.applyCommitted(committed());
    expect(confirmed.kind).toBe("APPLIED");
    expect(confirmed.record.outbox).toEqual([]);
    expect(confirmed.record.localDrafts).toEqual([]);
    expect(confirmed.record.confirmedSnapshot?.strokes).toHaveLength(1);
  });

  it("dedupes an ACK-lost restart by retaining the same client operation ID until snapshot confirmation", async () => {
    await replica.applySnapshot(snapshot());
    await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId,
      operation: createOperation,
      localDraft: draft,
    });

    const restarted = new AnnotationReplica({
      area,
      profileId: DEFAULT_SERVER_PROFILE_ID,
      userId: actorUserId,
      now: () => now + 1,
    });
    const pending = await restarted.getRetryableOperations(roomId, pageKey);
    expect(pending).toEqual([
      {
        clientOpId,
        frameKey: "top",
        baseAnnotationSeq: 0,
        operation: createOperation,
      },
    ]);

    const recovered = await restarted.applySnapshot(
      snapshot({ annotationSeq: 1, includeStroke: true }),
    );
    expect(recovered.outbox).toEqual([]);
    expect(recovered.localDrafts).toEqual([]);
    expect(recovered.confirmedSnapshot?.annotationSeq).toBe(1);
  });
});

describe("AnnotationReplica recovery and isolation", () => {
  it("isolates the same user, room, and page between server profiles", async () => {
    const first = new AnnotationReplica({
      area,
      profileId: "server-a",
      userId: actorUserId,
      now: () => now,
    });
    const second = new AnnotationReplica({
      area,
      profileId: "server-b",
      userId: actorUserId,
      now: () => now + 1,
    });

    await first.applySnapshot(snapshot({ annotationSeq: 1 }));
    await second.applySnapshot(snapshot({ annotationSeq: 7 }));

    expect((await first.load(roomId, pageKey)).confirmedSnapshot?.annotationSeq).toBe(1);
    expect((await second.load(roomId, pageKey)).confirmedSnapshot?.annotationSeq).toBe(7);
  });

  it("migrates a v2 annotation record only into the default server profile", async () => {
    const legacyKey = `syncaction.annotation-replica.v2.${actorUserId}.${roomId}.${pageKey}`;
    area.values.set(legacyKey, {
      schemaVersion: 2,
      userId: actorUserId,
      roomId,
      pageKey,
      mode: "SYNCED",
      confirmedSnapshot: {
        annotationSeq: 4,
        strokes: [],
      },
      outbox: [],
      localDrafts: [],
      quarantineReason: null,
      updatedAtMs: now - 1,
    });

    const migrated = await replica.load(roomId, pageKey);

    expect(migrated).toMatchObject({
      schemaVersion: 3,
      profileId: DEFAULT_SERVER_PROFILE_ID,
      confirmedSnapshot: { annotationSeq: 4 },
    });
    expect(
      area.values.get(
        annotationReplicaStorageKey(DEFAULT_SERVER_PROFILE_ID, actorUserId, roomId, pageKey),
      ),
    ).toEqual(migrated);

    const custom = new AnnotationReplica({
      area,
      profileId: "server-a",
      userId: actorUserId,
      now: () => now + 1,
    });
    expect((await custom.load(roomId, pageKey)).confirmedSnapshot).toBeNull();
  });

  it("upgrades an unsigned v0.8.1 confirmed snapshot without rewriting its geometry", async () => {
    const storageKey = annotationReplicaStorageKey(
      DEFAULT_SERVER_PROFILE_ID,
      actorUserId,
      roomId,
      pageKey,
    );
    const legacyStroke = {
      ...legacyDraft,
      authorUserId: actorUserId,
      lockedAtServerMs: null,
      version: 1,
      createdAtServerMs: now - 10,
      deletedAtServerMs: null,
    };
    area.values.set(storageKey, {
      schemaVersion: 3,
      profileId: DEFAULT_SERVER_PROFILE_ID,
      userId: actorUserId,
      roomId,
      pageKey,
      mode: "SYNCED",
      confirmedSnapshot: {
        annotationSeq: 4,
        strokes: [legacyStroke],
      },
      outbox: [],
      localDrafts: [],
      quarantineReason: null,
      updatedAtMs: now - 1,
    });

    const migrated = await replica.load(roomId, pageKey);

    expect(migrated).toMatchObject({
      mode: "SYNCED",
      confirmedSnapshot: {
        annotationSeq: 4,
        strokes: [{ ...legacyStroke, contentSignature: null }],
      },
    });
    expect(area.values.get(storageKey)).toEqual(migrated);
  });

  it("quarantines an unreadable record without overwriting potentially recoverable raw drafts", async () => {
    const storageKey = annotationReplicaStorageKey(
      DEFAULT_SERVER_PROFILE_ID,
      actorUserId,
      roomId,
      pageKey,
    );
    const raw = {
      schemaVersion: 999,
      userId: actorUserId,
      roomId,
      pageKey,
      localDrafts: [{ clientOpId, draft }],
      futureField: "preserve-me",
    };
    area.values.set(storageKey, structuredClone(raw));

    const quarantined = await replica.load(roomId, pageKey);

    expect(quarantined).toMatchObject({
      mode: "QUARANTINED",
      quarantineReason: "CORRUPT_ANNOTATION_REPLICA",
    });
    expect(area.values.get(storageKey)).toEqual(raw);
    expect(area.writes).toEqual([]);
  });

  it("never regresses or rewrites an equal-sequence authoritative snapshot", async () => {
    await replica.applySnapshot(snapshot({ annotationSeq: 2, includeStroke: true }));

    await expect(
      replica.applySnapshot(snapshot({ annotationSeq: 1, includeStroke: false })),
    ).rejects.toThrow("ANNOTATION_SNAPSHOT_REGRESSION");
    await expect(
      replica.applySnapshot(snapshot({ annotationSeq: 2, includeStroke: false })),
    ).rejects.toThrow("ANNOTATION_SNAPSHOT_CONFLICT");

    const retained = await replica.load(roomId, pageKey);
    expect(retained.confirmedSnapshot?.annotationSeq).toBe(2);
    expect(retained.confirmedSnapshot?.strokes).toHaveLength(1);
  });

  it("removes a replayed mutation after its dedupe ACK is already covered by a full snapshot", async () => {
    await replica.applySnapshot(snapshot({ annotationSeq: 1, includeStroke: true }));
    const deleteOperation: AnnotationOperation = {
      type: "stroke.delete",
      items: [{ strokeId, expectedVersion: 1 }],
    };
    await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId: secondClientOpId,
      operation: deleteOperation,
      frameKey: "top",
    });
    await replica.applySnapshot(snapshot({ annotationSeq: 2, includeStroke: false }));

    const recovered = await replica.applyAcknowledgement(
      pageKey,
      AnnotationAckSchema.parse({
        type: "annotation.ack.v2",
        protocolVersion: 1,
        clientOpId: secondClientOpId,
        roomId,
        accepted: true,
        code: null,
        pageKey,
        annotationSeq: 2,
        results: [
          {
            strokeId,
            accepted: true,
            code: null,
            version: 2,
          },
        ],
      }),
    );

    expect(recovered.outbox).toEqual([]);
  });

  it("does not retain terminally rejected mutations without a user-visible draft", async () => {
    await replica.applySnapshot(snapshot({ annotationSeq: 1, includeStroke: true }));
    const deleteOperation: AnnotationOperation = {
      type: "stroke.delete",
      items: [{ strokeId, expectedVersion: 1 }],
    };
    await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId: secondClientOpId,
      operation: deleteOperation,
      frameKey: "top",
    });

    const rejected = await replica.applyAcknowledgement(
      pageKey,
      AnnotationAckSchema.parse({
        type: "annotation.ack.v2",
        protocolVersion: 1,
        clientOpId: secondClientOpId,
        roomId,
        accepted: false,
        code: "DOCUMENT_UNAUTHORIZED",
        pageKey,
        annotationSeq: null,
        results: [],
      }),
    );

    expect(rejected.outbox).toEqual([]);
  });

  it("requests a full snapshot on a sequence gap without applying the out-of-order delta", async () => {
    await replica.applySnapshot(snapshot());
    const gap = AnnotationDeltaMessageSchema.parse({
      type: "annotation.delta.v2",
      protocolVersion: 1,
      ...context,
      pageKey,
      fromAnnotationSeq: 2,
      toAnnotationSeq: 3,
      operations: [committed({ sequence: 3 })],
    });

    const result = await replica.applyDelta(gap);
    expect(result.kind).toBe("SNAPSHOT_REQUIRED");
    expect(result.record.mode).toBe("RECOVERING");
    expect(result.record.confirmedSnapshot?.annotationSeq).toBe(0);
    expect(result.record.confirmedSnapshot?.strokes).toEqual([]);
  });

  it("keeps drafts and confirmed state isolated by page key", async () => {
    await replica.applySnapshot(snapshot());
    await replica.applySnapshot(snapshot({ key: otherPageKey }));
    await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId,
      operation: createOperation,
      localDraft: draft,
    });
    await replica.enqueueFinalOperation({
      roomId,
      pageKey: otherPageKey,
      clientOpId: secondClientOpId,
      operation: {
        type: "stroke.create",
        stroke: {
          ...draft,
          strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789d07",
        },
      },
      localDraft: {
        ...draft,
        strokeId: "018f8f8e-4b5c-7d6e-8f90-123456789d07",
      },
    });

    const first = await replica.load(roomId, pageKey);
    const second = await replica.load(roomId, otherPageKey);
    expect(first.localDrafts.map((item) => item.clientOpId)).toEqual([clientOpId]);
    expect(second.localDrafts.map((item) => item.clientOpId)).toEqual([secondClientOpId]);

    await replica.applyCommitted(committed());
    expect((await replica.load(roomId, pageKey)).localDrafts).toEqual([]);
    expect((await replica.load(roomId, otherPageKey)).localDrafts).toHaveLength(1);
  });

  it("never exposes or replays one account's drafts from another account", async () => {
    await replica.applySnapshot(snapshot());
    await replica.enqueueFinalOperation({
      roomId,
      pageKey,
      clientOpId,
      operation: createOperation,
      localDraft: draft,
    });

    const otherAccount = new AnnotationReplica({
      area,
      profileId: DEFAULT_SERVER_PROFILE_ID,
      userId: otherUserId,
      now: () => now + 1,
    });
    await otherAccount.applySnapshot(snapshot());

    expect(await otherAccount.getRetryableOperations(roomId, pageKey)).toEqual([]);
    expect((await otherAccount.load(roomId, pageKey)).localDrafts).toEqual([]);
    expect((await replica.load(roomId, pageKey)).localDrafts).toHaveLength(1);
    expect(
      area.values.has(
        annotationReplicaStorageKey(DEFAULT_SERVER_PROFILE_ID, actorUserId, roomId, pageKey),
      ),
    ).toBe(true);
    expect(
      area.values.has(
        annotationReplicaStorageKey(DEFAULT_SERVER_PROFILE_ID, otherUserId, roomId, pageKey),
      ),
    ).toBe(true);
  });

  it("quarantines only the corrupt annotation record and leaves the durable tab replica untouched", async () => {
    const annotationKey = annotationReplicaStorageKey(
      DEFAULT_SERVER_PROFILE_ID,
      actorUserId,
      roomId,
      pageKey,
    );
    const durableTabKey = `syncaction.replica.v1.${roomId}`;
    const durableTabReplica = {
      schemaVersion: 1,
      roomId,
      mode: "SYNCED",
      sentinel: "must-survive",
    };
    area.values.set(annotationKey, {
      schemaVersion: 1,
      roomId,
      pageKey,
      confirmedSnapshot: "corrupt",
    });
    area.values.set(durableTabKey, durableTabReplica);

    const quarantined = await replica.load(roomId, pageKey);
    expect(quarantined.mode).toBe("QUARANTINED");
    expect(quarantined.quarantineReason).toBe("CORRUPT_ANNOTATION_REPLICA");
    expect(area.values.get(durableTabKey)).toEqual(durableTabReplica);
    expect(area.writes.every((write) => write.key !== durableTabKey)).toBe(true);
  });
});
