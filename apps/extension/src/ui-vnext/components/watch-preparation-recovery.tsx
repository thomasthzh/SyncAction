import type { JSX } from "preact";
import {
  sameMediaTarget,
  mediaDeviceTakeoverSource,
  sameMediaTakeoverSource,
} from "../../media-controller-model.js";
import type { WatchPreparation } from "../../watch-preparation.js";
import type { UiStore } from "../store.js";

export function WatchPreparationRecovery({
  store,
  busy,
  onResume,
  onOpen,
  onDismiss,
}: {
  readonly store: UiStore;
  readonly busy: boolean;
  readonly onResume: (task: WatchPreparation) => void;
  readonly onOpen: (pageId: string) => void;
  readonly onDismiss: (id: string) => void;
}): JSX.Element | null {
  const room = store.room.value;
  const task = room.watchPreparation;
  const shell = store.shell.value;
  const profile = shell.profiles.find((profile) => profile.profileId === shell.selectedProfileId);
  if (
    task == null ||
    task.accountId !== shell.account?.id ||
    task.profileId !== shell.selectedProfileId ||
    task.roomId !== room.selectedRoomId ||
    task.serverOrigin !== profile?.baseUrl ||
    task.serverId !== (profile.metadata?.serverId ?? null)
  )
    return null;
  const media = room.runtime?.media;
  const group = media?.playbackGroups.find((group) => group.playbackGroupId === task.groupId);
  const matches = group?.target != null && sameMediaTarget(group.target, task.target);
  const ownGroup =
    media?.localMembership?.playbackGroupId === task.groupId && media.localMembership.activeDevice;
  const leading = ownGroup && media!.localMembership!.role === "LEADER";
  const alreadyJoined =
    (task.action === "JOIN" || task.action === "TAKEOVER") &&
    ownGroup &&
    media!.localMembership!.role === "FOLLOWER";
  const connected =
    room.runtime?.state === "SYNCED" &&
    media?.roomMediaRevision != null &&
    media.state !== "OFFLINE" &&
    store.transport.value !== "RECONNECTING";
  const sourceMatches =
    task.action !== "TAKEOVER" ||
    (task.takeoverFrom !== undefined &&
      sameMediaTakeoverSource(mediaDeviceTakeoverSource(group, task.accountId), task.takeoverFrom));
  const canResume =
    !leading &&
    connected &&
    matches &&
    ((task.stage === "PREPARING" && sourceMatches) || alreadyJoined);
  const detail = !connected
    ? "连接恢复后可查看上次准备的结果。"
    : !matches
      ? "原视频已变化或播放组已关闭，请从当前视频重新选择。"
      : leading
        ? "你正在负责这段视频的领播，可直接查看当前播放器。"
        : task.action === "TAKEOVER" && !sourceMatches && !alreadyJoined
          ? "原参与设备或角色已变化，请查看当前播放组后重新选择。"
          : task.stage === "PREPARING"
            ? `你上次还在准备${task.action === "ALIGN" ? "一次进度对齐" : task.action === "TAKEOVER" ? "换到本设备继续看" : "一起看"}，可以接着完成。`
            : alreadyJoined
              ? "你已加入原播放组，可在本设备继续跟随。"
              : task.action === "TAKEOVER"
                ? "上次设备切换结果待确认。请先查看播放组，这条记录不会自动再次接管。"
                : task.action === "ALIGN"
                  ? "上次对齐结果待确认。请先查看播放器，这条记录不会自动重放。"
                  : "上次加入结果待确认。请先查看当前播放组，不会自动再次加入。";
  return (
    <section
      class="watch-return watch-recovery"
      aria-label="上次的观看准备"
      data-watch-recovery={task.stage}
    >
      <div>
        <span class="eyebrow">上次的观看准备</span>
        <strong>{task.title}</strong>
        <p>{detail}</p>
      </div>
      <div class="watch-return__actions">
        {canResume ? (
          <button
            class="primary-button"
            type="button"
            disabled={busy}
            onClick={() => onResume(task)}
          >
            {alreadyJoined ? "继续跟随" : "继续准备"}
          </button>
        ) : null}
        {group?.target != null ? (
          <button
            class="compact-button"
            type="button"
            disabled={busy || !connected}
            onClick={() => onOpen(group.target!.logicalTabId)}
          >
            查看当前视频
          </button>
        ) : null}
        <button
          class="text-button"
          type="button"
          disabled={busy}
          onClick={() => onDismiss(task.id)}
        >
          不再保留
        </button>
      </div>
    </section>
  );
}
