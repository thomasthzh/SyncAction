import { signal } from "@preact/signals";
import { DeviceIdSchema, LogicalTabIdSchema, RoomIdSchema } from "@syncaction/protocol";
import type {
  UiCommandInput,
  UiCommandError,
  UiStore,
  UiTransportState,
} from "../src/ui-vnext/store.js";
import type { UiCommandResult, UiStateSlices } from "../src/ui/ui-protocol.js";

export type VisualFixture =
  | "lobby"
  | "room"
  | "guest"
  | "room-unshared"
  | "room-leader"
  | "room-leader-unshared"
  | "journey"
  | "room-journey"
  | "room-continuity";

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
    baseUrl: "https://demo.syncaction.example",
    mode: "VNEXT" as const,
    metadata: {
      serverId: uuid(500),
      displayName: "SyncAction 示例",
      softwareVersion: "0.9.9",
      protocolVersion: "1",
      minimumClientVersion: "0.8.1",
      termsVersion: "2026-07-30",
      capabilities: [
        "public-rooms",
        "join-requests",
        "notifications",
        "volatile-pointer-v2",
        "content-compatibility-v1",
        "account-activation-v1",
        "account-key-login-v1",
      ],
      limits: { ordinaryActiveRooms: 5, ordinaryOpenTabs: 20 },
    },
    lastHealthyAt: FIXTURE_NOW_MS,
  },
];

