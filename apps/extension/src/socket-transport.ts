import {
  AnnotationAckV2Schema,
  AnnotationCommittedOperationV2Schema,
  AnnotationDeltaV2MessageSchema,
  AnnotationSnapshotV2MessageSchema,
  AnnotationSubmitV2Schema,
  AnnotationSyncRequestSchema,
  CommittedOperationSchema,
  DanmakuAckSchema,
  DanmakuEventMessageSchema,
  DanmakuSendSchema,
  MediaCommandAckSchema,
  MediaCommandSchema,
  MediaGroupsSnapshotMessageSchema,
  MediaHeartbeatSchema,
  OperationAckSchema,
  PointerAckSchema,
  PointerClearMessageSchema,
  PointerEventMessageSchema,
  PointerFrameEventSchema,
  PointerFrameSchema,
  PointerLeaseAckSchema,
  PointerLeaseClearSchema,
  PointerLeaseEventSchema,
  PointerLeaseSnapshotSchema,
  PointerLeaseUpdateSchema,
  PointerSnapshotMessageSchema,
  PointerUpdateSchema,
  PresenceAckSchema,
  PresenceDeltaMessageSchema,
  PresenceSnapshotMessageSchema,
  PresenceSnapshotV2MessageSchema,
  PresenceUpdateSchema,
  PresenceUpdateV2Schema,
  NotificationReadEventSchema,
  NotificationSchema,
  RoomEventMessageSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  RoomSyncRequestSchema,
  StrokePreviewClearMessageSchema,
  StrokePreviewClearSchema,
  StrokePreviewEventMessageSchema,
  StrokePreviewUpdateSchema,
  SyncErrorMessageSchema,
  type AnnotationAckV2,
  type AnnotationCommittedOperationV2,
  type AnnotationDeltaV2Message,
  type AnnotationSnapshotV2Message,
  type AnnotationSubmitV2,
  type AnnotationSyncRequest,
  type ClientOperationEnvelope,
  type CommittedOperation,
  type DanmakuAck,
  type DanmakuEventMessage,
  type DanmakuSend,
  type MediaCommand,
  type MediaCommandAck,
  type MediaGroupsSnapshotMessage,
  type MediaHeartbeat,
  type OperationAck,
  type PointerAck,
  type PointerClearMessage,
  type PointerEventMessage,
  type PointerFrame,
  type PointerFrameEvent,
  type PointerLeaseAck,
  type PointerLeaseClear,
  type PointerLeaseEvent,
  type PointerLeaseSnapshot,
  type PointerLeaseUpdate,
  type PointerSnapshotMessage,
  type PointerUpdate,
  type PresenceAck,
  type PresenceDeltaMessage,
  type PresenceSnapshotMessage,
  type PresenceSnapshotV2Message,
  type PresenceUpdate,
  type PresenceUpdateV2,
  type Notification,
  type NotificationReadEvent,
  type RoomEventMessage,
  type RoomDeltaMessage,
  type RoomSnapshotMessage,
  type RoomSyncRequest,
  type StrokePreviewClear,
  type StrokePreviewClearMessage,
  type StrokePreviewEventMessage,
  type StrokePreviewUpdate,
  type SyncErrorCode,
} from "@syncaction/protocol";
import type { ReplicaTransport, ReplicaTransportHandlers } from "@syncaction/replica";
import { io, type Socket } from "socket.io-client";
import {
  realtimeMetrics,
  type RealtimeMetrics,
  type RealtimeTransportName,
} from "./realtime-metrics.js";

export class SocketReplicaTransportError extends Error {
  public readonly code: SyncErrorCode | "TRANSPORT_FAILURE" | "PROTOCOL_FAILURE";

  public constructor(
    code: SyncErrorCode | "TRANSPORT_FAILURE" | "PROTOCOL_FAILURE",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "SocketReplicaTransportError";
    this.code = code;
  }
}

export interface SocketReplicaTransportOptions {
  serverUrl: string;
  accessToken: string | (() => Promise<string>);
  clientVersion: string;
  ackTimeoutMs?: number;
  onUiRelevantActivity?: () => void;
  metrics?: RealtimeMetrics;
  now?: () => number;
}

export type SocketAuthCallback = (data: {
  accessToken: string;
  realtimeProtocolVersion: 2;
  clientVersion: string;
}) => void;
export type PresenceMessage =
  PresenceSnapshotMessage | PresenceSnapshotV2Message | PresenceDeltaMessage;
export type PresenceMessageHandler = (message: PresenceMessage) => void;
export type PresenceSnapshotHandler = PresenceMessageHandler;
export type PointerMessage =
  | PointerEventMessage
  | PointerClearMessage
  | PointerSnapshotMessage
  | PointerLeaseEvent
  | PointerLeaseClear
  | PointerLeaseSnapshot
  | PointerFrameEvent;
