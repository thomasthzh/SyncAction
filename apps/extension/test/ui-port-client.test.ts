import { describe, expect, it, vi } from "vitest";
import {
  reconstructExtensionAppStatus,
  UiPortClient,
  type UiPortClientPort,
  type UiPortClientScheduler,
} from "../src/ui/ui-port-client.js";
import {
  UiStateSnapshotSchema,
  type UiStateSlices,
  type UiSliceVersions,
} from "../src/ui/ui-protocol.js";

const commandId = "018f8f8e-4b5c-7d6e-8f90-123456789c01";

function slices(): UiStateSlices {
  return {
    shell: {
      phase: "SIGNED_OUT",
      account: null,
      profiles: [
        {
          profileId: "syncaction-production",
          baseUrl: "https://syncaction.example.com",
          mode: "UNVERIFIED",
          metadata: null,
          lastHealthyAt: null,
        },
      ],
      selectedProfileId: "syncaction-production",
      onboardingRequired: true,
      errorCode: null,
    },
    discovery: { publicRooms: [], rooms: [], invitations: [] },
    room: { selectedRoomId: null, detail: null, runtime: null },
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
    notifications: { items: [], unreadCount: 0, cursor: 0 },
    pageAccess: {
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
    },
  };
}

function versions(value = 0): UiSliceVersions {
  return {
    shell: value,
    discovery: value,
    room: value,
    collaboration: value,
    notifications: value,
    pageAccess: value,
  };
}

function snapshot(state = slices(), stateVersions = versions()) {
  return UiStateSnapshotSchema.parse({
    type: "ui.state.snapshot",
    versions: stateVersions,
    slices: state,
  });
}

class FakePort implements UiPortClientPort {
  public readonly posted: unknown[] = [];
  public readonly messageListeners = new Set<(message: unknown) => void>();
  public readonly disconnectListeners = new Set<() => void>();
  public disconnectCalls = 0;

  public readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.add(listener);
    },
    removeListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.delete(listener);
    },
  };

  public readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.add(listener);
    },
    removeListener: (listener: () => void): void => {
      this.disconnectListeners.delete(listener);
    },
  };

  public postMessage(message: unknown): void {
    this.posted.push(structuredClone(message));
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
    this.drop();
  }

  public receive(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(structuredClone(message));
    }
  }

  public drop(): void {
    for (const listener of [...this.disconnectListeners]) {
      listener();
    }
  }
}

class ManualScheduler implements UiPortClientScheduler {
  public readonly delays: number[] = [];
  readonly #tasks: Array<{ handle: object; task: () => void; cancelled: boolean }> = [];

  public setTimeout(task: () => void, delayMs: number): unknown {
    const item = { handle: {}, task, cancelled: false };
    this.delays.push(delayMs);
    this.#tasks.push(item);
    return item.handle;
  }

  public clearTimeout(handle: unknown): void {
    const item = this.#tasks.find((candidate) => candidate.handle === handle);
    if (item !== undefined) {
      item.cancelled = true;
    }
  }

  public runNext(): void {
    const item = this.#tasks.shift();
    if (item !== undefined && !item.cancelled) {
      item.task();
    }
  }
}

function createClient(ports = [new FakePort()]) {
  const scheduler = new ManualScheduler();
  let index = 0;
  const connect = vi.fn(() => {
    const port = ports[index];
    index += 1;
    if (port === undefined) {
      throw new Error("NO_TEST_PORT");
    }
    return port;
  });
  const client = new UiPortClient({
    connect,
    scheduler,
    createCommandId: () => commandId,
  });
  return { client, scheduler, connect, ports };
}

