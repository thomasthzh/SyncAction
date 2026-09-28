import { predictGroupPosition } from "@syncaction/media";
import type {
  PlaybackAction,
  PlaybackGroupSnapshot,
  PlaybackGroupStatus,
} from "@syncaction/protocol";
import type {
  ExtensionCollaborationMemberSummary,
  ExtensionCollaborationPageSummary,
} from "../app-controller.js";
import type { MediaControllerStatus } from "../media-controller.js";

export type MediaViewTone = "neutral" | "info" | "success" | "warning" | "danger";
export type MediaGroupTheme = "blue" | "indigo" | "cyan" | "teal";

export type MediaViewIntent =
  | { readonly type: "JUMP_TO_MEMBER"; readonly userId: string }
  | { readonly type: "ALIGN_ONCE"; readonly playbackGroupId: string }
  | { readonly type: "JOIN_GROUP"; readonly playbackGroupId: string }
  | { readonly type: "LEAVE_GROUP"; readonly playbackGroupId: string }
  | { readonly type: "CLOSE_GROUP"; readonly playbackGroupId: string }
  | { readonly type: "TAKEOVER_DEVICE"; readonly playbackGroupId: string }
  | {
      readonly type: "DECIDE_PROPOSAL";
      readonly playbackGroupId: string;
      readonly proposalId: string;
      readonly decision: "APPROVE" | "REJECT";
    };

export interface MediaViewAction {
  readonly key: string;
  readonly label: string;
  readonly accessibleText: string;
  readonly intent: MediaViewIntent;
  readonly tone: MediaViewTone;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}

export interface MediaTargetView {
  readonly pageId: string;
  readonly pageTitle: string;
  readonly domain: string;
  readonly providerText: string;
  readonly progressText: string;
  readonly frameText: string;
}

export interface MediaMemberView {
  readonly key: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: "LEADER" | "FOLLOWER" | "OUTSIDE";
  readonly roleText: string;
  readonly online: boolean;
  readonly pageId: string | null;
  readonly pageTitle: string | null;
  readonly detail: string;
  readonly tone: MediaViewTone;
  readonly primaryAction: MediaViewAction;
  readonly trailingActions: readonly MediaViewAction[];
}

export interface MediaProposalView {
  readonly key: string;
  readonly proposalId: string;
  readonly proposedByText: string;
  readonly title: string;
  readonly detail: string;
  readonly tone: MediaViewTone;
  readonly trailingActions: readonly MediaViewAction[];
}

export interface MediaGroupView {
  readonly key: string;
  readonly groupId: string;
  readonly name: string;
  readonly theme: MediaGroupTheme;
  readonly state: PlaybackGroupStatus;
  readonly statusText: string;
  readonly tone: MediaViewTone;
  readonly memberCount: number;
  readonly recommended: boolean;
  readonly progressSeconds: number;
  readonly isDefaultForUngroupedViewer: boolean;
  readonly badgeText: string;
  readonly target: MediaTargetView | null;
  readonly detail: string;
  readonly members: readonly MediaMemberView[];
  readonly proposals: readonly MediaProposalView[];
  readonly trailingActions: readonly MediaViewAction[];
}

export interface MediaViewNotice {
  readonly tone: MediaViewTone;
  readonly text: string;
}

export interface MediaViewModel {
  readonly state: "UNAVAILABLE" | MediaControllerStatus["state"];
  readonly recommendedPlaybackGroupId: string | null;
  readonly groups: readonly MediaGroupView[];
  readonly outsideMembers: readonly MediaMemberView[];
  readonly notice: MediaViewNotice | null;
}

export interface MediaViewModelInput {
  readonly media: MediaControllerStatus | null;
  readonly pages: readonly ExtensionCollaborationPageSummary[];
  readonly members: readonly ExtensionCollaborationMemberSummary[];
  readonly nowMs: number;
}

const themes: readonly MediaGroupTheme[] = ["blue", "indigo", "cyan", "teal"];

