import { describe, expect, it, vi } from "vitest";
import {
  ExtensionCommandRouter,
  registerUiPortServer,
  type ExtensionCommandAppPort,
  type ExtensionCommandBrowserPort,
  type ExtensionCommandOriginConsentPort,
  type ExtensionCommandPagePort,
  type ExtensionCommandBindingsPort,
  type UiPortServerRuntime,
} from "../src/extension-command-router.js";
import { UiCommandSchema, type UiCommand } from "../src/ui/ui-protocol.js";

const commandId = "018f8f8e-4b5c-7d6e-8f90-123456789c01";
const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789c02";
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789c03";
const requestId = "018f8f8e-4b5c-7d6e-8f90-123456789c04";
const invitationId = "018f8f8e-4b5c-7d6e-8f90-123456789c05";
const logicalTabId = "018f8f8e-4b5c-7d6e-8f90-123456789c06";
const playbackGroupId = "018f8f8e-4b5c-7d6e-8f90-123456789c07";
const proposalId = "018f8f8e-4b5c-7d6e-8f90-123456789c08";
const notificationId = "018f8f8e-4b5c-7d6e-8f90-123456789c09";

interface RecordedCall {
  method: string;
  args: unknown[];
}

function fakeApp(calls: RecordedCall[]): ExtensionCommandAppPort {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string") {
          return undefined;
        }
        return async (...args: unknown[]) => {
          calls.push({ method: property, args });
          if (property === "recordCurrentPolicyAcceptance") {
            return {
              profileId: "server-a",
              serverTermsVersion: "2026-07-30",
            };
          }
          return { method: property, args };
        };
      },
    },
  ) as ExtensionCommandAppPort;
}

function command(name: UiCommand["name"], payload?: unknown): UiCommand {
  return UiCommandSchema.parse({
    type: "ui.command",
    commandId,
    name,
    ...(payload === undefined ? {} : { payload }),
  });
}

function createRouter(input?: {
  tab?: { id?: number; url?: string; pendingUrl?: string };
  removed?: boolean;
}) {
  const calls: RecordedCall[] = [];
  const browser: ExtensionCommandBrowserPort = {
    tabs: {
      query: vi.fn(async () => [input?.tab ?? { id: 42, url: "https://news.example/article" }]),
    },
  };
  const pageCollaborationPort: ExtensionCommandPagePort = {
    removeOrigin: vi.fn(async () => input?.removed ?? true),
    refreshOriginAccess: vi.fn(async () => undefined),
  };
  const originConsents: ExtensionCommandOriginConsentPort = {
    markPolicySynchronized: vi.fn(async () => []),
  };
  const commandBindings: ExtensionCommandBindingsPort = {
    read: vi.fn(
      async () =>
        ({
          danmaku: {
            command: "toggle-danmaku-input",
            suggestedShortcut: "Alt+T",
            actualShortcut: "Alt+T",
            state: "BOUND",
          },
          pen: {
            command: "toggle-page-pen",
            suggestedShortcut: "Alt+P",
            actualShortcut: "Alt+P",
            state: "BOUND",
          },
        }) as const,
    ),
  };
  const router = new ExtensionCommandRouter({
    app: fakeApp(calls),
    browser,
    pageCollaborationPort,
    commandBindings,
    originConsents,
  });
  return { router, calls, browser, pageCollaborationPort, commandBindings, originConsents };
}

