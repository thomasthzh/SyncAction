import type { ExtensionAppController } from "./app-controller.js";
import type { PageToolCommandBindings } from "./command-bindings.js";
import { UiCommandSchema } from "./ui/ui-protocol.js";

export type ExtensionCommandAppPort = Pick<
  ExtensionAppController,
  | "register"
  | "activateAccount"
  | "loginWithAccountKey"
  | "login"
  | "logout"
  | "updateAccountProfile"
  | "changeAccountPassword"
  | "initializeAccountPassword"
  | "addServer"
  | "selectServer"
  | "dismissVnextOnboarding"
  | "refreshPublicRooms"
  | "createRoom"
  | "updateRoom"
  | "selectRoom"
  | "activateLogicalTab"
  | "joinOpenRoom"
  | "requestRoomJoin"
  | "decideJoinRequest"
  | "acceptInvitation"
  | "searchDirectory"
  | "batchInvite"
  | "markNotificationRead"
  | "markAllNotificationsRead"
  | "leaveRoom"
  | "removeMember"
  | "transferOwnership"
  | "dissolveRoom"
  | "shareBrowserTab"
  | "confirmBrowserRecovery"
  | "handleActiveTabChanged"
  | "handlePagePermissionBoundaryChanged"
  | "recordCurrentPolicyAcceptance"
  | "toggleDanmakuInput"
  | "setDanmakuHidden"
  | "togglePagePen"
  | "jumpToMediaMember"
  | "alignMediaGroupOnce"
  | "joinMediaGroup"
  | "leaveMediaGroup"
  | "closeMediaGroup"
  | "takeOverMediaDevice"
  | "decideMediaProposal"
>;

export interface ExtensionCommandBrowserTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
}

export interface ExtensionCommandBrowserPort {
  tabs: {
    query(options: {
      active: true;
      lastFocusedWindow: true;
    }): Promise<ExtensionCommandBrowserTab[]>;
  };
}

export interface ExtensionCommandPagePort {
  removeOrigin(origin: string): Promise<boolean>;
  refreshOriginAccess(): Promise<void>;
}

export interface ExtensionCommandOriginConsentPort {
  markPolicySynchronized(input: {
    profileId: unknown;
    serverTermsVersion: unknown;
  }): Promise<unknown>;
}

export interface ExtensionCommandBindingsPort {
  read(): Promise<PageToolCommandBindings>;
}

export interface ExtensionCommandRouterOptions {
  app: ExtensionCommandAppPort;
  browser: ExtensionCommandBrowserPort;
  pageCollaborationPort: ExtensionCommandPagePort;
  commandBindings: ExtensionCommandBindingsPort;
  originConsents: ExtensionCommandOriginConsentPort;
}

function unreachableCommand(command: never): never {
  throw new Error(`UNHANDLED_UI_COMMAND:${String(command)}`);
}

function jsonSafeResult(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new Error("COMMAND_RESULT_NOT_SERIALIZABLE", { cause });
  }
  if (serialized === undefined) {
    throw new Error("COMMAND_RESULT_NOT_SERIALIZABLE");
  }
  return JSON.parse(serialized) as unknown;
}

export class ExtensionCommandRouter {
  readonly #app: ExtensionCommandAppPort;
  readonly #browser: ExtensionCommandBrowserPort;
  readonly #pageCollaborationPort: ExtensionCommandPagePort;
  readonly #commandBindings: ExtensionCommandBindingsPort;
  readonly #originConsents: ExtensionCommandOriginConsentPort;

  public constructor(options: ExtensionCommandRouterOptions) {
    this.#app = options.app;
    this.#browser = options.browser;
    this.#pageCollaborationPort = options.pageCollaborationPort;
    this.#commandBindings = options.commandBindings;
    this.#originConsents = options.originConsents;
  }

