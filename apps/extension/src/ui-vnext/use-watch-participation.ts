import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { MediaTarget } from "@syncaction/protocol";
import {
  sameMediaTarget,
  mediaDeviceTakeoverSource,
  sameMediaTakeoverSource,
  type MediaDeviceTakeoverSource,
} from "../media-controller-model.js";
import type { UiStore } from "./store.js";
import type { PagePermissionRequester } from "../origin-permission-coordinator.js";

type Participation = {
  profileId: string;
  roomId: NonNullable<UiStore["room"]["value"]["selectedRoomId"]>;
  groupId: string;
  target: MediaTarget;
  action: "JOIN" | "ALIGN" | "TAKEOVER";
  accountId: string;
  takeoverFrom: MediaDeviceTakeoverSource | null;
  preparationId: string | null;
  tabId: number | null;
  url: string | null;
  started: boolean;
  preparation: "NEW" | "PERMISSION" | "IN_FLIGHT" | "READY";
};
type Phase =
  | "OPENING"
  | "WAITING_PAGE"
  | "PERMISSION"
  | "WAITING_MEDIA"
  | "JOINING"
  | "ALIGNING"
  | "TAKING_OVER"
  | "CONFIRMING_DEVICE";

/** One explicit user action opens the chosen video and continues on that page.
 * No local browsing is published and a changed target is never silently followed. */
