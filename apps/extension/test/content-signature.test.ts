// @vitest-environment happy-dom

import { RoomIdSchema } from "@syncaction/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPageCompatibilityReport,
  computeElementContentSignature,
  computePageContentSignature,
} from "../src/page-collaboration/content-signature.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-323456789a01");
const otherRoomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-323456789a02");
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-323456789a03";
const viewport = {
  widthCssPx: 1_280,
  heightCssPx: 800,
};

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "complete",
  });
});

describe("privacy-limited semantic page signature", () => {
  it("is deterministic, room-domain-separated, and insensitive to private content", async () => {
    installSemanticFixture({
      heading: "Private account balance",
      formValue: "secret-one",
      privateId: "account-a",
      privateClass: "premium-a",
      privateData: "token-a",
    });
    document.cookie = "private_session=one";
    const first = await pageSignature(roomId, "https://example.com/watch#private-one");

    installSemanticFixture({
      heading: "Completely different words",
      formValue: "secret-two",
      privateId: "account-b",
      privateClass: "premium-b",
      privateData: "token-b",
    });
    document.cookie = "private_session=two";
    const second = await pageSignature(roomId, "https://example.com/watch#private-two");
    const otherRoom = await pageSignature(otherRoomId, "https://example.com/watch#private-two");

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(otherRoom).not.toEqual(first);
    expect(first?.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("changes for semantic landmark membership and quantized placement", async () => {
    installSemanticFixture({
      heading: "A",
      formValue: "one",
      privateId: "a",
      privateClass: "a",
      privateData: "a",
    });
    const baseline = await pageSignature(roomId, "https://example.com/watch");

    document.querySelector("main")?.remove();
    const removed = await pageSignature(roomId, "https://example.com/watch");
    expect(removed).not.toEqual(baseline);

    installSemanticFixture({
      heading: "A",
      formValue: "one",
      privateId: "a",
      privateClass: "a",
      privateData: "a",
    });
    setRectangle(document.querySelector("main")!, 20, 120, 720, 420);
    const moved = await pageSignature(roomId, "https://example.com/watch");
    expect(moved).not.toEqual(baseline);
  });

  it("quantizes viewport dimensions into stable 160 CSS-pixel buckets", async () => {
    document.body.replaceChildren(document.createElement("p"));
    const first = await computePageContentSignature({
      document,
      roomId,
      pageUrl: "https://example.com/",
      viewport: { widthCssPx: 1_000, heightCssPx: 800 },
    });
    const sameBucket = await computePageContentSignature({
      document,
      roomId,
      pageUrl: "https://example.com/#private",
      viewport: { widthCssPx: 1_050, heightCssPx: 800 },
    });
    const nextBucket = await computePageContentSignature({
      document,
      roomId,
      pageUrl: "https://example.com/",
      viewport: { widthCssPx: 1_121, heightCssPx: 800 },
    });

    expect(sameBucket).toEqual(first);
    expect(nextBucket).not.toEqual(first);
  });

  it("returns null for protected, unsupported, or incomplete documents", async () => {
    expect(
      await computePageContentSignature({
        document,
        roomId,
        pageUrl: "chrome://extensions/",
        viewport,
      }),
    ).toBeNull();
    expect(
      await computePageContentSignature({
        document,
        roomId,
        pageUrl: "file:///private.html",
        viewport,
      }),
    ).toBeNull();

    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "loading",
    });
    expect(
      await computePageContentSignature({
        document,
        roomId,
        pageUrl: "https://example.com/",
        viewport,
      }),
    ).toBeNull();
  });
});

describe("privacy-limited semantic element signature", () => {
  it("uses semantic ancestry, room separation, and quantized geometry without private fields", async () => {
    document.body.innerHTML = `
      <main id="private-main" class="private-shell">
        <article data-private="one">
          <button id="private-action">Sensitive label</button>
        </article>
      </main>
    `;
    const main = document.querySelector("main")!;
    const article = document.querySelector("article")!;
    const button = document.querySelector("button")!;
    setRectangle(main, 0, 0, 1_200, 700);
    setRectangle(article, 100, 100, 800, 500);
    setRectangle(button, 200, 180, 160, 48);
    const first = await computeElementContentSignature({
      element: button,
      roomId,
      viewport,
    });

    button.setAttribute("id", "changed-private-id");
    button.setAttribute("class", "changed-private-class");
    button.setAttribute("data-private", "changed-private-data");
    button.replaceChildren("Different sensitive label");
    const same = await computeElementContentSignature({
      element: button,
      roomId,
      viewport,
    });
    const otherRoom = await computeElementContentSignature({
      element: button,
      roomId: otherRoomId,
      viewport,
    });
    setRectangle(button, 600, 180, 160, 48);
    const moved = await computeElementContentSignature({
      element: button,
      roomId,
      viewport,
    });

    expect(first).not.toBeNull();
    expect(same).toEqual(first);
    expect(otherRoom).not.toEqual(first);
    expect(moved).not.toEqual(first);
    expect(
      await computeElementContentSignature({
        element: document.createElement("div"),
        roomId,
        viewport,
      }),
    ).toBeNull();
  });
});

describe("page compatibility report projection", () => {
  it("contains no raw semantic signature source", async () => {
    installSemanticFixture({
      heading: "private",
      formValue: "secret",
      privateId: "private",
      privateClass: "private",
      privateData: "private",
    });
    const signature = await pageSignature(roomId, "https://example.com/watch");
    const report = buildPageCompatibilityReport({
      logicalTabId,
      documentRevision: {
        roomEpoch: 2,
        tabUpdatedAtSeq: 4,
      },
      canonicalPageIdentity: "url:https://example.com/watch",
      contentSignature: signature,
      media: {
        provider: "HTML5",
        mediaKey: "html5:primary-video",
      },
    });

    expect(report).toMatchObject({
      type: "page.compatibility.report",
      protocolVersion: 1,
      logicalTabId,
      contentContext: {
        contentSignature: signature,
      },
    });
    expect(JSON.stringify(report)).not.toMatch(
      /headingCountBuckets|interactiveCountBucket|landmarks|private|secret|viewport/iu,
    );
  });
});

async function pageSignature(scopedRoomId: typeof roomId, pageUrl: string) {
  return computePageContentSignature({
    document,
    roomId: scopedRoomId,
    pageUrl,
    viewport,
  });
}

function installSemanticFixture(input: {
  heading: string;
  formValue: string;
  privateId: string;
  privateClass: string;
  privateData: string;
}): void {
  document.body.innerHTML = `
    <header><h1>${input.heading}</h1></header>
    <nav><a href="/private">Private navigation</a></nav>
    <main id="${input.privateId}" class="${input.privateClass}" data-secret="${input.privateData}">
      <article><form><input value="${input.formValue}"><button>Submit</button></form></article>
      <video></video>
    </main>
    <footer></footer>
  `;
  const rectangles: Array<[string, [number, number, number, number]]> = [
    ["header", [0, 0, 1_280, 96]],
    ["nav", [0, 96, 240, 600]],
    ["main", [240, 96, 1_040, 600]],
    ["article", [280, 120, 720, 420]],
    ["form", [300, 160, 560, 240]],
    ["video", [860, 160, 320, 180]],
    ["footer", [0, 696, 1_280, 104]],
  ];
  for (const [selector, rectangle] of rectangles) {
    setRectangle(document.querySelector(selector)!, ...rectangle);
  }
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
