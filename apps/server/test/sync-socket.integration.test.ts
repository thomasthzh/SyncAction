import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AccountService, createAccessTokenCodec } from "@syncaction/identity";
import {
  AnnotationAckSchema,
  AnnotationAckV2Schema,
  AnnotationCommittedOperationSchema,
  AnnotationCommittedOperationV2Schema,
  AnnotationDeltaMessageSchema,
  AnnotationOperationV2Schema,
  AnnotationSnapshotMessageSchema,
  AnnotationSnapshotV2MessageSchema,
  AnnotationSubmitSchema,
  AnnotationSubmitV2Schema,
  AnnotationSyncRequestSchema,
  type AnnotationAck,
  type AnnotationAckV2,
  type AnnotationCommittedOperation,
  type AnnotationCommittedOperationV2,
  type AnnotationDeltaMessage,
  type AnnotationDeltaV2Message,
  type AnnotationSnapshotMessage,
  type AnnotationSnapshotV2Message,
  type AnnotationSubmit,
  type AnnotationSubmitV2,
  type AnnotationSyncRequest,
  type ClientOperationEnvelope,
  type CommittedOperation,
  DanmakuAckSchema,
  DanmakuEventMessageSchema,
  DanmakuSendSchema,
  type DanmakuAck,
  type DanmakuEventMessage,
  type DanmakuSend,
  MediaCommandAckSchema,
  MediaGroupsSnapshotMessageSchema,
  MediaHeartbeatAckSchema,
  MediaTargetSchema,
  type MediaCommand,
  type MediaCommandAck,
  type MediaGroupsSnapshotMessage,
  type MediaHeartbeat,
  type MediaHeartbeatAck,
  NotificationReadEventSchema,
  NotificationSchema,
  type Notification,
  type NotificationReadEvent,
  PointerAckSchema,
  PointerClearMessageSchema,
  PointerFrameEventSchema,
  PointerLeaseAckSchema,
  PointerLeaseClearSchema,
  PointerLeaseEventSchema,
  PointerLeaseSnapshotSchema,
  type PointerClearMessage,
  PointerEventMessageSchema,
  type PointerFrame,
  type PointerFrameEvent,
  type PointerLeaseAck,
  type PointerLeaseClear,
  type PointerLeaseEvent,
  type PointerLeaseSnapshot,
  type PointerLeaseUpdate,
  type PointerEventMessage,
  PointerSnapshotMessageSchema,
  type PointerSnapshotMessage,
  type PointerUpdate,
  PresenceAckSchema,
  PresenceDeltaMessageSchema,
  PresenceSnapshotMessageSchema,
  PresenceSnapshotV2MessageSchema,
  type PresenceDeltaMessage,
  type PresenceSnapshotMessage,
  type PresenceSnapshotV2Message,
  type PresenceUpdateV2,
  PublicRoomsInvalidatedSchema,
  type PublicRoomsInvalidated,
  RoomDeltaMessageSchema,
  RoomEventMessageSchema,
  type RoomEventMessage,
  RoomSnapshotMessageSchema,
  type ServerMessage,
  StrokePreviewClearMessageSchema,
  StrokePreviewClearSchema,
  type StrokePreviewClear,
  type StrokePreviewClearMessage,
  StrokePreviewEventMessageSchema,
  StrokePreviewUpdateSchema,
  type StrokePreviewEventMessage,
  type StrokePreviewUpdate,
} from "@syncaction/protocol";
import { NotificationService, RoomProductEventBus, RoomService } from "@syncaction/rooms";
import { RoomPresenceService, RoomSequencer } from "@syncaction/sync";
import type { FastifyInstance } from "fastify";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildPublicApp } from "../src/app.js";
import { SYNC_SOCKET_CONNECTION_OPTIONS } from "../src/sync-socket.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const now = new Date("2026-07-27T00:00:00.000Z");
const annotationHmacKey = new Uint8Array(32).fill(23);

interface ServerToClientEvents {
  "annotation.ack.v2": (acknowledgement: AnnotationAckV2) => void;
  "annotation.snapshot": (snapshot: AnnotationSnapshotMessage) => void;
  "annotation.snapshot.v2": (snapshot: AnnotationSnapshotV2Message) => void;
  "annotation.delta": (delta: AnnotationDeltaMessage) => void;
  "annotation.delta.v2": (delta: AnnotationDeltaV2Message) => void;
  "annotation.committed": (operation: AnnotationCommittedOperation) => void;
  "annotation.committed.v2": (operation: AnnotationCommittedOperationV2) => void;
  "danmaku.event": (event: DanmakuEventMessage) => void;
  "op.committed": (operation: CommittedOperation) => void;
  "presence.delta.v2": (delta: PresenceDeltaMessage) => void;
  "presence.snapshot": (snapshot: PresenceSnapshotMessage) => void;
  "presence.snapshot.v2": (snapshot: PresenceSnapshotV2Message) => void;
  "pointer.frame": (event: PointerFrameEvent) => void;
  "pointer.lease.clear": (clear: PointerLeaseClear) => void;
  "pointer.lease.event": (event: PointerLeaseEvent) => void;
  "pointer.lease.snapshot": (snapshot: PointerLeaseSnapshot) => void;
  "pointer.event": (event: PointerEventMessage) => void;
  "pointer.clear": (clear: PointerClearMessage) => void;
  "pointer.snapshot": (snapshot: PointerSnapshotMessage) => void;
  "media.groups.snapshot": (snapshot: MediaGroupsSnapshotMessage) => void;
  "room.event": (event: RoomEventMessage) => void;
  "notification.created": (notification: Notification) => void;
  "notification.read": (message: NotificationReadEvent) => void;
  "public-rooms.invalidated": (message: PublicRoomsInvalidated) => void;
  "stroke.preview.event": (event: StrokePreviewEventMessage) => void;
  "stroke.preview.clear": (clear: StrokePreviewClearMessage) => void;
}

interface ClientToServerEvents {
  "annotation.sync": (
    request: AnnotationSyncRequest,
    acknowledge: (
      message:
        | AnnotationSnapshotMessage
        | AnnotationDeltaMessage
        | AnnotationSnapshotV2Message
        | AnnotationDeltaV2Message
        | ServerMessage,
    ) => void,
  ) => void;
  "annotation.submit": (
    submission: AnnotationSubmit,
    acknowledge: (message: AnnotationAck | ServerMessage) => void,
  ) => void;
  "annotation.submit.v2": (
    submission: AnnotationSubmitV2,
    acknowledge: (message: AnnotationAckV2 | ServerMessage) => void,
  ) => void;
  "danmaku.send": (
    message: DanmakuSend,
    acknowledge: (message: DanmakuAck | ServerMessage) => void,
  ) => void;
  "room.sync": (
    request: {
      protocolVersion: 1;
      roomId: string;
      roomEpoch: number;
      lastServerSeq: number;
      hasConfirmedSnapshot: boolean;
    },
    acknowledge: (message: ServerMessage) => void,
  ) => void;
  "operation.submit": (
    envelope: ClientOperationEnvelope,
    acknowledge: (message: ServerMessage) => void,
  ) => void;
  "presence.update": (
    update: {
      type: "presence.update";
      protocolVersion: 1;
      roomId: string;
      logicalTabId: string | null;
    },
    acknowledge: (message: ServerMessage) => void,
  ) => void;
  "presence.update.v2": (
    update: PresenceUpdateV2,
    acknowledge: (message: ServerMessage) => void,
  ) => void;
  "pointer.update": (update: PointerUpdate, acknowledge: (message: ServerMessage) => void) => void;
  "pointer.lease": (
    update: PointerLeaseUpdate,
    acknowledge: (message: PointerLeaseAck | ServerMessage) => void,
  ) => void;
  "pointer.frame": (frame: PointerFrame) => void;
  "stroke.preview.update": (update: StrokePreviewUpdate) => void;
  "stroke.preview.clear": (clear: StrokePreviewClear) => void;
  "media.command": (
    command: MediaCommand,
    acknowledge: (message: MediaCommandAck | ServerMessage) => void,
  ) => void;
  "media.heartbeat": (
    heartbeat: MediaHeartbeat,
    acknowledge?: (message: MediaHeartbeatAck | ServerMessage) => void,
  ) => void;
}

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface ActiveSession {
  userId: string;
  username: string;
  deviceId: string;
  accessToken: string;
}

let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let rooms: RoomService;
let notifications: NotificationService;
let productEvents: RoomProductEventBus;
let sequencer: RoomSequencer;
let app: FastifyInstance;
let baseUrl: string;
const sockets = new Set<TestSocket>();

class BlockingPresenceService extends RoomPresenceService {
  #barrier:
    | {
        markEntered(): void;
        entered: Promise<void>;
        wait: Promise<void>;
      }
    | undefined;

  public blockNextUpdate(): { entered: Promise<void>; release(): void } {
    let markEntered = (): void => undefined;
    let release = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#barrier = { markEntered, entered, wait };
    return { entered, release };
  }

  public override async update(input: Parameters<RoomPresenceService["update"]>[0]) {
    const barrier = this.#barrier;
    if (barrier !== undefined) {
      this.#barrier = undefined;
      barrier.markEntered();
      await barrier.wait;
    }
    return super.update(input);
  }
}

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(17),
      now: () => now,
    }),
    now: () => now,
  });
  productEvents = new RoomProductEventBus();
  notifications = new NotificationService({
    db,
    events: productEvents,
    now: () => now,
  });
  rooms = new RoomService({
    db,
    events: productEvents,
    notifications,
    now: () => now,
  });
  sequencer = new RoomSequencer({ db, now: () => now });
  app = await buildPublicApp({
    db,
    accounts,
    rooms,
    notifications,
    productEvents,
    sequencer,
    annotationHmacKey,
    now: () => now,
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
  for (const socket of sockets) {
    socket.disconnect();
  }
  await app.close();
  await db.destroy();
});

beforeEach(async () => {
  for (const socket of sockets) {
    socket.disconnect();
  }
  sockets.clear();
  await db.deleteFrom("notifications").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

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

async function createAdditionalDeviceSession(account: ActiveSession): Promise<ActiveSession> {
  const deviceId = randomUUID();
  const session = await accounts.login({
    username: account.username,
    password: "correct horse battery",
    deviceId,
  });
  return {
    userId: account.userId,
    username: account.username,
    deviceId,
    accessToken: session.accessToken,
  };
}

async function createSharedRoom(owner: ActiveSession, member?: ActiveSession) {
  const room = await rooms.createRoom({ actorUserId: owner.userId, name: "Socket room" });
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

function createPresenceV2Update(
  roomId: string,
  logicalTabId: string,
  canonicalPageIdentity: string,
  tabUpdatedAtSeq = 1,
): PresenceUpdateV2 {
  return {
    type: "presence.update.v2",
    protocolVersion: 1,
    roomId: roomId as PresenceUpdateV2["roomId"],
    logicalTabId: logicalTabId as PresenceUpdateV2["logicalTabId"],
    contentContext: {
      documentRevision: {
        roomEpoch: 0,
        tabUpdatedAtSeq,
      },
      canonicalPageIdentity,
      contentSignature: {
        signatureVersion: 1,
        digest: "A".repeat(43),
      },
      media: null,
    },
  };
}

function createSocket(
  accessToken?: string,
  url = baseUrl,
  realtimeProtocolVersion?: number,
  transports: Array<"websocket" | "polling"> = ["websocket"],
): TestSocket {
  const auth: Record<string, unknown> = {};
  if (accessToken !== undefined) {
    auth.accessToken = accessToken;
  }
  if (realtimeProtocolVersion !== undefined) {
    auth.realtimeProtocolVersion = realtimeProtocolVersion;
  }
  const socket = io(url, {
    autoConnect: false,
    transports,
    reconnection: false,
    auth,
  }) as TestSocket;
  sockets.add(socket);
  return socket;
}

async function connect(socket: TestSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("socket connect timed out")), 3_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.connect();
  });
}

async function rejectedConnection(socket: TestSocket): Promise<Error & { data?: unknown }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("socket rejection timed out")), 3_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      reject(new Error("socket unexpectedly connected"));
    });
    socket.once("connect_error", (error: Error & { data?: unknown }) => {
      clearTimeout(timeout);
      resolve(error);
    });
    socket.connect();
  });
}

function syncRequest(roomId: string, roomEpoch: number, lastServerSeq: number) {
  return {
    protocolVersion: 1 as const,
    roomId,
    roomEpoch,
    lastServerSeq,
    hasConfirmedSnapshot: lastServerSeq > 0,
  };
}

