import { batch, signal, type ReadonlySignal } from "@preact/signals";
import { DEFAULT_SERVER_PROFILE_ID } from "../server-profile.js";
import { PRODUCTION_PUBLIC_SERVER_ORIGIN } from "../server-origin.js";
import type { UiPortClientTransportState } from "../ui/ui-port-client.js";
import type { UiStateUpdate } from "../ui/ui-port-client.js";
import type {
  UiCollaborationSlice,
  UiCommandRequest,
  UiCommandResult,
  UiDiscoverySlice,
  UiNotificationsSlice,
  UiPageAccessSlice,
  UiRoomSlice,
  UiShellSlice,
  UiSliceVersions,
  UiStateSlices,
} from "../ui/ui-protocol.js";

export type UiTransportState = UiPortClientTransportState;
export type UiCommandInput = UiCommandRequest;

export interface UiCommandError {
  readonly commandId: string;
  readonly errorCode: string;
}

export interface UiStoreClient {
  subscribe(listener: (update: UiStateUpdate) => void): () => void;
  subscribeTransport(listener: (state: UiTransportState) => void): () => void;
  getVersions(): UiSliceVersions;
  command(command: UiCommandInput, commandId?: string): Promise<unknown>;
}

export interface UiStore {
  readonly versions: ReadonlySignal<UiSliceVersions>;
  readonly transport: ReadonlySignal<UiTransportState>;
  readonly shell: ReadonlySignal<UiShellSlice>;
  readonly discovery: ReadonlySignal<UiDiscoverySlice>;
  readonly room: ReadonlySignal<UiRoomSlice>;
  readonly collaboration: ReadonlySignal<UiCollaborationSlice>;
  readonly notifications: ReadonlySignal<UiNotificationsSlice>;
  readonly pageAccess: ReadonlySignal<UiPageAccessSlice>;
  readonly pendingCommands: ReadonlySignal<ReadonlySet<string>>;
  readonly commandError: ReadonlySignal<UiCommandError | null>;
  command(command: UiCommandInput): Promise<UiCommandResult>;
  dispose(): void;
}

export interface CreateUiStoreOptions {
  createCommandId?: () => string;
}

function zeroVersions(): UiSliceVersions {
  return {
    shell: 0,
    discovery: 0,
    room: 0,
    collaboration: 0,
    notifications: 0,
    pageAccess: 0,
  };
}

function initialSlices(): UiStateSlices {
  return {
    shell: {
      phase: "SIGNED_OUT",
      account: null,
      profiles: [
        {
          profileId: DEFAULT_SERVER_PROFILE_ID,
          baseUrl: PRODUCTION_PUBLIC_SERVER_ORIGIN,
          mode: "UNVERIFIED",
          metadata: null,
          lastHealthyAt: null,
        },
      ],
      selectedProfileId: DEFAULT_SERVER_PROFILE_ID,
      onboardingRequired: false,
      errorCode: null,
    },
    discovery: {
      publicRooms: [],
      rooms: [],
      invitations: [],
    },
    room: {
      selectedRoomId: null,
      detail: null,
      runtime: null,
    },
    collaboration: {
      capacity: {
        openTabCount: 0,
        limit: null,
        exemption: "UNKNOWN",
      },
      navigation: {
        canJump: false,
        disabledReason: "ROOM_NOT_SELECTED",
      },
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
    notifications: {
      items: [],
      unreadCount: 0,
      cursor: 0,
    },
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

function errorCodeOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "UI_COMMAND_FAILED";
}

export function createUiStore(client: UiStoreClient, options: CreateUiStoreOptions = {}): UiStore {
  const createCommandId = options.createCommandId ?? (() => globalThis.crypto.randomUUID());
  const initial = initialSlices();
  const versionsSignal = signal<UiSliceVersions>(zeroVersions());
  const transportSignal = signal<UiTransportState>("CONNECTING");
  const shellSignal = signal<UiShellSlice>(initial.shell);
  const discoverySignal = signal<UiDiscoverySlice>(initial.discovery);
  const roomSignal = signal<UiRoomSlice>(initial.room);
  const collaborationSignal = signal<UiCollaborationSlice>(initial.collaboration);
  const notificationsSignal = signal<UiNotificationsSlice>(initial.notifications);
  const pageAccessSignal = signal<UiPageAccessSlice>(initial.pageAccess);
  const pendingCommandsSignal = signal<ReadonlySet<string>>(new Set());
  const commandErrorSignal = signal<UiCommandError | null>(null);
  let disposed = false;

  const unsubscribeTransport = client.subscribeTransport((state) => {
    if (disposed) {
      return;
    }
    batch(() => {
      transportSignal.value = state;
      if (state === "CONNECTED") {
        commandErrorSignal.value = null;
      }
    });
  });

  const unsubscribeState = client.subscribe(({ state, versions, changedSlices }) => {
    if (disposed) {
      return;
    }
    batch(() => {
      if (changedSlices.includes("shell")) {
        shellSignal.value = state.shell;
      }
      if (changedSlices.includes("discovery")) {
        discoverySignal.value = state.discovery;
      }
      if (changedSlices.includes("room")) {
        roomSignal.value = state.room;
      }
      if (changedSlices.includes("collaboration")) {
        collaborationSignal.value = state.collaboration;
      }
      if (changedSlices.includes("notifications")) {
        notificationsSignal.value = state.notifications;
      }
      if (changedSlices.includes("pageAccess")) {
        pageAccessSignal.value = state.pageAccess;
      }
      versionsSignal.value = versions;
    });
  });

  async function command(input: UiCommandInput): Promise<UiCommandResult> {
    const commandId = createCommandId();
    if (pendingCommandsSignal.peek().has(commandId)) {
      const result: UiCommandResult = {
        type: "ui.command.result",
        commandId,
        ok: false,
        errorCode: "DUPLICATE_UI_COMMAND_ID",
      };
      commandErrorSignal.value = {
        commandId,
        errorCode: result.errorCode,
      };
      return result;
    }

    batch(() => {
      pendingCommandsSignal.value = new Set([...pendingCommandsSignal.peek(), commandId]);
      commandErrorSignal.value = null;
    });
    try {
      const value = await client.command(input, commandId);
      return value === undefined
        ? {
            type: "ui.command.result",
            commandId,
            ok: true,
          }
        : {
            type: "ui.command.result",
            commandId,
            ok: true,
            value,
          };
    } catch (error) {
      const errorCode = errorCodeOf(error);
      const result: UiCommandResult = {
        type: "ui.command.result",
        commandId,
        ok: false,
        errorCode,
      };
      commandErrorSignal.value = { commandId, errorCode };
      return result;
    } finally {
      const pending = new Set(pendingCommandsSignal.peek());
      pending.delete(commandId);
      pendingCommandsSignal.value = pending;
    }
  }

  return {
    versions: versionsSignal,
    transport: transportSignal,
    shell: shellSignal,
    discovery: discoverySignal,
    room: roomSignal,
    collaboration: collaborationSignal,
    notifications: notificationsSignal,
    pageAccess: pageAccessSignal,
    pendingCommands: pendingCommandsSignal,
    commandError: commandErrorSignal,
    command,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeState();
      unsubscribeTransport();
    },
  };
}
