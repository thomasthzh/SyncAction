import {
  DanmakuAckSchema,
  DanmakuEventMessageSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  RoomSnapshotStateSchema,
  type DanmakuAck,
  type DanmakuEventMessage,
  type DanmakuSend,
} from "@syncaction/protocol";
import { ReplicaRecordSchema, type ReplicaRecord } from "@syncaction/replica";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DanmakuController, type DanmakuControllerPagePort } from "../src/danmaku-controller.js";
import {
  SocketReplicaTransportError,
  type CollaborationTransport,
  type DanmakuMessageHandler,
} from "../src/socket-transport.js";
import type {
  CollaborationPageContext,
  DanmakuSubmitMessage,
} from "../src/page-collaboration/messages.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789e01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789e02");
const browserSessionId = "018f8f8e-4b5c-7d6e-8f90-123456789e03";
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789e04";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789e05");
const messageId = "018f8f8e-4b5c-7d6e-8f90-123456789e06";
const now = 1_785_130_000_000;

const context: CollaborationPageContext = {
  roomId,
  logicalTabId,
  documentRevision: {
    roomEpoch: 3,
    tabUpdatedAtSeq: 7,
  },
  frameKey: "top",
};
const childFrameKey = "frame:sha256-0123456789abcdef0123456789abcdef" as const;
const childContext: CollaborationPageContext = {
  ...context,
  frameKey: childFrameKey,
};

function record(overrides: { mode?: ReplicaRecord["mode"]; tabUpdatedAtSeq?: number } = {}) {
  const snapshot = RoomSnapshotStateSchema.parse({
    roomId,
    roomEpoch: 3,
    serverSeq: 9,
    order: [logicalTabId],
    tabs: [
      {
        id: logicalTabId,
        url: "https://example.com/watch",
        title: "Watch",
        favIconUrl: null,
        createdAtSeq: 1,
        updatedAtSeq: overrides.tabUpdatedAtSeq ?? 7,
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
        tabId: 11,
        windowId: 1,
        groupId: 2,
        browserSessionId,
        validatedAtServerSeq: 9,
      },
    ],
    quarantineReason: null,
    updatedAtMs: now,
  });
}

function submission(overrides: Partial<DanmakuSubmitMessage> = {}): DanmakuSubmitMessage {
  return {
    type: "syncaction.danmaku.submit",
    controller: "danmaku",
    context,
    messageId,
    text: "一起看",
    ...overrides,
  };
}

class FakeTransport implements Pick<CollaborationTransport, "setDanmakuHandler" | "sendDanmaku"> {
  public handler: DanmakuMessageHandler | undefined;
  public readonly sent: DanmakuSend[] = [];
  public implementation: ((message: DanmakuSend) => Promise<DanmakuAck>) | undefined;

  public setDanmakuHandler(handler: DanmakuMessageHandler | undefined): void {
    this.handler = handler;
  }

  public async sendDanmaku(message: DanmakuSend): Promise<DanmakuAck> {
    this.sent.push(structuredClone(message));
    if (this.implementation !== undefined) {
      return this.implementation(message);
    }
    return DanmakuAckSchema.parse({
      type: "danmaku.ack",
      protocolVersion: 1,
      messageId: message.messageId,
      roomId,
      accepted: true,
      code: null,
      sentAtServerMs: now,
      expiresAtServerMs: now + 9_000,
    });
  }

  public emit(message: DanmakuEventMessage): void {
    this.handler?.(message);
  }
}

class FakePage implements DanmakuControllerPagePort {
  public readonly statuses: Array<{
    tabId: number;
    context: CollaborationPageContext;
    status: "IDLE" | "SENDING" | "SENT" | "FAILED";
    messageId: string | null;
    errorCode: string | null;
  }> = [];
  public readonly rendered: Array<{
    tabId: number;
    context: CollaborationPageContext;
    event: DanmakuEventMessage;
  }> = [];
  public readonly cleared: Array<{ tabId: number; context: CollaborationPageContext }> = [];

  public async setDanmakuStatus(
    tabId: number,
    pageContext: CollaborationPageContext,
    status: {
      status: "IDLE" | "SENDING" | "SENT" | "FAILED";
      messageId: string | null;
      errorCode: string | null;
    },
  ): Promise<void> {
    this.statuses.push({
      tabId,
      context: structuredClone(pageContext),
      ...status,
    });
  }