function createEnvelope(
  session: ActiveSession,
  roomId: string,
  baseServerSeq: number,
  url: string,
): ClientOperationEnvelope {
  return {
    protocolVersion: 1,
    clientOpId: randomUUID() as ClientOperationEnvelope["clientOpId"],
    roomId: roomId as ClientOperationEnvelope["roomId"],
    roomEpoch: 0,
    deviceId: session.deviceId as ClientOperationEnvelope["deviceId"],
    baseServerSeq,
    operation: {
      type: "tab.create",
      logicalTabId: randomUUID() as ClientOperationEnvelope["operation"]["logicalTabId"],
      url,
      after: null,
    },
  };
}

async function nextPresence(socket: TestSocket): Promise<PresenceSnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("presence snapshot timed out")), 3_000);
    socket.once("presence.snapshot", (snapshot) => {
      clearTimeout(timeout);
      resolve(PresenceSnapshotMessageSchema.parse(snapshot));
    });
  });
}

async function nextPresenceV2Snapshot(socket: TestSocket): Promise<PresenceSnapshotV2Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("presence v2 snapshot timed out")), 3_000);
    socket.once("presence.snapshot.v2", (snapshot) => {
      clearTimeout(timeout);
      resolve(PresenceSnapshotV2MessageSchema.parse(snapshot));
    });
  });
}

async function nextPresenceDelta(socket: TestSocket): Promise<PresenceDeltaMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("presence delta timed out")), 3_000);
    socket.once("presence.delta.v2", (delta) => {
      clearTimeout(timeout);
      resolve(PresenceDeltaMessageSchema.parse(delta));
    });
  });
}

async function nextPointerEvent(socket: TestSocket): Promise<PointerEventMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pointer event timed out")), 3_000);
    socket.once("pointer.event", (event) => {
      clearTimeout(timeout);
      resolve(PointerEventMessageSchema.parse(event));
    });
  });
}

async function nextPointerClear(socket: TestSocket): Promise<PointerClearMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pointer clear timed out")), 3_000);
    socket.once("pointer.clear", (clear) => {
      clearTimeout(timeout);
      resolve(PointerClearMessageSchema.parse(clear));
    });
  });
}

async function nextPointerSnapshot(socket: TestSocket): Promise<PointerSnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pointer snapshot timed out")), 3_000);
    socket.once("pointer.snapshot", (snapshot) => {
      clearTimeout(timeout);
      resolve(PointerSnapshotMessageSchema.parse(snapshot));
    });
  });
}

async function nextPointerLeaseSnapshot(socket: TestSocket): Promise<PointerLeaseSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pointer lease snapshot timed out")), 3_000);
    socket.once("pointer.lease.snapshot", (snapshot) => {
      clearTimeout(timeout);
      resolve(PointerLeaseSnapshotSchema.parse(snapshot));
    });
  });
}

async function nextPointerLeaseEvent(socket: TestSocket): Promise<PointerLeaseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pointer lease event timed out")), 3_000);
    socket.once("pointer.lease.event", (event) => {
      clearTimeout(timeout);
      resolve(PointerLeaseEventSchema.parse(event));
    });
  });
}

async function nextPointerLeaseClear(socket: TestSocket): Promise<PointerLeaseClear> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pointer lease clear timed out")), 3_000);
    socket.once("pointer.lease.clear", (clear) => {
      clearTimeout(timeout);
      resolve(PointerLeaseClearSchema.parse(clear));
    });
  });
}

async function nextPointerFrame(socket: TestSocket): Promise<PointerFrameEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("pointer frame timed out")), 3_000);
    socket.once("pointer.frame", (event) => {
      clearTimeout(timeout);
      resolve(PointerFrameEventSchema.parse(event));
    });
  });
}

async function nextAnnotationSnapshot(socket: TestSocket): Promise<AnnotationSnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("annotation snapshot timed out")), 3_000);
    socket.once("annotation.snapshot", (snapshot) => {
      clearTimeout(timeout);
      resolve(AnnotationSnapshotMessageSchema.parse(snapshot));
    });
  });
}

async function nextAnnotationDelta(socket: TestSocket): Promise<AnnotationDeltaMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("annotation delta timed out")), 3_000);
    socket.once("annotation.delta", (delta) => {
      clearTimeout(timeout);
      resolve(AnnotationDeltaMessageSchema.parse(delta));
    });
  });
}

async function nextAnnotationCommitted(socket: TestSocket): Promise<AnnotationCommittedOperation> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("annotation commit timed out")), 3_000);
    socket.once("annotation.committed", (operation) => {
      clearTimeout(timeout);
      resolve(AnnotationCommittedOperationSchema.parse(operation));
    });
  });
}

async function nextAnnotationV2Snapshot(socket: TestSocket): Promise<AnnotationSnapshotV2Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("annotation v2 snapshot timed out")), 3_000);
    socket.once("annotation.snapshot.v2", (snapshot) => {
      clearTimeout(timeout);
      resolve(AnnotationSnapshotV2MessageSchema.parse(snapshot));
    });
  });
}

async function nextAnnotationV2Committed(
  socket: TestSocket,
): Promise<AnnotationCommittedOperationV2> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("annotation v2 commit timed out")), 3_000);
    socket.once("annotation.committed.v2", (operation) => {
      clearTimeout(timeout);
      resolve(AnnotationCommittedOperationV2Schema.parse(operation));
    });
  });
}

async function nextDanmakuEvent(socket: TestSocket): Promise<DanmakuEventMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("danmaku event timed out")), 3_000);
    socket.once("danmaku.event", (event) => {
      clearTimeout(timeout);
      resolve(DanmakuEventMessageSchema.parse(event));
    });
  });
}

async function nextPreviewEvent(socket: TestSocket): Promise<StrokePreviewEventMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("stroke preview timed out")), 3_000);
    socket.once("stroke.preview.event", (event) => {
      clearTimeout(timeout);
      resolve(StrokePreviewEventMessageSchema.parse(event));
    });
  });
}

async function nextPreviewClear(socket: TestSocket): Promise<StrokePreviewClearMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("stroke preview clear timed out")), 3_000);
    socket.once("stroke.preview.clear", (clear) => {
      clearTimeout(timeout);
      resolve(StrokePreviewClearMessageSchema.parse(clear));
    });
  });
}

async function nextMediaSnapshot(
  socket: TestSocket,
  predicate: (snapshot: MediaGroupsSnapshotMessage) => boolean = () => true,
): Promise<MediaGroupsSnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("media.groups.snapshot", onSnapshot);
      reject(new Error("media snapshot timed out"));
    }, 3_000);
    const onSnapshot = (snapshotInput: MediaGroupsSnapshotMessage) => {
      const snapshot = MediaGroupsSnapshotMessageSchema.parse(snapshotInput);
      if (!predicate(snapshot)) {
        return;
      }
      clearTimeout(timeout);
      socket.off("media.groups.snapshot", onSnapshot);
      resolve(snapshot);
    };
    socket.on("media.groups.snapshot", onSnapshot);
  });
}

async function nextRoomEvent(
  socket: TestSocket,
  predicate: (event: RoomEventMessage) => boolean = () => true,
): Promise<RoomEventMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("room.event", onEvent);
      reject(new Error("room event timed out"));
    }, 3_000);
    const onEvent = (eventInput: RoomEventMessage): void => {
      const event = RoomEventMessageSchema.parse(eventInput);
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      socket.off("room.event", onEvent);
      resolve(event);
    };
    socket.on("room.event", onEvent);
  });
}

async function nextNotification(
  socket: TestSocket,
  predicate: (notification: Notification) => boolean = () => true,
): Promise<Notification> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("notification.created", onNotification);
      reject(new Error("notification timed out"));
    }, 3_000);
    const onNotification = (notificationInput: Notification): void => {
      const notification = NotificationSchema.parse(notificationInput);
      if (!predicate(notification)) {
        return;
      }
      clearTimeout(timeout);
      socket.off("notification.created", onNotification);
      resolve(notification);
    };
    socket.on("notification.created", onNotification);
  });
}

async function nextNotificationRead(socket: TestSocket): Promise<NotificationReadEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("notification.read", onRead);
      reject(new Error("notification read timed out"));
    }, 3_000);
    const onRead = (readInput: NotificationReadEvent): void => {
      clearTimeout(timeout);
      socket.off("notification.read", onRead);
      resolve(NotificationReadEventSchema.parse(readInput));
    };
    socket.on("notification.read", onRead);
  });
}

async function nextPublicInvalidation(
  socket: TestSocket,
  predicate: (message: PublicRoomsInvalidated) => boolean = () => true,
): Promise<PublicRoomsInvalidated> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("public-rooms.invalidated", onInvalidation);
      reject(new Error("public invalidation timed out"));
    }, 3_000);
    const onInvalidation = (messageInput: PublicRoomsInvalidated): void => {
      const message = PublicRoomsInvalidatedSchema.parse(messageInput);
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timeout);
      socket.off("public-rooms.invalidated", onInvalidation);
      resolve(message);
    };
    socket.on("public-rooms.invalidated", onInvalidation);
  });
}

async function settleSocketDelivery(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
}

