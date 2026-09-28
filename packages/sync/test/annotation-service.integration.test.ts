import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import {
  AnnotationOperationV2Schema,
  AnnotationOperationSchema,
  AnnotationSubmitSchema,
  AnnotationSubmitV2Schema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  serializedAnnotationStrokeBytes,
  type AnnotationOperation,
  type AnnotationOperationV2,
  type AnnotationSubmit,
  type AnnotationSubmitV2,
  type PresenceRecord,
} from "@syncaction/protocol";
import {
  AnnotationPageKeyDeriver,
  AnnotationService,
  MediaServiceError,
  type AuthorizedDocument,
  type DocumentAuthorizationPort,
  type PresencePrincipal,
} from "../src/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const ownerId = "018f8f8e-4b5c-4d6e-8f90-523456789a01";
const memberId = "018f8f8e-4b5c-4d6e-8f90-523456789a02";
const otherMemberId = "018f8f8e-4b5c-4d6e-8f90-523456789a03";
const ownerDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-523456789a04");
const memberDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-523456789a05");
const otherDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-523456789a06");
const roomId = RoomIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-523456789a07");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-4d6e-8f90-523456789a08");
const stableFrameKey = "frame:sha256-0123456789abcdef0123456789abcdef";
const revision = { roomEpoch: 0, tabUpdatedAtSeq: 12 } as const;
const canonicalPageIdentity = "youtube:dQw4w9WgXcQ";
const hmacKey = new Uint8Array(32).fill(17);
const pageKeys = new AnnotationPageKeyDeriver(hmacKey);
const pageKey = pageKeys.derive({ roomId, canonicalPageIdentity });
const fixedNow = new Date("2026-07-28T00:00:00.000Z");
let db: ReturnType<typeof createDatabase>;

function principal(userId = ownerId): PresencePrincipal {
  if (userId === memberId) {
    return {
      userId,
      deviceId: memberDeviceId,
      sessionId: "018f8f8e-4b5c-4d6e-8f90-523456789a12",
    };
  }
  if (userId === otherMemberId) {
    return {
      userId,
      deviceId: otherDeviceId,
      sessionId: "018f8f8e-4b5c-4d6e-8f90-523456789a13",
    };
  }
  return {
    userId,
    deviceId: ownerDeviceId,
    sessionId: "018f8f8e-4b5c-4d6e-8f90-523456789a11",
  };
}

function memberRecord(userId: string): PresenceRecord {
  const selected =
    userId === ownerId
      ? { username: "owner", displayName: "Owner", deviceId: ownerDeviceId }
      : userId === memberId
        ? { username: "member", displayName: "Member", deviceId: memberDeviceId }
        : { username: "other", displayName: "Other", deviceId: otherDeviceId };
  return {
    userId,
    ...selected,
    logicalTabId,
    expiresAt: fixedNow.getTime() + 30_000,
  };
}

class FakeDocumentAuthorization implements DocumentAuthorizationPort {
  public async authorize(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    frameKey?: unknown;
  }): Promise<AuthorizedDocument> {
    const expectedSocket = `socket-${input.principal.userId}`;
    if (
      input.socketId !== expectedSocket ||
      input.roomId !== roomId ||
      input.logicalTabId !== logicalTabId ||
      JSON.stringify(input.documentRevision) !== JSON.stringify(revision) ||
      input.frameKey !== stableFrameKey ||
      ![ownerId, memberId, otherMemberId].includes(input.principal.userId)
    ) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }
    return {
      roomId,
      logicalTabId,
      documentRevision: revision,
      canonicalPageIdentity,
      role: input.principal.userId === ownerId ? "OWNER" : "MEMBER",
      frameKey: stableFrameKey,
      member: memberRecord(input.principal.userId),
    };
  }

  public async authorizeRoomDocument(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    frameKey?: unknown;
  }): Promise<AuthorizedDocument> {
    return this.authorize(input);
  }

  public async authorizeRoom(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
  }): Promise<PresenceRecord> {
    if (input.roomId !== roomId || input.socketId !== `socket-${input.principal.userId}`) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }
    return memberRecord(input.principal.userId);
  }

  public hasRoomEntries(roomIdInput: unknown): boolean {
    return roomIdInput === roomId;
  }

  public async isRoomActive(roomIdInput: unknown): Promise<boolean> {
    return roomIdInput === roomId;
  }
}

