import type { PublicRoomSummary } from "@syncaction/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type {
  OriginPermissionCoordinator,
  PermissionConfirmation,
  PermissionIntent,
} from "../origin-permission-coordinator.js";
import type { UiCommandInput, UiStore } from "./store.js";
import type { UiCommandResult } from "../ui/ui-protocol.js";
import type { PageFeature } from "../ui/ui-protocol.js";
import type { PageToolShortcutIntent } from "../page-tool-shortcut-intent.js";
import { AppShell } from "./components/app-shell.js";
import { AccountSettingsDialog } from "./components/account-settings-dialog.js";
import { ActiveRoom } from "./components/active-room.js";
import {
  AuthorizedSitesDialog,
  type AuthorizedSiteView,
} from "./components/authorized-sites-dialog.js";
import { AuthDialog, type AuthMode } from "./components/auth-dialog.js";
import { CreateRoomDialog } from "./components/create-room-dialog.js";
import { GuestLobby } from "./components/guest-lobby.js";
import { InvitePicker } from "./components/invite-picker.js";
import { MessageCenter } from "./components/message-center.js";
import { ModalDialog } from "./components/modal-dialog.js";
import { PermissionDialog } from "./components/permission-dialog.js";
import { RoomLifecycleSheet } from "./components/room-lifecycle-sheet.js";
import { ServerProfileDialog, type ServerVerifier } from "./components/server-profile-dialog.js";
import type { ServiceStatusProbe } from "./components/service-status-card.js";
import { UpgradeNotice } from "./components/upgrade-notice.js";

export type Overlay =
  | { kind: "AUTH"; mode: AuthMode }
  | { kind: "MESSAGES" }
  | { kind: "SERVER_PROFILES" }
  | { kind: "AUTHORIZED_SITES" }
  | { kind: "ACCOUNT_SETTINGS" }
  | { kind: "CREATE_ROOM" }
  | { kind: "INVITE_PICKER" }
  | { kind: "ROOM_LIFECYCLE" }
  | {
      kind: "PAGE_PERMISSION";
      intentKey: string;
      feature: PageFeature;
      intent: PermissionIntent | null;
      preflightErrorCode: string | null;
    }
  | null;

interface DeferredCommand {
  readonly profileId: string;
  readonly roomId: string;
  readonly command: UiCommandInput;
}

export interface AppProps {
  readonly store: UiStore;
  readonly now?: () => number;
  readonly serverVerifier?: ServerVerifier;
  readonly serviceStatusProbe?: ServiceStatusProbe;
  readonly pagePermissionCoordinator?: Pick<OriginPermissionCoordinator, "capture" | "confirm">;
  readonly privacyPageUrl?: string;
  readonly loadAuthorizedSites?: (profileId: string) => Promise<readonly AuthorizedSiteView[]>;
  readonly initialPagePermissionIntent?: PageToolShortcutIntent | null;
  readonly pagePermissionIntentSource?: {
    subscribe(listener: (intent: PageToolShortcutIntent) => void): () => void;
  };
}

const EMPTY_AUTHORIZED_SITES_LOADER = async (): Promise<readonly AuthorizedSiteView[]> => [];

function selectedServerContext(store: UiStore): {
  profileId: string;
  host: string;
  connected: boolean;
  accountActivationSupported: boolean;
  accountKeyLoginSupported: boolean;
  accountSettingsSupported: boolean;
} {
  const shell = store.shell.value;
  const profile =
    shell.profiles.find(({ profileId }) => profileId === shell.selectedProfileId) ??
    shell.profiles[0]!;
  let host = profile.baseUrl;
  try {
    host = new URL(profile.baseUrl).host;
  } catch {
    // The profile boundary validates origins; retain the supplied label if a test double does not.
  }
  const accountActivationSupported =
    profile.metadata?.capabilities.includes("account-activation-v1") ?? false;
  const accountKeyLoginSupported =
    profile.metadata?.capabilities.includes("account-key-login-v1") ?? false;
  return {
    profileId: profile.profileId,
    host,
    connected: profile.mode !== "UNVERIFIED",
    accountActivationSupported,
    accountKeyLoginSupported,
    accountSettingsSupported: accountActivationSupported || accountKeyLoginSupported,
  };
}

