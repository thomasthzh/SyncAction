import type { ServerProfile } from "../src/server-profile.js";
import type { ExtensionAppStatus } from "../src/app-controller.js";
import { RoomIdSchema } from "@syncaction/protocol";
import {
  UiStateHub,
  projectUiSlice,
  projectUiState,
  type UiStateHubPort,
  type UiStateHubScheduler,
  type UiStateHubSource,
} from "../src/ui/ui-state-hub.js";
import {
  UiServerMessageSchema,
  UiStateSlicesSchema,
  type UiCommand,
  type UiPageAccessSlice,
  type UiServerMessage,
  type UiSliceHint,
  type UiSliceName,
} from "../src/ui/ui-protocol.js";
import { describe, expect, it, vi } from "vitest";

const commandId = "018f8f8e-4b5c-7d6e-8f90-123456789c01";
const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c02");
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789c03";

function profile(): ServerProfile {
  return {
    profileId: "syncaction-production",
    baseUrl: "https://syncaction.example.com",
    mode: "UNVERIFIED",
    metadata: null,
    lastHealthyAt: null,
  };
}

function roomDetail(revision = 0): NonNullable<ExtensionAppStatus["roomDetail"]> {
  return {
    id: roomId,
    name: "Design room",
    role: "OWNER",
    roomEpoch: 0,
    visibility: "PUBLIC",
    joinPolicy: "OPEN",
    roomRevision: revision,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    members: [
      {
        userId,
        username: "alice",
        displayName: "Alice",
        role: "OWNER",
        joinedAt: "2026-07-30T00:00:00.000Z",
      },
    ],
    pendingInvitations: [],
  };
}

function collaboration(): ExtensionAppStatus["collaboration"] {
  return {
    capacity: { openTabCount: 0, limit: 20, exemption: "NOT_EXEMPT" },
    navigation: { canJump: false, disabledReason: "NO_ACTIVE_PAGE" },
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
  };
}

function status(): ExtensionAppStatus {
  const selected = profile();
  return {
    phase: "AUTHENTICATED_NO_ROOM",
    account: null,
    profiles: [selected],
    selectedProfileId: selected.profileId,
    selectedProfile: selected,
    serverCapabilities: [],
    publicRooms: [],
    publicRoomsUnavailableReason: null,
    pointerUnavailableReason: null,
    contentCompatibilityUnavailableReason: null,
    notifications: [],
    notificationCursor: 0,
    unreadNotificationCount: 0,
    onboardingRequired: true,
    rooms: [],
    invitations: [],
    selectedRoomId: null,
    roomDetail: null,
    room: null,
    errorCode: null,
    collaboration: collaboration(),
  };
}

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

class ManualScheduler implements UiStateHubScheduler {
  readonly #tasks: Array<() => void | Promise<void>> = [];

  public schedule(task: () => void | Promise<void>): void {
    this.#tasks.push(task);
  }

  public async flush(): Promise<void> {
    while (this.#tasks.length > 0) {
      await this.#tasks.shift()!();
    }
  }
}

class FakeSource implements UiStateHubSource {
  public status = status();
  public profiles = [profile()];
  public pageAccess = structuredClone(pageAccess);
  public statusReads = 0;
  public profileReads = 0;
  public pageAccessReads = 0;
  public readonly executeCalls: UiCommand[] = [];
  readonly #listeners = new Set<(hint?: UiSliceHint) => void>();

  public async readStatus(): Promise<ExtensionAppStatus> {
    this.statusReads += 1;
    return structuredClone(this.status);
  }

  public async readProfiles(): Promise<ServerProfile[]> {
    this.profileReads += 1;
    return structuredClone(this.profiles);
  }

  public async readPageAccess(): Promise<UiPageAccessSlice> {
    this.pageAccessReads += 1;
    return structuredClone(this.pageAccess);
  }

  public subscribeChanged(listener: (hint?: UiSliceHint) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async execute(command: UiCommand): Promise<unknown> {
    this.executeCalls.push(command);
    if (command.name === "ONBOARDING_DISMISS") {
      this.status.onboardingRequired = false;
      this.emit();
      return { dismissed: true };
    }
    return null;
  }

  public emit(hint?: readonly UiSliceName[]): void {
    for (const listener of this.#listeners) {
      listener(hint);
    }
  }
}

class FakePort implements UiStateHubPort {
  public readonly messages: UiServerMessage[] = [];
  public readonly messageListeners = new Set<(message: unknown) => void>();
  public readonly disconnectListeners = new Set<() => void>();
  public removedMessageListeners = 0;
  public removedDisconnectListeners = 0;