function service(deltaLimit = 1_000): AnnotationService {
  return new AnnotationService({
    db,
    authorization: new FakeDocumentAuthorization(),
    pageKeys,
    now: () => fixedNow,
    deltaLimit,
  });
}

function strokeCreate(strokeId = randomUUID(), width = 5): AnnotationOperation {
  return AnnotationOperationSchema.parse({
    type: "stroke.create",
    stroke: {
      strokeId,
      frameKey: stableFrameKey,
      anchor: {
        type: "document",
        layoutSignature: { widthCssPx: 1_440, heightCssPx: 5_000 },
      },
      points: [
        { x: 0.1, y: 0.2, pressure: 0.5 },
        { x: 0.2, y: 0.3, pressure: 0.7 },
      ],
      rgb: { r: 31, g: 140, b: 255 },
      width,
    },
  });
}

function mutation(
  type: "stroke.delete" | "stroke.lock" | "stroke.unlock",
  items: Array<{ strokeId: string; expectedVersion: number }>,
): AnnotationOperation {
  return AnnotationOperationSchema.parse({ type, items });
}

function submission(
  operation: AnnotationOperation,
  options: {
    clientOpId?: string;
    baseAnnotationSeq?: number;
    suppliedPageKey?: string;
  } = {},
): AnnotationSubmit {
  return AnnotationSubmitSchema.parse({
    protocolVersion: 1,
    clientOpId: options.clientOpId ?? randomUUID(),
    roomId,
    logicalTabId,
    documentRevision: revision,
    frameKey: stableFrameKey,
    pageKey: options.suppliedPageKey ?? pageKey,
    baseAnnotationSeq: options.baseAnnotationSeq ?? 0,
    operation,
  });
}

function v2StrokeCreate(
  strokeId = randomUUID(),
  digest = "S".repeat(43),
): Extract<AnnotationOperationV2, { type: "stroke.create" }> {
  return AnnotationOperationV2Schema.parse({
    type: "stroke.create",
    stroke: {
      strokeId,
      frameKey: stableFrameKey,
      anchor: {
        type: "document",
        layoutSignature: { widthCssPx: 1_440, heightCssPx: 5_000 },
      },
      points: [
        { x: 0.1, y: 0.2, pressure: 0.5 },
        { x: 0.2, y: 0.3, pressure: 0.7 },
      ],
      rgb: { r: 31, g: 140, b: 255 },
      width: 5,
      contentSignature: { digest, signatureVersion: 1 },
    },
  }) as Extract<AnnotationOperationV2, { type: "stroke.create" }>;
}

function v2Submission(
  operation: AnnotationOperationV2,
  options: {
    clientOpId?: string;
    baseAnnotationSeq?: number;
    suppliedPageKey?: string;
  } = {},
): AnnotationSubmitV2 {
  return AnnotationSubmitV2Schema.parse({
    type: "annotation.submit.v2",
    protocolVersion: 1,
    clientOpId: options.clientOpId ?? randomUUID(),
    roomId,
    logicalTabId,
    documentRevision: revision,
    frameKey: stableFrameKey,
    pageKey: options.suppliedPageKey ?? pageKey,
    baseAnnotationSeq: options.baseAnnotationSeq ?? 0,
    operation,
  });
}

async function submit(actorUserId: string, value: AnnotationSubmit, annotationService = service()) {
  return annotationService.submit({
    mode: "LEGACY",
    principal: principal(actorUserId),
    socketId: `socket-${actorUserId}`,
    submission: value,
  });
}

async function submitV2(
  actorUserId: string,
  value: AnnotationSubmitV2,
  annotationService = service(),
) {
  return annotationService.submit({
    mode: "V2",
    principal: principal(actorUserId),
    socketId: `socket-${actorUserId}`,
    submission: value,
  });
}

