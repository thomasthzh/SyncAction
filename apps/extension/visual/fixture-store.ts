import { signal } from "@preact/signals";
import { DeviceIdSchema, LogicalTabIdSchema, RoomIdSchema } from "@syncaction/protocol";
import type {
  UiCommandInput,
  UiCommandError,
  UiStore,
  UiTransportState,
} from "../src/ui-vnext/store.js";
import type { UiCommandResult, UiStateSlices } from "../src/ui/ui-protocol.js";

export type VisualFixture = "lobby" | "room";

export const FIXTURE_NOW_MS = Date.parse("2026-08-24T08:00:00.000Z");

const roomId = RoomIdSchema.parse(uuid(1));
const alternateRoomId = RoomIdSchema.parse(uuid(2));
const userIds = Array.from({ length: 20 }, (_, index) => uuid(100 + index));
const pageIds = Array.from({ length: 20 }, (_, index) =>
  LogicalTabIdSchema.parse(uuid(200 + index)),
);
const deviceIds = Array.from({ length: 20 }, (_, index) => DeviceIdSchema.parse(uuid(300 + index)));
const playbackGroupIds = [uuid(400), uuid(401)] as const;

const profiles = [
  {
    profileId: "syncaction-production",
    baseUrl: "https://syncaction.example.com",
    mode: "VNEXT" as const,
    metadata: {
      serverId: uuid(500),
      displayName: "SyncAction 演示节点",
      softwareVersion: "0.9.5",
      protocolVersion: "1",
      minimumClientVersion: "0.8.1",
      termsVersion: "2026-07-30",
      capabilities: [
        "public-rooms",
        "join-requests",
        "notifications",
        "volatile-pointer-v2",
        "content-compatibility-v1",
      ],
      limits: { ordinaryActiveRooms: 5, ordinaryOpenTabs: 20 },
    },
    lastHealthyAt: FIXTURE_NOW_MS,
  },
];

const account = {
  id: userIds[0]!,
  username: "demo",
  displayName: "示例用户",
  status: "ACTIVE" as const,
  passwordResetRequired: false,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const members = userIds.map((userId, index) => ({
  userId,
  username: `member-${index + 1}`,
  displayName: index === 0 ? "示例用户" : index === 1 ? "林岚" : `成员 ${index + 1}`,
  role: index === 0 ? ("OWNER" as const) : ("MEMBER" as const),
  joinedAt: "2026-08-01T00:00:00.000Z",
}));

const pages = pageIds.map((pageId, index) => ({
  pageId,
  title:
    index === 0
      ? "示例文章：团队协作"
      : index === 1
        ? "发布会回放 · 产品路线"
        : `协作资料 ${String(index + 1).padStart(2, "0")}`,
  domain:
    index === 0 ? "portal.example.com" : index === 1 ? "video.example" : `docs-${index}.example`,
  state: "OPEN" as const,
  compatibility: "EXACT" as const,
}));

const collaborationMembers = members.map((member, index) => ({
  userId: member.userId,
  displayName: member.displayName,
  roomRole: member.role,
  online: index < 14,
  deviceCount: index < 14 ? 1 : 0,
  activePageIds: index < 8 ? [pageIds[0]!] : index < 14 ? [pageIds[index - 7]!] : [],
}));

function playbackGroup(groupIndex: number, start: number, count: number, positionMs: number) {
  const groupMembers = members.slice(start, start + count);
  return {
    playbackGroupId: playbackGroupIds[groupIndex]!,
    roomId,
    groupRevision: 3,
    status: "PLAYING" as const,
    leaderUserId: groupMembers[0]!.userId,
    leaderDeviceId: deviceIds[start]!,
    members: groupMembers.map((member, memberIndex) => ({
      userId: member.userId,
      username: member.username,
      displayName: member.displayName,
      activeDeviceId: deviceIds[start + memberIndex]!,
      joinedAtServerMs: FIXTURE_NOW_MS - (count - memberIndex) * 1_000,
      online: true,
    })),
    target: {
      logicalTabId: pageIds[groupIndex]!,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 + groupIndex },
      frameKey: "top",
      provider: groupIndex === 0 ? ("YOUTUBE" as const) : ("HTML5" as const),
      mediaKey: groupIndex === 0 ? "youtube:syncaction-demo" : "html:video-1",
      durationMs: 600_000,
    },
    observed: {
      observedAtClientMs: FIXTURE_NOW_MS - 700,
      positionMs,
      paused: false,
      playbackRate: 1,
      ended: false,
      buffering: false,
    },
    observedAtServerMs: FIXTURE_NOW_MS - 500,
    proposals: [],
    leaderGraceExpiresAtServerMs: null,
    updatedAtServerMs: FIXTURE_NOW_MS - 500,
  };
}

function lobbySlices(): UiStateSlices {
  return {
    shell: {
      phase: "AUTHENTICATED_NO_ROOM",
      account,
      profiles,
      selectedProfileId: profiles[0]!.profileId,
      onboardingRequired: false,
      errorCode: null,
    },
    discovery: {
      publicRooms: [
        {
          roomId: RoomIdSchema.parse(uuid(610)),
          name: "公开客厅 · 产品讨论",
          joinPolicy: "OPEN",
          onlineCount: 8,
          memberCount: 12,
          openTabCount: 9,
          hasActivePlayback: true,
          updatedAt: "2026-08-24T07:59:00.000Z",
        },
        {
          roomId: RoomIdSchema.parse(uuid(611)),
          name: "周末观影",
          joinPolicy: "APPROVAL",
          onlineCount: 5,
          memberCount: 9,
          openTabCount: 4,
          hasActivePlayback: true,
          updatedAt: "2026-08-24T07:58:00.000Z",
        },
        {
          roomId: RoomIdSchema.parse(uuid(612)),
          name: "设计资料室",
          joinPolicy: "INVITE_ONLY",
          onlineCount: 2,
          memberCount: 6,
          openTabCount: 12,
          hasActivePlayback: false,
          updatedAt: "2026-08-24T07:57:00.000Z",
        },
      ],
      rooms: [
        roomSummary(roomId, "联合研究室", "OWNER"),
        roomSummary(alternateRoomId, "界面评审", "MEMBER"),
      ],
      invitations: [],
    },
    room: { selectedRoomId: null, detail: null, runtime: null },
    collaboration: emptyCollaboration(),
    notifications: { items: [], unreadCount: 2, cursor: 2 },
    pageAccess: emptyPageAccess(),
  };
}

