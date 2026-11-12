import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { SyncActionApiClient } from "../src/api-client.js";
import { ExtensionAppController, type ExtensionAppStorageArea } from "../src/app-controller.js";
import { AnnotationReplica } from "../src/annotation-replica.js";
import { BackgroundController } from "../src/background-controller.js";
import { createWatchPreparationStorage } from "../src/watch-preparation.js";
import {
  getOrCreateBrowserSessionId,
  type BrowserSessionStorageArea,
} from "../src/browser-session.js";
import { ChromeBrowserPort, type ChromiumBrowserApi } from "../src/chrome-browser-port.js";
import {
  PAGE_TOOL_COMMANDS,
  readPageToolCommandBindings,
  subscribePageToolCommands,
  type ChromiumCommandBindingsApi,
} from "../src/command-bindings.js";
import {
  ExtensionCommandRouter,
  registerUiPortServer,
  type ExtensionCommandBrowserPort,
  type UiPortServerRuntime,
} from "../src/extension-command-router.js";
import {
  ChromePageCollaborationPort,
  originPatternForUrl,
  type ChromiumPageCollaborationApi,
} from "../src/page-collaboration/chrome-page-port.js";
import { stableMediaFrameKey } from "../src/page-collaboration/frame-identity.js";
import {
  ChromeReplicaPersistence,
  restrictReplicaStorageAccess,
  type ChromeStorageArea,
} from "../src/chrome-replica-persistence.js";
import {
  getOrCreateInstallationId,
  type InstallationIdentityStorageArea,
} from "../src/installation-identity.js";
import {
  ExtensionSessionManager,
  type ExtensionSessionStorageArea,
} from "../src/product-session.js";
import { OnboardingStateStore } from "../src/onboarding-state.js";
import { OriginConsentStore, type OriginConsentStorageArea } from "../src/origin-consent.js";
import { AuthenticatedOriginPolicyRetry } from "../src/origin-policy-retry.js";
import { projectDocumentFeatureAccess } from "../src/page-access-policy.js";
import {
  PageToolShortcutIntentMessageSchema,
  PageToolShortcutIntentStore,
  PageToolShortcutContextSchema,
  type PageToolShortcutContext,
  type PageToolShortcutIntentStorageArea,
} from "../src/page-tool-shortcut-intent.js";
import { PublicCatalogTransport } from "../src/public-catalog-transport.js";
import { DEFAULT_SERVER_PROFILE_ID, ServerProfileStore } from "../src/server-profile.js";
import {
  isPageControllerMessage,
  parsePageOutboundMessageFromSender,
} from "../src/page-collaboration/messages.js";
import { resolvePublicServerOrigin } from "../src/server-origin.js";
import { SocketReplicaTransport } from "../src/socket-transport.js";
import { UiPageAccessSliceSchema, type UiPageAccessSlice } from "../src/ui/ui-protocol.js";
import { UiStateHub, type UiStateHubPort } from "../src/ui/ui-state-hub.js";

