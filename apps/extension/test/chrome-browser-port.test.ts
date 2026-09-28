import { describe, expect, it } from "vitest";
import { ChromeBrowserPort, type ChromiumBrowserApi } from "../src/chrome-browser-port.js";

const sessionId = "018f8f8e-4b5c-7d6e-8f90-123456789ab1";

function rawTab(
  id: number,
  options: {
    groupId?: number;
    index?: number;
    url?: string;
    pendingUrl?: string;
    status?: "loading" | "complete";
  } = {},
) {
  return {
    id,
    windowId: 1,
    groupId: options.groupId ?? -1,
    index: options.index ?? id,
    url: options.url,
    pendingUrl: options.pendingUrl,
    title: options.url ?? options.pendingUrl,
    status: options.status ?? "complete",
    pinned: false,
  };
}

class FakeChromiumApi implements ChromiumBrowserApi {
  public readonly createInputs: unknown[] = [];
  public readonly groupInputs: unknown[] = [];
  public readonly groupUpdateInputs: unknown[] = [];
  public readonly tabUpdateInputs: unknown[] = [];
  public readonly moveInputs: unknown[] = [];
  public readonly removedTabIds: number[] = [];
  public readonly ungroupedTabIds: number[] = [];
  public ignoreUngroup = false;
  public returnedTabIdOverride: number | null = null;
  public tabsState = [
    rawTab(10, { groupId: 7, index: 1, url: "https://example.com/one" }),
    rawTab(11, {
      index: 2,
      pendingUrl: "https://example.com/loading",
      status: "loading",
    }),
  ];
  public groupsState = [
    {
      id: 7,
      windowId: 1,
      title: "SyncAction · 018f8f8e",
      color: "blue",
      collapsed: false,
    },
  ];

  public readonly windows = {
    getAll: async () => [{ id: 1, type: "normal", incognito: false }],
  };

  public readonly tabGroups = {
    query: async () => structuredClone(this.groupsState),
    get: async (groupId: number) => {
      const group = this.groupsState.find((candidate) => candidate.id === groupId);
      if (group === undefined) {
        throw new Error("missing group");
      }
      return structuredClone(group);
    },
    update: async (groupId: number, input: { title: string }) => {
      this.groupUpdateInputs.push({ groupId, ...input });
      const group = this.groupsState.find((candidate) => candidate.id === groupId);
      if (group === undefined) {
        this.groupsState.push({
          id: groupId,
          windowId: 1,
          title: input.title,
          color: "blue",
          collapsed: false,
        });
      } else {
        group.title = input.title;
      }
      return this.tabGroups.get(groupId);
    },
  };

  public readonly tabs = {
    query: async () => structuredClone(this.tabsState),
    get: async (tabId: number) => {
      const tab = this.tabsState.find((candidate) => candidate.id === tabId);
      if (tab === undefined) {
        throw new Error("missing tab");
      }
      return {
        ...structuredClone(tab),
        ...(this.returnedTabIdOverride === null ? {} : { id: this.returnedTabIdOverride }),
      };
    },
    create: async (input: { url: string; active: boolean; index: number; windowId?: number }) => {
      this.createInputs.push(structuredClone(input));
      const created = rawTab(20, {
        index: input.index,
        url: input.url,
      });
      this.tabsState.push(created);
      return structuredClone(created);
    },
    group: async (input: { tabIds: number; groupId?: number }) => {
      this.groupInputs.push(structuredClone(input));
      const groupId = input.groupId ?? 8;
      const tab = this.tabsState.find((candidate) => candidate.id === input.tabIds)!;
      tab.groupId = groupId;
      return groupId;
    },
    ungroup: async (tabId: number) => {
      this.ungroupedTabIds.push(tabId);
      const tab = this.tabsState.find((candidate) => candidate.id === tabId)!;
      if (!this.ignoreUngroup) {
        tab.groupId = -1;
      }
    },
    update: async (tabId: number, input: { url: string }) => {
      this.tabUpdateInputs.push({ tabId, ...input });
      const tab = this.tabsState.find((candidate) => candidate.id === tabId)!;
      tab.url = input.url;
      tab.pendingUrl = undefined;
      tab.status = "complete";
      return structuredClone(tab);
    },
    move: async (
      tabId: number,
      input: {
        windowId: number;
        index: number;
      },
    ) => {
      this.moveInputs.push({ tabId, ...input });
      const tab = this.tabsState.find((candidate) => candidate.id === tabId)!;
      tab.windowId = input.windowId;
      tab.index = input.index;
      return structuredClone(tab);
    },
    remove: async (tabId: number) => {
      this.removedTabIds.push(tabId);
      this.tabsState = this.tabsState.filter((candidate) => candidate.id !== tabId);
    },
  };
}

