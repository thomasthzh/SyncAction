import { ServerCapabilitySchema, type ServerCapability } from "@syncaction/protocol";
import type { ExtensionAppStatus } from "../app-controller.js";
import type { ExtensionStatus } from "../background-controller.js";
import {
  UiCommandSchema,
  UiResyncSchema,
  UiServerMessageSchema,
  type UiCommandRequest,
  type UiSliceName,
  type UiSliceVersions,
  type UiStateSlices,
} from "./ui-protocol.js";

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const ALL_UI_SLICE_NAMES = [
  "shell",
  "discovery",
  "room",
  "collaboration",
  "notifications",
  "pageAccess",
] as const satisfies readonly UiSliceName[];

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

export function reconstructExtensionAppStatus(state: UiStateSlices): ExtensionAppStatus {
  const selectedProfile =
    state.shell.profiles.find((profile) => profile.profileId === state.shell.selectedProfileId) ??
    null;
  const serverCapabilities: ServerCapability[] =
    selectedProfile?.metadata?.capabilities.flatMap((capability) => {
      const parsed = ServerCapabilitySchema.safeParse(capability);
      return parsed.success ? [parsed.data] : [];
    }) ?? [];
  const hasCapability = (capability: ServerCapability): boolean =>
    serverCapabilities.includes(capability);
  const unavailableReason = (capability: ServerCapability, missing: string): string | null =>
    selectedProfile?.mode === "LEGACY_V081"
      ? "SERVER_LEGACY_LIMITED"
      : hasCapability(capability)
        ? null
        : missing;
  const room: ExtensionStatus | null =
    state.room.runtime === null
      ? null
      : {
          ...state.room.runtime,
          danmaku: state.room.runtime.danmaku ?? null,
          drawing: state.room.runtime.drawing ?? null,
        };

  const status: ExtensionAppStatus = {
    phase: state.shell.phase,
    account: state.shell.account,
    profiles: state.shell.profiles,
    selectedProfileId: state.shell.selectedProfileId,
    selectedProfile,
    serverCapabilities,
    publicRooms: state.discovery.publicRooms,
    publicRoomsUnavailableReason: unavailableReason(
      "public-rooms",
      "SERVER_CAPABILITY_PUBLIC_ROOMS_UNAVAILABLE",
    ),
    pointerUnavailableReason: unavailableReason(
      "volatile-pointer-v2",
      "SERVER_CAPABILITY_VOLATILE_POINTER_UNAVAILABLE",
    ),
    contentCompatibilityUnavailableReason: unavailableReason(
      "content-compatibility-v1",
      "SERVER_CAPABILITY_CONTENT_COMPATIBILITY_UNAVAILABLE",
    ),
    notifications: state.notifications.items,
    notificationCursor: state.notifications.cursor,
    unreadNotificationCount: state.notifications.unreadCount,
    onboardingRequired: state.shell.onboardingRequired,
    rooms: state.discovery.rooms,
    invitations: state.discovery.invitations,
    selectedRoomId: state.room.selectedRoomId,
    roomDetail: state.room.detail,
    room,
    errorCode: state.shell.errorCode,
    collaboration: state.collaboration,
  };
  return structuredClone(status);
}

export interface UiPortClientEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface UiPortClientPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: UiPortClientEvent<(message: unknown) => void>;
  onDisconnect: UiPortClientEvent<() => void>;
}