export type PointerMessageHandler = (message: PointerMessage) => void;
export type MediaSnapshotHandler = (snapshot: MediaGroupsSnapshotMessage) => void;
export type AnnotationMessage =
  AnnotationSnapshotV2Message | AnnotationDeltaV2Message | AnnotationCommittedOperationV2;
export type AnnotationMessageHandler = (message: AnnotationMessage) => void;
export type DanmakuMessageHandler = (message: DanmakuEventMessage) => void;
export type StrokePreviewMessage = StrokePreviewEventMessage | StrokePreviewClearMessage;
export type StrokePreviewMessageHandler = (message: StrokePreviewMessage) => void;
export type RoomEventHandler = (event: RoomEventMessage) => void;
export type NotificationCreatedHandler = (notification: Notification) => void;
export type NotificationReadHandler = (event: NotificationReadEvent) => void;

export interface PresenceTransport {
  setPresenceHandler(handler: PresenceMessageHandler | undefined): void;
  publishPresence(update: PresenceUpdate | PresenceUpdateV2): Promise<PresenceAck>;
}

export interface PointerTransport {
  setPointerHandler(handler: PointerMessageHandler | undefined): void;
  publishPointerLease(update: PointerLeaseUpdate): Promise<PointerLeaseAck>;
  publishPointerFrame(frame: PointerFrame): void;
  publishPointer(update: PointerUpdate): Promise<PointerAck>;
}

export interface MediaTransport {
  setMediaHandler(handler: MediaSnapshotHandler | undefined): void;
  sendMediaCommand(command: MediaCommand): Promise<MediaCommandAck>;
  publishMediaHeartbeat(heartbeat: MediaHeartbeat): void;
}

export interface CollaborationTransport {
  setAnnotationHandler(handler: AnnotationMessageHandler | undefined): void;
  setDanmakuHandler(handler: DanmakuMessageHandler | undefined): void;
  setStrokePreviewHandler(handler: StrokePreviewMessageHandler | undefined): void;
  synchronizeAnnotations(
    request: AnnotationSyncRequest,
  ): Promise<AnnotationSnapshotV2Message | AnnotationDeltaV2Message>;
  submitAnnotation(submission: AnnotationSubmitV2): Promise<AnnotationAckV2>;
  sendDanmaku(message: DanmakuSend): Promise<DanmakuAck>;
  publishStrokePreview(update: StrokePreviewUpdate): Promise<void>;
  clearStrokePreview(clear: StrokePreviewClear): Promise<void>;
}

export function createSocketAuth(
  accessToken: string | (() => Promise<string>),
  clientVersionInput: string,
): (callback: SocketAuthCallback) => void {
  const provider = typeof accessToken === "string" ? async () => accessToken : accessToken;
  const clientVersion = parseClientVersion(clientVersionInput);
  return (callback) => {
    void provider().then(
      (token) => callback({ accessToken: token, realtimeProtocolVersion: 2, clientVersion }),
      () => callback({ accessToken: "", realtimeProtocolVersion: 2, clientVersion }),
    );
  };
}

