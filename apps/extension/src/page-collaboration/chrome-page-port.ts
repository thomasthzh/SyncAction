import {
  AnnotationAckV2Schema,
  AnnotationCommittedOperationV2Schema,
  AnnotationSnapshotV2MessageSchema,
  AnnotationStrokeDraftV2Schema,
  CollaborationFrameKeySchema,
  DanmakuEventMessageSchema,
  PointerFrameEventSchema,
  PointerLeaseRecordSchema,
  PointerRecordSchema,
  StrokePreviewClearMessageSchema,
  StrokePreviewEventMessageSchema,
  canonicalSharedPageIdentity,
  type AnnotationAckV2,
  type AnnotationCommittedOperationV2,
  type AnnotationSnapshotV2Message,
  type AnnotationStrokeDraftV2,
  type ContentSignature,
  type DanmakuErrorCode,
  type DanmakuEventMessage,
  type MediaTarget,
  type PointerFrameEvent,
  type PointerLeaseRecord,
  type PointerRecord,
  type PointerPathSegment,
  type StrokePreviewClearMessage,
  type StrokePreviewEventMessage,
} from "@syncaction/protocol";
import { z } from "zod";
import type { DanmakuControllerPagePort } from "../danmaku-controller.js";
import type { DrawingControllerPagePort } from "../drawing-controller.js";
import type { MediaPagePort } from "../media-controller.js";
import {
  PointerPageContextSchema,
  type PointerIdentity,
  type PointerPageContext,
  type PointerPagePort,
} from "../pointer-controller.js";
import {
  CollaborationPageContextSchema,
  AnnotationAckPageMessageSchema,
  AnnotationCommittedPageMessageSchema,
  AnnotationDraftPageMessageSchema,
  AnnotationSnapshotPageMessageSchema,
  DanmakuClearMessageSchema,
  DanmakuCommandMessageSchema,
  DanmakuRenderMessageSchema,
  DanmakuStatusMessageSchema,
  DrawingClearMessageSchema,
  DrawingCommandMessageSchema,
  DrawingViewerMessageSchema,
  ElementAnchorSignatureRequestSchema,
  ElementAnchorSignatureResponseSchema,
  PageAnnounceMessageSchema,
  PageCapabilityMessageSchema,
  PageCollaborationInboundMessageSchema,
  PageDisposeMessageSchema,
  MediaCommandMessageSchema,
  PointerClearMessageSchema,
  PointerContextMessageSchema,
  PointerFrameRenderMessageSchema,
  PointerLeaseRenderMessageSchema,
  PointerRenderMessageSchema,
  StrokePreviewClearPageMessageSchema,
  StrokePreviewRenderPageMessageSchema,
  type CollaborationPageContext,
  type PageCapabilityMessage,
  type PageCapabilityReport,
  type PageDisposeReason,
  type ParsedPageOutboundMessage,
  type MediaPageApplyAction,
  type MediaPageContext,
} from "./messages.js";

const LocalTabIdSchema = z.number().int().nonnegative().safe();
const FrameIdSchema = z.number().int().nonnegative().safe();

export interface ChromiumPageCollaborationTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
}

export interface ChromiumPageCollaborationApi {
  tabs: {
    get(tabId: number): Promise<ChromiumPageCollaborationTab>;
    query(query: Record<string, unknown>): Promise<ChromiumPageCollaborationTab[]>;
    sendMessage(
      tabId: number,
      message: unknown,
      options?: { frameId?: number; documentId?: string },
    ): Promise<unknown>;
  };
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
    getAll(): Promise<{ origins?: string[] | undefined }>;
    remove(permissions: { origins: string[] }): Promise<boolean>;
    onAdded?: {
      addListener(listener: (permissions: { origins?: string[] | undefined }) => void): void;
    };
    onRemoved?: {
      addListener(listener: (permissions: { origins?: string[] | undefined }) => void): void;
    };
  };
  scripting: {
    executeScript(details: {
      target: { tabId: number; frameIds: number[] };
      files: string[];
    }): Promise<Array<{ frameId?: number; documentId?: string }>>;
    getRegisteredContentScripts(filter?: {
      ids?: string[] | undefined;
    }): Promise<Array<{ id: string }>>;
    registerContentScripts(scripts: RegisteredPageContentScript[]): Promise<void>;
    updateContentScripts(scripts: RegisteredPageContentScript[]): Promise<void>;
    unregisterContentScripts(filter: { ids?: string[] | undefined }): Promise<void>;
  };
}

export interface RegisteredPageContentScript {
  id: string;
  js: string[];
  matches: string[];
  allFrames: boolean;
  persistAcrossSessions: boolean;
  runAt: "document_idle";
  world: "ISOLATED";
}

export interface ChromePageCollaborationPortOptions {
  onCapability?: (report: PageCapabilityReport) => void;
  onPermissionBoundaryChanged?: () => void | Promise<void>;
  onPageToolFrameUnavailable?: (tabId: number, frameId: number, frameKey: string) => void;
  excludedOriginPatterns?: readonly string[];
  originAccess?: {
    listAllowedOrigins(): Promise<readonly string[]>;
    isOriginAllowed(origin: string): Promise<boolean>;
  };
}

export interface PageToolCommandPort {
  toggleDanmakuInput(
    tabId: number,
    context: CollaborationPageContext,
  ): Promise<PageCapabilityMessage>;
  setDanmakuHidden?(
    tabId: number,
    context: CollaborationPageContext,
    hidden: boolean,
  ): Promise<PageCapabilityMessage>;
  togglePagePen(tabId: number, context: CollaborationPageContext): Promise<PageCapabilityMessage>;
}

const PROTECTED_HTTPS_HOSTS = new Set([
  "addons.mozilla.org",
  "chrome.google.com",
  "chromewebstore.google.com",
  "microsoftedge.microsoft.com",
]);
const REGISTERED_PAGE_SCRIPT_ID = "syncaction-page-collaboration";

export function isProtectedPageUrl(urlInput: unknown): boolean {
  if (typeof urlInput !== "string") {
    return true;
  }
  try {
    const url = new URL(urlInput);
    return (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      PROTECTED_HTTPS_HOSTS.has(url.hostname)
    );
  } catch {
    return true;
  }
}

export function originPatternForUrl(urlInput: unknown): string | null {
  if (isProtectedPageUrl(urlInput)) {
    return null;
  }
  return `${new URL(urlInput as string).origin}/*`;
}

interface TrackedFrameDocument {
  originPattern: string;
  documentUrl: string;
  documentId: string | null;
  collaborationFrameKey: string | null;
}

interface TrackedTabFrames {
  rootOriginPattern: string;
  rootDocumentUrl: string;
  rootGeneration: number;
  frames: Map<number, TrackedFrameDocument>;
  ambiguousFrameKeys: Set<string>;
}

interface PendingInjection {
  identity: string;
  promise: Promise<boolean>;
}

