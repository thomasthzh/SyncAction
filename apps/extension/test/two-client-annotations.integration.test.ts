import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AccountService, createAccessTokenCodec } from "@syncaction/identity";
import {
  AnnotationSnapshotV2MessageSchema as AnnotationSnapshotMessageSchema,
  AnnotationSubmitV2Schema as AnnotationSubmitSchema,
  ClientOpIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type AnnotationCommittedOperationV2 as AnnotationCommittedOperation,
  type AnnotationSubmitV2 as AnnotationSubmit,
  type ClientOperationEnvelope,
  type DanmakuEventMessage,
} from "@syncaction/protocol";
import { RoomService } from "@syncaction/rooms";
import { buildPublicApp } from "@syncaction/server/app";
import { RoomSequencer } from "@syncaction/sync";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SocketReplicaTransport,
  type AnnotationMessage,
  type StrokePreviewMessage,
} from "../src/socket-transport.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const fixedNow = new Date("2026-07-28T00:00:00.000Z");
const password = "correct horse battery";
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let rooms: RoomService;
let sequencer: RoomSequencer;
let app: Awaited<ReturnType<typeof buildPublicApp>> | undefined;
let baseUrl = "";
const liveTransports = new Set<SocketReplicaTransport>();

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(73),
      now: () => fixedNow,
    }),
    now: () => fixedNow,
  });
  rooms = new RoomService({ db, now: () => fixedNow });
  sequencer = new RoomSequencer({ db, now: () => fixedNow });
  await startServer();
});

