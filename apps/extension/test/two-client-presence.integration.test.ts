import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AccountService, createAccessTokenCodec } from "@syncaction/identity";
import { RoomSnapshotMessageSchema, type ClientOperationEnvelope } from "@syncaction/protocol";
import { ReplicaRecordSchema, type ReplicaRecord } from "@syncaction/replica";
import { RoomService } from "@syncaction/rooms";
import { buildPublicApp } from "@syncaction/server/app";
import { RoomPresenceService, RoomSequencer } from "@syncaction/sync";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActiveTabPresenceController, type PresenceScheduler } from "../src/active-tab-presence.js";
import { SocketReplicaTransport } from "../src/socket-transport.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

let nowMs = Date.parse("2026-07-27T00:00:00.000Z");
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let rooms: RoomService;
let sequencer: RoomSequencer;
let app: Awaited<ReturnType<typeof buildPublicApp>>;
let baseUrl: string;
const liveTransports = new Set<SocketReplicaTransport>();
const livePresences = new Set<ActiveTabPresenceController>();

class PassiveScheduler implements PresenceScheduler {
  public setInterval(): unknown {
    return 1;
  }

  public clearInterval(): void {}
}

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  const now = () => new Date(nowMs);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(43),
      now,
    }),
    now,
  });
  rooms = new RoomService({ db, now });
  sequencer = new RoomSequencer({ db, now });
  app = await buildPublicApp({
    db,
    accounts,
    rooms,
    sequencer,
    annotationHmacKey: new Uint8Array(32).fill(23),
    presence: new RoomPresenceService({ db, now }),
    operationRateLimitMax: 100,
    logger: false,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an ephemeral TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await cleanupClients();
  await app.close();
  await db.destroy();
});

beforeEach(async () => {
  await cleanupClients();
  nowMs = Date.parse("2026-07-27T00:00:00.000Z");
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

async function cleanupClients(): Promise<void> {
  await Promise.all(
    [...livePresences].map(async (presence) => {
      try {
        await presence.dispose();
      } catch {
        // Continue cleanup after a failed test.
      }
    }),
  );
  livePresences.clear();
  await Promise.all([...liveTransports].map((transport) => transport.disconnect()));
  liveTransports.clear();
}

async function activeSession(username: string) {
  const account = await accounts.register({
    username,
    displayName: username,
    password: "correct horse battery",
  });
  await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", account.id).execute();
  const deviceId = randomUUID();
  const session = await accounts.login({
    username,
    password: "correct horse battery",
    deviceId,
  });
  return {
    account,
    deviceId,
    accessToken: session.accessToken,
    principal: await accounts.authenticateAccessToken(session.accessToken),
  };
}

async function connectedTransport(
  accessToken: string,
  roomId: string,
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
    roomId: roomId as ClientOperationEnvelope["roomId"],
    roomEpoch: 0,
    lastServerSeq: 0,
    hasConfirmedSnapshot: false,
  });
  return transport;
}

function replicaRecord(
  snapshot: ReturnType<typeof RoomSnapshotMessageSchema.parse>["state"],
  browserSessionId: string,
  tabId: number,
): ReplicaRecord {
  const logicalTabId = snapshot.order[0]!;
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId: snapshot.roomId,
    mode: "SYNCED",
    confirmedSnapshot: snapshot,
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: [
      {
        logicalTabId,
        tabId,
        windowId: 1,
        groupId: 2,
        browserSessionId,
        validatedAtServerSeq: snapshot.serverSeq,
      },
    ],
    quarantineReason: null,
    updatedAtMs: nowMs,
  });
}

function presenceClient(
  roomId: string,
  browserSessionId: string,
  userId: string,
  deviceId: string,
  tabId: number,
  record: ReplicaRecord,
  transport: SocketReplicaTransport,
): ActiveTabPresenceController {
  const controller = new ActiveTabPresenceController({
    roomId,
    browserSessionId,
    userId,
    deviceId,
    replica: { getRecord: async () => record },
    transport,
    scheduler: new PassiveScheduler(),
    now: () => nowMs,
    requestRoomSync: async () => {
      const confirmed = record.confirmedSnapshot;
      await transport.synchronize({
        protocolVersion: 1,
        roomId: roomId as ClientOperationEnvelope["roomId"],
        roomEpoch: confirmed?.roomEpoch ?? 0,
        lastServerSeq: confirmed?.serverSeq ?? 0,
        hasConfirmedSnapshot: confirmed !== null,
      });
    },
  });
  livePresences.add(controller);
  return controller;
}