describe("authenticated room socket transport", () => {
  it("configures polling fallback and bounded middleware-rerun connection recovery", () => {
    expect(SYNC_SOCKET_CONNECTION_OPTIONS).toEqual({
      transports: ["websocket", "polling"],
      connectionStateRecovery: {
        maxDisconnectionDuration: 120_000,
        skipMiddlewares: false,
      },
    });
  });

  it("rejects missing and invalid tokens before exposing room state", async () => {
    const missing = await rejectedConnection(createSocket());
    const invalid = await rejectedConnection(createSocket("not-a-token"));

    expect(missing.data).toMatchObject({ type: "sync.error", code: "SYNC_AUTH_REQUIRED" });
    expect(invalid.data).toMatchObject({ type: "sync.error", code: "SYNC_AUTH_REQUIRED" });
  });

  it("accepts an authenticated room sync over polling-only transport", async () => {
    const owner = await createActiveSession("polling-owner");
    const room = await createSharedRoom(owner);
    const pollingSocket = createSocket(owner.accessToken, baseUrl, 2, ["polling"]);

    await connect(pollingSocket);
    await expect(
      pollingSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ).resolves.toMatchObject({
      type: "room.snapshot",
      state: { roomId: room.id },
    });
  });

  it("streams room lifecycle and durable notification events through authorized channels", async () => {
    const owner = await createActiveSession("product-owner");
    const applicant = await createActiveSession("product-applicant");
    const room = await rooms.createRoom({
      actorUserId: owner.userId,
      name: "Product room",
      visibility: "PUBLIC",
      joinPolicy: "APPROVAL",
    });
    const ownerSocket = createSocket(owner.accessToken);
    const unsyncedOwnerSocket = createSocket(owner.accessToken);
    const applicantSocket = createSocket(applicant.accessToken);
    await Promise.all([
      connect(ownerSocket),
      connect(unsyncedOwnerSocket),
      connect(applicantSocket),
    ]);
    await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));

    let ownerRoomEventCount = 0;
    let unsyncedOwnerRoomEventCount = 0;
    ownerSocket.on("room.event", () => {
      ownerRoomEventCount += 1;
    });
    unsyncedOwnerSocket.on("room.event", () => {
      unsyncedOwnerRoomEventCount += 1;
    });

    const requestNotification = nextNotification(
      ownerSocket,
      (notification) => notification.type === "ROOM_JOIN_REQUEST_CREATED",
    );
    const requestResponse = await app.inject({
      method: "POST",
      url: `/v1/rooms/${room.id}/join-requests`,
      headers: { authorization: `Bearer ${applicant.accessToken}` },
      payload: {},
    });
    expect(requestResponse.statusCode).toBe(201);
    const requestId = (requestResponse.json() as { requestId: string }).requestId;
    await expect(requestNotification).resolves.toMatchObject({
      type: "ROOM_JOIN_REQUEST_CREATED",
      requestId,
    });

    const joinedEvent = nextRoomEvent(ownerSocket, (event) => event.kind === "ROOM_MEMBER_JOINED");
    const approvedNotification = nextNotification(
      applicantSocket,
      (notification) => notification.type === "ROOM_JOIN_REQUEST_APPROVED",
    );
    const decisionPayload = {
      decision: "APPROVE",
      clientOpId: randomUUID(),
    };
    const decisionResponse = await app.inject({
      method: "POST",
      url: `/v1/room-join-requests/${requestId}/decision`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: decisionPayload,
    });
    expect(decisionResponse.statusCode).toBe(200);
    await expect(joinedEvent).resolves.toMatchObject({
      kind: "ROOM_MEMBER_JOINED",
      roomId: room.id,
      roomRevision: 1,
      member: { userId: applicant.userId },
    });
    const approved = await approvedNotification;
    expect(approved).toMatchObject({
      type: "ROOM_JOIN_REQUEST_APPROVED",
      requestId,
      decision: "APPROVED",
    });

    await app.inject({
      method: "POST",
      url: `/v1/room-join-requests/${requestId}/decision`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: decisionPayload,
    });
    await settleSocketDelivery();
    expect(ownerRoomEventCount).toBe(1);
    expect(unsyncedOwnerRoomEventCount).toBe(0);

    const readEvent = nextNotificationRead(applicantSocket);
    const readResponse = await app.inject({
      method: "POST",
      url: `/v1/notifications/${approved.notificationId}/read`,
      headers: { authorization: `Bearer ${applicant.accessToken}` },
      payload: {},
    });
    expect(readResponse.statusCode).toBe(200);
    await expect(readEvent).resolves.toMatchObject({
      kind: "ONE",
      notificationId: approved.notificationId,
    });

    await applicantSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    const ownerTransfer = nextRoomEvent(
      applicantSocket,
      (event) => event.kind === "ROOM_OWNER_TRANSFERRED",
    );
    await rooms.transferOwnership({
      actorUserId: owner.userId,
      roomId: room.id,
      newOwnerUserId: applicant.userId,
    });
    await expect(ownerTransfer).resolves.toMatchObject({
      kind: "ROOM_OWNER_TRANSFERRED",
      roomRevision: 2,
      previousOwnerUserId: owner.userId,
      newOwnerUserId: applicant.userId,
    });

    const ownerLeft = nextRoomEvent(applicantSocket, (event) => event.kind === "ROOM_MEMBER_LEFT");
    await rooms.leaveRoom({
      actorUserId: owner.userId,
      roomId: room.id,
    });
    await expect(ownerLeft).resolves.toMatchObject({
      kind: "ROOM_MEMBER_LEFT",
      roomRevision: 3,
      userId: owner.userId,
    });

    const dissolved = nextRoomEvent(applicantSocket, (event) => event.kind === "ROOM_DISSOLVED");
    await rooms.softDeleteRoom({
      actorUserId: applicant.userId,
      roomId: room.id,
    });
    await expect(dissolved).resolves.toMatchObject({
      kind: "ROOM_DISSOLVED",
      roomRevision: 4,
    });
  });

  it("exposes an invalidation-only anonymous public namespace", async () => {
    const owner = await createActiveSession("public-socket-owner");
    const publicRoom = await rooms.createRoom({
      actorUserId: owner.userId,
      name: "Visible room",
      visibility: "PUBLIC",
      joinPolicy: "OPEN",
    });
    const privateRoom = await rooms.createRoom({
      actorUserId: owner.userId,
      name: "Private room",
    });
    const ownerSocket = createSocket(owner.accessToken);
    const publicSocket = createSocket(undefined, `${baseUrl}/public`);
    const publicEvents: Array<{ event: string; payload: unknown }> = [];
    publicSocket.onAny((event, payload) => {
      publicEvents.push({ event, payload });
    });
    await Promise.all([connect(ownerSocket), connect(publicSocket)]);

    await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(publicRoom.id, 0, 0));
    const publicTabInvalidation = nextPublicInvalidation(
      publicSocket,
      (message) => message.reason === "TAB_STATE",
    );
    const publicEnvelope = createEnvelope(
      owner,
      publicRoom.id,
      0,
      "https://example.com/public-sensitive-path",
    );
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", publicEnvelope);
    await expect(publicTabInvalidation).resolves.toEqual({
      type: "public-rooms.invalidated",
      roomId: publicRoom.id,
      reason: "TAB_STATE",
      roomRevision: null,
    });

    const roomInvalidation = nextPublicInvalidation(
      publicSocket,
      (message) => message.reason === "ROOM",
    );
    await rooms.renameRoom({
      actorUserId: owner.userId,
      roomId: publicRoom.id,
      name: "Still visible",
    });
    await expect(roomInvalidation).resolves.toMatchObject({
      roomId: publicRoom.id,
      reason: "ROOM",
      roomRevision: 1,
    });

    await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(privateRoom.id, 0, 0));
    const privateEnvelope = createEnvelope(
      owner,
      privateRoom.id,
      0,
      "https://example.com/private-sensitive-path",
    );
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", privateEnvelope);
    await settleSocketDelivery();

    expect(publicEvents.map(({ event }) => event)).toEqual([
      "public-rooms.invalidated",
      "public-rooms.invalidated",
    ]);
    expect(JSON.stringify(publicEvents)).not.toContain("sensitive-path");

    const hostilePublicSocket = createSocket(undefined, `${baseUrl}/public`);
    await connect(hostilePublicSocket);
    const disconnected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("public socket stayed connected")), 3_000);
      hostilePublicSocket.once("disconnect", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    (
      hostilePublicSocket as unknown as {
        emit(event: string, payload: unknown): void;
      }
    ).emit("room.sync", syncRequest(publicRoom.id, 0, 0));
    await expect(disconnected).resolves.toBeUndefined();
  });

  it("synchronizes accepted members and hides rooms from nonmembers", async () => {
    const owner = await createActiveSession("socket-owner");
    const member = await createActiveSession("socket-member");
    const outsider = await createActiveSession("socket-outsider");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken);
    const memberSocket = createSocket(member.accessToken);
    const outsiderSocket = createSocket(outsider.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket), connect(outsiderSocket)]);

    const ownerResult = await ownerSocket
      .timeout(3_000)
      .emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    const memberResult = await memberSocket
      .timeout(3_000)
      .emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    const outsiderResult = await outsiderSocket
      .timeout(3_000)
      .emitWithAck("room.sync", syncRequest(room.id, 0, 0));

    expect(RoomSnapshotMessageSchema.parse(ownerResult).state).toMatchObject({
      roomId: room.id,
      serverSeq: 0,
    });
    expect(RoomSnapshotMessageSchema.parse(memberResult).state).toMatchObject({
      roomId: room.id,
      serverSeq: 0,
    });
    expect(outsiderResult).toMatchObject({
      type: "sync.error",
      code: "ROOM_NOT_FOUND",
      roomId: room.id,
    });
  });

  it("broadcasts authorized active-tab presence without advancing durable state", async () => {
    const owner = await createActiveSession("presence-owner");
    const member = await createActiveSession("presence-member");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken);
    const memberSocket = createSocket(member.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket)]);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);
    const envelope = createEnvelope(owner, room.id, 0, "https://example.com/presence");
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    const logicalTabId = envelope.operation.logicalTabId;
    const ownerSnapshot = nextPresence(ownerSocket);
    const memberSnapshot = nextPresence(memberSocket);

    const acknowledgement = await ownerSocket.timeout(3_000).emitWithAck("presence.update", {
      type: "presence.update",
      protocolVersion: 1,
      roomId: room.id,
      logicalTabId,
    });

    expect(PresenceAckSchema.parse(acknowledgement)).toMatchObject({
      roomId: room.id,
    });
    await expect(Promise.all([ownerSnapshot, memberSnapshot])).resolves.toEqual([
      expect.objectContaining({
        roomId: room.id,
        presences: [
          expect.objectContaining({
            userId: owner.userId,
            deviceId: owner.deviceId,
            logicalTabId,
          }),
        ],
      }),
      expect.objectContaining({
        roomId: room.id,
        presences: [
          expect.objectContaining({
            userId: owner.userId,
            deviceId: owner.deviceId,
            logicalTabId,
          }),
        ],
      }),
    ]);
    await expect(
      ownerSocket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: room.id,
        logicalTabId: randomUUID(),
      }),
    ).resolves.toMatchObject({ type: "sync.error", code: "ROOM_NOT_FOUND" });
    await expect(
      db
        .selectFrom("rooms")
        .select("serverSeq")
        .where("id", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ serverSeq: 1 });
    await expect(
      db
        .selectFrom("roomOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });

    const removalSnapshot = nextPresence(memberSocket);
    ownerSocket.disconnect();
    await expect(removalSnapshot).resolves.toMatchObject({
      roomId: room.id,
      presences: [],
    });
  });

  it("negotiates presence v2 deltas while preserving a throttled legacy snapshot bridge", async () => {
    const owner = await createActiveSession("presence-v2-owner");
    const member = await createActiveSession("presence-v2-member");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken, baseUrl, 2);
    const memberSocket = createSocket(member.accessToken, baseUrl, 2);
    const legacySocket = createSocket(member.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket), connect(legacySocket)]);

    let ownerLegacySnapshotCount = 0;
    let legacyV2SnapshotCount = 0;
    let legacyV2DeltaCount = 0;
    let ownerDeltaCount = 0;
    let memberDeltaCount = 0;
    const legacySnapshots: PresenceSnapshotMessage[] = [];
    ownerSocket.on("presence.snapshot", () => {
      ownerLegacySnapshotCount += 1;
    });
    ownerSocket.on("presence.delta.v2", () => {
      ownerDeltaCount += 1;
    });
    memberSocket.on("presence.delta.v2", () => {
      memberDeltaCount += 1;
    });
    legacySocket.on("presence.snapshot.v2", () => {
      legacyV2SnapshotCount += 1;
    });
    legacySocket.on("presence.delta.v2", () => {
      legacyV2DeltaCount += 1;
    });
    legacySocket.on("presence.snapshot", (snapshot) => {
      legacySnapshots.push(PresenceSnapshotMessageSchema.parse(snapshot));
    });

    const ownerInitial = nextPresenceV2Snapshot(ownerSocket);
    await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    await expect(ownerInitial).resolves.toMatchObject({
      roomId: room.id,
      presenceSeq: 0,
      presences: [],
    });
    const memberInitial = nextPresenceV2Snapshot(memberSocket);
    await memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    await expect(memberInitial).resolves.toMatchObject({
      roomId: room.id,
      presenceSeq: 0,
      presences: [],
    });
    const legacyInitial = nextPresence(legacySocket);
    await legacySocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    await expect(legacyInitial).resolves.toMatchObject({ roomId: room.id, presences: [] });
    await settleSocketDelivery();
    expect(ownerLegacySnapshotCount).toBe(0);
    expect(legacyV2SnapshotCount).toBe(0);

    const envelope = createEnvelope(owner, room.id, 0, "https://example.com/presence-v2");
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    const logicalTabId = envelope.operation.logicalTabId;
    const ownerDelta = nextPresenceDelta(ownerSocket);
    const memberDelta = nextPresenceDelta(memberSocket);
    const legacySnapshot = nextPresence(legacySocket);
    const firstUpdate = createPresenceV2Update(
      room.id,
      logicalTabId,
      "https://example.com/presence-v2",
    );

    await expect(
      ownerSocket.timeout(3_000).emitWithAck("presence.update.v2", firstUpdate),
    ).resolves.toMatchObject({ type: "presence.ack", roomId: room.id });
    await expect(Promise.all([ownerDelta, memberDelta])).resolves.toEqual([
      expect.objectContaining({
        roomId: room.id,
        fromPresenceSeq: 0,
        toPresenceSeq: 1,
        changes: [
          expect.objectContaining({
            kind: "UPSERT",
            presence: expect.objectContaining({
              userId: owner.userId,
              deviceId: owner.deviceId,
              logicalTabId,
              contentContext: firstUpdate.contentContext,
            }),
          }),
        ],
      }),
      expect.objectContaining({
        roomId: room.id,
        fromPresenceSeq: 0,
        toPresenceSeq: 1,
      }),
    ]);
    await expect(legacySnapshot).resolves.toMatchObject({
      roomId: room.id,
      presences: [
        expect.objectContaining({
          userId: owner.userId,
          logicalTabId,
        }),
      ],
    });
    expect(ownerDeltaCount).toBe(1);
    expect(memberDeltaCount).toBe(1);
    expect(legacySnapshots).toHaveLength(2);

    await ownerSocket.timeout(3_000).emitWithAck("presence.update.v2", firstUpdate);
    await settleSocketDelivery();
    expect(ownerDeltaCount).toBe(1);
    expect(memberDeltaCount).toBe(1);
    expect(legacySnapshots).toHaveLength(2);

    const changedUpdate = createPresenceV2Update(
      room.id,
      logicalTabId,
      "https://example.com/presence-v2?page=2",
    );
    const changedDelta = nextPresenceDelta(memberSocket);
    await ownerSocket.timeout(3_000).emitWithAck("presence.update.v2", changedUpdate);
    await expect(changedDelta).resolves.toMatchObject({
      fromPresenceSeq: 1,
      toPresenceSeq: 2,
      changes: [
        expect.objectContaining({
          kind: "UPSERT",
          presence: expect.objectContaining({
            contentContext: changedUpdate.contentContext,
          }),
        }),
      ],
    });
    await settleSocketDelivery();
    expect(ownerDeltaCount).toBe(2);
    expect(memberDeltaCount).toBe(2);
    expect(legacySnapshots).toHaveLength(2);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_050);
    });
    expect(legacySnapshots).toHaveLength(3);

    const removalDelta = nextPresenceDelta(memberSocket);
    ownerSocket.disconnect();
    await expect(removalDelta).resolves.toMatchObject({
      fromPresenceSeq: 2,
      toPresenceSeq: 3,
      changes: [
        {
          kind: "REMOVE",
          userId: owner.userId,
          deviceId: owner.deviceId,
        },
      ],
    });
    expect(ownerLegacySnapshotCount).toBe(0);
    expect(legacyV2SnapshotCount).toBe(0);
    expect(legacyV2DeltaCount).toBe(0);
  });

  it("invalidates public room presence only when the online user set changes", async () => {
    const owner = await createActiveSession("public-presence-owner");
    const ownerSecondDevice = await createAdditionalDeviceSession(owner);
    const member = await createActiveSession("public-presence-member");
    const room = await rooms.createRoom({
      actorUserId: owner.userId,
      name: "Public presence room",
      visibility: "PUBLIC",
      joinPolicy: "OPEN",
    });
    const invitation = await rooms.inviteByUsername({
      actorUserId: owner.userId,
      roomId: room.id,
      username: member.username,
    });
    await rooms.acceptInvitation({
      actorUserId: member.userId,
      invitationId: invitation.id,
    });
    const ownerSocket = createSocket(owner.accessToken, baseUrl, 2);
    const ownerSecondSocket = createSocket(ownerSecondDevice.accessToken, baseUrl, 2);
    const memberSocket = createSocket(member.accessToken, baseUrl, 2);
    const publicSocket = createSocket(undefined, `${baseUrl}/public`);
    await Promise.all([
      connect(ownerSocket),
      connect(ownerSecondSocket),
      connect(memberSocket),
      connect(publicSocket),
    ]);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      ownerSecondSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);

    const presenceInvalidations: PublicRoomsInvalidated[] = [];
    publicSocket.on("public-rooms.invalidated", (messageInput) => {
      const message = PublicRoomsInvalidatedSchema.parse(messageInput);
      if (message.reason === "PRESENCE") {
        presenceInvalidations.push(message);
      }
    });
    const envelope = createEnvelope(owner, room.id, 0, "https://example.com/public-presence");
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    const logicalTabId = envelope.operation.logicalTabId;
    const initialUpdate = createPresenceV2Update(
      room.id,
      logicalTabId,
      "https://example.com/public-presence",
    );

    await ownerSocket.timeout(3_000).emitWithAck("presence.update.v2", initialUpdate);
    await settleSocketDelivery();
    expect(presenceInvalidations).toEqual([
      {
        type: "public-rooms.invalidated",
        roomId: room.id,
        reason: "PRESENCE",
        roomRevision: null,
      },
    ]);

    await ownerSocket.timeout(3_000).emitWithAck("pointer.update", {
      type: "pointer.update",
      protocolVersion: 1,
      roomId: room.id as PointerUpdate["roomId"],
      logicalTabId: logicalTabId as PointerUpdate["logicalTabId"],
      documentRevision: {
        roomEpoch: 0,
        tabUpdatedAtSeq: 1,
      },
      anchor: null,
      viewport: { x: 0.5, y: 0.5 },
    });
    await ownerSocket
      .timeout(3_000)
      .emitWithAck(
        "presence.update.v2",
        createPresenceV2Update(room.id, logicalTabId, "https://example.com/public-presence?page=2"),
      );
    await ownerSecondSocket.timeout(3_000).emitWithAck("presence.update.v2", initialUpdate);
    await settleSocketDelivery();
    expect(presenceInvalidations).toHaveLength(1);

    await memberSocket.timeout(3_000).emitWithAck("presence.update.v2", initialUpdate);
    await settleSocketDelivery();
    expect(presenceInvalidations).toHaveLength(2);

    ownerSocket.disconnect();
    await settleSocketDelivery();
    expect(presenceInvalidations).toHaveLength(2);

    ownerSecondSocket.disconnect();
    await settleSocketDelivery();
    expect(presenceInvalidations).toHaveLength(3);
    expect(presenceInvalidations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomId: room.id,
          reason: "PRESENCE",
          roomRevision: null,
        }),
      ]),
    );
  });

  it("accepts unacknowledged media heartbeats and invalidates only public playback transitions", async () => {
    const owner = await createActiveSession("public-playback-owner");
    const publicRoom = await rooms.createRoom({
      actorUserId: owner.userId,
      name: "Public playback room",
      visibility: "PUBLIC",
      joinPolicy: "OPEN",
    });
    const ownerSocket = createSocket(owner.accessToken, baseUrl, 2);
    const publicSocket = createSocket(undefined, `${baseUrl}/public`);
    await Promise.all([connect(ownerSocket), connect(publicSocket)]);
    await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(publicRoom.id, 0, 0));
    const playbackInvalidations: PublicRoomsInvalidated[] = [];
    publicSocket.on("public-rooms.invalidated", (messageInput) => {
      const message = PublicRoomsInvalidatedSchema.parse(messageInput);
      if (message.reason === "PLAYBACK") {
        playbackInvalidations.push(message);
      }
    });

    const tab = createEnvelope(
      owner,
      publicRoom.id,
      0,
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", tab);
    await ownerSocket.timeout(3_000).emitWithAck("presence.update.v2", {
      ...createPresenceV2Update(publicRoom.id, tab.operation.logicalTabId, "youtube:dQw4w9WgXcQ"),
      contentContext: {
        ...createPresenceV2Update(publicRoom.id, tab.operation.logicalTabId, "youtube:dQw4w9WgXcQ")
          .contentContext!,
        media: {
          provider: "YOUTUBE",
          mediaKey: "youtube:dQw4w9WgXcQ",
        },
      },
    });
    const mediaTarget = MediaTargetSchema.parse({
      logicalTabId: tab.operation.logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 212_000,
    });
    const observed = {
      observedAtClientMs: now.getTime(),
      positionMs: 42_000,
      paused: false,
      playbackRate: 1,
      ended: false,
      buffering: false,
    };
    const createCommand: MediaCommand = {
      type: "group.create",
      protocolVersion: 1,
      commandId: randomUUID(),
      roomId: publicRoom.id as MediaCommand["roomId"],
      target: mediaTarget,
      observed,
    };
    const createdInvalidation = nextPublicInvalidation(
      publicSocket,
      (message) => message.reason === "PLAYBACK",
    );
    await expect(
      ownerSocket.timeout(3_000).emitWithAck("media.command", createCommand),
    ).resolves.toMatchObject({ type: "media.command.ack", accepted: true });
    await expect(createdInvalidation).resolves.toEqual({
      type: "public-rooms.invalidated",
      roomId: publicRoom.id,
      reason: "PLAYBACK",
      roomRevision: null,
    });

    const heartbeat: MediaHeartbeat = {
      type: "media.heartbeat",
      protocolVersion: 1,
      roomId: publicRoom.id as MediaHeartbeat["roomId"],
      playbackGroupId: createCommand.commandId,
      groupRevision: 1,
      target: mediaTarget,
      ...observed,
      positionMs: 80_000,
    };
    const heartbeatSnapshot = nextMediaSnapshot(
      ownerSocket,
      (snapshot) => snapshot.groups[0]?.observed?.positionMs === 80_000,
    );
    ownerSocket.emit("media.heartbeat", heartbeat);
    await expect(heartbeatSnapshot).resolves.toMatchObject({
      groups: [
        expect.objectContaining({ observed: expect.objectContaining({ positionMs: 80_000 }) }),
      ],
    });
    await settleSocketDelivery();
    expect(playbackInvalidations).toHaveLength(1);

    const endedInvalidation = nextPublicInvalidation(
      publicSocket,
      (message) => message.reason === "PLAYBACK",
    );
    const endedSnapshot = nextMediaSnapshot(
      ownerSocket,
      (snapshot) => snapshot.groups[0]?.status === "ENDED_WAITING",
    );
    ownerSocket.emit("media.heartbeat", {
      ...heartbeat,
      positionMs: mediaTarget.durationMs,
      paused: true,
      ended: true,
    });
    await expect(Promise.all([endedSnapshot, endedInvalidation])).resolves.toEqual([
      expect.objectContaining({
        groups: [expect.objectContaining({ status: "ENDED_WAITING" })],
      }),
      {
        type: "public-rooms.invalidated",
        roomId: publicRoom.id,
        reason: "PLAYBACK",
        roomRevision: null,
      },
    ]);

    const privateRoom = await rooms.createRoom({
      actorUserId: owner.userId,
      name: "Private playback room",
    });
    await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(privateRoom.id, 0, 0));
    const privateTab = createEnvelope(
      owner,
      privateRoom.id,
      0,
      "https://www.youtube.com/watch?v=9bZkp7q19f0",
    );
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", privateTab);
    await ownerSocket.timeout(3_000).emitWithAck("presence.update", {
      type: "presence.update",
      protocolVersion: 1,
      roomId: privateRoom.id,
      logicalTabId: privateTab.operation.logicalTabId,
    });
    await ownerSocket.timeout(3_000).emitWithAck("media.command", {
      ...createCommand,
      commandId: randomUUID(),
      roomId: privateRoom.id as MediaCommand["roomId"],
      target: {
        ...mediaTarget,
        logicalTabId: privateTab.operation.logicalTabId,
      },
    });
    await settleSocketDelivery();
    expect(JSON.stringify(playbackInvalidations)).not.toContain(privateRoom.id);
  });

  it("rejects an old-room presence update that resumes after a room switch", async () => {
    const owner = await createActiveSession("presence-switch-owner");
    const firstRoom = await createSharedRoom(owner);
    const secondRoom = await createSharedRoom(owner);
    const blockingPresence = new BlockingPresenceService({ db, now: () => now });
    const raceApp = await buildPublicApp({
      db,
      accounts,
      rooms,
      sequencer,
      annotationHmacKey,
      now: () => now,
      presence: blockingPresence,
      operationRateLimitMax: 100,
      logger: false,
    });
    await raceApp.listen({ host: "127.0.0.1", port: 0 });
    const address = raceApp.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an ephemeral TCP address");
    }
    const socket = createSocket(owner.accessToken, `http://127.0.0.1:${address.port}`);
    try {
      await connect(socket);
      await socket.timeout(3_000).emitWithAck("room.sync", syncRequest(firstRoom.id, 0, 0));
      const barrier = blockingPresence.blockNextUpdate();
      const staleUpdate = socket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: firstRoom.id,
        logicalTabId: null,
      });
      await barrier.entered;

      await expect(
        socket.timeout(3_000).emitWithAck("room.sync", syncRequest(secondRoom.id, 0, 0)),
      ).resolves.toMatchObject({
        type: "room.snapshot",
        state: { roomId: secondRoom.id },
      });
      barrier.release();

      await expect(staleUpdate).resolves.toMatchObject({
        type: "sync.error",
        code: "ROOM_NOT_FOUND",
        roomId: firstRoom.id,
      });
      expect(blockingPresence.snapshot(firstRoom.id).presences).toEqual([]);
    } finally {
      socket.disconnect();
      await raceApp.close();
    }
  });

  it("keeps an old-room presence update when a concurrent room switch fails", async () => {
    const owner = await createActiveSession("presence-failed-switch-owner");
    const room = await createSharedRoom(owner);
    const blockingPresence = new BlockingPresenceService({ db, now: () => now });
    const raceApp = await buildPublicApp({
      db,
      accounts,
      rooms,
      sequencer,
      annotationHmacKey,
      now: () => now,
      presence: blockingPresence,
      operationRateLimitMax: 100,
      logger: false,
    });
    await raceApp.listen({ host: "127.0.0.1", port: 0 });
    const address = raceApp.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an ephemeral TCP address");
    }
    const socket = createSocket(owner.accessToken, `http://127.0.0.1:${address.port}`);
    try {
      await connect(socket);
      await socket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
      const barrier = blockingPresence.blockNextUpdate();
      const validUpdate = socket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: room.id,
        logicalTabId: null,
      });
      await barrier.entered;

      await expect(
        socket.timeout(3_000).emitWithAck("room.sync", syncRequest(randomUUID(), 0, 0)),
      ).resolves.toMatchObject({
        type: "sync.error",
        code: "ROOM_NOT_FOUND",
      });
      barrier.release();

      await expect(validUpdate).resolves.toMatchObject({
        type: "presence.ack",
        roomId: room.id,
      });
      expect(blockingPresence.snapshot(room.id).presences).toHaveLength(1);
    } finally {
      socket.disconnect();
      await raceApp.close();
    }
  });

  it("broadcasts reliable pointer leases and a volatile latest-wins frame burst", async () => {
    const owner = await createActiveSession("pointer-v2-owner");
    const member = await createActiveSession("pointer-v2-member");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken, baseUrl, 2);
    const memberSocket = createSocket(member.accessToken, baseUrl, 2);
    await Promise.all([connect(ownerSocket), connect(memberSocket)]);

    let ownerLegacySnapshotCount = 0;
    let memberLegacySnapshotCount = 0;
    ownerSocket.on("pointer.snapshot", () => {
      ownerLegacySnapshotCount += 1;
    });
    memberSocket.on("pointer.snapshot", () => {
      memberLegacySnapshotCount += 1;
    });
    const ownerInitial = nextPointerLeaseSnapshot(ownerSocket);
    await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    await expect(ownerInitial).resolves.toMatchObject({ roomId: room.id, leases: [] });
    const memberInitial = nextPointerLeaseSnapshot(memberSocket);
    await memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    await expect(memberInitial).resolves.toMatchObject({ roomId: room.id, leases: [] });
    expect(ownerLegacySnapshotCount).toBe(0);
    expect(memberLegacySnapshotCount).toBe(0);

    const envelope = createEnvelope(owner, room.id, 0, "https://example.com/pointer-v2");
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    const logicalTabId = envelope.operation.logicalTabId;
    await ownerSocket
      .timeout(3_000)
      .emitWithAck(
        "presence.update.v2",
        createPresenceV2Update(room.id, logicalTabId, "https://example.com/pointer-v2"),
      );
    const before = await durablePointerCounts(room.id);
    const leaseId = randomUUID() as PointerLeaseUpdate["leaseId"];
    const leaseUpdate: PointerLeaseUpdate = {
      type: "pointer.lease",
      protocolVersion: 1,
      roomId: room.id as PointerLeaseUpdate["roomId"],
      deviceId: owner.deviceId as PointerLeaseUpdate["deviceId"],
      leaseId,
      logicalTabId: logicalTabId as PointerLeaseUpdate["logicalTabId"],
      documentRevision: {
        roomEpoch: 0,
        tabUpdatedAtSeq: 1,
      },
      anchor: null,
    };
    const ownerLeaseEvent = nextPointerLeaseEvent(ownerSocket);
    const memberLeaseEvent = nextPointerLeaseEvent(memberSocket);
    const leaseAck = PointerLeaseAckSchema.parse(
      await ownerSocket.timeout(3_000).emitWithAck("pointer.lease", leaseUpdate),
    );
    expect(leaseAck).toMatchObject({
      roomId: room.id,
      leaseId,
      accepted: true,
      expiresAt: expect.any(Number),
    });
    await expect(Promise.all([ownerLeaseEvent, memberLeaseEvent])).resolves.toEqual([
      expect.objectContaining({
        roomId: room.id,
        lease: expect.objectContaining({
          userId: owner.userId,
          deviceId: owner.deviceId,
          leaseId,
          logicalTabId,
        }),
      }),
      expect.objectContaining({
        lease: expect.objectContaining({
          userId: owner.userId,
          leaseId,
        }),
      }),
    ]);

    const receivedFrames: PointerFrameEvent[] = [];
    memberSocket.on("pointer.frame", (eventInput) => {
      receivedFrames.push(PointerFrameEventSchema.parse(eventInput));
    });
    let callbackCount = 0;
    const rawOwnerSocket = ownerSocket as unknown as {
      emit(event: "pointer.frame", frame: PointerFrame, acknowledge: () => void): void;
    };
    for (let sequence = 1; sequence <= 200; sequence += 1) {
      rawOwnerSocket.emit(
        "pointer.frame",
        {
          type: "pointer.frame",
          protocolVersion: 1,
          roomId: room.id as PointerFrame["roomId"],
          leaseId,
          seq: sequence,
          xQuantized: Math.min(4_095, sequence * 20),
          yQuantized: Math.max(0, 4_095 - sequence * 20),
          viewport: { widthBucket: 8, heightBucket: 5 },
          sentAtClientMs: Date.now(),
        },
        () => {
          callbackCount += 1;
        },
      );
    }
    await settleSocketDelivery();
    expect(callbackCount).toBe(0);
    expect(receivedFrames.length).toBeGreaterThan(0);
    expect(
      receivedFrames.every(
        (frameEvent, index) =>
          index === 0 || frameEvent.seq > (receivedFrames[index - 1]?.seq ?? 0),
      ),
    ).toBe(true);
    expect(receivedFrames.at(-1)?.seq).toBeGreaterThanOrEqual(190);

    const frameCountAfterBurst = receivedFrames.length;
    rawOwnerSocket.emit(
      "pointer.frame",
      {
        type: "pointer.frame",
        protocolVersion: 1,
        roomId: room.id as PointerFrame["roomId"],
        leaseId,
        seq: 199,
        xQuantized: 1,
        yQuantized: 1,
        viewport: { widthBucket: 8, heightBucket: 5 },
        sentAtClientMs: Date.now(),
      },
      () => {
        callbackCount += 1;
      },
    );
    await settleSocketDelivery();
    expect(receivedFrames).toHaveLength(frameCountAfterBurst);

    const newestFrame = nextPointerFrame(memberSocket);
    ownerSocket.emit("pointer.frame", {
      type: "pointer.frame",
      protocolVersion: 1,
      roomId: room.id as PointerFrame["roomId"],
      leaseId,
      seq: 201,
      xQuantized: 4_095,
      yQuantized: 0,
      viewport: { widthBucket: 8, heightBucket: 5 },
      sentAtClientMs: Date.now(),
    });
    await expect(newestFrame).resolves.toMatchObject({
      userId: owner.userId,
      deviceId: owner.deviceId,
      leaseId,
      seq: 201,
    });
    await expect(durablePointerCounts(room.id)).resolves.toEqual(before);

    const leaseClear = nextPointerLeaseClear(memberSocket);
    ownerSocket.disconnect();
    await expect(leaseClear).resolves.toMatchObject({
      roomId: room.id,
      userId: owner.userId,
      deviceId: owner.deviceId,
      leaseId,
    });
  });

  it("broadcasts recent-lease pointers without advancing or writing durable room state", async () => {
    const owner = await createActiveSession("pointer-owner");
    const member = await createActiveSession("pointer-member");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken);
    const memberSocket = createSocket(member.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket)]);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);
    const envelope = createEnvelope(owner, room.id, 0, "https://example.com/pointer");
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    const logicalTabId = envelope.operation.logicalTabId;
    await ownerSocket.timeout(3_000).emitWithAck("presence.update", {
      type: "presence.update",
      protocolVersion: 1,
      roomId: room.id,
      logicalTabId,
    });
    const before = await durablePointerCounts(room.id);
    const ownerEvent = nextPointerEvent(ownerSocket);
    const memberEvent = nextPointerEvent(memberSocket);
    const update: PointerUpdate = {
      type: "pointer.update",
      protocolVersion: 1,
      roomId: room.id as PointerUpdate["roomId"],
      logicalTabId: logicalTabId as PointerUpdate["logicalTabId"],
      documentRevision: {
        roomEpoch: 0,
        tabUpdatedAtSeq: 1,
      },
      anchor: {
        path: [
          { tagName: "html", nthOfType: 1 },
          { tagName: "body", nthOfType: 1 },
          { tagName: "button", nthOfType: 2 },
        ],
        x: 0.25,
        y: 0.75,
      },
      viewport: { x: 0.4, y: 0.6 },
    };

    const acknowledgement = PointerAckSchema.parse(
      await ownerSocket.timeout(3_000).emitWithAck("pointer.update", update),
    );
    expect(acknowledgement).toMatchObject({
      roomId: room.id,
      accepted: true,
      expiresAt: expect.any(Number),
    });
    const events = await Promise.all([ownerEvent, memberEvent]);
    expect(events).toEqual([
      expect.objectContaining({
        roomId: room.id,
        pointer: expect.objectContaining({
          userId: owner.userId,
          username: owner.username,
          deviceId: owner.deviceId,
          color: expect.stringMatching(/^#[0-9a-f]{6}$/u),
          logicalTabId,
          documentRevision: update.documentRevision,
          anchor: update.anchor,
          viewport: update.viewport,
          expiresAt: acknowledgement.expiresAt,
        }),
      }),
      expect.objectContaining({
        pointer: expect.objectContaining({
          userId: owner.userId,
          deviceId: owner.deviceId,
        }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/https?:|selector|className|password|token/iu);

    expect(
      PointerAckSchema.parse(
        await ownerSocket.timeout(3_000).emitWithAck("pointer.update", {
          ...update,
          viewport: { x: 0.9, y: 0.9 },
        }),
      ),
    ).toMatchObject({
      accepted: false,
      expiresAt: null,
    });
    await expect(
      ownerSocket.timeout(3_000).emitWithAck("pointer.update", {
        ...update,
        userId: member.userId,
      } as PointerUpdate),
    ).resolves.toMatchObject({
      type: "sync.error",
      code: "INVALID_SYNC_MESSAGE",
    });

    const resyncSnapshot = nextPointerSnapshot(memberSocket);
    await memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 1));
    await expect(resyncSnapshot).resolves.toMatchObject({
      roomId: room.id,
      pointers: [
        expect.objectContaining({
          userId: owner.userId,
          logicalTabId,
        }),
      ],
    });
    await expect(durablePointerCounts(room.id)).resolves.toEqual(before);

    const clear = nextPointerClear(memberSocket);
    ownerSocket.disconnect();
    await expect(clear).resolves.toMatchObject({
      roomId: room.id,
      userId: owner.userId,
      deviceId: owner.deviceId,
    });
  });

  it("isolates signed annotation broadcasts by authenticated realtime protocol", async () => {
    const owner = await createActiveSession("annotation-v2-owner");
    const member = await createActiveSession("annotation-v1-member");
    const room = await createSharedRoom(owner, member);
    const v2Socket = createSocket(owner.accessToken, baseUrl, 2);
    const legacySocket = createSocket(member.accessToken, baseUrl, 1);
    await Promise.all([connect(v2Socket), connect(legacySocket)]);
    await Promise.all([
      v2Socket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      legacySocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);

    const url = "https://example.com/annotation-v2";
    const envelope = createEnvelope(owner, room.id, 0, url);
    await v2Socket.timeout(3_000).emitWithAck("operation.submit", envelope);
    const logicalTabId = envelope.operation.logicalTabId;
    await Promise.all([
      v2Socket
        .timeout(3_000)
        .emitWithAck("presence.update.v2", createPresenceV2Update(room.id, logicalTabId, url)),
      legacySocket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: room.id,
        logicalTabId,
      }),
    ]);

    const identity = {
      roomId: room.id,
      logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      frameKey: "top" as const,
    };
    const syncRequestInput = AnnotationSyncRequestSchema.parse({
      protocolVersion: 1,
      ...identity,
      lastAnnotationSeq: 0,
      hasConfirmedSnapshot: false,
    });
    const [snapshotInput, snapshotEvent] = await Promise.all([
      v2Socket.timeout(3_000).emitWithAck("annotation.sync", syncRequestInput),
      nextAnnotationV2Snapshot(v2Socket),
    ]);
    const snapshot = AnnotationSnapshotV2MessageSchema.parse(snapshotInput);
    expect(snapshotEvent).toEqual(snapshot);

    const signedOperation = AnnotationOperationV2Schema.parse({
      type: "stroke.create",
      stroke: {
        strokeId: randomUUID(),
        frameKey: "top",
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
        // Deliberately differs from the presence digest: the server validates and
        // persists signatures but leaves compatibility decisions to clients.
        contentSignature: { signatureVersion: 1, digest: "B".repeat(43) },
      },
    });
    const signedSubmission = AnnotationSubmitV2Schema.parse({
      type: "annotation.submit.v2",
      protocolVersion: 1,
      clientOpId: randomUUID(),
      ...identity,
      pageKey: snapshot.pageKey,
      baseAnnotationSeq: 0,
      operation: signedOperation,
    });
    const legacyLeaks: AnnotationCommittedOperation[] = [];
    legacySocket.on("annotation.committed", (operation) => legacyLeaks.push(operation));
    const ackEvent = new Promise<AnnotationAckV2>((resolve) => {
      v2Socket.once("annotation.ack.v2", (acknowledgement) =>
        resolve(AnnotationAckV2Schema.parse(acknowledgement)),
      );
    });
    const [ackInput, committed, emittedAck] = await Promise.all([
      v2Socket.timeout(3_000).emitWithAck("annotation.submit.v2", signedSubmission),
      nextAnnotationV2Committed(v2Socket),
      ackEvent,
    ]);
    const acknowledgement = AnnotationAckV2Schema.parse(ackInput);
    expect(emittedAck).toEqual(acknowledgement);
    expect(committed).toMatchObject({
      operation: signedOperation,
      annotationSeq: 1,
    });
    await settleSocketDelivery();
    expect(legacyLeaks).toEqual([]);

    const legacySnapshot = AnnotationSnapshotMessageSchema.parse(
      await legacySocket.timeout(3_000).emitWithAck("annotation.sync", syncRequestInput),
    );
    expect(legacySnapshot).toMatchObject({
      annotationSeq: 1,
      strokes: [],
    });

    const legacyStrokeId = randomUUID();
    const legacySubmission = AnnotationSubmitSchema.parse({
      protocolVersion: 1,
      clientOpId: randomUUID(),
      ...identity,
      pageKey: snapshot.pageKey,
      baseAnnotationSeq: 1,
      operation: {
        type: "stroke.create",
        stroke: {
          strokeId: legacyStrokeId,
          frameKey: "top",
          anchor: {
            type: "document",
            layoutSignature: { widthCssPx: 1_440, heightCssPx: 5_000 },
          },
          points: [{ x: 0.3, y: 0.4, pressure: 0.6 }],
          rgb: { r: 0, g: 122, b: 255 },
          width: 4,
        },
      },
    });
    const [legacyAckInput, legacyCommitted, projectedV2Committed] = await Promise.all([
      legacySocket.timeout(3_000).emitWithAck("annotation.submit", legacySubmission),
      nextAnnotationCommitted(legacySocket),
      nextAnnotationV2Committed(v2Socket),
    ]);
    expect(AnnotationAckSchema.parse(legacyAckInput)).toMatchObject({
      accepted: true,
      annotationSeq: 2,
    });
    expect(legacyCommitted.operation).toEqual(legacySubmission.operation);
    expect(projectedV2Committed).toMatchObject({
      annotationSeq: 2,
      operation: {
        type: "stroke.create",
        stroke: {
          strokeId: legacyStrokeId,
          contentSignature: null,
        },
      },
    });
  });

  it("authorizes exact-page messages, previews, and durable annotations without changing room sequencing", async () => {
    const owner = await createActiveSession("page-owner");
    const member = await createActiveSession("page-member");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken);
    const memberSocket = createSocket(member.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket)]);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);

    const sharedUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=40";
    const envelope = createEnvelope(owner, room.id, 0, sharedUrl);
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    const logicalTabId = envelope.operation.logicalTabId;
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: room.id,
        logicalTabId,
      }),
      memberSocket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: room.id,
        logicalTabId,
      }),
    ]);

    const documentIdentity = {
      roomId: room.id,
      logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      frameKey: "top" as const,
    };
    const initialSync: AnnotationSyncRequest = AnnotationSyncRequestSchema.parse({
      protocolVersion: 1,
      ...documentIdentity,
      lastAnnotationSeq: 0,
      hasConfirmedSnapshot: false,
    });
    const [initialResponse, initialEmission] = await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("annotation.sync", initialSync),
      nextAnnotationSnapshot(ownerSocket),
    ]);
    const initialSnapshot = AnnotationSnapshotMessageSchema.parse(initialResponse);
    expect(initialEmission).toEqual(initialSnapshot);
    expect(initialSnapshot).toMatchObject({
      ...documentIdentity,
      annotationSeq: 0,
      strokes: [],
    });
    expect(initialSnapshot.pageKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const firstDanmaku: DanmakuSend = DanmakuSendSchema.parse({
      type: "danmaku.send",
      protocolVersion: 1,
      messageId: randomUUID(),
      ...documentIdentity,
      text: "<b>literal message</b>",
    });
    const [firstDanmakuAckInput, firstDanmakuEvent] = await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("danmaku.send", firstDanmaku),
      nextDanmakuEvent(memberSocket),
    ]);
    const firstDanmakuAck = DanmakuAckSchema.parse(firstDanmakuAckInput);
    expect(firstDanmakuAck).toMatchObject({
      accepted: true,
      messageId: firstDanmaku.messageId,
    });
    expect(firstDanmakuEvent).toMatchObject({
      ...documentIdentity,
      messageId: firstDanmaku.messageId,
      text: firstDanmaku.text,
      sender: {
        userId: owner.userId,
        username: owner.username,
        deviceId: owner.deviceId,
      },
    });
    expect(firstDanmakuEvent.expiresAtServerMs - firstDanmakuEvent.sentAtServerMs).toBe(9_000);

    expect(
      DanmakuAckSchema.parse(
        await ownerSocket.timeout(3_000).emitWithAck("danmaku.send", {
          ...firstDanmaku,
          messageId: randomUUID(),
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 2 },
        }),
      ),
    ).toMatchObject({
      accepted: false,
      code: "DOCUMENT_UNAUTHORIZED",
    });
    for (let index = 0; index < 4; index += 1) {
      expect(
        DanmakuAckSchema.parse(
          await ownerSocket.timeout(3_000).emitWithAck("danmaku.send", {
            ...firstDanmaku,
            messageId: randomUUID(),
            text: `message ${index}`,
          }),
        ),
      ).toMatchObject({ accepted: true });
    }
    expect(
      DanmakuAckSchema.parse(
        await ownerSocket.timeout(3_000).emitWithAck("danmaku.send", {
          ...firstDanmaku,
          messageId: randomUUID(),
          text: "rate overflow",
        }),
      ),
    ).toMatchObject({
      accepted: false,
      code: "DANMAKU_RATE_LIMITED",
    });

    const preview: StrokePreviewUpdate = StrokePreviewUpdateSchema.parse({
      type: "stroke.preview.update",
      protocolVersion: 1,
      previewId: randomUUID(),
      ...documentIdentity,
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
    });
    const previewEventPromise = nextPreviewEvent(memberSocket);
    ownerSocket.emit("stroke.preview.update", preview);
    const previewEvent = await previewEventPromise;
    expect(previewEvent).toMatchObject({
      previewId: preview.previewId,
      ...documentIdentity,
      sender: { userId: owner.userId, deviceId: owner.deviceId },
      points: preview.points,
    });

    const previewClear: StrokePreviewClear = StrokePreviewClearSchema.parse({
      type: "stroke.preview.clear",
      protocolVersion: 1,
      previewId: preview.previewId,
      ...documentIdentity,
    });
    const previewClearPromise = nextPreviewClear(memberSocket);
    ownerSocket.emit("stroke.preview.clear", previewClear);
    await expect(previewClearPromise).resolves.toMatchObject({
      previewId: preview.previewId,
      ...documentIdentity,
      sender: { userId: owner.userId, deviceId: owner.deviceId },
    });

    const strokeId = randomUUID();
    const submission: AnnotationSubmit = AnnotationSubmitSchema.parse({
      protocolVersion: 1,
      clientOpId: randomUUID(),
      ...documentIdentity,
      pageKey: initialSnapshot.pageKey,
      baseAnnotationSeq: 0,
      operation: {
        type: "stroke.create",
        stroke: {
          strokeId,
          frameKey: "top",
          anchor: preview.anchor,
          points: preview.points,
          rgb: preview.rgb,
          width: preview.width,
        },
      },
    });
    const [annotationAckInput, committed] = await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("annotation.submit", submission),
      nextAnnotationCommitted(memberSocket),
    ]);
    const annotationAck = AnnotationAckSchema.parse(annotationAckInput);
    expect(annotationAck).toMatchObject({
      accepted: true,
      pageKey: initialSnapshot.pageKey,
      annotationSeq: 1,
    });
    expect(committed).toMatchObject({
      clientOpId: submission.clientOpId,
      roomId: room.id,
      pageKey: initialSnapshot.pageKey,
      annotationSeq: 1,
      actorUserId: owner.userId,
      operation: submission.operation,
    });

    const [deltaResponse, deltaEmission] = await Promise.all([
      memberSocket.timeout(3_000).emitWithAck("annotation.sync", {
        ...initialSync,
        lastAnnotationSeq: 0,
        hasConfirmedSnapshot: true,
      }),
      nextAnnotationDelta(memberSocket),
    ]);
    const delta = AnnotationDeltaMessageSchema.parse(deltaResponse);
    expect(deltaEmission).toEqual(delta);
    expect(delta).toMatchObject({
      pageKey: initialSnapshot.pageKey,
      fromAnnotationSeq: 0,
      toAnnotationSeq: 1,
      operations: [expect.objectContaining({ clientOpId: submission.clientOpId })],
    });

    await ownerSocket.timeout(3_000).emitWithAck("presence.update", {
      type: "presence.update",
      protocolVersion: 1,
      roomId: room.id,
      logicalTabId: null,
    });
    expect(
      DanmakuAckSchema.parse(
        await ownerSocket.timeout(3_000).emitWithAck("danmaku.send", {
          ...firstDanmaku,
          messageId: randomUUID(),
          text: "must not leak",
        }),
      ),
    ).toMatchObject({
      accepted: false,
      code: "DOCUMENT_UNAUTHORIZED",
    });
    expect(
      AnnotationAckSchema.parse(
        await ownerSocket
          .timeout(3_000)
          .emitWithAck(
            "annotation.submit",
            AnnotationSubmitSchema.parse({ ...submission, clientOpId: randomUUID() }),
          ),
      ),
    ).toMatchObject({
      accepted: false,
      code: "DOCUMENT_UNAUTHORIZED",
    });
    const stalePreviews: StrokePreviewEventMessage[] = [];
    memberSocket.on("stroke.preview.event", (event) => stalePreviews.push(event));
    ownerSocket.emit("stroke.preview.update", {
      ...preview,
      previewId: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stalePreviews).toEqual([]);

    const restartedApp = await buildPublicApp({
      db,
      accounts,
      rooms,
      sequencer: new RoomSequencer({ db, now: () => now }),
      annotationHmacKey,
      now: () => now,
      logger: false,
    });
    await restartedApp.listen({ host: "127.0.0.1", port: 0 });
    const address = restartedApp.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an ephemeral TCP address");
    }
    const restartedSocket = createSocket(owner.accessToken, `http://127.0.0.1:${address.port}`);
    try {
      await connect(restartedSocket);
      await restartedSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
      await restartedSocket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: room.id,
        logicalTabId,
      });
      const recovered = AnnotationSnapshotMessageSchema.parse(
        await restartedSocket.timeout(3_000).emitWithAck("annotation.sync", initialSync),
      );
      expect(recovered).toMatchObject({
        pageKey: initialSnapshot.pageKey,
        annotationSeq: 1,
        strokes: [
          expect.objectContaining({
            strokeId,
            authorUserId: owner.userId,
            version: 1,
            deletedAtServerMs: null,
          }),
        ],
      });
    } finally {
      restartedSocket.disconnect();
      await restartedApp.close();
    }

    const [roomState, roomOperations, roomTabs, annotationOperations, audits] = await Promise.all([
      db
        .selectFrom("rooms")
        .select("serverSeq")
        .where("id", "=", room.id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("roomOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", room.id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("roomTabs")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", room.id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("annotationOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", room.id)
        .executeTakeFirstOrThrow(),
      db.selectFrom("auditEvents").select(["eventType", "details"]).execute(),
    ]);
    expect({
      serverSeq: roomState.serverSeq,
      roomOperations: Number(roomOperations.count),
      roomTabs: Number(roomTabs.count),
      annotationOperations: Number(annotationOperations.count),
    }).toEqual({
      serverSeq: 1,
      roomOperations: 1,
      roomTabs: 1,
      annotationOperations: 1,
    });
    const auditProjection = JSON.stringify(audits);
    expect(auditProjection).not.toContain(firstDanmaku.text);
    expect(auditProjection).not.toContain(initialSnapshot.pageKey);
    expect(auditProjection).not.toContain(sharedUrl);
    expect(auditProjection).not.toMatch(/points|rgb|width/iu);
  });

  it("shares ephemeral playback groups without touching durable room sequencing", async () => {
    const owner = await createActiveSession("media-owner");
    const member = await createActiveSession("media-member");
    const observer = await createActiveSession("media-observer");
    const room = await createSharedRoom(owner, member);
    const observerInvitation = await rooms.inviteByUsername({
      actorUserId: owner.userId,
      roomId: room.id,
      username: observer.username,
    });
    await rooms.acceptInvitation({
      actorUserId: observer.userId,
      invitationId: observerInvitation.id,
    });
    const ownerSocket = createSocket(owner.accessToken);
    const memberSocket = createSocket(member.accessToken);
    const observerSocket = createSocket(observer.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket), connect(observerSocket)]);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      observerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);

    const firstTab = createEnvelope(
      owner,
      room.id,
      0,
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    const secondTab = createEnvelope(
      owner,
      room.id,
      1,
      "https://www.youtube.com/watch?v=9bZkp7q19f0",
    );
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", firstTab);
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", secondTab);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: room.id,
        logicalTabId: firstTab.operation.logicalTabId,
      }),
      memberSocket.timeout(3_000).emitWithAck("presence.update", {
        type: "presence.update",
        protocolVersion: 1,
        roomId: room.id,
        logicalTabId: firstTab.operation.logicalTabId,
      }),
    ]);
    const before = await durablePointerCounts(room.id);
    const firstTarget = MediaTargetSchema.parse({
      logicalTabId: firstTab.operation.logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 212_000,
    });
    const observed = {
      observedAtClientMs: now.getTime(),
      positionMs: 42_000,
      paused: false,
      playbackRate: 1,
      ended: false,
      buffering: false,
    };
    const createCommand: MediaCommand = {
      type: "group.create",
      protocolVersion: 1,
      commandId: randomUUID(),
      roomId: room.id as MediaCommand["roomId"],
      target: firstTarget,
      observed,
    };
    const ownerCreated = nextMediaSnapshot(
      ownerSocket,
      (snapshot) => snapshot.groups[0]?.playbackGroupId === createCommand.commandId,
    );
    const memberCreated = nextMediaSnapshot(
      memberSocket,
      (snapshot) => snapshot.groups[0]?.playbackGroupId === createCommand.commandId,
    );
    const createAck = MediaCommandAckSchema.parse(
      await ownerSocket.timeout(3_000).emitWithAck("media.command", createCommand),
    );
    expect(createAck).toMatchObject({
      accepted: true,
      playbackGroupId: createCommand.commandId,
      groupRevision: 1,
    });
    await expect(Promise.all([ownerCreated, memberCreated])).resolves.toEqual([
      expect.objectContaining({
        groups: [
          expect.objectContaining({
            playbackGroupId: createCommand.commandId,
            leaderUserId: owner.userId,
            status: "PLAYING",
          }),
        ],
      }),
      expect.objectContaining({
        groups: [expect.objectContaining({ playbackGroupId: createCommand.commandId })],
      }),
    ]);

    expect(
      MediaCommandAckSchema.parse(
        await ownerSocket.timeout(3_000).emitWithAck("media.command", createCommand),
      ),
    ).toEqual(createAck);

    const memberJoined = nextMediaSnapshot(
      memberSocket,
      (snapshot) => snapshot.groups[0]?.members.length === 2,
    );
    const joinAck = MediaCommandAckSchema.parse(
      await memberSocket.timeout(3_000).emitWithAck("media.command", {
        type: "group.join",
        protocolVersion: 1,
        commandId: randomUUID(),
        roomId: room.id as MediaCommand["roomId"],
        playbackGroupId: createCommand.commandId,
        expectedGroupRevision: 1,
      }),
    );
    expect(joinAck).toMatchObject({ accepted: true, groupRevision: 2 });
    await expect(memberJoined).resolves.toMatchObject({
      groups: [
        expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({ userId: owner.userId }),
            expect.objectContaining({ userId: member.userId }),
          ]),
        }),
      ],
    });

    const proposalCommandId = randomUUID();
    const proposed = nextMediaSnapshot(
      ownerSocket,
      (snapshot) =>
        snapshot.groups[0]?.proposals.some(
          (proposal) => proposal.proposalId === proposalCommandId,
        ) === true,
    );
    const proposalAck = MediaCommandAckSchema.parse(
      await memberSocket.timeout(3_000).emitWithAck("media.command", {
        type: "proposal.create",
        protocolVersion: 1,
        commandId: proposalCommandId,
        roomId: room.id as MediaCommand["roomId"],
        playbackGroupId: createCommand.commandId,
        expectedGroupRevision: 2,
        action: { type: "PAUSE" },
      }),
    );
    expect(proposalAck).toMatchObject({ accepted: true, groupRevision: 2 });
    await expect(proposed).resolves.toMatchObject({
      groups: [
        expect.objectContaining({
          proposals: [expect.objectContaining({ proposalId: proposalCommandId })],
        }),
      ],
    });

    const approved = nextMediaSnapshot(
      memberSocket,
      (snapshot) =>
        snapshot.groups[0]?.status === "PAUSED" && snapshot.groups[0].proposals.length === 0,
    );
    const approvalAck = MediaCommandAckSchema.parse(
      await ownerSocket.timeout(3_000).emitWithAck("media.command", {
        type: "proposal.decide",
        protocolVersion: 1,
        commandId: randomUUID(),
        roomId: room.id as MediaCommand["roomId"],
        playbackGroupId: createCommand.commandId,
        expectedGroupRevision: 2,
        proposalId: proposalCommandId,
        decision: "APPROVE",
      }),
    );
    expect(approvalAck).toMatchObject({ accepted: true, groupRevision: 3 });
    await expect(approved).resolves.toMatchObject({
      groups: [
        expect.objectContaining({
          status: "PAUSED",
          proposals: [],
          observed: expect.objectContaining({ paused: true }),
        }),
      ],
    });

    const heartbeat: MediaHeartbeat = {
      type: "media.heartbeat",
      protocolVersion: 1,
      roomId: room.id as MediaHeartbeat["roomId"],
      playbackGroupId: createCommand.commandId,
      groupRevision: 3,
      target: firstTarget,
      ...observed,
      positionMs: 80_000,
    };
    const heartbeatSnapshot = nextMediaSnapshot(
      memberSocket,
      (snapshot) => snapshot.groups[0]?.observed?.positionMs === 80_000,
    );
    expect(
      MediaHeartbeatAckSchema.parse(
        await ownerSocket.timeout(3_000).emitWithAck("media.heartbeat", heartbeat),
      ),
    ).toMatchObject({ accepted: true, groupRevision: 3 });
    await expect(heartbeatSnapshot).resolves.toMatchObject({
      groups: [
        expect.objectContaining({
          observed: expect.objectContaining({
            positionMs: 80_000,
          }),
        }),
      ],
    });

    const endedSnapshot = nextMediaSnapshot(
      memberSocket,
      (snapshot) => snapshot.groups[0]?.status === "ENDED_WAITING",
    );
    await ownerSocket.timeout(3_000).emitWithAck("media.heartbeat", {
      ...heartbeat,
      positionMs: firstTarget.durationMs,
      paused: true,
      ended: true,
    });
    await expect(endedSnapshot).resolves.toMatchObject({
      groups: [
        expect.objectContaining({
          status: "ENDED_WAITING",
          members: expect.arrayContaining([
            expect.objectContaining({ userId: owner.userId }),
            expect.objectContaining({ userId: member.userId }),
          ]),
        }),
      ],
    });

    await ownerSocket.timeout(3_000).emitWithAck("presence.update", {
      type: "presence.update",
      protocolVersion: 1,
      roomId: room.id,
      logicalTabId: secondTab.operation.logicalTabId,
    });
    const secondTarget = MediaTargetSchema.parse({
      logicalTabId: secondTab.operation.logicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 2 },
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:9bZkp7q19f0",
      durationMs: 253_000,
    });
    const switched = nextMediaSnapshot(
      memberSocket,
      (snapshot) => snapshot.groups[0]?.target?.mediaKey === secondTarget.mediaKey,
    );
    expect(
      MediaCommandAckSchema.parse(
        await ownerSocket.timeout(3_000).emitWithAck("media.command", {
          type: "group.switch-target",
          protocolVersion: 1,
          commandId: randomUUID(),
          roomId: room.id as MediaCommand["roomId"],
          playbackGroupId: createCommand.commandId,
          expectedGroupRevision: 3,
          target: secondTarget,
          observed: { ...observed, positionMs: 0, paused: true },
        }),
      ),
    ).toMatchObject({ accepted: true, groupRevision: 4 });
    await expect(switched).resolves.toMatchObject({
      groups: [
        expect.objectContaining({
          playbackGroupId: createCommand.commandId,
          target: expect.objectContaining({ mediaKey: secondTarget.mediaKey }),
          members: expect.arrayContaining([
            expect.objectContaining({ userId: owner.userId }),
            expect.objectContaining({ userId: member.userId }),
          ]),
        }),
      ],
    });

    const observerResync = nextMediaSnapshot(observerSocket);
    await observerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 2));
    await expect(observerResync).resolves.toMatchObject({
      groups: [expect.objectContaining({ playbackGroupId: createCommand.commandId })],
    });
    await expect(durablePointerCounts(room.id)).resolves.toEqual(before);

    const grace = nextMediaSnapshot(
      memberSocket,
      (snapshot) => snapshot.groups[0]?.status === "LEADER_GRACE",
    );
    ownerSocket.disconnect();
    await expect(grace).resolves.toMatchObject({
      groups: [
        expect.objectContaining({
          status: "LEADER_GRACE",
          leaderUserId: owner.userId,
        }),
      ],
    });

    const reconnectedOwner = createSocket(owner.accessToken);
    await connect(reconnectedOwner);
    const graceOnSync = nextMediaSnapshot(
      reconnectedOwner,
      (snapshot) => snapshot.groups[0]?.status === "LEADER_GRACE",
    );
    await reconnectedOwner.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 2));
    await expect(graceOnSync).resolves.toMatchObject({
      groups: [expect.objectContaining({ status: "LEADER_GRACE" })],
    });
    const resumed = nextMediaSnapshot(
      memberSocket,
      (snapshot) =>
        snapshot.groups[0]?.status === "PAUSED" &&
        snapshot.groups[0].leaderGraceExpiresAtServerMs === null,
    );
    await reconnectedOwner.timeout(3_000).emitWithAck("presence.update", {
      type: "presence.update",
      protocolVersion: 1,
      roomId: room.id,
      logicalTabId: secondTab.operation.logicalTabId,
    });
    await expect(resumed).resolves.toMatchObject({
      groups: [expect.objectContaining({ status: "PAUSED" })],
    });

    const cleared = nextMediaSnapshot(observerSocket, (snapshot) => snapshot.groups.length === 0);
    reconnectedOwner.disconnect();
    memberSocket.disconnect();
    await expect(cleared).resolves.toMatchObject({ roomId: room.id, groups: [] });
    await expect(durablePointerCounts(room.id)).resolves.toEqual(before);
  });

  it("closes and broadcasts playback groups when the room is deleted", async () => {
    const owner = await createActiveSession("media-delete-owner");
    const room = await createSharedRoom(owner);
    const ownerSocket = createSocket(owner.accessToken);
    await connect(ownerSocket);
    await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    const tab = createEnvelope(owner, room.id, 0, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", tab);
    await ownerSocket.timeout(3_000).emitWithAck("presence.update", {
      type: "presence.update",
      protocolVersion: 1,
      roomId: room.id,
      logicalTabId: tab.operation.logicalTabId,
    });
    const command: MediaCommand = {
      type: "group.create",
      protocolVersion: 1,
      commandId: randomUUID(),
      roomId: room.id as MediaCommand["roomId"],
      target: MediaTargetSchema.parse({
        logicalTabId: tab.operation.logicalTabId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
        frameKey: "top",
        provider: "YOUTUBE",
        mediaKey: "youtube:dQw4w9WgXcQ",
        durationMs: 212_000,
      }),
      observed: {
        observedAtClientMs: now.getTime(),
        positionMs: 42_000,
        paused: false,
        playbackRate: 1,
        ended: false,
        buffering: false,
      },
    };
    const created = nextMediaSnapshot(
      ownerSocket,
      (snapshot) => snapshot.groups[0]?.playbackGroupId === command.commandId,
    );
    await expect(
      ownerSocket.timeout(3_000).emitWithAck("media.command", command),
    ).resolves.toMatchObject({ type: "media.command.ack", accepted: true });
    await expect(created).resolves.toMatchObject({
      groups: [expect.objectContaining({ playbackGroupId: command.commandId })],
    });

    const cleared = nextMediaSnapshot(ownerSocket, (snapshot) => snapshot.groups.length === 0);
    const deletion = await app.inject({
      method: "DELETE",
      url: `/v1/rooms/${room.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(deletion.statusCode).toBe(204);
    await expect(cleared).resolves.toMatchObject({
      roomId: room.id,
      groups: [],
    });
  });

  it("ACKs once, broadcasts only new commits, and rejects spoofed or future operations", async () => {
    const owner = await createActiveSession("commit-owner");
    const member = await createActiveSession("commit-member");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken);
    const memberSocket = createSocket(member.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket)]);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);
    const broadcasts: CommittedOperation[] = [];
    memberSocket.on("op.committed", (operation) => broadcasts.push(operation));
    const envelope = createEnvelope(owner, room.id, 0, "https://example.com/first");

    const firstAck = await ownerSocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    await expect.poll(() => broadcasts.length, { timeout: 3_000 }).toBe(1);
    const duplicateAck = await ownerSocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(firstAck).toMatchObject({ type: "op.ack", serverSeq: 1 });
    expect(duplicateAck).toEqual(firstAck);
    expect(broadcasts).toHaveLength(1);

    const spoofed = {
      ...createEnvelope(owner, room.id, 1, "https://example.com/spoofed"),
      deviceId: member.deviceId as ClientOperationEnvelope["deviceId"],
    };
    expect(await ownerSocket.timeout(3_000).emitWithAck("operation.submit", spoofed)).toMatchObject(
      { type: "sync.error", code: "DEVICE_MISMATCH" },
    );
    expect(
      await ownerSocket
        .timeout(3_000)
        .emitWithAck(
          "operation.submit",
          createEnvelope(owner, room.id, 99, "https://example.com/future"),
        ),
    ).toMatchObject({ type: "sync.error", code: "BASE_SEQUENCE_AHEAD" });
  });

  it("recovers a committed operation after simulated ACK loss and reconnect", async () => {
    const owner = await createActiveSession("reconnect-owner");
    const member = await createActiveSession("reconnect-member");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken);
    const memberSocket = createSocket(member.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket)]);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);
    const first = createEnvelope(owner, room.id, 0, "https://example.com/confirmed");
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", first);
    const committedWithoutAck = new Promise<CommittedOperation>((resolve) =>
      ownerSocket.once("op.committed", resolve),
    );
    memberSocket.emit(
      "operation.submit",
      createEnvelope(member, room.id, 1, "https://example.com/ack-lost"),
      () => undefined,
    );
    await committedWithoutAck;
    memberSocket.disconnect();

    const reconnected = createSocket(member.accessToken);
    await connect(reconnected);
    const recovery = await reconnected
      .timeout(3_000)
      .emitWithAck("room.sync", syncRequest(room.id, 0, 1));

    expect(RoomDeltaMessageSchema.parse(recovery)).toMatchObject({
      fromServerSeq: 1,
      toServerSeq: 2,
      operations: [{ serverSeq: 2 }],
    });
  });

  it("limits operation submissions per authenticated device over a rolling window", async () => {
    const owner = await createActiveSession("limited-owner");
    const room = await createSharedRoom(owner);
    const limitedSequencer = new RoomSequencer({ db, now: () => now });
    const limitedApp = await buildPublicApp({
      db,
      accounts,
      rooms,
      sequencer: limitedSequencer,
      annotationHmacKey,
      now: () => now,
      operationRateLimitMax: 2,
      logger: false,
    });
    await limitedApp.listen({ host: "127.0.0.1", port: 0 });
    const address = limitedApp.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an ephemeral TCP address");
    }
    const socket = createSocket(owner.accessToken, `http://127.0.0.1:${address.port}`);
    try {
      await connect(socket);
      await socket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
      expect(
        await socket
          .timeout(3_000)
          .emitWithAck(
            "operation.submit",
            createEnvelope(owner, room.id, 0, "https://example.com/rate/1"),
          ),
      ).toMatchObject({ type: "op.ack", serverSeq: 1 });
      expect(
        await socket
          .timeout(3_000)
          .emitWithAck(
            "operation.submit",
            createEnvelope(owner, room.id, 1, "https://example.com/rate/2"),
          ),
      ).toMatchObject({ type: "op.ack", serverSeq: 2 });
      expect(
        await socket
          .timeout(3_000)
          .emitWithAck(
            "operation.submit",
            createEnvelope(owner, room.id, 2, "https://example.com/rate/3"),
          ),
      ).toMatchObject({ type: "sync.error", code: "OPERATION_RATE_LIMITED" });
    } finally {
      socket.disconnect();
      await limitedApp.close();
    }
  });

  it("deduplicates a commit when its ACK is lost and the client retries after reconnect", async () => {
    const owner = await createActiveSession("ack-retry-owner");
    const room = await createSharedRoom(owner);
    const firstSocket = createSocket(owner.accessToken);
    await connect(firstSocket);
    await firstSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    const envelope = createEnvelope(owner, room.id, 0, "https://example.com/commit-before-ack");
    const firstBroadcast = new Promise<CommittedOperation>((resolve) =>
      firstSocket.once("op.committed", resolve),
    );

    firstSocket.emit("operation.submit", envelope, () => undefined);
    expect(await firstBroadcast).toMatchObject({ serverSeq: 1, clientOpId: envelope.clientOpId });
    firstSocket.disconnect();

    const retrySocket = createSocket(owner.accessToken);
    await connect(retrySocket);
    await retrySocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    const retryBroadcasts: CommittedOperation[] = [];
    retrySocket.on("op.committed", (operation) => retryBroadcasts.push(operation));
    const retryAck = await retrySocket.timeout(3_000).emitWithAck("operation.submit", envelope);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(retryAck).toMatchObject({ type: "op.ack", serverSeq: 1 });
    expect(retryBroadcasts).toEqual([]);
    expect(
      await db
        .selectFrom("roomOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 1 });
  });

  it("does not invent a commit when the connection drops before submission reaches the server", async () => {
    const owner = await createActiveSession("precommit-drop-owner");
    const room = await createSharedRoom(owner);
    const droppedSocket = createSocket(owner.accessToken);
    await connect(droppedSocket);
    await droppedSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    const envelope = createEnvelope(owner, room.id, 0, "https://example.com/disconnected");

    droppedSocket.disconnect();
    droppedSocket.emit("operation.submit", envelope, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await db
        .selectFrom("roomOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });

    const retrySocket = createSocket(owner.accessToken);
    await connect(retrySocket);
    await retrySocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    expect(
      await retrySocket.timeout(3_000).emitWithAck("operation.submit", envelope),
    ).toMatchObject({ type: "op.ack", serverSeq: 1 });
  });

  it("serializes conflicting moves from two clients and exposes the sequence-five winner", async () => {
    const owner = await createActiveSession("move-owner");
    const member = await createActiveSession("move-member");
    const room = await createSharedRoom(owner, member);
    const ownerSocket = createSocket(owner.accessToken);
    const memberSocket = createSocket(member.accessToken);
    await Promise.all([connect(ownerSocket), connect(memberSocket)]);
    await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      memberSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
    ]);
    const first = createEnvelope(owner, room.id, 0, "https://example.com/move/first");
    const target = createEnvelope(owner, room.id, 1, "https://example.com/move/target");
    const last = createEnvelope(owner, room.id, 2, "https://example.com/move/last");
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", first);
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", target);
    await ownerSocket.timeout(3_000).emitWithAck("operation.submit", last);
    const moveToFront: ClientOperationEnvelope = {
      protocolVersion: 1,
      clientOpId: randomUUID() as ClientOperationEnvelope["clientOpId"],
      roomId: room.id as ClientOperationEnvelope["roomId"],
      roomEpoch: 0,
      deviceId: owner.deviceId as ClientOperationEnvelope["deviceId"],
      baseServerSeq: 3,
      operation: {
        type: "tab.move",
        logicalTabId: target.operation.logicalTabId,
        predecessor: null,
        successor: first.operation.logicalTabId,
      },
    };
    const moveToEnd: ClientOperationEnvelope = {
      ...moveToFront,
      clientOpId: randomUUID() as ClientOperationEnvelope["clientOpId"],
      deviceId: member.deviceId as ClientOperationEnvelope["deviceId"],
      operation: {
        type: "tab.move",
        logicalTabId: target.operation.logicalTabId,
        predecessor: last.operation.logicalTabId,
        successor: null,
      },
    };

    const [frontAck, endAck] = await Promise.all([
      ownerSocket.timeout(3_000).emitWithAck("operation.submit", moveToFront),
      memberSocket.timeout(3_000).emitWithAck("operation.submit", moveToEnd),
    ]);
    const snapshot = RoomSnapshotMessageSchema.parse(
      await ownerSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 99, 0)),
    );
    const lastMoveWasToFront =
      frontAck.type === "op.ack" && frontAck.serverSeq === 5 && endAck.type === "op.ack";

    expect([frontAck, endAck]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "op.ack", serverSeq: 4 }),
        expect.objectContaining({ type: "op.ack", serverSeq: 5 }),
      ]),
    );
    expect(snapshot.state.serverSeq).toBe(5);
    expect(snapshot.state.order).toEqual(
      lastMoveWasToFront
        ? [target.operation.logicalTabId, first.operation.logicalTabId, last.operation.logicalTabId]
        : [
            first.operation.logicalTabId,
            last.operation.logicalTabId,
            target.operation.logicalTabId,
          ],
    );
  });

  it("restores the durable room through a fresh server and sequencer instance", async () => {
    const owner = await createActiveSession("restart-owner");
    const room = await createSharedRoom(owner);
    const firstSocket = createSocket(owner.accessToken);
    await connect(firstSocket);
    await firstSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    await firstSocket
      .timeout(3_000)
      .emitWithAck(
        "operation.submit",
        createEnvelope(owner, room.id, 0, "https://example.com/survives-restart"),
      );
    firstSocket.disconnect();

    const restartedApp = await buildPublicApp({
      db,
      accounts,
      rooms,
      sequencer: new RoomSequencer({ db, now: () => now }),
      annotationHmacKey,
      now: () => now,
      logger: false,
    });
    await restartedApp.listen({ host: "127.0.0.1", port: 0 });
    const address = restartedApp.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an ephemeral TCP address");
    }
    const restartedSocket = createSocket(owner.accessToken, `http://127.0.0.1:${address.port}`);
    try {
      await connect(restartedSocket);
      const snapshot = RoomSnapshotMessageSchema.parse(
        await restartedSocket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0)),
      );
      expect(snapshot.state).toMatchObject({
        serverSeq: 1,
        tabs: [expect.objectContaining({ url: "https://example.com/survives-restart" })],
      });
    } finally {
      restartedSocket.disconnect();
      await restartedApp.close();
    }
  });

  it("rejects malformed messages and a deleted room without writing or broadcasting", async () => {
    const owner = await createActiveSession("fault-owner");
    const room = await createSharedRoom(owner);
    const socket = createSocket(owner.accessToken);
    await connect(socket);
    await socket.timeout(3_000).emitWithAck("room.sync", syncRequest(room.id, 0, 0));
    const malformedSync = {
      ...syncRequest(room.id, 0, 0),
      unexpected: true,
    } as Parameters<ClientToServerEvents["room.sync"]>[0];
    expect(await socket.timeout(3_000).emitWithAck("room.sync", malformedSync)).toMatchObject({
      type: "sync.error",
      code: "INVALID_SYNC_MESSAGE",
    });
    expect(
      await socket.timeout(3_000).emitWithAck("operation.submit", {} as ClientOperationEnvelope),
    ).toMatchObject({
      type: "sync.error",
      code: "INVALID_SYNC_MESSAGE",
    });

    const broadcasts: CommittedOperation[] = [];
    socket.on("op.committed", (operation) => broadcasts.push(operation));
    await rooms.softDeleteRoom({ actorUserId: owner.userId, roomId: room.id });
    expect(
      await socket
        .timeout(3_000)
        .emitWithAck(
          "operation.submit",
          createEnvelope(owner, room.id, 0, "https://example.com/deleted"),
        ),
    ).toMatchObject({ type: "sync.error", code: "ROOM_NOT_FOUND" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(broadcasts).toEqual([]);
    expect(
      await db
        .selectFrom("roomOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("roomId", "=", room.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });
  });
});

async function durablePointerCounts(roomId: string): Promise<{
  serverSeq: number;
  operations: number;
  snapshots: number;
}> {
  const [room, operations, snapshots] = await Promise.all([
    db.selectFrom("rooms").select("serverSeq").where("id", "=", roomId).executeTakeFirstOrThrow(),
    db
      .selectFrom("roomOperations")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("roomSnapshots")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("roomId", "=", roomId)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    serverSeq: room.serverSeq,
    operations: Number(operations.count),
    snapshots: Number(snapshots.count),
  };
}
