import { originPatternForUrl } from "../page-collaboration/chrome-page-port.js";

export interface SidePanelTabsApi {
  query(input: {
    active: true;
    lastFocusedWindow: true;
  }): Promise<readonly { url?: string | undefined; pendingUrl?: string | undefined }[]>;
}

export interface SidePanelPermissionsApi {
  request(input: { origins: string[] }): Promise<boolean>;
}

export interface BrowserPagePermissionControllerOptions {
  readonly tabs: SidePanelTabsApi;
  readonly permissions: SidePanelPermissionsApi;
  readonly refresh: () => Promise<unknown>;
  readonly onGranted: (intentKey: string) => Promise<unknown>;
}

export interface PagePermissionRequest {
  readonly intentKey: string;
  readonly cachedOriginPattern: string | null;
}

export class BrowserPagePermissionController {
  readonly #tabs: SidePanelTabsApi;
  readonly #permissions: SidePanelPermissionsApi;
  readonly #refresh: () => Promise<unknown>;
  readonly #onGranted: (intentKey: string) => Promise<unknown>;

  public constructor(options: BrowserPagePermissionControllerOptions) {
    this.#tabs = options.tabs;
    this.#permissions = options.permissions;
    this.#refresh = options.refresh;
    this.#onGranted = options.onGranted;
  }

  public async request(input: PagePermissionRequest): Promise<boolean> {
    const tabs = await this.#tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const tab = tabs[0];
    const currentOriginPattern = originPatternForUrl(tab?.pendingUrl ?? tab?.url);
    if (currentOriginPattern !== input.cachedOriginPattern) {
      await this.#refresh();
      return false;
    }
    if (currentOriginPattern === null) {
      return false;
    }
    const granted = await this.#permissions.request({
      origins: [currentOriginPattern],
    });
    if (!granted) {
      return false;
    }
    await this.#refresh();
    await this.#onGranted(input.intentKey);
    return true;
  }
}
