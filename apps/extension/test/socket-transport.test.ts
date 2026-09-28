import type {
  AnnotationAckV2 as AnnotationAck,
  AnnotationCommittedOperationV2 as AnnotationCommittedOperation,
  AnnotationSnapshotV2Message as AnnotationSnapshotMessage,
  AnnotationSubmitV2 as AnnotationSubmit,
  AnnotationSyncRequest,
  DanmakuAck,
  DanmakuEventMessage,
  DanmakuSend,
  MediaCommand,
  MediaCommandAck,
  MediaGroupsSnapshotMessage,
  MediaHeartbeat,
  PointerAck,
  PointerClearMessage,
  PointerEventMessage,
  PointerFrame,
  PointerFrameEvent,
  PointerLeaseAck,
  PointerLeaseClear,
  PointerLeaseEvent,
  PointerLeaseSnapshot,
  PointerLeaseUpdate,
  PointerSnapshotMessage,
  PointerUpdate,
  PresenceDeltaMessage,
  PresenceSnapshotV2Message,
  PresenceUpdateV2,
  StrokePreviewClear,
  StrokePreviewClearMessage,
  StrokePreviewEventMessage,
  StrokePreviewUpdate,
} from "@syncaction/protocol";
import {
  ClientOpIdSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
} from "@syncaction/protocol";
import { io } from "socket.io-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSocketAuth, SocketReplicaTransport } from "../src/socket-transport.js";
import type { SocketReplicaTransportError } from "../src/socket-transport.js";

vi.mock("socket.io-client", () => ({
  io: vi.fn(),
}));

const ROOM_ID = RoomIdSchema.parse("10000000-0000-4000-8000-000000000001");
const LOGICAL_TAB_ID = LogicalTabIdSchema.parse("20000000-0000-4000-8000-000000000001");
const USER_ID = "30000000-0000-4000-8000-000000000001";
const DEVICE_ID = DeviceIdSchema.parse("40000000-0000-4000-8000-000000000001");
const PLAYBACK_GROUP_ID = "50000000-0000-4000-8000-000000000001";
const MEDIA_COMMAND_ID = "60000000-0000-4000-8000-000000000001";
const ANNOTATION_CLIENT_OP_ID = ClientOpIdSchema.parse("70000000-0000-4000-8000-000000000001");
const STROKE_ID = "80000000-0000-4000-8000-000000000001";
const PREVIEW_ID = "90000000-0000-4000-8000-000000000001";
const DANMAKU_ID = "a0000000-0000-4000-8000-000000000001";
const PAGE_KEY = "A".repeat(43);

const pointerUpdate: PointerUpdate = {
  type: "pointer.update",
  protocolVersion: 1,
  roomId: ROOM_ID,
  logicalTabId: LOGICAL_TAB_ID,
  documentRevision: {
    roomEpoch: 1,
    tabUpdatedAtSeq: 2,
  },
  anchor: {
    path: [{ tagName: "main", nthOfType: 1 }],
    x: 0.25,
    y: 0.75,
  },
  viewport: {
    x: 0.4,
    y: 0.6,
  },
};

const pointerEvent: PointerEventMessage = {
  type: "pointer.event",
  protocolVersion: 1,
  roomId: ROOM_ID,
  pointer: {
    userId: USER_ID,
    username: "member",
    displayName: "Member",
    deviceId: DEVICE_ID,
    color: "#3b82f6",
    logicalTabId: LOGICAL_TAB_ID,
    documentRevision: pointerUpdate.documentRevision,
    anchor: pointerUpdate.anchor,
    viewport: pointerUpdate.viewport,
    expiresAt: 10_000,
  },
};

const pointerLeaseId = "41000000-0000-4000-8000-000000000001";
const pointerLeaseUpdate: PointerLeaseUpdate = {
  type: "pointer.lease",
  protocolVersion: 1,
  roomId: ROOM_ID,
  deviceId: DEVICE_ID,
  leaseId: pointerLeaseId,
  logicalTabId: LOGICAL_TAB_ID,
  documentRevision: pointerUpdate.documentRevision,
  anchor: pointerUpdate.anchor,
};
const pointerLeaseAck: PointerLeaseAck = {
  type: "pointer.lease.ack",
  protocolVersion: 1,
  roomId: ROOM_ID,
  leaseId: pointerLeaseId,
  accepted: true,
  expiresAt: 10_000,
};
const pointerLeaseEvent: PointerLeaseEvent = {
  type: "pointer.lease.event",
  protocolVersion: 1,
  roomId: ROOM_ID,
  lease: {
    userId: USER_ID,
    username: "member",
    displayName: "Member",
    deviceId: DEVICE_ID,
    leaseId: pointerLeaseId,
    color: "#3b82f6",
    logicalTabId: LOGICAL_TAB_ID,
    documentRevision: pointerUpdate.documentRevision,
    anchor: pointerUpdate.anchor,
    expiresAt: 10_000,
  },
};
const pointerFrame: PointerFrame = {
  type: "pointer.frame",
  protocolVersion: 1,
  roomId: ROOM_ID,
  leaseId: pointerLeaseId,
  seq: 1,
  xQuantized: 1_638,
  yQuantized: 2_457,
  viewport: { widthBucket: 9, heightBucket: 6 },
  sentAtClientMs: 9_900,
};
const pointerFrameEvent: PointerFrameEvent = {
  ...pointerFrame,
  userId: USER_ID,
  deviceId: DEVICE_ID,
  receivedAtServerMs: 10_000,
};
delete (pointerFrameEvent as Partial<PointerFrame>).sentAtClientMs;