function roomSlices(): UiStateSlices {
  const base = lobbySlices();
  const groups = [playbackGroup(0, 0, 8, 204_000), playbackGroup(1, 8, 5, 338_000)];
  return {
    ...base,
    shell: { ...base.shell, phase: "ROOM_ACTIVE" },
    room: {
      selectedRoomId: roomId,
      detail: {
        ...roomSummary(roomId, "联合研究室", "OWNER"),
        members,
        pendingInvitations: [],
      },
      runtime: {
        state: "SYNCED",
        roomName: "联合研究室",
        serverSeq: 42,
        sharedTabCount: 20,
        outboxCount: 0,
        pendingConfirmationCount: 0,
        bindingCount: 20,
        browser: {
          state: "SYNCHRONIZED",
          reason: null,
          missingTabCount: 0,
          effectsApplied: 20,
        },
        presence: {
          state: "ONLINE",
          presences: [],
          lastAckExpiresAt: FIXTURE_NOW_MS + 10_000,
          errorCode: null,
        },
        pointer: {
          state: "ONLINE",
          lastAckExpiresAt: FIXTURE_NOW_MS + 10_000,
          errorCode: null,
        },
        media: {
          state: "ONLINE",
          roomMediaRevision: 42,
          playbackGroups: groups,
          localObservation: null,
          localMembership: null,
          recommendedPlaybackGroupId: groups[0]!.playbackGroupId,
          navigation: collaborationMembers
            .filter(({ online }) => online)
            .map((member, index) => ({
              userId: member.userId,
              deviceId: deviceIds[index]!,
              logicalTabId: member.activePageIds[0] ?? pageIds[0]!,
              canJump: true,
              disabledReason: null,
            })),
          errorCode: null,
        },
        danmaku: null,
        drawing: null,
        tabs: pages.map((page) => ({
          logicalTabId: page.pageId,
          title: page.title,
          domain: page.domain,
        })),
      },
    },
    collaboration: {
      capacity: { openTabCount: 20, limit: 20, exemption: "NOT_EXEMPT" },
      navigation: { canJump: true, disabledReason: null },
      pages,
      members: collaborationMembers,
      playbackGroups: [],
      tools: [],
      proposals: [],
      annotation: {
        used: 18,
        capacity: 2_000,
        lockedCount: 2,
        state: "AVAILABLE",
        canCreate: true,
        disabledReason: null,
      },
      activities: [],
    },
    pageAccess: {
      bindings: null,
      tabId: 42,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
      contentCompatibility: "EXACT",
      origin: "https://portal.example.com",
      supported: true,
      browserPermissionGranted: true,
      termsAccepted: true,
      serverTermsVersion: "2026-07-30",
      disclosureVersion: 1,
      enabledFeatures: ["POINTER", "DANMAKU", "DRAWING", "MEDIA_CONTROL"],
      policySyncPendingCount: 0,
      reason: null,
    },
  };
}

export function createVisualStore(fixture: VisualFixture): UiStore {
  return new VisualUiStore(fixture === "room" ? roomSlices() : lobbySlices());
}

class VisualUiStore implements UiStore {
  public readonly versions = signal({
    shell: 1,
    discovery: 1,
    room: 1,
    collaboration: 1,
    notifications: 1,
    pageAccess: 1,
  });
  public readonly transport = signal<UiTransportState>("CONNECTED");
  public readonly shell;
  public readonly discovery;
  public readonly room;
  public readonly collaboration;
  public readonly notifications;
  public readonly pageAccess;
  public readonly pendingCommands = signal<ReadonlySet<string>>(new Set());
  public readonly commandError = signal<UiCommandError | null>(null);

  public constructor(state: UiStateSlices) {
    this.shell = signal(state.shell);
    this.discovery = signal(state.discovery);
    this.room = signal(state.room);
    this.collaboration = signal(state.collaboration);
    this.notifications = signal(state.notifications);
    this.pageAccess = signal(state.pageAccess);
  }

  public command(_command: UiCommandInput): Promise<UiCommandResult> {
    void _command;
    return Promise.resolve({
      type: "ui.command.result",
      commandId: uuid(900),
      ok: true,
    });
  }

  public dispose(): void {}
}

function roomSummary(
  id: UiStateSlices["discovery"]["rooms"][number]["id"],
  name: string,
  role: "OWNER" | "MEMBER",
) {
  return {
    id,
    name,
    role,
    roomEpoch: 0,
    visibility: "PUBLIC" as const,
    joinPolicy: "APPROVAL" as const,
    roomRevision: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-24T07:59:00.000Z",
  };
}

function emptyCollaboration(): UiStateSlices["collaboration"] {
  return {
    capacity: { openTabCount: 0, limit: 20, exemption: "NOT_EXEMPT" },
    navigation: { canJump: false, disabledReason: "ROOM_NOT_SELECTED" },
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
  };
}

function emptyPageAccess(): UiStateSlices["pageAccess"] {
  return {
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
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