const cases: Array<{
  name: UiCommand["name"];
  payload?: unknown;
  method: string;
  args: unknown[];
}> = [
  {
    name: "AUTH_REGISTER",
    payload: { username: "alice", displayName: "Alice", password: "secret-passphrase" },
    method: "register",
    args: [{ username: "alice", displayName: "Alice", password: "secret-passphrase" }],
  },
  {
    name: "AUTH_LOGIN",
    payload: { username: "alice", password: "secret-passphrase" },
    method: "login",
    args: [{ username: "alice", password: "secret-passphrase" }],
  },
  {
    name: "AUTH_ACTIVATE",
    payload: {
      activationKey: `sak_${"A".repeat(43)}`,
      username: "alice",
      displayName: "Alice",
      password: "secret-passphrase",
    },
    method: "activateAccount",
    args: [
      {
        activationKey: `sak_${"A".repeat(43)}`,
        username: "alice",
        displayName: "Alice",
        password: "secret-passphrase",
      },
    ],
  },
  {
    name: "AUTH_KEY_LOGIN",
    payload: { activationKey: `sak_${"B".repeat(43)}` },
    method: "loginWithAccountKey",
    args: [{ activationKey: `sak_${"B".repeat(43)}` }],
  },
  { name: "AUTH_LOGOUT", method: "logout", args: [] },
  {
    name: "ACCOUNT_PROFILE_UPDATE",
    payload: { username: "alice.renamed", displayName: "Alice Renamed" },
    method: "updateAccountProfile",
    args: [{ username: "alice.renamed", displayName: "Alice Renamed" }],
  },
  {
    name: "ACCOUNT_PASSWORD_CHANGE",
    payload: {
      currentPassword: "secret-passphrase",
      newPassword: "replacement-passphrase",
    },
    method: "changeAccountPassword",
    args: [
      {
        currentPassword: "secret-passphrase",
        newPassword: "replacement-passphrase",
      },
    ],
  },
  {
    name: "ACCOUNT_PASSWORD_INITIALIZE",
    payload: { newPassword: "replacement-passphrase" },
    method: "initializeAccountPassword",
    args: [{ newPassword: "replacement-passphrase" }],
  },
  {
    name: "SERVER_ADD",
    payload: { baseUrl: "https://team.example/" },
    method: "addServer",
    args: [{ baseUrl: "https://team.example" }],
  },
  { name: "ONBOARDING_DISMISS", method: "dismissVnextOnboarding", args: [] },
  { name: "PUBLIC_ROOMS_REFRESH", method: "refreshPublicRooms", args: [] },
  {
    name: "ROOM_CREATE",
    payload: { name: "Research", visibility: "PUBLIC", joinPolicy: "APPROVAL" },
    method: "createRoom",
    args: [{ name: "Research", visibility: "PUBLIC", joinPolicy: "APPROVAL" }],
  },
  {
    name: "ROOM_UPDATE",
    payload: { name: "Research", visibility: "PUBLIC", joinPolicy: "OPEN" },
    method: "updateRoom",
    args: [{ name: "Research", visibility: "PUBLIC", joinPolicy: "OPEN" }],
  },
  { name: "ROOM_SELECT", payload: { roomId }, method: "selectRoom", args: [roomId] },
  {
    name: "ROOM_TAB_ACTIVATE",
    payload: { logicalTabId },
    method: "activateLogicalTab",
    args: [logicalTabId],
  },
  { name: "ROOM_JOIN_OPEN", payload: { roomId }, method: "joinOpenRoom", args: [roomId] },
  {
    name: "ROOM_JOIN_REQUEST",
    payload: { roomId },
    method: "requestRoomJoin",
    args: [roomId],
  },
  {
    name: "JOIN_REQUEST_DECIDE",
    payload: { requestId, decision: "APPROVE" },
    method: "decideJoinRequest",
    args: [requestId, "APPROVE", commandId],
  },
  {
    name: "INVITATION_ACCEPT",
    payload: { invitationId },
    method: "acceptInvitation",
    args: [invitationId],
  },
  {
    name: "DIRECTORY_SEARCH",
    payload: { roomId, query: "ali", cursor: null, limit: 20 },
    method: "searchDirectory",
    args: [{ roomId, query: "ali", cursor: null, limit: 20 }],
  },
  {
    name: "INVITE_BATCH",
    payload: { userIds: [userId] },
    method: "batchInvite",
    args: [[userId]],
  },
  {
    name: "NOTIFICATION_READ",
    payload: { notificationId },
    method: "markNotificationRead",
    args: [notificationId],
  },
  { name: "NOTIFICATIONS_READ_ALL", method: "markAllNotificationsRead", args: [] },
  { name: "ROOM_LEAVE", method: "leaveRoom", args: [] },
  {
    name: "ROOM_MEMBER_REMOVE",
    payload: { userId },
    method: "removeMember",
    args: [userId],
  },
  {
    name: "ROOM_OWNERSHIP_TRANSFER",
    payload: { userId },
    method: "transferOwnership",
    args: [userId],
  },
  { name: "ROOM_DISSOLVE", method: "dissolveRoom", args: [] },
  { name: "CURRENT_TAB_SHARE", method: "shareBrowserTab", args: [42] },
  { name: "BROWSER_RECOVERY_CONFIRM", method: "confirmBrowserRecovery", args: [] },
  { name: "DANMAKU_TOGGLE", method: "toggleDanmakuInput", args: [] },
  {
    name: "DANMAKU_VISIBILITY",
    payload: { hidden: true },
    method: "setDanmakuHidden",
    args: [true],
  },
  { name: "PEN_TOGGLE", method: "togglePagePen", args: [] },
  {
    name: "MEDIA_MEMBER_JUMP",
    payload: { userId },
    method: "jumpToMediaMember",
    args: [userId],
  },
  {
    name: "MEDIA_GROUP_ALIGN_ONCE",
    payload: { playbackGroupId },
    method: "alignMediaGroupOnce",
    args: [playbackGroupId],
  },
  {
    name: "MEDIA_GROUP_JOIN",
    payload: { playbackGroupId },
    method: "joinMediaGroup",
    args: [playbackGroupId],
  },
  {
    name: "MEDIA_GROUP_LEAVE",
    payload: { playbackGroupId },
    method: "leaveMediaGroup",
    args: [playbackGroupId],
  },
  {
    name: "MEDIA_GROUP_CLOSE",
    payload: { playbackGroupId },
    method: "closeMediaGroup",
    args: [playbackGroupId],
  },
  {
    name: "MEDIA_DEVICE_TAKEOVER",
    payload: { playbackGroupId },
    method: "takeOverMediaDevice",
    args: [playbackGroupId],
  },
  {
    name: "MEDIA_PROPOSAL_DECIDE",
    payload: { playbackGroupId, proposalId, decision: "REJECT" },
    method: "decideMediaProposal",
    args: [playbackGroupId, proposalId, "REJECT"],
  },
];