describe("UiPortClient", () => {
  it("reconstructs the legacy renderer status without trusting unknown capabilities", () => {
    const state = slices();
    state.shell.profiles[0] = {
      ...state.shell.profiles[0]!,
      mode: "VNEXT",
      metadata: {
        serverId: "018f8f8e-4b5c-7d6e-8f90-123456789c10",
        displayName: "Team",
        softwareVersion: "0.9.3",
        protocolVersion: "1",
        minimumClientVersion: "0.9.0",
        termsVersion: "2026-07-30",
        capabilities: ["public-rooms", "future-capability"],
        limits: { ordinaryActiveRooms: 5, ordinaryOpenTabs: 20 },
      },
      lastHealthyAt: 1,
    };

    expect(reconstructExtensionAppStatus(state)).toMatchObject({
      selectedProfile: { mode: "VNEXT" },
      serverCapabilities: ["public-rooms"],
      publicRoomsUnavailableReason: null,
      pointerUnavailableReason: "SERVER_CAPABILITY_VOLATILE_POINTER_UNAVAILABLE",
    });
  });

  it("reconstructs immutable state from one snapshot and matching slice patches", () => {
    const port = new FakePort();
    const { client } = createClient([port]);
    const listener = vi.fn();
    client.subscribe(listener);
    client.start();
    port.receive(snapshot());

    const initial = client.getState();
    const initialUpdate = listener.mock.calls[0]?.[0] as
      | {
          state: UiStateSlices;
          versions: UiSliceVersions;
          changedSlices: readonly string[];
        }
      | undefined;
    expect(initial).toEqual(slices());
    expect(listener).toHaveBeenCalledOnce();
    expect(initialUpdate).toMatchObject({
      versions: versions(),
      changedSlices: ["shell", "discovery", "room", "collaboration", "notifications", "pageAccess"],
    });

    port.receive({
      type: "ui.state.patch",
      slice: "shell",
      fromVersion: 0,
      toVersion: 1,
      value: { ...slices().shell, onboardingRequired: false },
    });

    expect(client.getState()).toMatchObject({
      shell: { onboardingRequired: false },
      discovery: slices().discovery,
    });
    expect(client.getVersions()).toEqual({ ...versions(), shell: 1 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(client.getState()).not.toBe(initial);
    const patchUpdate = listener.mock.calls[1]?.[0] as
      | {
          state: UiStateSlices;
          versions: UiSliceVersions;
          changedSlices: readonly string[];
        }
      | undefined;
    expect(patchUpdate).toMatchObject({
      versions: { ...versions(), shell: 1 },
      changedSlices: ["shell"],
    });
    expect(patchUpdate?.state.discovery).toBe(initialUpdate?.state.discovery);
    expect(patchUpdate?.state.room).toBe(initialUpdate?.state.room);
  });

  it("requests one full resync instead of applying an invalid or gapped patch", () => {
    const port = new FakePort();
    const { client } = createClient([port]);
    client.start();
    port.receive(snapshot());

    port.receive({
      type: "ui.state.patch",
      slice: "room",
      fromVersion: 9,
      toVersion: 10,
      value: slices().room,
    });
    port.receive({
      type: "ui.state.patch",
      slice: "room",
      fromVersion: 9,
      toVersion: 10,
      value: slices().room,
    });

    expect(port.posted).toEqual([
      {
        type: "ui.resync",
        versions: versions(),
      },
    ]);
    expect(client.getVersions()).toEqual(versions());
  });

  it("correlates command success and failure and rejects pending work on disconnect", async () => {
    const port = new FakePort();
    const { client } = createClient([port]);
    client.start();
    port.receive(snapshot());

    const success = client.command({ name: "ONBOARDING_DISMISS" });
    expect(port.posted.at(-1)).toEqual({
      type: "ui.command",
      commandId,
      name: "ONBOARDING_DISMISS",
    });
    port.receive({
      type: "ui.command.result",
      commandId,
      ok: true,
      value: { dismissed: true },
    });
    await expect(success).resolves.toEqual({ dismissed: true });

    const failure = client.command({ name: "ROOM_DISSOLVE" });
    port.receive({
      type: "ui.command.result",
      commandId,
      ok: false,
      errorCode: "ROOM_OWNER_REQUIRED",
    });
    await expect(failure).rejects.toThrow("ROOM_OWNER_REQUIRED");

    const pending = client.command({ name: "AUTH_LOGOUT" });
    port.drop();
    await expect(pending).rejects.toThrow("UI_PORT_DISCONNECTED");
  });

  it("reconnects with bounded backoff and reports local versions after every reconnect", () => {
    const ports = Array.from({ length: 7 }, () => new FakePort());
    const { client, scheduler, connect } = createClient(ports);
    client.start();
    ports[0]!.receive(snapshot(slices(), { ...versions(), shell: 3 }));

    for (let index = 0; index < 6; index += 1) {
      ports[index]!.drop();
      scheduler.runNext();
      expect(ports[index + 1]!.posted).toEqual([
        {
          type: "ui.resync",
          versions: { ...versions(), shell: 3 },
        },
      ]);
    }

    expect(scheduler.delays).toEqual([250, 500, 1_000, 2_000, 5_000, 5_000]);
    expect(connect).toHaveBeenCalledTimes(7);
  });

  it("resets reconnect backoff after a valid snapshot", () => {
    const ports = [new FakePort(), new FakePort(), new FakePort()];
    const { client, scheduler } = createClient(ports);
    client.start();
    ports[0]!.receive(snapshot());
    ports[0]!.drop();
    scheduler.runNext();
    ports[1]!.receive(snapshot());
    ports[1]!.drop();

    expect(scheduler.delays).toEqual([250, 250]);
  });

  it("disposes listeners, reconnect timers, and pending commands permanently", async () => {
    const ports = [new FakePort(), new FakePort()];
    const { client, scheduler, connect } = createClient(ports);
    client.start();
    ports[0]!.receive(snapshot());
    const pending = client.command({ name: "AUTH_LOGOUT" });
    ports[0]!.drop();
    client.dispose();
    scheduler.runNext();

    await expect(pending).rejects.toThrow("UI_PORT_DISCONNECTED");
    expect(connect).toHaveBeenCalledOnce();
    expect(ports[0]!.messageListeners.size).toBe(0);
    expect(ports[0]!.disconnectListeners.size).toBe(0);
  });
});
