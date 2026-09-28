import type { AuthenticatedPrincipal, AccountService } from "@syncaction/identity";
import {
  AnnotationAckSchema,
  AnnotationAckV2Schema,
  AnnotationSubmitSchema,
  AnnotationSubmitV2Schema,
  AnnotationSyncRequestSchema,
  DanmakuAckSchema,
  DanmakuSendSchema,
  ClientOperationEnvelopeSchema,
  ClientOpIdSchema,
  MediaCommandAckSchema,
  MediaCommandSchema,
  MediaHeartbeatAckSchema,
  MediaHeartbeatSchema,
  type AnnotationAck,
  type AnnotationAckV2,
  type AnnotationCommittedOperation,
  type AnnotationCommittedOperationV2,
  type AnnotationDeltaMessage,
  type AnnotationDeltaV2Message,
  type AnnotationSnapshotMessage,
  type AnnotationSnapshotV2Message,
  type DanmakuAck,
  type DanmakuEventMessage,
  type MediaCommandAck,
  type MediaGroupsSnapshotMessage,
  type MediaHeartbeatAck,
  type Notification,
  type NotificationReadEvent,
  type PointerAck,
  type PointerClearMessage,
  type PointerEventMessage,
  type PointerFrameEvent,
  type PointerLeaseAck,
  type PointerLeaseClear,
  type PointerLeaseEvent,
  type PointerLeaseSnapshot,
  type PointerSnapshotMessage,
  type PresenceAck,
  type PresenceDeltaMessage,
  type PresenceSnapshotMessage,
  type PresenceSnapshotV2Message,
  PublicRoomsInvalidatedSchema,
  type PublicRoomsInvalidated,
  RoomIdSchema,
  type RoomEventMessage,
  StrokePreviewClearSchema,
  StrokePreviewUpdateSchema,
  SyncErrorMessageSchema,
  type CommittedOperation,
  type OperationAck,
  type RoomDeltaMessage,
  type RoomSnapshotMessage,
  type StrokePreviewClearMessage,
  type StrokePreviewEventMessage,
  type SyncErrorMessage,
} from "@syncaction/protocol";
import type { RoomProductEventBus } from "@syncaction/rooms";
import {
  AnnotationServiceError,
  DanmakuServiceError,
  MediaServiceError,
  RoomPointerFrameService,
  SyncError,
  type AnnotationService,
  type DanmakuService,
  type RoomMediaGroupService,
  type RoomPointerService,
  type PresenceMutationResult,
  type PresenceRoomMutationResult,
  type RoomPresenceService,
  type RoomSequencer,
  type StrokePreviewService,
} from "@syncaction/sync";
import type { FastifyInstance } from "fastify";
import { isIP } from "node:net";
import { Server, type Socket } from "socket.io";

type EventResponse =
  | OperationAck
  | RoomSnapshotMessage
  | RoomDeltaMessage
  | PresenceAck
  | PointerAck
  | PointerLeaseAck
  | MediaCommandAck
  | MediaHeartbeatAck
  | AnnotationAck
  | AnnotationAckV2
  | AnnotationSnapshotMessage
  | AnnotationSnapshotV2Message
  | AnnotationDeltaMessage
  | AnnotationDeltaV2Message
  | DanmakuAck
  | SyncErrorMessage;

