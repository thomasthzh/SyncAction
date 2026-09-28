// @vitest-environment happy-dom

import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  canonicalSharedPageIdentity,
  type ContentSignature,
  type MediaIdentity,
  type PageCompatibilityReport,
} from "@syncaction/protocol";
import { h, render } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentCompatibilityController } from "../src/content-compatibility-controller.js";
import {
  OriginConsentStore,
  type OriginConsentStorageArea,
  type PageOriginPermissionPort,
} from "../src/origin-consent.js";
import {
  OriginPermissionCoordinator,
  type OriginPermissionBrowserPort,
} from "../src/origin-permission-coordinator.js";
import {
  buildPageCompatibilityReport,
  computeElementContentSignature,
  computePageContentSignature,
} from "../src/page-collaboration/content-signature.js";
import {
  ChromePageCollaborationPort,
  type ChromiumPageCollaborationApi,
  type RegisteredPageContentScript,
} from "../src/page-collaboration/chrome-page-port.js";
import {
  PAGE_OVERLAY_HOST_ATTRIBUTE,
  PAGE_SURFACE_NAMES,
  PageOverlayHost,
} from "../src/page-collaboration/page-overlay-host.js";
import { ActionableStatus } from "../src/ui-vnext/components/actionable-status.js";
import type { UiPageAccessSlice } from "../src/ui/ui-protocol.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-423456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-423456789a02");
const remoteUserId = "018f8f8e-4b5c-7d6e-8f90-423456789a03";
const remoteDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-423456789a04");
const pageUrl = "https://video.example/watch?v=shared";
const pageOrigin = "https://video.example";
const otherOrigin = "https://news.example";
const profileA = "server-a";
const profileB = "server-b";
const termsV1 = "2026-07-30";
const termsV2 = "2026-08-15";
const revision = { roomEpoch: 4, tabUpdatedAtSeq: 12 };
const viewport = { widthCssPx: 1_280, heightCssPx: 800 };
const media = {
  provider: "HTML5",
  mediaKey: "html5:shared-primary-video",
} satisfies MediaIdentity;

interface Fixture {
  document: Document;
  signature: ContentSignature;
  sharedButtonSignature: ContentSignature;
  privateMarkers: readonly string[];
}