describe("ExtensionCommandRouter", () => {
  it.each(cases)("routes $name through one exact application method", async (testCase) => {
    const { router, calls } = createRouter();

    await router.execute(command(testCase.name, testCase.payload));

    expect(calls).toEqual([{ method: testCase.method, args: testCase.args }]);
  });

  it("recomputes the page access boundary after selecting a server", async () => {
    const { router, calls, pageCollaborationPort } = createRouter();

    await router.execute(command("SERVER_SELECT", { profileId: "team-server" }));

    expect(calls).toEqual([{ method: "selectServer", args: ["team-server"] }]);
    expect(pageCollaborationPort.refreshOriginAccess).toHaveBeenCalledOnce();
  });

  it("refreshes current page state and shortcut bindings without accepting a tab ID", async () => {
    const { router, calls, browser, commandBindings, pageCollaborationPort } = createRouter();

    await expect(router.execute(command("PAGE_PERMISSION_REFRESH"))).resolves.toMatchObject({
      bindings: {
        danmaku: { state: "BOUND" },
        pen: { state: "BOUND" },
      },
    });

    expect(browser.tabs.query).toHaveBeenCalledWith({
      active: true,
      lastFocusedWindow: true,
    });
    expect(calls).toEqual([{ method: "handleActiveTabChanged", args: [42] }]);
    expect(pageCollaborationPort.refreshOriginAccess).toHaveBeenCalledOnce();
    expect(commandBindings.read).toHaveBeenCalledOnce();
  });

  it("removes an exact authorized origin even when it is not the current page", async () => {
    const { router, calls, pageCollaborationPort } = createRouter();

    await expect(
      router.execute(
        command("PAGE_PERMISSION_REMOVE", {
          origin: "https://news.example",
        }),
      ),
    ).resolves.toEqual({ removed: true });

    expect(pageCollaborationPort.removeOrigin).toHaveBeenCalledWith("https://news.example");
    expect(calls).toEqual([{ method: "handleActiveTabChanged", args: [42] }]);
  });

  it("does not bind authorized-site removal to the current page", async () => {
    const changed = createRouter();
    await expect(
      changed.router.execute(
        command("PAGE_PERMISSION_REMOVE", {
          origin: "https://different.example",
        }),
      ),
    ).resolves.toEqual({ removed: true });
    expect(changed.pageCollaborationPort.removeOrigin).toHaveBeenCalledWith(
      "https://different.example",
    );

    const missing = createRouter({ tab: {} });
    await expect(missing.router.execute(command("CURRENT_TAB_SHARE"))).rejects.toThrow(
      "ACTIVE_TAB_NOT_FOUND",
    );
    expect(missing.calls).toEqual([]);
  });

  it("marks local origin records synchronized only after server policy acceptance succeeds", async () => {
    const { router, calls, originConsents } = createRouter();

    await expect(router.execute(command("POLICY_ACCEPTANCE_RECORD"))).resolves.toEqual({
      profileId: "server-a",
      serverTermsVersion: "2026-07-30",
    });

    expect(originConsents.markPolicySynchronized).toHaveBeenCalledWith({
      profileId: "server-a",
      serverTermsVersion: "2026-07-30",
    });
    expect(calls).toEqual([
      { method: "recordCurrentPolicyAcceptance", args: [] },
      { method: "handlePagePermissionBoundaryChanged", args: [] },
    ]);
  });

  it("rejects malformed commands before invoking any dependency", async () => {
    const { router, calls, browser, pageCollaborationPort, commandBindings } = createRouter();

    await expect(
      router.execute({
        type: "ui.command",
        commandId,
        name: "ROOM_DISSOLVE",
        payload: { force: true },
      }),
    ).rejects.toThrow("INVALID_EXTENSION_MESSAGE");

    expect(calls).toEqual([]);
    expect(browser.tabs.query).not.toHaveBeenCalled();
    expect(pageCollaborationPort.removeOrigin).not.toHaveBeenCalled();
    expect(commandBindings.read).not.toHaveBeenCalled();
  });
});

describe("registerUiPortServer", () => {
  it("attaches only the named long-lived UI port and unregisters cleanly", async () => {
    let listener: ((port: { name: string }) => void) | undefined;
    const runtime: UiPortServerRuntime = {
      onConnect: {
        addListener: vi.fn((next) => {
          listener = next;
        }),
        removeListener: vi.fn((removed) => {
          if (listener === removed) {
            listener = undefined;
          }
        }),
      },
    };
    const attach = vi.fn(async () => undefined);
    const dispose = registerUiPortServer(runtime, Promise.resolve({ attach }));
    const ignored = { name: "another.port" };
    const accepted = { name: "syncaction.ui.v1" };

    listener?.(ignored);
    listener?.(accepted);
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
    expect(attach).toHaveBeenCalledWith(accepted);

    dispose();
    expect(listener).toBeUndefined();
    expect(runtime.onConnect.removeListener).toHaveBeenCalledOnce();
  });
});
