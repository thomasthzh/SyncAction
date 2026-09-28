import type { ExtensionAppStatus } from "../app-controller.js";
import type { ServerProfile } from "../server-profile.js";
import {
  UiClientMessageSchema,
  ExtensionCollaborationSummarySchema,
  UiDiscoverySliceSchema,
  UiNotificationsSliceSchema,
  UiPageAccessSliceSchema,
  UiRoomSliceSchema,
  UiShellSliceSchema,
  UiCommandResultSchema,
  UiStatePatchSchema,
  UiStateSlicesSchema,
  UiStateSnapshotSchema,
  type UiCommand,
  type UiPageAccessSlice,
  type UiServerMessage,
  type UiSliceHint,
  type UiSliceName,
  type UiSliceVersions,
  type UiStateSlices,
} from "./ui-protocol.js";

const UI_SLICE_NAMES = [
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

function serializeSlices(slices: UiStateSlices): Record<UiSliceName, string> {
  return {
    shell: JSON.stringify(slices.shell),
    discovery: JSON.stringify(slices.discovery),
    room: JSON.stringify(slices.room),
    collaboration: JSON.stringify(slices.collaboration),
    notifications: JSON.stringify(slices.notifications),
    pageAccess: JSON.stringify(slices.pageAccess),
  };
}

function stableErrorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(candidate) ? candidate : "COMMAND_FAILED";
}

export interface UiStateHubPortEvent<T> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

export interface UiStateHubPort {
  postMessage(message: unknown): void;
  onMessage: UiStateHubPortEvent<(message: unknown) => void>;
  onDisconnect: UiStateHubPortEvent<() => void>;
}

export interface UiStateHubScheduler {
  schedule(task: () => void | Promise<void>): void;
}

export interface UiStateHubSource {
  readStatus(): Promise<ExtensionAppStatus>;
  readProfiles(): Promise<ServerProfile[]>;
  readPageAccess(): Promise<UiPageAccessSlice>;
  subscribeChanged(listener: (hint?: UiSliceHint) => void): () => void;
  execute(command: UiCommand): Promise<unknown>;
}

export interface UiStateHubOptions {
  source: UiStateHubSource;
  scheduler?: UiStateHubScheduler;
}

interface PortConnection {
  readonly onMessage: (message: unknown) => void;
  readonly onDisconnect: () => void;
  tail: Promise<void>;
}

const defaultScheduler: UiStateHubScheduler = {
  schedule(task): void {
    globalThis.setTimeout(() => {
      void task();
    }, 0);
  },
};

export function projectUiState(
  status: ExtensionAppStatus,
  profiles: ServerProfile[],
  pageAccess: UiPageAccessSlice,
): UiStateSlices {
  return UiStateSlicesSchema.parse({
    shell: {
      phase: status.phase,
      account: status.account,
      profiles,
      selectedProfileId: status.selectedProfileId,
      onboardingRequired: status.onboardingRequired,
      errorCode: status.errorCode,
    },
    discovery: {
      publicRooms: status.publicRooms,
      rooms: status.rooms,
      invitations: status.invitations,
    },
    room: {
      selectedRoomId: status.selectedRoomId,
      detail: status.roomDetail,
      runtime: status.room,
    },
    collaboration: status.collaboration,
    notifications: {
      items: status.notifications,
      unreadCount: status.unreadNotificationCount,
      cursor: status.notificationCursor,
    },
    pageAccess,
  });
}

/**
 * Projects only the requested UI slice. Incremental updates use this seam so
 * unrelated slices do not get allocated, parsed, or serialized on every room
 * presence/media event.
 */
