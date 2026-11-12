import { h, render } from "preact";
import { browser } from "wxt/browser";
import {
  OriginPermissionCoordinator,
  type OriginPermissionBrowserPort,
} from "../../src/origin-permission-coordinator.js";
import {
  OriginConsentStore,
  pageOriginPattern,
  type OriginConsentStorageArea,
} from "../../src/origin-consent.js";
import { CustomServerVerifier } from "../../src/server-host-permission.js";
import {
  PageToolShortcutIntentMessageSchema,
  PageToolShortcutRequestSchema,
  type PageToolShortcutRequest,
} from "../../src/page-tool-shortcut-intent.js";
import { UiPortClient, type UiPortClientPort } from "../../src/ui/ui-port-client.js";
import { App } from "../../src/ui-vnext/app.js";
import { createUiStore } from "../../src/ui-vnext/store.js";
import {
  createPendingRoomJoinStorage,
  PENDING_ROOM_JOIN_KEY,
} from "../../src/pending-room-join.js";

const root = document.getElementById("sidepanel-app");
if (root === null) {
  throw new Error("MISSING_SIDEPANEL_ROOT");
}

const portClient = new UiPortClient({
  connect: () =>
    browser.runtime.connect({ name: "syncaction.ui.v1" }) as unknown as UiPortClientPort,
});
const store = createUiStore(portClient);
const serverVerifier = new CustomServerVerifier({
  permissions: browser.permissions,
  fetch: globalThis.fetch.bind(globalThis),
});
const originConsents = new OriginConsentStore({
  area: browser.storage.local as unknown as OriginConsentStorageArea,
  permissions: browser.permissions,
});
const pagePermissionCoordinator = new OriginPermissionCoordinator({
  browser: browser as unknown as OriginPermissionBrowserPort,
  consents: originConsents,
  getCurrentPageAccess: () => store.pageAccess.value,
  getSelectedProfileId: () => store.shell.value.selectedProfileId,
  getSelectedRoomId: () => store.room.value.selectedRoomId,
  recordPolicyAcceptance: async () =>
    (await store.command({ name: "POLICY_ACCEPTANCE_RECORD" })).ok,
  refreshPageAccess: async () => {
    const result = await store.command({ name: "PAGE_PERMISSION_REFRESH" });
    if (!result.ok) {
      throw new Error(result.errorCode);
    }
  },
  resumeFeature: async (feature, intent) => {
    let result;
    const toolContext = {
      profileId: intent.profileId,
      roomId: intent.roomId,
      tabId: intent.tabId,
      ...(intent.url === undefined ? {} : { url: intent.url }),
      documentRevision: intent.documentRevision,
    };
    if (feature === "DANMAKU") {
      result = await store.command({
        name: "DANMAKU_TOGGLE",
        payload: { expectedContext: toolContext },
      });
    } else if (feature === "DRAWING") {
      result = await store.command({
        name: "PEN_TOGGLE",
        payload: { expectedContext: toolContext },
      });
    } else if (feature === "MEDIA_CONTROL") {
      if (intent.roomId === undefined) throw new Error("PAGE_PERMISSION_INTENT_STALE");
      const expectedContext = {
        profileId: intent.profileId,
        roomId: intent.roomId,
        tabId: intent.tabId,
        ...(intent.url === undefined ? {} : { url: intent.url }),
        documentRevision: intent.documentRevision,
      };
      result = await store.command(
        intent.mediaSwitchGroupId !== undefined
          ? {
              name: "MEDIA_GROUP_SWITCH_CURRENT",
              payload: { playbackGroupId: intent.mediaSwitchGroupId, expectedContext },
            }
          : intent.mediaJoinGroupId === undefined
            ? { name: "MEDIA_GROUP_CREATE", payload: { expectedContext } }
            : intent.mediaJoinTarget === undefined
              ? {
                  name: "MEDIA_GROUP_JOIN",
                  payload: { playbackGroupId: intent.mediaJoinGroupId, expectedContext },
                }
              : {
                  name: "MEDIA_GROUP_PREPARE",
                  payload: {
                    playbackGroupId: intent.mediaJoinGroupId,
                    expectedContext,
                    expectedTarget: intent.mediaJoinTarget,
                  },
                },
      );
    } else {
      return;
    }
    if (!result.ok) {
      throw new Error(result.errorCode);
    }
  },
});
const bufferedPagePermissionIntents: PageToolShortcutRequest[] = [];
const pagePermissionIntentListeners = new Set<(intent: PageToolShortcutRequest) => void>();
const panelWindow = browser.windows.getCurrent();
const consumeShortcut = async (): Promise<void> => {
  const windowId = (await panelWindow).id;
  if (windowId === undefined) return;
  const result = await store.command({ name: "PAGE_TOOL_SHORTCUT_CONSUME", payload: { windowId } });
  if (!result.ok) return;
  const parsed = PageToolShortcutRequestSchema.safeParse(result.value);
  if (!parsed.success) return;
  const intent = parsed.data;
  if (pagePermissionIntentListeners.size === 0) {
    bufferedPagePermissionIntents.splice(0, bufferedPagePermissionIntents.length, intent);
    return;
  }
  for (const listener of pagePermissionIntentListeners) listener(intent);
};
const handlePagePermissionIntentMessage = (message: unknown): void => {
  const parsed = PageToolShortcutIntentMessageSchema.safeParse(message);
  if (!parsed.success) {
    return;
  }
  void consumeShortcut().catch(() => undefined);
};
browser.runtime.onMessage.addListener(handlePagePermissionIntentMessage);
const unsubscribeShortcutTransport = portClient.subscribeTransport((state) => {
  if (state === "CONNECTED") void consumeShortcut().catch(() => undefined);
});
const pagePermissionIntentSource = {
  subscribe(listener: (intent: PageToolShortcutRequest) => void): () => void {
    pagePermissionIntentListeners.add(listener);
    const buffered = bufferedPagePermissionIntents.shift();
    if (buffered !== undefined) {
      listener(buffered);
    }
    return () => pagePermissionIntentListeners.delete(listener);
  },
};

render(
  h(App, {
    store,
    pendingRoomJoinStorage: createPendingRoomJoinStorage(browser.storage.local, (listener) => {
      const changed: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
        changes,
        area,
      ) => {
        if (area === "local" && Object.hasOwn(changes, PENDING_ROOM_JOIN_KEY))
          listener(changes[PENDING_ROOM_JOIN_KEY]?.newValue);
      };
      browser.storage.onChanged.addListener(changed);
      return () => browser.storage.onChanged.removeListener(changed);
    }),
    serverVerifier,
    serviceStatusProbe: serverVerifier,
    pagePermissionCoordinator,
    pagePermissionIntentSource,
    privacyPageUrl: browser.runtime.getURL("/privacy.html"),
    loadAuthorizedSites: async (profileId: string) => {
      const records = await originConsents.listForProfile(profileId);
      return Promise.all(
        records.map(async (record) => ({
          record,
          browserPermissionGranted: await browser.permissions.contains({
            origins: [pageOriginPattern(record.origin)],
          }),
        })),
      );
    },
  }),
  root,
);

window.addEventListener(
  "unload",
  () => {
    unsubscribeShortcutTransport();
    browser.runtime.onMessage.removeListener(handlePagePermissionIntentMessage);
    render(null, root);
    store.dispose();
    portClient.dispose();
  },
  { once: true },
);

portClient.start();