  public async renderDanmaku(
    tabId: number,
    pageContext: CollaborationPageContext,
    event: DanmakuEventMessage,
  ): Promise<void> {
    this.rendered.push({
      tabId,
      context: structuredClone(pageContext),
      event: structuredClone(event),
    });
  }

  public async clearDanmaku(tabId: number, pageContext: CollaborationPageContext): Promise<void> {
    this.cleared.push({ tabId, context: structuredClone(pageContext) });
  }
}

let currentRecord: ReplicaRecord;
let transport: FakeTransport;
let page: FakePage;
let controller: DanmakuController;

beforeEach(async () => {
  currentRecord = record();
  transport = new FakeTransport();
  page = new FakePage();
  controller = new DanmakuController({
    roomId,
    browserSessionId,
    replica: { getRecord: async () => currentRecord },
    transport,
    page,
  });
  await controller.handlePageReady(11, 0, "top");
});

describe("DanmakuController exact routing", () => {
  it("accepts runtime state only from the exact active top document", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    await controller.handlePageReady(11, 3, childFrameKey);

    await controller.handlePageReport(11, 0, {
      type: "syncaction.danmaku.report",
      controller: "danmaku",
      context,
      hidden: true,
      inputOpen: true,
    });
    expect(controller.getStatus()).toMatchObject({
      hidden: true,
      inputOpen: true,
    });

    await controller.handlePageReport(11, 3, {
      type: "syncaction.danmaku.report",
      controller: "danmaku",
      context: childContext,
      hidden: false,
      inputOpen: false,
    });
    expect(controller.getStatus()).toMatchObject({
      hidden: true,
      inputOpen: true,
    });

    await controller.handleActiveTabChanged(12);
    expect(controller.getStatus().inputOpen).toBe(false);
  });

  it("blocks only relevant page capability failures and recovers exactly", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    expect(controller.getStatus().ready).toBe(true);

    await controller.handlePageCapability({
      tabId: 11,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DRAWING",
        state: "DEGRADED",
        errorCode: "DRAWING_RUNTIME_FAILED",
      },
    });
    expect(controller.getStatus().ready).toBe(true);

    await controller.handlePageCapability({
      tabId: 11,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DANMAKU",
        state: "DEGRADED",
        errorCode: "DANMAKU_RUNTIME_FAILED",
      },
    });
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      ready: false,
      canRetry: true,
      errorCode: "DANMAKU_RUNTIME_FAILED",
    });
    expect(controller.canRetryFor(11, context)).toBe(true);
    expect(controller.getStatus().ready).toBe(false);
    await controller.handleSubmit(11, 0, submission());
    expect(transport.sent).toEqual([]);

    await controller.handlePageCapability({
      tabId: 11,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DANMAKU",
        state: "AVAILABLE",
        errorCode: null,
      },
    });
    expect(controller.getStatus()).toMatchObject({
      state: "ONLINE",
      ready: true,
      canRetry: false,
      errorCode: null,
    });

    await controller.handlePageCapability({
      tabId: 11,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PAGE_HOST_CONFLICT",
      },
    });
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      ready: false,
      canRetry: false,
      errorCode: "PAGE_HOST_CONFLICT",
    });
  });

  it("marks the old route not ready synchronously while a binding refresh is deferred", async () => {
    let resolveRefresh: ((value: ReplicaRecord) => void) | undefined;
    const deferred = new Promise<ReplicaRecord>((resolve) => {
      resolveRefresh = resolve;
    });
    let reads = 0;
    controller = new DanmakuController({
      roomId,
      browserSessionId,
      replica: {
        getRecord: async () => {
          reads += 1;
          return reads === 1 ? currentRecord : deferred;
        },
      },
      transport,
      page,
    });
    await controller.handlePageReady(11, 0, "top", 2);
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    expect(controller.getStatus().ready).toBe(true);

    const refreshing = controller.handleBindingsChanged();
    expect(controller.getStatus().ready).toBe(false);
    expect(controller.isReadyFor(11, context)).toBe(false);
    await vi.waitFor(() => expect(page.cleared).toContainEqual({ tabId: 11, context }));
    resolveRefresh?.(record({ tabUpdatedAtSeq: 8 }));
    await refreshing;

    expect(controller.getStatus().ready).toBe(true);
    expect(
      controller.isReadyFor(11, {
        ...context,
        documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 8 },
      }),
    ).toBe(true);
  });

  it("reports not-ready state and rejects an attributable submit when no binding resolves", async () => {
    currentRecord = record({ mode: "RECOVERING" });
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "DANMAKU_NOT_READY",
      ready: false,
    });
    await controller.handleSubmit(11, 0, submission());

    expect(transport.sent).toEqual([]);
    expect(page.statuses).toContainEqual({
      tabId: 11,
      context,
      status: "FAILED",
      messageId,
      errorCode: "DOCUMENT_UNAUTHORIZED",
    });
  });

  it("sends only from the exact active binding, revision, and top frame", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    await controller.handleSubmit(11, 0, submission());
    await controller.handleSubmit(
      11,
      0,
      submission({
        context: {
          ...context,
          documentRevision: { ...context.documentRevision, tabUpdatedAtSeq: 8 },
        },
      }),
    );
    await controller.handleSubmit(
      11,
      1,
      submission({
        context: { ...context, frameKey: "frame:sha256-0123456789abcdef0123456789abcdef" },
      }),
    );

    expect(transport.sent).toEqual([
      {
        type: "danmaku.send",
        protocolVersion: 1,
        messageId,
        ...context,
        text: "一起看",
      },
    ]);
    expect(page.statuses.map((status) => status.status)).toEqual([
      "SENDING",
      "SENT",
      "FAILED",
      "FAILED",
    ]);
    expect(controller.getStatus().ready).toBe(true);
  });

  it("sends and renders through an authorized exact child-frame route", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    await controller.handlePageReady(11, 3, childFrameKey);

    await controller.handleSubmit(11, 3, submission({ context: childContext }));
    const event = DanmakuEventMessageSchema.parse({
      type: "danmaku.event",
      protocolVersion: 1,
      messageId,
      ...childContext,
      sender: {
        userId,
        username: "member",
        displayName: "Member",
        deviceId,
      },
      text: "子页面",
      sentAtServerMs: now,
      expiresAtServerMs: now + 9_000,
    });
    transport.emit(event);
    await controller.whenIdle();

    expect(transport.sent).toMatchObject([{ ...childContext, text: "一起看" }]);
    expect(page.rendered).toEqual([{ tabId: 11, context: childContext, event }]);
  });

  it("preserves child-frame degradation after a successful top send", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    await controller.handlePageReady(11, 3, childFrameKey);
    await controller.handlePageUnavailable(11, 3, childFrameKey);

    await controller.handleSubmit(11, 0, submission());

    expect(transport.sent).toHaveLength(1);
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      ready: true,
      errorCode: "PAGE_TOOL_PERMISSION_REQUIRED",
    });

    await controller.handlePageReady(11, 3, childFrameKey);
    expect(controller.getStatus().errorCode).toBeNull();
  });

  it("drops an old child route when a replacement top document becomes ready", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    await controller.handlePageReady(11, 3, childFrameKey);

    await controller.handlePageReady(11, 0, "top", 2);
    await controller.handleSubmit(11, 3, submission({ context: childContext }));

    expect(page.cleared.some((entry) => entry.context.frameKey === childFrameKey)).toBe(true);
    expect(transport.sent).toEqual([]);
  });

  it("keeps a new child that reports before the replacement top document", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    await controller.handlePageReady(11, 3, childFrameKey, 1);

    await controller.handlePageReady(11, 3, childFrameKey, 2);
    await controller.handlePageReady(11, 0, "top", 2);
    await controller.handleSubmit(11, 3, submission({ context: childContext }));

    expect(transport.sent).toMatchObject([{ ...childContext, text: "一起看" }]);
    expect(page.cleared.some((entry) => entry.context.frameKey === childFrameKey)).toBe(true);
  });

  it("renders only matching live events on the currently bound page", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    const event = DanmakuEventMessageSchema.parse({
      type: "danmaku.event",
      protocolVersion: 1,
      messageId,
      ...context,
      sender: {
        userId,
        username: "member",
        displayName: "Member",
        deviceId,
      },
      text: "一起看",
      sentAtServerMs: now,
      expiresAtServerMs: now + 9_000,
    });

    transport.emit(event);
    transport.emit({
      ...event,
      documentRevision: { ...event.documentRevision, tabUpdatedAtSeq: 8 },
    });
    await controller.whenIdle();

    expect(page.rendered).toEqual([{ tabId: 11, context, event }]);
  });
});