export function useWatchParticipation(store: UiStore, requestPermission: PagePermissionRequester) {
  const [pending, setPending] = useState<{ task: Participation; phase: Phase } | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const current = useRef<Participation | null>(null);
  const mounted = useRef(true);
  const access = store.pageAccess.value;
  const room = store.room.value;
  const profileId = store.shell.value.selectedProfileId;
  useLayoutEffect(
    () => () => {
      mounted.current = false;
      current.current = null;
    },
    [],
  );

  function isCurrent(task: Participation): boolean {
    const group = store.room.value.runtime?.media?.playbackGroups.find(
      (group) => group.playbackGroupId === task.groupId,
    );
    return (
      mounted.current &&
      current.current === task &&
      store.shell.value.selectedProfileId === task.profileId &&
      store.shell.value.account?.id === task.accountId &&
      (task.takeoverFrom === null ||
        sameMediaTakeoverSource(
          mediaDeviceTakeoverSource(group, task.accountId),
          task.takeoverFrom,
        ) ||
        (task.started &&
          store.room.value.runtime?.media?.localMembership?.playbackGroupId === task.groupId &&
          store.room.value.runtime.media.localMembership.activeDevice &&
          mediaDeviceTakeoverSource(group, task.accountId)?.role === task.takeoverFrom.role)) &&
      store.room.value.selectedRoomId === task.roomId &&
      (task.tabId === null || store.pageAccess.value.tabId === task.tabId) &&
      (task.url === null || store.pageAccess.value.url === task.url) &&
      group?.target != null &&
      sameMediaTarget(group.target, task.target)
    );
  }
  function finish(
    task: Participation,
    error: string | null = null,
    text: string | null = null,
  ): void {
    if (!mounted.current || current.current !== task) return;
    current.current = null;
    setPending(null);
    setErrorCode(error);
    setMessage(text);
  }
  function confirmDevice(task: Participation): void {
    if (!isCurrent(task)) {
      finish(task, "MEDIA_DEVICE_CHANGED");
      return;
    }
    const media = store.room.value.runtime?.media;
    const member = media?.localMembership;
    if (
      media == null ||
      member?.playbackGroupId !== task.groupId ||
      !member.activeDevice ||
      member.role !== task.takeoverFrom?.role
    )
      return;
    const ready =
      media.controlReady === true &&
      media.localObservation != null &&
      sameMediaTarget(media.localObservation.target, task.target);
    finish(
      task,
      null,
      ready
        ? member.role === "LEADER"
          ? "已在本设备领播，播放状态见当前视频"
          : "已在本设备参与跟随，播放状态见当前视频"
        : "已切换到本设备，播放器仍在准备；当前角色已确认",
    );
    if (task.preparationId !== null)
      void store.command({
        name: "WATCH_PREPARATION_DISMISS",
        payload: { id: task.preparationId },
      });
  }
  function pageReady(task: Participation): boolean {
    const latest = store.pageAccess.value;
    return (
      latest.logicalTabId === task.target.logicalTabId &&
      latest.documentRevision !== null &&
      latest.documentRevision.roomEpoch === task.target.documentRevision.roomEpoch &&
      latest.documentRevision.tabUpdatedAtSeq === task.target.documentRevision.tabUpdatedAtSeq &&
      latest.tabId !== null
    );
  }
  async function participate(task: Participation): Promise<void> {
    if (task.started || !isCurrent(task) || !pageReady(task)) return;
    if (task.preparation === "PERMISSION" || task.preparation === "IN_FLIGHT") return;
    const latest = store.pageAccess.value;
    task.url ??= latest.url ?? null;
    if (!latest.browserPermissionGranted || !latest.termsAccepted) {
      task.preparation = "PERMISSION";
      setPending({ task, phase: "PERMISSION" });
      requestPermission(
        `media-${task.action === "ALIGN" ? "align" : task.action === "TAKEOVER" ? "takeover" : "join"}:${task.groupId}`,
        latest.url ?? undefined,
        (granted) => {
          if (!isCurrent(task)) {
            finish(task, "MEDIA_CONTEXT_CHANGED");
            return;
          }
          if (!granted) {
            finish(task);
            if (task.preparationId !== null)
              void store.command({
                name: "WATCH_PREPARATION_DISMISS",
                payload: { id: task.preparationId },
              });
            return;
          }
          task.preparation = "READY";
          setPending({ task, phase: "WAITING_MEDIA" });
          void participate(task);
        },
      );
      return;
    }
    const expectedContext = {
      profileId: task.profileId,
      roomId: task.roomId,
      tabId: task.tabId!,
      documentRevision: task.target.documentRevision,
      ...(task.url === null ? {} : { url: task.url }),
    };
    if (task.preparation === "NEW") {
      task.preparation = "IN_FLIGHT";
      setPending({ task, phase: "WAITING_MEDIA" });
      try {
        const result = await store.command({
          name: "MEDIA_GROUP_PREPARE",
          payload: {
            playbackGroupId: task.groupId,
            expectedContext,
            expectedTarget: task.target,
            ...(task.takeoverFrom === null ? {} : { takeoverFrom: task.takeoverFrom }),
          },
        });
        if (!isCurrent(task)) {
          finish(task, "MEDIA_CONTEXT_CHANGED");
          return;
        }
        if (!result.ok) {
          finish(task, result.errorCode);
          return;
        }
        task.preparation = "READY";
        setPending({ task, phase: "WAITING_MEDIA" });
        void participate(task);
      } catch {
        if (isCurrent(task)) finish(task, "NETWORK_ERROR");
      }
      return;
    }
    const media = store.room.value.runtime?.media;
    if (
      media?.localObservation == null ||
      !sameMediaTarget(media.localObservation.target, task.target)
    ) {
      if (
        media?.errorCode !== null &&
        media?.errorCode !== undefined &&
        [
          "MEDIA_DRM_UNSUPPORTED",
          "MEDIA_LIVE_UNSUPPORTED",
          "MEDIA_NOT_SUPPORTED",
          "MEDIA_FRAME_UNAUTHORIZED",
          "ORIGIN_PERMISSION_REVOKED",
        ].includes(media.errorCode)
      )
        finish(task, media.errorCode);
      return;
    }
    task.started = true;
    setPending({
      task,
      phase:
        task.action === "ALIGN"
          ? "ALIGNING"
          : task.action === "TAKEOVER"
            ? "TAKING_OVER"
            : "JOINING",
    });
    try {
      const result = await store.command({
        name:
          task.action === "ALIGN"
            ? "MEDIA_GROUP_ALIGN_ONCE"
            : task.action === "TAKEOVER"
              ? "MEDIA_DEVICE_TAKEOVER"
              : "MEDIA_GROUP_JOIN",
        payload: {
          playbackGroupId: task.groupId,
          expectedTarget: task.target,
          expectedContext,
          ...(task.takeoverFrom === null ? {} : { takeoverFrom: task.takeoverFrom }),
          ...(task.preparationId === null ? {} : { preparationId: task.preparationId }),
        },
      });
      if (!isCurrent(task)) {
        finish(task, "MEDIA_CONTEXT_CHANGED");
        return;
      }
      if (task.action === "TAKEOVER" && result.ok) {
        setPending({ task, phase: "CONFIRMING_DEVICE" });
        confirmDevice(task);
        return;
      }
      const membership = store.room.value.runtime?.media?.localMembership;
      finish(
        task,
        result.ok ? null : result.errorCode,
        result.ok
          ? task.action === "ALIGN"
            ? "进度对齐已发出，请以播放器为准；不会持续跟随"
            : membership?.playbackGroupId === task.groupId && membership.activeDevice
              ? "已参与跟随，播放状态见当前视频"
              : "跟随请求已提交，正在确认本设备状态"
          : null,
      );
    } catch {
      if (isCurrent(task)) finish(task, "NETWORK_ERROR");
    }
  }
  async function follow(
    groupId: string,
    action: "JOIN" | "ALIGN" | "TAKEOVER" = "JOIN",
    expectedTarget?: MediaTarget,
    expectedTakeoverFrom?: MediaDeviceTakeoverSource,
  ): Promise<void> {
    if (current.current !== null) return;
    const group = store.room.value.runtime?.media?.playbackGroups.find(
      (group) => group.playbackGroupId === groupId,
    );
    const selectedRoomId = store.room.value.selectedRoomId;
    if (group?.target == null || selectedRoomId === null) {
      setErrorCode("MEDIA_TARGET_UNAVAILABLE");
      return;
    }
    if (expectedTarget !== undefined && !sameMediaTarget(group.target, expectedTarget)) {
      setErrorCode("MEDIA_TARGET_CHANGED");
      return;
    }
    const accountId = store.shell.value.account?.id;
    if (accountId === undefined) {
      setErrorCode("AUTHENTICATION_REQUIRED");
      return;
    }
    const takeoverFrom = action === "TAKEOVER" ? mediaDeviceTakeoverSource(group, accountId) : null;
    const membership = store.room.value.runtime?.media?.localMembership;
    if (
      action === "TAKEOVER" &&
      (takeoverFrom === null ||
        membership?.playbackGroupId !== groupId ||
        membership.activeDevice ||
        (expectedTakeoverFrom !== undefined &&
          !sameMediaTakeoverSource(takeoverFrom, expectedTakeoverFrom)))
    ) {
      setErrorCode("MEDIA_DEVICE_CHANGED");
      return;
    }
    const task: Participation = {
      profileId: store.shell.value.selectedProfileId,
      roomId: selectedRoomId,
      groupId,
      target: structuredClone(group.target),
      action,
      accountId,
      takeoverFrom,
      preparationId:
        store.room.value.watchPreparationAvailable === true ? crypto.randomUUID() : null,
      tabId: null,
      url: null,
      started: false,
      preparation: "NEW",
    };
    current.current = task;
    setErrorCode(null);
    setMessage(null);
    setPending({ task, phase: "OPENING" });
    try {
      if (task.preparationId !== null) {
        const saved = await store.command({
          name: "WATCH_PREPARATION_SAVE",
          payload: {
            id: task.preparationId,
            groupId,
            target: task.target,
            action,
            ...(takeoverFrom === null ? {} : { takeoverFrom }),
            profileId: task.profileId,
            roomId: task.roomId,
          },
        });
        if (!isCurrent(task)) return;
        if (!saved.ok) {
          finish(task, saved.errorCode);
          return;
        }
      }
      const result = await store.command({
        name: "ROOM_TAB_ACTIVATE",
        payload: {
          logicalTabId: task.target.logicalTabId,
          expectedContext: { profileId: task.profileId, roomId: task.roomId },
        },
      });
      if (!isCurrent(task)) {
        finish(task, "MEDIA_CONTEXT_CHANGED");
        return;
      }
      if (!result.ok) {
        finish(task, result.errorCode);
        return;
      }
      const refreshed = await store.command({ name: "PAGE_PERMISSION_REFRESH" });
      if (!isCurrent(task)) {
        finish(task, "MEDIA_CONTEXT_CHANGED");
        return;
      }
      if (!refreshed.ok) {
        finish(task, refreshed.errorCode);
        return;
      }
      task.tabId = store.pageAccess.value.tabId;
      setPending({ task, phase: "WAITING_PAGE" });
      await participate(task);
    } catch {
      if (isCurrent(task)) finish(task, "NETWORK_ERROR");
    }
  }
  useEffect(() => {
    if (pending === null) return;
    const { task, phase } = pending;
    if (
      !isCurrent(task) ||
      (phase !== "OPENING" && task.tabId !== null && access.tabId !== task.tabId)
    ) {
      finish(task, "MEDIA_CONTEXT_CHANGED");
      return;
    }
    const revision = access.documentRevision;
    if (
      access.logicalTabId === task.target.logicalTabId &&
      revision !== null &&
      (revision.roomEpoch > task.target.documentRevision.roomEpoch ||
        (revision.roomEpoch === task.target.documentRevision.roomEpoch &&
          revision.tabUpdatedAtSeq > task.target.documentRevision.tabUpdatedAtSeq))
    ) {
      finish(task, "MEDIA_TARGET_CHANGED");
      return;
    }
    if (phase === "CONFIRMING_DEVICE") confirmDevice(task);
    else if (phase === "WAITING_PAGE" || phase === "WAITING_MEDIA") void participate(task);
  }, [pending, profileId, room, access]);
  useEffect(() => {
    if (pending === null || pending.phase === "PERMISSION") return;
    const timer = setTimeout(
      () =>
        finish(
          pending.task,
          pending.task.action === "TAKEOVER" && pending.task.started
            ? "MEDIA_DEVICE_RESULT_UNCONFIRMED"
            : pending.phase === "JOINING" || pending.phase === "ALIGNING"
              ? "MEDIA_FOLLOW_RESULT_UNCONFIRMED"
              : "MEDIA_TARGET_PAGE_PREPARING",
        ),
      10_000,
    );
    return () => clearTimeout(timer);
  }, [pending]);
  function cancel(): void {
    if (current.current?.started === true) return;
    if (current.current !== null) {
      const task = current.current;
      finish(task, null, "已停止准备，打开的页面仍保留");
      if (task.preparationId !== null)
        void store.command({
          name: "WATCH_PREPARATION_DISMISS",
          payload: { id: task.preparationId },
        });
    }
  }
  return {
    follow,
    cancel,
    canCancel: pending !== null && !pending.task.started,
    busy: pending !== null,
    errorCode,
    message,
    phase: pending?.phase ?? null,
  };
}