export interface UiPortClientScheduler {
  setTimeout(task: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UiPortClientOptions {
  connect(): UiPortClientPort;
  scheduler?: UiPortClientScheduler;
  createCommandId?: () => string;
  onResyncRequested?: () => void;
}

export type UiPortClientTransportState = "CONNECTING" | "CONNECTED" | "RECONNECTING";

export interface UiStateUpdate {
  readonly state: UiStateSlices;
  readonly versions: UiSliceVersions;
  readonly changedSlices: readonly UiSliceName[];
}

interface PortHandlers {
  readonly port: UiPortClientPort;
  readonly message: (message: unknown) => void;
  readonly disconnect: () => void;
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const defaultScheduler: UiPortClientScheduler = {
  setTimeout(task, delayMs): unknown {
    return globalThis.setTimeout(task, delayMs);
  },
  clearTimeout(handle): void {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

export class UiPortClient {
  readonly #connectPort: () => UiPortClientPort;
  readonly #scheduler: UiPortClientScheduler;
  readonly #createCommandId: () => string;
  readonly #onResyncRequested: (() => void) | undefined;
  readonly #listeners = new Set<(update: UiStateUpdate) => void>();
  readonly #transportListeners = new Set<(state: UiPortClientTransportState) => void>();
  readonly #pending = new Map<string, PendingCommand>();
  #handlers: PortHandlers | undefined;
  #state: UiStateSlices | null = null;
  #versions = zeroVersions();
  #reconnectAttempt = 0;
  #reconnectTimer: unknown;
  #resyncRequested = false;
  #hasConnected = false;
  #started = false;
  #disposed = false;
  #transport: UiPortClientTransportState = "CONNECTING";

  public constructor(options: UiPortClientOptions) {
    this.#connectPort = options.connect;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#createCommandId = options.createCommandId ?? (() => globalThis.crypto.randomUUID());
    this.#onResyncRequested = options.onResyncRequested;
  }

  public start(): void {
    if (this.#disposed) {
      throw new Error("UI_PORT_CLIENT_DISPOSED");
    }
    if (this.#started) {
      throw new Error("UI_PORT_CLIENT_ALREADY_STARTED");
    }
    this.#started = true;
    this.#openPort(false);
  }

  public subscribe(listener: (update: UiStateUpdate) => void): () => void {
    if (this.#disposed) {
      throw new Error("UI_PORT_CLIENT_DISPOSED");
    }
    this.#listeners.add(listener);
    if (this.#state !== null) {
      listener(this.#createUpdate(ALL_UI_SLICE_NAMES));
    }
    return () => this.#listeners.delete(listener);
  }

  public subscribeTransport(listener: (state: UiPortClientTransportState) => void): () => void {
    if (this.#disposed) {
      throw new Error("UI_PORT_CLIENT_DISPOSED");
    }
    this.#transportListeners.add(listener);
    listener(this.#transport);
    return () => this.#transportListeners.delete(listener);
  }

  public getState(): UiStateSlices | null {
    return this.#state === null ? null : structuredClone(this.#state);
  }

  public getVersions(): UiSliceVersions {
    return structuredClone(this.#versions);
  }

  public command(
    requestInput: UiCommandRequest,
    commandId = this.#createCommandId(),
  ): Promise<unknown> {
    if (this.#disposed || this.#handlers === undefined) {
      return Promise.reject(new Error("UI_PORT_DISCONNECTED"));
    }
    const parsed = UiCommandSchema.safeParse({
      type: "ui.command",
      commandId,
      ...requestInput,
    });
    if (!parsed.success) {
      return Promise.reject(new Error("INVALID_EXTENSION_MESSAGE", { cause: parsed.error }));
    }
    const command = parsed.data;
    if (this.#pending.has(command.commandId)) {
      return Promise.reject(new Error("DUPLICATE_UI_COMMAND_ID"));
    }
    const port = this.#handlers.port;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(command.commandId, { resolve, reject });
      try {
        port.postMessage(command);
      } catch {
        this.#pending.delete(command.commandId);
        reject(new Error("UI_PORT_DISCONNECTED"));
        this.#handleDisconnect(port);
      }
    });
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#reconnectTimer !== undefined) {
      this.#scheduler.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const port = this.#handlers?.port;
    if (port !== undefined) {
      this.#detach(port);
      try {
        port.disconnect();
      } catch {
        // The browser already considers this Port disconnected.
      }
    }
    this.#rejectPending("UI_PORT_DISCONNECTED");
    this.#listeners.clear();
    this.#transportListeners.clear();
  }

  #openPort(reconnecting: boolean): void {
    if (this.#disposed) {
      return;
    }
    let port: UiPortClientPort;
    try {
      port = this.#connectPort();
    } catch {
      this.#scheduleReconnect();
      return;
    }
    const handlers: PortHandlers = {
      port,
      message: (message) => this.#handleMessage(port, message),
      disconnect: () => this.#handleDisconnect(port),
    };
    this.#handlers = handlers;
    port.onMessage.addListener(handlers.message);
    port.onDisconnect.addListener(handlers.disconnect);
    if (reconnecting || this.#hasConnected) {
      this.#requestResync();
    }
    this.#hasConnected = true;
  }

  #handleMessage(port: UiPortClientPort, message: unknown): void {
    if (this.#handlers?.port !== port || this.#disposed) {
      return;
    }
    const parsed = UiServerMessageSchema.safeParse(message);
    if (!parsed.success) {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        typeof message.type === "string" &&
        message.type.startsWith("ui.state.")
      ) {
        this.#requestResync();
      }
      return;
    }
    const data = parsed.data;
    if (data.type === "ui.state.snapshot") {
      this.#state = structuredClone(data.slices);
      this.#versions = structuredClone(data.versions);
      this.#reconnectAttempt = 0;
      this.#resyncRequested = false;
      this.#setTransport("CONNECTED");
      this.#notify(ALL_UI_SLICE_NAMES);
      return;
    }
    if (data.type === "ui.state.patch") {
      if (this.#state === null || this.#versions[data.slice] !== data.fromVersion) {
        this.#requestResync();
        return;
      }
      this.#state = {
        ...this.#state,
        [data.slice]: data.value,
      } as UiStateSlices;
      this.#versions = {
        ...this.#versions,
        [data.slice]: data.toVersion,
      };
      this.#notify([data.slice]);
      return;
    }

    const pending = this.#pending.get(data.commandId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(data.commandId);
    if (data.ok) {
      pending.resolve(data.value);
    } else {
      pending.reject(new Error(data.errorCode));
    }
  }

  #requestResync(): void {
    const port = this.#handlers?.port;
    if (port === undefined || this.#resyncRequested || this.#disposed) {
      return;
    }
    this.#resyncRequested = true;
    try {
      port.postMessage(
        UiResyncSchema.parse({
          type: "ui.resync",
          versions: this.#versions,
        }),
      );
      try {
        this.#onResyncRequested?.();
      } catch {
        // Optional diagnostics cannot affect transport recovery.
      }
    } catch {
      this.#handleDisconnect(port);
    }
  }