export class ChromePageCollaborationPort
  implements
    PointerPagePort,
    MediaPagePort,
    PageToolCommandPort,
    DanmakuControllerPagePort,
    DrawingControllerPagePort
{
  readonly #api: ChromiumPageCollaborationApi;
  readonly #onCapability: ((report: PageCapabilityReport) => void) | undefined;
  readonly #onPermissionBoundaryChanged: (() => void | Promise<void>) | undefined;
  readonly #onPageToolFrameUnavailable:
    ((tabId: number, frameId: number, frameKey: string) => void) | undefined;
  readonly #excludedOriginPatterns: ReadonlySet<string>;
  readonly #originAccess:
    | {
        listAllowedOrigins(): Promise<readonly string[]>;
        isOriginAllowed(origin: string): Promise<boolean>;
      }
    | undefined;
  readonly #reportedCapabilities = new Map<string, string>();
  readonly #trackedTabs = new Map<number, TrackedTabFrames>();
  readonly #permissionEpochs = new Map<string, number>();
  readonly #pendingInjections = new Map<string, PendingInjection>();
  readonly #ambiguityProbes = new Set<string>();
  #registrationTail = Promise.resolve();
  #activePermissionBoundaries = 0;
  #nextRootGeneration = 1;

  public constructor(
    api: ChromiumPageCollaborationApi,
    options: ChromePageCollaborationPortOptions = {},
  ) {
    this.#api = api;
    this.#onCapability = options.onCapability;
    this.#onPermissionBoundaryChanged = options.onPermissionBoundaryChanged;
    this.#onPageToolFrameUnavailable = options.onPageToolFrameUnavailable;
    this.#excludedOriginPatterns = new Set(options.excludedOriginPatterns ?? []);
    this.#originAccess = options.originAccess;
    this.#api.permissions.onAdded?.addListener(() => {
      void this.#scheduleRegisteredContentScriptSync();
    });
    this.#api.permissions.onRemoved?.addListener((permissions) => {
      void Promise.all([
        this.#handlePermissionsRemoved(permissions.origins ?? []),
        this.#scheduleRegisteredContentScriptSync(),
      ]);
    });
  }

  public async initialize(): Promise<void> {
    await this.#scheduleRegisteredContentScriptSync();
  }

  public async refreshOriginAccess(): Promise<void> {
    const disallowed = new Set<string>();
    for (const tracked of this.#trackedTabs.values()) {
      if (!(await this.#isOriginPatternAllowed(tracked.rootOriginPattern))) {
        disallowed.add(tracked.rootOriginPattern);
      }
      for (const frame of tracked.frames.values()) {
        if (!(await this.#isOriginPatternAllowed(frame.originPattern))) {
          disallowed.add(frame.originPattern);
        }
      }
    }
    if (disallowed.size > 0) {
      await this.#handlePermissionsRemoved([...disallowed]);
    }
    await this.#scheduleRegisteredContentScriptSync();
  }

  public async announceExistingPages(): Promise<void> {
    const announce = PageAnnounceMessageSchema.parse({
      type: "syncaction.page.announce",
    });
    const tabs = await this.#api.tabs.query({});
    for (const tab of tabs) {
      if (tab.id === undefined || !LocalTabIdSchema.safeParse(tab.id).success) {
        continue;
      }
      const originPattern = originPatternForUrl(tab.url ?? tab.pendingUrl);
      if (
        originPattern === null ||
        !(await this.#isOriginPatternAllowed(originPattern)) ||
        !(await this.#api.permissions.contains({ origins: [originPattern] }))
      ) {
        continue;
      }
      try {
        await this.#api.tabs.sendMessage(tab.id, announce);
      } catch {
        // Only documents with an already-installed all-frame runtime answer.
      }
    }
  }

  public registerPageToolFrame(
    tabIdInput: unknown,
    frameIdInput: unknown,
    frameKeyInput: unknown,
  ): boolean {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const collaborationFrameKey = CollaborationFrameKeySchema.parse(frameKeyInput);
    const tracked = this.#trackedTabs.get(tabId);
    const frame = tracked?.frames.get(frameId);
    if (tracked === undefined || frame === undefined) {
      return false;
    }
    frame.collaborationFrameKey = collaborationFrameKey;
    const duplicates = [...tracked.frames.entries()].filter(
      ([, candidate]) => candidate.collaborationFrameKey === collaborationFrameKey,
    );
    if (duplicates.length > 1) {
      const firstAmbiguity = !tracked.ambiguousFrameKeys.has(collaborationFrameKey);
      tracked.ambiguousFrameKeys.add(collaborationFrameKey);
      for (const [duplicateFrameId] of duplicates) {
        this.#reportCapability(tabId, duplicateFrameId, "DEGRADED", "DUPLICATE_FRAME_IDENTITY");
        if (firstAmbiguity) {
          this.#onPageToolFrameUnavailable?.(tabId, duplicateFrameId, collaborationFrameKey);
        }
      }
      this.#scheduleAmbiguityProbe(tabId, collaborationFrameKey, tracked.rootGeneration);
      return false;
    }
    tracked.ambiguousFrameKeys.delete(collaborationFrameKey);
    return true;
  }

  public pageToolRootGeneration(tabIdInput: unknown, frameIdInput: unknown): number | null {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const tracked = this.#trackedTabs.get(tabId);
    return tracked?.frames.has(frameId) === true ? tracked.rootGeneration : null;
  }

  public async ensureInjected(
    tabIdInput: number,
    frameIdInput = 0,
    frameUrlInput?: unknown,
  ): Promise<boolean> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const key = frameKey(tabId, frameId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const tab = await this.#api.tabs.get(tabId);
      const rootDocumentUrl = readDocumentUrl(tab.url ?? tab.pendingUrl);
      if (
        frameId !== 0 &&
        (typeof frameUrlInput !== "string" ||
          frameUrlInput.length < 1 ||
          frameUrlInput.length > 8_192)
      ) {
        this.#reportCapability(tabId, frameId, "DEGRADED", "FRAME_DOCUMENT_URL_REQUIRED");
        return false;
      }
      const frameDocumentUrl = frameId === 0 ? rootDocumentUrl : (frameUrlInput as string);
      const identity = injectionIdentity(rootDocumentUrl, frameDocumentUrl);
      const existing = this.#pendingInjections.get(key);
      if (existing !== undefined) {
        if (existing.identity === identity) {
          return existing.promise;
        }
        await existing.promise.catch(() => false);
        continue;
      }
      const promise = this.#inject(tabId, frameId, rootDocumentUrl, frameDocumentUrl);
      const pending = { identity, promise };
      this.#pendingInjections.set(key, pending);
      try {
        return await promise;
      } finally {
        if (this.#pendingInjections.get(key) === pending) {
          this.#pendingInjections.delete(key);
        }
      }
    }
    this.#reportCapability(tabId, frameId, "DEGRADED", "DOCUMENT_NAVIGATION_UNSTABLE");
    return false;
  }

  public async validateOutboundMessage(message: ParsedPageOutboundMessage): Promise<boolean> {
    const tabId = LocalTabIdSchema.parse(message.tabId);
    const frameId = FrameIdSchema.parse(message.frameId);
    const pending = this.#pendingInjections.get(frameKey(tabId, frameId))?.promise;
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        return false;
      }
    }
    if (message.documentUrl === null) {
      return false;
    }
    if (message.message.type === "page.compatibility.report") {
      if (frameId !== 0) {
        return false;
      }
      try {
        if (
          message.message.contentContext.canonicalPageIdentity !==
          canonicalSharedPageIdentity(message.documentUrl)
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    let tab: ChromiumPageCollaborationTab;
    try {
      tab = await this.#api.tabs.get(tabId);
    } catch {
      return false;
    }
    const rootDocumentUrl = tab.url ?? tab.pendingUrl;
    const rootOriginPattern = originPatternForUrl(rootDocumentUrl);
    const documentOriginPattern = originPatternForUrl(message.documentUrl);
    if (
      rootOriginPattern === null ||
      documentOriginPattern === null ||
      (frameId === 0 && !sameDocumentUrl(rootDocumentUrl, message.documentUrl))
    ) {
      return false;
    }
    let tracked = this.#trackedTabs.get(tabId);
    let frame = tracked?.frames.get(frameId);
    const rootIdentityChanged =
      tracked !== undefined &&
      (tracked.rootOriginPattern !== rootOriginPattern ||
        !sameDocumentUrl(tracked.rootDocumentUrl, rootDocumentUrl));
    const frameIdentityChanged =
      frame !== undefined &&
      (frame.originPattern !== documentOriginPattern ||
        !sameDocumentUrl(frame.documentUrl, message.documentUrl) ||
        (frame.documentId !== null &&
          message.documentId !== null &&
          frame.documentId !== message.documentId));
    if (
      (tracked === undefined ||
        frame === undefined ||
        rootIdentityChanged ||
        frameIdentityChanged) &&
      message.documentLifecycle === "active" &&
      (message.message.type === "syncaction.page.ready" ||
        message.message.type === "syncaction.page.capability")
    ) {
      const [rootPermitted, documentPermitted, rootAllowed, documentAllowed] = await Promise.all([
        this.#api.permissions.contains({ origins: [rootOriginPattern] }),
        this.#api.permissions.contains({ origins: [documentOriginPattern] }),
        this.#isOriginPatternAllowed(rootOriginPattern),
        this.#isOriginPatternAllowed(documentOriginPattern),
      ]);
      if (rootPermitted && documentPermitted && rootAllowed && documentAllowed) {
        this.#trackFrame(tabId, frameId, {
          rootOriginPattern,
          rootDocumentUrl: readDocumentUrl(rootDocumentUrl),
          frame: {
            originPattern: documentOriginPattern,
            documentUrl: message.documentUrl,
            documentId: message.documentId,
            collaborationFrameKey: null,
          },
        });
        tracked = this.#trackedTabs.get(tabId);
        frame = tracked?.frames.get(frameId);
      }
    }
    if (
      tracked === undefined ||
      tracked.rootOriginPattern !== rootOriginPattern ||
      !sameDocumentUrl(tracked.rootDocumentUrl, rootDocumentUrl) ||
      frame === undefined ||
      frame.originPattern !== documentOriginPattern ||
      !sameDocumentUrl(frame.documentUrl, message.documentUrl) ||
      (frame.documentId !== null &&
        message.documentId !== null &&
        frame.documentId !== message.documentId)
    ) {
      return false;
    }
    const [documentPermitted, rootAllowed, documentAllowed] = await Promise.all([
      this.#api.permissions.contains({ origins: [documentOriginPattern] }),
      this.#isOriginPatternAllowed(rootOriginPattern),
      this.#isOriginPatternAllowed(documentOriginPattern),
    ]);
    const permitted = documentPermitted && rootAllowed && documentAllowed;
    if (
      permitted &&
      frame.collaborationFrameKey !== null &&
      tracked.ambiguousFrameKeys.has(frame.collaborationFrameKey) &&
      "controller" in message.message &&
      (message.message.controller === "danmaku" || message.message.controller === "drawing")
    ) {
      return false;
    }
    if (permitted && message.message.type === "syncaction.page.capability") {
      this.#rememberCapability(tabId, frameId, message.message);
    }
    return permitted;
  }

  public async verifyInjected(tabIdInput: number, frameIdInput = 0): Promise<boolean> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const pending = this.#pendingInjections.get(frameKey(tabId, frameId))?.promise;
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        return false;
      }
    }
    let tab: ChromiumPageCollaborationTab;
    try {
      tab = await this.#api.tabs.get(tabId);
    } catch {
      return false;
    }
    const rootDocumentUrl = tab.url ?? tab.pendingUrl;
    const rootOriginPattern = originPatternForUrl(rootDocumentUrl);
    const tracked = this.#trackedTabs.get(tabId);
    const frame = tracked?.frames.get(frameId);
    if (
      rootOriginPattern === null ||
      tracked === undefined ||
      tracked.rootOriginPattern !== rootOriginPattern ||
      !sameDocumentUrl(tracked.rootDocumentUrl, rootDocumentUrl) ||
      frame === undefined ||
      (frameId === 0 && !sameDocumentUrl(frame.documentUrl, rootDocumentUrl))
    ) {
      return false;
    }
    const [originAllowed, permitted] = await Promise.all([
      this.#isOriginPatternAllowed(frame.originPattern),
      this.#api.permissions.contains({ origins: [frame.originPattern] }),
    ]);
    return originAllowed && permitted;
  }

  public async observe(
    tabIdInput: number,
    frameIdInput: number,
    contextInput: MediaPageContext,
    targetInput?: MediaTarget,
  ): Promise<void> {
    const { tabId, frameId } = await this.#requireMediaDocument(tabIdInput, frameIdInput);
    await this.#send(
      tabId,
      MediaCommandMessageSchema.parse({
        type: "syncaction.media.command",
        context: contextInput,
        operation: {
          type: "OBSERVE",
          ...(targetInput === undefined ? {} : { target: targetInput }),
        },
      }),
      frameId,
    );
  }

  public async apply(
    tabIdInput: number,
    frameIdInput: number,
    contextInput: MediaPageContext,
    targetInput: MediaTarget,
    actionInput: MediaPageApplyAction,
    applyTokenInput: string,
  ): Promise<void> {
    const { tabId, frameId } = await this.#requireMediaDocument(tabIdInput, frameIdInput);
    await this.#send(
      tabId,
      MediaCommandMessageSchema.parse({
        type: "syncaction.media.command",
        context: contextInput,
        operation: {
          type: "APPLY",
          applyToken: applyTokenInput,
          target: targetInput,
          action: actionInput,
        },
      }),
      frameId,
    );
  }

  public async setFollowerLock(
    tabIdInput: number,
    frameIdInput: number,
    contextInput: MediaPageContext,
    targetInput: MediaTarget,
    locked: boolean,
  ): Promise<void> {
    const { tabId, frameId } = await this.#requireMediaDocument(tabIdInput, frameIdInput);
    await this.#send(
      tabId,
      MediaCommandMessageSchema.parse({
        type: "syncaction.media.command",
        context: contextInput,
        operation: {
          type: "SET_FOLLOWER_LOCK",
          locked,
          target: targetInput,
        },
      }),
      frameId,
    );
  }

  public async toggleDanmakuInput(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
  ): Promise<PageCapabilityMessage> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const response = await this.#send(
      tabId,
      DanmakuCommandMessageSchema.parse({
        type: "syncaction.danmaku.command",
        controller: "danmaku",
        context,
        action: "TOGGLE_INPUT",
      }),
      frameId,
      documentId,
    );
    if (response === null) {
      throw pageToolReachableDegradedError("PAGE_TOOL_RESPONSE_INVALID");
    }
    return response;
  }

  public async setDanmakuHidden(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    hidden: boolean,
  ): Promise<PageCapabilityMessage> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const response = await this.#send(
      tabId,
      DanmakuCommandMessageSchema.parse({
        type: "syncaction.danmaku.command",
        controller: "danmaku",
        context,
        action: hidden ? "HIDE" : "SHOW",
      }),
      frameId,
      documentId,
    );
    if (response === null) {
      throw pageToolReachableDegradedError("PAGE_TOOL_RESPONSE_INVALID");
    }
    return response;
  }

  public async togglePagePen(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
  ): Promise<PageCapabilityMessage> {
    const targets = await this.#pageToolTargets(tabIdInput, contextInput);
    const primaryTargetIndex = targets.findIndex(
      ({ frameId, context }) => frameId === 0 && context.frameKey === "top",
    );
    if (primaryTargetIndex < 0) {
      throw new Error("PAGE_TOOL_PERMISSION_REQUIRED");
    }
    const results = await Promise.allSettled(
      targets.map(({ tabId, frameId, context, documentId }) =>
        this.#send(
          tabId,
          DrawingCommandMessageSchema.parse({
            type: "syncaction.drawing.command",
            controller: "drawing",
            context,
            action: { type: "TOGGLE_PEN" },
          }),
          frameId,
          documentId,
        ),
      ),
    );
    const primaryResult = results[primaryTargetIndex];
    if (primaryResult?.status !== "fulfilled") {
      throw primaryResult?.reason instanceof Error
        ? primaryResult.reason
        : new Error("PAGE_TOOL_PERMISSION_REQUIRED");
    }
    if (primaryResult.value === null) {
      throw pageToolReachableDegradedError("PAGE_TOOL_RESPONSE_INVALID");
    }
    return primaryResult.value;
  }

  public async setDanmakuStatus(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    status: {
      status: "IDLE" | "SENDING" | "SENT" | "FAILED";
      messageId: string | null;
      errorCode: DanmakuErrorCode | null;
    },
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    await this.#send(
      tabId,
      DanmakuStatusMessageSchema.parse({
        type: "syncaction.danmaku.status",
        controller: "danmaku",
        context,
        ...status,
      }),
      frameId,
      documentId,
    );
  }

  public async renderDanmaku(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    eventInput: DanmakuEventMessage,
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const event = DanmakuEventMessageSchema.parse(eventInput);
    await this.#send(
      tabId,
      DanmakuRenderMessageSchema.parse({
        type: "syncaction.danmaku.render",
        controller: "danmaku",
        context,
        event,
      }),
      frameId,
      documentId,
    );
  }

  public async clearDanmaku(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
  ): Promise<void> {
    const target = await this.#findInjectedPageToolDocument(tabIdInput, contextInput);
    if (target === null) {
      return;
    }
    const { tabId, frameId, context, documentId } = target;
    await this.#send(
      tabId,
      DanmakuClearMessageSchema.parse({
        type: "syncaction.danmaku.clear",
        controller: "danmaku",
        context,
      }),
      frameId,
      documentId,
    );
  }

  public async setDrawingViewer(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    viewerInput: { userId: string; role: "OWNER" | "MEMBER" },
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    await this.#send(
      tabId,
      DrawingViewerMessageSchema.parse({
        type: "syncaction.drawing.viewer",
        controller: "drawing",
        context,
        viewer: viewerInput,
      }),
      frameId,
      documentId,
    );
  }

  public async renderAnnotationSnapshot(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    snapshotInput: AnnotationSnapshotV2Message,
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const snapshot = AnnotationSnapshotV2MessageSchema.parse(snapshotInput);
    await this.#send(
      tabId,
      AnnotationSnapshotPageMessageSchema.parse({
        type: "syncaction.annotation.snapshot",
        controller: "drawing",
        context,
        snapshot,
      }),
      frameId,
      documentId,
    );
  }

  public async renderAnnotationCommitted(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    committedInput: AnnotationCommittedOperationV2,
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const committed = AnnotationCommittedOperationV2Schema.parse(committedInput);
    await this.#send(
      tabId,
      AnnotationCommittedPageMessageSchema.parse({
        type: "syncaction.annotation.committed",
        controller: "drawing",
        context,
        committed,
      }),
      frameId,
      documentId,
    );
  }

  public async renderAnnotationAcknowledgement(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    acknowledgementInput: AnnotationAckV2,
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const acknowledgement = AnnotationAckV2Schema.parse(acknowledgementInput);
    await this.#send(
      tabId,
      AnnotationAckPageMessageSchema.parse({
        type: "syncaction.annotation.ack",
        controller: "drawing",
        context,
        acknowledgement,
      }),
      frameId,
      documentId,
    );
  }

  public async renderLocalDraft(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    draftInput: AnnotationStrokeDraftV2,
    status: "PENDING" | "ERROR",
    retryable = false,
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const draft = AnnotationStrokeDraftV2Schema.parse(draftInput);
    await this.#send(
      tabId,
      AnnotationDraftPageMessageSchema.parse({
        type: "syncaction.annotation.draft",
        controller: "drawing",
        context,
        draft,
        status,
        retryable,
      }),
      frameId,
      documentId,
    );
  }

  public async renderStrokePreview(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    previewInput: StrokePreviewEventMessage,
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const preview = StrokePreviewEventMessageSchema.parse(previewInput);
    await this.#send(
      tabId,
      StrokePreviewRenderPageMessageSchema.parse({
        type: "syncaction.stroke.preview.render",
        controller: "drawing",
        context,
        preview,
      }),
      frameId,
      documentId,
    );
  }

  public async clearStrokePreview(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    clearInput: StrokePreviewClearMessage,
  ): Promise<void> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    const clear = StrokePreviewClearMessageSchema.parse(clearInput);
    await this.#send(
      tabId,
      StrokePreviewClearPageMessageSchema.parse({
        type: "syncaction.stroke.preview.clear",
        controller: "drawing",
        context,
        clear,
      }),
      frameId,
      documentId,
    );
  }

  public async clearDrawing(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
  ): Promise<void> {
    const target = await this.#findInjectedPageToolDocument(tabIdInput, contextInput);
    if (target === null) {
      return;
    }
    const { tabId, frameId, context, documentId } = target;
    await this.#send(
      tabId,
      DrawingClearMessageSchema.parse({
        type: "syncaction.drawing.clear",
        controller: "drawing",
        context,
      }),
      frameId,
      documentId,
    );
  }

  public async resolveElementAnchorSignature(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
    pathInput: readonly PointerPathSegment[],
  ): Promise<ContentSignature | null> {
    const { tabId, frameId, context, documentId } = await this.#requirePageToolDocument(
      tabIdInput,
      contextInput,
    );
    if (this.#activePermissionBoundaries > 0) {
      throw new Error("PAGE_PERMISSION_BOUNDARY_ACTIVE");
    }
    const request = ElementAnchorSignatureRequestSchema.parse({
      type: "syncaction.annotation.anchor-signature.request",
      controller: "drawing",
      context,
      path: pathInput,
    });
    const frame = this.#trackedTabs.get(tabId)?.frames.get(frameId);
    if (frame?.documentId !== documentId) {
      throw new Error("PAGE_DOCUMENT_CHANGED");
    }
    let response: unknown;
    try {
      response = await this.#api.tabs.sendMessage(
        tabId,
        request,
        documentId === null ? { frameId } : { frameId, documentId },
      );
    } catch (cause) {
      if (frame !== undefined) {
        this.#evictTrackedFrame(tabId, frameId, frame);
      }
      throw cause;
    }
    if (this.#trackedTabs.get(tabId)?.frames.get(frameId)?.documentId !== documentId) {
      throw new Error("PAGE_DOCUMENT_CHANGED");
    }
    const parsed = ElementAnchorSignatureResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw pageToolReachableDegradedError("PAGE_TOOL_RESPONSE_INVALID");
    }
    return parsed.data.signature === null ? null : structuredClone(parsed.data.signature);
  }

  public async setContext(
    tabIdInput: number,
    contextInput: PointerPageContext,
    frameIdInput = 0,
  ): Promise<void> {
    const context = PointerPageContextSchema.parse(contextInput);
    await this.#send(
      tabIdInput,
      PointerContextMessageSchema.parse({
        type: "syncaction.pointer.context",
        context,
      }),
      frameIdInput,
    );
  }

  public async render(
    tabIdInput: number,
    pointerInput: PointerRecord,
    frameIdInput = 0,
  ): Promise<void> {
    const pointer = PointerRecordSchema.parse(pointerInput);
    await this.#send(
      tabIdInput,
      PointerRenderMessageSchema.parse({
        type: "syncaction.pointer.render",
        pointer,
      }),
      frameIdInput,
    );
  }

  public async renderLease(
    tabIdInput: number,
    leaseInput: PointerLeaseRecord,
    frameIdInput = 0,
  ): Promise<void> {
    const lease = PointerLeaseRecordSchema.parse(leaseInput);
    await this.#send(
      tabIdInput,
      PointerLeaseRenderMessageSchema.parse({
        type: "syncaction.pointer.lease",
        lease,
      }),
      frameIdInput,
    );
  }

  public async renderFrame(
    tabIdInput: number,
    frameInput: PointerFrameEvent,
    frameIdInput = 0,
  ): Promise<void> {
    const frame = PointerFrameEventSchema.parse(frameInput);
    await this.#send(
      tabIdInput,
      PointerFrameRenderMessageSchema.parse({
        type: "syncaction.pointer.frame",
        frame,
      }),
      frameIdInput,
    );
  }

  public async clear(
    tabIdInput: number,
    identityInput?: PointerIdentity,
    frameIdInput = 0,
  ): Promise<void> {
    await this.#send(
      tabIdInput,
      PointerClearMessageSchema.parse({
        type: "syncaction.pointer.clear",
        identity: identityInput ?? null,
      }),
      frameIdInput,
    );
  }

  public async dispose(
    tabIdInput: number,
    frameIdInput = 0,
    reason: PageDisposeReason = "BACKGROUND_STOPPED",
  ): Promise<void> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    try {
      await this.#send(
        tabId,
        PageDisposeMessageSchema.parse({
          type: "syncaction.page.dispose",
          reason,
        }),
        frameId,
      );
    } finally {
      this.#forgetFrame(tabId, frameId);
    }
  }

  public async removeOriginForTab(tabIdInput: number): Promise<boolean> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const selected = await this.#api.tabs.get(tabId);
    const originPattern = originPatternForUrl(selected.url ?? selected.pendingUrl);
    if (originPattern === null) {
      return false;
    }
    return this.removeOrigin(originPattern.slice(0, -2));
  }

  public async removeOrigin(originInput: string): Promise<boolean> {
    const originPattern = originPatternForUrl(originInput);
    if (originPattern === null || originPattern.slice(0, -2) !== originInput) {
      throw new Error("INVALID_PAGE_ORIGIN");
    }
    const tabs = await this.#api.tabs.query({});
    for (const tab of tabs) {
      if (
        tab.id !== undefined &&
        LocalTabIdSchema.safeParse(tab.id).success &&
        originPatternForUrl(tab.url ?? tab.pendingUrl) === originPattern
      ) {
        const tracked = this.#trackedTabs.get(tab.id);
        const frameIds =
          tracked?.rootOriginPattern === originPattern
            ? [...tracked.frames.keys()].sort((left, right) => left - right)
            : [0];
        for (const frameId of frameIds) {
          try {
            await this.dispose(tab.id, frameId, "ORIGIN_REVOKED");
          } catch {
            // A page without an injected runtime is already disposed.
          }
        }
        this.#trackedTabs.delete(tab.id);
      }
    }
    return this.#api.permissions.remove({ origins: [originPattern] });
  }

  async #requireMediaDocument(
    tabIdInput: number,
    frameIdInput: number,
  ): Promise<{ tabId: number; frameId: number }> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    let injected = await this.verifyInjected(tabId, frameId);
    if (!injected && frameId === 0) {
      injected = await this.ensureInjected(tabId);
    }
    if (!injected) {
      throw new Error("MEDIA_PERMISSION_REQUIRED");
    }
    return { tabId, frameId };
  }

  async #requirePageToolDocument(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
  ): Promise<{
    tabId: number;
    frameId: number;
    context: CollaborationPageContext;
    documentId: string | null;
  }> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const context = CollaborationPageContextSchema.parse(contextInput);
    let candidates = this.#pageToolFrameCandidates(tabId, context.frameKey);
    if (candidates.length === 0 && context.frameKey === "top") {
      await this.ensureInjected(tabId, 0);
      this.registerPageToolFrame(tabId, 0, "top");
      candidates = this.#pageToolFrameCandidates(tabId, context.frameKey);
    }
    if (candidates.length !== 1) {
      throw new Error("PAGE_TOOL_PERMISSION_REQUIRED");
    }
    const frameId = candidates[0]!;
    if (!(await this.verifyInjected(tabId, frameId))) {
      throw new Error("PAGE_TOOL_PERMISSION_REQUIRED");
    }
    const documentId = this.#trackedTabs.get(tabId)?.frames.get(frameId)?.documentId ?? null;
    return { tabId, frameId, context, documentId };
  }

  async #findInjectedPageToolDocument(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
  ): Promise<{
    tabId: number;
    frameId: number;
    context: CollaborationPageContext;
    documentId: string | null;
  } | null> {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const context = CollaborationPageContextSchema.parse(contextInput);
    const candidates = this.#pageToolFrameCandidates(tabId, context.frameKey);
    if (candidates.length !== 1 || !(await this.verifyInjected(tabId, candidates[0]!))) {
      return null;
    }
    const frameId = candidates[0]!;
    const documentId = this.#trackedTabs.get(tabId)?.frames.get(frameId)?.documentId ?? null;
    return { tabId, frameId, context, documentId };
  }

  async #pageToolTargets(
    tabIdInput: number,
    contextInput: CollaborationPageContext,
  ): Promise<
    Array<{
      tabId: number;
      frameId: number;
      context: CollaborationPageContext;
      documentId: string | null;
    }>
  > {
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const base = CollaborationPageContextSchema.parse(contextInput);
    const tracked = this.#trackedTabs.get(tabId);
    if (tracked === undefined) {
      return [await this.#requirePageToolDocument(tabId, base)];
    }
    const frameKeyCounts = new Map<string, number>();
    for (const frame of tracked.frames.values()) {
      if (frame.collaborationFrameKey !== null) {
        frameKeyCounts.set(
          frame.collaborationFrameKey,
          (frameKeyCounts.get(frame.collaborationFrameKey) ?? 0) + 1,
        );
      }
    }
    const targets: Array<{
      tabId: number;
      frameId: number;
      context: CollaborationPageContext;
      documentId: string | null;
    }> = [];
    for (const [frameId, frame] of [...tracked.frames.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      const frameKey = frame.collaborationFrameKey;
      if (
        frameKey === null ||
        frameKeyCounts.get(frameKey) !== 1 ||
        tracked.ambiguousFrameKeys.has(frameKey) ||
        !(await this.verifyInjected(tabId, frameId))
      ) {
        continue;
      }
      targets.push({
        tabId,
        frameId,
        documentId: frame.documentId,
        context: CollaborationPageContextSchema.parse({
          ...base,
          frameKey,
        }),
      });
    }
    if (targets.length === 0) {
      throw new Error("PAGE_TOOL_PERMISSION_REQUIRED");
    }
    return targets;
  }

  #pageToolFrameCandidates(tabId: number, collaborationFrameKey: string): number[] {
    const tracked = this.#trackedTabs.get(tabId);
    if (tracked === undefined) {
      return [];
    }
    if (tracked.ambiguousFrameKeys.has(collaborationFrameKey)) {
      return [];
    }
    return [...tracked.frames.entries()]
      .filter(([, frame]) => frame.collaborationFrameKey === collaborationFrameKey)
      .map(([frameId]) => frameId);
  }

  async #send(
    tabIdInput: number,
    message: unknown,
    frameIdInput: number,
    expectedDocumentId?: string | null,
  ): Promise<PageCapabilityMessage | null> {
    if (this.#activePermissionBoundaries > 0) {
      throw new Error("PAGE_PERMISSION_BOUNDARY_ACTIVE");
    }
    const tabId = LocalTabIdSchema.parse(tabIdInput);
    const frameId = FrameIdSchema.parse(frameIdInput);
    const frame = this.#trackedTabs.get(tabId)?.frames.get(frameId);
    if (expectedDocumentId !== undefined && frame?.documentId !== expectedDocumentId) {
      throw new Error("PAGE_DOCUMENT_CHANGED");
    }
    const documentId =
      expectedDocumentId !== undefined ? expectedDocumentId : (frame?.documentId ?? null);
    let response: unknown;
    try {
      response = await this.#api.tabs.sendMessage(
        tabId,
        message,
        documentId === null ? { frameId } : { frameId, documentId },
      );
    } catch (cause) {
      if (frame !== undefined) {
        this.#evictTrackedFrame(tabId, frameId, frame);
      }
      throw cause;
    }
    const expectedCapability = pageToolResponseCapability(message);
    if (expectedCapability === null) {
      return null;
    }
    const parsedResponse = PageCapabilityMessageSchema.safeParse(response);
    if (!parsedResponse.success || parsedResponse.data.capability !== expectedCapability) {
      this.#reportCapability(
        tabId,
        frameId,
        "DEGRADED",
        "PAGE_TOOL_RESPONSE_INVALID",
        expectedCapability,
      );
      throw pageToolReachableDegradedError("PAGE_TOOL_RESPONSE_INVALID");
    }
    this.#reportCapability(
      tabId,
      frameId,
      parsedResponse.data.state,
      parsedResponse.data.errorCode,
      expectedCapability,
    );
    if (parsedResponse.data.state === "DEGRADED") {
      throw pageToolReachableDegradedError(parsedResponse.data.errorCode);
    }
    return parsedResponse.data;
  }

  async #inject(
    tabId: number,
    frameId: number,
    rootDocumentUrl: string,
    frameDocumentUrl: string,
  ): Promise<boolean> {
    const rootOriginPattern = originPatternForUrl(rootDocumentUrl);
    const frameOriginPattern = originPatternForUrl(frameDocumentUrl);
    if (rootOriginPattern === null || frameOriginPattern === null) {
      this.#reportCapability(tabId, frameId, "DEGRADED", "PROTECTED_PAGE");
      return false;
    }
    const [rootAllowed, frameAllowed, framePermitted] = await Promise.all([
      this.#isOriginPatternAllowed(rootOriginPattern),
      this.#isOriginPatternAllowed(frameOriginPattern),
      this.#api.permissions.contains({ origins: [frameOriginPattern] }),
    ]);
    if (!rootAllowed || !frameAllowed || !framePermitted) {
      this.#reportCapability(tabId, frameId, "DEGRADED", "ORIGIN_PERMISSION_REQUIRED");
      return false;
    }
    const rootEpoch = this.#permissionEpoch(rootOriginPattern);
    const frameEpoch = this.#permissionEpoch(frameOriginPattern);
    let results: Array<{ frameId?: number; documentId?: string }>;
    try {
      results = await this.#api.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ["page-collaboration.js"],
      });
    } catch {
      this.#reportCapability(tabId, frameId, "DEGRADED", "PAGE_INJECTION_FAILED");
      return false;
    }
    const result = results.find((candidate) => candidate.frameId === frameId) ?? results[0];
    let currentRootDocumentUrl: string;
    try {
      const currentTab = await this.#api.tabs.get(tabId);
      currentRootDocumentUrl = readDocumentUrl(currentTab.url ?? currentTab.pendingUrl);
    } catch {
      await this.#disposeInjectionResult(tabId, frameId, result);
      return false;
    }
    const permissionStillValid =
      sameDocumentUrl(currentRootDocumentUrl, rootDocumentUrl) &&
      rootEpoch === this.#permissionEpoch(rootOriginPattern) &&
      frameEpoch === this.#permissionEpoch(frameOriginPattern) &&
      (await this.#api.permissions.contains({ origins: [frameOriginPattern] })) &&
      (await this.#isOriginPatternAllowed(rootOriginPattern)) &&
      (await this.#isOriginPatternAllowed(frameOriginPattern));
    if (!permissionStillValid) {
      await this.#disposeInjectionResult(tabId, frameId, result);
      this.#reportCapability(
        tabId,
        frameId,
        "DEGRADED",
        sameDocumentUrl(currentRootDocumentUrl, rootDocumentUrl)
          ? "ORIGIN_PERMISSION_REVOKED"
          : "DOCUMENT_CHANGED_DURING_INJECTION",
      );
      return false;
    }
    this.#trackFrame(tabId, frameId, {
      rootOriginPattern,
      rootDocumentUrl,
      frame: {
        originPattern: frameOriginPattern,
        documentUrl: frameDocumentUrl,
        documentId:
          typeof result?.documentId === "string" && result.documentId.length > 0
            ? result.documentId
            : null,
        collaborationFrameKey: null,
      },
    });
    return true;
  }

  async #disposeInjectionResult(
    tabId: number,
    frameId: number,
    result: { frameId?: number; documentId?: string } | undefined,
  ): Promise<void> {
    try {
      await this.#api.tabs.sendMessage(
        tabId,
        PageDisposeMessageSchema.parse({
          type: "syncaction.page.dispose",
          reason: "ORIGIN_REVOKED",
        }),
        typeof result?.documentId === "string" && result.documentId.length > 0
          ? { documentId: result.documentId }
          : { frameId },
      );
    } catch {
      // A replaced or just-revoked document can be unreachable before cleanup is delivered.
    }
  }

  #reportCapability(
    tabId: number,
    frameId: number,
    state: "AVAILABLE" | "DEGRADED",
    errorCode: string | null,
    capability: "PAGE_HOST" | "DANMAKU" | "DRAWING" = "PAGE_HOST",
  ): void {
    const message = PageCapabilityMessageSchema.parse({
      type: "syncaction.page.capability",
      capability,
      state,
      errorCode,
    });
    const key = `${frameKey(tabId, frameId)}:${message.capability}`;
    const signature = `${message.state}:${message.errorCode ?? ""}`;
    if (this.#reportedCapabilities.get(key) === signature) {
      return;
    }
    this.#reportedCapabilities.set(key, signature);
    this.#onCapability?.({
      tabId,
      frameId,
      message,
    });
  }

  #rememberCapability(
    tabId: number,
    frameId: number,
    message: PageCapabilityReport["message"],
  ): void {
    this.#reportedCapabilities.set(
      `${frameKey(tabId, frameId)}:${message.capability}`,
      `${message.state}:${message.errorCode ?? ""}`,
    );
  }

  #trackFrame(
    tabId: number,
    frameId: number,
    input: {
      rootOriginPattern: string;
      rootDocumentUrl: string;
      frame: TrackedFrameDocument;
    },
  ): void {
    let tracked = this.#trackedTabs.get(tabId);
    if (
      tracked === undefined ||
      tracked.rootOriginPattern !== input.rootOriginPattern ||
      !sameDocumentUrl(tracked.rootDocumentUrl, input.rootDocumentUrl)
    ) {
      tracked = {
        rootOriginPattern: input.rootOriginPattern,
        rootDocumentUrl: input.rootDocumentUrl,
        rootGeneration: this.#nextRootGeneration,
        frames: new Map(),
        ambiguousFrameKeys: new Set(),
      };
      this.#nextRootGeneration += 1;
      this.#trackedTabs.set(tabId, tracked);
    }
    const replacedFrameKey = tracked.frames.get(frameId)?.collaborationFrameKey ?? null;
    tracked.frames.set(frameId, input.frame);
    if (replacedFrameKey !== null) {
      this.#recoverUniqueFrameKey(tabId, replacedFrameKey, tracked.rootGeneration);
    }
  }

  #forgetFrame(tabId: number, frameId: number): void {
    const tracked = this.#trackedTabs.get(tabId);
    if (tracked === undefined) {
      return;
    }
    const removed = tracked.frames.get(frameId);
    tracked.frames.delete(frameId);
    if (tracked.frames.size === 0) {
      this.#trackedTabs.delete(tabId);
      return;
    }
    if (removed?.collaborationFrameKey !== null && removed?.collaborationFrameKey !== undefined) {
      this.#recoverUniqueFrameKey(tabId, removed.collaborationFrameKey, tracked.rootGeneration);
    }
  }

  #evictTrackedFrame(
    tabId: number,
    frameId: number,
    expected: TrackedFrameDocument,
    recover = true,
  ): boolean {
    const tracked = this.#trackedTabs.get(tabId);
    if (tracked?.frames.get(frameId) !== expected) {
      return false;
    }
    const collaborationFrameKey = expected.collaborationFrameKey;
    const rootGeneration = tracked.rootGeneration;
    if (frameId === 0) {
      this.#trackedTabs.delete(tabId);
    } else {
      tracked.frames.delete(frameId);
      if (tracked.frames.size === 0) {
        this.#trackedTabs.delete(tabId);
      }
    }
    if (collaborationFrameKey !== null) {
      this.#onPageToolFrameUnavailable?.(tabId, frameId, collaborationFrameKey);
      if (recover) {
        this.#recoverUniqueFrameKey(tabId, collaborationFrameKey, rootGeneration);
      }
    }
    return true;
  }

  #scheduleAmbiguityProbe(
    tabId: number,
    collaborationFrameKey: string,
    rootGeneration: number,
  ): void {
    const probeKey = `${String(tabId)}:${String(rootGeneration)}:${collaborationFrameKey}`;
    if (this.#ambiguityProbes.has(probeKey)) {
      return;
    }
    this.#ambiguityProbes.add(probeKey);
    queueMicrotask(() => {
      void (async () => {
        try {
          const tracked = this.#trackedTabs.get(tabId);
          if (tracked?.rootGeneration !== rootGeneration) {
            return;
          }
          const announce = PageAnnounceMessageSchema.parse({
            type: "syncaction.page.announce",
          });
          const candidates = [...tracked.frames.entries()].filter(
            ([, frame]) => frame.collaborationFrameKey === collaborationFrameKey,
          );
          await Promise.allSettled(
            candidates.map(async ([frameId, frame]) => {
              try {
                await this.#api.tabs.sendMessage(
                  tabId,
                  announce,
                  frame.documentId === null
                    ? { frameId }
                    : { frameId, documentId: frame.documentId },
                );
              } catch {
                this.#evictTrackedFrame(tabId, frameId, frame, false);
              }
            }),
          );
        } finally {
          this.#ambiguityProbes.delete(probeKey);
          this.#recoverUniqueFrameKey(tabId, collaborationFrameKey, rootGeneration);
        }
      })();
    });
  }

  #recoverUniqueFrameKey(
    tabId: number,
    collaborationFrameKey: string,
    rootGeneration: number,
  ): void {
    const tracked = this.#trackedTabs.get(tabId);
    if (tracked?.rootGeneration !== rootGeneration) {
      return;
    }
    const candidates = [...tracked.frames.entries()].filter(
      ([, frame]) => frame.collaborationFrameKey === collaborationFrameKey,
    );
    if (candidates.length !== 1 || !tracked.ambiguousFrameKeys.has(collaborationFrameKey)) {
      return;
    }
    tracked.ambiguousFrameKeys.delete(collaborationFrameKey);
    const [frameId, frame] = candidates[0]!;
    const announce = PageAnnounceMessageSchema.parse({
      type: "syncaction.page.announce",
    });
    void this.#api.tabs
      .sendMessage(
        tabId,
        announce,
        frame.documentId === null ? { frameId } : { frameId, documentId: frame.documentId },
      )
      .catch(() => {
        this.#evictTrackedFrame(tabId, frameId, frame);
      });
  }

  async #handlePermissionsRemoved(origins: readonly string[]): Promise<void> {
    const removed = new Set(origins);
    if (removed.size === 0) {
      return;
    }
    this.#activePermissionBoundaries += 1;
    for (const origin of removed) {
      this.#permissionEpochs.set(origin, this.#permissionEpoch(origin) + 1);
    }
    const trackedTargets = [...this.#trackedTabs.entries()].flatMap(([tabId, tracked]) =>
      [...tracked.frames.entries()].map(([frameId, frame]) => ({
        tabId,
        frameId,
        documentId: frame.documentId,
      })),
    );
    this.#trackedTabs.clear();
    this.#reportedCapabilities.clear();
    try {
      const dispose = PageDisposeMessageSchema.parse({
        type: "syncaction.page.dispose",
        reason: "ORIGIN_REVOKED",
      });
      const expectedByTab = new Map<number, number>();
      const succeededByTab = new Map<number, number>();
      const failedTabs = new Set<number>();
      for (const target of trackedTargets) {
        expectedByTab.set(target.tabId, (expectedByTab.get(target.tabId) ?? 0) + 1);
        try {
          await this.#api.tabs.sendMessage(
            target.tabId,
            dispose,
            target.documentId === null
              ? { frameId: target.frameId }
              : { frameId: target.frameId, documentId: target.documentId },
          );
          succeededByTab.set(target.tabId, (succeededByTab.get(target.tabId) ?? 0) + 1);
        } catch {
          failedTabs.add(target.tabId);
          // A document can disappear while the permission boundary is being processed.
        }
      }
      const exactlyDisposedTabs = new Set(
        [...expectedByTab.entries()]
          .filter(
            ([tabId, expected]) => !failedTabs.has(tabId) && succeededByTab.get(tabId) === expected,
          )
          .map(([tabId]) => tabId),
      );
      const tabs = await this.#api.tabs.query({});
      for (const tab of tabs) {
        if (
          tab.id === undefined ||
          !LocalTabIdSchema.safeParse(tab.id).success ||
          exactlyDisposedTabs.has(tab.id)
        ) {
          continue;
        }
        try {
          await this.#api.tabs.sendMessage(tab.id, dispose);
        } catch {
          // MV3 may wake after a document was closed or before it has a collaboration runtime.
        }
      }
    } catch {
      // The boundary callback still invalidates controller state if tab enumeration fails.
    } finally {
      this.#activePermissionBoundaries -= 1;
      if (this.#activePermissionBoundaries === 0) {
        await this.#onPermissionBoundaryChanged?.();
      }
    }
  }

  #permissionEpoch(originPattern: string): number {
    return this.#permissionEpochs.get(originPattern) ?? 0;
  }

  #isOriginPatternAllowed(originPattern: string): Promise<boolean> {
    if (this.#originAccess === undefined) {
      return Promise.resolve(true);
    }
    return this.#originAccess.isOriginAllowed(originPattern.slice(0, -2));
  }

  #scheduleRegisteredContentScriptSync(): Promise<void> {
    const next = this.#registrationTail.then(() => this.#syncRegisteredContentScript());
    this.#registrationTail = next.catch(() => undefined);
    return next;
  }

  async #syncRegisteredContentScript(): Promise<void> {
    let candidates: string[];
    if (this.#originAccess === undefined) {
      const granted = await this.#api.permissions.getAll();
      candidates = [...new Set(granted.origins ?? [])];
    } else {
      const allowed = await this.#originAccess.listAllowedOrigins();
      candidates = [...new Set(allowed.map((origin) => `${origin}/*`))];
    }
    const exactCandidates = candidates.filter(
      (origin) => isExactWebOriginPattern(origin) && !this.#excludedOriginPatterns.has(origin),
    );
    const permitted = await Promise.all(
      exactCandidates.map(async (origin) => ({
        origin,
        granted: await this.#api.permissions.contains({ origins: [origin] }),
      })),
    );
    const matches = permitted
      .filter(({ granted }) => granted)
      .map(({ origin }) => origin)
      .sort();
    const registered = await this.#api.scripting.getRegisteredContentScripts({
      ids: [REGISTERED_PAGE_SCRIPT_ID],
    });
    const exists = registered.some((script) => script.id === REGISTERED_PAGE_SCRIPT_ID);
    if (matches.length === 0) {
      if (exists) {
        await this.#api.scripting.unregisterContentScripts({
          ids: [REGISTERED_PAGE_SCRIPT_ID],
        });
      }
      return;
    }
    const script: RegisteredPageContentScript = {
      id: REGISTERED_PAGE_SCRIPT_ID,
      js: ["page-collaboration.js"],
      matches,
      allFrames: true,
      persistAcrossSessions: true,
      runAt: "document_idle",
      world: "ISOLATED",
    };
    if (exists) {
      await this.#api.scripting.updateContentScripts([script]);
    } else {
      await this.#api.scripting.registerContentScripts([script]);
    }
  }
}