export function createMediaViewModel(input: MediaViewModelInput): MediaViewModel {
  const pages = uniqueBy(input.pages, (page) => page.pageId);
  const members = uniqueBy(input.members, (member) => member.userId);
  const pageById = new Map(pages.map((page) => [page.pageId, page]));
  const memberById = new Map(members.map((member) => [member.userId, member]));
  const media = input.media;
  if (media === null) {
    return {
      state: "UNAVAILABLE",
      recommendedPlaybackGroupId: null,
      groups: [],
      outsideMembers: outsideMembers(members, new Set(), pageById, null),
      notice: null,
    };
  }

  const groups = uniqueBy(media.playbackGroups, (group) => group.playbackGroupId).sort(
    (left, right) =>
      right.members.length - left.members.length ||
      groupProgressMs(right, input.nowMs) - groupProgressMs(left, input.nowMs) ||
      left.playbackGroupId.localeCompare(right.playbackGroupId),
  );
  const defaultGroupId =
    media.localMembership === null
      ? (groups[0]?.playbackGroupId ?? null)
      : media.recommendedPlaybackGroupId;
  const groupedUserIds = new Set(
    groups.flatMap((group) => group.members.map((member) => member.userId)),
  );
  return {
    state: media.state,
    recommendedPlaybackGroupId: defaultGroupId,
    groups: groups.map((group) =>
      groupView(group, media, pageById, memberById, input.nowMs, defaultGroupId),
    ),
    outsideMembers: outsideMembers(members, groupedUserIds, pageById, media),
    notice: mediaNotice(media),
  };
}

