// @vitest-environment happy-dom

import {
  LogicalTabIdSchema,
  RoomIdSchema,
  type DocumentRevision,
  type PageCompatibilityReport,
} from "@syncaction/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PageContentCompatibilityReporter,
  type CompatibilityMutationObserver,
  type CompatibilityReporterScheduler,
} from "../src/page-collaboration/content-signature.js";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b02");
const revision = { roomEpoch: 2, tabUpdatedAtSeq: 7 } satisfies DocumentRevision;

class FakeScheduler implements CompatibilityReporterScheduler {
  public callback: (() => void) | undefined;
  public delayMs: number | undefined;
  public clearCount = 0;

  public setTimeout(callback: () => void, delayMs: number): unknown {
    this.callback = callback;
    this.delayMs = delayMs;
    return 1;
  }

  public clearTimeout(): void {
    this.callback = undefined;
    this.clearCount += 1;
  }

  public run(): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.();
  }
}

class FakeMutationObserver implements CompatibilityMutationObserver {
  public observeCount = 0;
  public disconnectCount = 0;

  public observe(): void {
    this.observeCount += 1;
  }

  public disconnect(): void {
    this.disconnectCount += 1;
  }
}

let scheduler: FakeScheduler;
let observer: FakeMutationObserver;
let notifyMutation: (() => void) | undefined;
let reports: PageCompatibilityReport[];
let now: number;
let pageUrl: string;
let reporter: PageContentCompatibilityReporter;

beforeEach(() => {
  document.documentElement.innerHTML = "<body><main></main><h1></h1><button></button></body>";
  vi.spyOn(document.querySelector("main")!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(80, 120, 640, 400),
  );
  scheduler = new FakeScheduler();
  observer = new FakeMutationObserver();
  reports = [];
  now = 10_000;
  pageUrl = "https://example.com/article#private-fragment";
  reporter = new PageContentCompatibilityReporter({
    document,
    roomId,
    readPageUrl: () => pageUrl,
    readViewport: () => ({ widthCssPx: 1_280, heightCssPx: 720 }),
    emit: async (report) => {
      reports.push(report);
    },
    now: () => now,
    scheduler,
    createMutationObserver: (callback) => {
      notifyMutation = callback;
      return observer;
    },
    addPageShowListener: (listener) => window.addEventListener("pageshow", listener),
    removePageShowListener: (listener) => window.removeEventListener("pageshow", listener),
  });
});

describe("PageContentCompatibilityReporter", () => {
  it("reports an authorized document once and recomputes for canonical or media identity changes", async () => {
    await reporter.setContext({ logicalTabId, documentRevision: revision });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      type: "page.compatibility.report",
      logicalTabId,
      contentContext: {
        canonicalPageIdentity: "url:https://example.com/article",
        media: null,
      },
    });
    expect(observer.observeCount).toBe(1);

    await reporter.setContext({ logicalTabId, documentRevision: revision });
    expect(reports).toHaveLength(1);

    await reporter.setMedia({
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
    });
    expect(reports).toHaveLength(2);
    expect(reports.at(-1)?.contentContext.media).toEqual({
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
    });

    pageUrl = "https://example.com/another#still-private";
    window.dispatchEvent(new Event("pageshow"));
    await reporter.whenIdle();
    expect(reports).toHaveLength(3);
    expect(reports.at(-1)?.contentContext.canonicalPageIdentity).toBe(
      "url:https://example.com/another",
    );
  });

  it("debounces semantic mutations for one second and never computes more than once per five seconds", async () => {
    await reporter.setContext({ logicalTabId, documentRevision: revision });
    notifyMutation?.();
    expect(scheduler.delayMs).toBe(5_000);

    now += 5_000;
    scheduler.run();
    await reporter.whenIdle();
    expect(reports).toHaveLength(1);

    document.body.append(document.createElement("nav"));
    vi.spyOn(document.querySelector("nav")!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 1_280, 80),
    );
    notifyMutation?.();
    expect(scheduler.delayMs).toBe(5_000);
    now += 5_000;
    scheduler.run();
    await reporter.whenIdle();
    expect(reports).toHaveLength(2);
  });

  it("disconnects observation and cancels pending work before permission cleanup", async () => {
    await reporter.setContext({ logicalTabId, documentRevision: revision });
    notifyMutation?.();

    reporter.dispose();

    expect(observer.disconnectCount).toBe(1);
    expect(scheduler.clearCount).toBe(1);
    window.dispatchEvent(new Event("pageshow"));
    scheduler.run();
    await reporter.whenIdle();
    expect(reports).toHaveLength(1);
  });
});