  #handleDisconnect(port: UiPortClientPort): void {
    if (this.#handlers?.port !== port) {
      return;
    }
    this.#detach(port);
    this.#resyncRequested = false;
    this.#setTransport("RECONNECTING");
    this.#rejectPending("UI_PORT_DISCONNECTED");
    this.#scheduleReconnect();
  }

  #detach(port: UiPortClientPort): void {
    const handlers = this.#handlers;
    if (handlers?.port !== port) {
      return;
    }
    this.#handlers = undefined;
    port.onMessage.removeListener(handlers.message);
    port.onDisconnect.removeListener(handlers.disconnect);
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectTimer !== undefined) {
      return;
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#scheduler.setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#openPort(true);
    }, delay);
  }

  #rejectPending(code: string): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(code));
    }
    this.#pending.clear();
  }

  #createUpdate(changedSlices: readonly UiSliceName[]): UiStateUpdate {
    if (this.#state === null) {
      throw new Error("UI_STATE_UNAVAILABLE");
    }
    return {
      state: this.#state,
      versions: { ...this.#versions },
      changedSlices,
    };
  }

  #notify(changedSlices: readonly UiSliceName[]): void {
    if (this.#state === null) {
      return;
    }
    const update = this.#createUpdate(changedSlices);
    for (const listener of [...this.#listeners]) {
      try {
        listener(update);
      } catch {
        // A renderer callback cannot corrupt state reconstruction or other subscribers.
      }
    }
  }

  #setTransport(state: UiPortClientTransportState): void {
    if (this.#transport === state) {
      return;
    }
    this.#transport = state;
    for (const listener of [...this.#transportListeners]) {
      try {
        listener(state);
      } catch {
        // A renderer callback cannot disrupt transport recovery.
      }
    }
  }
}