async function sync(
  actorUserId = ownerId,
  options: { lastAnnotationSeq?: number; hasConfirmedSnapshot?: boolean } = {},
  annotationService = service(),
) {
  return annotationService.synchronize({
    mode: "LEGACY",
    principal: principal(actorUserId),
    socketId: `socket-${actorUserId}`,
    request: {
      protocolVersion: 1,
      roomId,
      logicalTabId,
      documentRevision: revision,
      frameKey: stableFrameKey,
      lastAnnotationSeq: options.lastAnnotationSeq ?? 0,
      hasConfirmedSnapshot: options.hasConfirmedSnapshot ?? false,
    },
  });
}

async function syncV2(
  actorUserId = ownerId,
  options: { lastAnnotationSeq?: number; hasConfirmedSnapshot?: boolean } = {},
  annotationService = service(),
) {
  return annotationService.synchronize({
    mode: "V2",
    principal: principal(actorUserId),
    socketId: `socket-${actorUserId}`,
    request: {
      protocolVersion: 1,
      roomId,
      logicalTabId,
      documentRevision: revision,
      frameKey: stableFrameKey,
      lastAnnotationSeq: options.lastAnnotationSeq ?? 0,
      hasConfirmedSnapshot: options.hasConfirmedSnapshot ?? false,
    },
  });
}

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
});

afterAll(async () => {
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await db.destroy();
});

beforeEach(async () => {
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  await db
    .insertInto("users")
    .values([
      {
        id: ownerId,
        username: "annotation-owner",
        usernameNormalized: "annotation-owner",
        displayName: "Owner",
        passwordHash: "hash",
        status: "ACTIVE",
      },
      {
        id: memberId,
        username: "annotation-member",
        usernameNormalized: "annotation-member",
        displayName: "Member",
        passwordHash: "hash",
        status: "ACTIVE",
      },
      {
        id: otherMemberId,
        username: "annotation-other",
        usernameNormalized: "annotation-other",
        displayName: "Other",
        passwordHash: "hash",
        status: "ACTIVE",
      },
    ])
    .execute();
  await db
    .insertInto("rooms")
    .values({
      id: roomId,
      name: "Annotation service",
      ownerUserId: ownerId,
      roomEpoch: revision.roomEpoch,
      serverSeq: revision.tabUpdatedAtSeq,
      deletedAt: null,
    })
    .execute();
  await db
    .insertInto("roomMemberships")
    .values([
      { roomId, userId: ownerId, role: "OWNER" },
      { roomId, userId: memberId, role: "MEMBER" },
      { roomId, userId: otherMemberId, role: "MEMBER" },
    ])
    .execute();
  await db
    .insertInto("roomTabs")
    .values({
      roomId,
      logicalTabId,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Must not enter annotation storage",
      favIconUrl: null,
      position: 0,
      createdAtSeq: 1,
      updatedAtSeq: revision.tabUpdatedAtSeq,
      closedAtSeq: null,
    })
    .execute();
});

