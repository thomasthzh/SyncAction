import { CanonicalUuidSchema, type PublicRoomSummary } from "@syncaction/protocol";
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
import { isPlaceholderServerOrigin } from "../server-configuration.js";
import {
  pendingJoinMatchesServer,
  type PendingRoomJoin,
  type PendingRoomJoinStorage,
} from "../pending-room-join.js";
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
import { WorkspaceSettings } from "./components/workspace-settings.js";

export type Overlay =
  | { kind: "AUTH"; mode: AuthMode }
  | { kind: "MESSAGES" }
  | { kind: "SETTINGS" }
  | { kind: "SERVER_PROFILES" }
  | { kind: "AUTHORIZED_SITES" }
  | { kind: "ACCOUNT_SETTINGS" }
  | { kind: "CREATE_ROOM" }
  | { kind: "INVITE_PICKER" }
  | { kind: "ROOM_LIFECYCLE" }
  | {
      kind: "PAGE_PERMISSION";
      intentKey: string;
      expectedUrl?: string;
      feature: PageFeature;
      intent: PermissionIntent | null;
      preflightErrorCode: string | null;
    }
  | null;

export interface AppProps {
  readonly store: UiStore;
  readonly now?: () => number;
  readonly serverVerifier?: ServerVerifier;
  readonly serviceStatusProbe?: ServiceStatusProbe;
  readonly pendingRoomJoinStorage?: PendingRoomJoinStorage;
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
  profile: UiStore["shell"]["value"]["profiles"][number];
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
    profile,
    profileId: profile.profileId,
    host,
    connected:
      profile.mode !== "UNVERIFIED" &&
      store.transport.value === "CONNECTED" &&
      (store.room.value.selectedRoomId === null || store.room.value.runtime?.state === "SYNCED"),
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
  pendingRoomJoinStorage,
  pagePermissionCoordinator,
  privacyPageUrl = "privacy.html",
  loadAuthorizedSites = EMPTY_AUTHORIZED_SITES_LOADER,
  initialPagePermissionIntent = null,
  pagePermissionIntentSource,
}: AppProps): JSX.Element {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [deferredCommand, setDeferredCommand] = useState<PendingRoomJoin | null>(null);
  const deferredRef = useRef<PendingRoomJoin | null>(null);
  const destinationGeneration = useRef(0);
  const [destinationStorageError, setDestinationStorageError] = useState(false);
  const [joining, setJoining] = useState(false);
  const joinInFlight = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const serverReturnAuthMode = useRef<AuthMode | null>(null);
  const settingsChild = useRef(false);
  const initialPermissionIntentOpened = useRef(false);
  const permissionCaptureGeneration = useRef(0);
  const server = selectedServerContext(store);
  const configurationRequired = isPlaceholderServerOrigin(server.profile.baseUrl);
  const serverKey = `${server.profileId}:${server.profile.baseUrl}:${server.profile.metadata?.serverId ?? ""}`;
  const effectiveAuthMode =
    overlay?.kind === "AUTH" ? supportedAuthMode(overlay.mode, server) : null;
  const publicRoomKey = store.discovery.value.publicRooms.map(({ roomId }) => roomId).join("|");

  function rememberDestination(intent: PendingRoomJoin | null): void {
    destinationGeneration.current += 1;
    deferredRef.current = intent;
    setDeferredCommand(intent);
    setDestinationStorageError(false);
    const generation = destinationGeneration.current;
    void pendingRoomJoinStorage?.write(intent).catch(() => {
      if (generation === destinationGeneration.current) setDestinationStorageError(true);
    });
  }

  useEffect(() => {
    if (pendingRoomJoinStorage === undefined) return;
    let active = true;
    const generation = destinationGeneration.current;
    void pendingRoomJoinStorage.read().then(
      (intent) => {
        if (!active || generation !== destinationGeneration.current) return;
        deferredRef.current = intent;
        setDeferredCommand(intent);
      },
      () => {
        if (active && generation === destinationGeneration.current)
          setDestinationStorageError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [pendingRoomJoinStorage]);

  useEffect(() => {
    setActionError(null);
  }, [server.profileId, store.room.value.selectedRoomId]);

  function openOverlay(next: Exclude<Overlay, null>): void {
    permissionCaptureGeneration.current += 1;
    if (overlay === null) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setOverlay(next);
  }

  function closeOverlay(options: { clearDeferred?: boolean } = {}): void {
    settingsChild.current = false;
    permissionCaptureGeneration.current += 1;
    if (options.clearDeferred === true) {
      rememberDestination(null);
    }
    setOverlay(null);
    queueMicrotask(() => openerRef.current?.focus());
  }

  function openServerProfiles(returnToAuth: AuthMode | null = null): void {
    serverReturnAuthMode.current = returnToAuth;
    openOverlay({ kind: "SERVER_PROFILES" });
  }

  function openAuth(): void {
    if (configurationRequired) openServerProfiles("LOGIN");
    else openOverlay({ kind: "AUTH", mode: "LOGIN" });
  }

  function closeServerProfiles(): void {
    const returnToAuth = serverReturnAuthMode.current;
    const selectedServer = selectedServerContext(store);
    serverReturnAuthMode.current = null;
    if (returnToAuth === null || isPlaceholderServerOrigin(selectedServer.profile.baseUrl)) {
      closeSettingsChild();
    } else {
      setOverlay({
        kind: "AUTH",
        mode: supportedAuthMode(returnToAuth, selectedServer),
      });
    }
  }

  function closeSettingsChild(): void {
    if (settingsChild.current) {
      settingsChild.current = false;
      setOverlay({ kind: "SETTINGS" });
    } else closeOverlay();
  }

  function openSettingsChild(
    next: "SERVER_PROFILES" | "AUTHORIZED_SITES" | "ACCOUNT_SETTINGS",
  ): void {
    settingsChild.current = true;
    if (next === "SERVER_PROFILES") openServerProfiles();
    else setOverlay({ kind: next });
  }

  useEffect(() => {
    if (deferredCommand === null || store.transport.value !== "CONNECTED") return;
    const profile = server.profile;
    // Initial state precedes metadata verification. Do not discard a valid saved destination then.
    if (
      profile.mode === "UNVERIFIED" &&
      deferredCommand.profileId === profile.profileId &&
      deferredCommand.serverOrigin === profile.baseUrl
    )
      return;
    if (
      !pendingJoinMatchesServer(deferredCommand, profile) ||
      (store.shell.value.phase !== "ERROR" &&
        store.shell.value.errorCode !== "PUBLIC_CATALOG_UNAVAILABLE" &&
        !store.discovery.value.publicRooms.some(
          ({ roomId, joinPolicy }) =>
            roomId === deferredCommand.roomId && joinPolicy === deferredCommand.joinPolicy,
        ))
    ) {
      rememberDestination(null);
    }
  }, [deferredCommand, publicRoomKey, serverKey, store.transport.value, store.discovery.value]);

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
    const selected = selectedServerContext(store).profile;
    if (
      selected.profileId !== server.profileId ||
      selected.baseUrl !== server.profile.baseUrl ||
      selected.metadata?.serverId !== server.profile.metadata?.serverId
    )
      return result;
    if (
      !result.ok &&
      (result.errorCode === "AUTHENTICATION_REQUIRED" || result.errorCode === "SESSION_REQUIRED")
    ) {
      rememberDestination({
        version: 1,
        profileId: server.profileId,
        serverOrigin: server.profile.baseUrl,
        serverId: server.profile.metadata?.serverId ?? null,
        roomId: room.roomId,
        roomName: room.name,
        joinPolicy: room.joinPolicy === "OPEN" ? "OPEN" : "APPROVAL",
      });
      openOverlay({ kind: "AUTH", mode: "LOGIN" });
      return { ...result, errorCode: "AUTHENTICATION_REQUIRED" };
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
    const generation = destinationGeneration.current;
    const authServer = server.profile;
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
    const selected = selectedServerContext(store).profile;
    if (
      !result.ok ||
      selected.profileId !== authServer.profileId ||
      selected.baseUrl !== authServer.baseUrl ||
      selected.metadata?.serverId !== authServer.metadata?.serverId
    ) {
      return result;
    }
    if (input.mode !== "REGISTER" && generation === destinationGeneration.current) {
      await continueDestination();
    }
    closeOverlay();
    return result;
  }

  async function continueDestination(): Promise<void> {
    const queued = deferredRef.current;
    if (queued === null || joinInFlight.current) return;
    if (store.shell.value.account?.status !== "ACTIVE") {
      openAuth();
      return;
    }
    const profile = selectedServerContext(store).profile;
    if (store.shell.value.errorCode === "PUBLIC_CATALOG_UNAVAILABLE") {
      setActionError("PUBLIC_CATALOG_UNAVAILABLE");
      return;
    }
    const room = store.discovery.value.publicRooms.find(({ roomId }) => roomId === queued.roomId);
    if (!pendingJoinMatchesServer(queued, profile) || room?.joinPolicy !== queued.joinPolicy) {
      rememberDestination(null);
      return;
    }
    const generation = destinationGeneration.current;
    joinInFlight.current = true;
    setJoining(true);
    try {
      const result = await store.command({
        name: queued.joinPolicy === "OPEN" ? "ROOM_JOIN_OPEN" : "ROOM_JOIN_REQUEST",
        payload: { roomId: room.roomId },
      });
      if (
        generation !== destinationGeneration.current ||
        !pendingJoinMatchesServer(queued, selectedServerContext(store).profile)
      )
        return;
      if (result.ok) rememberDestination(null);
      else setActionError(result.errorCode);
    } catch {
      if (generation === destinationGeneration.current) setActionError("NETWORK_ERROR");
    } finally {
      joinInFlight.current = false;
      setJoining(false);
    }
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
    if (selectedServerContext(store).profileId !== server.profileId) return result;
    if (result.ok) {
      closeOverlay();
    }
    return result;
  }

  function openPagePermission(intentKey: string, expectedUrl?: string): void {
    const mediaJoinGroupId = intentKey.startsWith("media-join:")
      ? CanonicalUuidSchema.parse(intentKey.slice("media-join:".length))
      : undefined;
    const feature =
      intentKey === "media-create" || mediaJoinGroupId !== undefined
        ? "MEDIA_CONTROL"
        : intentKey === "danmaku"
          ? "DANMAKU"
          : intentKey === "pen"
            ? "DRAWING"
            : "POINTER";
    openOverlay({
      kind: "PAGE_PERMISSION",
      intentKey,
      ...(expectedUrl === undefined ? {} : { expectedUrl }),
      feature,
      intent: null,
      preflightErrorCode: null,
    });
    if (pagePermissionCoordinator === undefined) {
      return;
    }
    const generation = permissionCaptureGeneration.current;
    const capture =
      expectedUrl === undefined
        ? pagePermissionCoordinator.capture(feature)
        : pagePermissionCoordinator.capture(feature, expectedUrl);
    void capture.then(
      (intent) => {
        if (generation !== permissionCaptureGeneration.current) return;
        setOverlay((current) =>
          current?.kind === "PAGE_PERMISSION" && current.intentKey === intentKey
            ? {
                ...current,
                intent: mediaJoinGroupId === undefined ? intent : { ...intent, mediaJoinGroupId },
                preflightErrorCode: null,
              }
            : current,
        );
      },
      (error: unknown) => {
        if (generation !== permissionCaptureGeneration.current) return;
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
      onOpenAuth={openAuth}
      onOpenMessages={() => openOverlay({ kind: "MESSAGES" })}
      onOpenServerProfiles={() => openServerProfiles()}
      onOpenSettings={() => openOverlay({ kind: "SETTINGS" })}
      onOpenAccountSettings={
        server.accountSettingsSupported && store.shell.value.account?.status === "ACTIVE"
          ? () => openOverlay({ kind: "ACCOUNT_SETTINGS" })
          : null
      }
    >
      {destinationStorageError ? (
        <p role="alert">无法保存加入进度，请保持此侧栏打开后重试。</p>
      ) : null}
      {deferredCommand !== null && store.room.value.selectedRoomId === null ? (
        <section class="editorial-surface" aria-label="待继续的加入任务">
          <p>已保留目标房间：{deferredCommand.roomName}</p>
          <button
            class="primary-button"
            type="button"
            disabled={joining}
            onClick={() => void continueDestination()}
          >
            {joining ? "正在加入…" : `继续加入 ${deferredCommand.roomName}`}
          </button>
          <button class="text-button" type="button" onClick={() => rememberDestination(null)}>
            取消加入
          </button>
        </section>
      ) : null}
      {store.shell.value.onboardingRequired && !configurationRequired ? (
        <UpgradeNotice store={store} />
      ) : null}
      {store.room.value.selectedRoomId !== null ? (
        <ActiveRoom
          key={`${serverKey}:${store.room.value.selectedRoomId}`}
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
          key={server.profileId}
          store={store}
          actionError={actionError}
          onJoinPublicRoom={joinPublicRoom}
          onOpenCreateRoom={() => openOverlay({ kind: "CREATE_ROOM" })}
          onOpenAuth={openAuth}
          onOpenServerProfiles={() => openServerProfiles()}
          {...(serviceStatusProbe === undefined ? {} : { serviceStatusProbe })}
        />
      )}

      {overlay?.kind === "AUTH" && effectiveAuthMode !== null ? (
        <AuthDialog
          key={server.profileId}
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
      store.shell.value.account?.status === "ACTIVE" ? (
        <AccountSettingsDialog
          store={store}
          account={store.shell.value.account}
          onClose={closeSettingsChild}
        />
      ) : null}
      {overlay?.kind === "SETTINGS" ? (
        <WorkspaceSettings
          store={store}
          onClose={() => closeOverlay()}
          onOpenServerProfiles={() => openSettingsChild("SERVER_PROFILES")}
          onOpenAuthorizedSites={() => openSettingsChild("AUTHORIZED_SITES")}
          onOpenAccountSettings={
            server.accountSettingsSupported && store.shell.value.account?.status === "ACTIVE"
              ? () => openSettingsChild("ACCOUNT_SETTINGS")
              : null
          }
          {...(serviceStatusProbe === undefined ? {} : { serviceStatusProbe })}
        />
      ) : null}
      {overlay?.kind === "CREATE_ROOM" ? (
        <CreateRoomDialog
          key={server.profileId}
          onSubmit={createRoom}
          onClose={() => closeOverlay()}
        />
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
          initialSetup={configurationRequired}
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
          onClose={closeSettingsChild}
        />
      ) : null}
      {overlay?.kind === "PAGE_PERMISSION" ? (
        <PermissionDialog
          key={`${serverKey}:${overlay.intentKey}:${overlay.intent?.tabId ?? "preparing"}:${overlay.intent?.documentRevision.roomEpoch ?? ""}:${overlay.intent?.documentRevision.tabUpdatedAtSeq ?? ""}`}
          feature={overlay.feature}
          {...(overlay.feature === "MEDIA_CONTROL"
            ? {
                continuation: overlay.intentKey.startsWith("media-join:")
                  ? ("JOIN_MEDIA_GROUP" as const)
                  : ("CREATE_MEDIA_GROUP" as const),
              }
            : {})}
          origin={overlay.intent?.origin ?? store.pageAccess.value.origin ?? "当前页面不可授权"}
          browserPermission={
            (overlay.intent?.origin ?? store.pageAccess.value.origin) === null
              ? "无可请求权限"
              : `${overlay.intent?.origin ?? store.pageAccess.value.origin}/*`
          }
          termsVersion={
            overlay.intent?.serverTermsVersion ??
            store.pageAccess.value.serverTermsVersion ??
            "未提供"
          }
          privacyPageUrl={privacyPageUrl}
          ready={overlay.intent !== null}
          externalErrorCode={overlay.preflightErrorCode}
          onRetry={() => openPagePermission(overlay.intentKey, overlay.expectedUrl)}
          onConfirm={(agreed) => confirmPagePermission(overlay.intent, agreed)}
          onClose={() => closeOverlay()}
        />
      ) : null}
    </AppShell>
  );
}