const mediaTarget = {
  logicalTabId: LOGICAL_TAB_ID,
  documentRevision: pointerUpdate.documentRevision,
  frameKey: "top" as const,
  provider: "YOUTUBE" as const,
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
};

const mediaObserved = {
  observedAtClientMs: 1_700_000_000_000,
  positionMs: 42_000,
  paused: false,
  playbackRate: 1,
  ended: false,
  buffering: false,
};

const mediaCommand: MediaCommand = {
  type: "group.create",
  protocolVersion: 1,
  commandId: MEDIA_COMMAND_ID,
  roomId: ROOM_ID,
  target: mediaTarget,
  observed: mediaObserved,
};

const mediaHeartbeat: MediaHeartbeat = {
  type: "media.heartbeat",
  protocolVersion: 1,
  roomId: ROOM_ID,
  playbackGroupId: PLAYBACK_GROUP_ID,
  groupRevision: 1,
  target: mediaTarget,
  ...mediaObserved,
};

const mediaSnapshot: MediaGroupsSnapshotMessage = {
  type: "media.groups.snapshot",
  protocolVersion: 1,
  roomId: ROOM_ID,
  roomMediaRevision: 1,
  groups: [
    {
      playbackGroupId: PLAYBACK_GROUP_ID,
      roomId: ROOM_ID,
      groupRevision: 1,
      status: "PLAYING",
      leaderUserId: USER_ID,
      leaderDeviceId: DEVICE_ID,
      members: [
        {
          userId: USER_ID,
          username: "member",
          displayName: "Member",
          activeDeviceId: DEVICE_ID,
          joinedAtServerMs: 1_700_000_000_000,
          online: true,
        },
      ],
      target: mediaTarget,
      observed: mediaObserved,
      observedAtServerMs: 1_700_000_000_100,
      proposals: [],
      leaderGraceExpiresAtServerMs: null,
      updatedAtServerMs: 1_700_000_000_100,
    },
  ],
};

const presenceSnapshotV2: PresenceSnapshotV2Message = {
  type: "presence.snapshot.v2",
  protocolVersion: 1,
  roomId: ROOM_ID,
  presenceSeq: 1,
  presences: [
    {
      userId: USER_ID,
      username: "member",
      displayName: "Member",
      deviceId: DEVICE_ID,
      logicalTabId: LOGICAL_TAB_ID,
      contentContext: null,
      expiresAt: 10_000,
    },
  ],
};

const presenceDeltaV2: PresenceDeltaMessage = {
  type: "presence.delta.v2",
  protocolVersion: 1,
  roomId: ROOM_ID,
  fromPresenceSeq: 1,
  toPresenceSeq: 2,
  changes: [
    {
      kind: "UPSERT",
      presence: {
        ...presenceSnapshotV2.presences[0]!,
        logicalTabId: null,
        contentContext: null,
        expiresAt: 20_000,
      },
    },
  ],
};

const exactDocument = {
  roomId: ROOM_ID,
  logicalTabId: LOGICAL_TAB_ID,
  documentRevision: pointerUpdate.documentRevision,
  frameKey: "top" as const,
};