export function projectUiSlice(
  slice: UiSliceName,
  status: ExtensionAppStatus,
  profiles: ServerProfile[],
  pageAccess: UiPageAccessSlice,
): UiStateSlices[UiSliceName] {
  switch (slice) {
    case "shell":
      return UiShellSliceSchema.parse({
        phase: status.phase,
        account: status.account,
        profiles,
        selectedProfileId: status.selectedProfileId,
        onboardingRequired: status.onboardingRequired,
        errorCode: status.errorCode,
      });
    case "discovery":
      return UiDiscoverySliceSchema.parse({
        publicRooms: status.publicRooms,
        rooms: status.rooms,
        invitations: status.invitations,
      });
    case "room":
      return UiRoomSliceSchema.parse({
        selectedRoomId: status.selectedRoomId,
        detail: status.roomDetail,
        runtime: status.room,
      });
    case "collaboration":
      return ExtensionCollaborationSummarySchema.parse(status.collaboration);
    case "notifications":
      return UiNotificationsSliceSchema.parse({
        items: status.notifications,
        unreadCount: status.unreadNotificationCount,
        cursor: status.notificationCursor,
      });
    case "pageAccess":
      return UiPageAccessSliceSchema.parse(pageAccess);
  }
}

export class UiStateHub {
  readonly #source: UiStateHubSource;
  readonly #scheduler: UiStateHubScheduler;
  readonly #connections = new Map<UiStateHubPort, PortConnection>();
  readonly #unsubscribeSource: () => void;
  #versions = zeroVersions();
  #slices: UiStateSlices | undefined;
  #serialized: Record<UiSliceName, string> | undefined;
  #status: ExtensionAppStatus | undefined;
  #profiles: ServerProfile[] | undefined;
  #pageAccess: UiPageAccessSlice | undefined;
  #refreshTail: Promise<void> = Promise.resolve();
  #refreshScheduled = false;
  readonly #pendingDirtySlices = new Set<UiSliceName>();
  #disposed = false;

