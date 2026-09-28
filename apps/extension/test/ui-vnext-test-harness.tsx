import { batch, signal } from "@preact/signals";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { ComponentChildren } from "preact";
import type {
  UiCommandInput,
  UiCommandError,
  UiStore,
  UiTransportState,
} from "../src/ui-vnext/store.js";
import type { UiCommandResult, UiStateSlices } from "../src/ui/ui-protocol.js";

const resultCommandId = "018f8f8e-4b5c-7d6e-8f90-123456789c31";

export function baseSlices(): UiStateSlices {
  return {
    shell: {
      phase: "SIGNED_OUT",
      account: null,
      profiles: [
        {
          profileId: "syncaction-production",
          baseUrl: "https://syncaction.example.com",
          mode: "VNEXT",
          metadata: {
            serverId: "018f8f8e-4b5c-7d6e-8f90-123456789c32",
            displayName: "SyncAction 香港",
            softwareVersion: "0.9.3",
            protocolVersion: "1",
            minimumClientVersion: "0.9.0",
            termsVersion: "2026-07-30",
            capabilities: ["public-rooms", "join-requests", "notifications"],
            limits: {
              ordinaryActiveRooms: 5,
              ordinaryOpenTabs: 20,
            },
          },
          lastHealthyAt: 1,
        },
      ],
      selectedProfileId: "syncaction-production",
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
        limit: 20,
        exemption: "NOT_EXEMPT",
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

export class TestUiStore implements UiStore {
  public readonly versions = signal({
    shell: 1,
    discovery: 1,
    room: 1,
    collaboration: 1,
    notifications: 1,
    pageAccess: 1,
  });
  public readonly transport = signal<UiTransportState>("CONNECTED");
  public readonly shell = signal(baseSlices().shell);
  public readonly discovery = signal(baseSlices().discovery);
  public readonly room = signal(baseSlices().room);
  public readonly collaboration = signal(baseSlices().collaboration);
  public readonly notifications = signal(baseSlices().notifications);
  public readonly pageAccess = signal(baseSlices().pageAccess);
  public readonly pendingCommands = signal<ReadonlySet<string>>(new Set());
  public readonly commandError = signal<UiCommandError | null>(null);
  public readonly commandCalls: UiCommandInput[] = [];
  public responder: (command: UiCommandInput) => Promise<UiCommandResult> = async () => ({
    type: "ui.command.result",
    commandId: resultCommandId,
    ok: true,
  });

  public async command(command: UiCommandInput): Promise<UiCommandResult> {
    this.commandCalls.push(structuredClone(command));
    const result = await this.responder(command);
    this.commandError.value = result.ok
      ? null
      : {
          commandId: result.commandId,
          errorCode: result.errorCode,
        };
    return result;
  }

  public update(next: Partial<UiStateSlices>): void {
    batch(() => {
      if (next.shell !== undefined) {
        this.shell.value = next.shell;
      }
      if (next.discovery !== undefined) {
        this.discovery.value = next.discovery;
      }
      if (next.room !== undefined) {
        this.room.value = next.room;
      }
      if (next.collaboration !== undefined) {
        this.collaboration.value = next.collaboration;
      }
      if (next.notifications !== undefined) {
        this.notifications.value = next.notifications;
      }
      if (next.pageAccess !== undefined) {
        this.pageAccess.value = next.pageAccess;
      }
    });
  }

  public dispose(): void {}
}

let mountedRoot: HTMLElement | null = null;

export function renderPanel(children: ComponentChildren): HTMLElement {
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  act(() => render(children, root));
  mountedRoot = root;
  return root;
}

export function unmountPanel(): void {
  if (mountedRoot !== null) {
    act(() => render(null, mountedRoot!));
  }
  mountedRoot = null;
  document.body.replaceChildren();
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
    }
  });
}

export function input(element: HTMLInputElement, value: string): void {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function change(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function byRole(root: ParentNode, selector: "button" | "link", name: string): HTMLElement {
  const candidates = [...root.querySelectorAll(selector)];
  const candidate = candidates.find(
    (element) =>
      element.textContent?.trim() === name || element.getAttribute("aria-label") === name,
  );
  if (!(candidate instanceof HTMLElement)) {
    throw new Error(`Unable to find ${selector} named ${name}`);
  }
  return candidate;
}

export function success(value?: unknown): UiCommandResult {
  return value === undefined
    ? {
        type: "ui.command.result",
        commandId: resultCommandId,
        ok: true,
      }
    : {
        type: "ui.command.result",
        commandId: resultCommandId,
        ok: true,
        value,
      };
}

export function failure(errorCode: string): UiCommandResult {
  return {
    type: "ui.command.result",
    commandId: resultCommandId,
    ok: false,
    errorCode,
  };
}