const account = {
  id: userIds[0]!,
  username: "thomas",
  displayName: "Thomas",
  status: "ACTIVE" as const,
  passwordResetRequired: false,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const members = userIds.map((userId, index) => ({
  userId,
  username: `member-${index + 1}`,
  displayName: index === 0 ? "Thomas" : index === 1 ? "林岚" : `成员 ${index + 1}`,
  role: index === 0 ? ("OWNER" as const) : ("MEMBER" as const),
  joinedAt: "2026-08-01T00:00:00.000Z",
}));

const pages = pageIds.map((pageId, index) => ({
  pageId,
  title:
    index === 0
      ? "Tina 专业文章：退休资金分层"
      : index === 1
        ? "发布会回放 · 产品路线"
        : `协作资料 ${String(index + 1).padStart(2, "0")}`,
  domain: index === 0 ? "docs.example" : index === 1 ? "video.example" : `docs-${index}.example`,
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
        roomSummary(alternateRoomId, "Tina 视觉评审", "MEMBER"),
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
      logicalTabId: pageIds[0]!,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
      contentCompatibility: "EXACT",
      origin: "https://docs.example",
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
  const slices = fixture.startsWith("room") ? roomSlices() : lobbySlices();
  if (fixture.startsWith("room-leader")) {
    const runtime = slices.room.runtime!;
    const media = runtime.media!;
    slices.room = {
      ...slices.room,
      runtime: {
        ...runtime,
        media: {
          ...media,
          state: "DEGRADED",
          errorCode: "STALE_MEDIA_CONTEXT",
          localMembership: {
            playbackGroupId: media.playbackGroups[0]!.playbackGroupId,
            role: "LEADER",
            activeDevice: true,
          },
        },
      },
    };
    if (fixture === "room-leader-unshared")
      slices.pageAccess = { ...slices.pageAccess, documentRevision: null };
  }
  if (fixture === "room-unshared") {
    slices.pageAccess = {
      ...slices.pageAccess,
      documentRevision: null,
      contentCompatibility: null,
      enabledFeatures: [],
      reason: "ROOM_DOCUMENT_UNAVAILABLE",
    };
  }
  if (fixture === "room-continuity") {
    slices.collaboration.pages = slices.collaboration.pages.slice(0, 3);
    slices.collaboration.capacity = { ...slices.collaboration.capacity, openTabCount: 3 };
    slices.collaboration.members = slices.collaboration.members.map((member) => ({
      ...member,
      activePageIds: member.activePageIds.filter((id) =>
        slices.collaboration.pages.some((page) => page.pageId === id),
      ),
    }));
    const runtime = slices.room.runtime!;
    slices.room = {
      ...slices.room,
      runtime: {
        ...runtime,
        sharedTabCount: 3,
        media: { ...runtime.media!, playbackGroups: [], localMembership: null },
        browser: {
          ...runtime.browser!,
          pendingPublications: [
            { tabId: 84, logicalTabId: pageIds[0]! },
            { tabId: 85, logicalTabId: pageIds[1]! },
            { tabId: 86, logicalTabId: LogicalTabIdSchema.parse(uuid(999)) },
          ],
        },
      },
    };
    slices.collaboration.members[1] = {
      ...slices.collaboration.members[1]!,
      activePageIds: [pageIds[0]!, pageIds[1]!],
      deviceCount: 2,
    };
  }
  if (fixture === "guest") {
    slices.shell = { ...slices.shell, phase: "SIGNED_OUT", account: null };
    slices.discovery = { ...slices.discovery, rooms: [], invitations: [] };
  }
  return new VisualUiStore(
    slices,
    fixture === "room-unshared",
    fixture === "journey" || fixture === "room-journey" || fixture === "room-continuity",
  );
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
  private requestedRoom: UiStateSlices["discovery"]["publicRooms"][number] | undefined;
  private nextLocalPage = 950;

  public constructor(
    state: UiStateSlices,
    private readonly pageToolFixture = false,
    private readonly journeyFixture = false,
  ) {
    this.shell = signal(state.shell);
    this.discovery = signal(state.discovery);
    this.room = signal(state.room);
    this.collaboration = signal(state.collaboration);
    this.notifications = signal(state.notifications);
    this.pageAccess = signal(state.pageAccess);
  }

  public command(_command: UiCommandInput): Promise<UiCommandResult> {
    const done = (value?: unknown): Promise<UiCommandResult> =>
      Promise.resolve({
        type: "ui.command.result",
        commandId: uuid(900),
        ok: true,
        ...(value === undefined ? {} : { value }),
      });
    if (this.journeyFixture) {
      if (_command.name === "LOCAL_PAGE_ACTIVATE") {
        this.pageAccess.value = {
          ...this.pageAccess.value,
          tabId: _command.payload.tabId,
          logicalTabId: null,
          documentRevision: null,
          pendingPublication: { logicalTabId: _command.payload.logicalTabId },
          origin: "https://video.example",
          url: `https://video.example/candidate/${_command.payload.tabId}`,
        };
      }
      if (
        (_command.name === "CURRENT_TAB_SHARE" || _command.name === "CURRENT_TAB_SHARE_AS_NEW") &&
        this.pageAccess.value.pendingPublication != null
      ) {
        const access = this.pageAccess.value;
        const logicalTabId = LogicalTabIdSchema.parse(
          _command.name === "CURRENT_TAB_SHARE_AS_NEW"
            ? uuid(this.nextLocalPage++)
            : access.pendingPublication!.logicalTabId,
        );
        const runtime = this.room.value.runtime!;
        this.room.value = {
          ...this.room.value,
          runtime: {
            ...runtime,
            browser: {
              ...runtime.browser!,
              pendingPublications: runtime.browser!.pendingPublications!.filter(
                (item) => item.tabId !== access.tabId,
              ),
            },
          },
        };
        this.pageAccess.value = {
          ...access,
          logicalTabId,
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 43 },
          pendingPublication: null,
        };
        this.collaboration.value = {
          ...this.collaboration.value,
          pages: [
            ...this.collaboration.value.pages.filter((page) => page.pageId !== logicalTabId),
            {
              pageId: logicalTabId,
              title: "刚刚分享的共同片段",
              domain: "video.example",
              state: "OPEN",
              compatibility: "EXACT",
            },
          ],
          capacity: {
            ...this.collaboration.value.capacity,
            openTabCount:
              this.collaboration.value.capacity.openTabCount +
              (_command.name === "CURRENT_TAB_SHARE_AS_NEW" ? 1 : 0),
          },
        };
        return done({
          kind: "INTENT_RECORDED",
          operation: {
            type: _command.name === "CURRENT_TAB_SHARE_AS_NEW" ? "tab.create" : "tab.navigate",
          },
          sharedPageContext: { tabId: access.tabId, url: access.url },
        });
      }
      if (_command.name === "ROOM_JOIN_REQUEST") {
        this.requestedRoom = this.discovery.value.publicRooms.find(
          (room) => room.roomId === _command.payload.roomId,
        );
        return done({
          requestId: uuid(901),
          roomId: _command.payload.roomId,
          applicant: {
            userId: account.id,
            username: account.username,
            displayName: account.displayName,
          },
          status: "PENDING",
          createdAt: "2026-11-13T00:00:00.000Z",
          decidedAt: null,
        });
      }
      if (
        _command.name === "PRODUCT_REFRESH" &&
        this.requestedRoom !== undefined &&
        !this.discovery.value.rooms.some((room) => room.id === this.requestedRoom!.roomId)
      )
        this.discovery.value = {
          ...this.discovery.value,
          rooms: [
            ...this.discovery.value.rooms,
            roomSummary(this.requestedRoom.roomId, this.requestedRoom.name, "MEMBER"),
          ],
        };
      if (_command.name === "ROOM_JOIN_CANCEL") this.requestedRoom = undefined;
      if (_command.name === "ROOM_SELECT") {
        const next = roomSlices();
        const selected = this.discovery.value.rooms.find(
          (room) => room.id === _command.payload.roomId,
        );
        this.shell.value = { ...this.shell.value, phase: "ROOM_ACTIVE" };
        this.room.value = {
          ...next.room,
          selectedRoomId: _command.payload.roomId,
          detail: {
            ...next.room.detail!,
            id: _command.payload.roomId,
            name: selected?.name ?? next.room.detail!.name,
            role: selected?.role ?? "MEMBER",
          },
          runtime: {
            ...next.room.runtime!,
            roomName: selected?.name ?? next.room.runtime!.roomName,
            media: {
              ...next.room.runtime!.media!,
              playbackGroups: next.room.runtime!.media!.playbackGroups.map((group) => ({
                ...group,
                roomId: _command.payload.roomId,
              })),
            },
          },
        };
        this.collaboration.value = next.collaboration;
        this.pageAccess.value = next.pageAccess;
      }
      if (_command.name === "ROOM_TAB_ACTIVATE") {
        const group = this.room.value.runtime?.media?.playbackGroups.find(
          (group) => group.target?.logicalTabId === _command.payload.logicalTabId,
        );
        if (group?.target != null)
          this.pageAccess.value = {
            ...this.pageAccess.value,
            tabId: 42,
            logicalTabId: group.target.logicalTabId,
            documentRevision: group.target.documentRevision,
          };
        else if (
          this.collaboration.value.pages.some(
            (page) => page.pageId === _command.payload.logicalTabId,
          )
        )
          this.pageAccess.value = {
            ...this.pageAccess.value,
            tabId: 42,
            logicalTabId: _command.payload.logicalTabId,
            documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
            pendingPublication: null,
          };
      }
      if (_command.name === "MEDIA_GROUP_PREPARE") {
        const runtime = this.room.value.runtime!;
        const group = runtime.media!.playbackGroups.find(
          (group) => group.playbackGroupId === _command.payload.playbackGroupId,
        )!;
        this.room.value = {
          ...this.room.value,
          runtime: {
            ...runtime,
            media: {
              ...runtime.media!,
              localObservation: { target: group.target!, observed: group.observed! },
            },
          },
        };
      }
      if (_command.name === "MEDIA_GROUP_JOIN") {
        const runtime = this.room.value.runtime!;
        this.room.value = {
          ...this.room.value,
          runtime: {
            ...runtime,
            media: {
              ...runtime.media!,
              controlReady: true,
              localMembership: {
                playbackGroupId: _command.payload.playbackGroupId,
                role: "FOLLOWER",
                activeDevice: true,
              },
            },
          },
        };
      }
      if (_command.name === "DIRECTORY_SEARCH")
        return done({
          items: [1, 2].map((index) => ({
            userId: uuid(910 + index),
            username: `friend${index}`,
            displayName: index === 1 ? "小林" : "小周",
            online: true,
          })),
          nextCursor: null,
        });
      if (_command.name === "INVITE_BATCH")
        return done(
          _command.payload.userIds.map((userId, index) => ({
            userId,
            status: index === 0 ? "CREATED" : "FORBIDDEN",
            invitationId: index === 0 ? uuid(930) : null,
          })),
        );
      if (_command.name === "BROWSER_RECOVERY_CONFIRM")
        return done({ kind: "BLOCKED", reason: "STALE_BINDINGS", effectsApplied: 0 });
    }
    if (this.pageToolFixture && _command.name === "CURRENT_TAB_SHARE") {
      return Promise.resolve({
        type: "ui.command.result",
        commandId: uuid(900),
        ok: true,
        value: {
          kind: "INTENT_RECORDED",
          sharedPageContext: { tabId: 42, url: "https://docs.example/article" },
        },
      });
    }
    if (this.pageToolFixture && _command.name === "PAGE_PERMISSION_REFRESH") {
      this.pageAccess.value = {
        ...this.pageAccess.value,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 12 },
        contentCompatibility: "EXACT",
        enabledFeatures: ["POINTER", "DANMAKU", "DRAWING", "MEDIA_CONTROL"],
        reason: null,
      };
    }
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
