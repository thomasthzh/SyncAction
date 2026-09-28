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
  PageToolShortcutIntentStore,
  type PageToolShortcutIntent,
  type PageToolShortcutIntentStorageArea,
} from "../../src/page-tool-shortcut-intent.js";
import { UiPortClient, type UiPortClientPort } from "../../src/ui/ui-port-client.js";
import { App } from "../../src/ui-vnext/app.js";
import { createUiStore } from "../../src/ui-vnext/store.js";

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
  recordPolicyAcceptance: async () =>
    (await store.command({ name: "POLICY_ACCEPTANCE_RECORD" })).ok,
  refreshPageAccess: async () => {
    const result = await store.command({ name: "PAGE_PERMISSION_REFRESH" });
    if (!result.ok) {
      throw new Error(result.errorCode);
    }
  },
  resumeFeature: async (feature) => {
    let result;
    if (feature === "DANMAKU") {
      result = await store.command({ name: "DANMAKU_TOGGLE" });
    } else if (feature === "DRAWING") {
      result = await store.command({ name: "PEN_TOGGLE" });
    } else {
      return;
    }
    if (!result.ok) {
      throw new Error(result.errorCode);
    }
  },
});
const shortcutIntents = new PageToolShortcutIntentStore({
  area: browser.storage.session as unknown as PageToolShortcutIntentStorageArea,
});
const bufferedPagePermissionIntents: PageToolShortcutIntent[] = [];
const pagePermissionIntentListeners = new Set<(intent: PageToolShortcutIntent) => void>();
const handlePagePermissionIntentMessage = (message: unknown): void => {
  const parsed = PageToolShortcutIntentMessageSchema.safeParse(message);
  if (!parsed.success) {
    return;
  }
  void shortcutIntents
    .consume()
    .then((intent) => {
      if (intent === null) {
        return;
      }
      if (pagePermissionIntentListeners.size === 0) {
        bufferedPagePermissionIntents.splice(0, bufferedPagePermissionIntents.length, intent);
        return;
      }
      for (const listener of pagePermissionIntentListeners) {
        listener(intent);
      }
    })
    .catch(() => undefined);
};
browser.runtime.onMessage.addListener(handlePagePermissionIntentMessage);
const initialPagePermissionIntent = await shortcutIntents.consume().catch(() => null);
const pagePermissionIntentSource = {
  subscribe(listener: (intent: PageToolShortcutIntent) => void): () => void {
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
    serverVerifier,
    serviceStatusProbe: serverVerifier,
    pagePermissionCoordinator,
    initialPagePermissionIntent,
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
    render(null, root);
    store.dispose();
    portClient.dispose();
  },
  { once: true },
);

portClient.start();