describe("ChromeBrowserPort", () => {
  it("reads one normalized, fully identified browser snapshot", async () => {
    const api = new FakeChromiumApi();
    const port = new ChromeBrowserPort(api, sessionId);

    await expect(port.readState()).resolves.toEqual({
      browserSessionId: sessionId,
      windows: [{ windowId: 1, type: "normal", incognito: false }],
      groups: [
        {
          groupId: 7,
          windowId: 1,
          title: "SyncAction · 018f8f8e",
          color: "blue",
          collapsed: false,
        },
      ],
      tabs: [
        {
          tabId: 10,
          windowId: 1,
          groupId: 7,
          index: 1,
          url: "https://example.com/one",
          title: "https://example.com/one",
          status: "complete",
          pinned: false,
        },
        {
          tabId: 11,
          windowId: 1,
          groupId: null,
          index: 2,
          url: "https://example.com/loading",
          title: "https://example.com/loading",
          status: "loading",
          pinned: false,
        },
      ],
    });
  });

  it("creates inactive, groups with deterministic title, and returns normalized objects", async () => {
    const api = new FakeChromiumApi();
    const port = new ChromeBrowserPort(api, sessionId);

    const created = await port.createTab({
      url: "https://example.com/new",
      index: 3,
      windowId: 1,
    });
    const grouped = await port.groupTab({
      tabId: created.tabId,
      groupId: null,
      title: "SyncAction · 018f8f8e",
    });

    expect(api.createInputs).toEqual([
      {
        url: "https://example.com/new",
        active: false,
        index: 3,
        windowId: 1,
      },
    ]);
    expect(api.groupInputs).toEqual([{ tabIds: 20 }]);
    expect(api.groupUpdateInputs).toEqual([{ groupId: 8, title: "SyncAction · 018f8f8e" }]);
    expect(grouped).toMatchObject({
      tab: { tabId: 20, groupId: 8 },
      group: { groupId: 8, title: "SyncAction · 018f8f8e" },
    });
  });

  it("navigates, moves, and closes only the exact requested tab ID", async () => {
    const api = new FakeChromiumApi();
    const port = new ChromeBrowserPort(api, sessionId);

    await expect(
      port.navigateTab({ tabId: 10, url: "https://example.com/next" }),
    ).resolves.toMatchObject({ tabId: 10, url: "https://example.com/next" });
    await expect(port.moveTab({ tabId: 10, windowId: 1, index: 4 })).resolves.toMatchObject({
      tabId: 10,
      index: 4,
    });
    await port.closeTab(10);

    expect(api.tabUpdateInputs).toEqual([{ tabId: 10, url: "https://example.com/next" }]);
    expect(api.moveInputs).toEqual([{ tabId: 10, windowId: 1, index: 4 }]);
    expect(api.removedTabIds).toEqual([10]);
  });

  it("ungroups and re-reads the same tab without ever removing it", async () => {
    const api = new FakeChromiumApi();
    const port = new ChromeBrowserPort(api, sessionId);

    await expect(port.ungroupTab(10)).resolves.toMatchObject({
      tabId: 10,
      groupId: null,
      url: "https://example.com/one",
    });

    expect(api.ungroupedTabIds).toEqual([10]);
    expect(api.removedTabIds).toEqual([]);
    expect(api.tabsState).toContainEqual(expect.objectContaining({ id: 10, groupId: -1 }));
  });

  it("rejects an ungroup result that does not satisfy the exact-tab postcondition", async () => {
    const api = new FakeChromiumApi();
    api.ignoreUngroup = true;
    const port = new ChromeBrowserPort(api, sessionId);

    await expect(port.ungroupTab(10)).rejects.toThrow("UNGROUP_TAB_POSTCONDITION_FAILED");

    expect(api.ungroupedTabIds).toEqual([10]);
    expect(api.removedTabIds).toEqual([]);
    expect(api.tabsState).toContainEqual(expect.objectContaining({ id: 10, groupId: 7 }));
  });

  it("rejects when the post-read unexpectedly identifies a different tab", async () => {
    const api = new FakeChromiumApi();
    api.returnedTabIdOverride = 99;
    const port = new ChromeBrowserPort(api, sessionId);

    await expect(port.ungroupTab(10)).rejects.toThrow("UNGROUP_TAB_POSTCONDITION_FAILED");

    expect(api.ungroupedTabIds).toEqual([10]);
    expect(api.removedTabIds).toEqual([]);
  });

  it("fails closed when Chrome omits an object ID", async () => {
    const api = new FakeChromiumApi();
    api.tabsState[0] = { ...api.tabsState[0]!, id: undefined } as never;
    const port = new ChromeBrowserPort(api, sessionId);

    await expect(port.readState()).rejects.toThrow();
  });
});