describe("two-client active-tab presence", () => {
  it("switches, disconnects, reconnects, and expires without changing serverSeq", async () => {
    const owner = await activeSession("presence-e2e-owner");
    const member = await activeSession("presence-e2e-member");
    const room = await rooms.createRoom({
      actorUserId: owner.account.id,
      name: "Presence E2E",
    });
    const invitation = await rooms.inviteByUsername({
      actorUserId: owner.account.id,
      roomId: room.id,
      username: member.account.username,
    });
    await rooms.acceptInvitation({
      actorUserId: member.account.id,
      invitationId: invitation.id,
    });
    const logicalTabId = randomUUID();
    await sequencer.commitOperation({
      principal: owner.principal,
      envelope: {
        protocolVersion: 1,
        clientOpId: randomUUID(),
        roomId: room.id,
        roomEpoch: 0,
        deviceId: owner.deviceId,
        baseServerSeq: 0,
        operation: {
          type: "tab.create",
          logicalTabId,
          url: "https://example.com/presence-e2e",
          after: null,
        },
      },
    });
    const snapshot = RoomSnapshotMessageSchema.parse(
      await sequencer.synchronize({
        principal: owner.principal,
        request: {
          protocolVersion: 1,
          roomId: room.id,
          roomEpoch: 0,
          lastServerSeq: 0,
          hasConfirmedSnapshot: false,
        },
      }),
    ).state;
    const ownerTransport = await connectedTransport(owner.accessToken, room.id);
    const memberTransport = await connectedTransport(member.accessToken, room.id);
    const ownerPresence = presenceClient(
      room.id,
      "018f8f8e-4b5c-7d6e-8f90-123456789c01",
      owner.account.id,
      owner.deviceId,
      101,
      replicaRecord(snapshot, "018f8f8e-4b5c-7d6e-8f90-123456789c01", 101),
      ownerTransport,
    );
    let memberPresence = presenceClient(
      room.id,
      "018f8f8e-4b5c-7d6e-8f90-123456789c02",
      member.account.id,
      member.deviceId,
      201,
      replicaRecord(snapshot, "018f8f8e-4b5c-7d6e-8f90-123456789c02", 201),
      memberTransport,
    );
    await ownerPresence.handleActiveTabChanged(101);
    await memberPresence.handleActiveTabChanged(201);
    await ownerPresence.setSynchronized(true);
    await memberPresence.setSynchronized(true);

    await waitFor(() => ownerPresence.getStatus().presences.length === 2);
    expect(ownerPresence.getStatus().presences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: owner.account.id,
          logicalTabId,
        }),
        expect.objectContaining({
          userId: member.account.id,
          logicalTabId,
        }),
      ]),
    );

    await memberPresence.handleActiveTabChanged(999);
    await waitFor(
      () =>
        ownerPresence
          .getStatus()
          .presences.find((presence) => presence.userId === member.account.id)?.logicalTabId ===
        null,
    );

    await memberPresence.dispose();
    livePresences.delete(memberPresence);
    await memberTransport.disconnect();
    liveTransports.delete(memberTransport);
    await waitFor(() => ownerPresence.getStatus().presences.length === 1);

    const restoredTransport = await connectedTransport(member.accessToken, room.id);
    memberPresence = presenceClient(
      room.id,
      "018f8f8e-4b5c-7d6e-8f90-123456789c03",
      member.account.id,
      member.deviceId,
      301,
      replicaRecord(snapshot, "018f8f8e-4b5c-7d6e-8f90-123456789c03", 301),
      restoredTransport,
    );
    await memberPresence.handleActiveTabChanged(301);
    await memberPresence.setSynchronized(true);
    await waitFor(() => ownerPresence.getStatus().presences.length === 2);

    const durableBeforeExpiry = await roomDurableState(room.id);
    nowMs += 30_001;
    expect(ownerPresence.getStatus().presences).toEqual([]);
    await expect(roomDurableState(room.id)).resolves.toEqual(durableBeforeExpiry);
  });
});

async function roomDurableState(roomId: string): Promise<{
  serverSeq: number;
  operationCount: number;
}> {
  const [room, operations] = await Promise.all([
    db.selectFrom("rooms").select("serverSeq").where("id", "=", roomId).executeTakeFirstOrThrow(),
    db
      .selectFrom("roomOperations")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
  ]);
  return { serverSeq: room.serverSeq, operationCount: Number(operations.count) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("presence condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
