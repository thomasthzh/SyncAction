import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AccountService, AdminService, createAccessTokenCodec } from "@syncaction/identity";
import type {
  ClientOperationEnvelope,
  OperationAck,
  RoomDeltaMessage,
  RoomSnapshotMessage,
  RoomSyncRequest,
} from "@syncaction/protocol";
import {
  DurableReplica,
  MemoryReplicaPersistence,
  ReplicaCoordinator,
  ReplicaRepository,
  type ReplicaPersistence,
  type ReplicaTransport,
  type ReplicaTransportHandlers,
} from "@syncaction/replica";
import { RoomService } from "@syncaction/rooms";
import { buildPublicApp } from "@syncaction/server/app";
import { RoomSequencer } from "@syncaction/sync";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SocketReplicaTransport } from "../src/socket-transport.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-27T00:00:00.000Z");

interface ActiveSession {
  userId: string;
  username: string;
  deviceId: string;
  accessToken: string;
}

interface ReplicaClient {
  replica: DurableReplica;
  coordinator: ReplicaCoordinator;
}

let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let administrators: AdminService;
let rooms: RoomService;
let app: Awaited<ReturnType<typeof buildPublicApp>>;
let baseUrl: string;
let administratorId: string;
const coordinators = new Set<ReplicaCoordinator>();

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(23),
      now: () => now,
    }),
    now: () => now,
  });
  administrators = new AdminService({
    db,
    totpEncryptionKey: new Uint8Array(32).fill(29),
    now: () => now,
  });
  rooms = new RoomService({ db, now: () => now });
  app = await buildPublicApp({
    db,
    accounts,
    rooms,
    sequencer: new RoomSequencer({ db, now: () => now }),
    annotationHmacKey: new Uint8Array(32).fill(23),
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
  await stopAllClients();
  await app.close();
  await db.destroy();
});

beforeEach(async () => {
  await stopAllClients();
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  administratorId = (
    await administrators.bootstrap({
      username: "SyncAdmin",
      password: "administrator horse battery",
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    })
  ).id;
});

async function stopAllClients(): Promise<void> {
  await Promise.all(
    [...coordinators].map(async (coordinator) => {
      try {
        await coordinator.stop();
      } catch {
        // Test cleanup must continue even if a simulated transport already failed.
      }
    }),
  );
  coordinators.clear();
}

async function createActiveSession(username: string): Promise<ActiveSession> {
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
    userId: account.id,
    username,
    deviceId,
    accessToken: session.accessToken,
  };
}

async function createSharedRoom(owner: ActiveSession, member?: ActiveSession) {
  const room = await rooms.createRoom({
    actorUserId: owner.userId,
    name: "Live replica room",
  });
  if (member !== undefined) {
    const invitation = await rooms.inviteByUsername({
      actorUserId: owner.userId,
      roomId: room.id,
      username: member.username,
    });
    await rooms.acceptInvitation({
      actorUserId: member.userId,
      invitationId: invitation.id,
    });
  }
  return room;
}

function createClient(
  session: ActiveSession,
  roomId: string,
  persistence: ReplicaPersistence,
  transport: ReplicaTransport = new SocketReplicaTransport({
    serverUrl: baseUrl,
    accessToken: session.accessToken,
    clientVersion: "0.9.0",
    ackTimeoutMs: 3_000,
  }),
): ReplicaClient {
  const replica = new DurableReplica({
    repository: new ReplicaRepository({ persistence }),
    roomId,
    deviceId: session.deviceId,
  });
  const coordinator = new ReplicaCoordinator({
    replica,
    transport,
    roomId,
  });
  coordinators.add(coordinator);
  return { replica, coordinator };
}

function createTabOperation(url: string) {
  return {
    type: "tab.create" as const,
    logicalTabId: randomUUID(),
    url,
    after: null,
  };
}

async function operationCount(roomId: string): Promise<number> {
  return (
    await db
      .selectFrom("roomOperations")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow()
  ).count;
}

class AckDroppingTransport implements ReplicaTransport {
  readonly #inner: SocketReplicaTransport;

  public constructor(options: { serverUrl: string; accessToken: string }) {
    this.#inner = new SocketReplicaTransport({
      ...options,
      clientVersion: "0.9.0",
      ackTimeoutMs: 3_000,
    });
  }

  public connect(handlers: ReplicaTransportHandlers): Promise<void> {
    return this.#inner.connect({
      onCommitted: () => undefined,
      onDisconnect: handlers.onDisconnect,
      onReconnect: handlers.onReconnect,
    });
  }

  public synchronize(request: RoomSyncRequest): Promise<RoomSnapshotMessage | RoomDeltaMessage> {
    return this.#inner.synchronize(request);
  }

  public async submit(envelope: ClientOperationEnvelope): Promise<OperationAck> {
    await this.#inner.submit(envelope);
    await this.#inner.disconnect();
    throw new Error("simulated ACK loss");
  }

  public disconnect(): Promise<void> {
    return this.#inner.disconnect();
  }
}