  public constructor(options: UiStateHubOptions) {
    this.#source = options.source;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#unsubscribeSource = this.#source.subscribeChanged((hint) =>
      this.#scheduleProjection(hint),
    );
  }

  public async attach(port: UiStateHubPort): Promise<void> {
    if (this.#disposed) {
      throw new Error("UI_STATE_HUB_DISPOSED");
    }
    if (this.#connections.has(port)) {
      throw new Error("UI_PORT_ALREADY_ATTACHED");
    }
    await this.#refresh();
    if (this.#disposed) {
      throw new Error("UI_STATE_HUB_DISPOSED");
    }

    const connection: PortConnection = {
      onMessage: (message) => {
        connection.tail = connection.tail
          .then(() => this.#handleMessage(port, message))
          .catch(() => undefined);
      },
      onDisconnect: () => this.#detach(port),
      tail: Promise.resolve(),
    };
    this.#connections.set(port, connection);
    port.onMessage.addListener(connection.onMessage);
    port.onDisconnect.addListener(connection.onDisconnect);
    this.#post(port, this.#snapshot());
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSource();
    for (const port of [...this.#connections.keys()]) {
      this.#detach(port);
    }
  }

  #scheduleProjection(hint?: UiSliceHint): void {
    if (this.#disposed) {
      return;
    }
    for (const slice of hint ?? UI_SLICE_NAMES) {
      this.#pendingDirtySlices.add(slice);
    }
    if (this.#refreshScheduled) {
      return;
    }
    this.#refreshScheduled = true;
    this.#scheduler.schedule(async () => {
      this.#refreshScheduled = false;
      if (!this.#disposed) {
        const dirtySlices = [...this.#pendingDirtySlices];
        this.#pendingDirtySlices.clear();
        await this.#refresh(dirtySlices).catch(() => undefined);
      }
    });
  }

  #refresh(dirtySlices: readonly UiSliceName[] = UI_SLICE_NAMES): Promise<void> {
    const operation = this.#refreshTail.then(() => this.#performRefresh(dirtySlices));
    this.#refreshTail = operation.catch(() => undefined);
    return operation;
  }

  async #performRefresh(dirtySlicesInput: readonly UiSliceName[]): Promise<void> {
    const dirtySlices =
      this.#slices === undefined ||
      this.#status === undefined ||
      this.#profiles === undefined ||
      this.#pageAccess === undefined
        ? UI_SLICE_NAMES
        : dirtySlicesInput;
    const dirtySet = new Set(dirtySlices);
    const statusDirty = ["shell", "discovery", "room", "collaboration", "notifications"].some(
      (slice) => dirtySet.has(slice as UiSliceName),
    );
    const [status, profiles, pageAccess] = await Promise.all([
      statusDirty || this.#status === undefined
        ? this.#source.readStatus()
        : Promise.resolve(this.#status),
      dirtySet.has("shell") || this.#profiles === undefined
        ? this.#source.readProfiles()
        : Promise.resolve(this.#profiles),
      dirtySet.has("pageAccess") || this.#pageAccess === undefined
        ? this.#source.readPageAccess()
        : Promise.resolve(this.#pageAccess),
    ]);
    this.#status = status;
    this.#profiles = profiles;
    this.#pageAccess = pageAccess;
    if (this.#slices === undefined || this.#serialized === undefined) {
      const next = projectUiState(status, profiles, pageAccess);
      this.#slices = next;
      this.#serialized = serializeSlices(next);
      return;
    }

    const patches: UiServerMessage[] = [];
    for (const slice of dirtySlices) {
      const value = projectUiSlice(slice, status, profiles, pageAccess);
      const serialized = JSON.stringify(value);
      if (serialized === this.#serialized[slice]) {
        continue;
      }
      const fromVersion = this.#versions[slice];
      if (fromVersion >= Number.MAX_SAFE_INTEGER) {
        throw new Error("UI_SLICE_VERSION_EXHAUSTED");
      }
      const toVersion = fromVersion + 1;
      this.#versions[slice] = toVersion;
      this.#serialized[slice] = serialized;
      this.#slices = { ...this.#slices, [slice]: value } as UiStateSlices;
      patches.push(
        UiStatePatchSchema.parse({
          type: "ui.state.patch",
          slice,
          fromVersion,
          toVersion,
          value,
        }),
      );
    }
    for (const patch of patches) {
      this.#broadcast(patch);
    }
  }

  async #handleMessage(port: UiStateHubPort, message: unknown): Promise<void> {
    if (!this.#connections.has(port) || this.#disposed) {
      return;
    }
    const parsed = UiClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      return;
    }
    if (parsed.data.type === "ui.resync") {
      await this.#refresh();
      this.#post(port, this.#snapshot());
      return;
    }

    const command = parsed.data;
    try {
      const value = await this.#source.execute(command);
      await this.#refresh();
      const result =
        value === undefined
          ? {
              type: "ui.command.result" as const,
              commandId: command.commandId,
              ok: true as const,
            }
          : {
              type: "ui.command.result" as const,
              commandId: command.commandId,
              ok: true as const,
              value,
            };
      this.#post(port, UiCommandResultSchema.parse(result));
    } catch (error) {
      await this.#refresh().catch(() => undefined);
      this.#post(
        port,
        UiCommandResultSchema.parse({
          type: "ui.command.result",
          commandId: command.commandId,
          ok: false,
          errorCode: stableErrorCode(error),
        }),
      );
    }
  }

  #snapshot(): UiServerMessage {
    if (this.#slices === undefined) {
      throw new Error("UI_STATE_UNAVAILABLE");
    }
    return UiStateSnapshotSchema.parse({
      type: "ui.state.snapshot",
      versions: this.#versions,
      slices: this.#slices,
    });
  }

  #broadcast(message: UiServerMessage): void {
    for (const port of [...this.#connections.keys()]) {
      this.#post(port, message);
    }
  }

  #post(port: UiStateHubPort, message: UiServerMessage): void {
    if (!this.#connections.has(port)) {
      return;
    }
    try {
      port.postMessage(message);
    } catch {
      this.#detach(port);
    }
  }

  #detach(port: UiStateHubPort): void {
    const connection = this.#connections.get(port);
    if (connection === undefined) {
      return;
    }
    this.#connections.delete(port);
    port.onMessage.removeListener(connection.onMessage);
    port.onDisconnect.removeListener(connection.onDisconnect);
  }
}