const annotationDraft = {
  strokeId: STROKE_ID,
  frameKey: "top" as const,
  anchor: {
    type: "document" as const,
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
  contentSignature: {
    signatureVersion: 1,
    digest: "S".repeat(43),
  },
};

const annotationSyncRequest: AnnotationSyncRequest = {
  protocolVersion: 1,
  ...exactDocument,
  lastAnnotationSeq: 0,
  hasConfirmedSnapshot: false,
};

const annotationSnapshot: AnnotationSnapshotMessage = {
  type: "annotation.snapshot.v2",
  protocolVersion: 1,
  ...exactDocument,
  pageKey: PAGE_KEY,
  annotationSeq: 0,
  strokes: [],
};

const annotationSubmit: AnnotationSubmit = {
  type: "annotation.submit.v2",
  protocolVersion: 1,
  clientOpId: ANNOTATION_CLIENT_OP_ID,
  ...exactDocument,
  pageKey: PAGE_KEY,
  baseAnnotationSeq: 0,
  operation: {
    type: "stroke.create",
    stroke: annotationDraft,
  },
};

const annotationAck: AnnotationAck = {
  type: "annotation.ack.v2",
  protocolVersion: 1,
  clientOpId: ANNOTATION_CLIENT_OP_ID,
  roomId: ROOM_ID,
  accepted: true,
  code: null,
  pageKey: PAGE_KEY,
  annotationSeq: 1,
  results: [
    {
      strokeId: STROKE_ID,
      accepted: true,
      code: null,
      version: 1,
    },
  ],
};

const annotationCommitted: AnnotationCommittedOperation = {
  type: "annotation.committed.v2",
  protocolVersion: 1,
  clientOpId: ANNOTATION_CLIENT_OP_ID,
  roomId: ROOM_ID,
  pageKey: PAGE_KEY,
  annotationSeq: 1,
  actorUserId: USER_ID,
  operation: annotationSubmit.operation,
  results: annotationAck.results,
  createdAtServerMs: 10_000,
};

const danmakuSend: DanmakuSend = {
  type: "danmaku.send",
  protocolVersion: 1,
  messageId: DANMAKU_ID,
  ...exactDocument,
  text: "一起看",
};

const danmakuAck: DanmakuAck = {
  type: "danmaku.ack",
  protocolVersion: 1,
  messageId: DANMAKU_ID,
  roomId: ROOM_ID,
  accepted: true,
  code: null,
  sentAtServerMs: 10_000,
  expiresAtServerMs: 19_000,
};

const danmakuEvent: DanmakuEventMessage = {
  type: "danmaku.event",
  protocolVersion: 1,
  messageId: DANMAKU_ID,
  ...exactDocument,
  sender: {
    userId: USER_ID,
    username: "member",
    displayName: "Member",
    deviceId: DEVICE_ID,
  },
  text: "一起看",
  sentAtServerMs: 10_000,
  expiresAtServerMs: 19_000,
};

const previewUpdate: StrokePreviewUpdate = {
  type: "stroke.preview.update",
  protocolVersion: 1,
  previewId: PREVIEW_ID,
  ...exactDocument,
  anchor: annotationDraft.anchor,
  points: annotationDraft.points,
  rgb: annotationDraft.rgb,
  width: annotationDraft.width,
};

const previewEvent: StrokePreviewEventMessage = {
  type: "stroke.preview.event",
  protocolVersion: 1,
  previewId: PREVIEW_ID,
  ...exactDocument,
  sender: {
    userId: USER_ID,
    username: "member",
    displayName: "Member",
    deviceId: DEVICE_ID,
  },
  anchor: annotationDraft.anchor,
  points: annotationDraft.points,
  rgb: annotationDraft.rgb,
  width: annotationDraft.width,
  expiresAtServerMs: 13_000,
};

const previewClear: StrokePreviewClear = {
  type: "stroke.preview.clear",
  protocolVersion: 1,
  previewId: PREVIEW_ID,
  ...exactDocument,
};

const previewClearMessage: StrokePreviewClearMessage = {
  ...previewClear,
  sender: {
    userId: USER_ID,
    deviceId: DEVICE_ID,
  },
};

class FakeSocket {
  public connected = false;
  public volatileReads = 0;
  public readonly emitWithAck = vi.fn();
  public readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  public readonly removeAllListeners = vi.fn(() => {
    this.handlers.clear();
    this.onceHandlers.clear();
  });
  public readonly disconnect = vi.fn(() => {
    this.connected = false;
  });
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private readonly onceHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

  public on(event: string, handler: (...args: never[]) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.handlers.set(event, handlers);
    return this;
  }

  public once(event: string, handler: (...args: never[]) => void): this {
    const handlers = this.onceHandlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.onceHandlers.set(event, handlers);
    return this;
  }

  public connect(): this {
    this.connected = true;
    this.emit("connect");
    return this;
  }

  public timeout(): this {
    return this;
  }

  public get volatile(): this {
    this.volatileReads += 1;
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    this.emitted.push({ event, args: structuredClone(args) });
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
    const once = this.onceHandlers.get(event) ?? [];
    this.onceHandlers.delete(event);
    for (const handler of once) {
      handler(...args);
    }
  }
}

function createConnectedTransport(): {
  socket: FakeSocket;
  transport: SocketReplicaTransport;
} {
  const socket = new FakeSocket();
  vi.mocked(io).mockReturnValue(socket as never);
  const transport = new SocketReplicaTransport({
    serverUrl: "https://syncaction.example.test",
    accessToken: "access-1",
    clientVersion: "0.9.0",
  });
  void transport.connect({
    onCommitted: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn(),
  });
  return { socket, transport };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SocketReplicaTransport authentication", () => {
  it("reads the latest access token for every Socket.IO handshake", async () => {
    let token = "access-1";
    const provider = vi.fn(async () => token);
    const auth = createSocketAuth(provider, "0.9.0");
    const first = vi.fn();
    const second = vi.fn();

    auth(first);
    await vi.waitFor(() =>
      expect(first).toHaveBeenCalledWith({
        accessToken: "access-1",
        realtimeProtocolVersion: 2,
        clientVersion: "0.9.0",
      }),
    );
    token = "access-2";
    auth(second);
    await vi.waitFor(() =>
      expect(second).toHaveBeenCalledWith({
        accessToken: "access-2",
        realtimeProtocolVersion: 2,
        clientVersion: "0.9.0",
      }),
    );

    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("fails the handshake closed when the token provider cannot refresh", async () => {
    const auth = createSocketAuth(vi.fn().mockRejectedValue(new Error("refresh failed")), "0.9.0");
    const callback = vi.fn();

    auth(callback);

    await vi.waitFor(() =>
      expect(callback).toHaveBeenCalledWith({
        accessToken: "",
        realtimeProtocolVersion: 2,
        clientVersion: "0.9.0",
      }),
    );
  });

  it("uses WebSocket-first fallback and bounded randomized reconnection", () => {
    createConnectedTransport();

    expect(io).toHaveBeenCalledWith(
      "https://syncaction.example.test",
      expect.objectContaining({
        autoConnect: false,
        transports: ["websocket", "polling"],
        tryAllTransports: true,
        upgrade: true,
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 30_000,
        randomizationFactor: 0.5,
      }),
    );
  });
});

describe("SocketReplicaTransport product event channels", () => {
  it("parses product events strictly and reports only UI-relevant activity", async () => {
    const socket = new FakeSocket();
    vi.mocked(io).mockReturnValue(socket as never);
    const onUiRelevantActivity = vi.fn();
    const transport = new SocketReplicaTransport({
      serverUrl: "https://syncaction.example.test",
      accessToken: "access-1",
      clientVersion: "0.9.0",
      onUiRelevantActivity,
    });
    const roomHandler = vi.fn();
    const notificationHandler = vi.fn();
    const readHandler = vi.fn();
    transport.setRoomEventHandler(roomHandler);
    transport.setNotificationCreatedHandler(notificationHandler);
    transport.setNotificationReadHandler(readHandler);
    await transport.connect({
      onCommitted: vi.fn(),
      onDisconnect: vi.fn(),
      onReconnect: vi.fn(),
    });

    const roomEvent = {
      type: "room.event",
      protocolVersion: 1,
      eventId: "b0000000-0000-4000-8000-000000000001",
      roomId: ROOM_ID,
      roomRevision: 2,
      occurredAt: "2026-07-30T00:00:00.000Z",
      kind: "ROOM_UPDATED",
      name: "Shared room",
      visibility: "PUBLIC",
      joinPolicy: "APPROVAL",
    };
    const notification = {
      notificationId: "c0000000-0000-4000-8000-000000000001",
      cursor: 3,
      type: "SYSTEM_UPDATE",
      actor: null,
      room: null,
      requestId: null,
      invitationId: null,
      decision: null,
      title: "SyncAction v0.9.0",
      body: "Update available",
      version: "0.9.0",
      createdAt: "2026-07-30T00:00:00.000Z",
      readAt: null,
    };
    const read = {
      kind: "ONE",
      notificationId: notification.notificationId,
      readAt: "2026-07-30T00:01:00.000Z",
    };

    socket.emit("room.event", roomEvent);
    socket.emit("notification.created", notification);
    socket.emit("notification.read", read);
    socket.emit("room.event", { ...roomEvent, privateUrl: "https://private.example" });
    socket.emit("notification.created", { ...notification, cursor: 0 });
    socket.emit("notification.read", { ...read, unexpected: true });
    socket.emit("media.groups.snapshot", mediaSnapshot);
    socket.emit("annotation.committed.v2", annotationCommitted);
    socket.emit("pointer.event", pointerEvent);
    socket.emit("danmaku.event", danmakuEvent);
    socket.emit("stroke.preview.event", previewEvent);

    expect(roomHandler).toHaveBeenCalledExactlyOnceWith(roomEvent);
    expect(notificationHandler).toHaveBeenCalledExactlyOnceWith(notification);
    expect(readHandler).toHaveBeenCalledExactlyOnceWith(read);
    expect(onUiRelevantActivity).toHaveBeenCalledTimes(6);
  });
});

describe("SocketReplicaTransport presence v2 channel", () => {
  it("publishes strict v2 content context on the v2 event", async () => {
    const { socket, transport } = createConnectedTransport();
    const update: PresenceUpdateV2 = {
      type: "presence.update.v2",
      protocolVersion: 1,
      roomId: ROOM_ID,
      logicalTabId: LOGICAL_TAB_ID,
      contentContext: {
        documentRevision: { roomEpoch: 1, tabUpdatedAtSeq: 2 },
        canonicalPageIdentity: "https://example.com/watch",
        contentSignature: {
          signatureVersion: 1,
          digest: "A".repeat(43),
        },
        media: {
          provider: "YOUTUBE",
          mediaKey: "youtube:dQw4w9WgXcQ",
        },
      },
    };
    const ack = {
      type: "presence.ack",
      protocolVersion: 1,
      roomId: ROOM_ID,
      expiresAt: 30_000,
    };
    socket.emitWithAck.mockResolvedValue(ack);

    await expect(transport.publishPresence(update)).resolves.toEqual(ack);

    expect(socket.emitWithAck).toHaveBeenCalledWith("presence.update.v2", update);
  });

  it("delivers strict snapshots and contiguous deltas", () => {
    const { socket, transport } = createConnectedTransport();
    const handler = vi.fn();
    transport.setPresenceHandler(handler);

    socket.emit("presence.snapshot.v2", presenceSnapshotV2);
    socket.emit("presence.delta.v2", presenceDeltaV2);
    socket.emit("presence.delta.v2", {
      ...presenceDeltaV2,
      privateUrl: "https://private.example/",
    });

    expect(handler.mock.calls).toEqual([[presenceSnapshotV2], [presenceDeltaV2]]);
  });

  it("waits for a fresh v2 snapshot after disconnect before forwarding deltas", () => {
    const { socket, transport } = createConnectedTransport();
    const handler = vi.fn();
    transport.setPresenceHandler(handler);
    socket.emit("presence.snapshot.v2", presenceSnapshotV2);
    handler.mockClear();

    socket.emit("disconnect");
    socket.emit("presence.delta.v2", presenceDeltaV2);
    expect(handler).not.toHaveBeenCalled();

    const recoveredSnapshot: PresenceSnapshotV2Message = {
      ...presenceSnapshotV2,
      presenceSeq: 2,
      presences: [
        {
          ...presenceSnapshotV2.presences[0]!,
          logicalTabId: null,
          contentContext: null,
          expiresAt: 20_000,
        },
      ],
    };
    socket.emit("presence.snapshot.v2", recoveredSnapshot);
    socket.emit("presence.delta.v2", {
      ...presenceDeltaV2,
      fromPresenceSeq: 2,
      toPresenceSeq: 3,
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, recoveredSnapshot);
    expect(handler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "presence.delta.v2", fromPresenceSeq: 2 }),
    );
  });
});

describe("SocketReplicaTransport pointer channel", () => {
  it("publishes a reliable lease before volatile frames without frame ACKs", async () => {
    const { socket, transport } = createConnectedTransport();
    socket.emitWithAck.mockResolvedValue(pointerLeaseAck);

    await expect(transport.publishPointerLease(pointerLeaseUpdate)).resolves.toEqual(
      pointerLeaseAck,
    );
    expect(socket.emitWithAck).toHaveBeenCalledWith("pointer.lease", pointerLeaseUpdate);

    expect(transport.publishPointerFrame(pointerFrame)).toBeUndefined();
    expect(socket.volatileReads).toBe(1);
    expect(socket.emitted.at(-1)).toEqual({
      event: "pointer.frame",
      args: [pointerFrame],
    });
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
  });

  it("delivers strict lease, frame, snapshot, and clear messages", () => {
    const { socket, transport } = createConnectedTransport();
    const handler = vi.fn();
    transport.setPointerHandler(handler);
    const snapshot: PointerLeaseSnapshot = {
      type: "pointer.lease.snapshot",
      protocolVersion: 1,
      roomId: ROOM_ID,
      leases: [pointerLeaseEvent.lease],
    };
    const clear: PointerLeaseClear = {
      type: "pointer.lease.clear",
      protocolVersion: 1,
      roomId: ROOM_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      leaseId: pointerLeaseId,
    };

    socket.emit("pointer.lease.snapshot", snapshot);
    socket.emit("pointer.lease.event", pointerLeaseEvent);
    socket.emit("pointer.frame", pointerFrameEvent);
    socket.emit("pointer.lease.clear", clear);
    socket.emit("pointer.frame", { ...pointerFrameEvent, seq: 0 });
    socket.emit("pointer.lease.event", {
      ...pointerLeaseEvent,
      lease: { ...pointerLeaseEvent.lease, privateUrl: "https://private.example" },
    });

    expect(handler.mock.calls).toEqual([
      [snapshot],
      [pointerLeaseEvent],
      [pointerFrameEvent],
      [clear],
    ]);
  });

  it("replays the latest lease snapshot when the controller attaches after connect", () => {
    const { socket, transport } = createConnectedTransport();
    const snapshot: PointerLeaseSnapshot = {
      type: "pointer.lease.snapshot",
      protocolVersion: 1,
      roomId: ROOM_ID,
      leases: [pointerLeaseEvent.lease],
    };
    socket.emit("pointer.lease.snapshot", snapshot);
    const handler = vi.fn();

    transport.setPointerHandler(handler);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(snapshot);

    transport.setPointerHandler(undefined);
    const replacement = vi.fn();
    transport.setPointerHandler(replacement);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("publishes a strict pointer update and parses its acknowledgement", async () => {
    const { socket, transport } = createConnectedTransport();
    const ack: PointerAck = {
      type: "pointer.ack",
      protocolVersion: 1,
      roomId: ROOM_ID,
      accepted: true,
      expiresAt: 10_000,
    };
    socket.emitWithAck.mockResolvedValue(ack);

    await expect(transport.publishPointer(pointerUpdate)).resolves.toEqual(ack);
    expect(socket.emitWithAck).toHaveBeenCalledWith("pointer.update", pointerUpdate);
  });

  it("rejects malformed updates, sync errors, and malformed acknowledgements", async () => {
    const { socket, transport } = createConnectedTransport();

    await expect(
      transport.publishPointer({
        ...pointerUpdate,
        selector: "#private",
      } as never),
    ).rejects.toThrow();
    expect(socket.emitWithAck).not.toHaveBeenCalled();

    socket.emitWithAck.mockResolvedValueOnce({
      type: "sync.error",
      protocolVersion: 1,
      code: "ROOM_NOT_FOUND",
    });
    await expect(transport.publishPointer(pointerUpdate)).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    } satisfies Partial<SocketReplicaTransportError>);

    socket.emitWithAck.mockResolvedValueOnce({
      type: "pointer.ack",
      protocolVersion: 1,
      roomId: ROOM_ID,
      accepted: true,
      expiresAt: null,
    });
    await expect(transport.publishPointer(pointerUpdate)).rejects.toMatchObject({
      code: "PROTOCOL_FAILURE",
    } satisfies Partial<SocketReplicaTransportError>);
  });

  it("delivers only strict pointer events, clears, and snapshots", () => {
    const { socket, transport } = createConnectedTransport();
    const handler = vi.fn();
    transport.setPointerHandler(handler);
    const clear: PointerClearMessage = {
      type: "pointer.clear",
      protocolVersion: 1,
      roomId: ROOM_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
    };
    const snapshot: PointerSnapshotMessage = {
      type: "pointer.snapshot",
      protocolVersion: 1,
      roomId: ROOM_ID,
      pointers: [pointerEvent.pointer],
    };

    socket.emit("pointer.event", pointerEvent);
    socket.emit("pointer.clear", clear);
    socket.emit("pointer.snapshot", snapshot);
    socket.emit("pointer.event", {
      ...pointerEvent,
      pointer: {
        ...pointerEvent.pointer,
        color: "blue",
      },
    });
    socket.emit("pointer.snapshot", {
      ...snapshot,
      pointers: [pointerEvent.pointer, pointerEvent.pointer],
    });

    expect(handler.mock.calls).toEqual([[pointerEvent], [clear], [snapshot]]);
  });

  it("stops delivering pointer messages after the handler is cleared", () => {
    const { socket, transport } = createConnectedTransport();
    const handler = vi.fn();
    transport.setPointerHandler(handler);
    transport.setPointerHandler(undefined);

    socket.emit("pointer.event", pointerEvent);

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("SocketReplicaTransport media channel", () => {
  it("delivers one strict media snapshot and ignores malformed messages", () => {
    const { socket, transport } = createConnectedTransport();
    const handler = vi.fn();
    transport.setMediaHandler(handler);

    socket.emit("media.groups.snapshot", mediaSnapshot);
    socket.emit("media.groups.snapshot", {
      ...mediaSnapshot,
      privateUrl: "https://private.example/watch",
    });
    socket.emit("media.groups.snapshot", {
      ...mediaSnapshot,
      groups: [mediaSnapshot.groups[0], mediaSnapshot.groups[0]],
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(mediaSnapshot);
  });

  it("validates reliable commands and preserves domain rejection acknowledgements", async () => {
    const { socket, transport } = createConnectedTransport();
    const accepted: MediaCommandAck = {
      type: "media.command.ack",
      protocolVersion: 1,
      commandId: MEDIA_COMMAND_ID,
      roomId: ROOM_ID,
      accepted: true,
      code: null,
      playbackGroupId: PLAYBACK_GROUP_ID,
      groupRevision: 1,
      roomMediaRevision: 1,
    };
    const rejected: MediaCommandAck = {
      ...accepted,
      accepted: false,
      code: "GROUP_REVISION_CONFLICT",
      groupRevision: 2,
      roomMediaRevision: 2,
    };
    socket.emitWithAck.mockResolvedValueOnce(accepted).mockResolvedValueOnce(rejected);

    await expect(transport.sendMediaCommand(mediaCommand)).resolves.toEqual(accepted);
    await expect(
      transport.sendMediaCommand({
        ...mediaCommand,
        privateUrl: "https://private.example/watch",
      } as never),
    ).rejects.toThrow();
    await expect(transport.sendMediaCommand(mediaCommand)).resolves.toEqual(rejected);
    expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
    expect(socket.emitWithAck).toHaveBeenNthCalledWith(1, "media.command", mediaCommand);
  });

  it("validates heartbeats and publishes them as volatile latest-state messages", () => {
    const { socket, transport } = createConnectedTransport();
    expect(transport.publishMediaHeartbeat(mediaHeartbeat)).toBeUndefined();
    expect(() =>
      transport.publishMediaHeartbeat({
        ...mediaHeartbeat,
        positionMs: mediaTarget.durationMs + 1,
      }),
    ).toThrow();
    expect(socket.volatileReads).toBe(1);
    expect(socket.emitted).toContainEqual({
      event: "media.heartbeat",
      args: [mediaHeartbeat],
    });
    expect(socket.emitWithAck).not.toHaveBeenCalled();
  });

  it("removes media listeners on disconnect", async () => {
    const { socket, transport } = createConnectedTransport();
    const handler = vi.fn();
    transport.setMediaHandler(handler);

    await transport.disconnect();
    socket.emit("media.groups.snapshot", mediaSnapshot);

    expect(socket.removeAllListeners).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("SocketReplicaTransport page collaboration channels", () => {
  it("strictly validates reliable annotation sync, submit, and danmaku acknowledgements", async () => {
    const { socket, transport } = createConnectedTransport();
    socket.emitWithAck
      .mockResolvedValueOnce(annotationSnapshot)
      .mockResolvedValueOnce(annotationAck)
      .mockResolvedValueOnce(danmakuAck);

    await expect(transport.synchronizeAnnotations(annotationSyncRequest)).resolves.toEqual(
      annotationSnapshot,
    );
    await expect(transport.submitAnnotation(annotationSubmit)).resolves.toEqual(annotationAck);
    await expect(transport.sendDanmaku(danmakuSend)).resolves.toEqual(danmakuAck);
    expect(socket.volatileReads).toBe(1);

    expect(socket.emitWithAck).toHaveBeenNthCalledWith(1, "annotation.sync", annotationSyncRequest);
    expect(socket.emitWithAck).toHaveBeenNthCalledWith(2, "annotation.submit.v2", annotationSubmit);
    expect(socket.emitWithAck).toHaveBeenNthCalledWith(3, "danmaku.send", danmakuSend);

    const authoritativePageMismatch = {
      type: "annotation.ack.v2",
      protocolVersion: 1,
      clientOpId: annotationSubmit.clientOpId,
      roomId: ROOM_ID,
      accepted: false,
      code: "PAGE_MISMATCH",
      pageKey: "B".repeat(43),
      annotationSeq: null,
      results: [],
    } as const;
    socket.emitWithAck.mockResolvedValueOnce(authoritativePageMismatch);
    await expect(transport.submitAnnotation(annotationSubmit)).resolves.toEqual(
      authoritativePageMismatch,
    );

    socket.emitWithAck.mockResolvedValueOnce({
      ...annotationAck,
      pageKey: "private-url",
    });
    await expect(transport.submitAnnotation(annotationSubmit)).rejects.toMatchObject({
      code: "PROTOCOL_FAILURE",
    } satisfies Partial<SocketReplicaTransportError>);

    socket.emitWithAck.mockResolvedValueOnce({
      ...annotationAck,
      clientOpId: "70000000-0000-4000-8000-000000000002",
    });
    await expect(transport.submitAnnotation(annotationSubmit)).rejects.toMatchObject({
      code: "PROTOCOL_FAILURE",
    } satisfies Partial<SocketReplicaTransportError>);

    socket.emitWithAck.mockResolvedValueOnce({
      ...annotationAck,
      pageKey: "B".repeat(43),
    });
    await expect(transport.submitAnnotation(annotationSubmit)).rejects.toMatchObject({
      code: "PROTOCOL_FAILURE",
    } satisfies Partial<SocketReplicaTransportError>);

    socket.emitWithAck.mockResolvedValueOnce({
      ...danmakuAck,
      messageId: "a0000000-0000-4000-8000-000000000002",
    });
    await expect(transport.sendDanmaku(danmakuSend)).rejects.toMatchObject({
      code: "PROTOCOL_FAILURE",
    } satisfies Partial<SocketReplicaTransportError>);
  });

  it("uses replaceable non-ACK preview events and parses each inbound family strictly", async () => {
    const { socket, transport } = createConnectedTransport();
    const annotationHandler = vi.fn();
    const danmakuHandler = vi.fn();
    const previewHandler = vi.fn();
    transport.setAnnotationHandler(annotationHandler);
    transport.setDanmakuHandler(danmakuHandler);
    transport.setStrokePreviewHandler(previewHandler);

    await transport.publishStrokePreview(previewUpdate);
    await transport.clearStrokePreview(previewClear);
    expect(socket.volatileReads).toBe(2);
    expect(socket.emitted).toContainEqual({
      event: "stroke.preview.update",
      args: [previewUpdate],
    });
    expect(socket.emitted).toContainEqual({
      event: "stroke.preview.clear",
      args: [previewClear],
    });

    socket.emit("annotation.snapshot.v2", annotationSnapshot);
    socket.emit("annotation.committed.v2", annotationCommitted);
    socket.emit("danmaku.event", danmakuEvent);
    socket.emit("stroke.preview.event", previewEvent);
    socket.emit("stroke.preview.clear", previewClearMessage);
    socket.emit("annotation.committed.v2", {
      ...annotationCommitted,
      privatePageUrl: "https://private.example/",
    });
    socket.emit("danmaku.event", {
      ...danmakuEvent,
      expiresAtServerMs: 20_000,
    });
    socket.emit("stroke.preview.event", {
      ...previewEvent,
      points: [{ x: 2, y: 0.2, pressure: 0.5 }],
    });

    expect(annotationHandler.mock.calls).toEqual([[annotationSnapshot], [annotationCommitted]]);
    expect(danmakuHandler.mock.calls).toEqual([[danmakuEvent]]);
    expect(previewHandler.mock.calls).toEqual([[previewEvent], [previewClearMessage]]);
  });

  it("fails collaboration ephemera locally while disconnected instead of buffering for reconnect", async () => {
    const { socket, transport } = createConnectedTransport();
    socket.emitted.length = 0;
    socket.connected = false;

    await expect(transport.sendDanmaku(danmakuSend)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
    } satisfies Partial<SocketReplicaTransportError>);
    await expect(transport.publishStrokePreview(previewUpdate)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
    } satisfies Partial<SocketReplicaTransportError>);
    await expect(transport.clearStrokePreview(previewClear)).rejects.toMatchObject({
      code: "TRANSPORT_FAILURE",
    } satisfies Partial<SocketReplicaTransportError>);

    expect(socket.emitWithAck).not.toHaveBeenCalled();
    expect(socket.emitted).toEqual([]);
  });

  it("clears collaboration handlers on explicit disconnect before a later reconnect", async () => {
    const { transport } = createConnectedTransport();
    const annotationHandler = vi.fn();
    const danmakuHandler = vi.fn();
    const previewHandler = vi.fn();
    transport.setAnnotationHandler(annotationHandler);
    transport.setDanmakuHandler(danmakuHandler);
    transport.setStrokePreviewHandler(previewHandler);

    await transport.disconnect();
    const replacement = new FakeSocket();
    vi.mocked(io).mockReturnValue(replacement as never);
    await transport.connect({
      onCommitted: vi.fn(),
      onDisconnect: vi.fn(),
      onReconnect: vi.fn(),
    });
    replacement.emit("annotation.snapshot.v2", annotationSnapshot);
    replacement.emit("danmaku.event", danmakuEvent);
    replacement.emit("stroke.preview.event", previewEvent);

    expect(annotationHandler).not.toHaveBeenCalled();
    expect(danmakuHandler).not.toHaveBeenCalled();
    expect(previewHandler).not.toHaveBeenCalled();
  });
});