function pageToolResponseCapability(messageInput: unknown): "DANMAKU" | "DRAWING" | null {
  const parsed = PageCollaborationInboundMessageSchema.safeParse(messageInput);
  if (!parsed.success || !("controller" in parsed.data)) {
    return null;
  }
  if (parsed.data.controller === "danmaku") {
    return parsed.data.type === "syncaction.danmaku.clear" ? null : "DANMAKU";
  }
  if (parsed.data.controller === "drawing") {
    return parsed.data.type === "syncaction.drawing.clear" ? null : "DRAWING";
  }
  return null;
}

function pageToolReachableDegradedError(errorCode: string): Error {
  return Object.assign(new Error(errorCode), {
    code: "PAGE_TOOL_REACHABLE_DEGRADED",
  });
}

function readDocumentUrl(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 8_192) {
    return "";
  }
  return input;
}

function sameDocumentUrl(leftInput: unknown, rightInput: unknown): boolean {
  if (typeof leftInput !== "string" || typeof rightInput !== "string") {
    return false;
  }
  try {
    const left = new URL(leftInput);
    const right = new URL(rightInput);
    left.hash = "";
    right.hash = "";
    return left.href === right.href;
  } catch {
    return false;
  }
}

function injectionIdentity(rootDocumentUrl: string, frameDocumentUrl: string): string {
  return JSON.stringify([
    documentUrlWithoutHash(rootDocumentUrl),
    documentUrlWithoutHash(frameDocumentUrl),
  ]);
}

function documentUrlWithoutHash(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";
    return url.href;
  } catch {
    return input;
  }
}

function frameKey(tabId: number, frameId: number): string {
  return `${String(tabId)}:${String(frameId)}`;
}

function isExactWebOriginPattern(input: string): boolean {
  if (!/^https?:\/\/[^/*]+\/\*$/u.test(input) || input.includes("://*.")) {
    return false;
  }
  const origin = input.slice(0, -2);
  return originPatternForUrl(origin) === input;
}
