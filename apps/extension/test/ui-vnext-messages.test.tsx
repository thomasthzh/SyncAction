// @vitest-environment happy-dom

import {
  CanonicalUuidSchema,
  NotificationSchema,
  RoomIdSchema,
  type DirectoryUser,
  type Notification,
  type NotificationType,
} from "@syncaction/protocol";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { foldNotificationThreads } from "../src/ui-vnext/components/message-center.js";
import { UiDiscoverySliceSchema, UiRoomSliceSchema } from "../src/ui/ui-protocol.js";
import {
  TestUiStore,
  byRole,
  click,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

const roomId = RoomIdSchema.parse("00000000-0000-4000-8000-000000000601");
const ownerId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000602");
const newOwnerId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000603");
const applicantId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000604");
const memberId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000605");
const invitedId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000606");
const candidateId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000607");
const requestId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000611");
const invitationId = CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000612");

afterEach(() => {
  vi.useRealTimers();
  unmountPanel();
});

describe("vNext message center", () => {
  it("derives one local policy-sync item from page access without forging a server notification", async () => {
    const store = messageStore();
    store.pageAccess.value = {
      ...store.pageAccess.value,
      policySyncPendingCount: 3,
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "消息"));

    expect(root.textContent).toContain("页面授权记录待同步");
    expect(root.textContent).toContain("3 个站点");
    expect(root.querySelectorAll("[data-local-policy-sync]")).toHaveLength(1);
    expect(root.querySelectorAll("[data-message-card]")).toHaveLength(0);

    await click(byRole(root, "button", "重试同步页面授权记录"));
    expect(store.commandCalls.at(-1)).toEqual({ name: "POLICY_ACCEPTANCE_RECORD" });
  });

  it("caps the header badge at 99+ and never marks messages read merely by opening", async () => {
    const store = messageStore();
    store.notifications.value = {
      items: [systemNotification(1)],
      unreadCount: 123,
      cursor: 1,
    };
    const root = renderPanel(<App store={store} />);

    expect(root.textContent).toContain("99+");
    await click(byRole(root, "button", "消息"));

    expect(root.textContent).toContain("消息中心");
    expect(root.textContent).toContain("SyncAction 0.9.0");
    expect(store.commandCalls).toHaveLength(0);
  });

  it("groups unread first and renders every structured notification variant as text", async () => {
    const store = messageStore();
    store.notifications.value = {
      items: [
        notification("ROOM_MEMBER_REMOVED", 1, { readAt: "2026-07-30T01:00:00.000Z" }),
        notification("ROOM_OWNERSHIP_TRANSFERRED", 2),
        notification("ROOM_DISSOLVED", 3),
        notification("ROOM_JOIN_REQUEST_CANCELLED", 4, {
          requestId,
          decision: "CANCELLED",
        }),
        notification("ROOM_JOIN_REQUEST_APPROVED", 5, {
          requestId: CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000613"),
          decision: "APPROVED",
        }),
        notification("ROOM_JOIN_REQUEST_REJECTED", 6, {
          requestId: CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000614"),
          decision: "REJECTED",
        }),
        notification("ROOM_INVITATION_CREATED", 7, { invitationId }),
        systemNotification(8),
        systemAnnouncement(9),
      ],
      unreadCount: 8,
      cursor: 9,
    };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "消息"));

    const copy = root.textContent ?? "";
    expect(copy).toContain("成员变更");
    expect(copy).toContain("房主已变更");
    expect(copy).toContain("房间已解散");
    expect(copy).toContain("加入申请已取消");
    expect(copy).toContain("加入申请已通过");
    expect(copy).toContain("加入申请已拒绝");
    expect(copy).toContain("邀请加入");
    expect(copy).toContain("SyncAction 0.9.0");
    expect(copy).toContain("维护通知");
    const cards = [...root.querySelectorAll<HTMLElement>("[data-message-card]")];
    expect(cards[0]?.dataset.unread).toBe("true");
    expect(cards.at(-1)?.dataset.unread).toBe("false");
  });

  it("marks one durable item or all items read only on explicit action", async () => {
    const store = messageStore();
    const system = systemNotification(1);
    store.notifications.value = { items: [system], unreadCount: 1, cursor: 1 };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "消息"));

    await click(byRole(root, "button", "阅读 SyncAction 0.9.0"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "NOTIFICATION_READ",
      payload: { notificationId: system.notificationId },
    });
    await click(byRole(root, "button", "全部已读"));
    expect(store.commandCalls.at(-1)).toEqual({ name: "NOTIFICATIONS_READ_ALL" });
  });

  it("keeps join requests actionable only for the room's current owner", async () => {
    const store = messageStore();
    store.notifications.value = {
      items: [notification("ROOM_JOIN_REQUEST_CREATED", 1, { requestId })],
      unreadCount: 1,
      cursor: 1,
    };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "消息"));

    await click(byRole(root, "button", "同意申请"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "JOIN_REQUEST_DECIDE",
      payload: { requestId, decision: "APPROVE" },
    });
    await click(byRole(root, "button", "拒绝申请"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "JOIN_REQUEST_DECIDE",
      payload: { requestId, decision: "REJECT" },
    });

    act(() => {
      store.update({
        discovery: UiDiscoverySliceSchema.parse({
          ...store.discovery.value,
          rooms: [{ ...store.discovery.value.rooms[0]!, role: "MEMBER" }],
        }),
      });
    });
    expect(root.textContent).not.toContain("同意申请");

    act(() => {
      store.update({
        shell: {
          ...store.shell.value,
          account: {
            ...store.shell.value.account!,
            id: newOwnerId,
            username: "new-owner",
            displayName: "新房主",
          },
        },
        discovery: UiDiscoverySliceSchema.parse({
          ...store.discovery.value,
          rooms: [{ ...store.discovery.value.rooms[0]!, role: "OWNER" }],
        }),
      });
    });
    expect(root.textContent).toContain("同意申请");
  });

  it("folds request creation and result into one final durable card across snapshots", async () => {
    const store = messageStore();
    const created = notification("ROOM_JOIN_REQUEST_CREATED", 1, { requestId });
    const approved = notification("ROOM_JOIN_REQUEST_APPROVED", 2, {
      requestId,
      decision: "APPROVED",
    });
    store.notifications.value = {
      items: [created, approved],
      unreadCount: 2,
      cursor: 2,
    };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "消息"));

    expect(foldNotificationThreads([created, approved])).toHaveLength(1);
    expect(root.querySelectorAll("[data-message-card]")).toHaveLength(1);
    expect(root.textContent).toContain("加入申请已通过");
    expect(root.textContent).not.toContain("同意申请");

    store.notifications.value = {
      items: structuredClone([created, approved]),
      unreadCount: 2,
      cursor: 2,
    };
    expect(root.querySelectorAll("[data-message-card]")).toHaveLength(1);
    expect(root.textContent).not.toContain("同意申请");
  });

  it("accepts only an invitation that remains authoritative and folds revocation as history", async () => {
    const store = messageStore();
    const created = notification("ROOM_INVITATION_CREATED", 1, { invitationId });
    store.notifications.value = { items: [created], unreadCount: 1, cursor: 1 };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "消息"));

    await click(byRole(root, "button", "接受邀请"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "INVITATION_ACCEPT",
      payload: { invitationId },
    });

    const revoked = notification("ROOM_INVITATION_REVOKED", 2, { invitationId });
    act(() => {
      store.update({
        discovery: UiDiscoverySliceSchema.parse({
          ...store.discovery.value,
          invitations: [],
        }),
        notifications: {
          items: [created, revoked],
          unreadCount: 2,
          cursor: 2,
        },
      });
    });
    expect(root.querySelectorAll("[data-message-card]")).toHaveLength(1);
    expect(root.textContent).toContain("邀请已撤回");
    expect(root.textContent).not.toContain("接受邀请");
  });

  it("searches accounts, explains disabled choices, preserves selection, and batches IDs", async () => {
    vi.useFakeTimers();
    const store = messageStore();
    const directory: DirectoryUser[] = [
      directoryUser(ownerId, "owner", "当前用户"),
      directoryUser(memberId, "member", "已有成员"),
      directoryUser(invitedId, "invited", "已邀请用户"),
      directoryUser(candidateId, "candidate", "可邀请用户"),
    ];
    store.responder = async (command) =>
      command.name === "DIRECTORY_SEARCH"
        ? success({ items: directory, nextCursor: null })
        : success();
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "消息"));
    await click(byRole(root, "button", "邀请成员"));

    expect(root.querySelector('input[name="username"]')).toBeNull();
    const search = root.querySelector<HTMLInputElement>('input[name="directorySearch"]')!;
    input(search, "a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(store.commandCalls).toHaveLength(0);
    input(search, "al");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(store.commandCalls.at(-1)).toEqual({
      name: "DIRECTORY_SEARCH",
      payload: { roomId, query: "al", cursor: null, limit: 20 },
    });
    expect(root.textContent).toContain("这是你自己");
    expect(root.textContent).toContain("已经是房间成员");
    expect(root.textContent).toContain("已有待处理邀请");
    const candidate = root.querySelector<HTMLInputElement>(
      `input[type="checkbox"][value="${candidateId}"]`,
    )!;
    await click(candidate);

    input(search, "ali");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(candidate.checked).toBe(true);
    await click(byRole(root, "button", "发送邀请"));
    expect(store.commandCalls.at(-1)).toEqual({
      name: "INVITE_BATCH",
      payload: { userIds: [candidateId] },
    });
  });

  it("ignores an older directory response after a newer query has completed", async () => {
    vi.useFakeTimers();
    const store = messageStore();
    const first = deferred<ReturnType<typeof success>>();
    const second = deferred<ReturnType<typeof success>>();
    let searchCount = 0;
    store.responder = async (command) => {
      if (command.name !== "DIRECTORY_SEARCH") {
        return success();
      }
      searchCount += 1;
      return searchCount === 1 ? first.promise : second.promise;
    };
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "消息"));
    await click(byRole(root, "button", "邀请成员"));
    const search = root.querySelector<HTMLInputElement>('input[name="directorySearch"]')!;

    input(search, "al");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    input(search, "ali");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => {
      second.resolve(
        success({
          items: [directoryUser(candidateId, "candidate", "最新结果")],
          nextCursor: null,
        }),
      );
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
    });
    expect(root.textContent).toContain("最新结果");

    await act(async () => {
      first.resolve(
        success({
          items: [directoryUser(invitedId, "old", "过期结果")],
          nextCursor: null,
        }),
      );
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
    });
    expect(root.textContent).toContain("最新结果");
    expect(root.textContent).not.toContain("过期结果");
  });
});