function supportedAuthMode(
  mode: AuthMode,
  server: ReturnType<typeof selectedServerContext>,
): AuthMode {
  if (mode === "KEY_LOGIN") {
    return server.accountKeyLoginSupported
      ? mode
      : server.accountActivationSupported
        ? "ACTIVATE"
        : "LOGIN";
  }
  if (mode === "ACTIVATE") {
    return server.accountKeyLoginSupported
      ? "KEY_LOGIN"
      : server.accountActivationSupported
        ? mode
        : "LOGIN";
  }
  return mode;
}

export function App({
  store,
  now = () => Date.now(),
  serverVerifier,
  serviceStatusProbe,
  pagePermissionCoordinator,
  privacyPageUrl = "privacy.html",
  loadAuthorizedSites = EMPTY_AUTHORIZED_SITES_LOADER,
  initialPagePermissionIntent = null,
  pagePermissionIntentSource,
}: AppProps): JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [deferredCommand, setDeferredCommand] = useState<DeferredCommand | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const serverReturnAuthMode = useRef<AuthMode | null>(null);
  const initialPermissionIntentOpened = useRef(false);
  const server = selectedServerContext(store);
  const effectiveAuthMode =
    overlay?.kind === "AUTH" ? supportedAuthMode(overlay.mode, server) : null;
  const publicRoomKey = store.discovery.value.publicRooms.map(({ roomId }) => roomId).join("|");

  function openOverlay(next: Exclude<Overlay, null>): void {
    if (overlay === null) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setOverlay(next);
  }

  function closeOverlay(options: { clearDeferred?: boolean } = {}): void {
    if (options.clearDeferred === true) {
      setDeferredCommand(null);
    }
    setOverlay(null);
    queueMicrotask(() => openerRef.current?.focus());
  }

  function openServerProfiles(returnToAuth: AuthMode | null = null): void {
    serverReturnAuthMode.current = returnToAuth;
    openOverlay({ kind: "SERVER_PROFILES" });
  }

  function closeServerProfiles(): void {
    const returnToAuth = serverReturnAuthMode.current;
    const selectedServer = selectedServerContext(store);
    serverReturnAuthMode.current = null;
    if (returnToAuth === null) {
      closeOverlay();
    } else {
      setOverlay({
        kind: "AUTH",
        mode: supportedAuthMode(returnToAuth, selectedServer),
      });
    }
  }

  useEffect(() => {
    if (
      deferredCommand !== null &&
      (deferredCommand.profileId !== server.profileId ||
        !store.discovery.value.publicRooms.some(({ roomId }) => roomId === deferredCommand.roomId))
    ) {
      setDeferredCommand(null);
    }
  }, [deferredCommand, publicRoomKey, server.profileId, store.discovery]);

  useEffect(() => {
    setOverlay((current) => {
      if (current?.kind === "AUTH") {
        const mode = supportedAuthMode(current.mode, server);
        return mode === current.mode ? current : { kind: "AUTH", mode };
      }
      return current?.kind === "ACCOUNT_SETTINGS" && !server.accountSettingsSupported
        ? null
        : current;
    });
  }, [
    server.accountActivationSupported,
    server.accountKeyLoginSupported,
    server.accountSettingsSupported,
    server.profileId,
  ]);

  async function joinPublicRoom(room: PublicRoomSummary): Promise<UiCommandResult> {
    setActionError(null);
    const command: UiCommandInput =
      room.joinPolicy === "OPEN"
        ? { name: "ROOM_JOIN_OPEN", payload: { roomId: room.roomId } }
        : { name: "ROOM_JOIN_REQUEST", payload: { roomId: room.roomId } };
    const result = await store.command(command);
    if (!result.ok && result.errorCode === "AUTHENTICATION_REQUIRED") {
      setDeferredCommand({
        profileId: server.profileId,
        roomId: room.roomId,
        command,
      });
      openOverlay({ kind: "AUTH", mode: "LOGIN" });
    } else if (!result.ok) {
      setActionError(result.errorCode);
    }
    return result;
  }

  async function authenticate(
    input:
      | { mode: "LOGIN"; username: string; password: string }
      | { mode: "REGISTER"; username: string; displayName: string; password: string }
      | {
          mode: "ACTIVATE";
          activationKey: string;
          username: string;
          displayName: string;
          password: string;
        }
      | { mode: "KEY_LOGIN"; activationKey: string },
  ): Promise<UiCommandResult> {
    const result = await (input.mode === "LOGIN"
      ? store.command({
          name: "AUTH_LOGIN",
          payload: {
            username: input.username,
            password: input.password,
          },
        })
      : input.mode === "REGISTER"
        ? store.command({
            name: "AUTH_REGISTER",
            payload: {
              username: input.username,
              displayName: input.displayName,
              password: input.password,
            },
          })
        : input.mode === "ACTIVATE"
          ? store.command({
              name: "AUTH_ACTIVATE",
              payload: {
                activationKey: input.activationKey,
                username: input.username,
                displayName: input.displayName,
                password: input.password,
              },
            })
          : store.command({
              name: "AUTH_KEY_LOGIN",
              payload: { activationKey: input.activationKey },
            }));
    if (!result.ok) {
      return result;
    }

    const queued = input.mode === "REGISTER" ? null : deferredCommand;
    setDeferredCommand(null);
    if (
      queued !== null &&
      queued.profileId === store.shell.value.selectedProfileId &&
      store.discovery.value.publicRooms.some(({ roomId }) => roomId === queued.roomId)
    ) {
      const replayResult = await store.command(queued.command);
      if (!replayResult.ok) {
        setActionError(replayResult.errorCode);
      }
    }
    closeOverlay();
    return result;
  }

  async function createRoom(input: {
    name: string;
    visibility: "PRIVATE" | "PUBLIC";
    joinPolicy: "OPEN" | "APPROVAL" | "INVITE_ONLY";
  }): Promise<UiCommandResult> {
    const result = await store.command({
      name: "ROOM_CREATE",
      payload: input,
    });
    if (result.ok) {
      closeOverlay();
    }
    return result;
  }

  function openPagePermission(intentKey: string): void {
    const feature =
      intentKey === "danmaku" ? "DANMAKU" : intentKey === "pen" ? "DRAWING" : "POINTER";
    openOverlay({
      kind: "PAGE_PERMISSION",
      intentKey,
      feature,
      intent: null,
      preflightErrorCode: null,
    });
    if (pagePermissionCoordinator === undefined) {
      return;
    }
    void pagePermissionCoordinator.capture(feature).then(
      (intent) => {
        setOverlay((current) =>
          current?.kind === "PAGE_PERMISSION" && current.intentKey === intentKey
            ? { ...current, intent, preflightErrorCode: null }
            : current,
        );
      },
      (error: unknown) => {
        const errorCode =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "PAGE_PERMISSION_UNAVAILABLE";
        setOverlay((current) =>
          current?.kind === "PAGE_PERMISSION" && current.intentKey === intentKey
            ? { ...current, preflightErrorCode: errorCode }
            : current,
        );
      },
    );
  }

  function confirmPagePermission(
    intent: PermissionIntent | null,
    agreed: boolean,
  ): Promise<PermissionConfirmation> {
    if (intent === null || pagePermissionCoordinator === undefined) {
      return Promise.resolve({
        granted: false,
        errorCode: "PAGE_PERMISSION_UNAVAILABLE",
        policySyncPending: false,
      });
    }
    return pagePermissionCoordinator.confirm(intent, agreed);
  }

  useEffect(() => {
    if (initialPagePermissionIntent === null || initialPermissionIntentOpened.current) {
      return;
    }
    initialPermissionIntentOpened.current = true;
    openPagePermission(initialPagePermissionIntent);
  }, [initialPagePermissionIntent]);

  useEffect(
    () => pagePermissionIntentSource?.subscribe((intent) => openPagePermission(intent)),
    [pagePermissionIntentSource],
  );

  return (
    <AppShell
      store={store}
      serverHost={server.host}
      serverConnected={server.connected}
      onOpenAuth={() => openOverlay({ kind: "AUTH", mode: "LOGIN" })}
      onOpenMessages={() => openOverlay({ kind: "MESSAGES" })}
      onOpenServerProfiles={() => openServerProfiles()}
      onOpenAccountSettings={
        server.accountSettingsSupported ? () => openOverlay({ kind: "ACCOUNT_SETTINGS" }) : null
      }
    >
      {store.shell.value.onboardingRequired ? <UpgradeNotice store={store} /> : null}
      {store.room.value.selectedRoomId !== null ? (
        <ActiveRoom
          store={store}
          serverHost={server.host}
          now={now}
          onOpenServerProfiles={() => openServerProfiles()}
          onOpenInvite={() => openOverlay({ kind: "INVITE_PICKER" })}
          onOpenRoomLifecycle={() => openOverlay({ kind: "ROOM_LIFECYCLE" })}
          onRequestPagePermission={openPagePermission}
        />
      ) : (
        <GuestLobby
          store={store}
          actionError={actionError}
          onJoinPublicRoom={joinPublicRoom}
          onOpenCreateRoom={() => openOverlay({ kind: "CREATE_ROOM" })}
          {...(serviceStatusProbe === undefined ? {} : { serviceStatusProbe })}
        />
      )}

      {overlay?.kind === "AUTH" && effectiveAuthMode !== null ? (
        <AuthDialog
          mode={effectiveAuthMode}
          selectedProfileId={server.profileId}
          serverHost={server.host}
          serverConnected={server.connected}
          activationSupported={server.accountActivationSupported}
          keyLoginSupported={server.accountKeyLoginSupported}
          onModeChange={(mode) => setOverlay({ kind: "AUTH", mode })}
          onOpenServerProfiles={() => openServerProfiles(effectiveAuthMode)}
          onSubmit={authenticate}
          onClose={() => closeOverlay({ clearDeferred: true })}
        />
      ) : null}
      {overlay?.kind === "ACCOUNT_SETTINGS" &&
      server.accountSettingsSupported &&
      store.shell.value.account !== null ? (
        <AccountSettingsDialog
          store={store}
          account={store.shell.value.account}
          onClose={() => closeOverlay()}
        />
      ) : null}
      {overlay?.kind === "CREATE_ROOM" ? (
        <CreateRoomDialog onSubmit={createRoom} onClose={() => closeOverlay()} />
      ) : null}
      {overlay?.kind === "MESSAGES" ? (
        <MessageCenter store={store} onClose={() => closeOverlay()} />
      ) : null}
      {overlay?.kind === "INVITE_PICKER" ? (
        <ModalDialog titleId="invite-picker-title" onClose={() => closeOverlay()}>
          <InvitePicker store={store} onBack={() => closeOverlay()} />
        </ModalDialog>
      ) : null}
      {overlay?.kind === "ROOM_LIFECYCLE" ? (
        <RoomLifecycleSheet store={store} onClose={() => closeOverlay()} />
      ) : null}
      {overlay?.kind === "SERVER_PROFILES" ? (
        <ServerProfileDialog
          store={store}
          {...(serverVerifier === undefined ? {} : { verifier: serverVerifier })}
          onClose={closeServerProfiles}
          onSelected={closeServerProfiles}
          onOpenAuthorizedSites={() => setOverlay({ kind: "AUTHORIZED_SITES" })}
        />
      ) : null}
      {overlay?.kind === "AUTHORIZED_SITES" ? (
        <AuthorizedSitesDialog
          store={store}
          profileId={server.profileId}
          load={loadAuthorizedSites}
          onClose={() => closeOverlay()}
        />
      ) : null}
      {overlay?.kind === "PAGE_PERMISSION" ? (
        <PermissionDialog
          feature={overlay.feature}
          origin={store.pageAccess.value.origin ?? "当前页面不可授权"}
          browserPermission={
            store.pageAccess.value.origin === null
              ? "无可请求权限"
              : `${store.pageAccess.value.origin}/*`
          }
          termsVersion={store.pageAccess.value.serverTermsVersion ?? "未提供"}
          privacyPageUrl={privacyPageUrl}
          ready={overlay.intent !== null}
          externalErrorCode={overlay.preflightErrorCode}
          onConfirm={(agreed) => confirmPagePermission(overlay.intent, agreed)}
          onClose={() => closeOverlay()}
        />
      ) : null}
    </AppShell>
  );
}
