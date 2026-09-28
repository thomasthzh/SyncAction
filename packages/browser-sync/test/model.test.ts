import { describe, expect, it } from "vitest";
import { BrowserStateSchema, discoverRoomGroup, roomGroupTitle } from "../src/model.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";

function browserState() {
  return {
    browserSessionId: "018f8f8e-4b5c-7d6e-8f90-123456789ab2",
    windows: [
      {
        windowId: 1,
        type: "normal",
        incognito: false,
      },
    ],
    groups: [
      {
        groupId: 7,
        windowId: 1,
        title: roomGroupTitle(roomId),
        color: "blue",
        collapsed: false,
      },
    ],
    tabs: [
      {
        tabId: 10,
        windowId: 1,
        groupId: 7,
        index: 4,
        url: "https://example.com/duplicate",
        title: "Second",
        status: "complete",
        pinned: false,
      },
      {
        tabId: 9,
        windowId: 1,
        groupId: 7,
        index: 3,
        url: "https://example.com/duplicate",
        title: "First",
        status: "complete",
        pinned: false,
      },
      {
        tabId: 20,
        windowId: 1,
        groupId: null,
        index: 0,
        url: "https://personal.example/",
        title: "Personal",
        status: "complete",
        pinned: false,
      },
    ],
  };
}

describe("browser state and room-group discovery", () => {
  it("parses a complete state and discovers one exact group in tab-strip order", () => {
    const state = BrowserStateSchema.parse(browserState());

    expect(discoverRoomGroup(state, roomId)).toMatchObject({
      kind: "FOUND",
      group: { groupId: 7, windowId: 1 },
      tabs: [
        { tabId: 9, url: "https://example.com/duplicate" },
        { tabId: 10, url: "https://example.com/duplicate" },
      ],
    });
  });

  it("returns missing without treating personal tabs as shared", () => {
    const input = browserState();
    input.groups[0]!.title = "Another group";

    expect(discoverRoomGroup(BrowserStateSchema.parse(input), roomId)).toEqual({
      kind: "MISSING",
    });
  });

  it("returns ambiguity when duplicate room titles exist", () => {
    const input = browserState();
    input.groups.push({
      ...input.groups[0]!,
      groupId: 8,
    });

    expect(discoverRoomGroup(BrowserStateSchema.parse(input), roomId)).toEqual({
      kind: "AMBIGUOUS",
      reason: "DUPLICATE_ROOM_GROUP",
    });
  });

  it("rejects incognito and unsupported-window room groups", () => {
    const incognito = browserState();
    incognito.windows[0]!.incognito = true;
    expect(discoverRoomGroup(BrowserStateSchema.parse(incognito), roomId)).toEqual({
      kind: "UNSAFE",
      reason: "INCOGNITO_ROOM_GROUP",
    });

    const popup = browserState();
    popup.windows[0]!.type = "popup";
    expect(discoverRoomGroup(BrowserStateSchema.parse(popup), roomId)).toEqual({
      kind: "UNSAFE",
      reason: "UNSUPPORTED_WINDOW",
    });
  });

  it("rejects duplicate IDs, duplicate window indexes, and dangling groups", () => {
    const duplicateTab = browserState();
    duplicateTab.tabs[1]!.tabId = duplicateTab.tabs[0]!.tabId;
    expect(() => BrowserStateSchema.parse(duplicateTab)).toThrow();

    const duplicateIndex = browserState();
    duplicateIndex.tabs[1]!.index = duplicateIndex.tabs[0]!.index;
    expect(() => BrowserStateSchema.parse(duplicateIndex)).toThrow();

    const danglingGroup = browserState();
    danglingGroup.tabs[0]!.groupId = 999;
    expect(() => BrowserStateSchema.parse(danglingGroup)).toThrow();
  });

  it("uses a deterministic room marker and rejects non-canonical or malformed states", () => {
    expect(roomGroupTitle(roomId)).toBe("SyncAction · 018f8f8e");
    expect(() => roomGroupTitle(roomId.toUpperCase())).toThrow();
    expect(() => roomGroupTitle("not-a-room")).toThrow();
    expect(() =>
      BrowserStateSchema.parse({
        ...browserState(),
        unknown: true,
      }),
    ).toThrow();
  });
});