  public async execute(commandInput: unknown): Promise<unknown> {
    const parsed = UiCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      throw new Error("INVALID_EXTENSION_MESSAGE", { cause: parsed.error });
    }
    const command = parsed.data;
    let result: unknown;
    switch (command.name) {
      case "AUTH_REGISTER":
        result = await this.#app.register(command.payload);
        break;
      case "AUTH_LOGIN":
        result = await this.#app.login(command.payload);
        break;
      case "AUTH_ACTIVATE":
        result = await this.#app.activateAccount(command.payload);
        break;
      case "AUTH_KEY_LOGIN":
        result = await this.#app.loginWithAccountKey(command.payload);
        break;
      case "AUTH_LOGOUT":
        result = await this.#app.logout();
        break;
      case "ACCOUNT_PROFILE_UPDATE":
        result = await this.#app.updateAccountProfile(command.payload);
        break;
      case "ACCOUNT_PASSWORD_CHANGE":
        result = await this.#app.changeAccountPassword(command.payload);
        break;
      case "ACCOUNT_PASSWORD_INITIALIZE":
        result = await this.#app.initializeAccountPassword(command.payload);
        break;
      case "SERVER_ADD":
        result = await this.#app.addServer(command.payload);
        break;
      case "SERVER_SELECT":
        result = await this.#app.selectServer(command.payload.profileId);
        await this.#pageCollaborationPort.refreshOriginAccess();
        break;
      case "ONBOARDING_DISMISS":
        result = await this.#app.dismissVnextOnboarding();
        break;
      case "PUBLIC_ROOMS_REFRESH":
        result = await this.#app.refreshPublicRooms();
        break;
      case "ROOM_CREATE":
        result = await this.#app.createRoom(command.payload);
        break;
      case "ROOM_UPDATE":
        result = await this.#app.updateRoom(command.payload);
        break;
      case "ROOM_SELECT":
        result = await this.#app.selectRoom(command.payload.roomId);
        break;
      case "ROOM_TAB_ACTIVATE":
        result = await this.#app.activateLogicalTab(command.payload.logicalTabId);
        break;
      case "ROOM_JOIN_OPEN":
        result = await this.#app.joinOpenRoom(command.payload.roomId);
        break;
      case "ROOM_JOIN_REQUEST":
        result = await this.#app.requestRoomJoin(command.payload.roomId);
        break;
      case "JOIN_REQUEST_DECIDE":
        result = await this.#app.decideJoinRequest(
          command.payload.requestId,
          command.payload.decision,
          command.commandId,
        );
        break;
      case "INVITATION_ACCEPT":
        result = await this.#app.acceptInvitation(command.payload.invitationId);
        break;
      case "DIRECTORY_SEARCH":
        result = await this.#app.searchDirectory(command.payload);
        break;
      case "INVITE_BATCH":
        result = await this.#app.batchInvite(command.payload.userIds);
        break;
      case "NOTIFICATION_READ":
        result = await this.#app.markNotificationRead(command.payload.notificationId);
        break;
      case "NOTIFICATIONS_READ_ALL":
        result = await this.#app.markAllNotificationsRead();
        break;
      case "ROOM_LEAVE":
        result = await this.#app.leaveRoom();
        break;
      case "ROOM_MEMBER_REMOVE":
        result = await this.#app.removeMember(command.payload.userId);
        break;
      case "ROOM_OWNERSHIP_TRANSFER":
        result = await this.#app.transferOwnership(command.payload.userId);
        break;
      case "ROOM_DISSOLVE":
        result = await this.#app.dissolveRoom();
        break;
      case "CURRENT_TAB_SHARE":
        result = await this.#app.shareBrowserTab((await this.#activeTab()).id);
        break;
      case "BROWSER_RECOVERY_CONFIRM":
        result = await this.#app.confirmBrowserRecovery();
        break;
      case "PAGE_PERMISSION_REFRESH": {
        const tab = await this.#activeTab();
        await this.#pageCollaborationPort.refreshOriginAccess();
        await this.#app.handleActiveTabChanged(tab.id);
        result = { bindings: await this.#commandBindings.read() };
        break;
      }
      case "PAGE_PERMISSION_REMOVE": {
        const tab = await this.#activeTab();
        const removed = await this.#pageCollaborationPort.removeOrigin(command.payload.origin);
        await this.#app.handleActiveTabChanged(tab.id);
        result = { removed };
        break;
      }
      case "POLICY_ACCEPTANCE_RECORD": {
        const acceptance = await this.#app.recordCurrentPolicyAcceptance();
        await this.#originConsents.markPolicySynchronized(acceptance);
        await this.#app.handlePagePermissionBoundaryChanged();
        result = acceptance;
        break;
      }
      case "DANMAKU_TOGGLE":
        result = await this.#app.toggleDanmakuInput();
        break;
      case "DANMAKU_VISIBILITY":
        result = await this.#app.setDanmakuHidden(command.payload.hidden);
        break;
      case "PEN_TOGGLE":
        result = await this.#app.togglePagePen();
        break;
      case "MEDIA_MEMBER_JUMP":
        result = await this.#app.jumpToMediaMember(command.payload.userId);
        break;
      case "MEDIA_GROUP_ALIGN_ONCE":
        result = await this.#app.alignMediaGroupOnce(command.payload.playbackGroupId);
        break;
      case "MEDIA_GROUP_JOIN":
        result = await this.#app.joinMediaGroup(command.payload.playbackGroupId);
        break;
      case "MEDIA_GROUP_LEAVE":
        result = await this.#app.leaveMediaGroup(command.payload.playbackGroupId);
        break;
      case "MEDIA_GROUP_CLOSE":
        result = await this.#app.closeMediaGroup(command.payload.playbackGroupId);
        break;
      case "MEDIA_DEVICE_TAKEOVER":
        result = await this.#app.takeOverMediaDevice(command.payload.playbackGroupId);
        break;
      case "MEDIA_PROPOSAL_DECIDE":
        result = await this.#app.decideMediaProposal(
          command.payload.playbackGroupId,
          command.payload.proposalId,
          command.payload.decision,
        );
        break;
      default:
        return unreachableCommand(command);
    }
    return jsonSafeResult(result);
  }

  async #activeTab(): Promise<ExtensionCommandBrowserTab & { id: number }> {
    const tab = (await this.#browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (
      tab === undefined ||
      typeof tab.id !== "number" ||
      !Number.isSafeInteger(tab.id) ||
      tab.id < 0
    ) {
      throw new Error("ACTIVE_TAB_NOT_FOUND");
    }
    return { ...tab, id: tab.id };
  }
}

export interface UiPortServerEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface UiPortServerRuntime<Port extends { name: string } = { name: string }> {
  onConnect: UiPortServerEvent<(port: Port) => void>;
}

export function registerUiPortServer<Port extends { name: string }>(
  runtime: UiPortServerRuntime<Port>,
  hub: Promise<{ attach(port: Port): Promise<void> }>,
): () => void {
  const onConnect = (port: Port): void => {
    if (port.name !== "syncaction.ui.v1") {
      return;
    }
    void hub.then((resolved) => resolved.attach(port)).catch(() => undefined);
  };
  runtime.onConnect.addListener(onConnect);
  return () => runtime.onConnect.removeListener(onConnect);
}