  public readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.add(listener);
    },
    removeListener: (listener: (message: unknown) => void): void => {
      if (this.messageListeners.delete(listener)) {
        this.removedMessageListeners += 1;
      }
    },
  };

  public readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.add(listener);
    },
    removeListener: (listener: () => void): void => {
      if (this.disconnectListeners.delete(listener)) {
        this.removedDisconnectListeners += 1;
      }
    },
  };

  public postMessage(message: unknown): void {
    this.messages.push(UiServerMessageSchema.parse(message));
  }

  public receive(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  public disconnect(): void {
    for (const listener of [...this.disconnectListeners]) {
      listener();
    }
  }
}

function createHub() {
  const source = new FakeSource();
  const scheduler = new ManualScheduler();
  const hub = new UiStateHub({ source, scheduler });
  return { source, scheduler, hub };
}

describe("UiStateHub", () => {
  it("projects one requested slice without rebuilding the complete snapshot", () => {
    const source = status();
    const profiles = [profile()];
    const full = projectUiState(source, profiles, pageAccess);

    expect(projectUiSlice("room", source, profiles, pageAccess)).toEqual(full.room);
    expect(projectUiSlice("pageAccess", source, profiles, pageAccess)).toEqual(full.pageAccess);
  });

  it("does not parse the complete state schema for an incremental slice refresh", async () => {
    const { source, scheduler, hub } = createHub();
    const port = new FakePort();
    await hub.attach(port);
    const parseSpy = vi.spyOn(UiStateSlicesSchema, "parse");

    source.status.collaboration = {
      ...source.status.collaboration,
      capacity: { openTabCount: 1, limit: 20, exemption: "NOT_EXEMPT" },
    };
    source.emit(["collaboration"]);
    await scheduler.flush();

    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it("projects and sends one strict complete snapshot when a port attaches", async () => {
    const { source, hub } = createHub();
    const port = new FakePort();

    await hub.attach(port);

    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]).toEqual({
      type: "ui.state.snapshot",
      versions: {
        shell: 0,
        discovery: 0,
        room: 0,
        collaboration: 0,
        notifications: 0,
        pageAccess: 0,
      },
      slices: projectUiState(source.status, source.profiles, source.pageAccess),
    });
  });

  it("coalesces a burst and emits only the changed slice with one version increment", async () => {
    const { source, scheduler, hub } = createHub();
    const port = new FakePort();
    await hub.attach(port);

    source.status.roomDetail = roomDetail(1);
    source.status.selectedRoomId = roomId;
    source.emit();
    source.emit();
    source.emit();
    await scheduler.flush();

    expect(port.messages.slice(1)).toEqual([
      expect.objectContaining({
        type: "ui.state.patch",
        slice: "room",
        fromVersion: 0,
        toVersion: 1,
        value: expect.objectContaining({
          selectedRoomId: roomId,
          detail: expect.objectContaining({ roomRevision: 1 }),
        }),
      }),
    ]);

    source.emit();
    await scheduler.flush();
    expect(port.messages).toHaveLength(2);
  });

  it("coalesces collaboration hints without rereading unrelated authoritative inputs", async () => {
    const { source, scheduler, hub } = createHub();
    const port = new FakePort();
    await hub.attach(port);
    const readsAfterAttach = {
      status: source.statusReads,
      profiles: source.profileReads,
      pageAccess: source.pageAccessReads,
    };

    source.status.collaboration = {
      ...source.status.collaboration,
      capacity: { openTabCount: 1, limit: 20, exemption: "NOT_EXEMPT" },
    };
    source.emit(["collaboration"]);
    source.emit(["collaboration"]);
    source.emit(["collaboration"]);
    await scheduler.flush();

    expect(source.statusReads).toBe(readsAfterAttach.status + 1);
    expect(source.profileReads).toBe(readsAfterAttach.profiles);
    expect(source.pageAccessReads).toBe(readsAfterAttach.pageAccess);
    expect(port.messages.slice(1)).toEqual([
      expect.objectContaining({
        type: "ui.state.patch",
        slice: "collaboration",
        value: expect.objectContaining({
          capacity: expect.objectContaining({ openTabCount: 1 }),
        }),
      }),
    ]);
  });

  it("refreshes only page access for an exact page-access hint", async () => {
    const { source, scheduler, hub } = createHub();
    const port = new FakePort();
    await hub.attach(port);
    const readsAfterAttach = {
      status: source.statusReads,
      profiles: source.profileReads,
      pageAccess: source.pageAccessReads,
    };

    source.pageAccess = { ...source.pageAccess, reason: "BROWSER_PERMISSION_REQUIRED" };
    source.emit(["pageAccess"]);
    await scheduler.flush();

    expect(source.statusReads).toBe(readsAfterAttach.status);
    expect(source.profileReads).toBe(readsAfterAttach.profiles);
    expect(source.pageAccessReads).toBe(readsAfterAttach.pageAccess + 1);
    expect(port.messages.at(-1)).toMatchObject({
      type: "ui.state.patch",
      slice: "pageAccess",
      value: { reason: "BROWSER_PERMISSION_REQUIRED" },
    });
  });

  it("sends state patches before the correlated command result", async () => {
    const { source, hub } = createHub();
    const port = new FakePort();
    await hub.attach(port);

    port.receive({
      type: "ui.command",
      commandId,
      name: "ONBOARDING_DISMISS",
    });

    await vi.waitFor(() => expect(port.messages).toHaveLength(3));
    expect(port.messages.slice(1)).toEqual([
      expect.objectContaining({
        type: "ui.state.patch",
        slice: "shell",
        value: expect.objectContaining({ onboardingRequired: false }),
      }),
      {
        type: "ui.command.result",
        commandId,
        ok: true,
        value: { dismissed: true },
      },
    ]);
    expect(source.executeCalls).toHaveLength(1);
  });

  it("returns a stable correlated error only after refreshing authoritative state", async () => {
    const { source, hub } = createHub();
    source.execute = vi.fn(async () => {
      source.status.errorCode = "ROOM_OWNER_REQUIRED";
      source.emit();
      throw new Error("ROOM_OWNER_REQUIRED");
    });
    const port = new FakePort();
    await hub.attach(port);

    port.receive({
      type: "ui.command",
      commandId,
      name: "ROOM_DISSOLVE",
    });

    await vi.waitFor(() => expect(port.messages).toHaveLength(3));
    expect(port.messages[1]).toMatchObject({
      type: "ui.state.patch",
      slice: "shell",
      value: expect.objectContaining({ errorCode: "ROOM_OWNER_REQUIRED" }),
    });
    expect(port.messages[2]).toEqual({
      type: "ui.command.result",
      commandId,
      ok: false,
      errorCode: "ROOM_OWNER_REQUIRED",
    });
  });

  it("answers stale resync and a reconnect with current full snapshots", async () => {
    const { source, scheduler, hub } = createHub();
    const first = new FakePort();
    await hub.attach(first);
    source.status.onboardingRequired = false;
    source.emit();
    await scheduler.flush();

    const second = new FakePort();
    await hub.attach(second);
    expect(second.messages[0]).toMatchObject({
      type: "ui.state.snapshot",
      versions: { shell: 1 },
      slices: { shell: { onboardingRequired: false } },
    });

    second.receive({
      type: "ui.resync",
      versions: {
        shell: 0,
        discovery: 0,
        room: 0,
        collaboration: 0,
        notifications: 0,
        pageAccess: 0,
      },
    });
    await vi.waitFor(() => expect(second.messages).toHaveLength(2));
    expect(second.messages[1]).toMatchObject({
      type: "ui.state.snapshot",
      versions: { shell: 1 },
    });
  });

  it("removes all port listeners and sends nothing after disconnect", async () => {
    const { source, scheduler, hub } = createHub();
    const port = new FakePort();
    await hub.attach(port);

    port.disconnect();
    expect(port.messageListeners).toHaveLength(0);
    expect(port.disconnectListeners).toHaveLength(0);
    expect(port.removedMessageListeners).toBe(1);
    expect(port.removedDisconnectListeners).toBe(1);

    source.status.onboardingRequired = false;
    source.emit();
    await scheduler.flush();
    expect(port.messages).toHaveLength(1);

    hub.dispose();
  });
});
