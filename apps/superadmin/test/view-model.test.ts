import { describe, expect, it } from "vitest";
import {
  buildOverviewMetrics,
  buildRoomConfirmation,
  presentName,
  quotaClassLabel,
  selectRooms,
  selectUsers,
} from "../public/view-model.js";

const users = [
  {
    id: "user-c",
    username: "zoe",
    displayName: "Zoe",
    status: "ACTIVE",
    passwordResetRequired: false,
    createdAt: "2026-07-27T03:00:00.000Z",
    updatedAt: "2026-07-27T03:00:00.000Z",
  },
  {
    id: "user-b",
    username: "alice",
    displayName: "Alice Two",
    status: "ACTIVE",
    passwordResetRequired: false,
    createdAt: "2026-07-27T02:00:00.000Z",
    updatedAt: "2026-07-27T02:00:00.000Z",
  },
  {
    id: "user-a",
    username: "Alice",
    displayName: "Alice One",
    status: "PENDING",
    passwordResetRequired: true,
    createdAt: "2026-07-27T01:00:00.000Z",
    updatedAt: "2026-07-27T01:00:00.000Z",
  },
] as const;

const rooms = [
  {
    roomId: "room-c",
    name: "Gamma",
    ownerUserId: "user-c",
    ownerUsername: "zoe",
    memberCount: 3,
    openTabCount: 5,
    roomEpoch: 0,
    serverSeq: 8,
    lifecycle: "ACTIVE",
    quotaClass: "ORDINARY",
  },
  {
    roomId: "room-a",
    name: "Alpha",
    ownerUserId: "user-a",
    ownerUsername: "alice",
    memberCount: 2,
    openTabCount: 11,
    roomEpoch: 1,
    serverSeq: 14,
    lifecycle: "ACTIVE",
    quotaClass: "EXEMPT",
  },
  {
    roomId: "room-b",
    name: "Beta",
    ownerUserId: "user-b",
    ownerUsername: "alice",
    memberCount: 1,
    openTabCount: 11,
    roomEpoch: 2,
    serverSeq: 21,
    lifecycle: "DELETED",
    quotaClass: "ORDINARY",
  },
] as const;

describe("administrator console view models", () => {
  it("filters and sorts users deterministically without mutating the source", () => {
    const selected = selectUsers(users, {
      query: "ali",
      sortBy: "username",
      direction: "asc",
    });

    expect(selected.map((user) => user.id)).toEqual(["user-a", "user-b"]);
    expect(
      selectUsers(users, { status: "ACTIVE", sortBy: "createdAt", direction: "desc" }),
    ).toEqual([users[0], users[1]]);
    expect(users.map((user) => user.id)).toEqual(["user-c", "user-b", "user-a"]);
  });

  it("filters and sorts rooms deterministically across lifecycle and quota class", () => {
    expect(
      selectRooms(rooms, {
        lifecycle: "ACTIVE",
        query: "a",
        sortBy: "openTabCount",
        direction: "desc",
      }).map((room) => room.roomId),
    ).toEqual(["room-a", "room-c"]);
    expect(
      selectRooms(rooms, {
        quotaClass: "ORDINARY",
        sortBy: "openTabCount",
        direction: "desc",
      }).map((room) => room.roomId),
    ).toEqual(["room-b", "room-c"]);
  });

  it("builds exactly five approval-first capacity metrics", () => {
    const metrics = buildOverviewMetrics({
      users,
      rooms,
      diagnostics: {
        database: "ready",
        counts: {
          users: 3,
          pendingUsers: 1,
          activeUsers: 2,
          suspendedUsers: 0,
          revokedUsers: 0,
          rooms: 2,
          activeDeviceSessions: 7,
        },
      },
    });

    expect(metrics).toEqual([
      { id: "pending", label: "待审批账号", value: "1", tone: "warning" },
      { id: "ordinaryRooms", label: "普通房间", value: "1 / 5", tone: "info" },
      {
        id: "exemptRooms",
        label: "管理员房间",
        value: "1 · 配额豁免",
        tone: "success",
      },
      { id: "sessions", label: "活跃会话", value: "7", tone: "neutral" },
      { id: "system", label: "系统状态", value: "正常", tone: "success" },
    ]);
  });

  it("uses explicit ordinary and administrator-exempt labels", () => {
    expect(quotaClassLabel("ORDINARY")).toBe("普通配额");
    expect(quotaClassLabel("EXEMPT")).toBe("配额豁免");
  });

  it("returns accessible metadata when a long name is truncated", () => {
    expect(presentName("协作🚀管理员控制台", 7)).toEqual({
      text: "协作🚀管理员…",
      fullText: "协作🚀管理员控制台",
      isTruncated: true,
      title: "协作🚀管理员控制台",
    });
    expect(presentName("短名称", 7)).toEqual({
      text: "短名称",
      fullText: "短名称",
      isTruncated: false,
      title: null,
    });
  });

  it("builds explicit second-step delete, restore, and transfer confirmations", () => {
    expect(buildRoomConfirmation("soft-delete", rooms[0])).toMatchObject({
      action: "soft-delete",
      roomId: "room-c",
      title: "软删除房间",
      confirmLabel: "确认软删除",
      reasonCode: "ADMIN_CLEANUP",
      tone: "danger",
    });
    expect(buildRoomConfirmation("restore", rooms[2])).toMatchObject({
      action: "restore",
      roomId: "room-b",
      title: "恢复房间",
      confirmLabel: "确认恢复",
      reasonCode: "ADMIN_RECOVERY",
      tone: "warning",
    });
    const transfer = buildRoomConfirmation("transfer", rooms[1], {
      newOwnerUserId: "user-b",
      newOwnerUsername: "alice",
    });
    expect(transfer).toMatchObject({
      action: "transfer",
      roomId: "room-a",
      newOwnerUserId: "user-b",
      title: "转移所有权",
      confirmLabel: "确认转移",
      reasonCode: "OWNER_RECOVERY",
      tone: "warning",
    });
    expect(transfer.summary).toContain("alice");
    expect(JSON.stringify(transfer)).not.toMatch(/https?:|favIcon|media|pointer|danmaku/iu);
  });
});
