import {
  AnnotationAckV2Schema as AnnotationAckSchema,
  AnnotationCommittedOperationV2Schema as AnnotationCommittedOperationSchema,
  AnnotationSnapshotV2MessageSchema as AnnotationSnapshotMessageSchema,
  DanmakuEventMessageSchema,
  MediaTargetSchema,
  PageCompatibilityReportSchema,
  PointerRecordSchema,
  RoomIdSchema,
  StrokePreviewClearMessageSchema,
  StrokePreviewEventMessageSchema,
  canonicalSharedPageIdentity,
} from "@syncaction/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChromePageCollaborationPort,
  isProtectedPageUrl,
  originPatternForUrl,
  type ChromiumPageCollaborationApi,
  type RegisteredPageContentScript,
} from "../src/page-collaboration/chrome-page-port.js";
import {
  PAGE_COLLABORATION_MESSAGE_TYPES,
  PageCollaborationMessageSchema,
  isPageControllerMessage,
  parsePageOutboundMessageFromSender,
} from "../src/page-collaboration/messages.js";
import type { PointerPageContext } from "../src/pointer-controller.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b01");
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789b02";
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789b03";
const deviceId = "018f8f8e-4b5c-7d6e-8f90-123456789b04";

const context: PointerPageContext = {
  roomId,
  logicalTabId: logicalTabId as PointerPageContext["logicalTabId"],
  documentRevision: { roomEpoch: 2, tabUpdatedAtSeq: 4 },
};

const pointer = PointerRecordSchema.parse({
  userId,
  username: "remote",
  displayName: "Remote",
  deviceId,
  color: "#22c55e",
  logicalTabId,
  documentRevision: context.documentRevision,
  anchor: {
    path: [{ tagName: "main", nthOfType: 1 }],
    x: 0.25,
    y: 0.75,
  },
  viewport: { x: 0.4, y: 0.6 },
  expiresAt: 1_785_150_003_000,
});

const mediaTarget = MediaTargetSchema.parse({
  logicalTabId,
  documentRevision: context.documentRevision,
  frameKey: "top",
  provider: "YOUTUBE",
  mediaKey: "youtube:dQw4w9WgXcQ",
  durationMs: 212_000,
});

const mediaObserved = {
  observedAtClientMs: 1_785_150_000_000,
  positionMs: 42_000,
  paused: false,
  playbackRate: 1,
  ended: false,
  buffering: false,
};

const exactContext = {
  ...context,
  frameKey: "top" as const,
};
const childFrameKey = "frame:sha256-0123456789abcdef0123456789abcdef" as const;
const childContext = {
  ...context,
  frameKey: childFrameKey,
};
const pageKey = "A".repeat(43);
const clientOpId = "018f8f8e-4b5c-7d6e-8f90-123456789b05";
const strokeId = "018f8f8e-4b5c-7d6e-8f90-123456789b06";
const previewId = "018f8f8e-4b5c-7d6e-8f90-123456789b07";
const messageId = "018f8f8e-4b5c-7d6e-8f90-123456789b08";
const annotationAnchor = {
  type: "document" as const,
  layoutSignature: { widthCssPx: 1_440, heightCssPx: 5_000 },
};
const annotationPoints = [
  { x: 0.1, y: 0.2, pressure: 0.5 },
  { x: 0.2, y: 0.3, pressure: 0.7 },
];
const annotationRgb = { r: 31, g: 140, b: 255 };
const unsignedStrokeDraft = {
  strokeId,
  frameKey: "top",
  anchor: annotationAnchor,
  points: annotationPoints,
  rgb: annotationRgb,
  width: 5,
};
const contentSignature = {
  signatureVersion: 1,
  digest: "S".repeat(43),
};
const strokeDraft = {
  ...unsignedStrokeDraft,
  contentSignature,
};
const annotationOperation = {
  type: "stroke.create" as const,
  stroke: strokeDraft,
};
const annotationCommitted = {
  type: "annotation.committed.v2" as const,
  protocolVersion: 1 as const,
  clientOpId,
  roomId,
  pageKey,
  annotationSeq: 1,
  actorUserId: userId,
  operation: annotationOperation,
  results: [{ strokeId, accepted: true as const, code: null, version: 1 }],
  createdAtServerMs: 1_785_150_000_000,
};
const previewUpdate = {
  type: "stroke.preview.update" as const,
  protocolVersion: 1 as const,
  previewId,
  ...exactContext,
  anchor: annotationAnchor,
  points: annotationPoints,
  rgb: annotationRgb,
  width: 5,
};

class FakeApi implements ChromiumPageCollaborationApi {
  public granted = false;
  public readonly grantedOrigins = new Set<string>();
  public readonly trace: string[] = [];
  public readonly executions: unknown[] = [];
  public readonly registeredScripts: RegisteredPageContentScript[] = [];
  public readonly containsCalls: string[][] = [];
  public readonly messages: Array<{ tabId: number; message: unknown; options: unknown }> = [];
  public executeImplementation:
    ChromiumPageCollaborationApi["scripting"]["executeScript"] | undefined;
  public queryImplementation: ChromiumPageCollaborationApi["tabs"]["query"] | undefined;
  public sendImplementation: ChromiumPageCollaborationApi["tabs"]["sendMessage"] | undefined;
  public permissionRemovedListener:
    ((permissions: { origins?: string[] | undefined }) => void) | undefined;
  public permissionAddedListener:
    ((permissions: { origins?: string[] | undefined }) => void) | undefined;
  public tabsById = new Map<number, { id: number; url?: string; pendingUrl?: string }>([
    [7, { id: 7, url: "https://example.com/article?private=1" }],
  ]);

  public readonly tabs: ChromiumPageCollaborationApi["tabs"] = {
    get: async (tabId) => {
      const tab = this.tabsById.get(tabId);
      if (tab === undefined) {
        throw new Error("TAB_NOT_FOUND");
      }
      return tab;
    },
    query: async (query) =>
      this.queryImplementation === undefined
        ? [...this.tabsById.values()]
        : this.queryImplementation(query),
    sendMessage: async (tabId, message, options) => {
      this.trace.push(`message:${String(tabId)}:${readType(message)}`);
      this.messages.push({ tabId, message, options });
      if (this.sendImplementation !== undefined) {
        return this.sendImplementation(tabId, message, options);
      }
      return availableToolResponse(message);
    },
  };

  public readonly permissions: ChromiumPageCollaborationApi["permissions"] = {
    contains: async ({ origins }) => {
      this.containsCalls.push([...origins]);
      return this.granted || origins.every((origin) => this.grantedOrigins.has(origin));
    },
    remove: async ({ origins }) => {
      this.trace.push(`remove:${origins.join(",")}`);
      this.granted = false;
      for (const origin of origins) {
        this.grantedOrigins.delete(origin);
      }
      return true;
    },
    getAll: async () => ({
      origins: this.granted ? ["https://example.com/*"] : [...this.grantedOrigins],
    }),
    onAdded: {
      addListener: (listener) => {
        this.permissionAddedListener = listener;
      },
    },
    onRemoved: {
      addListener: (listener) => {
        this.permissionRemovedListener = listener;
      },
    },
  };

  public readonly scripting: ChromiumPageCollaborationApi["scripting"] = {
    executeScript: async (details) => {
      this.executions.push(details);
      if (this.executeImplementation !== undefined) {
        return this.executeImplementation(details);
      }
      return [
        {
          frameId: details.target.frameIds[0]!,
          documentId: `document-${String(this.executions.length)}`,
        },
      ];
    },
    getRegisteredContentScripts: async () => structuredClone(this.registeredScripts),
    registerContentScripts: async (scripts) => {
      this.registeredScripts.push(...structuredClone(scripts));
    },
    updateContentScripts: async (scripts) => {
      for (const script of scripts) {
        const index = this.registeredScripts.findIndex((candidate) => candidate.id === script.id);
        if (index < 0) {
          throw new Error("SCRIPT_NOT_REGISTERED");
        }
        this.registeredScripts[index] = {
          ...this.registeredScripts[index],
          ...structuredClone(script),
        };
      }
    },
    unregisterContentScripts: async ({ ids }) => {
      for (const id of ids ?? []) {
        const index = this.registeredScripts.findIndex((candidate) => candidate.id === id);
        if (index >= 0) {
          this.registeredScripts.splice(index, 1);
        }
      }
    },
  };