interface ClientToServerEvents {
  "annotation.sync": (request: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "annotation.submit": (
    submission: unknown,
    acknowledge?: (message: EventResponse) => void,
  ) => void;
  "annotation.submit.v2": (
    submission: unknown,
    acknowledge?: (message: EventResponse) => void,
  ) => void;
  "danmaku.send": (message: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "room.sync": (request: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "operation.submit": (envelope: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "presence.update": (update: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "presence.update.v2": (update: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "pointer.lease": (update: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "pointer.frame": (frame: unknown) => void;
  "pointer.update": (update: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "stroke.preview.update": (update: unknown) => void;
  "stroke.preview.clear": (clear: unknown) => void;
  "media.command": (command: unknown, acknowledge?: (message: EventResponse) => void) => void;
  "media.heartbeat": (heartbeat: unknown, acknowledge?: (message: EventResponse) => void) => void;
}

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

type InterServerEvents = Record<string, never>;

interface SyncSocketData {
  principal: AuthenticatedPrincipal;
  realtimeProtocolVersion: 1 | 2;
  roomId?: string;
  roomGeneration?: number;
  roomTransitioning?: boolean;
}

type SyncSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SyncSocketData
>;

export interface AttachSyncSocketOptions {
  accounts: AccountService;
  sequencer: RoomSequencer;
  presence: RoomPresenceService;
  pointers: RoomPointerService;
  media: RoomMediaGroupService;
  annotations: AnnotationService;
  danmaku: DanmakuService;
  previews: StrokePreviewService;
  productEvents: RoomProductEventBus;
  isPublicRoom: (roomId: string) => Promise<boolean>;
  operationRateLimitMax?: number;
  operationRateLimitWindowMs?: number;
  presenceSweepIntervalMs?: number;
  pointerSweepIntervalMs?: number;
}

export interface AttachedSyncSocket {
  closeMediaRoom(roomId: unknown): void;
}

interface ErrorContext {
  roomId?: unknown;
  clientOpId?: unknown;
}

const roomChannel = (roomId: string): string => `room:${roomId}`;
const legacyPresenceChannel = (roomId: string): string => `room:${roomId}:presence-v1`;
const v2PresenceChannel = (roomId: string): string => `room:${roomId}:presence-v2`;
const legacyAnnotationChannel = (roomId: string): string => `room:${roomId}:annotation-v1`;
const v2AnnotationChannel = (roomId: string): string => `room:${roomId}:annotation-v2`;
const userChannel = (userId: string): string => `user:${userId}`;

const PUBLIC_CONNECTION_BUCKET_CAPACITY = 30;
const PUBLIC_CONNECTION_REFILL_PER_MS = PUBLIC_CONNECTION_BUCKET_CAPACITY / 60_000;
const PUBLIC_SOCKET_LIMIT = 100;

export const SYNC_SOCKET_CONNECTION_OPTIONS = {
  transports: ["websocket", "polling"] as Array<"websocket" | "polling">,
  connectionStateRecovery: {
    maxDisconnectionDuration: 120_000,
    skipMiddlewares: false,
  },
};

interface PublicConnectionBucket {
  tokens: number;
  updatedAtMs: number;
}

function isLoopbackPeer(address: string): boolean {
  if (address === "::1") {
    return true;
  }
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

export function publicConnectionAddress(
  handshake: Pick<Socket["handshake"], "address" | "headers">,
): string {
  const peerAddress = handshake.address;
  const forwardedFor = handshake.headers["x-forwarded-for"];
  if (!isLoopbackPeer(peerAddress) || typeof forwardedFor !== "string") {
    return peerAddress;
  }
  // A local reverse proxy must replace or sanitize incoming X-Forwarded-For.
  // The rightmost address is the nearest client-facing hop, not a client-controlled prefix.
  const nearestHop = forwardedFor.split(",").at(-1)?.trim();
  return nearestHop !== undefined && isIP(nearestHop) !== 0 ? nearestHop : peerAddress;
}

function toErrorMessage(cause: unknown, context: ErrorContext = {}): SyncErrorMessage {
  const code = cause instanceof SyncError ? cause.code : "RECOVERY_REQUIRED";
  const roomId = RoomIdSchema.safeParse(context.roomId);
  const clientOpId = ClientOpIdSchema.safeParse(context.clientOpId);
  return SyncErrorMessageSchema.parse({
    type: "sync.error",
    protocolVersion: 1,
    code,
    ...(roomId.success ? { roomId: roomId.data } : {}),
    ...(clientOpId.success ? { clientOpId: clientOpId.data } : {}),
  });
}

function authenticationError(): Error & { data: SyncErrorMessage } {
  const error = new Error("SYNC_AUTH_REQUIRED") as Error & { data: SyncErrorMessage };
  error.data = SyncErrorMessageSchema.parse({
    type: "sync.error",
    protocolVersion: 1,
    code: "SYNC_AUTH_REQUIRED",
  });
  return error;
}

function acknowledge(
  callback: ((message: EventResponse) => void) | undefined,
  message: EventResponse,
): void {
  callback?.(message);
}

function mediaCommandFailure(input: unknown, cause: unknown): MediaCommandAck | SyncErrorMessage {
  const parsed = MediaCommandSchema.safeParse(input);
  if (!parsed.success) {
    return SyncErrorMessageSchema.parse({
      type: "sync.error",
      protocolVersion: 1,
      code: "INVALID_SYNC_MESSAGE",
    });
  }
  return MediaCommandAckSchema.parse({
    type: "media.command.ack",
    protocolVersion: 1,
    commandId: parsed.data.commandId,
    roomId: parsed.data.roomId,
    accepted: false,
    code: cause instanceof MediaServiceError ? cause.code : "INVALID_MEDIA_MESSAGE",
    playbackGroupId: null,
    groupRevision: null,
    roomMediaRevision: 0,
  });
}

function mediaHeartbeatFailure(
  input: unknown,
  cause: unknown,
): MediaHeartbeatAck | SyncErrorMessage {
  const parsed = MediaHeartbeatSchema.safeParse(input);
  if (!parsed.success) {
    return SyncErrorMessageSchema.parse({
      type: "sync.error",
      protocolVersion: 1,
      code: "INVALID_SYNC_MESSAGE",
    });
  }
  return MediaHeartbeatAckSchema.parse({
    type: "media.heartbeat.ack",
    protocolVersion: 1,
    roomId: parsed.data.roomId,
    playbackGroupId: parsed.data.playbackGroupId,
    accepted: false,
    code: cause instanceof MediaServiceError ? cause.code : "INVALID_MEDIA_MESSAGE",
    groupRevision: null,
    roomMediaRevision: 0,
  });
}

function annotationSubmitFailure(input: unknown, cause: unknown): AnnotationAck | SyncErrorMessage {
  const parsed = AnnotationSubmitSchema.safeParse(input);
  if (!parsed.success) {
    return SyncErrorMessageSchema.parse({
      type: "sync.error",
      protocolVersion: 1,
      code: "INVALID_SYNC_MESSAGE",
    });
  }
  return AnnotationAckSchema.parse({
    type: "annotation.ack",
    protocolVersion: 1,
    clientOpId: parsed.data.clientOpId,
    roomId: parsed.data.roomId,
    accepted: false,
    code: cause instanceof AnnotationServiceError ? cause.code : "ANNOTATION_OPERATION_REJECTED",
    pageKey: null,
    annotationSeq: null,
    results: [],
  });
}

function annotationSubmitV2Failure(
  input: unknown,
  cause: unknown,
): AnnotationAckV2 | SyncErrorMessage {
  const parsed = AnnotationSubmitV2Schema.safeParse(input);
  if (!parsed.success) {
    return SyncErrorMessageSchema.parse({
      type: "sync.error",
      protocolVersion: 1,
      code: "INVALID_SYNC_MESSAGE",
    });
  }
  return AnnotationAckV2Schema.parse({
    type: "annotation.ack.v2",
    protocolVersion: 1,
    clientOpId: parsed.data.clientOpId,
    roomId: parsed.data.roomId,
    accepted: false,
    code: cause instanceof AnnotationServiceError ? cause.code : "ANNOTATION_OPERATION_REJECTED",
    pageKey: null,
    annotationSeq: null,
    results: [],
  });
}

function danmakuFailure(input: unknown, cause: unknown): DanmakuAck | SyncErrorMessage {
  const parsed = DanmakuSendSchema.safeParse(input);
  if (!parsed.success) {
    return SyncErrorMessageSchema.parse({
      type: "sync.error",
      protocolVersion: 1,
      code: "INVALID_SYNC_MESSAGE",
    });
  }
  return DanmakuAckSchema.parse({
    type: "danmaku.ack",
    protocolVersion: 1,
    messageId: parsed.data.messageId,
    roomId: parsed.data.roomId,
    accepted: false,
    code: cause instanceof DanmakuServiceError ? cause.code : "INVALID_DANMAKU_MESSAGE",
    sentAtServerMs: null,
    expiresAtServerMs: null,
  });
}

function isRoomTransitioning(socket: SyncSocket): boolean {
  return socket.data.roomTransitioning === true;
}

export function attachSyncSocket(
  app: FastifyInstance,
  options: AttachSyncSocketOptions,
): AttachedSyncSocket {
  const operationRateLimitMax = options.operationRateLimitMax ?? 30;
  const operationRateLimitWindowMs = options.operationRateLimitWindowMs ?? 10_000;
  const presenceSweepIntervalMs = options.presenceSweepIntervalMs ?? 5_000;
  const pointerSweepIntervalMs = options.pointerSweepIntervalMs ?? 1_000;
  if (
    !Number.isSafeInteger(operationRateLimitMax) ||
    operationRateLimitMax < 1 ||
    !Number.isSafeInteger(operationRateLimitWindowMs) ||
    operationRateLimitWindowMs < 1 ||
    !Number.isSafeInteger(presenceSweepIntervalMs) ||
    presenceSweepIntervalMs < 1_000 ||
    presenceSweepIntervalMs > 30_000 ||
    !Number.isSafeInteger(pointerSweepIntervalMs) ||
    pointerSweepIntervalMs < 500 ||
    pointerSweepIntervalMs > 3_000
  ) {
    throw new SyncError("INVALID_SYNC_MESSAGE");
  }

  const submissionsByDevice = new Map<string, number[]>();
  const publicConnectionBuckets = new Map<string, PublicConnectionBucket>();
  const pointerFrames = new RoomPointerFrameService({ leases: options.pointers });
  let publicSocketReservations = 0;
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SyncSocketData
  >(app.server, {
    serveClient: false,
    ...SYNC_SOCKET_CONNECTION_OPTIONS,
  });
  const publicNamespace = io.of("/public");
  const consumePublicConnection = (address: string): boolean => {
    const nowMs = Date.now();
    const previous = publicConnectionBuckets.get(address);
    const bucket =
      previous === undefined
        ? {
            tokens: PUBLIC_CONNECTION_BUCKET_CAPACITY,
            updatedAtMs: nowMs,
          }
        : {
            tokens: Math.min(
              PUBLIC_CONNECTION_BUCKET_CAPACITY,
              previous.tokens +
                Math.max(0, nowMs - previous.updatedAtMs) * PUBLIC_CONNECTION_REFILL_PER_MS,
            ),
            updatedAtMs: nowMs,
          };
    if (bucket.tokens < 1) {
      publicConnectionBuckets.set(address, bucket);
      return false;
    }
    publicConnectionBuckets.set(address, {
      tokens: bucket.tokens - 1,
      updatedAtMs: nowMs,
    });
    return true;
  };
  publicNamespace.use((socket, next) => {
    if (publicSocketReservations >= PUBLIC_SOCKET_LIMIT) {
      next(new Error("PUBLIC_SOCKET_CAPACITY"));
      return;
    }
    if (!consumePublicConnection(publicConnectionAddress(socket.handshake))) {
      next(new Error("PUBLIC_SOCKET_RATE_LIMITED"));
      return;
    }
    publicSocketReservations += 1;
    next();
  });
  publicNamespace.on("connection", (socket) => {
    let reservationReleased = false;
    const releaseReservation = (): void => {
      if (reservationReleased) {
        return;
      }
      reservationReleased = true;
      publicSocketReservations = Math.max(0, publicSocketReservations - 1);
    };
    socket.once("disconnect", releaseReservation);
    socket.onAny(() => {
      socket.disconnect(true);
    });
  });

  const unsubscribeProductEvents = options.productEvents.subscribe((message) => {
    switch (message.type) {
      case "ROOM_EVENT":
        io.to(roomChannel(message.event.roomId)).emit("room.event", message.event);
        break;
      case "NOTIFICATION_CREATED":
        io.to(userChannel(message.recipientUserId)).emit(
          "notification.created",
          message.notification,
        );
        break;
      case "NOTIFICATION_READ":
        io.to(userChannel(message.recipientUserId)).emit("notification.read", message.read);
        break;
      case "PUBLIC_ROOMS_INVALIDATED":
        publicNamespace.emit("public-rooms.invalidated", message.message);
        break;
    }
  });

  interface LegacyPresenceBridgeState {
    lastEmittedAtMs: number;
    timer: ReturnType<typeof setTimeout> | null;
    dirty: boolean;
  }
  const legacyPresenceBridgeByRoom = new Map<string, LegacyPresenceBridgeState>();
  const pendingPublicPresenceRooms = new Set<string>();
  const pendingPublicPlaybackRooms = new Map<string, boolean>();
  const knownMediaRooms = new Set<string>();
  const pendingPointerFrames = new Map<
    string,
    {
      socket: SyncSocket;
      event: PointerFrameEvent;
    }
  >();
  let publicPresenceFlushScheduled = false;
  let publicPresenceFlushTail = Promise.resolve();
  let publicPlaybackFlushScheduled = false;
  let publicPlaybackFlushTail = Promise.resolve();
  let pointerFrameFlush: ReturnType<typeof setImmediate> | undefined;
  const publishPublicPresenceInvalidation = async (roomId: string): Promise<void> => {
    try {
      if (await options.isPublicRoom(roomId)) {
        options.productEvents.publish({
          type: "PUBLIC_ROOMS_INVALIDATED",
          message: PublicRoomsInvalidatedSchema.parse({
            type: "public-rooms.invalidated",
            roomId,
            reason: "PRESENCE",
            roomRevision: null,
          }),
        });
      }
    } catch (cause) {
      app.log.error({ cause, roomId }, "Failed to publish public room presence invalidation");
    }
  };
  const schedulePublicPresenceInvalidation = (roomId: string): void => {
    pendingPublicPresenceRooms.add(roomId);
    if (publicPresenceFlushScheduled) {
      return;
    }
    publicPresenceFlushScheduled = true;
    queueMicrotask(() => {
      publicPresenceFlushScheduled = false;
      const roomIds = [...pendingPublicPresenceRooms].sort();
      pendingPublicPresenceRooms.clear();
      publicPresenceFlushTail = publicPresenceFlushTail.then(async () => {
        await Promise.all(roomIds.map(publishPublicPresenceInvalidation));
      });
    });
  };
  const publishPublicPlaybackInvalidation = async (roomId: string): Promise<void> => {
    try {
      if (await options.isPublicRoom(roomId)) {
        options.productEvents.publish({
          type: "PUBLIC_ROOMS_INVALIDATED",
          message: PublicRoomsInvalidatedSchema.parse({
            type: "public-rooms.invalidated",
            roomId,
            reason: "PLAYBACK",
            roomRevision: null,
          }),
        });
      }
    } catch (cause) {
      app.log.error({ cause, roomId }, "Failed to publish public room playback invalidation");
    }
  };
  const schedulePublicPlaybackInvalidation = (
    roomId: string,
    activeBeforeMutation: boolean,
  ): void => {
    const activeAfterMutation = options.media.hasActivePlayback(roomId);
    if (activeAfterMutation === activeBeforeMutation) {
      return;
    }
    if (!pendingPublicPlaybackRooms.has(roomId)) {
      pendingPublicPlaybackRooms.set(roomId, activeBeforeMutation);
    }
    if (publicPlaybackFlushScheduled) {
      return;
    }
    publicPlaybackFlushScheduled = true;
    queueMicrotask(() => {
      publicPlaybackFlushScheduled = false;
      const changedRoomIds = [...pendingPublicPlaybackRooms]
        .filter(
          ([pendingRoomId, activeBefore]) =>
            options.media.hasActivePlayback(pendingRoomId) !== activeBefore,
        )
        .map(([pendingRoomId]) => pendingRoomId)
        .sort();
      pendingPublicPlaybackRooms.clear();
      publicPlaybackFlushTail = publicPlaybackFlushTail.then(async () => {
        await Promise.all(changedRoomIds.map(publishPublicPlaybackInvalidation));
      });
    });
  };
  const runMediaMutation = <T>(roomId: string, mutation: () => T): T => {
    knownMediaRooms.add(roomId);
    const activeBeforeMutation = options.media.hasActivePlayback(roomId);
    try {
      return mutation();
    } finally {
      schedulePublicPlaybackInvalidation(roomId, activeBeforeMutation);
    }
  };
  const runAsyncMediaMutation = async <T>(
    roomId: string,
    mutation: () => Promise<T>,
  ): Promise<T> => {
    knownMediaRooms.add(roomId);
    const activeBeforeMutation = options.media.hasActivePlayback(roomId);
    try {
      return await mutation();
    } finally {
      schedulePublicPlaybackInvalidation(roomId, activeBeforeMutation);
    }
  };
  const emitLegacyPresenceSnapshot = (roomId: string, emittedAtMs = Date.now()): void => {
    io.to(legacyPresenceChannel(roomId)).emit(
      "presence.snapshot",
      options.presence.snapshot(roomId),
    );
    const state = legacyPresenceBridgeByRoom.get(roomId);
    if (state !== undefined) {
      state.lastEmittedAtMs = emittedAtMs;
      state.dirty = false;
    }
  };
  const scheduleLegacyPresenceSnapshot = (roomId: string): void => {
    const nowMs = Date.now();
    const state = legacyPresenceBridgeByRoom.get(roomId) ?? {
      lastEmittedAtMs: 0,
      timer: null,
      dirty: false,
    };
    legacyPresenceBridgeByRoom.set(roomId, state);
    const remainingMs = Math.max(0, 1_000 - (nowMs - state.lastEmittedAtMs));
    if (remainingMs === 0 && state.timer === null) {
      emitLegacyPresenceSnapshot(roomId, nowMs);
      return;
    }
    state.dirty = true;
    if (state.timer !== null) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.dirty) {
        emitLegacyPresenceSnapshot(roomId);
      }
    }, remainingMs);
    state.timer.unref();
  };
  const broadcastPresenceDelta = (delta: PresenceDeltaMessage): void => {
    io.to(v2PresenceChannel(delta.roomId)).emit("presence.delta.v2", delta);
    scheduleLegacyPresenceSnapshot(delta.roomId);
  };
  const handlePresenceMutation = (
    result: PresenceMutationResult | PresenceRoomMutationResult,
  ): void => {
    if (result.delta !== null) {
      broadcastPresenceDelta(result.delta);
    }
    if (result.onlineUserSetChanged && result.delta !== null) {
      schedulePublicPresenceInvalidation(result.delta.roomId);
    }
  };
  const broadcastPointerClear = (clear: PointerClearMessage): void => {
    io.to(roomChannel(clear.roomId)).emit("pointer.clear", clear);
  };
  const broadcastPointerLeaseClear = (clear: PointerLeaseClear): void => {
    pointerFrames.forget(clear.leaseId);
    for (const [key, pending] of pendingPointerFrames) {
      if (pending.event.leaseId === clear.leaseId) {
        pendingPointerFrames.delete(key);
      }
    }
    io.to(roomChannel(clear.roomId)).emit("pointer.lease.clear", clear);
  };
  const broadcastPointerLeaseEvent = (event: PointerLeaseEvent): void => {
    io.to(roomChannel(event.roomId)).emit("pointer.lease.event", event);
  };
  const schedulePointerFrame = (socket: SyncSocket, event: PointerFrameEvent): void => {
    pendingPointerFrames.set(`${socket.id}:${event.leaseId}`, { socket, event });
    if (pointerFrameFlush !== undefined) {
      return;
    }
    pointerFrameFlush = setImmediate(() => {
      pointerFrameFlush = undefined;
      const pending = [...pendingPointerFrames.values()];
      pendingPointerFrames.clear();
      for (const frame of pending) {
        if (frame.socket.connected && frame.socket.data.roomId === frame.event.roomId) {
          frame.socket.volatile
            .to(roomChannel(frame.event.roomId))
            .emit("pointer.frame", frame.event);
        }
      }
    });
    pointerFrameFlush.unref();
  };
  const broadcastPreviewClear = (clear: StrokePreviewClearMessage): void => {
    io.to(roomChannel(clear.roomId)).emit("stroke.preview.clear", clear);
  };
  const broadcastMedia = (snapshot: MediaGroupsSnapshotMessage): void => {
    io.to(roomChannel(snapshot.roomId)).emit("media.groups.snapshot", snapshot);
  };
  const broadcastVolatileMedia = (snapshot: MediaGroupsSnapshotMessage): void => {
    io.to(roomChannel(snapshot.roomId)).volatile.emit("media.groups.snapshot", snapshot);
  };
  const clearMediaIfRoomOffline = (roomId: string): void => {
    const snapshot = runMediaMutation(roomId, () => options.media.removeRoomIfOffline(roomId));
    if (snapshot !== null) {
      broadcastMedia(snapshot);
      knownMediaRooms.delete(roomId);
    }
  };
  const closeMediaRoom = (roomId: unknown): void => {
    const parsedRoomId = RoomIdSchema.parse(roomId);
    const snapshot = runMediaMutation(parsedRoomId, () => options.media.closeRoom(parsedRoomId));
    if (snapshot !== null) {
      broadcastMedia(snapshot);
    }
    knownMediaRooms.delete(parsedRoomId);
  };
  let inactiveRoomSweep: Promise<void> | undefined;
  const beginInactiveRoomSweep = (): void => {
    if (inactiveRoomSweep !== undefined) {
      return;
    }
    const activeBeforeSweep = new Map(
      [...knownMediaRooms].map((roomId) => [roomId, options.media.hasActivePlayback(roomId)]),
    );
    const sweep = options.media
      .removeInactiveRooms()
      .then((snapshots) => {
        for (const snapshot of snapshots) {
          broadcastMedia(snapshot);
          knownMediaRooms.delete(snapshot.roomId);
        }
      })
      .catch((cause: unknown) => {
        app.log.error({ cause }, "Failed to check active media rooms");
      })
      .finally(() => {
        for (const [roomId, activeBeforeMutation] of activeBeforeSweep) {
          schedulePublicPlaybackInvalidation(roomId, activeBeforeMutation);
        }
        if (inactiveRoomSweep === sweep) {
          inactiveRoomSweep = undefined;
        }
      });
    inactiveRoomSweep = sweep;
  };
  const sweepTimer = setInterval(() => {
    for (const result of options.presence.sweep()) {
      handlePresenceMutation(result);
      if (!options.presence.hasRoomEntries(result.delta.roomId)) {
        clearMediaIfRoomOffline(result.delta.roomId);
      }
    }
    const activeBeforeMediaSweep = new Map(
      [...knownMediaRooms].map((roomId) => [roomId, options.media.hasActivePlayback(roomId)]),
    );
    for (const snapshot of options.media.sweep()) {
      broadcastMedia(snapshot);
    }
    for (const [roomId, activeBeforeMutation] of activeBeforeMediaSweep) {
      schedulePublicPlaybackInvalidation(roomId, activeBeforeMutation);
    }
    beginInactiveRoomSweep();
  }, presenceSweepIntervalMs);
  sweepTimer.unref();
  const pointerSweepTimer = setInterval(() => {
    for (const clear of options.pointers.sweepLeases()) {
      broadcastPointerLeaseClear(clear);
    }
    for (const clear of options.pointers.sweep()) {
      broadcastPointerClear(clear);
    }
    for (const clear of options.previews.sweep()) {
      broadcastPreviewClear(clear);
    }
  }, pointerSweepIntervalMs);
  pointerSweepTimer.unref();

  io.use(async (socket, next) => {
    try {
      const accessToken = socket.handshake.auth.accessToken;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw authenticationError();
      }
      socket.data.principal = await options.accounts.authenticateAccessToken(accessToken);
      socket.data.realtimeProtocolVersion =
        socket.handshake.auth.realtimeProtocolVersion === 2 ? 2 : 1;
      await socket.join(userChannel(socket.data.principal.userId));
      next();
    } catch {
      next(authenticationError());
    }
  });

  const logFailure = (socket: SyncSocket, message: SyncErrorMessage): void => {
    app.log.warn(
      {
        code: message.code,
        socketId: socket.id,
        userId: socket.data.principal.userId,
        deviceId: socket.data.principal.deviceId,
        ...(message.roomId === undefined ? {} : { roomId: message.roomId }),
        ...(message.clientOpId === undefined ? {} : { clientOpId: message.clientOpId }),
      },
      "Synchronization request rejected",
    );
  };
  const logMediaFailure = (
    socket: SyncSocket,
    code: string,
    roomId?: string,
    commandId?: string,
  ): void => {
    app.log.warn(
      {
        code,
        socketId: socket.id,
        userId: socket.data.principal.userId,
        deviceId: socket.data.principal.deviceId,
        ...(roomId === undefined ? {} : { roomId }),
        ...(commandId === undefined ? {} : { commandId }),
      },
      "Media collaboration request rejected",
    );
  };
  const logPageCollaborationFailure = (
    socket: SyncSocket,
    family: "annotation" | "danmaku" | "preview",
    code: string,
    roomId?: string,
    operationId?: string,
  ): void => {
    app.log.warn(
      {
        family,
        code,
        socketId: socket.id,
        userId: socket.data.principal.userId,
        deviceId: socket.data.principal.deviceId,
        ...(roomId === undefined ? {} : { roomId }),
        ...(operationId === undefined ? {} : { operationId }),
      },
      "Page collaboration request rejected",
    );
  };

  const consumeSubmission = (principal: AuthenticatedPrincipal): void => {
    const key = `${principal.userId}:${principal.deviceId}`;
    const now = Date.now();
    const cutoff = now - operationRateLimitWindowMs;
    const recent = (submissionsByDevice.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= operationRateLimitMax) {
      submissionsByDevice.set(key, recent);
      throw new SyncError("OPERATION_RATE_LIMITED");
    }
    recent.push(now);
    submissionsByDevice.set(key, recent);
  };

  io.on("connection", (socket) => {
    options.media.registerSocket(socket.id);
    socket.data.roomGeneration = 0;
    socket.data.roomTransitioning = false;
    let roomSyncTail = Promise.resolve();
    const waitForRoomSync = async (): Promise<void> => {
      while (true) {
        const pending = roomSyncTail;
        await pending;
        if (pending === roomSyncTail) {
          return;
        }
      }
    };
    socket.on("room.sync", (request, ack) => {
      roomSyncTail = roomSyncTail.then(async () => {
        const context: ErrorContext =
          typeof request === "object" && request !== null && "roomId" in request
            ? { roomId: request.roomId }
            : {};
        socket.data.roomTransitioning = true;
        try {
          const result = await options.sequencer.synchronize({
            principal: socket.data.principal,
            request,
          });
          const roomId = result.type === "room.snapshot" ? result.state.roomId : result.roomId;
          const previousRoomId = socket.data.roomId;
          if (previousRoomId !== undefined && previousRoomId !== roomId) {
            const mediaSnapshots = runMediaMutation(previousRoomId, () =>
              options.media.leaveSocket(socket.id),
            );
            for (const snapshot of mediaSnapshots) {
              broadcastMedia(snapshot);
            }
            for (const mutation of options.presence.removeSocket(socket.id)) {
              handlePresenceMutation(mutation);
            }
            for (const clear of options.pointers.removeSocketLeases(socket.id)) {
              broadcastPointerLeaseClear(clear);
            }
            for (const clear of options.pointers.removeSocket(socket.id)) {
              broadcastPointerClear(clear);
            }
            for (const clear of options.previews.removeSocket(socket.id)) {
              broadcastPreviewClear(clear);
            }
            clearMediaIfRoomOffline(previousRoomId);
            await socket.leave(roomChannel(previousRoomId));
            await socket.leave(
              socket.data.realtimeProtocolVersion === 2
                ? v2PresenceChannel(previousRoomId)
                : legacyPresenceChannel(previousRoomId),
            );
            await socket.leave(
              socket.data.realtimeProtocolVersion === 2
                ? v2AnnotationChannel(previousRoomId)
                : legacyAnnotationChannel(previousRoomId),
            );
          }
          await socket.join(roomChannel(roomId));
          knownMediaRooms.add(roomId);
          await socket.join(
            socket.data.realtimeProtocolVersion === 2
              ? v2PresenceChannel(roomId)
              : legacyPresenceChannel(roomId),
          );
          await socket.join(
            socket.data.realtimeProtocolVersion === 2
              ? v2AnnotationChannel(roomId)
              : legacyAnnotationChannel(roomId),
          );
          socket.data.roomId = roomId;
          if (previousRoomId !== roomId) {
            socket.data.roomGeneration = (socket.data.roomGeneration ?? 0) + 1;
          }
          acknowledge(ack, result);
          if (socket.data.realtimeProtocolVersion === 2) {
            socket.emit("presence.snapshot.v2", options.presence.snapshotV2(roomId));
          } else {
            socket.emit("presence.snapshot", options.presence.snapshot(roomId));
          }
          if (socket.data.realtimeProtocolVersion === 2) {
            socket.emit("pointer.lease.snapshot", options.pointers.leaseSnapshot(roomId));
          } else {
            socket.emit("pointer.snapshot", options.pointers.snapshot(roomId));
          }
          socket.emit("media.groups.snapshot", options.media.snapshot(roomId));
        } catch (cause) {
          const message = toErrorMessage(cause, context);
          logFailure(socket, message);
          acknowledge(ack, message);
        } finally {
          socket.data.roomTransitioning = false;
        }
      });
      void roomSyncTail;
    });

    socket.on("operation.submit", async (envelopeInput, ack) => {
      const context: ErrorContext =
        typeof envelopeInput === "object" && envelopeInput !== null
          ? {
              ...("roomId" in envelopeInput ? { roomId: envelopeInput.roomId } : {}),
              ...("clientOpId" in envelopeInput ? { clientOpId: envelopeInput.clientOpId } : {}),
            }
          : {};
      try {
        const envelope = ClientOperationEnvelopeSchema.parse(envelopeInput);
        if (isRoomTransitioning(socket) || socket.data.roomId !== envelope.roomId) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        consumeSubmission(socket.data.principal);
        const result = await options.sequencer.commitOperation({
          principal: socket.data.principal,
          envelope,
        });
        acknowledge(ack, result.ack);
        if (!result.deduplicated) {
          io.to(roomChannel(envelope.roomId)).emit("op.committed", result.committed);
          try {
            if (await options.isPublicRoom(envelope.roomId)) {
              options.productEvents.publish({
                type: "PUBLIC_ROOMS_INVALIDATED",
                message: PublicRoomsInvalidatedSchema.parse({
                  type: "public-rooms.invalidated",
                  roomId: envelope.roomId,
                  reason: "TAB_STATE",
                  roomRevision: null,
                }),
              });
            }
          } catch (cause) {
            app.log.error(
              { cause, roomId: envelope.roomId },
              "Failed to publish public room tab invalidation",
            );
          }
        }
      } catch (cause) {
        const message = toErrorMessage(
          cause instanceof SyncError ? cause : new SyncError("INVALID_SYNC_MESSAGE", { cause }),
          context,
        );
        logFailure(socket, message);
        acknowledge(ack, message);
      }
    });

    const handlePresenceUpdate = async (
      updateInput: unknown,
      ack?: (message: EventResponse) => void,
    ): Promise<void> => {
      const context: ErrorContext =
        typeof updateInput === "object" && updateInput !== null && "roomId" in updateInput
          ? { roomId: updateInput.roomId }
          : {};
      try {
        await waitForRoomSync();
        const expectedRoomId = socket.data.roomId;
        const expectedRoomGeneration = socket.data.roomGeneration ?? 0;
        if (
          expectedRoomId === undefined ||
          typeof updateInput !== "object" ||
          updateInput === null ||
          !("roomId" in updateInput) ||
          updateInput.roomId !== expectedRoomId
        ) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        const result = await options.presence.update({
          principal: socket.data.principal,
          socketId: socket.id,
          update: updateInput,
        });
        await waitForRoomSync();
        if (
          socket.data.roomId !== expectedRoomId ||
          socket.data.roomGeneration !== expectedRoomGeneration
        ) {
          const mutation = options.presence.removeSocketFromRoom(socket.id, result.ack.roomId);
          if (mutation !== null) {
            handlePresenceMutation(mutation);
          }
          clearMediaIfRoomOffline(result.ack.roomId);
          throw new SyncError("ROOM_NOT_FOUND");
        }
        acknowledge(ack, result.ack);
        handlePresenceMutation(result);
        try {
          const beforeRevision = options.media.snapshot(result.ack.roomId).roomMediaRevision;
          const mediaSnapshot = await runAsyncMediaMutation(result.ack.roomId, () =>
            options.media.connect({
              principal: socket.data.principal,
              socketId: socket.id,
              roomId: result.ack.roomId,
            }),
          );
          if (mediaSnapshot.roomMediaRevision !== beforeRevision) {
            broadcastMedia(mediaSnapshot);
          }
        } catch (cause) {
          logMediaFailure(
            socket,
            cause instanceof MediaServiceError ? cause.code : "INVALID_MEDIA_MESSAGE",
            result.ack.roomId,
          );
        }
      } catch (cause) {
        const message = toErrorMessage(cause, context);
        logFailure(socket, message);
        acknowledge(ack, message);
      }
    };
    socket.on("presence.update", handlePresenceUpdate);
    socket.on("presence.update.v2", handlePresenceUpdate);

    socket.on("pointer.lease", (updateInput, ack) => {
      const context: ErrorContext =
        typeof updateInput === "object" && updateInput !== null && "roomId" in updateInput
          ? { roomId: updateInput.roomId }
          : {};
      try {
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          typeof updateInput !== "object" ||
          updateInput === null ||
          !("roomId" in updateInput) ||
          updateInput.roomId !== socket.data.roomId
        ) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        const result = options.pointers.lease({
          principal: socket.data.principal,
          socketId: socket.id,
          update: updateInput,
        });
        acknowledge(ack, result.ack);
        if (result.legacyClear !== null) {
          broadcastPointerClear(result.legacyClear);
        }
        if (result.replaced !== null) {
          broadcastPointerLeaseClear(result.replaced);
        }
        broadcastPointerLeaseEvent(result.event);
      } catch (cause) {
        const message = toErrorMessage(
          cause instanceof SyncError ? cause : new SyncError("INVALID_SYNC_MESSAGE", { cause }),
          context,
        );
        logFailure(socket, message);
        acknowledge(ack, message);
      }
    });

    socket.on("pointer.frame", (frameInput) => {
      const context: ErrorContext =
        typeof frameInput === "object" && frameInput !== null && "roomId" in frameInput
          ? { roomId: frameInput.roomId }
          : {};
      try {
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          typeof frameInput !== "object" ||
          frameInput === null ||
          !("roomId" in frameInput) ||
          frameInput.roomId !== socket.data.roomId
        ) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        const event = pointerFrames.accept({
          principal: socket.data.principal,
          socketId: socket.id,
          frame: frameInput,
        });
        if (event !== null) {
          schedulePointerFrame(socket, event);
        }
      } catch (cause) {
        const message = toErrorMessage(
          cause instanceof SyncError ? cause : new SyncError("INVALID_SYNC_MESSAGE", { cause }),
          context,
        );
        logFailure(socket, message);
      }
    });

    socket.on("pointer.update", (updateInput, ack) => {
      const context: ErrorContext =
        typeof updateInput === "object" && updateInput !== null && "roomId" in updateInput
          ? { roomId: updateInput.roomId }
          : {};
      try {
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          typeof updateInput !== "object" ||
          updateInput === null ||
          !("roomId" in updateInput) ||
          updateInput.roomId !== socket.data.roomId
        ) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        const result = options.pointers.update({
          principal: socket.data.principal,
          socketId: socket.id,
          update: updateInput,
        });
        acknowledge(ack, result.ack);
        if (result.event !== null) {
          if (result.legacyClear !== null && result.legacyClear !== undefined) {
            broadcastPointerClear(result.legacyClear);
          }
          if (result.replacedLease !== null && result.replacedLease !== undefined) {
            broadcastPointerLeaseClear(result.replacedLease);
          }
          if (result.leaseEvent !== undefined) {
            broadcastPointerLeaseEvent(result.leaseEvent);
          }
          if (result.frame !== undefined) {
            const frameEvent = pointerFrames.accept({
              principal: socket.data.principal,
              socketId: socket.id,
              frame: result.frame,
            });
            if (frameEvent !== null) {
              schedulePointerFrame(socket, frameEvent);
            }
          }
          io.to(roomChannel(result.event.roomId)).emit("pointer.event", result.event);
        }
      } catch (cause) {
        const message = toErrorMessage(
          cause instanceof SyncError ? cause : new SyncError("INVALID_SYNC_MESSAGE", { cause }),
          context,
        );
        logFailure(socket, message);
        acknowledge(ack, message);
      }
    });

    socket.on("annotation.sync", async (requestInput, ack) => {
      const parsed = AnnotationSyncRequestSchema.safeParse(requestInput);
      try {
        if (!parsed.success) {
          throw new SyncError("INVALID_SYNC_MESSAGE", { cause: parsed.error });
        }
        await waitForRoomSync();
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          socket.data.roomId !== parsed.data.roomId
        ) {
          throw new SyncError("ROOM_NOT_FOUND");
        }
        const response = await options.annotations.synchronize({
          mode: socket.data.realtimeProtocolVersion === 2 ? "V2" : "LEGACY",
          principal: socket.data.principal,
          socketId: socket.id,
          request: parsed.data,
        });
        acknowledge(ack, response);
        if (response.type === "annotation.snapshot.v2") {
          socket.emit("annotation.snapshot.v2", response);
        } else if (response.type === "annotation.delta.v2") {
          socket.emit("annotation.delta.v2", response);
        } else if (response.type === "annotation.snapshot") {
          socket.emit("annotation.snapshot", response);
        } else {
          socket.emit("annotation.delta", response);
        }
      } catch (cause) {
        const message = toErrorMessage(
          cause instanceof SyncError
            ? cause
            : new SyncError(
                cause instanceof AnnotationServiceError &&
                  cause.code === "INVALID_ANNOTATION_MESSAGE"
                  ? "INVALID_SYNC_MESSAGE"
                  : "RECOVERY_REQUIRED",
                { cause },
              ),
          { roomId: parsed.success ? parsed.data.roomId : undefined },
        );
        logFailure(socket, message);
        acknowledge(ack, message);
      }
    });

    socket.on("annotation.submit", async (submissionInput, ack) => {
      const parsed = AnnotationSubmitSchema.safeParse(submissionInput);
      try {
        if (socket.data.realtimeProtocolVersion !== 1) {
          throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE");
        }
        if (!parsed.success) {
          throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE", {
            cause: parsed.error,
          });
        }
        await waitForRoomSync();
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          socket.data.roomId !== parsed.data.roomId
        ) {
          throw new AnnotationServiceError("ROOM_MISMATCH");
        }
        consumeSubmission(socket.data.principal);
        const result = await options.annotations.submit({
          mode: "LEGACY",
          principal: socket.data.principal,
          socketId: socket.id,
          submission: parsed.data,
        });
        acknowledge(ack, result.ack);
        if (!result.deduplicated) {
          if (result.legacyCommitted !== null) {
            io.to(legacyAnnotationChannel(result.legacyCommitted.roomId)).emit(
              "annotation.committed",
              result.legacyCommitted,
            );
          }
          if (result.v2Committed !== null) {
            io.to(v2AnnotationChannel(result.v2Committed.roomId)).emit(
              "annotation.committed.v2",
              result.v2Committed,
            );
          }
        }
        if (!result.ack.accepted) {
          logPageCollaborationFailure(
            socket,
            "annotation",
            result.ack.code,
            result.ack.roomId,
            result.ack.clientOpId,
          );
        }
      } catch (cause) {
        const response = annotationSubmitFailure(submissionInput, cause);
        acknowledge(ack, response);
        logPageCollaborationFailure(
          socket,
          "annotation",
          response.type === "annotation.ack"
            ? (response.code ?? "ANNOTATION_OPERATION_REJECTED")
            : response.code,
          parsed.success ? parsed.data.roomId : undefined,
          parsed.success ? parsed.data.clientOpId : undefined,
        );
      }
    });

