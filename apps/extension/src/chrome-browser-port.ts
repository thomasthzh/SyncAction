import {
  BrowserGroupSchema,
  BrowserStateSchema,
  BrowserTabSchema,
  type BrowserGroup,
  type BrowserPort,
  type BrowserState,
  type BrowserTab,
} from "@syncaction/browser-sync";

interface ChromiumWindow {
  id?: number | undefined;
  type?: string | undefined;
  incognito: boolean;
}

interface ChromiumGroup {
  id?: number | undefined;
  windowId: number;
  title?: string | undefined;
  color: string;
  collapsed: boolean;
}

interface ChromiumTab {
  id?: number | undefined;
  windowId: number;
  groupId: number;
  index: number;
  url?: string | undefined;
  pendingUrl?: string | undefined;
  title?: string | undefined;
  status?: string | undefined;
  pinned: boolean;
}

export interface ChromiumBrowserApi {
  windows: {
    getAll(options: { populate: false }): Promise<ChromiumWindow[]>;
  };
  tabGroups: {
    query(query: Record<string, never>): Promise<ChromiumGroup[]>;
    get(groupId: number): Promise<ChromiumGroup>;
    update(groupId: number, input: { title: string }): Promise<ChromiumGroup>;
  };
  tabs: {
    query(query: Record<string, never>): Promise<ChromiumTab[]>;
    get(tabId: number): Promise<ChromiumTab>;
    create(input: {
      url: string;
      active: false;
      index: number;
      windowId?: number;
    }): Promise<ChromiumTab>;
    group(input: { tabIds: number; groupId?: number }): Promise<number>;
    ungroup(tabId: number): Promise<void>;
    update(tabId: number, input: { url: string }): Promise<ChromiumTab>;
    move(
      tabId: number,
      input: { windowId: number; index: number },
    ): Promise<ChromiumTab | ChromiumTab[]>;
    remove(tabId: number): Promise<void>;
  };
}

export class ChromeBrowserPort implements BrowserPort {
  readonly #api: ChromiumBrowserApi;
  readonly #browserSessionId: string;

  public constructor(api: ChromiumBrowserApi, browserSessionId: string) {
    this.#api = api;
    this.#browserSessionId = browserSessionId;
  }

  public async readState(): Promise<BrowserState> {
    const [windows, groups, tabs] = await Promise.all([
      this.#api.windows.getAll({ populate: false }),
      this.#api.tabGroups.query({}),
      this.#api.tabs.query({}),
    ]);
    return BrowserStateSchema.parse({
      browserSessionId: this.#browserSessionId,
      windows: windows.map((window) => ({
        windowId: requiredId(window.id),
        type: window.type ?? "normal",
        incognito: window.incognito,
      })),
      groups: groups.map(toBrowserGroup),
      tabs: tabs.map(toBrowserTab),
    });
  }

  public async createTab(input: {
    url: string;
    index: number;
    windowId: number | null;
  }): Promise<BrowserTab> {
    const created = await this.#api.tabs.create({
      url: input.url,
      active: false,
      index: input.index,
      ...(input.windowId === null ? {} : { windowId: input.windowId }),
    });
    return BrowserTabSchema.parse(toBrowserTab(created));
  }

  public async groupTab(input: {
    tabId: number;
    groupId: number | null;
    title: string;
  }): Promise<{ tab: BrowserTab; group: BrowserGroup }> {
    const groupId = await this.#api.tabs.group({
      tabIds: input.tabId,
      ...(input.groupId === null ? {} : { groupId: input.groupId }),
    });
    await this.#api.tabGroups.update(groupId, { title: input.title });
    const [tab, group] = await Promise.all([
      this.#api.tabs.get(input.tabId),
      this.#api.tabGroups.get(groupId),
    ]);
    return {
      tab: BrowserTabSchema.parse(toBrowserTab(tab)),
      group: BrowserGroupSchema.parse(toBrowserGroup(group)),
    };
  }

  public async ungroupTab(tabId: number): Promise<BrowserTab> {
    await this.#api.tabs.ungroup(tabId);
    const ungrouped = BrowserTabSchema.parse(toBrowserTab(await this.#api.tabs.get(tabId)));
    if (ungrouped.tabId !== tabId || ungrouped.groupId !== null) {
      throw new Error("UNGROUP_TAB_POSTCONDITION_FAILED");
    }
    return ungrouped;
  }

  public async navigateTab(input: { tabId: number; url: string }): Promise<BrowserTab> {
    return BrowserTabSchema.parse(
      toBrowserTab(await this.#api.tabs.update(input.tabId, { url: input.url })),
    );
  }

  public async moveTab(input: {
    tabId: number;
    windowId: number;
    index: number;
  }): Promise<BrowserTab> {
    const moved = await this.#api.tabs.move(input.tabId, {
      windowId: input.windowId,
      index: input.index,
    });
    if (Array.isArray(moved)) {
      if (moved.length !== 1 || moved[0] === undefined) {
        throw new Error("AMBIGUOUS_MOVED_TAB");
      }
      return BrowserTabSchema.parse(toBrowserTab(moved[0]));
    }
    return BrowserTabSchema.parse(toBrowserTab(moved));
  }

  public async closeTab(tabId: number): Promise<void> {
    await this.#api.tabs.remove(tabId);
  }
}

function toBrowserGroup(group: ChromiumGroup) {
  return {
    groupId: requiredId(group.id),
    windowId: group.windowId,
    title: group.title ?? null,
    color: group.color,
    collapsed: group.collapsed,
  };
}

function toBrowserTab(tab: ChromiumTab) {
  return {
    tabId: requiredId(tab.id),
    windowId: tab.windowId,
    groupId: tab.groupId < 0 ? null : tab.groupId,
    index: tab.index,
    url: tab.pendingUrl ?? tab.url ?? null,
    title: tab.title ?? null,
    status: tab.status === "complete" ? "complete" : "loading",
    pinned: tab.pinned,
  };
}

function requiredId(id: number | undefined): number {
  if (id === undefined) {
    throw new Error("MISSING_BROWSER_OBJECT_ID");
  }
  return id;
}