describe("live extension replica boundary", () => {
  it("persists local intent, commits once, and confirms it through the real socket server", async () => {
    const owner = await createActiveSession("replica-owner");
    const room = await createSharedRoom(owner);
    const persistence = new MemoryReplicaPersistence();
    const client = createClient(owner, room.id, persistence);

    await client.coordinator.start();
    await client.coordinator.enqueueLocalOperation(
      createTabOperation("https://example.com/confirmed"),
    );
    await expect
      .poll(async () => (await client.replica.getRecord()).confirmedSnapshot?.serverSeq)
      .toBe(1);

    expect(client.coordinator.state).toBe("SYNCED");
    expect(await client.replica.getRecord()).toMatchObject({
      confirmedSnapshot: {
        serverSeq: 1,
        tabs: [expect.objectContaining({ url: "https://example.com/confirmed" })],
      },
      outbox: [],
    });
    expect(await operationCount(room.id)).toBe(1);
  });

  it("recovers commit-before-ACK after a process-style restart without duplicate submission", async () => {
    const owner = await createActiveSession("ack-loss-owner");
    const room = await createSharedRoom(owner);
    const persistence = new MemoryReplicaPersistence();
    const seed = createClient(owner, room.id, persistence);
    await seed.coordinator.start();
    await seed.coordinator.stop();

    const pending = await seed.replica.enqueueLocalOperation(
      createTabOperation("https://example.com/ack-lost"),
    );
    const failing = createClient(
      owner,
      room.id,
      persistence,
      new AckDroppingTransport({
        serverUrl: baseUrl,
        accessToken: owner.accessToken,
      }),
    );

    await expect(failing.coordinator.start()).rejects.toThrow("simulated ACK loss");
    expect(await operationCount(room.id)).toBe(1);
    expect((await failing.replica.getRecord()).outbox[0]?.envelope.clientOpId).toBe(
      pending.envelope.clientOpId,
    );

    const restarted = createClient(owner, room.id, persistence);
    await restarted.coordinator.start();

    expect(restarted.coordinator.state).toBe("SYNCED");
    expect(await restarted.replica.getRecord()).toMatchObject({
      confirmedSnapshot: { serverSeq: 1 },
      outbox: [],
    });
    expect(await operationCount(room.id)).toBe(1);
  });

  it("stops and retains unsent intent when the owner removes the member", async () => {
    const owner = await createActiveSession("removal-owner");
    const member = await createActiveSession("removed-member");
    const room = await createSharedRoom(owner, member);
    const client = createClient(member, room.id, new MemoryReplicaPersistence());
    await client.coordinator.start();
    await rooms.removeMember({
      actorUserId: owner.userId,
      roomId: room.id,
      memberUserId: member.userId,
    });

    await expect(
      client.coordinator.enqueueLocalOperation(createTabOperation("https://example.com/removed")),
    ).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });

    expect(client.coordinator.state).toBe("DISCONNECTED");
    expect(client.coordinator.isActuatable()).toBe(false);
    expect((await client.replica.getRecord()).outbox).toHaveLength(1);
    expect(await operationCount(room.id)).toBe(0);
  });

  it("stops and retains unsent intent when the account is suspended", async () => {
    const owner = await createActiveSession("suspended-owner");
    const room = await createSharedRoom(owner);
    const client = createClient(owner, room.id, new MemoryReplicaPersistence());
    await client.coordinator.start();
    await administrators.suspendUser({
      administratorId,
      userId: owner.userId,
    });

    await expect(
      client.coordinator.enqueueLocalOperation(createTabOperation("https://example.com/suspended")),
    ).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });

    expect(client.coordinator.isActuatable()).toBe(false);
    expect((await client.replica.getRecord()).outbox).toHaveLength(1);
    expect(await operationCount(room.id)).toBe(0);
  });

  it("stops and retains unsent intent when the room is deleted", async () => {
    const owner = await createActiveSession("deleted-room-owner");
    const room = await createSharedRoom(owner);
    const client = createClient(owner, room.id, new MemoryReplicaPersistence());
    await client.coordinator.start();
    await rooms.softDeleteRoom({
      actorUserId: owner.userId,
      roomId: room.id,
    });

    await expect(
      client.coordinator.enqueueLocalOperation(createTabOperation("https://example.com/deleted")),
    ).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });

    expect(client.coordinator.isActuatable()).toBe(false);
    expect((await client.replica.getRecord()).outbox).toHaveLength(1);
    expect(await operationCount(room.id)).toBe(0);
  });

  it("orphans stale intent and quarantines the replica after a room epoch change", async () => {
    const owner = await createActiveSession("epoch-owner");
    const room = await createSharedRoom(owner);
    const persistence = new MemoryReplicaPersistence();
    const seed = createClient(owner, room.id, persistence);
    await seed.coordinator.start();
    await seed.coordinator.stop();
    const pending = await seed.replica.enqueueLocalOperation(
      createTabOperation("https://example.com/old-epoch"),
    );
    await db
      .updateTable("rooms")
      .set({ roomEpoch: 1 })
      .where("id", "=", room.id)
      .executeTakeFirstOrThrow();

    const restarted = createClient(owner, room.id, persistence);
    await restarted.coordinator.start();
    const record = await restarted.replica.getRecord();

    expect(restarted.coordinator.state).toBe("QUARANTINED");
    expect(restarted.coordinator.isActuatable()).toBe(false);
    expect(record).toMatchObject({
      mode: "QUARANTINED",
      confirmedSnapshot: { roomEpoch: 1, serverSeq: 0 },
      outbox: [],
      orphanedOutbox: [
        expect.objectContaining({
          envelope: expect.objectContaining({
            clientOpId: pending.envelope.clientOpId,
            roomEpoch: 0,
          }),
        }),
      ],
      bindings: [],
      quarantineReason: "ROOM_EPOCH_CHANGED",
    });
    expect(await operationCount(room.id)).toBe(0);
  });
});
