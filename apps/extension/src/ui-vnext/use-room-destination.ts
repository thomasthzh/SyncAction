import { RoomIdSchema, RoomJoinRequestSchema, type PublicRoomSummary } from "@syncaction/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  pendingJoinMatchesServer,
  type PendingRoomJoin,
  type PendingRoomJoinStorage,
} from "../pending-room-join.js";
import type { UiCommandResult } from "../ui/ui-protocol.js";
import type { UiStore } from "./store.js";

function selectedProfile(store: UiStore) {
  const shell = store.shell.value;
  return (
    shell.profiles.find((profile) => profile.profileId === shell.selectedProfileId) ??
    shell.profiles[0]!
  );
}
function failed(errorCode: string): UiCommandResult {
  return { type: "ui.command.result", commandId: crypto.randomUUID(), ok: false, errorCode };
}

/** A saved destination becomes a tracked application, then an explicit room entry.
 * Refreshing progress never silently moves the user into a room. */
export function useRoomDestination(
  store: UiStore,
  storage: PendingRoomJoinStorage | undefined,
  onAuthenticate: () => void,
) {
  const [deferredCommand, setDestination] = useState<PendingRoomJoin | null>(null);
  const current = useRef<PendingRoomJoin | null>(null);
  const destinationGeneration = useRef(0);
  const [destinationStorageError, setStorageError] = useState(false);
  const [joining, setJoining] = useState(false);
  const busy = useRef(false);
  const restoredRequest = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const profile = selectedProfile(store);
  const discovery = store.discovery.value;
  const account = store.shell.value.account;
  const notifications = store.notifications.value.items;
  const approved =
    deferredCommand !== null && discovery.rooms.some((room) => room.id === deferredCommand.roomId);
  const latestDecision =
    deferredCommand?.requestId === undefined
      ? undefined
      : [...notifications]
          .sort((left, right) => right.cursor - left.cursor)
          .find((item) => item.requestId === deferredCommand.requestId);
  const rejected =
    latestDecision?.type === "ROOM_JOIN_REQUEST_REJECTED" ||
    latestDecision?.type === "ROOM_JOIN_REQUEST_CANCELLED";

  function rememberDestination(intent: PendingRoomJoin | null): Promise<boolean> {
    destinationGeneration.current += 1;
    current.current = intent;
    setDestination(intent);
    setStorageError(false);
    const generation = destinationGeneration.current;
    return (storage?.write(intent) ?? Promise.resolve()).then(
      () => true,
      () => {
        if (mounted.current && generation === destinationGeneration.current) setStorageError(true);
        return false;
      },
    );
  }
  function valid(intent: PendingRoomJoin, generation: number): boolean {
    return (
      mounted.current &&
      generation === destinationGeneration.current &&
      pendingJoinMatchesServer(intent, selectedProfile(store)) &&
      (intent.accountId === undefined || store.shell.value.account?.id === intent.accountId)
    );
  }
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (storage === undefined) return;
    let active = true;
    // A reopened sidebar can receive the background's confirmed request later.
    const unsubscribe = storage.subscribe?.((intent) => {
      const previous = current.current;
      if (
        !active ||
        intent?.stage !== "REQUESTED" ||
        !pendingJoinMatchesServer(intent, selectedProfile(store)) ||
        (previous !== null &&
          (previous.stage === "REQUESTED" ||
            previous.roomId !== intent.roomId ||
            previous.profileId !== intent.profileId ||
            previous.serverOrigin !== intent.serverOrigin ||
            previous.serverId !== intent.serverId)) ||
        (store.shell.value.account !== null && intent.accountId !== store.shell.value.account.id)
      )
        return;
      if (previous === null) destinationGeneration.current += 1;
      current.current = intent;
      restoredRequest.current = intent.requestId;
      setDestination(intent);
    });
    const generation = destinationGeneration.current;
    void storage.read().then(
      (intent) => {
        if (!active || generation !== destinationGeneration.current) return;
        current.current = intent;
        restoredRequest.current = intent?.stage === "REQUESTED" ? intent.requestId : undefined;
        setDestination(intent);
      },
      () => {
        if (active && generation === destinationGeneration.current) setStorageError(true);
      },
    );
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [storage]);
  useEffect(() => {
    if (deferredCommand === null || store.transport.value !== "CONNECTED") return;
    if (
      profile.mode === "UNVERIFIED" &&
      deferredCommand.profileId === profile.profileId &&
      deferredCommand.serverOrigin === profile.baseUrl
    )
      return;
    if (
      !pendingJoinMatchesServer(deferredCommand, profile) ||
      (deferredCommand.accountId !== undefined &&
        account !== null &&
        account.id !== deferredCommand.accountId) ||
      (deferredCommand.stage !== "REQUESTED" &&
        store.shell.value.phase !== "ERROR" &&
        store.shell.value.errorCode !== "PUBLIC_CATALOG_UNAVAILABLE" &&
        !discovery.rooms.some((room) => room.id === deferredCommand.roomId) &&
        !discovery.publicRooms.some(
          (room) =>
            room.roomId === deferredCommand.roomId &&
            room.joinPolicy === deferredCommand.joinPolicy,
        ))
    )
      rememberDestination(null);
  }, [
    profile.profileId,
    profile.baseUrl,
    profile.metadata?.serverId,
    profile.mode,
    account?.id,
    deferredCommand,
    store.transport.value,
    discovery,
  ]);
  useEffect(
    () => setActionError(null),
    [
      profile.profileId,
      profile.baseUrl,
      profile.metadata?.serverId,
      account?.id,
      store.room.value.selectedRoomId,
    ],
  );

  async function runJoin(intent: PendingRoomJoin): Promise<UiCommandResult> {
    if (busy.current) return failed("ROOM_JOIN_IN_PROGRESS");
    if (
      !pendingJoinMatchesServer(intent, selectedProfile(store)) ||
      (intent.accountId !== undefined && intent.accountId !== store.shell.value.account?.id)
    )
      return failed("ROOM_CONTEXT_CHANGED");
    busy.current = true;
    setJoining(true);
    setActionError(null);
    // Save before sending: a sidebar close must not lose the requested destination.
    intent = {
      ...intent,
      ...(store.shell.value.account?.status === "ACTIVE"
        ? { accountId: store.shell.value.account.id }
        : {}),
    };
    const saved = rememberDestination(intent);
    const generation = destinationGeneration.current;
    try {
      if (!(await saved)) return failed("ROOM_JOIN_PROGRESS_NOT_SAVED");
      if (!valid(intent, generation)) return failed("ROOM_CONTEXT_CHANGED");
      const member = store.discovery.value.rooms.some((room) => room.id === intent.roomId);
      const result = await store.command({
        name: member
          ? "ROOM_SELECT"
          : intent.joinPolicy === "OPEN"
            ? "ROOM_JOIN_OPEN"
            : "ROOM_JOIN_REQUEST",
        payload: { roomId: RoomIdSchema.parse(intent.roomId) },
      });
      if (!valid(intent, generation)) return result;
      if (!result.ok) {
        if (["AUTHENTICATION_REQUIRED", "SESSION_REQUIRED"].includes(result.errorCode)) {
          onAuthenticate();
          return { ...result, errorCode: "AUTHENTICATION_REQUIRED" };
        } else setActionError(result.errorCode);
        return result;
      }
      if (member || intent.joinPolicy === "OPEN") rememberDestination(null);
      else {
        const parsed = RoomJoinRequestSchema.safeParse(result.value);
        if (
          !parsed.success ||
          parsed.data.roomId !== intent.roomId ||
          parsed.data.applicant.userId !== store.shell.value.account?.id
        ) {
          setActionError("ROOM_JOIN_RESULT_UNCONFIRMED");
          return failed("ROOM_JOIN_RESULT_UNCONFIRMED");
        }
        rememberDestination({
          ...intent,
          stage: "REQUESTED",
          requestId: parsed.data.requestId,
          accountId: parsed.data.applicant.userId,
        });
      }
      return result;
    } catch {
      if (valid(intent, generation)) setActionError("NETWORK_ERROR");
      return failed("NETWORK_ERROR");
    } finally {
      busy.current = false;
      if (mounted.current) setJoining(false);
    }
  }

  async function joinPublicRoom(room: PublicRoomSummary): Promise<UiCommandResult> {
    if (
      current.current?.roomId === room.roomId &&
      current.current.stage === "REQUESTED" &&
      !rejected
    )
      return failed("ROOM_JOIN_ALREADY_REQUESTED");
    const selected = selectedProfile(store);
    return runJoin({
      version: 1,
      profileId: selected.profileId,
      serverOrigin: selected.baseUrl,
      serverId: selected.metadata?.serverId ?? null,
      roomId: room.roomId,
      roomName: room.name,
      joinPolicy: room.joinPolicy === "OPEN" ? "OPEN" : "APPROVAL",
      stage: "READY",
    });
  }
  async function refreshProgress(enter: boolean): Promise<void> {
    const intent = current.current;
    if (intent === null || busy.current) return;
    if (
      intent.accountId !== undefined &&
      intent.accountId !== store.shell.value.account?.id &&
      store.shell.value.account !== null
    ) {
      setActionError("ROOM_CONTEXT_CHANGED");
      return;
    }
    if (store.shell.value.account?.status !== "ACTIVE") {
      onAuthenticate();
      return;
    }
    const generation = destinationGeneration.current;
    busy.current = true;
    setJoining(true);
    setActionError(null);
    try {
      const result = await store.command({ name: "PRODUCT_REFRESH" });
      if (!valid(intent, generation)) return;
      if (!result.ok) {
        setActionError(result.errorCode);
        return;
      }
      if (enter && store.discovery.value.rooms.some((room) => room.id === intent.roomId)) {
        const opened = await store.command({
          name: "ROOM_SELECT",
          payload: { roomId: RoomIdSchema.parse(intent.roomId) },
        });
        if (!valid(intent, generation)) return;
        if (opened.ok) rememberDestination(null);
        else setActionError(opened.errorCode);
      }
    } catch {
      if (valid(intent, generation)) setActionError("NETWORK_ERROR");
    } finally {
      busy.current = false;
      if (mounted.current) setJoining(false);
    }
  }
  async function continueDestination(): Promise<void> {
    const intent = current.current;
    if (intent === null) return;
    if (
      intent.accountId !== undefined &&
      store.shell.value.account !== null &&
      intent.accountId !== store.shell.value.account.id
    ) {
      setActionError("ROOM_CONTEXT_CHANGED");
      return;
    }
    if (store.shell.value.account?.status !== "ACTIVE") {
      onAuthenticate();
      return;
    }
    if (intent.stage === "REQUESTED" && !rejected) {
      await refreshProgress(true);
      return;
    }
    if (store.shell.value.errorCode === "PUBLIC_CATALOG_UNAVAILABLE") {
      setActionError("PUBLIC_CATALOG_UNAVAILABLE");
      return;
    }
    if (
      !store.discovery.value.rooms.some((room) => room.id === intent.roomId) &&
      !store.discovery.value.publicRooms.some(
        (room) => room.roomId === intent.roomId && room.joinPolicy === intent.joinPolicy,
      )
    ) {
      setActionError("ROOM_NOT_AVAILABLE");
      return;
    }
    await runJoin({ ...intent, stage: "READY" });
  }
  async function cancelDestination(): Promise<void> {
    const intent = current.current;
    if (intent === null || busy.current) return;
    if (intent.accountId !== undefined && intent.accountId !== store.shell.value.account?.id) {
      setActionError("ROOM_CONTEXT_CHANGED");
      return;
    }
    if (intent.stage !== "REQUESTED" || approved || rejected) {
      rememberDestination(null);
      return;
    }
    const generation = destinationGeneration.current;
    busy.current = true;
    setJoining(true);
    try {
      const result = await store.command({
        name: "ROOM_JOIN_CANCEL",
        payload: { requestId: intent.requestId! },
      });
      if (!valid(intent, generation)) return;
      if (result.ok) rememberDestination(null);
      else setActionError(result.errorCode);
    } catch {
      if (valid(intent, generation)) setActionError("NETWORK_ERROR");
    } finally {
      busy.current = false;
      if (mounted.current) setJoining(false);
    }
  }
  useEffect(() => {
    if (
      deferredCommand?.stage !== "REQUESTED" ||
      account?.status !== "ACTIVE" ||
      store.room.value.selectedRoomId !== null
    )
      return;
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshProgress(false);
    };
    if (restoredRequest.current === deferredCommand.requestId) {
      restoredRequest.current = undefined;
      void refreshProgress(false);
    }
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [deferredCommand, account?.id, account?.status, store.room.value.selectedRoomId]);

  return {
    deferredCommand,
    destinationGeneration,
    destinationStorageError,
    joining,
    actionError,
    approved,
    rejected,
    rememberDestination,
    joinPublicRoom,
    continueDestination,
    cancelDestination,
  };
}