function groupView(
  group: PlaybackGroupSnapshot,
  media: MediaControllerStatus,
  pageById: ReadonlyMap<string, ExtensionCollaborationPageSummary>,
  memberById: ReadonlyMap<string, ExtensionCollaborationMemberSummary>,
  nowMs: number,
  defaultGroupId: string | null,
): MediaGroupView {
  const target = targetView(group, pageById, nowMs);
  const recommended = defaultGroupId === group.playbackGroupId;
  const membership = media.localMembership;
  const alignDisabledReason =
    media.state === "OFFLINE"
      ? "媒体同步当前离线"
      : media.state === "DEGRADED"
        ? "当前媒体控制已降级"
        : membership !== null
          ? "已加入播放组"
          : group.target === null || group.observed === null
            ? "播放组暂无可对齐媒体"
            : null;
  const joinDisabledReason =
    media.state === "OFFLINE" ? "媒体同步当前离线" : membership !== null ? "已加入播放组" : null;
  const members = orderedMembers(group).map((member) => {
    const role =
      member.userId === group.leaderUserId && member.activeDeviceId === group.leaderDeviceId
        ? ("LEADER" as const)
        : ("FOLLOWER" as const);
    const navigation = media.navigation.find(
      (candidate) =>
        candidate.userId === member.userId && candidate.deviceId === member.activeDeviceId,
    );
    const page =
      navigation?.logicalTabId === null || navigation?.logicalTabId === undefined
        ? undefined
        : pageById.get(navigation.logicalTabId);
    const knownMember = memberById.get(member.userId);
    const online = member.online && (knownMember?.online ?? true);
    const jumpDisabledReason = !online
      ? "成员离线"
      : navigation?.logicalTabId === null || navigation === undefined
        ? "成员未在共享页面"
        : !navigation.canJump
          ? "当前客户端未绑定该共享页面"
          : null;
    const detail = memberDetail(page, navigation?.logicalTabId ?? null, group, target, online);
    return {
      key: `media-group:${group.playbackGroupId}:member:${member.userId}`,
      userId: member.userId,
      displayName: member.displayName,
      role,
      roleText: role === "LEADER" ? "领播者" : "跟随者",
      online,
      pageId: page?.pageId ?? null,
      pageTitle: page?.title ?? null,
      detail,
      tone:
        role === "LEADER"
          ? ("info" as const)
          : online
            ? ("success" as const)
            : ("neutral" as const),
      primaryAction: viewAction({
        key: `media-group:${group.playbackGroupId}:member:${member.userId}:jump`,
        label: "跳转",
        accessibleText: `跳转到 ${member.displayName} 当前页面`,
        intent: { type: "JUMP_TO_MEMBER", userId: member.userId },
        disabledReason: jumpDisabledReason,
      }),
      trailingActions: [],
    };
  });

  const canSeeProposals =
    membership?.playbackGroupId === group.playbackGroupId &&
    membership.role === "LEADER" &&
    membership.activeDevice;
  const proposals = canSeeProposals
    ? group.proposals
        .filter(
          (proposal) =>
            proposal.expiresAtServerMs > nowMs &&
            proposal.baseGroupRevision === group.groupRevision,
        )
        .map((proposal) => {
          const proposedBy =
            group.members.find((member) => member.userId === proposal.proposedByUserId)
              ?.displayName ?? "组成员";
          const decisionDisabledReason = media.state === "OFFLINE" ? "媒体同步当前离线" : null;
          return {
            key: `media-group:${group.playbackGroupId}:proposal:${proposal.proposalId}`,
            proposalId: proposal.proposalId,
            proposedByText: proposedBy,
            title: proposalTitle(proposal.action),
            detail: `${proposalDetail(proposal.action)} · ${remainingSeconds(
              proposal.expiresAtServerMs,
              nowMs,
            )} 秒内有效`,
            tone: "warning" as const,
            trailingActions: [
              viewAction({
                key: `media-group:${group.playbackGroupId}:proposal:${proposal.proposalId}:approve`,
                label: "同意",
                accessibleText: `同意 ${proposedBy} 的${proposalTitle(proposal.action)}`,
                intent: {
                  type: "DECIDE_PROPOSAL",
                  playbackGroupId: group.playbackGroupId,
                  proposalId: proposal.proposalId,
                  decision: "APPROVE",
                },
                disabledReason: decisionDisabledReason,
              }),
              viewAction({
                key: `media-group:${group.playbackGroupId}:proposal:${proposal.proposalId}:reject`,
                label: "拒绝",
                accessibleText: `拒绝 ${proposedBy} 的${proposalTitle(proposal.action)}`,
                intent: {
                  type: "DECIDE_PROPOSAL",
                  playbackGroupId: group.playbackGroupId,
                  proposalId: proposal.proposalId,
                  decision: "REJECT",
                },
                disabledReason: decisionDisabledReason,
                tone: "danger",
              }),
            ],
          };
        })
    : [];
  const status = statusView(group, nowMs);
  const trailingActions = groupActions(group, media, alignDisabledReason, joinDisabledReason);
  const detailParts = [
    status.text,
    target?.pageTitle,
    target?.providerText,
    target?.progressText,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return {
    key: `media-group:${group.playbackGroupId}`,
    groupId: group.playbackGroupId,
    name: `播放组 ${group.playbackGroupId.slice(0, 8)}`,
    theme: themeFor(group.playbackGroupId),
    state: group.status,
    statusText: status.text,
    tone: status.tone,
    memberCount: members.length,
    recommended,
    progressSeconds: Math.floor(groupProgressMs(group, nowMs) / 1_000),
    isDefaultForUngroupedViewer:
      media.localMembership === null && defaultGroupId === group.playbackGroupId,
    badgeText: recommended ? "推荐" : "",
    target,
    detail: detailParts.join(" · "),
    members,
    proposals,
    trailingActions,
  };
}

function groupActions(
  group: PlaybackGroupSnapshot,
  media: MediaControllerStatus,
  alignDisabledReason: string | null,
  joinDisabledReason: string | null,
): MediaViewAction[] {
  const membership = media.localMembership;
  if (membership?.playbackGroupId === group.playbackGroupId) {
    if (!membership.activeDevice) {
      return [
        viewAction({
          key: `media-group:${group.playbackGroupId}:takeover`,
          label: "在此设备接管",
          accessibleText: `在此设备接管播放组 ${group.playbackGroupId.slice(0, 8)}`,
          intent: { type: "TAKEOVER_DEVICE", playbackGroupId: group.playbackGroupId },
          disabledReason: media.state === "OFFLINE" ? "媒体同步当前离线" : null,
        }),
      ];
    }
    if (membership.role === "LEADER") {
      return [
        viewAction({
          key: `media-group:${group.playbackGroupId}:close`,
          label: "关闭播放组",
          accessibleText: `关闭播放组 ${group.playbackGroupId.slice(0, 8)}`,
          intent: { type: "CLOSE_GROUP", playbackGroupId: group.playbackGroupId },
          disabledReason: media.state === "OFFLINE" ? "媒体同步当前离线" : null,
          tone: "danger",
        }),
      ];
    }
    return [
      viewAction({
        key: `media-group:${group.playbackGroupId}:leave`,
        label: "退出播放组",
        accessibleText: `退出播放组 ${group.playbackGroupId.slice(0, 8)}`,
        intent: { type: "LEAVE_GROUP", playbackGroupId: group.playbackGroupId },
        disabledReason: media.state === "OFFLINE" ? "媒体同步当前离线" : null,
      }),
    ];
  }
  return [
    viewAction({
      key: `media-group:${group.playbackGroupId}:align-once`,
      label: "对齐一次",
      accessibleText: `与播放组 ${group.playbackGroupId.slice(0, 8)} 对齐一次`,
      intent: { type: "ALIGN_ONCE", playbackGroupId: group.playbackGroupId },
      disabledReason: alignDisabledReason,
    }),
    viewAction({
      key: `media-group:${group.playbackGroupId}:join`,
      label: "加入播放组",
      accessibleText: `加入播放组 ${group.playbackGroupId.slice(0, 8)}`,
      intent: { type: "JOIN_GROUP", playbackGroupId: group.playbackGroupId },
      disabledReason: joinDisabledReason,
    }),
  ];
}

function outsideMembers(
  members: readonly ExtensionCollaborationMemberSummary[],
  groupedUserIds: ReadonlySet<string>,
  pageById: ReadonlyMap<string, ExtensionCollaborationPageSummary>,
  media: MediaControllerStatus | null,
): MediaMemberView[] {
  return members.flatMap((member) => {
    if (groupedUserIds.has(member.userId)) {
      return [];
    }
    const page = member.activePageIds
      .map((pageId) => pageById.get(pageId))
      .find((candidate) => candidate !== undefined);
    const navigation = media?.navigation.find(
      (candidate) =>
        candidate.userId === member.userId &&
        candidate.logicalTabId !== null &&
        candidate.logicalTabId === page?.pageId,
    );
    const jumpDisabledReason = !member.online
      ? "成员离线"
      : page === undefined
        ? "成员未在共享页面"
        : navigation?.canJump !== true
          ? "当前客户端未绑定该共享页面"
          : null;
    const detail = !member.online
      ? "离线"
      : page === undefined
        ? `在线 · 共享组外 · ${member.deviceCount} 台设备`
        : `正在查看 ${page.title} · ${page.domain}`;
    return [
      {
        key: `media-outside-member:${member.userId}`,
        userId: member.userId,
        displayName: member.displayName,
        role: "OUTSIDE" as const,
        roleText: member.roomRole === "OWNER" ? "房主" : "成员",
        online: member.online,
        pageId: page?.pageId ?? null,
        pageTitle: page?.title ?? null,
        detail,
        tone: member.online ? ("success" as const) : ("neutral" as const),
        primaryAction: viewAction({
          key: `media-outside-member:${member.userId}:jump`,
          label: "跳转",
          accessibleText: `跳转到 ${member.displayName} 当前页面`,
          intent: { type: "JUMP_TO_MEMBER", userId: member.userId },
          disabledReason: jumpDisabledReason,
        }),
        trailingActions: [],
      },
    ];
  });
}

function targetView(
  group: PlaybackGroupSnapshot,
  pageById: ReadonlyMap<string, ExtensionCollaborationPageSummary>,
  nowMs: number,
): MediaTargetView | null {
  const target = group.target;
  if (target === null) {
    return null;
  }
  const page = pageById.get(target.logicalTabId);
  return {
    pageId: target.logicalTabId,
    pageTitle: page?.title ?? "共享视频",
    domain: page?.domain ?? "",
    providerText: providerText(target.provider),
    progressText:
      group.observed === null
        ? `— / ${formatDuration(target.durationMs)}`
        : `${formatDuration(predictGroupPosition(group, nowMs))} / ${formatDuration(
            target.durationMs,
          )}`,
    frameText: target.frameKey === "top" ? "主页面媒体" : "子页面媒体",
  };
}

function memberDetail(
  page: ExtensionCollaborationPageSummary | undefined,
  logicalTabId: string | null,
  group: PlaybackGroupSnapshot,
  target: MediaTargetView | null,
  online: boolean,
): string {
  if (!online) {
    return "离线";
  }
  if (page === undefined || logicalTabId === null) {
    return "在线 · 未停留在共享页";
  }
  if (group.target?.logicalTabId === logicalTabId && target !== null) {
    return `${page.title} · ${target.providerText} · ${target.progressText}`;
  }
  return `正在查看 ${page.title} · ${page.domain}`;
}

function orderedMembers(group: PlaybackGroupSnapshot): PlaybackGroupSnapshot["members"] {
  return [...group.members].sort((left, right) => {
    const leftLeader =
      left.userId === group.leaderUserId && left.activeDeviceId === group.leaderDeviceId;
    const rightLeader =
      right.userId === group.leaderUserId && right.activeDeviceId === group.leaderDeviceId;
    if (leftLeader !== rightLeader) {
      return leftLeader ? -1 : 1;
    }
    return (
      left.joinedAtServerMs - right.joinedAtServerMs || left.userId.localeCompare(right.userId)
    );
  });
}

function statusView(
  group: PlaybackGroupSnapshot,
  nowMs: number,
): { text: string; tone: MediaViewTone } {
  switch (group.status) {
    case "PLAYING":
      return { text: "播放中", tone: "success" };
    case "PAUSED":
      return { text: "已暂停", tone: "info" };
    case "ENDED_WAITING":
      return { text: "已结束，等待领播者切换", tone: "neutral" };
    case "LOADING":
      return { text: "正在加载", tone: "info" };
    case "LEADER_GRACE":
      return {
        text: `等待领播者恢复 · ${remainingSeconds(
          group.leaderGraceExpiresAtServerMs ?? nowMs,
          nowMs,
        )} 秒`,
        tone: "warning",
      };
    case "IDLE":
      return { text: "等待媒体", tone: "neutral" };
  }
}

function mediaNotice(media: MediaControllerStatus): MediaViewNotice | null {
  if (media.state === "OFFLINE") {
    return {
      tone: "warning",
      text: "媒体同步当前离线；共享标签页、成员位置和普通跳转仍可使用。",
    };
  }
  if (media.state !== "DEGRADED") {
    return null;
  }
  switch (media.errorCode) {
    case "AUTOPLAY_BLOCKED":
      return {
        tone: "warning",
        text: "浏览器阻止了自动播放；请在视频页面点击继续，播放组不会解散。",
      };
    case "MEDIA_LIVE_UNSUPPORTED":
      return {
        tone: "warning",
        text: "当前媒体是直播或不可定位流，仍可共享和跳转，但不能同步进度。",
      };
    case "MEDIA_DRM_UNSUPPORTED":
    case "MEDIA_NOT_SUPPORTED":
      return {
        tone: "warning",
        text: "当前媒体受保护或播放器不受支持，仍可共享和跳转，但不能同步播放。",
      };
    case "MEDIA_FRAME_UNAUTHORIZED":
    case "FRAME_DOCUMENT_URL_REQUIRED":
    case "MEDIA_PERMISSION_REQUIRED":
    case "ORIGIN_PERMISSION_REQUIRED":
    case "ORIGIN_PERMISSION_REVOKED":
      return {
        tone: "warning",
        text: "媒体所在的子页面未获授权；当前只能跳转，不能同步播放。",
      };
    case "MEDIA_METADATA_PENDING":
      return {
        tone: "info",
        text: "正在等待视频元数据；页面保持共享，媒体就绪后会自动恢复。",
      };
    default:
      return {
        tone: "warning",
        text: "媒体控制暂时降级；共享标签页和成员跳转仍可使用。",
      };
  }
}

function proposalTitle(action: PlaybackAction): string {
  switch (action.type) {
    case "PLAY":
      return "建议播放";
    case "PAUSE":
      return "建议暂停";
    case "SEEK":
      return "建议调整进度";
    case "SET_RATE":
      return "建议调整倍速";
    case "SWITCH_TARGET":
      return "建议切换媒体";
  }
}

function proposalDetail(action: PlaybackAction): string {
  switch (action.type) {
    case "PLAY":
      return "继续播放";
    case "PAUSE":
      return "暂停播放";
    case "SEEK":
      return `跳转到 ${formatDuration(action.positionMs)}`;
    case "SET_RATE":
      return `调整到 ${formatRate(action.playbackRate)} 倍速`;
    case "SWITCH_TARGET":
      return `切换到 ${providerText(action.target.provider)} 媒体`;
  }
}

function viewAction(input: {
  key: string;
  label: string;
  accessibleText: string;
  intent: MediaViewIntent;
  disabledReason: string | null;
  tone?: MediaViewTone;
}): MediaViewAction {
  return {
    key: input.key,
    label: input.label,
    accessibleText: input.accessibleText,
    intent: input.intent,
    tone: input.tone ?? "neutral",
    disabled: input.disabledReason !== null,
    disabledReason: input.disabledReason,
  };
}

function providerText(provider: "YOUTUBE" | "BILIBILI" | "HTML5"): string {
  switch (provider) {
    case "YOUTUBE":
      return "YouTube";
    case "BILIBILI":
      return "Bilibili";
    case "HTML5":
      return "网页视频";
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}

function formatRate(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(2).replace(/0+$/u, "");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function remainingSeconds(expiresAtServerMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((expiresAtServerMs - nowMs) / 1_000));
}

function groupProgressMs(group: PlaybackGroupSnapshot, nowMs: number): number {
  return group.target === null || group.observed === null ? 0 : predictGroupPosition(group, nowMs);
}

function themeFor(groupId: string): MediaGroupTheme {
  let hash = 2_166_136_261;
  for (const character of groupId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return themes[(hash >>> 0) % themes.length]!;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}