describe("AnnotationService durable sequencing", () => {
  it("isolates signed v2 strokes while projecting legacy operations safely", async () => {
    const legacyStrokeId = randomUUID();
    const legacyCreate = submission(strokeCreate(legacyStrokeId));
    const legacyResult = await submit(ownerId, legacyCreate);
    expect(legacyResult.legacyCommitted).toEqual(legacyResult.committed);
    expect(legacyResult.v2Committed).toMatchObject({
      type: "annotation.committed.v2",
      operation: {
        type: "stroke.create",
        stroke: { strokeId: legacyStrokeId, contentSignature: null },
      },
    });

    const signedStrokeId = randomUUID();
    const signedClientOpId = randomUUID();
    const signedOperation = v2StrokeCreate(signedStrokeId);
    const signedResult = await submitV2(
      ownerId,
      v2Submission(signedOperation, {
        clientOpId: signedClientOpId,
        baseAnnotationSeq: 1,
      }),
    );
    expect(signedResult).toMatchObject({
      ack: { type: "annotation.ack.v2", accepted: true, annotationSeq: 2 },
      committed: {
        type: "annotation.committed.v2",
        operation: signedOperation,
      },
      legacyCommitted: null,
    });
    expect(signedResult.v2Committed).toEqual(signedResult.committed);

    const stored = await db
      .selectFrom("annotationStrokes")
      .select(["strokeId", "contentSignature", "signatureVersion", "byteSize"])
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .orderBy("createdAt")
      .orderBy("strokeId")
      .execute();
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strokeId: legacyStrokeId,
          contentSignature: null,
          signatureVersion: null,
        }),
        {
          strokeId: signedStrokeId,
          contentSignature: signedOperation.stroke.contentSignature.digest,
          signatureVersion: signedOperation.stroke.contentSignature.signatureVersion,
          byteSize: serializedAnnotationStrokeBytes(signedOperation.stroke),
        },
      ]),
    );

    await expect(sync()).resolves.toMatchObject({
      type: "annotation.snapshot",
      annotationSeq: 2,
      strokes: [{ strokeId: legacyStrokeId }],
    });
    await expect(syncV2()).resolves.toMatchObject({
      type: "annotation.snapshot.v2",
      annotationSeq: 2,
      strokes: expect.arrayContaining([
        expect.objectContaining({ strokeId: legacyStrokeId, contentSignature: null }),
        expect.objectContaining({
          strokeId: signedStrokeId,
          contentSignature: signedOperation.stroke.contentSignature,
        }),
      ]),
    });
    await expect(
      sync(ownerId, { lastAnnotationSeq: 0, hasConfirmedSnapshot: true }),
    ).resolves.toMatchObject({
      type: "annotation.snapshot",
      annotationSeq: 2,
      strokes: [{ strokeId: legacyStrokeId }],
    });
    await expect(
      syncV2(ownerId, { lastAnnotationSeq: 0, hasConfirmedSnapshot: true }),
    ).resolves.toMatchObject({
      type: "annotation.delta.v2",
      fromAnnotationSeq: 0,
      toAnnotationSeq: 2,
      operations: [
        expect.objectContaining({
          type: "annotation.committed.v2",
          operation: expect.objectContaining({
            type: "stroke.create",
            stroke: expect.objectContaining({ contentSignature: null }),
          }),
        }),
        expect.objectContaining({
          type: "annotation.committed.v2",
          operation: signedOperation,
        }),
      ],
    });

    if (signedOperation.type !== "stroke.create") {
      throw new Error("expected signed create");
    }
    const signatureReuse = await submitV2(
      ownerId,
      v2Submission(
        {
          ...signedOperation,
          stroke: {
            ...signedOperation.stroke,
            contentSignature: {
              ...signedOperation.stroke.contentSignature,
              digest: "T".repeat(43),
            },
          },
        },
        { clientOpId: signedClientOpId, baseAnnotationSeq: 2 },
      ),
    );
    expect(signatureReuse).toMatchObject({
      ack: { accepted: false, code: "ANNOTATION_CLIENT_OP_REUSE" },
      committed: null,
      legacyCommitted: null,
      v2Committed: null,
    });
  });

  it("creates, deduplicates, recovers a snapshot/delta, and rejects client-op reuse", async () => {
    await expect(sync()).resolves.toMatchObject({
      type: "annotation.snapshot",
      pageKey,
      annotationSeq: 0,
      strokes: [],
    });

    const strokeId = randomUUID();
    const clientOpId = randomUUID();
    const create = submission(strokeCreate(strokeId), { clientOpId });
    const first = await submit(ownerId, create);
    expect(first).toMatchObject({
      deduplicated: false,
      ack: {
        accepted: true,
        pageKey,
        annotationSeq: 1,
        results: [{ strokeId, accepted: true, version: 1 }],
      },
      committed: {
        annotationSeq: 1,
        actorUserId: ownerId,
        operation: create.operation,
      },
    });

    const duplicate = await submit(ownerId, create);
    expect(duplicate).toEqual({ ...first, deduplicated: true });
    const afterRestartDuplicate = await submit(ownerId, create, service());
    expect(afterRestartDuplicate).toEqual({ ...first, deduplicated: true });

    if (create.operation.type !== "stroke.create") {
      throw new Error("expected create operation");
    }
    const reuse = await submit(
      ownerId,
      submission(
        {
          ...create.operation,
          stroke: {
            ...create.operation.stroke,
            rgb: { r: 255, g: 0, b: 0 },
          },
        },
        { clientOpId },
      ),
    );
    expect(reuse).toMatchObject({
      ack: {
        accepted: false,
        code: "ANNOTATION_CLIENT_OP_REUSE",
        annotationSeq: null,
      },
      committed: null,
      deduplicated: false,
    });

    await expect(
      sync(ownerId, { lastAnnotationSeq: 0, hasConfirmedSnapshot: true }, service()),
    ).resolves.toMatchObject({
      type: "annotation.delta",
      fromAnnotationSeq: 0,
      toAnnotationSeq: 1,
      operations: [first.committed],
    });
    await expect(sync(ownerId, {}, service())).resolves.toMatchObject({
      type: "annotation.snapshot",
      annotationSeq: 1,
      strokes: [{ strokeId, authorUserId: ownerId, version: 1 }],
    });

    const [page, operationCount, room] = await Promise.all([
      db
        .selectFrom("annotationPages")
        .selectAll()
        .where("roomId", "=", roomId)
        .where("pageKey", "=", pageKey)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("annotationOperations")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("roomId", "=", roomId)
        .where("pageKey", "=", pageKey)
        .executeTakeFirstOrThrow(),
      db.selectFrom("rooms").select("serverSeq").where("id", "=", roomId).executeTakeFirstOrThrow(),
    ]);
    expect(page).toMatchObject({ annotationSeq: 1, liveStrokeCount: 1 });
    expect(Number(operationCount.count)).toBe(1);
    expect(room.serverSeq).toBe(revision.tabUpdatedAtSeq);
  });

  it("keeps a soft-deleted stroke tombstone and never revives its ID", async () => {
    const strokeId = randomUUID();
    await submit(ownerId, submission(strokeCreate(strokeId)));
    const deletion = await submit(
      memberId,
      submission(mutation("stroke.delete", [{ strokeId, expectedVersion: 1 }]), {
        baseAnnotationSeq: 1,
      }),
    );
    expect(deletion.ack).toMatchObject({
      accepted: true,
      annotationSeq: 2,
      results: [{ strokeId, accepted: true, version: 2 }],
    });

    const recreation = await submit(
      ownerId,
      submission(strokeCreate(strokeId), { baseAnnotationSeq: 2 }),
    );
    expect(recreation.ack).toMatchObject({
      accepted: true,
      annotationSeq: 3,
      results: [{ strokeId, accepted: false, code: "STROKE_DELETED", version: 2 }],
    });
    await expect(sync()).resolves.toMatchObject({ annotationSeq: 3, strokes: [] });

    const tombstone = await db
      .selectFrom("annotationStrokes")
      .select(["version", "deletedAt"])
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .where("strokeId", "=", strokeId)
      .executeTakeFirstOrThrow();
    expect(tombstone.version).toBe(2);
    expect(tombstone.deletedAt).toEqual(fixedNow);
  });

  it("enforces author locks, member erase rules, owner override, and redacted audit", async () => {
    const memberStrokeId = randomUUID();
    await submit(memberId, submission(strokeCreate(memberStrokeId)));

    const foreignLock = await submit(
      otherMemberId,
      submission(mutation("stroke.lock", [{ strokeId: memberStrokeId, expectedVersion: 1 }])),
    );
    expect(foreignLock.ack).toMatchObject({
      results: [{ accepted: false, code: "NOT_STROKE_AUTHOR", version: 1 }],
    });

    const memberLock = await submit(
      memberId,
      submission(mutation("stroke.lock", [{ strokeId: memberStrokeId, expectedVersion: 1 }])),
    );
    expect(memberLock.ack).toMatchObject({
      results: [{ accepted: true, version: 2 }],
    });

    const blockedDelete = await submit(
      otherMemberId,
      submission(mutation("stroke.delete", [{ strokeId: memberStrokeId, expectedVersion: 2 }])),
    );
    expect(blockedDelete.ack).toMatchObject({
      results: [{ accepted: false, code: "STROKE_PERMISSION_DENIED", version: 2 }],
    });

    const blockedUnlock = await submit(
      ownerId,
      submission(mutation("stroke.unlock", [{ strokeId: memberStrokeId, expectedVersion: 2 }])),
    );
    expect(blockedUnlock.ack).toMatchObject({
      results: [{ accepted: false, code: "NOT_STROKE_AUTHOR", version: 2 }],
    });

    const ownerDelete = await submit(
      ownerId,
      submission(mutation("stroke.delete", [{ strokeId: memberStrokeId, expectedVersion: 2 }])),
    );
    expect(ownerDelete.ack).toMatchObject({
      results: [{ accepted: true, version: 3 }],
    });

    const audit = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("eventType", "=", "annotation.owner_override_delete")
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actorUserId: ownerId,
      actorAdministratorId: null,
      targetType: "annotation_stroke",
      targetId: memberStrokeId,
      details: {
        strokeId: memberStrokeId,
        authorUserId: memberId,
        actorUserId: ownerId,
        reasonCode: "ROOM_OWNER_LOCKED_STROKE_DELETE",
      },
    });
    expect(JSON.stringify(audit)).not.toMatch(/points|rgb|width|youtube|https?:|pageKey/iu);
  });

  it("returns one ordered result per batch item without granting ineligible locks", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const foreignId = randomUUID();
    await submit(memberId, submission(strokeCreate(firstId)));
    await submit(memberId, submission(strokeCreate(secondId)));
    await submit(ownerId, submission(strokeCreate(foreignId)));

    const batch = await submit(
      memberId,
      submission(
        mutation("stroke.lock", [
          { strokeId: firstId, expectedVersion: 1 },
          { strokeId: foreignId, expectedVersion: 1 },
          { strokeId: secondId, expectedVersion: 1 },
        ]),
      ),
    );
    expect(batch.ack).toMatchObject({
      accepted: true,
      results: [
        { strokeId: firstId, accepted: true, version: 2 },
        { strokeId: foreignId, accepted: false, code: "NOT_STROKE_AUTHOR", version: 1 },
        { strokeId: secondId, accepted: true, version: 2 },
      ],
    });
  });

  it("serializes concurrent version races so exactly one mutation wins", async () => {
    const strokeId = randomUUID();
    await submit(ownerId, submission(strokeCreate(strokeId)));

    const [lock, erase] = await Promise.all([
      submit(
        ownerId,
        submission(mutation("stroke.lock", [{ strokeId, expectedVersion: 1 }]), {
          baseAnnotationSeq: 1,
        }),
        service(),
      ),
      submit(
        memberId,
        submission(mutation("stroke.delete", [{ strokeId, expectedVersion: 1 }]), {
          baseAnnotationSeq: 1,
        }),
        service(),
      ),
    ]);
    const itemResults = [lock.ack.results[0], erase.ack.results[0]];
    expect(itemResults.filter((result) => result?.accepted)).toHaveLength(1);
    expect(itemResults.filter((result) => !result?.accepted)).toHaveLength(1);

    const page = await db
      .selectFrom("annotationPages")
      .select("annotationSeq")
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .executeTakeFirstOrThrow();
    expect(page.annotationSeq).toBe(3);
  });

  it("falls back to snapshots on gaps and enforces page safety capacity for every room", async () => {
    const strokeId = randomUUID();
    await submit(ownerId, submission(strokeCreate(strokeId)));
    await submit(ownerId, submission(mutation("stroke.lock", [{ strokeId, expectedVersion: 1 }])));

    await expect(
      sync(ownerId, { lastAnnotationSeq: 0, hasConfirmedSnapshot: true }, service(1)),
    ).resolves.toMatchObject({
      type: "annotation.snapshot",
      annotationSeq: 2,
      strokes: [{ strokeId, version: 2 }],
    });
    await expect(
      sync(ownerId, { lastAnnotationSeq: 99, hasConfirmedSnapshot: true }),
    ).resolves.toMatchObject({ type: "annotation.snapshot", annotationSeq: 2 });

    await db
      .updateTable("annotationPages")
      .set({ liveStrokeCount: 2_000, liveStrokeBytes: 5 * 1_024 * 1_024 })
      .where("roomId", "=", roomId)
      .where("pageKey", "=", pageKey)
      .execute();
    await db
      .insertInto("administrators")
      .values({
        id: "018f8f8e-4b5c-4d6e-8f90-523456789a20",
        username: "annotation-admin",
        usernameNormalized: "annotation-admin",
        passwordHash: "hash",
        totpSecretCiphertext: "ciphertext",
        linkedUserId: ownerId,
      })
      .execute();
    const capacity = await submit(ownerId, submission(strokeCreate()));
    expect(capacity).toMatchObject({
      ack: {
        accepted: false,
        code: "ANNOTATION_PAGE_CAPACITY_REACHED",
        pageKey,
        annotationSeq: null,
      },
      committed: null,
    });

    const unlock = await submit(
      ownerId,
      submission(mutation("stroke.unlock", [{ strokeId, expectedVersion: 2 }])),
    );
    expect(unlock.ack).toMatchObject({
      accepted: true,
      results: [{ accepted: true, version: 3 }],
    });
  });

  it("rejects page mismatch, future sequence, stale socket, and oversized strokes before content writes", async () => {
    const valid = submission(strokeCreate());
    const annotationService = service();

    await expect(
      submit(
        ownerId,
        submission(valid.operation, {
          suppliedPageKey: "Z".repeat(43),
        }),
        annotationService,
      ),
    ).resolves.toMatchObject({
      ack: { accepted: false, code: "PAGE_MISMATCH" },
      committed: null,
    });
    await expect(
      submit(ownerId, submission(valid.operation, { baseAnnotationSeq: 1 }), annotationService),
    ).resolves.toMatchObject({
      ack: { accepted: false, code: "ANNOTATION_SEQUENCE_CONFLICT" },
      committed: null,
    });
    await expect(
      annotationService.submit({
        principal: principal(ownerId),
        socketId: "socket-stale",
        submission: valid,
      }),
    ).resolves.toMatchObject({
      ack: { accepted: false, code: "DOCUMENT_UNAUTHORIZED" },
      committed: null,
    });

    if (valid.operation.type !== "stroke.create") {
      throw new Error("expected create operation");
    }
    const tooManyPoints = {
      ...valid,
      operation: {
        ...valid.operation,
        stroke: {
          ...valid.operation.stroke,
          points: Array.from({ length: 2_049 }, () => ({
            x: 0.5,
            y: 0.5,
            pressure: 0.5,
          })),
        },
      },
    };
    const tooManyBytes = {
      ...valid,
      clientOpId: randomUUID(),
      operation: {
        ...valid.operation,
        stroke: {
          ...valid.operation.stroke,
          strokeId: randomUUID(),
          points: Array.from({ length: 2_048 }, (_, index) => ({
            x: index / 2_047,
            y: 0.987_654_321_012_345_6,
            pressure: 0.555_555_555_555_555_6,
          })),
        },
      },
    };
    for (const invalid of [tooManyPoints, tooManyBytes]) {
      await expect(
        annotationService.submit({
          principal: principal(ownerId),
          socketId: `socket-${ownerId}`,
          submission: invalid,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ANNOTATION_MESSAGE" });
    }

    const [strokeCount, operationCount, room] = await Promise.all([
      db
        .selectFrom("annotationStrokes")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("annotationOperations")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
      db.selectFrom("rooms").select("serverSeq").where("id", "=", roomId).executeTakeFirstOrThrow(),
    ]);
    expect(Number(strokeCount.count)).toBe(0);
    expect(Number(operationCount.count)).toBe(0);
    expect(room.serverSeq).toBe(revision.tabUpdatedAtSeq);
  });
});