export class SocketReplicaTransport
  implements
    ReplicaTransport,
    PresenceTransport,
    PointerTransport,
    MediaTransport,
    CollaborationTransport
{
  readonly #serverUrl: string;
  readonly #auth: (callback: SocketAuthCallback) => void;
  readonly #ackTimeoutMs: number;
  readonly #onUiRelevantActivity: (() => void) | undefined;
  readonly #metrics: RealtimeMetrics;
  readonly #now: () => number;
  #socket: Socket | undefined;
  #active = false;
  #presenceHandler: PresenceMessageHandler | undefined;
  #awaitingPresenceSnapshotV2 = true;
  #presenceMetricsSeq: number | null = null;
  #disconnectedAtMs: number | null = null;
  #pointerHandler: PointerMessageHandler | undefined;
  #latestPointerLeaseSnapshot: PointerLeaseSnapshot | undefined;
  #mediaHandler: MediaSnapshotHandler | undefined;
  #latestMediaSnapshot: MediaGroupsSnapshotMessage | undefined;
  #annotationHandler: AnnotationMessageHandler | undefined;
  #danmakuHandler: DanmakuMessageHandler | undefined;
  #strokePreviewHandler: StrokePreviewMessageHandler | undefined;
  #roomEventHandler: RoomEventHandler | undefined;
  #notificationCreatedHandler: NotificationCreatedHandler | undefined;
  #notificationReadHandler: NotificationReadHandler | undefined;
  readonly #roomSyncs = new Set<Promise<RoomSnapshotMessage | RoomDeltaMessage>>();
  #latestRoomSync:
    { key: string; promise: Promise<RoomSnapshotMessage | RoomDeltaMessage> } | undefined;
  #connectionGeneration = 0;
  #roomGeneration = 0;
  #roomScope: { roomId: string; roomEpoch: number } | undefined;
  #pendingMediaHeartbeat:
    | {
        socket: Socket;
        connectionGeneration: number;
        roomGeneration: number;
        heartbeat: MediaHeartbeat;
      }
    | undefined;

  public constructor(options: SocketReplicaTransportOptions) {
    this.#serverUrl = options.serverUrl;
    this.#auth = createSocketAuth(options.accessToken, options.clientVersion);
    this.#ackTimeoutMs = options.ackTimeoutMs ?? 8_000;
    this.#onUiRelevantActivity = options.onUiRelevantActivity;
    this.#metrics = options.metrics ?? realtimeMetrics;
    this.#now = options.now ?? Date.now;
  }

  public async connect(handlers: ReplicaTransportHandlers): Promise<void> {
    if (this.#socket !== undefined) {
      throw new SocketReplicaTransportError("TRANSPORT_FAILURE");
    }
    const socket = io(this.#serverUrl, {
      autoConnect: false,
      auth: this.#auth,
      reconnection: true,
      transports: ["websocket", "polling"],
      tryAllTransports: true,
      upgrade: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });
    this.#socket = socket;
    this.#active = true;
    let hasConnected = false;
    installReconnectAttemptMetric(socket, () => {
      if (this.#active) {
        this.#metrics.recordReconnectAttempt();
      }
    });
    socket.on("connect", () => {
      if (!this.#active) {
        return;
      }
      const selectedTransport = socketTransportName(socket);
      if (selectedTransport !== null) {
        this.#metrics.setSelectedTransport(selectedTransport);
      }
      if (hasConnected) {
        if (this.#disconnectedAtMs !== null) {
          this.#metrics.recordLatency(
            "reconnectRecovery",
            Math.max(0, this.#now() - this.#disconnectedAtMs),
          );
          this.#disconnectedAtMs = null;
        }
        handlers.onReconnect();
      } else {
        hasConnected = true;
      }
      this.#notifyUiRelevantActivity();
    });
    socket.on("op.committed", (message: unknown) => {
      const committed = parseCommitted(message);
      if (this.#active && committed !== undefined) {
        handlers.onCommitted(committed);
        this.#notifyUiRelevantActivity();
      }
    });
    socket.on("presence.snapshot", (message: unknown) => {
      const snapshot = PresenceSnapshotMessageSchema.safeParse(message);
      if (this.#active && snapshot.success) {
        this.#presenceMetricsSeq = null;
        this.#metrics.recordPresenceSnapshot();
        this.#presenceHandler?.(snapshot.data);
        this.#notifyUiRelevantActivity();
      }
    });
    socket.on("presence.snapshot.v2", (message: unknown) => {
      const snapshot = PresenceSnapshotV2MessageSchema.safeParse(message);
      if (this.#active && snapshot.success) {
        this.#awaitingPresenceSnapshotV2 = false;
        this.#presenceMetricsSeq = snapshot.data.presenceSeq;
        this.#metrics.recordPresenceSnapshot();
        this.#presenceHandler?.(snapshot.data);
        this.#notifyUiRelevantActivity();
      }
    });
    socket.on("presence.delta.v2", (message: unknown) => {
      const startedAt = this.#now();
      const delta = PresenceDeltaMessageSchema.safeParse(message);
      if (this.#active && !this.#awaitingPresenceSnapshotV2 && delta.success) {
        this.#metrics.recordPresenceDelta();
        if (
          this.#presenceMetricsSeq !== null &&
          delta.data.fromPresenceSeq !== this.#presenceMetricsSeq
        ) {
          this.#presenceMetricsSeq = null;
          this.#metrics.recordPresenceGap();
        } else if (this.#presenceMetricsSeq !== null) {
          this.#presenceMetricsSeq = delta.data.toPresenceSeq;
        }
        this.#presenceHandler?.(delta.data);
        this.#notifyUiRelevantActivity();
        this.#metrics.recordLatency("presenceDeltaToUi", Math.max(0, this.#now() - startedAt));
      }
    });
    socket.on("pointer.event", (message: unknown) => {
      const event = PointerEventMessageSchema.safeParse(message);
      if (this.#active && event.success) {
        this.#pointerHandler?.(event.data);
      }
    });
    socket.on("pointer.clear", (message: unknown) => {
      const clear = PointerClearMessageSchema.safeParse(message);
      if (this.#active && clear.success) {
        this.#pointerHandler?.(clear.data);
      }
    });
    socket.on("pointer.snapshot", (message: unknown) => {
      const snapshot = PointerSnapshotMessageSchema.safeParse(message);
      if (this.#active && snapshot.success) {
        this.#pointerHandler?.(snapshot.data);
      }
    });
    socket.on("pointer.lease.snapshot", (message: unknown) => {
      const snapshot = PointerLeaseSnapshotSchema.safeParse(message);
      if (this.#active && snapshot.success) {
        if (this.#pointerHandler === undefined) {
          this.#latestPointerLeaseSnapshot = snapshot.data;
        } else {
          this.#latestPointerLeaseSnapshot = undefined;
          this.#pointerHandler(snapshot.data);
        }
      }
    });
    socket.on("pointer.lease.event", (message: unknown) => {
      const event = PointerLeaseEventSchema.safeParse(message);
      if (this.#active && event.success) {
        this.#pointerHandler?.(event.data);
      }
    });
    socket.on("pointer.lease.clear", (message: unknown) => {
      const clear = PointerLeaseClearSchema.safeParse(message);
      if (this.#active && clear.success) {
        this.#pointerHandler?.(clear.data);
      }
    });
    socket.on("pointer.frame", (message: unknown) => {
      const event = PointerFrameEventSchema.safeParse(message);
      if (this.#active && event.success) {
        this.#pointerHandler?.(event.data);
      }
    });
    socket.on("media.groups.snapshot", (message: unknown) => {
      const snapshot = MediaGroupsSnapshotMessageSchema.safeParse(message);
      if (this.#active && snapshot.success) {
        if (this.#mediaHandler === undefined) {
          this.#latestMediaSnapshot = snapshot.data;
        } else {
          this.#latestMediaSnapshot = undefined;
          this.#mediaHandler(snapshot.data);
        }
        this.#notifyUiRelevantActivity();
      }
    });
    socket.on("annotation.snapshot.v2", (message: unknown) => {
      const snapshot = AnnotationSnapshotV2MessageSchema.safeParse(message);
      if (this.#active && snapshot.success) {
        this.#annotationHandler?.(snapshot.data);
      }
    });
    socket.on("annotation.delta.v2", (message: unknown) => {
      const delta = AnnotationDeltaV2MessageSchema.safeParse(message);
      if (this.#active && delta.success) {
        this.#annotationHandler?.(delta.data);
      }
    });
    socket.on("annotation.committed.v2", (message: unknown) => {
      const committed = AnnotationCommittedOperationV2Schema.safeParse(message);
      if (this.#active && committed.success) {
        this.#annotationHandler?.(committed.data);
        this.#notifyUiRelevantActivity();
      }
    });
    socket.on("danmaku.event", (message: unknown) => {
      const event = DanmakuEventMessageSchema.safeParse(message);
      if (this.#active && event.success) {
        this.#danmakuHandler?.(event.data);
      }
    });
    socket.on("stroke.preview.event", (message: unknown) => {
      const event = StrokePreviewEventMessageSchema.safeParse(message);
      if (this.#active && event.success) {
        this.#strokePreviewHandler?.(event.data);
      }
    });
    socket.on("stroke.preview.clear", (message: unknown) => {
      const clear = StrokePreviewClearMessageSchema.safeParse(message);
      if (this.#active && clear.success) {
        this.#strokePreviewHandler?.(clear.data);
      }
    });
    socket.on("room.event", (message: unknown) => {
      const startedAt = this.#now();
      const event = RoomEventMessageSchema.safeParse(message);
      if (this.#active && event.success) {
        this.#roomEventHandler?.(event.data);
        this.#notifyUiRelevantActivity();
        this.#metrics.recordLatency("roomEventToUi", Math.max(0, this.#now() - startedAt));
      }
    });
    socket.on("notification.created", (message: unknown) => {
      const notification = NotificationSchema.safeParse(message);
      if (this.#active && notification.success) {
        this.#notificationCreatedHandler?.(notification.data);
        this.#notifyUiRelevantActivity();
      }
    });
    socket.on("notification.read", (message: unknown) => {
      const read = NotificationReadEventSchema.safeParse(message);
      if (this.#active && read.success) {
        this.#notificationReadHandler?.(read.data);
        this.#notifyUiRelevantActivity();
      }
    });
    socket.on("disconnect", () => {
      if (this.#active) {
        this.#resetRoomSync();
        this.#awaitingPresenceSnapshotV2 = true;
        this.#presenceMetricsSeq = null;
        this.#disconnectedAtMs = this.#now();
        this.#latestPointerLeaseSnapshot = undefined;
        this.#latestMediaSnapshot = undefined;
        handlers.onDisconnect();
        this.#notifyUiRelevantActivity();
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", (cause: Error & { data?: unknown }) => {
        const syncError = SyncErrorMessageSchema.safeParse(cause.data);
        reject(
          syncError.success
            ? new SocketReplicaTransportError(syncError.data.code, { cause })
            : new SocketReplicaTransportError("TRANSPORT_FAILURE", { cause }),
        );
      });
      socket.connect();
    });
  }

  public async synchronize(
    requestInput: RoomSyncRequest,
  ): Promise<RoomSnapshotMessage | RoomDeltaMessage> {
    const request = RoomSyncRequestSchema.parse(requestInput);
    const socket = this.#requireSocket();
    const key = JSON.stringify(request);
    const existing = this.#latestRoomSync;
    if (existing?.key === key) return existing.promise;
    const generation = this.#connectionGeneration;
    const operation = (async () => {
      const response: unknown = await socket
        .timeout(this.#ackTimeoutMs)
        .emitWithAck("room.sync", request);
      if (
        generation !== this.#connectionGeneration ||
        this.#socket !== socket ||
        !socket.connected
      ) {
        throw new SocketReplicaTransportError("TRANSPORT_FAILURE");
      }
      this.#throwSyncError(response);
      const snapshot = RoomSnapshotMessageSchema.safeParse(response);
      const delta = RoomDeltaMessageSchema.safeParse(response);
      const message = snapshot.success ? snapshot.data : delta.success ? delta.data : null;
      if (message === null) throw new SocketReplicaTransportError("PROTOCOL_FAILURE");
      const scope = message.type === "room.snapshot" ? message.state : message;
      if (scope.roomId !== request.roomId) {
        throw new SocketReplicaTransportError("PROTOCOL_FAILURE");
      }
      if (
        this.#roomScope !== undefined &&
        (this.#roomScope.roomId !== scope.roomId || this.#roomScope.roomEpoch !== scope.roomEpoch)
      ) {
        this.#roomGeneration += 1;
      }
      this.#roomScope = { roomId: scope.roomId, roomEpoch: scope.roomEpoch };
      this.#notifyUiRelevantActivity();
      return message;
    })();
    const pending = operation.finally(() => {
      this.#roomSyncs.delete(pending);
      if (this.#latestRoomSync?.promise === pending) this.#latestRoomSync = undefined;
      if (this.#roomSyncs.size === 0) this.#flushMediaHeartbeat();
    });
    this.#roomSyncs.add(pending);
    this.#latestRoomSync = { key, promise: pending };
    return pending;
  }

  public async submit(envelope: ClientOperationEnvelope): Promise<OperationAck> {
    const response: unknown = await this.#afterRoomSync(
      envelope.roomId,
      envelope.roomEpoch,
      (socket) => socket.timeout(this.#ackTimeoutMs).emitWithAck("operation.submit", envelope),
    );
    const error = SyncErrorMessageSchema.safeParse(response);
    if (error.success) {
      throw new SocketReplicaTransportError(error.data.code);
    }
    const ack = OperationAckSchema.safeParse(response);
    if (!ack.success) {
      throw new SocketReplicaTransportError("PROTOCOL_FAILURE", {
        cause: ack.error,
      });
    }
    return ack.data;
  }

  public setPresenceHandler(handler: PresenceMessageHandler | undefined): void {
    this.#presenceHandler = handler;
  }

  public async publishPresence(
    updateInput: PresenceUpdate | PresenceUpdateV2,
  ): Promise<PresenceAck> {
    const update =
      updateInput.type === "presence.update.v2"
        ? PresenceUpdateV2Schema.parse(updateInput)
        : PresenceUpdateSchema.parse(updateInput);
    const response: unknown = await this.#afterRoomSync(
      update.roomId,
      update.type === "presence.update.v2"
        ? update.contentContext?.documentRevision.roomEpoch
        : undefined,
      (socket) => socket.timeout(this.#ackTimeoutMs).emitWithAck(update.type, update),
    );
    const error = SyncErrorMessageSchema.safeParse(response);
    if (error.success) {
      throw new SocketReplicaTransportError(error.data.code);
    }
    const ack = PresenceAckSchema.safeParse(response);
    if (!ack.success) {
      throw new SocketReplicaTransportError("PROTOCOL_FAILURE", {
        cause: ack.error,
      });
    }
    return ack.data;
  }

  public setPointerHandler(handler: PointerMessageHandler | undefined): void {
    this.#pointerHandler = handler;
    if (handler !== undefined && this.#active && this.#latestPointerLeaseSnapshot !== undefined) {
      const snapshot = this.#latestPointerLeaseSnapshot;
      this.#latestPointerLeaseSnapshot = undefined;
      handler(snapshot);
    }
  }

  public async publishPointerLease(updateInput: PointerLeaseUpdate): Promise<PointerLeaseAck> {
    const update = PointerLeaseUpdateSchema.parse(updateInput);
    const response: unknown = await this.#afterRoomSync(
      update.roomId,
      update.documentRevision?.roomEpoch,
      (socket) => socket.timeout(this.#ackTimeoutMs).emitWithAck("pointer.lease", update),
    );
    const error = SyncErrorMessageSchema.safeParse(response);
    if (error.success) {
      throw new SocketReplicaTransportError(error.data.code);
    }
    const acknowledgement = PointerLeaseAckSchema.safeParse(response);
    if (
      !acknowledgement.success ||
      acknowledgement.data.roomId !== update.roomId ||
      acknowledgement.data.leaseId !== update.leaseId
    ) {
      throw new SocketReplicaTransportError("PROTOCOL_FAILURE", {
        ...(!acknowledgement.success ? { cause: acknowledgement.error } : {}),
      });
    }
    return acknowledgement.data;
  }

  public publishPointerFrame(frameInput: PointerFrame): void {
    const frame = PointerFrameSchema.parse(frameInput);
    const socket = this.#requireSocket();
    const blocked = this.#roomSyncs.size > 0 || !this.#roomScopeMatches(frame.roomId);
    this.#metrics.recordPointerFrame(blocked || volatilePacketWillDrop(socket));
    if (blocked) return;
    socket.volatile.emit("pointer.frame", frame);
  }

  public async publishPointer(updateInput: PointerUpdate): Promise<PointerAck> {
    const update = PointerUpdateSchema.parse(updateInput);
    const response: unknown = await this.#afterRoomSync(
      update.roomId,
      update.documentRevision?.roomEpoch,
      (socket) => socket.timeout(this.#ackTimeoutMs).emitWithAck("pointer.update", update),
    );
    const error = SyncErrorMessageSchema.safeParse(response);
    if (error.success) {
      throw new SocketReplicaTransportError(error.data.code);
    }
    const ack = PointerAckSchema.safeParse(response);
    if (!ack.success) {
      throw new SocketReplicaTransportError("PROTOCOL_FAILURE", {
        cause: ack.error,
      });
    }
    return ack.data;
  }

  public setMediaHandler(handler: MediaSnapshotHandler | undefined): void {
    this.#mediaHandler = handler;
    if (handler !== undefined && this.#active && this.#latestMediaSnapshot !== undefined) {
      const snapshot = this.#latestMediaSnapshot;
      this.#latestMediaSnapshot = undefined;
      handler(snapshot);
    }
  }

  public async sendMediaCommand(commandInput: MediaCommand): Promise<MediaCommandAck> {
    const command = MediaCommandSchema.parse(commandInput);
    const response: unknown = await this.#afterRoomSync(
      command.roomId,
      "target" in command ? command.target?.documentRevision.roomEpoch : undefined,
      (socket) => socket.timeout(this.#ackTimeoutMs).emitWithAck("media.command", command),
    );
    const error = SyncErrorMessageSchema.safeParse(response);
    if (error.success) {
      throw new SocketReplicaTransportError(error.data.code);
    }
    const ack = MediaCommandAckSchema.safeParse(response);
    if (!ack.success) {
      throw new SocketReplicaTransportError("PROTOCOL_FAILURE", {
        cause: ack.error,
      });
    }
    return ack.data;
  }

  public publishMediaHeartbeat(heartbeatInput: MediaHeartbeat): void {
    const heartbeat = MediaHeartbeatSchema.parse(heartbeatInput);
    const socket = this.#requireSocket();
    if (this.#roomSyncs.size > 0) {
      this.#pendingMediaHeartbeat = {
        socket,
        connectionGeneration: this.#connectionGeneration,
        roomGeneration: this.#roomGeneration,
        heartbeat,
      };
      return;
    }
    if (!this.#roomScopeMatches(heartbeat.roomId, heartbeat.target.documentRevision.roomEpoch))
      return;
    this.#metrics.recordMediaHeartbeat();
    socket.volatile.emit("media.heartbeat", heartbeat);
  }

  public setAnnotationHandler(handler: AnnotationMessageHandler | undefined): void {
    this.#annotationHandler = handler;
  }

  public setDanmakuHandler(handler: DanmakuMessageHandler | undefined): void {
    this.#danmakuHandler = handler;
  }

  public setStrokePreviewHandler(handler: StrokePreviewMessageHandler | undefined): void {
    this.#strokePreviewHandler = handler;
  }

  public setRoomEventHandler(handler: RoomEventHandler | undefined): void {
    this.#roomEventHandler = handler;
  }

  public setNotificationCreatedHandler(handler: NotificationCreatedHandler | undefined): void {
    this.#notificationCreatedHandler = handler;
  }

  public setNotificationReadHandler(handler: NotificationReadHandler | undefined): void {
    this.#notificationReadHandler = handler;
  }

  public async synchronizeAnnotations(
    requestInput: AnnotationSyncRequest,
  ): Promise<AnnotationSnapshotV2Message | AnnotationDeltaV2Message> {
    const request = AnnotationSyncRequestSchema.parse(requestInput);
    const response: unknown = await this.#afterRoomSync(
      request.roomId,
      request.documentRevision.roomEpoch,
      (socket) => socket.timeout(this.#ackTimeoutMs).emitWithAck("annotation.sync", request),
    );
    this.#throwSyncError(response);
    const snapshot = AnnotationSnapshotV2MessageSchema.safeParse(response);
    if (snapshot.success) {
      return snapshot.data;
    }
    const delta = AnnotationDeltaV2MessageSchema.safeParse(response);
    if (delta.success) {
      return delta.data;
    }
    throw new SocketReplicaTransportError("PROTOCOL_FAILURE");
  }

  public async submitAnnotation(submissionInput: AnnotationSubmitV2): Promise<AnnotationAckV2> {
    const submission = AnnotationSubmitV2Schema.parse(submissionInput);
    const response: unknown = await this.#afterRoomSync(
      submission.roomId,
      submission.documentRevision.roomEpoch,
      (socket) =>
        socket.timeout(this.#ackTimeoutMs).emitWithAck("annotation.submit.v2", submission),
    );
    this.#throwSyncError(response);
    const acknowledgement = AnnotationAckV2Schema.safeParse(response);
    const authoritativePageMismatch =
      acknowledgement.success &&
      !acknowledgement.data.accepted &&
      acknowledgement.data.code === "PAGE_MISMATCH" &&
      acknowledgement.data.pageKey !== null &&
      acknowledgement.data.pageKey !== submission.pageKey;
    if (
      !acknowledgement.success ||
      acknowledgement.data.clientOpId !== submission.clientOpId ||
      acknowledgement.data.roomId !== submission.roomId ||
      (acknowledgement.data.pageKey !== null &&
        acknowledgement.data.pageKey !== submission.pageKey &&
        !authoritativePageMismatch)
    ) {
      throw new SocketReplicaTransportError("PROTOCOL_FAILURE", {
        ...(!acknowledgement.success ? { cause: acknowledgement.error } : {}),
      });
    }
    return acknowledgement.data;
  }

  public async sendDanmaku(messageInput: DanmakuSend): Promise<DanmakuAck> {
    const message = DanmakuSendSchema.parse(messageInput);
    const response: unknown = await this.#afterRoomSync(
      message.roomId,
      message.documentRevision.roomEpoch,
      (socket) => socket.volatile.timeout(this.#ackTimeoutMs).emitWithAck("danmaku.send", message),
    );
    this.#throwSyncError(response);
    const acknowledgement = DanmakuAckSchema.safeParse(response);
    if (
      !acknowledgement.success ||
      acknowledgement.data.messageId !== message.messageId ||
      acknowledgement.data.roomId !== message.roomId
    ) {
      throw new SocketReplicaTransportError("PROTOCOL_FAILURE", {
        ...(!acknowledgement.success ? { cause: acknowledgement.error } : {}),
      });
    }
    return acknowledgement.data;
  }

  public async publishStrokePreview(updateInput: StrokePreviewUpdate): Promise<void> {
    const update = StrokePreviewUpdateSchema.parse(updateInput);
    if (
      this.#roomSyncs.size > 0 ||
      !this.#roomScopeMatches(update.roomId, update.documentRevision.roomEpoch)
    )
      return;
    this.#requireSocket().volatile.emit("stroke.preview.update", update);
  }

  public async clearStrokePreview(clearInput: StrokePreviewClear): Promise<void> {
    const clear = StrokePreviewClearSchema.parse(clearInput);
    if (
      this.#roomSyncs.size > 0 ||
      !this.#roomScopeMatches(clear.roomId, clear.documentRevision.roomEpoch)
    )
      return;
    this.#requireSocket().volatile.emit("stroke.preview.clear", clear);
  }

  public async disconnect(): Promise<void> {
    const socket = this.#socket;
    this.#resetRoomSync();
    this.#active = false;
    this.#socket = undefined;
    this.#awaitingPresenceSnapshotV2 = true;
    this.#presenceMetricsSeq = null;
    this.#disconnectedAtMs = null;
    this.#latestPointerLeaseSnapshot = undefined;
    this.#latestMediaSnapshot = undefined;
    this.#mediaHandler = undefined;
    this.#annotationHandler = undefined;
    this.#danmakuHandler = undefined;
    this.#strokePreviewHandler = undefined;
    this.#roomEventHandler = undefined;
    this.#notificationCreatedHandler = undefined;
    this.#notificationReadHandler = undefined;
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  }

  async #afterRoomSync<T>(
    roomId: string,
    roomEpoch: number | undefined,
    send: (socket: Socket) => Promise<T>,
  ): Promise<T> {
    const socket = this.#requireSocket();
    const generation = this.#connectionGeneration;
    const roomGeneration = this.#roomGeneration;
    while (this.#roomSyncs.size > 0) {
      await Promise.allSettled([...this.#roomSyncs.values()]);
      if (generation !== this.#connectionGeneration) {
        throw new SocketReplicaTransportError("TRANSPORT_FAILURE");
      }
    }
    if (
      generation !== this.#connectionGeneration ||
      roomGeneration !== this.#roomGeneration ||
      this.#socket !== socket ||
      !socket.connected ||
      !this.#roomScopeMatches(roomId, roomEpoch)
    ) {
      throw new SocketReplicaTransportError("TRANSPORT_FAILURE");
    }
    return send(socket);
  }

  #roomScopeMatches(roomId: string, roomEpoch?: number): boolean {
    return (
      this.#roomScope === undefined ||
      (this.#roomScope.roomId === roomId &&
        (roomEpoch === undefined || this.#roomScope.roomEpoch === roomEpoch))
    );
  }

  #flushMediaHeartbeat(): void {
    const pending = this.#pendingMediaHeartbeat;
    this.#pendingMediaHeartbeat = undefined;
    if (
      pending === undefined ||
      pending.socket !== this.#socket ||
      !pending.socket.connected ||
      pending.connectionGeneration !== this.#connectionGeneration ||
      pending.roomGeneration !== this.#roomGeneration ||
      !this.#roomScopeMatches(
        pending.heartbeat.roomId,
        pending.heartbeat.target.documentRevision.roomEpoch,
      )
    )
      return;
    this.#metrics.recordMediaHeartbeat();
    pending.socket.volatile.emit("media.heartbeat", pending.heartbeat);
  }

  #resetRoomSync(): void {
    this.#connectionGeneration += 1;
    this.#roomSyncs.clear();
    this.#latestRoomSync = undefined;
    this.#roomScope = undefined;
    this.#pendingMediaHeartbeat = undefined;
  }

  #requireSocket(): Socket {
    if (this.#socket === undefined || !this.#socket.connected) {
      throw new SocketReplicaTransportError("TRANSPORT_FAILURE");
    }
    return this.#socket;
  }

  #throwSyncError(response: unknown): void {
    const error = SyncErrorMessageSchema.safeParse(response);
    if (error.success) {
      throw new SocketReplicaTransportError(error.data.code);
    }
  }

  #notifyUiRelevantActivity(): void {
    try {
      this.#onUiRelevantActivity?.();
    } catch {
      // UI notification hooks must never break transport delivery.
    }
  }
}