function messageStore(): TestUiStore {
  const store = new TestUiStore();
  const room = roomSummary();
  store.update({
    shell: {
      ...store.shell.value,
      phase: "ROOM_ACTIVE",
      account: {
        id: ownerId,
        username: "owner",
        displayName: "房主",
        status: "ACTIVE",
        passwordResetRequired: false,
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    },
    discovery: UiDiscoverySliceSchema.parse({
      ...store.discovery.value,
      rooms: [room],
      invitations: [
        {
          id: invitationId,
          roomId,
          roomName: room.name,
          invitedByUserId: newOwnerId,
          invitedByUsername: "new-owner",
          expiresAt: "2026-08-01T00:00:00.000Z",
          createdAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    }),
    room: UiRoomSliceSchema.parse({
      selectedRoomId: roomId,
      detail: {
        ...room,
        members: [
          roomMember(ownerId, "owner", "房主", "OWNER"),
          roomMember(memberId, "member", "已有成员", "MEMBER"),
        ],
        pendingInvitations: [
          {
            id: CanonicalUuidSchema.parse("00000000-0000-4000-8000-000000000621"),
            invitedUserId: invitedId,
            username: "invited",
            displayName: "已邀请用户",
            status: "PENDING",
            expiresAt: "2026-08-01T00:00:00.000Z",
            createdAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      },
      runtime: null,
    }),
  });
  return store;
}

function notification(
  type: NotificationType,
  cursor: number,
  overrides: Partial<Notification> = {},
): Notification {
  const requestType = type.startsWith("ROOM_JOIN_REQUEST_");
  const invitationType = type.startsWith("ROOM_INVITATION_");
  return NotificationSchema.parse({
    notificationId: `00000000-0000-4000-8000-${String(700 + cursor).padStart(12, "0")}`,
    cursor,
    type,
    actor: {
      userId: applicantId,
      displayName: "申请人",
    },
    room: { roomId, name: "联合研究室" },
    requestId: requestType ? requestId : null,
    invitationId: invitationType ? invitationId : null,
    decision:
      type === "ROOM_JOIN_REQUEST_APPROVED"
        ? "APPROVED"
        : type === "ROOM_JOIN_REQUEST_REJECTED"
          ? "REJECTED"
          : type === "ROOM_JOIN_REQUEST_CANCELLED"
            ? "CANCELLED"
            : null,
    title: null,
    body: null,
    version: null,
    createdAt: `2026-07-30T00:${String(cursor).padStart(2, "0")}:00.000Z`,
    readAt: null,
    ...overrides,
  });
}

function systemNotification(cursor: number): Notification {
  return NotificationSchema.parse({
    notificationId: `00000000-0000-4000-8000-${String(800 + cursor).padStart(12, "0")}`,
    cursor,
    type: "SYSTEM_UPDATE",
    actor: null,
    room: null,
    requestId: null,
    invitationId: null,
    decision: null,
    title: "SyncAction 0.9.0",
    body: "单屏协作界面现已可用。",
    version: "0.9.0",
    createdAt: `2026-07-30T00:${String(cursor).padStart(2, "0")}:00.000Z`,
    readAt: null,
  });
}

function systemAnnouncement(cursor: number): Notification {
  return NotificationSchema.parse({
    notificationId: `00000000-0000-4000-8000-${String(850 + cursor).padStart(12, "0")}`,
    cursor,
    type: "SYSTEM_ANNOUNCEMENT",
    actor: null,
    room: null,
    requestId: null,
    invitationId: null,
    decision: null,
    title: "维护通知",
    body: "服务将在低峰期维护。",
    version: null,
    createdAt: `2026-07-30T00:${String(cursor).padStart(2, "0")}:00.000Z`,
    readAt: null,
  });
}

function roomSummary() {
  return {
    id: roomId,
    name: "联合研究室",
    role: "OWNER" as const,
    roomEpoch: 0,
    visibility: "PRIVATE" as const,
    joinPolicy: "INVITE_ONLY" as const,
    roomRevision: 1,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function roomMember(
  userId: string,
  username: string,
  displayName: string,
  role: "OWNER" | "MEMBER",
) {
  return {
    userId,
    username,
    displayName,
    role,
    joinedAt: "2026-07-30T00:00:00.000Z",
  };
}

function directoryUser(userId: string, username: string, displayName: string): DirectoryUser {
  return { userId, username, displayName, online: true };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