describe("DanmakuController failure lifecycle", () => {
  it("stays permission-blocked across an offline reconnect until fresh top ready", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    await controller.setSynchronized(false);
    await controller.handlePermissionBoundaryChanged();

    await controller.setSynchronized(true);
    await controller.handleActiveTabChanged(11);
    await controller.handleSubmit(11, 0, submission());

    expect(transport.sent).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      ready: false,
      errorCode: "PAGE_TOOL_PERMISSION_REQUIRED",
    });

    await controller.handlePageReady(11, 0, "top");
    await controller.handleSubmit(11, 0, submission());

    expect(transport.sent).toHaveLength(1);
    expect(controller.getStatus().ready).toBe(true);
  });

  it("releases a page submission that disconnects while its acknowledgement is pending", async () => {
    let rejectSend: ((cause: Error) => void) | undefined;
    transport.implementation = () =>
      new Promise<DanmakuAck>((_resolve, reject) => {
        rejectSend = reject;
      });
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    const submitting = controller.handleSubmit(11, 0, submission());
    await vi.waitFor(() => expect(page.statuses.at(-1)?.status).toBe("SENDING"));
    const disconnecting = controller.setSynchronized(false);
    rejectSend?.(new SocketReplicaTransportError("TRANSPORT_FAILURE"));
    await Promise.all([submitting, disconnecting]);
    await controller.setSynchronized(true);

    expect(transport.sent).toHaveLength(1);
    expect(page.statuses).toMatchObject([
      { status: "SENDING", messageId, errorCode: null },
      { status: "FAILED", messageId, errorCode: "DANMAKU_OFFLINE" },
    ]);
  });

  it("fails a queued pre-disconnect submission instead of sending it after reconnect", async () => {
    let rejectFirst: ((cause: Error) => void) | undefined;
    transport.implementation = () =>
      new Promise<DanmakuAck>((_resolve, reject) => {
        rejectFirst = reject;
      });
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    const first = controller.handleSubmit(11, 0, submission());
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    const secondMessageId = "018f8f8e-4b5c-7d6e-8f90-123456789e07";
    const second = controller.handleSubmit(11, 0, submission({ messageId: secondMessageId }));
    const disconnecting = controller.setSynchronized(false);
    const reconnecting = controller.setSynchronized(true);
    rejectFirst?.(new SocketReplicaTransportError("TRANSPORT_FAILURE"));
    await Promise.all([first, second, disconnecting, reconnecting]);
    await controller.whenIdle();

    expect(transport.sent).toHaveLength(1);
    expect(page.statuses).toContainEqual({
      tabId: 11,
      context,
      status: "FAILED",
      messageId: secondMessageId,
      errorCode: "DANMAKU_OFFLINE",
    });
  });

  it("labels a queued submit invalidated by a binding refresh as stale, not offline", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    const submitting = controller.handleSubmit(11, 0, submission());
    currentRecord = record({ tabUpdatedAtSeq: 8 });
    const refreshing = controller.handleBindingsChanged();
    await Promise.all([submitting, refreshing]);

    expect(transport.sent).toEqual([]);
    expect(page.statuses).toContainEqual({
      tabId: 11,
      context,
      status: "FAILED",
      messageId,
      errorCode: "DOCUMENT_UNAUTHORIZED",
    });
  });

  it("does not render a blocked acknowledgement after the durable document revision advances", async () => {
    let resolveSend: ((acknowledgement: DanmakuAck) => void) | undefined;
    transport.implementation = () =>
      new Promise<DanmakuAck>((resolve) => {
        resolveSend = resolve;
      });
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    const submitting = controller.handleSubmit(11, 0, submission());
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    currentRecord = record({ tabUpdatedAtSeq: 8 });
    const refreshing = controller.handleBindingsChanged();
    resolveSend?.(
      DanmakuAckSchema.parse({
        type: "danmaku.ack",
        protocolVersion: 1,
        messageId,
        roomId,
        accepted: true,
        code: null,
        sentAtServerMs: now,
        expiresAtServerMs: now + 9_000,
      }),
    );
    await Promise.all([submitting, refreshing]);

    expect(page.statuses.map((status) => status.status)).toEqual(["SENDING"]);
    expect(page.cleared).toContainEqual({ tabId: 11, context });
  });

  it("reports an offline send once, retains the same message ID, and never retries it", async () => {
    transport.implementation = vi
      .fn()
      .mockRejectedValue(new SocketReplicaTransportError("TRANSPORT_FAILURE"));
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    await controller.handleSubmit(11, 0, submission());
    await controller.setSynchronized(false);
    await controller.setSynchronized(true);
    await controller.whenIdle();

    expect(transport.sent).toHaveLength(1);
    expect(page.statuses).toMatchObject([
      { status: "SENDING", messageId, errorCode: null },
      { status: "FAILED", messageId, errorCode: "DANMAKU_OFFLINE" },
    ]);
  });

  it("preserves an authorization error and does not misreport a local failure as offline", async () => {
    transport.implementation = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("DOCUMENT_UNAUTHORIZED"), {
          code: "DOCUMENT_UNAUTHORIZED",
        }),
      )
      .mockRejectedValueOnce(new Error("local decode bug"));
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    await controller.handleSubmit(11, 0, submission());
    await controller.handleSubmit(
      11,
      0,
      submission({ messageId: "018f8f8e-4b5c-7d6e-8f90-123456789e07" }),
    );

    expect(page.statuses.slice(-2)).toMatchObject([
      {
        status: "SENDING",
        messageId: "018f8f8e-4b5c-7d6e-8f90-123456789e07",
        errorCode: null,
      },
      {
        status: "FAILED",
        messageId: "018f8f8e-4b5c-7d6e-8f90-123456789e07",
        errorCode: "INVALID_DANMAKU_MESSAGE",
      },
    ]);
    expect(page.statuses[1]).toMatchObject({
      status: "FAILED",
      messageId,
      errorCode: "DOCUMENT_UNAUTHORIZED",
    });
  });

  it("rejects a schema-valid acknowledgement for another message", async () => {
    transport.implementation = async () =>
      DanmakuAckSchema.parse({
        type: "danmaku.ack",
        protocolVersion: 1,
        messageId: "018f8f8e-4b5c-7d6e-8f90-123456789e07",
        roomId,
        accepted: true,
        code: null,
        sentAtServerMs: now,
        expiresAtServerMs: now + 9_000,
      });
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    await controller.handleSubmit(11, 0, submission());

    expect(page.statuses.at(-1)).toMatchObject({
      status: "FAILED",
      messageId,
      errorCode: "INVALID_DANMAKU_MESSAGE",
    });
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "INVALID_DANMAKU_MESSAGE",
    });
  });

  it("fails a submission immediately while disconnected and does not queue it for reconnect", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);
    await controller.setSynchronized(false);

    await controller.handleSubmit(11, 0, submission());
    await controller.setSynchronized(true);
    await controller.whenIdle();

    expect(transport.sent).toEqual([]);
    expect(page.statuses).toMatchObject([
      { status: "FAILED", messageId, errorCode: "DANMAKU_OFFLINE" },
    ]);
  });

  it("clears the prior page before a permission boundary and stops stale rendering", async () => {
    await controller.handleActiveTabChanged(11);
    await controller.setSynchronized(true);

    await controller.handlePermissionBoundaryChanged();
    transport.emit(
      DanmakuEventMessageSchema.parse({
        type: "danmaku.event",
        protocolVersion: 1,
        messageId,
        ...context,
        sender: {
          userId,
          username: "member",
          displayName: "Member",
          deviceId,
        },
        text: "stale",
        sentAtServerMs: now,
        expiresAtServerMs: now + 9_000,
      }),
    );
    await controller.whenIdle();

    expect(page.cleared).toEqual([{ tabId: 11, context }]);
    expect(page.rendered).toEqual([]);
    expect(controller.getStatus()).toMatchObject({
      state: "DEGRADED",
      errorCode: "PAGE_TOOL_PERMISSION_REQUIRED",
    });
  });
});