    socket.on("annotation.submit.v2", async (submissionInput, ack) => {
      const parsed = AnnotationSubmitV2Schema.safeParse(submissionInput);
      try {
        if (socket.data.realtimeProtocolVersion !== 2 || !parsed.success) {
          throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE", {
            cause: parsed.success ? undefined : parsed.error,
          });
        }
        await waitForRoomSync();
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          socket.data.roomId !== parsed.data.roomId
        ) {
          throw new AnnotationServiceError("ROOM_MISMATCH");
        }
        consumeSubmission(socket.data.principal);
        const result = await options.annotations.submit({
          mode: "V2",
          principal: socket.data.principal,
          socketId: socket.id,
          submission: parsed.data,
        });
        acknowledge(ack, result.ack);
        if (result.ack.type !== "annotation.ack.v2") {
          throw new AnnotationServiceError("ANNOTATION_OPERATION_REJECTED");
        }
        socket.emit("annotation.ack.v2", result.ack);
        if (!result.deduplicated) {
          if (result.legacyCommitted !== null) {
            io.to(legacyAnnotationChannel(result.legacyCommitted.roomId)).emit(
              "annotation.committed",
              result.legacyCommitted,
            );
          }
          if (result.v2Committed !== null) {
            io.to(v2AnnotationChannel(result.v2Committed.roomId)).emit(
              "annotation.committed.v2",
              result.v2Committed,
            );
          }
        }
        if (!result.ack.accepted) {
          logPageCollaborationFailure(
            socket,
            "annotation",
            result.ack.code,
            result.ack.roomId,
            result.ack.clientOpId,
          );
        }
      } catch (cause) {
        const response = annotationSubmitV2Failure(submissionInput, cause);
        acknowledge(ack, response);
        if (response.type === "annotation.ack.v2") {
          socket.emit("annotation.ack.v2", response);
        }
        logPageCollaborationFailure(
          socket,
          "annotation",
          response.type === "annotation.ack.v2"
            ? (response.code ?? "ANNOTATION_OPERATION_REJECTED")
            : response.code,
          parsed.success ? parsed.data.roomId : undefined,
          parsed.success ? parsed.data.clientOpId : undefined,
        );
      }
    });

    socket.on("danmaku.send", async (messageInput, ack) => {
      const parsed = DanmakuSendSchema.safeParse(messageInput);
      try {
        if (!parsed.success) {
          throw new DanmakuServiceError("INVALID_DANMAKU_MESSAGE", {
            cause: parsed.error,
          });
        }
        await waitForRoomSync();
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          socket.data.roomId !== parsed.data.roomId
        ) {
          throw new DanmakuServiceError("ROOM_MISMATCH");
        }
        const result = await options.danmaku.send({
          principal: socket.data.principal,
          socketId: socket.id,
          message: parsed.data,
        });
        acknowledge(ack, result.ack);
        if (result.event !== null) {
          io.to(roomChannel(result.event.roomId)).emit("danmaku.event", result.event);
        }
        if (!result.ack.accepted) {
          logPageCollaborationFailure(
            socket,
            "danmaku",
            result.ack.code,
            result.ack.roomId,
            result.ack.messageId,
          );
        }
      } catch (cause) {
        const response = danmakuFailure(messageInput, cause);
        acknowledge(ack, response);
        logPageCollaborationFailure(
          socket,
          "danmaku",
          response.type === "danmaku.ack"
            ? (response.code ?? "INVALID_DANMAKU_MESSAGE")
            : response.code,
          parsed.success ? parsed.data.roomId : undefined,
          parsed.success ? parsed.data.messageId : undefined,
        );
      }
    });

    socket.on("stroke.preview.update", async (updateInput) => {
      const parsed = StrokePreviewUpdateSchema.safeParse(updateInput);
      try {
        if (!parsed.success) {
          throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE", {
            cause: parsed.error,
          });
        }
        await waitForRoomSync();
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          socket.data.roomId !== parsed.data.roomId
        ) {
          throw new AnnotationServiceError("ROOM_MISMATCH");
        }
        const result = await options.previews.update({
          principal: socket.data.principal,
          socketId: socket.id,
          update: parsed.data,
        });
        if (result.event !== null) {
          io.to(roomChannel(result.event.roomId)).emit("stroke.preview.event", result.event);
        }
      } catch (cause) {
        logPageCollaborationFailure(
          socket,
          "preview",
          cause instanceof AnnotationServiceError || cause instanceof SyncError
            ? cause.code
            : "ANNOTATION_OPERATION_REJECTED",
          parsed.success ? parsed.data.roomId : undefined,
          parsed.success ? parsed.data.previewId : undefined,
        );
      }
    });

    socket.on("stroke.preview.clear", async (clearInput) => {
      const parsed = StrokePreviewClearSchema.safeParse(clearInput);
      try {
        if (!parsed.success) {
          throw new AnnotationServiceError("INVALID_ANNOTATION_MESSAGE", {
            cause: parsed.error,
          });
        }
        await waitForRoomSync();
        if (
          socket.data.roomId === undefined ||
          isRoomTransitioning(socket) ||
          socket.data.roomId !== parsed.data.roomId
        ) {
          throw new AnnotationServiceError("ROOM_MISMATCH");
        }
        const clear = await options.previews.clear({
          principal: socket.data.principal,
          socketId: socket.id,
          clear: parsed.data,
        });
        if (clear !== null) {
          broadcastPreviewClear(clear);
        }
      } catch (cause) {
        logPageCollaborationFailure(
          socket,
          "preview",
          cause instanceof AnnotationServiceError || cause instanceof SyncError
            ? cause.code
            : "ANNOTATION_OPERATION_REJECTED",
          parsed.success ? parsed.data.roomId : undefined,
          parsed.success ? parsed.data.previewId : undefined,
        );
      }
    });

    socket.on("media.command", async (commandInput, ack) => {
      const parsed = MediaCommandSchema.safeParse(commandInput);
      try {
        if (!parsed.success) {
          throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
            cause: parsed.error,
          });
        }
        if (
          isRoomTransitioning(socket) ||
          socket.data.roomId === undefined ||
          socket.data.roomId !== parsed.data.roomId
        ) {
          throw new MediaServiceError("ROOM_MISMATCH");
        }
        const result = await runAsyncMediaMutation(parsed.data.roomId, () =>
          options.media.command({
            principal: socket.data.principal,
            socketId: socket.id,
            command: parsed.data,
          }),
        );
        acknowledge(ack, result.ack);
        if (result.snapshot !== null && result.events.length > 0) {
          broadcastMedia(result.snapshot);
        }
        if (!result.ack.accepted) {
          logMediaFailure(
            socket,
            result.ack.code ?? "INVALID_MEDIA_MESSAGE",
            result.ack.roomId,
            result.ack.commandId,
          );
        }
      } catch (cause) {
        const response = mediaCommandFailure(commandInput, cause);
        acknowledge(ack, response);
        logMediaFailure(
          socket,
          response.type === "media.command.ack"
            ? (response.code ?? "INVALID_MEDIA_MESSAGE")
            : response.code,
          parsed.success ? parsed.data.roomId : undefined,
          parsed.success ? parsed.data.commandId : undefined,
        );
      }
    });

    socket.on("media.heartbeat", async (heartbeatInput, ack) => {
      const parsed = MediaHeartbeatSchema.safeParse(heartbeatInput);
      try {
        if (!parsed.success) {
          throw new MediaServiceError("INVALID_MEDIA_MESSAGE", {
            cause: parsed.error,
          });
        }
        if (
          isRoomTransitioning(socket) ||
          socket.data.roomId === undefined ||
          socket.data.roomId !== parsed.data.roomId
        ) {
          throw new MediaServiceError("ROOM_MISMATCH");
        }
        const result = await runAsyncMediaMutation(parsed.data.roomId, () =>
          options.media.heartbeat({
            principal: socket.data.principal,
            socketId: socket.id,
            heartbeat: parsed.data,
          }),
        );
        acknowledge(ack, result.ack);
        if (result.snapshot !== null && result.events.length > 0) {
          broadcastVolatileMedia(result.snapshot);
        }
        if (!result.ack.accepted) {
          logMediaFailure(socket, result.ack.code ?? "INVALID_MEDIA_MESSAGE", result.ack.roomId);
        }
      } catch (cause) {
        const response = mediaHeartbeatFailure(heartbeatInput, cause);
        acknowledge(ack, response);
        logMediaFailure(
          socket,
          response.type === "media.heartbeat.ack"
            ? (response.code ?? "INVALID_MEDIA_MESSAGE")
            : response.code,
          parsed.success ? parsed.data.roomId : undefined,
        );
      }
    });

    socket.on("disconnect", () => {
      for (const [key, pending] of pendingPointerFrames) {
        if (pending.socket.id === socket.id) {
          pendingPointerFrames.delete(key);
        }
      }
      const mediaSnapshots =
        socket.data.roomId === undefined
          ? options.media.removeSocket(socket.id)
          : runMediaMutation(socket.data.roomId, () => options.media.removeSocket(socket.id));
      for (const snapshot of mediaSnapshots) {
        broadcastMedia(snapshot);
      }
      for (const mutation of options.presence.removeSocket(socket.id)) {
        handlePresenceMutation(mutation);
      }
      for (const clear of options.pointers.removeSocketLeases(socket.id)) {
        broadcastPointerLeaseClear(clear);
      }
      for (const clear of options.pointers.removeSocket(socket.id)) {
        broadcastPointerClear(clear);
      }
      for (const clear of options.previews.removeSocket(socket.id)) {
        broadcastPreviewClear(clear);
      }
      if (socket.data.roomId !== undefined) {
        clearMediaIfRoomOffline(socket.data.roomId);
      }
    });
  });

  app.addHook("onClose", async () => {
    clearInterval(sweepTimer);
    clearInterval(pointerSweepTimer);
    if (pointerFrameFlush !== undefined) {
      clearImmediate(pointerFrameFlush);
      pointerFrameFlush = undefined;
    }
    pendingPointerFrames.clear();
    for (const state of legacyPresenceBridgeByRoom.values()) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
    }
    legacyPresenceBridgeByRoom.clear();
    await Promise.resolve();
    await publicPresenceFlushTail;
    await publicPlaybackFlushTail;
    await inactiveRoomSweep;
    await Promise.resolve();
    await publicPlaybackFlushTail;
    pendingPublicPlaybackRooms.clear();
    knownMediaRooms.clear();
    submissionsByDevice.clear();
    publicConnectionBuckets.clear();
    unsubscribeProductEvents();
    await io.close();
  });

  return { closeMediaRoom };
}