beforeEach(async () => {
  await cleanupTransports();
  if (app === undefined) {
    await startServer();
  }
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

afterAll(async () => {
  await cleanupTransports();
  await stopServer();
  await db.destroy();
});

describe("two-client page collaboration through the local public server", () => {
  it("keeps messages and previews ephemeral while recovering durable annotations after everyone leaves", async () => {
    const owner = await activeSession("annotations-e2e-owner");
    const member = await activeSession("annotations-e2e-member");
    const room = await rooms.createRoom({
      actorUserId: owner.account.id,
      name: "Annotations E2E",
    });
    const roomId = RoomIdSchema.parse(room.id);
    const invitation = await rooms.inviteByUsername({
      actorUserId: owner.account.id,
      roomId,
      username: member.account.username,
    });
    await rooms.acceptInvitation({
      actorUserId: member.account.id,
      invitationId: invitation.id,
    });

    const logicalTabId = LogicalTabIdSchema.parse(randomUUID());
    await sequencer.commitOperation({
      principal: owner.principal,
      envelope: {
        protocolVersion: 1,
        clientOpId: randomUUID(),
        roomId,
        roomEpoch: 0,
        deviceId: owner.deviceId,
        baseServerSeq: 0,
        operation: {
          type: "tab.create",
          logicalTabId,
          url: "https://example.com/collaboration",
          after: null,
        },
      },
    });

    const ownerTransport = await connectedTransport(owner.accessToken, roomId);
    const memberTransport = await connectedTransport(member.accessToken, roomId);
    await Promise.all([
      ownerTransport.publishPresence({
        type: "presence.update",
        protocolVersion: 1,
        roomId,
        logicalTabId,
      }),
      memberTransport.publishPresence({
        type: "presence.update",
        protocolVersion: 1,
        roomId,
        logicalTabId,
      }),
    ]);

    const context = {
      roomId,
      logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      frameKey: "top" as const,
    };
    const ownerAnnotations: AnnotationMessage[] = [];
    const memberAnnotations: AnnotationMessage[] = [];
    const memberDanmaku: DanmakuEventMessage[] = [];
    const memberPreviews: StrokePreviewMessage[] = [];
    ownerTransport.setAnnotationHandler((message) => ownerAnnotations.push(message));
    memberTransport.setAnnotationHandler((message) => memberAnnotations.push(message));
    memberTransport.setDanmakuHandler((message) => memberDanmaku.push(message));
    memberTransport.setStrokePreviewHandler((message) => memberPreviews.push(message));

    const initial = AnnotationSnapshotMessageSchema.parse(
      await ownerTransport.synchronizeAnnotations({
        protocolVersion: 1,
        ...context,
        lastAnnotationSeq: 0,
        hasConfirmedSnapshot: false,
      }),
    );
    expect(initial).toMatchObject({ annotationSeq: 0, strokes: [] });
    await memberTransport.synchronizeAnnotations({
      protocolVersion: 1,
      ...context,
      lastAnnotationSeq: 0,
      hasConfirmedSnapshot: false,
    });

    const messageId = randomUUID();
    await expect(
      ownerTransport.sendDanmaku({
        type: "danmaku.send",
        protocolVersion: 1,
        messageId,
        ...context,
        text: "本地双端弹幕",
      }),
    ).resolves.toMatchObject({ accepted: true, messageId });
    await waitFor(
      () => memberDanmaku.some((message) => message.messageId === messageId),
      "member did not receive the exact-page danmaku",
    );

    const previewId = randomUUID();
    const contentSignature = {
      signatureVersion: 1,
      digest: "S".repeat(43),
    };
    const geometry = {
      anchor: {
        type: "document" as const,
        layoutSignature: { widthCssPx: 1_440, heightCssPx: 4_000 },
      },
      points: [
        { x: 0.1, y: 0.2, pressure: 0.5 },
        { x: 0.3, y: 0.4, pressure: 0.8 },
      ],
      rgb: { r: 16, g: 128, b: 240 },
      width: 9,
    };
    await ownerTransport.publishStrokePreview({
      type: "stroke.preview.update",
      protocolVersion: 1,
      previewId,
      ...context,
      ...geometry,
    });
    await waitFor(
      () =>
        memberPreviews.some(
          (message) => message.type === "stroke.preview.event" && message.previewId === previewId,
        ),
      "member did not receive the live stroke preview",
    );
    await ownerTransport.clearStrokePreview({
      type: "stroke.preview.clear",
      protocolVersion: 1,
      previewId,
      ...context,
    });
    await waitFor(
      () =>
        memberPreviews.some(
          (message) => message.type === "stroke.preview.clear" && message.previewId === previewId,
        ),
      "member did not receive the preview clear",
    );

    const firstStrokeId = randomUUID();
    const createFirst = submission({
      context,
      pageKey: initial.pageKey,
      baseAnnotationSeq: 0,
      operation: {
        type: "stroke.create",
        stroke: {
          strokeId: firstStrokeId,
          frameKey: "top",
          ...geometry,
          contentSignature,
        },
      },
    });
    await expect(ownerTransport.submitAnnotation(createFirst)).resolves.toMatchObject({
      accepted: true,
      annotationSeq: 1,
    });
    await waitForCommitted(memberAnnotations, createFirst.clientOpId);

    const deleteFirst = submission({
      context,
      pageKey: initial.pageKey,
      baseAnnotationSeq: 1,
      operation: {
        type: "stroke.delete",
        items: [{ strokeId: firstStrokeId, expectedVersion: 1 }],
      },
    });
    await expect(memberTransport.submitAnnotation(deleteFirst)).resolves.toMatchObject({
      accepted: true,
      annotationSeq: 2,
      results: [{ strokeId: firstStrokeId, accepted: true, version: 2 }],
    });
    await waitForCommitted(ownerAnnotations, deleteFirst.clientOpId);

    const retainedStrokeId = randomUUID();
    const createRetained = submission({
      context,
      pageKey: initial.pageKey,
      baseAnnotationSeq: 2,
      operation: {
        type: "stroke.create",
        stroke: {
          strokeId: retainedStrokeId,
          frameKey: "top",
          ...geometry,
          rgb: { r: 255, g: 59, b: 48 },
          contentSignature,
        },
      },
    });
    await expect(ownerTransport.submitAnnotation(createRetained)).resolves.toMatchObject({
      accepted: true,
      annotationSeq: 3,
    });
    await waitForCommitted(memberAnnotations, createRetained.clientOpId);

    const lockRetained = submission({
      context,
      pageKey: initial.pageKey,
      baseAnnotationSeq: 3,
      operation: {
        type: "stroke.lock",
        items: [{ strokeId: retainedStrokeId, expectedVersion: 1 }],
      },
    });
    await expect(ownerTransport.submitAnnotation(lockRetained)).resolves.toMatchObject({
      accepted: true,
      annotationSeq: 4,
      results: [{ strokeId: retainedStrokeId, accepted: true, version: 2 }],
    });
    await waitForCommitted(memberAnnotations, lockRetained.clientOpId);

    const blockedDelete = submission({
      context,
      pageKey: initial.pageKey,
      baseAnnotationSeq: 4,
      operation: {
        type: "stroke.delete",
        items: [{ strokeId: retainedStrokeId, expectedVersion: 2 }],
      },
    });
    await expect(memberTransport.submitAnnotation(blockedDelete)).resolves.toMatchObject({
      accepted: true,
      results: [
        {
          strokeId: retainedStrokeId,
          accepted: false,
          code: "STROKE_PERMISSION_DENIED",
          version: 2,
        },
      ],
    });

    await cleanupTransports();
    await stopServer();
    await startServer();

    const recoveredTransport = await connectedTransport(owner.accessToken, roomId);
    await recoveredTransport.publishPresence({
      type: "presence.update",
      protocolVersion: 1,
      roomId,
      logicalTabId,
    });
    const recovered = AnnotationSnapshotMessageSchema.parse(
      await recoveredTransport.synchronizeAnnotations({
        protocolVersion: 1,
        ...context,
        lastAnnotationSeq: 0,
        hasConfirmedSnapshot: false,
      }),
    );
    expect(recovered.strokes).toEqual([
      expect.objectContaining({
        strokeId: retainedStrokeId,
        authorUserId: owner.account.id,
        version: 2,
        lockedAtServerMs: expect.any(Number),
        deletedAtServerMs: null,
      }),
    ]);
    expect(recovered.strokes).not.toContainEqual(
      expect.objectContaining({ strokeId: firstStrokeId }),
    );

    const durable = await Promise.all([
      db.selectFrom("rooms").select("serverSeq").where("id", "=", roomId).executeTakeFirstOrThrow(),
      db
        .selectFrom("annotationOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", roomId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(Number(durable[0].serverSeq)).toBe(1);
    expect(Number(durable[1].count)).toBeGreaterThanOrEqual(4);
  });
});

function submission(input: {
  context: {
    roomId: AnnotationSubmit["roomId"];
    logicalTabId: AnnotationSubmit["logicalTabId"];
    documentRevision: AnnotationSubmit["documentRevision"];
    frameKey: AnnotationSubmit["frameKey"];
  };
  pageKey: string;
  baseAnnotationSeq: number;
  operation: AnnotationSubmit["operation"];
}): AnnotationSubmit {
  return AnnotationSubmitSchema.parse({
    type: "annotation.submit.v2",
    protocolVersion: 1,
    clientOpId: ClientOpIdSchema.parse(randomUUID()),
    ...input.context,
    pageKey: input.pageKey,
    baseAnnotationSeq: input.baseAnnotationSeq,
    operation: input.operation,
  });
}

async function waitForCommitted(
  messages: readonly AnnotationMessage[],
  clientOpId: string,
): Promise<AnnotationCommittedOperation> {
  await waitFor(
    () =>
      messages.some(
        (message) =>
          message.type === "annotation.committed.v2" && message.clientOpId === clientOpId,
      ),
    `annotation ${clientOpId} did not reach the other client`,
  );
  const committed = messages.find(
    (message): message is AnnotationCommittedOperation =>
      message.type === "annotation.committed.v2" && message.clientOpId === clientOpId,
  );
  if (committed === undefined) {
    throw new Error("ANNOTATION_COMMITTED_MISSING");
  }
  return committed;
}

async function connectedTransport(
  accessToken: string,
  roomId: ClientOperationEnvelope["roomId"],
): Promise<SocketReplicaTransport> {
  const transport = new SocketReplicaTransport({
    serverUrl: baseUrl,
    accessToken,
    clientVersion: "0.9.0",
    ackTimeoutMs: 3_000,
  });
  liveTransports.add(transport);
  await transport.connect({
    onCommitted: () => undefined,
    onDisconnect: () => undefined,
    onReconnect: () => undefined,
  });
  await transport.synchronize({
    protocolVersion: 1,
    roomId,
    roomEpoch: 0,
    lastServerSeq: 0,
    hasConfirmedSnapshot: false,
  });
  return transport;
}

async function activeSession(username: string) {
  const account = await accounts.register({
    username,
    displayName: username,
    password,
  });
  await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", account.id).execute();
  const deviceId = randomUUID();
  const session = await accounts.login({
    username,
    password,
    deviceId,
  });
  return {
    account,
    deviceId,
    accessToken: session.accessToken,
    principal: await accounts.authenticateAccessToken(session.accessToken),
  };
}

async function startServer(): Promise<void> {
  app = await buildPublicApp({
    db,
    accounts,
    rooms,
    sequencer: new RoomSequencer({ db, now: () => fixedNow }),
    annotationHmacKey: new Uint8Array(32).fill(23),
    now: () => fixedNow,
    operationRateLimitMax: 100,
    logger: false,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an ephemeral TCP address");
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
}

async function stopServer(): Promise<void> {
  const running = app;
  app = undefined;
  if (running !== undefined) {
    await running.close();
  }
}

async function cleanupTransports(): Promise<void> {
  await Promise.all([...liveTransports].map((transport) => transport.disconnect()));
  liveTransports.clear();
}

async function waitFor(
  predicate: () => boolean,
  failureMessage: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(failureMessage);
}