function parseClientVersion(input: unknown): string {
  if (typeof input !== "string" || !/^\d+\.\d+\.\d+$/u.test(input)) {
    throw new SocketReplicaTransportError("PROTOCOL_FAILURE");
  }
  return input;
}

interface SocketManagerMetricsView {
  on?(event: "reconnect_attempt", handler: () => void): unknown;
  engine?: {
    transport?: {
      name?: unknown;
      writable?: unknown;
    };
  };
}

function installReconnectAttemptMetric(socket: Socket, handler: () => void): void {
  const manager = (socket as unknown as { io?: SocketManagerMetricsView }).io;
  manager?.on?.("reconnect_attempt", handler);
}

function socketTransportName(socket: Socket): RealtimeTransportName | null {
  const name = (socket as unknown as { io?: SocketManagerMetricsView }).io?.engine?.transport?.name;
  return name === "websocket" || name === "polling" ? name : null;
}

function volatilePacketWillDrop(socket: Socket): boolean {
  const writable = (socket as unknown as { io?: SocketManagerMetricsView }).io?.engine?.transport
    ?.writable;
  return !socket.connected || writable === false;
}

function parseCommitted(message: unknown): CommittedOperation | undefined {
  const result = CommittedOperationSchema.safeParse(message);
  return result.success ? result.data : undefined;
}