beforeEach(() => {
  document.querySelectorAll(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`).forEach((node) => node.remove());
  document.body.replaceChildren();
});

describe("two-client randomized-page compatibility acceptance", () => {
  it("degrades positional collaboration while preserving matching media, danmaku, and anchors", async () => {
    const clientA = await randomizedFixture({
      recommendationVariant: "A",
      privateText: "fixture-a-private-account-text",
      privateFormValue: "fixture-a-private-form-value",
    });
    const clientB = await randomizedFixture({
      recommendationVariant: "B",
      privateText: "fixture-b-private-account-text",
      privateFormValue: "fixture-b-private-form-value",
    });
    expect(clientA.signature).not.toEqual(clientB.signature);
    expect(clientA.sharedButtonSignature).toEqual(clientB.sharedButtonSignature);

    const localReport = report(clientB.signature);
    const remoteReport = report(clientA.signature);
    const policy = compatibilityPolicy(localReport, remoteReport);
    const scope = {
      roomId,
      logicalTabId,
      documentRevision: revision,
      remoteUserId,
      remoteDeviceId,
    };
    expect(policy.classify(scope)).toBe("MISMATCH");

    const host = new PageOverlayHost({ document });
    const synchronizedMedia: MediaIdentity[] = [];
    const scrollApplications: number[] = [];
    const route = (
      capability:
        | "REMOTE_POINTER"
        | "ROOT_DRAWING"
        | "ELEMENT_DRAWING"
        | "BOTTOM_DANMAKU"
        | "SCROLL_FOLLOW"
        | "KNOWN_MEDIA_SYNC",
      evidence?: {
        localAnchorSignature: ContentSignature;
        remoteAnchorSignature: ContentSignature;
      },
    ): void => {
      const decision = policy.decide({
        capability,
        scope,
        ...(evidence === undefined ? {} : { evidence }),
        ...(capability === "KNOWN_MEDIA_SYNC" ? { knownMedia: media } : {}),
      });
      if (!decision.allowed) {
        return;
      }
      if (capability === "REMOTE_POINTER") {
        host.getSurface("pointer").append(document.createElement("span"));
      } else if (capability === "ROOT_DRAWING" || capability === "ELEMENT_DRAWING") {
        const stroke = document.createElement("span");
        stroke.dataset.strokeKind = capability;
        host.getSurface("drawing").append(stroke);
      } else if (capability === "BOTTOM_DANMAKU") {
        const danmaku = document.createElement("span");
        danmaku.textContent = "一起看";
        host.getSurface("danmaku").append(danmaku);
      } else if (capability === "SCROLL_FOLLOW") {
        scrollApplications.push(480);
      } else {
        synchronizedMedia.push(media);
      }
    };

    route("REMOTE_POINTER");
    route("ROOT_DRAWING");
    route("SCROLL_FOLLOW");
    route("KNOWN_MEDIA_SYNC");
    route("BOTTOM_DANMAKU");
    route("ELEMENT_DRAWING", {
      localAnchorSignature: clientB.sharedButtonSignature,
      remoteAnchorSignature: clientA.sharedButtonSignature,
    });
    route("ELEMENT_DRAWING", {
      localAnchorSignature: clientB.sharedButtonSignature,
      remoteAnchorSignature: {
        signatureVersion: 1,
        digest: "Z".repeat(43),
      },
    });

    expect(host.getSurface("pointer").childNodes).toHaveLength(0);
    expect(scrollApplications).toEqual([]);
    expect(synchronizedMedia).toEqual([media]);
    expect(host.getSurface("danmaku").textContent).toBe("一起看");
    expect(
      [...host.getSurface("drawing").children].map(
        (element) => (element as HTMLElement).dataset.strokeKind,
      ),
    ).toEqual(["ELEMENT_DRAWING"]);

    const warningRoot = document.createElement("div");
    render(h(ActionableStatus, { statusCode: "CONTENT_MISMATCH" }), warningRoot);
    expect(warningRoot.textContent).toContain("页面内容与对方不同，已保护性暂停");
    render(null, warningRoot);
    host.dispose("BACKGROUND_STOPPED");
  });

  it("classifies identical semantic layouts with different private text and form state as exact", async () => {
    const clientA = await randomizedFixture({
      recommendationVariant: "A",
      privateText: "first-user-private-heading",
      privateFormValue: "first-user-private-form",
    });
    const clientB = await randomizedFixture({
      recommendationVariant: "A",
      privateText: "second-user-unrelated-heading",
      privateFormValue: "second-user-unrelated-form",
    });

    expect(clientA.signature).toEqual(clientB.signature);
    const policy = compatibilityPolicy(report(clientB.signature), report(clientA.signature));
    expect(
      policy.classify({
        roomId,
        logicalTabId,
        documentRevision: revision,
        remoteUserId,
        remoteDeviceId,
      }),
    ).toBe("EXACT");
  });

  it("transmits digests and known media without fixture text, form state, DOM, or signature source", async () => {
    const clientA = await randomizedFixture({
      recommendationVariant: "A",
      privateText: "wire-forbidden-private-heading-a",
      privateFormValue: "wire-forbidden-private-form-a",
    });
    const clientB = await randomizedFixture({
      recommendationVariant: "B",
      privateText: "wire-forbidden-private-heading-b",
      privateFormValue: "wire-forbidden-private-form-b",
    });
    const capturedWirePayloads = [
      report(clientA.signature),
      report(clientB.signature),
      {
        type: "danmaku.send",
        protocolVersion: 1,
        roomId,
        logicalTabId,
        documentRevision: revision,
        text: "一起看",
      },
    ];
    const serialized = JSON.stringify(capturedWirePayloads);

    for (const marker of [...clientA.privateMarkers, ...clientB.privateMarkers]) {
      expect(serialized).not.toContain(marker);
    }
    expect(serialized).not.toMatch(
      /headingCountBuckets|interactiveCountBucket|landmarks|formValue|innerHTML|outerHTML|textContent|signatureSource|canvasPixels|screenshot/iu,
    );
    expect(serialized).toContain(clientA.signature.digest);
    expect(serialized).toContain(clientB.signature.digest);
    expect(serialized).toContain(media.mediaKey);
  });
});

describe("origin consent and external-revoke acceptance", () => {
  it("requests only on checked confirmation and isolates origin, profile, and terms", async () => {
    const storage = new MemoryConsentStorage();
    const browser = new PermissionBrowser();
    const consents = new OriginConsentStore({
      area: storage,
      permissions: browser,
      now: () => 1_785_320_000_000,
    });
    let access = pageAccess();
    const roomState = {
      tabs: [logicalTabId],
      members: [remoteUserId],
      messages: ["durable-room-message"],
    };
    const originalRoomState = structuredClone(roomState);
    const coordinator = new OriginPermissionCoordinator({
      browser,
      consents,
      getCurrentPageAccess: () => structuredClone(access),
      getSelectedProfileId: () => profileA,
      recordPolicyAcceptance: async () => true,
      refreshPageAccess: async () => {
        access = pageAccess({
          browserPermissionGranted: true,
          termsAccepted: true,
          reason: "CONTENT_UNKNOWN",
        });
      },
      resumeFeature: async () => undefined,
    });

    expect(browser.requestCalls).toEqual([]);
    const uncheckedIntent = await coordinator.capture("DRAWING");
    await expect(coordinator.confirm(uncheckedIntent, false)).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_PERMISSION_AGREEMENT_REQUIRED",
    });
    expect(browser.requestCalls).toEqual([]);

    browser.requestResult = false;
    const deniedIntent = await coordinator.capture("DRAWING");
    const denied = coordinator.confirm(deniedIntent, true);
    expect(browser.requestCalls).toEqual([[`${pageOrigin}/*`]]);
    await expect(denied).resolves.toMatchObject({
      granted: false,
      errorCode: "PAGE_PERMISSION_DENIED",
    });
    expect(roomState).toEqual(originalRoomState);
    await expect(consents.listForProfile(profileA)).resolves.toEqual([]);

    browser.requestResult = true;
    const acceptedIntent = await coordinator.capture("DRAWING");
    await expect(coordinator.confirm(acceptedIntent, true)).resolves.toMatchObject({
      granted: true,
      errorCode: null,
    });
    expect(browser.requestCalls.at(-1)).toEqual([`${pageOrigin}/*`]);
    await expect(
      consents.getEffectiveGrant({
        profileId: profileA,
        origin: pageOrigin,
        serverTermsVersion: termsV1,
      }),
    ).resolves.toMatchObject({ effective: true });
    await expect(
      consents.getEffectiveGrant({
        profileId: profileA,
        origin: otherOrigin,
        serverTermsVersion: termsV1,
      }),
    ).resolves.toMatchObject({ effective: false, termsAccepted: false });
    await expect(
      consents.getEffectiveGrant({
        profileId: profileB,
        origin: pageOrigin,
        serverTermsVersion: termsV1,
      }),
    ).resolves.toMatchObject({ effective: false, termsAccepted: false });
    await expect(
      consents.getEffectiveGrant({
        profileId: profileA,
        origin: pageOrigin,
        serverTermsVersion: termsV2,
      }),
    ).resolves.toMatchObject({ effective: false, termsAccepted: false });
  });

  it("uses the real page-port permission boundary to unload every overlay surface once", async () => {
    const host = new PageOverlayHost({ document });
    const disposed: string[] = [];
    for (const surface of PAGE_SURFACE_NAMES) {
      host.getSurface(surface).append(document.createElement("span"));
      host.registerSurfaceController(surface, (reason) => disposed.push(`${surface}:${reason}`));
    }
    const api = new RevocablePageApi(host);
    const allowed = new Set([pageOrigin]);
    let boundaryCount = 0;
    const port = new ChromePageCollaborationPort(api, {
      originAccess: {
        listAllowedOrigins: async () => [...allowed],
        isOriginAllowed: async (origin) => allowed.has(origin),
      },
      onPermissionBoundaryChanged: () => {
        boundaryCount += 1;
      },
    });
    const roomState = {
      tabs: [logicalTabId],
      members: [remoteUserId],
      messages: ["durable-room-message"],
    };
    const originalRoomState = structuredClone(roomState);

    await port.initialize();
    await expect(port.ensureInjected(7)).resolves.toBe(true);
    expect(api.registeredScripts[0]?.matches).toEqual([`${pageOrigin}/*`]);

    allowed.delete(pageOrigin);
    api.revoke(`${pageOrigin}/*`);
    await vi.waitFor(() => expect(boundaryCount).toBe(1));

    expect(disposed).toEqual(PAGE_SURFACE_NAMES.map((surface) => `${surface}:ORIGIN_REVOKED`));
    expect(document.querySelector(`[${PAGE_OVERLAY_HOST_ATTRIBUTE}]`)).toBeNull();
    expect(api.registeredScripts).toEqual([]);
    expect(roomState).toEqual(originalRoomState);
  });
});

async function randomizedFixture(input: {
  recommendationVariant: "A" | "B";
  privateText: string;
  privateFormValue: string;
}): Promise<Fixture> {
  const fixtureDocument = document.implementation.createHTMLDocument("private fixture");
  Object.defineProperty(fixtureDocument, "readyState", {
    configurable: true,
    value: "complete",
  });
  const privateId = `${input.privateText}-private-id`;
  const privateClass = `${input.privateText}-private-class`;
  const privateData = `${input.privateText}-private-data`;
  fixtureDocument.body.innerHTML = `
    <header><h1>${input.privateText}</h1></header>
    <main id="${privateId}" class="${privateClass}" data-private="${privateData}">
      <section>
        <button>${input.privateText}</button>
      </section>
      <article>
        <form><input value="${input.privateFormValue}"></form>
      </article>
      <video></video>
    </main>
    ${
      input.recommendationVariant === "B"
        ? `<aside><article>${input.privateText}-random-recommendation</article></aside>`
        : ""
    }
    <footer></footer>
  `;
  setRectangle(fixtureDocument.querySelector("header")!, 0, 0, 1_280, 88);
  setRectangle(fixtureDocument.querySelector("main")!, 160, 88, 960, 620);
  setRectangle(fixtureDocument.querySelector("main article")!, 200, 410, 640, 220);
  setRectangle(fixtureDocument.querySelector("form")!, 220, 450, 520, 120);
  setRectangle(fixtureDocument.querySelector("video")!, 520, 140, 520, 292);
  setRectangle(fixtureDocument.querySelector("button")!, 240, 180, 180, 48);
  setRectangle(fixtureDocument.querySelector("footer")!, 0, 708, 1_280, 92);
  const aside = fixtureDocument.querySelector("aside");
  if (aside !== null) {
    setRectangle(aside, 1_120, 88, 160, 620);
    setRectangle(fixtureDocument.querySelector("aside article")!, 1_136, 120, 128, 280);
  }
  const signature = await computePageContentSignature({
    document: fixtureDocument,
    roomId,
    pageUrl,
    viewport,
  });
  const sharedButtonSignature = await computeElementContentSignature({
    element: fixtureDocument.querySelector("button")!,
    roomId,
    viewport,
  });
  if (signature === null || sharedButtonSignature === null) {
    throw new Error("fixture signature unavailable");
  }
  return {
    document: fixtureDocument,
    signature,
    sharedButtonSignature,
    privateMarkers: [
      input.privateText,
      input.privateFormValue,
      privateId,
      privateClass,
      privateData,
    ],
  };
}

function report(signature: ContentSignature): PageCompatibilityReport {
  return buildPageCompatibilityReport({
    logicalTabId,
    documentRevision: revision,
    canonicalPageIdentity: canonicalSharedPageIdentity(pageUrl),
    contentSignature: signature,
    media,
  });
}

function compatibilityPolicy(
  localReport: PageCompatibilityReport,
  remoteReport: PageCompatibilityReport,
): ContentCompatibilityController {
  const policy = new ContentCompatibilityController();
  policy.upsertLocalReport({ roomId, report: localReport });
  policy.upsertRemoteReport({
    roomId,
    remoteUserId,
    remoteDeviceId,
    report: remoteReport,
  });
  return policy;
}

function setRectangle(element: Element, x: number, y: number, width: number, height: number): void {
  element.getBoundingClientRect = () => ({
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  });
}

function pageAccess(overrides: Partial<UiPageAccessSlice> = {}): UiPageAccessSlice {
  return {
    bindings: null,
    tabId: 7,
    documentRevision: revision,
    contentCompatibility: "UNKNOWN",
    origin: pageOrigin,
    supported: true,
    browserPermissionGranted: false,
    termsAccepted: false,
    serverTermsVersion: termsV1,
    disclosureVersion: 1,
    enabledFeatures: [],
    policySyncPendingCount: 0,
    reason: "BROWSER_PERMISSION_REQUIRED",
    ...overrides,
  };
}

class MemoryConsentStorage implements OriginConsentStorageArea {
  readonly values = new Map<string, unknown>();

  public async get(key: string): Promise<Record<string, unknown>> {
    return this.values.has(key) ? { [key]: structuredClone(this.values.get(key)) } : {};
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }
}

class PermissionBrowser implements OriginPermissionBrowserPort, PageOriginPermissionPort {
  readonly granted = new Set<string>();
  readonly requestCalls: string[][] = [];
  requestResult = true;

  readonly tabs: OriginPermissionBrowserPort["tabs"] = {
    query: async () => [{ id: 7, url: pageUrl }],
  };

  readonly permissions: OriginPermissionBrowserPort["permissions"] = {
    contains: (input) => this.contains(input),
    request: async (input) => {
      this.requestCalls.push([...input.origins]);
      if (this.requestResult) {
        for (const origin of input.origins) {
          this.granted.add(origin);
        }
      }
      return this.requestResult;
    },
    remove: async (input) => {
      for (const origin of input.origins) {
        this.granted.delete(origin);
      }
      return true;
    },
  };

  public async contains(input: { origins: string[] }): Promise<boolean> {
    return input.origins.every((origin) => this.granted.has(origin));
  }
}

class RevocablePageApi implements ChromiumPageCollaborationApi {
  readonly registeredScripts: RegisteredPageContentScript[] = [];
  readonly granted = new Set([`${pageOrigin}/*`]);
  #removedListener: ((permissions: { origins?: string[] }) => void) | undefined;
  readonly #host: PageOverlayHost;

  public constructor(host: PageOverlayHost) {
    this.#host = host;
  }

  readonly tabs: ChromiumPageCollaborationApi["tabs"] = {
    get: async () => ({ id: 7, url: pageUrl }),
    query: async () => [{ id: 7, url: pageUrl }],
    sendMessage: async (_tabId, message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "syncaction.page.dispose"
      ) {
        this.#host.dispose("ORIGIN_REVOKED");
      }
      return undefined;
    },
  };

  readonly permissions: ChromiumPageCollaborationApi["permissions"] = {
    contains: async ({ origins }) => origins.every((origin) => this.granted.has(origin)),
    getAll: async () => ({ origins: [...this.granted] }),
    remove: async ({ origins }) => {
      for (const origin of origins) {
        this.granted.delete(origin);
      }
      return true;
    },
    onAdded: {
      addListener: () => undefined,
    },
    onRemoved: {
      addListener: (listener) => {
        this.#removedListener = listener;
      },
    },
  };

  readonly scripting: ChromiumPageCollaborationApi["scripting"] = {
    executeScript: async ({ target }) => [
      {
        frameId: target.frameIds[0]!,
        documentId: "fixture-document",
      },
    ],
    getRegisteredContentScripts: async () => structuredClone(this.registeredScripts),
    registerContentScripts: async (scripts) => {
      this.registeredScripts.push(...structuredClone(scripts));
    },
    updateContentScripts: async (scripts) => {
      this.registeredScripts.splice(0, this.registeredScripts.length, ...structuredClone(scripts));
    },
    unregisterContentScripts: async () => {
      this.registeredScripts.length = 0;
    },
  };

  public revoke(origin: string): void {
    this.granted.delete(origin);
    this.#removedListener?.({ origins: [origin] });
  }
}
