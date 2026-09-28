import { describe, expect, it } from "vitest";
import { EffectLedger } from "../src/effect-ledger.js";

const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";
const effectIds = [
  "018f8f8e-4b5c-7d6e-8f90-123456789ac0",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac1",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac2",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac3",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac4",
  "018f8f8e-4b5c-7d6e-8f90-123456789ac5",
];

function effect(
  index: number,
  expectation:
    | { type: "TAB_CREATED"; tabId: number | null; url: string }
    | { type: "TAB_GROUPED"; tabId: number; groupId: number | null }
    | { type: "TAB_NAVIGATED"; tabId: number; url: string }
    | { type: "TAB_MOVED"; tabId: number; windowId: number; index: number }
    | { type: "TAB_CLOSED"; tabId: number }
    | { type: "TAB_METADATA"; tabId: number; title: string | null },
) {
  return {
    effectId: effectIds[index],
    logicalTabId,
    serverSeq: 7,
    expectation,
    startedAtMs: 1_000,
    expiresAtMs: 2_000,
  };
}

describe("per-effect browser callback ledger", () => {
  it("matches create only after the actuator attaches the returned tab ID", () => {
    const ledger = new EffectLedger();
    ledger.begin(
      effect(0, {
        type: "TAB_CREATED",
        tabId: null,
        url: "https://example.com/new",
      }),
    );

    expect(
      ledger.consume({ type: "TAB_CREATED", tabId: 10, url: "https://example.com/new" }, 1_100),
    ).toBeUndefined();
    ledger.attachCreatedTab(effectIds[0], 10);
    expect(
      ledger.consume({ type: "TAB_CREATED", tabId: 10, url: "https://example.com/new" }, 1_100),
    ).toMatchObject({ effectId: effectIds[0], logicalTabId, serverSeq: 7 });
  });

  it("matches a newly created group only after attaching its returned group ID", () => {
    const ledger = new EffectLedger();
    ledger.begin(
      effect(1, {
        type: "TAB_GROUPED",
        tabId: 10,
        groupId: null,
      }),
    );

    expect(ledger.consume({ type: "TAB_GROUPED", tabId: 10, groupId: 7 }, 1_100)).toBeUndefined();
    ledger.attachGroup(effectIds[1], 7);
    expect(ledger.consume({ type: "TAB_GROUPED", tabId: 10, groupId: 7 }, 1_100)).toMatchObject({
      effectId: effectIds[1],
      logicalTabId,
    });
  });

  it("matches group, navigation, move, close, and metadata exactly once", () => {
    const ledger = new EffectLedger();
    const entries = [
      effect(1, { type: "TAB_GROUPED", tabId: 10, groupId: 4 }),
      effect(2, {
        type: "TAB_NAVIGATED",
        tabId: 10,
        url: "https://example.com/next",
      }),
      effect(3, { type: "TAB_MOVED", tabId: 10, windowId: 2, index: 3 }),
      effect(4, { type: "TAB_CLOSED", tabId: 10 }),
      effect(5, { type: "TAB_METADATA", tabId: 10, title: "Updated" }),
    ] as const;
    for (const entry of entries) {
      ledger.begin(entry);
    }
    const events = entries.map((entry) => entry.expectation);

    for (const [index, event] of events.entries()) {
      expect(ledger.consume(event, 1_100)?.effectId).toBe(effectIds[index + 1]);
      expect(ledger.consume(event, 1_100)).toBeUndefined();
    }
    expect(ledger.size).toBe(0);
  });

  it("does not consume unrelated, mismatched, unattached, or expired callbacks", () => {
    const ledger = new EffectLedger();
    ledger.begin(
      effect(0, {
        type: "TAB_CREATED",
        tabId: null,
        url: "https://example.com/new",
      }),
    );
    ledger.begin(
      effect(2, {
        type: "TAB_NAVIGATED",
        tabId: 10,
        url: "https://example.com/next",
      }),
    );

    expect(
      ledger.consume({ type: "TAB_NAVIGATED", tabId: 11, url: "https://example.com/next" }, 1_100),
    ).toBeUndefined();
    expect(
      ledger.consume({ type: "TAB_NAVIGATED", tabId: 10, url: "https://example.com/wrong" }, 1_100),
    ).toBeUndefined();
    expect(
      ledger.consume({ type: "TAB_CREATED", tabId: 10, url: "https://example.com/new" }, 1_100),
    ).toBeUndefined();
    expect(
      ledger.consume({ type: "TAB_NAVIGATED", tabId: 10, url: "https://example.com/next" }, 2_001),
    ).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it("rejects duplicate IDs and invalid time bounds", () => {
    const ledger = new EffectLedger();
    ledger.begin(effect(4, { type: "TAB_CLOSED", tabId: 10 }));

    expect(() => ledger.begin(effect(4, { type: "TAB_CLOSED", tabId: 11 }))).toThrow();
    expect(() =>
      ledger.begin({
        ...effect(3, {
          type: "TAB_MOVED",
          tabId: 10,
          windowId: 2,
          index: 3,
        }),
        expiresAtMs: 999,
      }),
    ).toThrow();
  });
});