  public addPermissions(origins: string[]): void {
    for (const origin of origins) {
      this.grantedOrigins.add(origin);
    }
    this.permissionAddedListener?.({ origins });
  }

  public removePermissions(origins: string[]): void {
    this.granted = false;
    for (const origin of origins) {
      this.grantedOrigins.delete(origin);
    }
    this.permissionRemovedListener?.({ origins });
  }
}

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

describe("page collaboration message contract", () => {
  it("defines the exact strict namespaced message list", () => {
    expect(PAGE_COLLABORATION_MESSAGE_TYPES).toEqual([
      "syncaction.page.announce",
      "syncaction.page.ready",
      "syncaction.page.capability",
      "page.compatibility.report",
      "syncaction.command.ready",
      "syncaction.pointer.context",
      "syncaction.pointer.lease",
      "syncaction.pointer.frame",
      "syncaction.pointer.render",
      "syncaction.pointer.clear",
      "syncaction.pointer.sample",
      "syncaction.media.command",
      "syncaction.media.observed",
      "syncaction.media.prompt",
      "syncaction.danmaku.command",
      "syncaction.danmaku.render",
      "syncaction.danmaku.status",
      "syncaction.danmaku.clear",
      "syncaction.danmaku.submit",
      "syncaction.danmaku.report",
      "syncaction.drawing.command",
      "syncaction.drawing.state",
      "syncaction.drawing.viewer",
      "syncaction.drawing.clear",
      "syncaction.drawing.report",
      "syncaction.annotation.snapshot",
      "syncaction.annotation.delta",
      "syncaction.annotation.committed",
      "syncaction.annotation.ack",
      "syncaction.annotation.draft",
      "syncaction.annotation.draft.control",
      "syncaction.annotation.anchor-signature.request",
      "syncaction.annotation.anchor-signature.response",
      "syncaction.stroke.preview.render",
      "syncaction.stroke.preview.clear",
      "syncaction.stroke.sample",
      "syncaction.stroke.final",
      "syncaction.drawing.selection",
      "syncaction.page.dispose",
    ]);
    const candidates: Record<(typeof PAGE_COLLABORATION_MESSAGE_TYPES)[number], unknown> = {
      "syncaction.page.announce": { type: "syncaction.page.announce" },
      "syncaction.page.ready": { type: "syncaction.page.ready" },
      "syncaction.page.capability": {
        type: "syncaction.page.capability",
        capability: "PAGE_HOST",
        state: "DEGRADED",
        errorCode: "PROTECTED_PAGE",
      },
      "page.compatibility.report": {
        type: "page.compatibility.report",
        protocolVersion: 1,
        logicalTabId,
        contentContext: {
          documentRevision: context.documentRevision,
          canonicalPageIdentity: "https://example.com/article",
          contentSignature: {
            signatureVersion: 1,
            digest: "A".repeat(43),
          },
          media: null,
        },
      },
      "syncaction.command.ready": {
        type: "syncaction.command.ready",
        controller: "danmaku",
        context: exactContext,
        command: "toggle-danmaku-input",
      },
      "syncaction.pointer.context": {
        type: "syncaction.pointer.context",
        context,
      },
      "syncaction.pointer.lease": {
        type: "syncaction.pointer.lease",
        lease: {
          userId: pointer.userId,
          username: pointer.username,
          displayName: pointer.displayName,
          deviceId: pointer.deviceId,
          leaseId: "018f8f8e-4b5c-7d6e-8f90-123456789b09",
          color: pointer.color,
          logicalTabId: pointer.logicalTabId,
          documentRevision: pointer.documentRevision,
          anchor: pointer.anchor,
          expiresAt: pointer.expiresAt,
        },
      },
      "syncaction.pointer.frame": {
        type: "syncaction.pointer.frame",
        frame: {
          type: "pointer.frame",
          protocolVersion: 1,
          roomId,
          userId,
          deviceId,
          leaseId: "018f8f8e-4b5c-7d6e-8f90-123456789b09",
          seq: 1,
          xQuantized: 1_638,
          yQuantized: 2_457,
          viewport: { widthBucket: 9, heightBucket: 6 },
          receivedAtServerMs: 1_785_150_000_000,
        },
      },
      "syncaction.pointer.render": {
        type: "syncaction.pointer.render",
        pointer,
      },
      "syncaction.pointer.clear": {
        type: "syncaction.pointer.clear",
        identity: null,
      },
      "syncaction.pointer.sample": {
        type: "syncaction.pointer.sample",
        sample: {
          type: "pointer.sample",
          documentRevision: context.documentRevision,
          anchor: null,
          viewport: { x: 0.4, y: 0.6 },
        },
      },
      "syncaction.media.command": {
        type: "syncaction.media.command",
        context: exactContext,
        operation: { type: "OBSERVE" },
      },
      "syncaction.media.observed": {
        type: "syncaction.media.observed",
        event: "DISCOVERED",
        context: exactContext,
        target: mediaTarget,
        observed: mediaObserved,
        applyToken: null,
        resultCode: null,
      },
      "syncaction.media.prompt": {
        type: "syncaction.media.prompt",
        controller: "media",
        context: exactContext,
        prompt: "ALIGN_AVAILABLE",
        playbackGroupId: null,
      },
      "syncaction.danmaku.command": {
        type: "syncaction.danmaku.command",
        controller: "danmaku",
        context: exactContext,
        action: "TOGGLE_INPUT",
      },
      "syncaction.danmaku.render": {
        type: "syncaction.danmaku.render",
        controller: "danmaku",
        context: exactContext,
        event: {
          type: "danmaku.event",
          protocolVersion: 1,
          messageId,
          ...exactContext,
          sender: { userId, username: "remote", displayName: "Remote", deviceId },
          text: "<b>literal</b>",
          sentAtServerMs: 1_785_150_000_000,
          expiresAtServerMs: 1_785_150_009_000,
        },
      },
      "syncaction.danmaku.status": {
        type: "syncaction.danmaku.status",
        controller: "danmaku",
        context: exactContext,
        status: "FAILED",
        messageId,
        errorCode: "DANMAKU_RATE_LIMITED",
      },
      "syncaction.danmaku.clear": {
        type: "syncaction.danmaku.clear",
        controller: "danmaku",
        context: exactContext,
      },
      "syncaction.danmaku.submit": {
        type: "syncaction.danmaku.submit",
        controller: "danmaku",
        context: exactContext,
        messageId,
        text: "literal text",
      },
      "syncaction.drawing.command": {
        type: "syncaction.drawing.command",
        controller: "drawing",
        context: exactContext,
        action: { type: "TOGGLE_PEN" },
      },
      "syncaction.drawing.state": {
        type: "syncaction.drawing.state",
        controller: "drawing",
        context: exactContext,
        active: true,
        tool: "PEN",
        rgb: annotationRgb,
        width: 5,
      },
      "syncaction.drawing.viewer": {
        type: "syncaction.drawing.viewer",
        controller: "drawing",
        context: exactContext,
        viewer: {
          userId,
          role: "OWNER",
        },
      },
      "syncaction.drawing.clear": {
        type: "syncaction.drawing.clear",
        controller: "drawing",
        context: exactContext,
      },
      "syncaction.drawing.report": {
        type: "syncaction.drawing.report",
        controller: "drawing",
        context: exactContext,
        active: true,
        tool: "SELECT",
        rgb: { r: 12, g: 34, b: 56 },
        width: 9,
        selectedCount: 2,
        selectedLockedCount: 1,
        unlocatableCount: 2,
      },
      "syncaction.danmaku.report": {
        type: "syncaction.danmaku.report",
        controller: "danmaku",
        context: exactContext,
        hidden: true,
        inputOpen: false,
      },
      "syncaction.annotation.snapshot": {
        type: "syncaction.annotation.snapshot",
        controller: "drawing",
        context: exactContext,
        snapshot: {
          type: "annotation.snapshot.v2",
          protocolVersion: 1,
          ...exactContext,
          pageKey,
          annotationSeq: 0,
          strokes: [],
        },
      },
      "syncaction.annotation.delta": {
        type: "syncaction.annotation.delta",
        controller: "drawing",
        context: exactContext,
        delta: {
          type: "annotation.delta.v2",
          protocolVersion: 1,
          ...exactContext,
          pageKey,
          fromAnnotationSeq: 0,
          toAnnotationSeq: 1,
          operations: [annotationCommitted],
        },
      },
      "syncaction.annotation.committed": {
        type: "syncaction.annotation.committed",
        controller: "drawing",
        context: exactContext,
        committed: annotationCommitted,
      },
      "syncaction.annotation.ack": {
        type: "syncaction.annotation.ack",
        controller: "drawing",
        context: exactContext,
        acknowledgement: {
          type: "annotation.ack.v2",
          protocolVersion: 1,
          clientOpId,
          roomId,
          accepted: true,
          code: null,
          pageKey,
          annotationSeq: 1,
          results: [{ strokeId, accepted: true, code: null, version: 1 }],
        },
      },
      "syncaction.annotation.draft": {
        type: "syncaction.annotation.draft",
        controller: "drawing",
        context: exactContext,
        draft: strokeDraft,
        status: "ERROR",
        retryable: false,
      },
      "syncaction.annotation.draft.control": {
        type: "syncaction.annotation.draft.control",
        controller: "drawing",
        context: exactContext,
        action: "RETRY",
        strokeId,
      },
      "syncaction.annotation.anchor-signature.request": {
        type: "syncaction.annotation.anchor-signature.request",
        controller: "drawing",
        context: exactContext,
        path: [{ tagName: "html", nthOfType: 1 }],
      },
      "syncaction.annotation.anchor-signature.response": {
        type: "syncaction.annotation.anchor-signature.response",
        signature: contentSignature,
      },
      "syncaction.stroke.preview.render": {
        type: "syncaction.stroke.preview.render",
        controller: "drawing",
        context: exactContext,
        preview: {
          ...previewUpdate,
          type: "stroke.preview.event",
          sender: { userId, username: "remote", displayName: "Remote", deviceId },
          expiresAtServerMs: 1_785_150_003_000,
        },
      },
      "syncaction.stroke.preview.clear": {
        type: "syncaction.stroke.preview.clear",
        controller: "drawing",
        context: exactContext,
        clear: {
          type: "stroke.preview.clear",
          protocolVersion: 1,
          previewId,
          ...exactContext,
          sender: { userId, deviceId },
        },
      },
      "syncaction.stroke.sample": {
        type: "syncaction.stroke.sample",
        controller: "drawing",
        context: exactContext,
        preview: previewUpdate,
      },
      "syncaction.stroke.final": {
        type: "syncaction.stroke.final",
        controller: "drawing",
        context: exactContext,
        stroke: unsignedStrokeDraft,
      },
      "syncaction.drawing.selection": {
        type: "syncaction.drawing.selection",
        controller: "drawing",
        context: exactContext,
        action: "LOCK",
        items: [{ strokeId, expectedVersion: 1 }],
      },
      "syncaction.page.dispose": {
        type: "syncaction.page.dispose",
        reason: "BACKGROUND_STOPPED",
      },
    };
    for (const type of PAGE_COLLABORATION_MESSAGE_TYPES) {
      const candidate = candidates[type];
      expect(PageCollaborationMessageSchema.safeParse(candidate).success, type).toBe(true);
      expect(
        PageCollaborationMessageSchema.safeParse({
          ...(candidate as Record<string, unknown>),
          privateUrl: "secret",
        }).success,
        type,
      ).toBe(false);
    }
  });

  it("validates exact tab/frame senders and defaults an omitted frame to the top frame", () => {
    expect(
      parsePageOutboundMessageFromSender(
        { type: "syncaction.page.ready" },
        { tab: { id: 7 }, frameId: 3, url: "https://frame.example/player" },
      ),
    ).toEqual({
      tabId: 7,
      frameId: 3,
      documentUrl: "https://frame.example/player",
      documentId: null,
      documentLifecycle: null,
      message: { type: "syncaction.page.ready" },
    });
    expect(
      parsePageOutboundMessageFromSender(
        { type: "syncaction.page.ready" },
        { tab: { id: 7 }, url: "https://example.com/article" },
      ),
    ).toMatchObject({ tabId: 7, frameId: 0 });
    expect(() =>
      parsePageOutboundMessageFromSender(
        { type: "syncaction.pointer.sample", sample: {} },
        { tab: {}, frameId: 0 },
      ),
    ).toThrow("INVALID_PAGE_MESSAGE_SENDER");
    expect(() =>
      parsePageOutboundMessageFromSender(
        { type: "syncaction.page.ready" },
        {
          tab: { id: 7 },
          frameId: 0,
          url: "https://example.com/article",
          documentLifecycle: "cached",
        },
      ),
    ).toThrow("INVALID_PAGE_MESSAGE_SENDER");
  });

  it.each(["DISCARD", "RETRY"] as const)(
    "parses an exact %s durable draft control for background dispatch",
    (action) => {
      expect(
        parsePageOutboundMessageFromSender(
          {
            type: "syncaction.annotation.draft.control",
            controller: "drawing",
            context: exactContext,
            action,
            strokeId,
          },
          {
            tab: { id: 7 },
            frameId: 0,
            url: "https://example.com/article",
            documentId: "document-7",
            documentLifecycle: "active",
          },
        ),
      ).toMatchObject({
        tabId: 7,
        frameId: 0,
        documentId: "document-7",
        message: {
          type: "syncaction.annotation.draft.control",
          controller: "drawing",
          action,
          strokeId,
        },
      });
    },
  );

  it("rejects cross-document payloads, duplicate selection targets, and controller spoofing", () => {
    expect(
      PageCollaborationMessageSchema.safeParse({
        type: "syncaction.danmaku.render",
        controller: "danmaku",
        context: exactContext,
        event: {
          type: "danmaku.event",
          protocolVersion: 1,
          messageId,
          ...exactContext,
          documentRevision: { ...exactContext.documentRevision, tabUpdatedAtSeq: 5 },
          sender: { userId, username: "remote", displayName: "Remote", deviceId },
          text: "wrong page",
          sentAtServerMs: 1_785_150_000_000,
          expiresAtServerMs: 1_785_150_009_000,
        },
      }).success,
    ).toBe(false);
    expect(
      PageCollaborationMessageSchema.safeParse({
        type: "syncaction.stroke.final",
        controller: "drawing",
        context: exactContext,
        stroke: { ...strokeDraft, frameKey: "frame:sha256-0123456789abcdef0123456789abcdef" },
      }).success,
    ).toBe(false);
    expect(
      PageCollaborationMessageSchema.safeParse({
        type: "syncaction.drawing.selection",
        controller: "drawing",
        context: exactContext,
        action: "DELETE",
        items: [
          { strokeId, expectedVersion: 1 },
          { strokeId, expectedVersion: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(
      PageCollaborationMessageSchema.safeParse({
        type: "syncaction.command.ready",
        controller: "drawing",
        context: exactContext,
        command: "toggle-danmaku-input",
      }).success,
    ).toBe(false);
  });

  it("accepts only fully valid messages from the controller's exact namespace", () => {
    expect(
      isPageControllerMessage(
        {
          type: "syncaction.pointer.sample",
          sample: {
            type: "pointer.sample",
            documentRevision: context.documentRevision,
            anchor: null,
            viewport: { x: 0.4, y: 0.6 },
          },
        },
        "pointer",
      ),
    ).toBe(true);
    expect(
      isPageControllerMessage(
        {
          type: "syncaction.media.observed",
          event: "DISCOVERED",
          context: {
            ...context,
            frameKey: "top",
          },
          target: mediaTarget,
          observed: mediaObserved,
          applyToken: null,
          resultCode: null,
        },
        "pointer",
      ),
    ).toBe(false);
    expect(isPageControllerMessage({ type: "syncaction.pointer.private" }, "pointer")).toBe(false);
    expect(isPageControllerMessage({ type: "syncaction.pointer.sample" }, "pointer")).toBe(false);
  });
});

describe("ChromePageCollaborationPort", () => {
  it("accepts compatibility reports only from the authorized exact top document", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);
    await port.ensureInjected(7);
    const documentUrl = "https://example.com/article?private=1";
    const report = PageCompatibilityReportSchema.parse({
      type: "page.compatibility.report",
      protocolVersion: 1,
      logicalTabId,
      contentContext: {
        documentRevision: context.documentRevision,
        canonicalPageIdentity: canonicalSharedPageIdentity(documentUrl),
        contentSignature: {
          signatureVersion: 1,
          digest: "A".repeat(43),
        },
        media: null,
      },
    });

    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 0,
        documentUrl,
        documentId: "document-1",
        documentLifecycle: "active",
        message: report,
      }),
    ).resolves.toBe(true);
    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 0,
        documentUrl,
        documentId: "document-1",
        documentLifecycle: "active",
        message: {
          ...report,
          contentContext: {
            ...report.contentContext,
            canonicalPageIdentity: canonicalSharedPageIdentity("https://example.com/other"),
          },
        },
      }),
    ).resolves.toBe(false);
    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 3,
        documentUrl,
        documentId: "document-1",
        documentLifecycle: "active",
        message: report,
      }),
    ).resolves.toBe(false);
  });

  it("reports an unsupported protected page once and never injects it", async () => {
    api.tabsById.set(8, { id: 8, url: "chrome://settings" });
    const capabilities: unknown[] = [];
    const port = new ChromePageCollaborationPort(api, {
      onCapability: (report) => {
        capabilities.push(report);
      },
    });

    await expect(port.ensureInjected(8)).resolves.toBe(false);
    await expect(port.ensureInjected(8)).resolves.toBe(false);
    expect(api.executions).toEqual([]);
    expect(capabilities).toEqual([
      {
        tabId: 8,
        frameId: 0,
        message: {
          type: "syncaction.page.capability",
          capability: "PAGE_HOST",
          state: "DEGRADED",
          errorCode: "PROTECTED_PAGE",
        },
      },
    ]);
  });

  it("classifies Chromium extension stores as protected HTTPS pages", async () => {
    const protectedUrls = [
      "https://chromewebstore.google.com/detail/example/abcdefghijklmnop",
      "https://chrome.google.com/webstore/detail/example/abcdefghijklmnop",
      "https://microsoftedge.microsoft.com/addons/detail/example/abcdefghijklmnop",
    ];
    const capabilities: unknown[] = [];
    const port = new ChromePageCollaborationPort(api, {
      onCapability: (report) => capabilities.push(report),
    });
    api.granted = true;

    for (const [index, url] of protectedUrls.entries()) {
      const tabId = 20 + index;
      api.tabsById.set(tabId, { id: tabId, url });
      expect(isProtectedPageUrl(url)).toBe(true);
      expect(originPatternForUrl(url)).toBeNull();
      await expect(port.ensureInjected(tabId)).resolves.toBe(false);
    }

    expect(api.executions).toEqual([]);
    expect(capabilities).toHaveLength(protectedUrls.length);
  });

  it("reports the same protected-page degradation again after an available document handshake", async () => {
    api.tabsById.set(8, { id: 8, url: "chrome://settings" });
    api.granted = true;
    const capabilities: unknown[] = [];
    const port = new ChromePageCollaborationPort(api, {
      onCapability: (report) => capabilities.push(report),
    });

    await expect(port.ensureInjected(8)).resolves.toBe(false);
    api.tabsById.set(8, { id: 8, url: "https://example.com/recovered" });
    await expect(port.ensureInjected(8)).resolves.toBe(true);
    await expect(
      port.validateOutboundMessage({
        tabId: 8,
        frameId: 0,
        documentUrl: "https://example.com/recovered",
        documentId: "document-1",
        documentLifecycle: "active",
        message: {
          type: "syncaction.page.capability",
          capability: "PAGE_HOST",
          state: "AVAILABLE",
          errorCode: null,
        },
      }),
    ).resolves.toBe(true);
    api.tabsById.set(8, { id: 8, url: "chrome://settings" });
    await expect(port.ensureInjected(8)).resolves.toBe(false);

    expect(capabilities).toHaveLength(2);
  });

  it("injects only page-collaboration.js and preserves exact pointer messages", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);

    await expect(port.ensureInjected(7)).resolves.toBe(true);
    await port.setContext(7, context);
    await port.render(7, pointer);
    await port.clear(7, { userId, deviceId });

    expect(api.executions).toEqual([
      {
        target: { tabId: 7, frameIds: [0] },
        files: ["page-collaboration.js"],
      },
    ]);
    expect(api.messages).toEqual([
      {
        tabId: 7,
        message: { type: "syncaction.pointer.context", context },
        options: { frameId: 0, documentId: "document-1" },
      },
      {
        tabId: 7,
        message: { type: "syncaction.pointer.render", pointer },
        options: { frameId: 0, documentId: "document-1" },
      },
      {
        tabId: 7,
        message: {
          type: "syncaction.pointer.clear",
          identity: { userId, deviceId },
        },
        options: { frameId: 0, documentId: "document-1" },
      },
    ]);
  });

  it("sends observe, apply, and cooperative-lock commands through the same exact document", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);
    const mediaContext = { ...context, frameKey: "top" };

    await port.observe(7, 0, mediaContext);
    await port.observe(7, 0, mediaContext, mediaTarget);
    await port.apply(
      7,
      0,
      mediaContext,
      mediaTarget,
      { type: "SEEK", positionMs: 50_000 },
      "00000000-0000-4000-8000-000000000001",
    );
    await port.setFollowerLock(7, 0, mediaContext, mediaTarget, true);
    await port.setFollowerLock(7, 0, mediaContext, mediaTarget, false);

    expect(api.executions).toHaveLength(1);
    expect(api.messages.map(({ message }) => message)).toEqual([
      {
        type: "syncaction.media.command",
        context: mediaContext,
        operation: { type: "OBSERVE" },
      },
      {
        type: "syncaction.media.command",
        context: mediaContext,
        operation: { type: "OBSERVE", target: mediaTarget },
      },
      {
        type: "syncaction.media.command",
        context: mediaContext,
        operation: {
          type: "APPLY",
          applyToken: "00000000-0000-4000-8000-000000000001",
          target: mediaTarget,
          action: { type: "SEEK", positionMs: 50_000 },
        },
      },
      {
        type: "syncaction.media.command",
        context: mediaContext,
        operation: {
          type: "SET_FOLLOWER_LOCK",
          locked: true,
          target: mediaTarget,
        },
      },
      {
        type: "syncaction.media.command",
        context: mediaContext,
        operation: {
          type: "SET_FOLLOWER_LOCK",
          locked: false,
          target: mediaTarget,
        },
      },
    ]);
    expect(api.messages.map(({ options }) => options)).toEqual([
      { frameId: 0, documentId: "document-1" },
      { frameId: 0, documentId: "document-1" },
      { frameId: 0, documentId: "document-1" },
      { frameId: 0, documentId: "document-1" },
      { frameId: 0, documentId: "document-1" },
    ]);
  });

  it("routes danmaku and pen toggles only through an authorized exact top-frame document", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);

    await port.toggleDanmakuInput(7, exactContext);
    await port.setDanmakuHidden(7, exactContext, true);
    await port.setDanmakuHidden(7, exactContext, false);
    await port.togglePagePen(7, exactContext);

    expect(api.executions).toHaveLength(1);
    expect(api.messages).toEqual([
      {
        tabId: 7,
        message: {
          type: "syncaction.danmaku.command",
          controller: "danmaku",
          context: exactContext,
          action: "TOGGLE_INPUT",
        },
        options: { frameId: 0, documentId: "document-1" },
      },
      {
        tabId: 7,
        message: {
          type: "syncaction.danmaku.command",
          controller: "danmaku",
          context: exactContext,
          action: "HIDE",
        },
        options: { frameId: 0, documentId: "document-1" },
      },
      {
        tabId: 7,
        message: {
          type: "syncaction.danmaku.command",
          controller: "danmaku",
          context: exactContext,
          action: "SHOW",
        },
        options: { frameId: 0, documentId: "document-1" },
      },
      {
        tabId: 7,
        message: {
          type: "syncaction.drawing.command",
          controller: "drawing",
          context: exactContext,
          action: { type: "TOGGLE_PEN" },
        },
        options: { frameId: 0, documentId: "document-1" },
      },
    ]);

    api.granted = false;
    await expect(port.toggleDanmakuInput(7, exactContext)).rejects.toThrow(
      "PAGE_TOOL_PERMISSION_REQUIRED",
    );
    expect(api.messages).toHaveLength(4);
  });

  it("consumes a response-carried tool capability without evicting the reachable document", async () => {
    api.granted = true;
    const capabilities: unknown[] = [];
    const port = new ChromePageCollaborationPort(api, {
      onCapability: (report) => capabilities.push(report),
    });
    api.sendImplementation = async (_tabId, message) =>
      readType(message) === "syncaction.drawing.command"
        ? {
            type: "syncaction.page.capability",
            capability: "DRAWING",
            state: "DEGRADED",
            errorCode: "DRAWING_RUNTIME_LOAD_FAILED",
          }
        : undefined;

    await expect(port.togglePagePen(7, exactContext)).rejects.toThrow(
      "DRAWING_RUNTIME_LOAD_FAILED",
    );
    expect(capabilities).toContainEqual({
      tabId: 7,
      frameId: 0,
      message: {
        type: "syncaction.page.capability",
        capability: "DRAWING",
        state: "DEGRADED",
        errorCode: "DRAWING_RUNTIME_LOAD_FAILED",
      },
    });

    api.sendImplementation = async (_tabId, message) =>
      readType(message) === "syncaction.drawing.command"
        ? {
            type: "syncaction.page.capability",
            capability: "DRAWING",
            state: "AVAILABLE",
            errorCode: null,
          }
        : undefined;
    await expect(port.togglePagePen(7, exactContext)).resolves.toMatchObject({
      capability: "DRAWING",
      state: "AVAILABLE",
    });
    expect(api.executions).toHaveLength(1);
  });

  it("routes child-frame tools to the exact registered frame and document", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const port = new ChromePageCollaborationPort(api);
    await port.ensureInjected(7, 0);
    await port.ensureInjected(7, 3, "https://frame.example/player");
    expect(port.registerPageToolFrame(7, 0, "top")).toBe(true);
    expect(port.registerPageToolFrame(7, 3, childFrameKey)).toBe(true);
    api.messages.length = 0;

    await port.setDanmakuStatus(7, childContext, {
      status: "FAILED",
      messageId,
      errorCode: "DANMAKU_OFFLINE",
    });
    await port.renderLocalDraft(
      7,
      childContext,
      { ...strokeDraft, frameKey: childFrameKey },
      "PENDING",
      false,
    );
    await port.togglePagePen(7, exactContext);

    expect(api.messages.slice(0, 2).map(({ options }) => options)).toEqual([
      { frameId: 3, documentId: "document-2" },
      { frameId: 3, documentId: "document-2" },
    ]);
    expect(
      api.messages
        .filter(({ message }) => readType(message) === "syncaction.drawing.command")
        .map(({ message, options }) => ({
          frameKey: (message as { context: { frameKey: string } }).context.frameKey,
          options,
        })),
    ).toEqual([
      {
        frameKey: "top",
        options: { frameId: 0, documentId: "document-1" },
      },
      {
        frameKey: childFrameKey,
        options: { frameId: 3, documentId: "document-2" },
      },
    ]);
  });

  it("evicts a missing child after a partial pen broadcast without toggling top twice", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const unavailable: Array<{ tabId: number; frameId: number; frameKey: string }> = [];
    const port = new ChromePageCollaborationPort(api, {
      onPageToolFrameUnavailable: (tabId, frameId, frameKey) => {
        unavailable.push({ tabId, frameId, frameKey });
      },
    });
    await port.ensureInjected(7, 0);
    await port.ensureInjected(7, 3, "https://frame.example/player");
    port.registerPageToolFrame(7, 0, "top");
    port.registerPageToolFrame(7, 3, childFrameKey);
    api.messages.length = 0;
    api.sendImplementation = async (_tabId, message, options) => {
      if (
        readType(message) === "syncaction.drawing.command" &&
        (options as { frameId?: number } | undefined)?.frameId === 3
      ) {
        throw new Error("NO_RECEIVER");
      }
      return availableToolResponse(message);
    };

    await expect(port.togglePagePen(7, exactContext)).resolves.toMatchObject({
      capability: "DRAWING",
      state: "AVAILABLE",
    });
    expect(unavailable).toEqual([{ tabId: 7, frameId: 3, frameKey: childFrameKey }]);
    expect(
      api.messages
        .filter(({ message }) => readType(message) === "syncaction.drawing.command")
        .map(({ options }) => options),
    ).toEqual([
      { frameId: 0, documentId: "document-1" },
      { frameId: 3, documentId: "document-2" },
    ]);

    api.messages.length = 0;
    await expect(port.togglePagePen(7, exactContext)).resolves.toMatchObject({
      capability: "DRAWING",
      state: "AVAILABLE",
    });
    expect(api.messages.map(({ options }) => options)).toEqual([
      { frameId: 0, documentId: "document-1" },
    ]);
  });

  it("does not treat a child-frame success as recovery of a degraded top-frame drawing runtime", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const port = new ChromePageCollaborationPort(api);
    await port.ensureInjected(7, 0);
    await port.ensureInjected(7, 3, "https://frame.example/player");
    port.registerPageToolFrame(7, 0, "top");
    port.registerPageToolFrame(7, 3, childFrameKey);
    api.sendImplementation = async (_tabId, message, options) => {
      if (
        readType(message) === "syncaction.drawing.command" &&
        (options as { frameId?: number } | undefined)?.frameId === 0
      ) {
        return {
          type: "syncaction.page.capability",
          capability: "DRAWING",
          state: "DEGRADED",
          errorCode: "DRAWING_RUNTIME_LOAD_FAILED",
        };
      }
      return availableToolResponse(message);
    };

    await expect(port.togglePagePen(7, exactContext)).rejects.toThrow(
      "DRAWING_RUNTIME_LOAD_FAILED",
    );
    expect(
      api.messages
        .filter(({ message }) => readType(message) === "syncaction.drawing.command")
        .map(({ options }) => options),
    ).toEqual([
      { frameId: 0, documentId: "document-1" },
      { frameId: 3, documentId: "document-2" },
    ]);
  });

  it("does not let an old child send failure evict a replacement document", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const unavailable: Array<{ tabId: number; frameId: number; frameKey: string }> = [];
    const port = new ChromePageCollaborationPort(api, {
      onPageToolFrameUnavailable: (tabId, frameId, frameKey) => {
        unavailable.push({ tabId, frameId, frameKey });
      },
    });
    await port.ensureInjected(7, 0);
    await port.ensureInjected(7, 3, "https://frame.example/player");
    port.registerPageToolFrame(7, 0, "top");
    port.registerPageToolFrame(7, 3, childFrameKey);
    let rejectOldChild: ((cause: Error) => void) | undefined;
    api.sendImplementation = async (_tabId, message, options) => {
      if (
        readType(message) === "syncaction.drawing.command" &&
        (options as { frameId?: number } | undefined)?.frameId === 3
      ) {
        return new Promise<never>((_resolve, reject) => {
          rejectOldChild = reject;
        });
      }
      return availableToolResponse(message);
    };

    const toggling = port.togglePagePen(7, exactContext);
    await vi.waitFor(() => expect(rejectOldChild).toBeTypeOf("function"));
    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 3,
        documentUrl: "https://frame.example/player",
        documentId: "child-replacement",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(true);
    expect(port.registerPageToolFrame(7, 3, childFrameKey)).toBe(true);
    rejectOldChild?.(new Error("OLD_DOCUMENT_GONE"));
    await expect(toggling).resolves.toMatchObject({
      capability: "DRAWING",
      state: "AVAILABLE",
    });
    expect(unavailable).toEqual([]);

    api.sendImplementation = undefined;
    api.messages.length = 0;
    await port.togglePagePen(7, exactContext);
    expect(api.messages.map(({ options }) => options)).toEqual([
      { frameId: 0, documentId: "document-1" },
      { frameId: 3, documentId: "child-replacement" },
    ]);
  });

  it("degrades duplicate sibling frame identities instead of ambiguously routing", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const capabilities: unknown[] = [];
    const unavailable: Array<{ tabId: number; frameId: number; frameKey: string }> = [];
    const port = new ChromePageCollaborationPort(api, {
      onCapability: (report) => capabilities.push(report),
      onPageToolFrameUnavailable: (tabId, frameId, frameKey) => {
        unavailable.push({ tabId, frameId, frameKey });
      },
    });
    await port.ensureInjected(7, 3, "https://frame.example/player");
    await port.ensureInjected(7, 4, "https://frame.example/player");

    expect(port.registerPageToolFrame(7, 3, childFrameKey)).toBe(true);
    expect(port.registerPageToolFrame(7, 4, childFrameKey)).toBe(false);
    expect(unavailable).toEqual([
      { tabId: 7, frameId: 3, frameKey: childFrameKey },
      { tabId: 7, frameId: 4, frameKey: childFrameKey },
    ]);
    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 3,
        documentUrl: "https://frame.example/player",
        documentId: "document-1",
        documentLifecycle: "active",
        message: {
          type: "syncaction.stroke.final",
          controller: "drawing",
          context: childContext,
          stroke: { ...strokeDraft, frameKey: childFrameKey },
        },
      }),
    ).resolves.toBe(false);
    await expect(
      port.setDanmakuStatus(7, childContext, {
        status: "FAILED",
        messageId,
        errorCode: "DANMAKU_OFFLINE",
      }),
    ).rejects.toThrow("PAGE_TOOL_PERMISSION_REQUIRED");
    expect(capabilities).toMatchObject([
      {
        tabId: 7,
        frameId: 3,
        message: { state: "DEGRADED", errorCode: "DUPLICATE_FRAME_IDENTITY" },
      },
      {
        tabId: 7,
        frameId: 4,
        message: { state: "DEGRADED", errorCode: "DUPLICATE_FRAME_IDENTITY" },
      },
    ]);
  });

  it("recovers the remaining sibling when a duplicate navigates to a new identity", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const port = new ChromePageCollaborationPort(api);
    const replacementFrameKey = "frame:sha256-fedcba9876543210fedcba9876543210" as const;
    await port.ensureInjected(7, 3, "https://frame.example/player");
    await port.ensureInjected(7, 4, "https://frame.example/player");
    port.registerPageToolFrame(7, 3, childFrameKey);
    port.registerPageToolFrame(7, 4, childFrameKey);
    await vi.waitFor(() =>
      expect(
        api.messages.filter(({ message }) => readType(message) === "syncaction.page.announce"),
      ).toHaveLength(2),
    );
    api.messages.length = 0;

    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 4,
        documentUrl: "https://frame.example/player",
        documentId: "document-4-after-navigation",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(true);
    expect(port.registerPageToolFrame(7, 4, replacementFrameKey)).toBe(true);
    expect(
      api.messages.filter(({ message }) => readType(message) === "syncaction.page.announce"),
    ).toContainEqual({
      tabId: 7,
      message: { type: "syncaction.page.announce" },
      options: { frameId: 3, documentId: "document-1" },
    });
    expect(port.registerPageToolFrame(7, 3, childFrameKey)).toBe(true);
    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 3,
        documentUrl: "https://frame.example/player",
        documentId: "document-1",
        documentLifecycle: "active",
        message: {
          type: "syncaction.stroke.final",
          controller: "drawing",
          context: childContext,
          stroke: { ...strokeDraft, frameKey: childFrameKey },
        },
      }),
    ).resolves.toBe(true);
  });

  it("routes isolated danmaku and drawing controller state through the exact document", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);
    const danmakuEvent = DanmakuEventMessageSchema.parse({
      type: "danmaku.event" as const,
      protocolVersion: 1 as const,
      messageId,
      ...exactContext,
      sender: { userId, username: "remote", displayName: "Remote", deviceId },
      text: "literal",
      sentAtServerMs: 1_785_150_000_000,
      expiresAtServerMs: 1_785_150_009_000,
    });
    const annotationSnapshot = AnnotationSnapshotMessageSchema.parse({
      type: "annotation.snapshot.v2" as const,
      protocolVersion: 1 as const,
      ...exactContext,
      pageKey,
      annotationSeq: 0,
      strokes: [],
    });
    const acknowledgement = AnnotationAckSchema.parse({
      type: "annotation.ack.v2" as const,
      protocolVersion: 1 as const,
      clientOpId,
      roomId,
      accepted: true as const,
      code: null,
      pageKey,
      annotationSeq: 1,
      results: [{ strokeId, accepted: true as const, code: null, version: 1 }],
    });
    const previewEvent = StrokePreviewEventMessageSchema.parse({
      ...previewUpdate,
      type: "stroke.preview.event" as const,
      sender: { userId, username: "remote", displayName: "Remote", deviceId },
      expiresAtServerMs: 1_785_150_003_000,
    });
    const previewClear = StrokePreviewClearMessageSchema.parse({
      type: "stroke.preview.clear" as const,
      protocolVersion: 1 as const,
      previewId,
      ...exactContext,
      sender: { userId, deviceId },
    });

    await port.setDanmakuStatus(7, exactContext, {
      status: "SENDING",
      messageId,
      errorCode: null,
    });
    await port.renderDanmaku(7, exactContext, danmakuEvent);
    await port.clearDanmaku(7, exactContext);
    await port.setDrawingViewer(7, exactContext, { userId, role: "OWNER" });
    await port.renderAnnotationSnapshot(7, exactContext, annotationSnapshot);
    await port.renderLocalDraft(7, exactContext, strokeDraft, "ERROR");
    await port.renderAnnotationCommitted(
      7,
      exactContext,
      AnnotationCommittedOperationSchema.parse(annotationCommitted),
    );
    await port.renderAnnotationAcknowledgement(7, exactContext, acknowledgement);
    await port.renderStrokePreview(7, exactContext, previewEvent);
    await port.clearStrokePreview(7, exactContext, previewClear);
    await port.clearDrawing(7, exactContext);

    expect(api.executions).toHaveLength(1);
    expect(api.messages.map(({ message }) => (message as { type: string }).type)).toEqual([
      "syncaction.danmaku.status",
      "syncaction.danmaku.render",
      "syncaction.danmaku.clear",
      "syncaction.drawing.viewer",
      "syncaction.annotation.snapshot",
      "syncaction.annotation.draft",
      "syncaction.annotation.committed",
      "syncaction.annotation.ack",
      "syncaction.stroke.preview.render",
      "syncaction.stroke.preview.clear",
      "syncaction.drawing.clear",
    ]);
    expect(
      api.messages.every(({ options }) => {
        const target = options as { frameId?: number; documentId?: string } | undefined;
        return target?.frameId === 0 && target.documentId === "document-1";
      }),
    ).toBe(true);
  });

  it("does not inject a page runtime merely to clear an already absent tool surface", async () => {
    const port = new ChromePageCollaborationPort(api);

    await port.clearDanmaku(7, exactContext);
    await port.clearDrawing(7, exactContext);

    expect(api.executions).toEqual([]);
    expect(api.messages).toEqual([]);
  });

  it("resolves an element signature only through the exact tracked document", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);
    await port.ensureInjected(7);
    api.messages.length = 0;
    api.sendImplementation = async (_tabId, message) => {
      expect(message).toEqual({
        type: "syncaction.annotation.anchor-signature.request",
        controller: "drawing",
        context: exactContext,
        path: [{ tagName: "html", nthOfType: 1 }],
      });
      return {
        type: "syncaction.annotation.anchor-signature.response",
        signature: contentSignature,
      };
    };

    await expect(
      port.resolveElementAnchorSignature(7, exactContext, [{ tagName: "html", nthOfType: 1 }]),
    ).resolves.toEqual(contentSignature);
    expect(api.messages).toEqual([
      {
        tabId: 7,
        message: {
          type: "syncaction.annotation.anchor-signature.request",
          controller: "drawing",
          context: exactContext,
          path: [{ tagName: "html", nthOfType: 1 }],
        },
        options: { frameId: 0, documentId: "document-2" },
      },
    ]);
  });

  it("targets an explicitly selected frame without broad all-frame messaging", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);

    await expect(port.ensureInjected(7, 3, "https://frame.example/player")).resolves.toBe(true);
    await port.setContext(7, context, 3);

    expect(api.executions).toEqual([
      {
        target: { tabId: 7, frameIds: [3] },
        files: ["page-collaboration.js"],
      },
    ]);
    expect(api.containsCalls[0]).toEqual(["https://frame.example/*"]);
    expect(api.messages[0]?.options).toEqual({ frameId: 3, documentId: "document-1" });
  });

  it("registers one all-frame runtime only for exact granted collaboration origins", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    api.grantedOrigins.add("https://syncaction.example.com/*");
    api.grantedOrigins.add("https://*/*");
    api.grantedOrigins.add("http://*.example.com/*");
    const port = new ChromePageCollaborationPort(api, {
      excludedOriginPatterns: ["https://syncaction.example.com/*"],
    });

    await port.initialize();

    expect(api.registeredScripts).toEqual([
      {
        id: "syncaction-page-collaboration",
        js: ["page-collaboration.js"],
        matches: ["https://example.com/*", "https://frame.example/*"],
        allFrames: true,
        persistAcrossSessions: true,
        runAt: "document_idle",
        world: "ISOLATED",
      },
    ]);
  });

  it("requires current versioned origin consent before registration, injection, or page messages", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const allowed = new Set(["https://frame.example"]);
    const port = new ChromePageCollaborationPort(api, {
      originAccess: {
        listAllowedOrigins: async () => [...allowed],
        isOriginAllowed: async (origin) => allowed.has(origin),
      },
    });

    await port.initialize();

    expect(api.registeredScripts[0]?.matches).toEqual(["https://frame.example/*"]);
    await expect(port.ensureInjected(7)).resolves.toBe(false);
    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 0,
        documentUrl: "https://example.com/article?private=1",
        documentId: "unconsented-document",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(false);
    expect(api.executions).toEqual([]);

    allowed.add("https://example.com");
    await port.refreshOriginAccess();
    expect(api.registeredScripts[0]?.matches).toEqual([
      "https://example.com/*",
      "https://frame.example/*",
    ]);
    await expect(port.ensureInjected(7)).resolves.toBe(true);

    allowed.delete("https://example.com");
    await port.refreshOriginAccess();
    expect(api.trace).toContain("message:7:syncaction.page.dispose");
    expect(api.registeredScripts[0]?.matches).toEqual(["https://frame.example/*"]);
  });

  it("announces a fresh worker to existing all-frame page runtimes", async () => {
    api.granted = true;
    api.tabsById.set(8, { id: 8, url: "https://example.com/embedded" });
    const port = new ChromePageCollaborationPort(api);

    await port.announceExistingPages();

    expect(api.messages).toEqual([
      {
        tabId: 7,
        message: { type: "syncaction.page.announce" },
        options: undefined,
      },
      {
        tabId: 8,
        message: { type: "syncaction.page.announce" },
        options: undefined,
      },
    ]);
  });

  it("updates all-frame registration as exact optional origins are granted and removed", async () => {
    api.grantedOrigins.add("https://example.com/*");
    const port = new ChromePageCollaborationPort(api);
    await port.initialize();

    api.addPermissions(["https://frame.example/*"]);
    await vi.waitFor(() =>
      expect(api.registeredScripts[0]?.matches).toEqual([
        "https://example.com/*",
        "https://frame.example/*",
      ]),
    );

    api.removePermissions(["https://frame.example/*"]);
    await vi.waitFor(() =>
      expect(api.registeredScripts[0]?.matches).toEqual(["https://example.com/*"]),
    );
  });

  it("adopts an automatically injected child only when top and child origins are authorized", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const port = new ChromePageCollaborationPort(api);

    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 3,
        documentUrl: "https://frame.example/player",
        documentId: "child-document",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(true);
    await expect(port.verifyInjected(7, 3)).resolves.toBe(true);
    expect(api.executions).toEqual([]);

    const deniedPort = new ChromePageCollaborationPort(api);
    api.grantedOrigins.delete("https://frame.example/*");
    await expect(
      deniedPort.validateOutboundMessage({
        tabId: 7,
        frameId: 4,
        documentUrl: "https://frame.example/denied",
        documentId: "denied-document",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(false);
  });

  it("replaces a tracked child document when that frame navigates", async () => {
    api.grantedOrigins.add("https://example.com/*");
    api.grantedOrigins.add("https://frame.example/*");
    const port = new ChromePageCollaborationPort(api);
    await port.ensureInjected(7, 3, "https://frame.example/first");

    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 3,
        documentUrl: "https://frame.example/second",
        documentId: "child-after-navigation",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(true);
    expect(port.registerPageToolFrame(7, 3, childFrameKey)).toBe(true);
    await port.setDanmakuStatus(7, childContext, {
      status: "FAILED",
      messageId,
      errorCode: "DANMAKU_OFFLINE",
    });

    expect(api.messages.at(-1)?.options).toEqual({
      frameId: 3,
      documentId: "child-after-navigation",
    });
  });

  it("refuses a child-frame injection without that frame's exact document URL", async () => {
    api.granted = true;
    const capabilities: unknown[] = [];
    const port = new ChromePageCollaborationPort(api, {
      onCapability: (report) => capabilities.push(report),
    });

    await expect(port.ensureInjected(7, 3)).resolves.toBe(false);

    expect(api.executions).toEqual([]);
    expect(capabilities).toEqual([
      {
        tabId: 7,
        frameId: 3,
        message: {
          type: "syncaction.page.capability",
          capability: "PAGE_HOST",
          state: "DEGRADED",
          errorCode: "FRAME_DOCUMENT_URL_REQUIRED",
        },
      },
    ]);
  });

  it("disposes all page runtimes after an external revoke even after worker memory is lost", async () => {
    api.granted = true;
    const firstWorkerPort = new ChromePageCollaborationPort(api);
    await firstWorkerPort.ensureInjected(7, 0);
    await firstWorkerPort.ensureInjected(7, 3, "https://frame.example/player");
    api.messages.length = 0;
    const permissionBoundaryChanged = vi.fn();
    new ChromePageCollaborationPort(api, {
      onPermissionBoundaryChanged: permissionBoundaryChanged,
    });

    api.removePermissions(["https://example.com/*"]);

    await vi.waitFor(() => expect(permissionBoundaryChanged).toHaveBeenCalledOnce());
    expect(api.messages).toEqual([
      {
        tabId: 7,
        message: { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
        options: undefined,
      },
    ]);
  });

  it("disposes every tracked child document exactly before forgetting permission state", async () => {
    api.granted = true;
    const permissionBoundaryChanged = vi.fn();
    const port = new ChromePageCollaborationPort(api, {
      onPermissionBoundaryChanged: permissionBoundaryChanged,
    });
    await port.ensureInjected(7, 0);
    await port.ensureInjected(7, 3, "https://frame.example/player");
    api.messages.length = 0;

    api.removePermissions(["https://example.com/*"]);

    await vi.waitFor(() => expect(permissionBoundaryChanged).toHaveBeenCalledOnce());
    expect(api.messages).toEqual([
      {
        tabId: 7,
        message: { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
        options: { frameId: 0, documentId: "document-1" },
      },
      {
        tabId: 7,
        message: { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
        options: { frameId: 3, documentId: "document-2" },
      },
    ]);
  });

  it("blocks document-targeted sends while a permission boundary is being cleaned up", async () => {
    api.granted = true;
    let finishQuery:
      ((tabs: Array<{ id: number; url?: string; pendingUrl?: string }>) => void) | undefined;
    api.queryImplementation = () =>
      new Promise((resolve) => {
        finishQuery = resolve;
      });
    const permissionBoundaryChanged = vi.fn();
    const port = new ChromePageCollaborationPort(api, {
      onPermissionBoundaryChanged: permissionBoundaryChanged,
    });
    await port.ensureInjected(7);

    api.removePermissions(["https://example.com/*"]);

    await expect(port.setContext(7, context)).rejects.toThrow("PAGE_PERMISSION_BOUNDARY_ACTIVE");
    finishQuery?.([...api.tabsById.values()]);
    await vi.waitFor(() => expect(permissionBoundaryChanged).toHaveBeenCalledOnce());
  });

  it("replaces exact document identity after top-frame navigation", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);
    await port.ensureInjected(7);
    api.tabsById.set(7, { id: 7, url: "https://other.example/after-navigation" });
    await port.ensureInjected(7);

    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 0,
        documentUrl: "https://example.com/article?private=1",
        documentId: "document-1",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(false);
    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 0,
        documentUrl: "https://other.example/after-navigation",
        documentId: "document-2",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(true);
  });

  it("retries against the latest document when navigation happens during injection", async () => {
    api.granted = true;
    let finishFirstInjection:
      ((value: Array<{ frameId?: number; documentId?: string }>) => void) | undefined;
    api.executeImplementation = async () => {
      if (api.executions.length === 1) {
        return new Promise((resolve) => {
          finishFirstInjection = resolve;
        });
      }
      return [{ frameId: 0, documentId: "document-after-navigation" }];
    };
    const port = new ChromePageCollaborationPort(api);

    const beforeNavigation = port.ensureInjected(7);
    await vi.waitFor(() => expect(api.executions).toHaveLength(1));
    api.tabsById.set(7, { id: 7, url: "https://other.example/after-navigation" });
    const afterNavigation = port.ensureInjected(7);
    finishFirstInjection?.([{ frameId: 0, documentId: "document-before-navigation" }]);

    await expect(beforeNavigation).resolves.toBe(false);
    await expect(afterNavigation).resolves.toBe(true);
    expect(api.executions).toHaveLength(2);
    expect(api.messages).toContainEqual({
      tabId: 7,
      message: { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
      options: { documentId: "document-before-navigation" },
    });
    await expect(port.verifyInjected(7)).resolves.toBe(true);
  });

  it("replaces the old root when a child frame is injected first after navigation", async () => {
    api.granted = true;
    const port = new ChromePageCollaborationPort(api);
    await port.ensureInjected(7);
    const oldRootGeneration = port.pageToolRootGeneration(7, 0);
    api.tabsById.set(7, { id: 7, url: "https://other.example/after-navigation" });
    await port.ensureInjected(7, 3, "https://frame.example/player");
    const newRootGeneration = port.pageToolRootGeneration(7, 3);

    await expect(
      port.validateOutboundMessage({
        tabId: 7,
        frameId: 3,
        documentUrl: "https://frame.example/player",
        documentId: "document-2",
        documentLifecycle: "active",
        message: { type: "syncaction.page.ready" },
      }),
    ).resolves.toBe(true);
    expect(oldRootGeneration).not.toBeNull();
    expect(newRootGeneration).not.toBe(oldRootGeneration);
    await expect(port.verifyInjected(7)).resolves.toBe(false);
  });

  it("invalidates an injection that finishes after its origin was revoked", async () => {
    api.granted = true;
    let finishInjection:
      ((value: Array<{ frameId?: number; documentId?: string }>) => void) | undefined;
    api.executeImplementation = () =>
      new Promise((resolve) => {
        finishInjection = resolve;
      });
    const permissionBoundaryChanged = vi.fn();
    const port = new ChromePageCollaborationPort(api, {
      onPermissionBoundaryChanged: permissionBoundaryChanged,
    });

    const injecting = port.ensureInjected(7);
    await vi.waitFor(() => expect(api.executions).toHaveLength(1));
    api.removePermissions(["https://example.com/*"]);
    finishInjection?.([{ frameId: 0, documentId: "revoked-document" }]);

    await expect(injecting).resolves.toBe(false);
    await vi.waitFor(() => expect(permissionBoundaryChanged).toHaveBeenCalledOnce());
    expect(api.messages).toContainEqual({
      tabId: 7,
      message: { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
      options: undefined,
    });
    expect(api.messages).toContainEqual({
      tabId: 7,
      message: { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
      options: { documentId: "revoked-document" },
    });
    await expect(port.verifyInjected(7)).resolves.toBe(false);
  });

  it("targets a late injected document even while broad revoke cleanup is still running", async () => {
    api.granted = true;
    api.tabsById.set(8, { id: 8, url: "https://other.example/slow-cleanup" });
    let finishInjection:
      ((value: Array<{ frameId?: number; documentId?: string }>) => void) | undefined;
    let finishSlowBroadcast: (() => void) | undefined;
    api.executeImplementation = () =>
      new Promise((resolve) => {
        finishInjection = resolve;
      });
    api.sendImplementation = (tabId, _message, options) =>
      tabId === 8 && options === undefined
        ? new Promise((resolve) => {
            finishSlowBroadcast = () => resolve(undefined);
          })
        : Promise.resolve(undefined);
    const permissionBoundaryChanged = vi.fn();
    const port = new ChromePageCollaborationPort(api, {
      onPermissionBoundaryChanged: permissionBoundaryChanged,
    });

    const injecting = port.ensureInjected(7);
    await vi.waitFor(() => expect(api.executions).toHaveLength(1));
    api.removePermissions(["https://example.com/*"]);
    await vi.waitFor(() =>
      expect(api.messages).toContainEqual({
        tabId: 8,
        message: { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
        options: undefined,
      }),
    );
    finishInjection?.([{ frameId: 0, documentId: "late-document" }]);

    await expect(injecting).resolves.toBe(false);
    expect(api.messages).toContainEqual({
      tabId: 7,
      message: { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
      options: { documentId: "late-document" },
    });
    expect(permissionBoundaryChanged).not.toHaveBeenCalled();
    finishSlowBroadcast?.();
    await vi.waitFor(() => expect(permissionBoundaryChanged).toHaveBeenCalledOnce());
  });

  it("disposes same-origin frames before revoking permission", async () => {
    api.granted = true;
    api.tabsById.set(8, { id: 8, url: "https://example.com/other" });
    api.tabsById.set(9, { id: 9, url: "https://other.example/" });
    const port = new ChromePageCollaborationPort(api);
    await port.ensureInjected(7, 0);
    await port.ensureInjected(7, 3, "https://example.com/frame");

    await expect(port.removeOriginForTab(7)).resolves.toBe(true);

    expect(api.trace).toEqual([
      "message:7:syncaction.page.dispose",
      "message:7:syncaction.page.dispose",
      "message:8:syncaction.page.dispose",
      "remove:https://example.com/*",
    ]);
    expect(api.messages.slice(0, 3).map(({ message }) => message)).toEqual([
      { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
      { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
      { type: "syncaction.page.dispose", reason: "ORIGIN_REVOKED" },
    ]);
    expect(api.messages.slice(0, 3).map(({ options }) => options)).toEqual([
      { frameId: 0, documentId: "document-1" },
      { frameId: 3, documentId: "document-2" },
      { frameId: 0 },
    ]);
  });

  it("keeps exact origin checks and rejects malformed commands and identifiers", async () => {
    const port = new ChromePageCollaborationPort(api);
    expect(originPatternForUrl("https://example.com/private?q=1")).toBe("https://example.com/*");
    expect(originPatternForUrl("chrome://extensions")).toBeNull();
    await expect(port.ensureInjected(-1)).rejects.toThrow();
    await expect(
      port.setContext(7, { ...context, privateUrl: "secret" } as never),
    ).rejects.toThrow();
    await expect(port.clear(7, { userId: userId.toUpperCase(), deviceId })).rejects.toThrow();
    expect(api.messages).toEqual([]);
  });
});

function readType(input: unknown): string {
  return typeof input === "object" &&
    input !== null &&
    "type" in input &&
    typeof input.type === "string"
    ? input.type
    : "unknown";
}

function availableToolResponse(message: unknown): unknown {
  const type = readType(message);
  if (
    type.startsWith("syncaction.danmaku.") &&
    type !== "syncaction.danmaku.clear" &&
    type !== "syncaction.danmaku.submit"
  ) {
    return {
      type: "syncaction.page.capability",
      capability: "DANMAKU",
      state: "AVAILABLE",
      errorCode: null,
    };
  }
  if (
    (type.startsWith("syncaction.drawing.") ||
      type.startsWith("syncaction.annotation.") ||
      type.startsWith("syncaction.stroke.preview.")) &&
    type !== "syncaction.drawing.clear" &&
    type !== "syncaction.drawing.report" &&
    type !== "syncaction.drawing.selection" &&
    type !== "syncaction.annotation.draft.control"
  ) {
    return {
      type: "syncaction.page.capability",
      capability: "DRAWING",
      state: "AVAILABLE",
      errorCode: null,
    };
  }
  return undefined;
}