const PUBLIC_SERVER_URL = resolvePublicServerOrigin(import.meta.env.WXT_PUBLIC_SERVER_URL);
const CLIENT_VERSION = browser.runtime.getManifest().version;
export default defineBackground(() => {
  let listAllowedOrigins = async (): Promise<readonly string[]> => [];
  let isOriginAllowed: (origin: string) => Promise<boolean> = async () => false;
  let handlePermissionBoundaryChanged = async (): Promise<void> => undefined;
  let currentPageAccess: {
    access: UiPageAccessSlice;
    context: PageToolShortcutContext | null;
  } | null = null;
  let pageAccessGeneration = 0;
  const invalidatePageAccess = (): void => {
    currentPageAccess = null;
    pageAccessGeneration += 1;
  };
  const localArea = browser.storage.local as unknown as ChromeStorageArea &
    ExtensionAppStorageArea &
    ExtensionSessionStorageArea &
    InstallationIdentityStorageArea &
    OriginConsentStorageArea;
  const commandApi = browser as unknown as ChromiumCommandBindingsApi;
  const shortcutIntents = new PageToolShortcutIntentStore({
    area: browser.storage.session as unknown as PageToolShortcutIntentStorageArea,
  });
  const sidePanelApi = browser as unknown as {
    sidePanel?: {
      setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
      open(options: { tabId: number } | { windowId: number }): Promise<void>;
    };
  };
  const pageCollaborationPort = new ChromePageCollaborationPort(
    browser as unknown as ChromiumPageCollaborationApi,
    {
      onCapability: (report) => {
        void ready.then((app) => app.handlePageCapability(report)).catch(() => undefined);
      },
      onPermissionBoundaryChanged: () => {
        invalidatePageAccess();
        return handlePermissionBoundaryChanged();
      },
      onPageToolFrameUnavailable: (tabId, frameId, frameKey) => {
        void ready
          .then((app) => app.handlePageToolFrameUnavailable(tabId, frameId, frameKey))
          .catch(() => undefined);
      },
      excludedOriginPatterns: [originPatternForUrl(PUBLIC_SERVER_URL)].filter(
        (origin): origin is string => origin !== null,
      ),
      originAccess: {
        listAllowedOrigins: () => listAllowedOrigins(),
        isOriginAllowed: (origin) => isOriginAllowed(origin),
      },
    },
  );
  const readyState = (async () => {
    await Promise.all([
      restrictReplicaStorageAccess(localArea),
      pageCollaborationPort.initialize().catch(() => undefined),
    ]);
    const [browserSessionId, deviceId] = await Promise.all([
      getOrCreateBrowserSessionId(browser.storage.session as unknown as BrowserSessionStorageArea),
      getOrCreateInstallationId(localArea),
    ]);
    const profiles = new ServerProfileStore({ area: localArea });
    const originConsents = new OriginConsentStore({
      area: localArea,
      permissions: browser.permissions,
    });
    listAllowedOrigins = async () => {
      const profile = await profiles.getSelected();
      const termsVersion = profile.metadata?.termsVersion;
      if (termsVersion === undefined) {
        return [];
      }
      const records = await originConsents.listForProfile(profile.profileId);
      const grants = await Promise.all(
        records
          .filter((record) => record.serverTermsVersion === termsVersion)
          .map(async (record) => ({
            origin: record.origin,
            effective: (
              await originConsents.getEffectiveGrant({
                profileId: profile.profileId,
                origin: record.origin,
                serverTermsVersion: termsVersion,
              })
            ).effective,
          })),
      );
      return grants
        .filter(({ effective, origin }) => effective && origin !== profile.baseUrl)
        .map(({ origin }) => origin);
    };
    isOriginAllowed = async (origin) => {
      const profile = await profiles.getSelected();
      const termsVersion = profile.metadata?.termsVersion;
      if (termsVersion === undefined || origin === profile.baseUrl) {
        return false;
      }
      return (
        await originConsents.getEffectiveGrant({
          profileId: profile.profileId,
          origin,
          serverTermsVersion: termsVersion,
        })
      ).effective;
    };
    const onboarding = new OnboardingStateStore({
      area: localArea,
      clientVersion: CLIENT_VERSION,
    });
    const sessions = new ExtensionSessionManager({
      area: localArea,
      rotate: ({ serverUrl, refreshToken }) =>
        new SyncActionApiClient({ serverUrl }).refresh(refreshToken),
    });
    const browserPort = new ChromeBrowserPort(
      browser as unknown as ChromiumBrowserApi,
      browserSessionId,
    );
    const app = new ExtensionAppController({
      watchPreparations: createWatchPreparationStorage(browser.storage.session),
      pageToolShortcuts: shortcutIntents,
      deviceId,
      area: localArea,
      profiles,
      sessions,
      clientVersion: CLIENT_VERSION,
      apiFactory: (baseUrl) => new SyncActionApiClient({ serverUrl: baseUrl }),
      publicTransportFactory: (baseUrl) => new PublicCatalogTransport({ baseUrl }),
      onboarding,
      runtimeFactory: async ({
        profileId = DEFAULT_SERVER_PROFILE_ID,
        serverUrl,
        userId,
        deviceId: runtimeDeviceId,
        room,
        enableVolatilePointer = false,
        enableContentCompatibility = false,
        onRoomEvent,
        onNotificationCreated,
        onNotificationRead,
        onStatusChanged,
        getAccessToken,
      }) => {
        const initialAccessToken = await getAccessToken();
        return new BackgroundController({
          persistence: new ChromeReplicaPersistence(localArea, {
            profileId,
          }),
          configStore: {
            read: async () => ({
              serverUrl,
              accessToken: initialAccessToken,
              roomId: room.id,
              roomName: room.name,
              userId,
              deviceId: runtimeDeviceId,
              roomRole: room.role,
            }),
          },
          transportFactory: () => {
            const transport = new SocketReplicaTransport({
              serverUrl,
              accessToken: getAccessToken,
              clientVersion: CLIENT_VERSION,
              ...(onStatusChanged === undefined ? {} : { onUiRelevantActivity: onStatusChanged }),
            });
            transport.setRoomEventHandler(onRoomEvent);
            transport.setNotificationCreatedHandler(onNotificationCreated);
            transport.setNotificationReadHandler(onNotificationRead);
            return transport;
          },
          browserPort,
          browserSessionId,
          browserChangePolicy: "MANUAL",
          pagePort: pageCollaborationPort,
          annotationReplica: new AnnotationReplica({
            area: localArea,
            profileId,
            userId,
          }),
          enableVolatilePointer,
          enableContentCompatibility,
          ...(onStatusChanged === undefined ? {} : { onStatusChanged }),
          mediaNavigationPort: {
            activateTab: async (tabId) => {
              const tab = await browser.tabs.update(tabId, { active: true });
              if (tab?.windowId !== undefined)
                await browser.windows.update(tab.windowId, { focused: true });
            },
          },
        });
      },
    });
    handlePermissionBoundaryChanged = () => app.handlePagePermissionBoundaryChanged();
    await sidePanelApi.sidePanel?.setPanelBehavior({
      openPanelOnActionClick: true,
    });
    const policyRetry = new AuthenticatedOriginPolicyRetry({
      source: {
        readStatus: async () => {
          const status = await app.getProjectionStatus();
          return {
            phase: status.phase,
            accountId: status.account?.id ?? null,
            profileId: status.selectedProfileId,
            serverTermsVersion: status.selectedProfile?.metadata?.termsVersion ?? null,
          };
        },
        subscribe: (listener) => app.subscribe(listener),
        recordCurrentPolicyAcceptance: () => app.recordCurrentPolicyAcceptance(),
        notifyChanged: () => app.handlePagePermissionBoundaryChanged(),
      },
      consents: originConsents,
    });
    policyRetry.start();
    await app.start();
    await pageCollaborationPort.refreshOriginAccess();
    const activeTabs = await browser.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (activeTabs[0]?.id !== undefined) {
      await app.handleActiveTabChanged(activeTabs[0].id);
    }
    const readPageAccess = async (): Promise<UiPageAccessSlice> => {
      const generation = pageAccessGeneration;
      const [tabs, bindings] = await Promise.all([
        browser.tabs.query({ active: true, lastFocusedWindow: true }),
        readPageToolCommandBindings(commandApi),
      ]);
      const tab = tabs[0];
      const currentOriginPattern = originPatternForUrl(tabs[0]?.pendingUrl ?? tabs[0]?.url ?? null);
      const profile = await profiles.getSelected();
      const origin = currentOriginPattern === null ? null : currentOriginPattern.slice(0, -2);
      const supported = origin !== null && origin !== profile.baseUrl;
      const tabId =
        tab?.id !== undefined && Number.isSafeInteger(tab.id) && tab.id >= 0 ? tab.id : null;
      const pageContext =
        tabId === null
          ? {
              profileId: profile.profileId,
              serverOrigin: profile.baseUrl,
              serverTermsVersion: profile.metadata?.termsVersion ?? null,
              documentRevision: null,
              contentCompatibility: null,
              mediaCollaborationAvailable: false,
              pendingPublication: null,
            }
          : await app.getPageAccessContext(tabId);
      const pendingRecords = await originConsents.listForProfile(pageContext.profileId);
      const grant =
        supported && origin !== null && pageContext.serverTermsVersion !== null
          ? await originConsents.getEffectiveGrant({
              profileId: pageContext.profileId,
              origin,
              serverTermsVersion: pageContext.serverTermsVersion,
            })
          : {
              record: null,
              browserPermissionGranted:
                supported &&
                currentOriginPattern !== null &&
                (await browser.permissions.contains({ origins: [currentOriginPattern] })),
              termsAccepted: false,
              effective: false,
            };
      const documentFeatureAccess = projectDocumentFeatureAccess({
        grantEffective: grant.effective,
        documentRevision: pageContext.documentRevision,
        contentCompatibility: pageContext.contentCompatibility,
        mediaCollaborationAvailable: pageContext.mediaCollaborationAvailable,
      });
      const enabledFeatures = documentFeatureAccess.enabledFeatures;
      const reason =
        tabId === null
          ? "NO_ACTIVE_TAB"
          : !supported
            ? "UNSUPPORTED_ORIGIN"
            : pageContext.serverTermsVersion === null
              ? "SERVER_TERMS_UNAVAILABLE"
              : !grant.browserPermissionGranted
                ? "BROWSER_PERMISSION_REQUIRED"
                : !grant.termsAccepted
                  ? "TERMS_ACCEPTANCE_REQUIRED"
                  : pageContext.documentRevision === null
                    ? "ROOM_DOCUMENT_UNAVAILABLE"
                    : documentFeatureAccess.contentReason;
      const access = UiPageAccessSliceSchema.parse({
        bindings,
        tabId,
        logicalTabId: pageContext.logicalTabId ?? null,
        url: supported ? (tab?.pendingUrl ?? tab?.url ?? null) : null,
        documentRevision: pageContext.documentRevision,
        contentCompatibility: pageContext.contentCompatibility,
        pendingPublication: pageContext.pendingPublication ?? null,
        origin: supported ? origin : null,
        supported,
        browserPermissionGranted: grant.browserPermissionGranted,
        termsAccepted: grant.termsAccepted,
        serverTermsVersion: pageContext.serverTermsVersion,
        disclosureVersion: 1,
        enabledFeatures,
        policySyncPendingCount: pendingRecords.filter(({ policySyncPending }) => policySyncPending)
          .length,
        reason,
      });
      const status = await app.getStatus();
      const context = PageToolShortcutContextSchema.safeParse({
        profileId: status.selectedProfileId,
        serverOrigin: status.selectedProfile?.baseUrl,
        serverId: status.selectedProfile?.metadata?.serverId ?? null,
        accountId: status.account?.id,
        roomId: status.selectedRoomId,
        tabId: access.tabId,
        windowId: tab?.windowId,
        url: access.url,
        documentRevision: access.documentRevision,
      });
      if (generation !== pageAccessGeneration) return access;
      currentPageAccess = {
        access,
        context:
          context.success &&
          status.selectedProfileId === pageContext.profileId &&
          status.selectedProfile?.baseUrl === pageContext.serverOrigin
            ? context.data
            : null,
      };
      return access;
    };
    await readPageAccess();
    const commandRouter = new ExtensionCommandRouter({
      app,
      browser: browser as unknown as ExtensionCommandBrowserPort,
      pageCollaborationPort,
      commandBindings: {
        read: () => readPageToolCommandBindings(commandApi),
      },
      originConsents,
    });
    const uiStateHub = new UiStateHub({
      source: {
        readStatus: () => app.getProjectionStatus(),
        readProfiles: () => profiles.list(),
        readPageAccess,
        subscribeChanged: (listener) => app.subscribe(listener),
        execute: (command) => commandRouter.execute(command),
      },
    });
    return { app, uiStateHub, readPageAccess };
  })();
  const ready = readyState.then(({ app }) => app);
  type NamedUiStateHubPort = UiStateHubPort & { name: string };
  registerUiPortServer(
    browser.runtime as unknown as UiPortServerRuntime<NamedUiStateHubPort>,
    readyState.then(({ uiStateHub }) => ({
      attach: (port: NamedUiStateHubPort) => uiStateHub.attach(port),
    })),
  );
  subscribePageToolCommands(commandApi, (command, invokedTab) => {
    const invokedAtMs = Date.now();
    const identity = ready.then((app) => app.getStatus());
    const intent = command === PAGE_TOOL_COMMANDS.danmaku ? "danmaku" : "pen";
    const feature = intent === "danmaku" ? "DANMAKU" : "DRAWING";
    const cached = currentPageAccess;
    const sourceTab = invokedTab;
    const sourceUrl = sourceTab?.pendingUrl ?? sourceTab?.url;
    const context = cached?.context;
    if (
      context?.documentRevision != null &&
      cached!.access.enabledFeatures.includes(feature) &&
      sourceTab?.id === context.tabId &&
      sourceTab.windowId === context.windowId &&
      sourceUrl === context.url
    ) {
      return ready.then(async (app) => {
        const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        const status = await app.getStatus();
        if (
          tabs[0]?.id !== context.tabId ||
          (tabs[0]?.pendingUrl ?? tabs[0]?.url) !== context.url ||
          status.selectedProfileId !== context.profileId ||
          status.selectedProfile?.baseUrl !== context.serverOrigin ||
          (status.selectedProfile.metadata?.serverId ?? null) !== context.serverId ||
          status.account?.id !== context.accountId ||
          status.selectedRoomId !== context.roomId
        )
          return;
        const expected = {
          profileId: context.profileId,
          roomId: context.roomId,
          tabId: context.tabId,
          url: context.url,
          documentRevision: context.documentRevision!,
        };
        return intent === "danmaku"
          ? app.toggleDanmakuInput(expected)
          : app.togglePagePen(expected);
      });
    }
    // Open synchronously in the command event; awaiting initialization loses Chrome's user gesture.
    const opened =
      sourceTab?.windowId === undefined
        ? Promise.resolve()
        : (sidePanelApi.sidePanel?.open({ windowId: sourceTab.windowId }) ?? Promise.resolve());
    void opened.catch(() => undefined);
    return readyState.then(async ({ readPageAccess }) => {
      const sourceIdentity = await identity;
      await readPageAccess();
      const current = currentPageAccess?.context;
      if (
        current == null ||
        sourceTab?.id !== current.tabId ||
        sourceTab.windowId !== current.windowId ||
        sourceUrl !== current.url
      )
        return;
      if (
        sourceIdentity.selectedProfileId !== current.profileId ||
        sourceIdentity.selectedProfile?.baseUrl !== current.serverOrigin ||
        (sourceIdentity.selectedProfile.metadata?.serverId ?? null) !== current.serverId ||
        sourceIdentity.account?.id !== current.accountId ||
        sourceIdentity.selectedRoomId !== current.roomId
      )
        return;
      // A cold worker has no cache; an existing cache must still describe the same identity.
      if (
        context != null &&
        (context.profileId !== current.profileId ||
          context.accountId !== current.accountId ||
          context.roomId !== current.roomId ||
          context.serverId !== current.serverId ||
          context.serverOrigin !== current.serverOrigin)
      )
        return;
      await shortcutIntents.enqueue(intent, current, invokedAtMs);
      await browser.runtime
        .sendMessage(
          PageToolShortcutIntentMessageSchema.parse({
            type: "syncaction.ui.page-tool-shortcut-intent",
            intent,
          }),
        )
        .catch(() => undefined);
    });
  });

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    let pageMessage;
    try {
      pageMessage = parsePageOutboundMessageFromSender(message, sender);
    } catch {
      sendResponse();
      return;
    }
    if (pageMessage !== null) {
      void (async () => {
        if (!(await pageCollaborationPort.validateOutboundMessage(pageMessage))) {
          return undefined;
        }
        const app = await ready;
        if (pageMessage.message.type === "syncaction.page.capability") {
          return app.handlePageCapability({
            tabId: pageMessage.tabId,
            frameId: pageMessage.frameId,
            message: pageMessage.message,
          });
        }
        if (pageMessage.message.type === "syncaction.page.ready") {
          const frameKey = await stableMediaFrameKey(pageMessage.frameId, pageMessage.documentUrl);
          if (frameKey === null) {
            return undefined;
          }
          const pageToolFrameRegistered = pageCollaborationPort.registerPageToolFrame(
            pageMessage.tabId,
            pageMessage.frameId,
            frameKey,
          );
          const pageToolRootGeneration = pageCollaborationPort.pageToolRootGeneration(
            pageMessage.tabId,
            pageMessage.frameId,
          );
          await Promise.all([
            pageMessage.frameId === 0
              ? app.handlePointerPageReady(pageMessage.tabId)
              : Promise.resolve(),
            app.handleMediaPageReady(pageMessage.tabId, pageMessage.frameId, frameKey),
            pageToolFrameRegistered && pageToolRootGeneration !== null
              ? app.handlePageToolFrameReady(
                  pageMessage.tabId,
                  pageMessage.frameId,
                  frameKey,
                  pageToolRootGeneration,
                )
              : Promise.resolve(),
          ]);
          return undefined;
        }
        if (pageMessage.frameId === 0 && pageMessage.message.type === "page.compatibility.report") {
          return app.handlePageCompatibilityReport(pageMessage.tabId, pageMessage.message);
        }
        if (
          isPageControllerMessage(pageMessage.message, "media") &&
          pageMessage.message.type === "syncaction.media.observed"
        ) {
          return app.handleMediaObserved(
            pageMessage.tabId,
            pageMessage.frameId,
            pageMessage.message,
          );
        }
        if (
          pageMessage.frameId === 0 &&
          isPageControllerMessage(pageMessage.message, "pointer") &&
          pageMessage.message.type === "syncaction.pointer.sample"
        ) {
          return app.handlePointerLocalSample(pageMessage.tabId, pageMessage.message.sample);
        }
        if (
          isPageControllerMessage(pageMessage.message, "danmaku") &&
          pageMessage.message.type === "syncaction.danmaku.submit"
        ) {
          return app.handleDanmakuSubmit(
            pageMessage.tabId,
            pageMessage.frameId,
            pageMessage.message,
          );
        }
        if (
          isPageControllerMessage(pageMessage.message, "danmaku") &&
          pageMessage.message.type === "syncaction.danmaku.report"
        ) {
          return app.handleDanmakuReport(
            pageMessage.tabId,
            pageMessage.frameId,
            pageMessage.message,
          );
        }
        if (isPageControllerMessage(pageMessage.message, "drawing")) {
          switch (pageMessage.message.type) {
            case "syncaction.stroke.sample":
              return app.handleStrokeSample(
                pageMessage.tabId,
                pageMessage.frameId,
                pageMessage.message,
              );
            case "syncaction.stroke.final":
              return app.handleStrokeFinal(
                pageMessage.tabId,
                pageMessage.frameId,
                pageMessage.message,
              );
            case "syncaction.drawing.selection":
              return app.handleDrawingSelection(
                pageMessage.tabId,
                pageMessage.frameId,
                pageMessage.message,
              );
            case "syncaction.annotation.draft.control":
              return app.handleDrawingDraftControl(
                pageMessage.tabId,
                pageMessage.frameId,
                pageMessage.message,
              );
            case "syncaction.drawing.report":
              return app.handleDrawingReport(
                pageMessage.tabId,
                pageMessage.frameId,
                pageMessage.message,
              );
          }
        }
        return undefined;
      })().then(sendResponse, () => sendResponse());
      return true;
    }
    return undefined;
  });

  browser.tabs.onCreated.addListener((tab) => {
    if (tab.id === undefined) {
      return;
    }
    dispatch(ready, {
      type: "TAB_CREATED",
      tabId: tab.id,
      url: tab.pendingUrl ?? tab.url ?? null,
    });
  });
  browser.tabs.onActivated.addListener(({ tabId }) => {
    invalidatePageAccess();
    dispatchActiveTab(ready, tabId);
  });
  browser.windows.onFocusChanged.addListener(() => {
    invalidatePageAccess();
    void browser.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((tabs) => {
        if (tabs[0]?.id !== undefined) {
          dispatchActiveTab(ready, tabs[0].id);
        }
      })
      .catch(() => undefined);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (currentPageAccess?.access.tabId === tabId) {
      invalidatePageAccess();
    }
    const groupId = (changeInfo as { groupId?: number }).groupId;
    if (groupId !== undefined) {
      dispatch(ready, {
        type: "TAB_GROUP_CHANGED",
        tabId,
        groupId: groupId < 0 ? null : groupId,
      });
    }
    dispatch(ready, {
      type: "TAB_UPDATED",
      tabId,
    });
  });
  browser.tabs.onMoved.addListener((tabId, moveInfo) => {
    dispatch(ready, {
      type: "TAB_MOVED",
      tabId,
      windowId: moveInfo.windowId,
      index: moveInfo.toIndex,
    });
  });
  browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (currentPageAccess?.access.tabId === tabId) {
      invalidatePageAccess();
    }
    dispatch(ready, {
      type: "TAB_REMOVED",
      tabId,
      windowId: removeInfo.windowId,
      isWindowClosing: removeInfo.isWindowClosing,
    });
  });
  browser.tabs.onDetached.addListener((tabId) => {
    dispatch(ready, {
      type: "TAB_DETACHED",
      tabId,
    });
  });
  browser.tabs.onAttached.addListener((tabId) => {
    dispatch(ready, {
      type: "TAB_ATTACHED",
      tabId,
    });
  });
  browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    if (currentPageAccess?.access.tabId === removedTabId) {
      invalidatePageAccess();
    }
    dispatch(ready, {
      type: "TAB_REPLACED",
      addedTabId,
      removedTabId,
    });
  });

  void ready.then(() => pageCollaborationPort.announceExistingPages()).catch(() => undefined);
  void ready.catch(() => undefined);
});

function dispatch(controller: Promise<ExtensionAppController>, event: unknown): void {
  void controller.then((app) => app.handleBrowserEvent(event)).catch(() => undefined);
}

function dispatchActiveTab(controller: Promise<ExtensionAppController>, tabId: number): void {
  void controller.then((app) => app.handleActiveTabChanged(tabId)).catch(() => undefined);
}
