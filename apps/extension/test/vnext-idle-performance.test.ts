import { readFile } from "node:fs/promises";
import type { ExtensionAppStatus } from "../src/app-controller.js";
import type { ServerProfile } from "../src/server-profile.js";
import { UiStateHub, type UiStateHubPort, type UiStateHubSource } from "../src/ui/ui-state-hub.js";
import type { UiCommand, UiPageAccessSlice } from "../src/ui/ui-protocol.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const profile: ServerProfile = {
  profileId: "syncaction-production",
  baseUrl: "https://syncaction.example.com",
  mode: "VNEXT",
  metadata: {
    serverId: "10000000-0000-4000-8000-000000000001",
    displayName: "SyncAction",
    softwareVersion: "0.9.3",
    protocolVersion: "1",
    minimumClientVersion: "0.8.1",
    termsVersion: "2026-07-30",
    capabilities: ["public-rooms"],
    limits: { ordinaryActiveRooms: 5, ordinaryOpenTabs: 20 },
  },
  lastHealthyAt: 1,
};

const pageAccess: UiPageAccessSlice = {
  bindings: null,
  tabId: null,
  documentRevision: null,
  contentCompatibility: null,
  origin: null,
  supported: false,
  browserPermissionGranted: false,
  termsAccepted: false,
  serverTermsVersion: null,
  disclosureVersion: 1,
  enabledFeatures: [],
  policySyncPendingCount: 0,
  reason: "NO_ACTIVE_TAB",
};

function idleStatus(): ExtensionAppStatus {
  return {
    phase: "AUTHENTICATED_NO_ROOM",
    account: null,
    profiles: [profile],
    selectedProfileId: profile.profileId,
    selectedProfile: profile,
    serverCapabilities: ["public-rooms"],
    publicRooms: [],
    publicRoomsUnavailableReason: null,
    pointerUnavailableReason: null,
    contentCompatibilityUnavailableReason: null,
    notifications: [],
    notificationCursor: 0,
    unreadNotificationCount: 0,
    onboardingRequired: false,
    rooms: [],
    invitations: [],
    selectedRoomId: null,
    roomDetail: null,
    room: null,
    errorCode: null,
    collaboration: {
      capacity: { openTabCount: 0, limit: 20, exemption: "NOT_EXEMPT" },
      navigation: { canJump: false, disabledReason: "ROOM_NOT_SELECTED" },
      pages: [],
      members: [],
      playbackGroups: [],
      tools: [],
      proposals: [],
      annotation: {
        used: 0,
        capacity: null,
        lockedCount: 0,
        state: "UNAVAILABLE",
        canCreate: false,
        disabledReason: "ROOM_NOT_SELECTED",
      },
      activities: [],
    },
  };
}

class CountingSource implements UiStateHubSource {
  public statusReads = 0;
  public profileReads = 0;
  public pageAccessReads = 0;
  public roomListRefreshes = 0;
  public browserEnumerations = 0;

  public async readStatus(): Promise<ExtensionAppStatus> {
    this.statusReads += 1;
    return idleStatus();
  }

  public async readProfiles(): Promise<ServerProfile[]> {
    this.profileReads += 1;
    return [structuredClone(profile)];
  }

  public async readPageAccess(): Promise<UiPageAccessSlice> {
    this.pageAccessReads += 1;
    return structuredClone(pageAccess);
  }

  public subscribeChanged(): () => void {
    return () => undefined;
  }

  public async execute(_command: UiCommand): Promise<unknown> {
    void _command;
    throw new Error("IDLE_UI_MUST_NOT_EXECUTE_COMMANDS");
  }
}

class IdlePort implements UiStateHubPort {
  public readonly posted: unknown[] = [];
  public readonly onMessage = {
    addListener: (_listener: (message: unknown) => void): void => void _listener,
    removeListener: (_listener: (message: unknown) => void): void => void _listener,
  };
  public readonly onDisconnect = {
    addListener: (_listener: () => void): void => void _listener,
    removeListener: (_listener: () => void): void => void _listener,
  };

  public postMessage(message: unknown): void {
    this.posted.push(structuredClone(message));
  }
}

afterEach(() => vi.useRealTimers());

describe("vNext idle performance acceptance", () => {
  it("does no polling, room refresh, or browser enumeration during ten idle minutes", async () => {
    vi.useFakeTimers();
    const source = new CountingSource();
    const hub = new UiStateHub({ source });
    const port = new IdlePort();
    await hub.attach(port);

    source.statusReads = 0;
    source.profileReads = 0;
    source.pageAccessReads = 0;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

    expect(source).toMatchObject({
      statusReads: 0,
      profileReads: 0,
      pageAccessReads: 0,
      roomListRefreshes: 0,
      browserEnumerations: 0,
    });
    expect(port.posted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    hub.dispose();
  });

  it("keeps the side panel and UI store event-driven", async () => {
    const [entrypoint, store, hub, client] = await Promise.all([
      readFile(new URL("../entrypoints/sidepanel/main.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/ui-vnext/store.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/ui/ui-state-hub.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/ui/ui-port-client.ts", import.meta.url), "utf8"),
    ]);

    for (const source of [entrypoint, store, hub]) {
      expect(source).not.toMatch(/\bsetInterval\s*\(/u);
    }
    expect(entrypoint).not.toMatch(/\bsetTimeout\s*\(/u);
    expect(store).not.toMatch(/\bsetTimeout\s*\(/u);
    expect(client).not.toMatch(/\bsetInterval\s*\(/u);
    expect(entrypoint.match(/\brender\s*\(/gu)).toHaveLength(2);
    expect(entrypoint).toContain('window.addEventListener(\n  "unload"');
  });
});
