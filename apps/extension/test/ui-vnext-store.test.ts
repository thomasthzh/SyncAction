import { describe, expect, it, vi } from "vitest";
import { createUiStore } from "../src/ui-vnext/store.js";
import {
  UiPortClient,
  type UiPortClientPort,
  type UiPortClientScheduler,
} from "../src/ui/ui-port-client.js";
import {
  UiStateSnapshotSchema,
  type UiSliceVersions,
  type UiStateSlices,
} from "../src/ui/ui-protocol.js";

const commandId = "018f8f8e-4b5c-7d6e-8f90-123456789c21";

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

function snapshotAt(value: number, state = slices()) {
  return UiStateSnapshotSchema.parse({
    type: "ui.state.snapshot",
    versions: versions(value),
    slices: state,
  });
}

class FakePort implements UiPortClientPort {
  public readonly posted: unknown[] = [];
  public readonly messageListeners = new Set<(message: unknown) => void>();
  public readonly disconnectListeners = new Set<() => void>();

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
  readonly #tasks: Array<{ handle: object; task: () => void; cancelled: boolean }> = [];

  public setTimeout(task: () => void): unknown {
    const item = { handle: {}, task, cancelled: false };
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

function createHarness(ports = [new FakePort()]) {
  const scheduler = new ManualScheduler();
  let index = 0;
  const requestResync = vi.fn();
  const client = new UiPortClient({
    connect: () => {
      const port = ports[index];
      index += 1;
      if (port === undefined) {
        throw new Error("NO_TEST_PORT");
      }
      return port;
    },
    scheduler,
    onResyncRequested: requestResync,
  });
  const store = createUiStore(client, { createCommandId: () => commandId });
  client.start();
  return { client, ports, requestResync, scheduler, store };
}

describe("vNext UI store", () => {
  it("populates all six slices from the first snapshot", () => {
    const harness = createHarness();
    const state = slices();

    harness.ports[0]!.receive(snapshotAt(4, state));

    expect(harness.store.versions.value).toEqual(versions(4));
    expect(harness.store.shell.value).toEqual(state.shell);
    expect(harness.store.discovery.value).toEqual(state.discovery);
    expect(harness.store.room.value).toEqual(state.room);
    expect(harness.store.collaboration.value).toEqual(state.collaboration);
    expect(harness.store.notifications.value).toEqual(state.notifications);
    expect(harness.store.pageAccess.value).toEqual(state.pageAccess);
    expect(harness.store.transport.value).toBe("CONNECTED");
  });

  it("replaces only the slice named by a matching patch", () => {
    const harness = createHarness();
    harness.ports[0]!.receive(snapshotAt(4));
    const shell = harness.store.shell.value;
    const room = harness.store.room.value;
    const pageAccess = harness.store.pageAccess.value;
    const notifications = { items: [], unreadCount: 2, cursor: 2 };

    harness.ports[0]!.receive({
      type: "ui.state.patch",
      slice: "notifications",
      fromVersion: 4,
      toVersion: 5,
      value: notifications,
    });

    expect(harness.store.notifications.value).toEqual(notifications);
    expect(harness.store.versions.value).toEqual({ ...versions(4), notifications: 5 });
    expect(harness.store.shell.value).toBe(shell);
    expect(harness.store.room.value).toBe(room);
    expect(harness.store.pageAccess.value).toBe(pageAccess);
  });

  it("requests a resync without applying a version gap", () => {
    const harness = createHarness();
    harness.ports[0]!.receive(snapshotAt(4));
    const notifications = harness.store.notifications.value;

    harness.ports[0]!.receive({
      type: "ui.state.patch",
      slice: "notifications",
      fromVersion: 6,
      toVersion: 7,
      value: { items: [], unreadCount: 2, cursor: 2 },
    });

    expect(harness.store.versions.value.notifications).toBe(4);
    expect(harness.store.notifications.value).toBe(notifications);
    expect(harness.requestResync).toHaveBeenCalledOnce();
  });

  it("exposes one pending command ID and resolves on its matching result", async () => {
    const harness = createHarness();
    harness.ports[0]!.receive(snapshotAt(1));

    const result = harness.store.command({ name: "ONBOARDING_DISMISS" });

    expect([...harness.store.pendingCommands.value]).toEqual([commandId]);
    expect(harness.ports[0]!.posted.at(-1)).toEqual({
      type: "ui.command",
      commandId,
      name: "ONBOARDING_DISMISS",
    });
    harness.ports[0]!.receive({
      type: "ui.command.result",
      commandId,
      ok: true,
      value: { dismissed: true },
    });

    await expect(result).resolves.toEqual({
      type: "ui.command.result",
      commandId,
      ok: true,
      value: { dismissed: true },
    });
    expect(harness.store.pendingCommands.value.size).toBe(0);
  });

  it("preserves rendered slices while a disconnected transport reconnects", () => {
    const ports = [new FakePort(), new FakePort()];
    const harness = createHarness(ports);
    ports[0]!.receive(snapshotAt(3));
    const shell = harness.store.shell.value;
    const room = harness.store.room.value;

    ports[0]!.drop();

    expect(harness.store.transport.value).toBe("RECONNECTING");
    expect(harness.store.shell.value).toBe(shell);
    expect(harness.store.room.value).toBe(room);
    expect(harness.store.versions.value).toEqual(versions(3));
  });

  it("clears a stale command error only after the reconnect snapshot", async () => {
    const ports = [new FakePort(), new FakePort()];
    const harness = createHarness(ports);
    ports[0]!.receive(snapshotAt(2));
    const result = harness.store.command({ name: "ROOM_DISSOLVE" });
    ports[0]!.receive({
      type: "ui.command.result",
      commandId,
      ok: false,
      errorCode: "ROOM_OWNER_REQUIRED",
    });
    await expect(result).resolves.toEqual({
      type: "ui.command.result",
      commandId,
      ok: false,
      errorCode: "ROOM_OWNER_REQUIRED",
    });
    expect(harness.store.commandError.value).toEqual({
      commandId,
      errorCode: "ROOM_OWNER_REQUIRED",
    });

    ports[0]!.drop();
    expect(harness.store.commandError.value).not.toBeNull();
    harness.scheduler.runNext();
    expect(harness.store.transport.value).toBe("RECONNECTING");
    ports[1]!.receive(snapshotAt(2));

    expect(harness.store.transport.value).toBe("CONNECTED");
    expect(harness.store.commandError.value).toBeNull();
  });
});
