/**
 * @typedef {"PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED"} UserStatus
 * @typedef {"ACTIVE" | "DELETED"} RoomLifecycle
 * @typedef {"ORDINARY" | "EXEMPT"} RoomQuotaClass
 * @typedef {"asc" | "desc"} SortDirection
 * @typedef {{
 *   id: string;
 *   username: string;
 *   displayName: string;
 *   status: UserStatus;
 *   passwordResetRequired: boolean;
 *   createdAt: string | Date;
 *   updatedAt: string | Date;
 * }} AdminUser
 * @typedef {{
 *   roomId: string;
 *   name: string;
 *   ownerUserId: string;
 *   ownerUsername: string;
 *   memberCount: number;
 *   openTabCount: number;
 *   roomEpoch: number;
 *   serverSeq: number;
 *   lifecycle: RoomLifecycle;
 *   quotaClass: RoomQuotaClass;
 * }} AdminRoom
 * @typedef {{
 *   database: "ready";
 *   counts: {
 *     users: number;
 *     pendingUsers: number;
 *     activeUsers: number;
 *     suspendedUsers: number;
 *     revokedUsers: number;
 *     rooms: number;
 *     activeDeviceSessions: number;
 *   };
 * }} AdminDiagnostics
 * @typedef {{
 *   id: "pending" | "ordinaryRooms" | "exemptRooms" | "sessions" | "system";
 *   label: string;
 *   value: string;
 *   tone: "neutral" | "info" | "success" | "warning" | "danger";
 * }} OverviewMetric
 * @typedef {"soft-delete" | "restore" | "transfer"} RoomAction
 * @typedef {{
 *   action: RoomAction;
 *   roomId: string;
 *   title: string;
 *   confirmLabel: string;
 *   reasonCode: "ADMIN_CLEANUP" | "ADMIN_RECOVERY" | "OWNER_RECOVERY";
 *   tone: "danger" | "warning";
 *   summary: string;
 *   impact: string[];
 *   newOwnerUserId?: string;
 * }} RoomConfirmation
 */

const textCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
  usage: "sort",
});

/**
 * @param {ReadonlyArray<AdminUser>} users
 * @param {{
 *   query?: string;
 *   status?: UserStatus | "ALL";
 *   sortBy?: "username" | "displayName" | "status" | "createdAt" | "updatedAt";
 *   direction?: SortDirection;
 * }} [options]
 * @returns {AdminUser[]}
 */
export function selectUsers(users, options = {}) {
  const normalizedQuery = normalizeSearch(options.query);
  const status = options.status;
  const sortBy = options.sortBy ?? "createdAt";
  const direction = options.direction ?? "asc";
  return users
    .filter((user) => {
      if (status !== undefined && status !== "ALL" && user.status !== status) {
        return false;
      }
      return (
        normalizedQuery === "" ||
        [user.username, user.displayName, user.id].some((value) =>
          normalizeSearch(value).includes(normalizedQuery),
        )
      );
    })
    .slice()
    .sort((left, right) => {
      const primary = compareUserField(left, right, sortBy);
      const deterministic = primary === 0 ? compareText(left.id, right.id) : primary;
      return direction === "desc" ? -deterministic : deterministic;
    });
}

/**
 * @param {ReadonlyArray<AdminRoom>} rooms
 * @param {{
 *   query?: string;
 *   lifecycle?: RoomLifecycle | "ALL";
 *   quotaClass?: RoomQuotaClass | "ALL";
 *   sortBy?: "name" | "ownerUsername" | "memberCount" | "openTabCount" | "serverSeq";
 *   direction?: SortDirection;
 * }} [options]
 * @returns {AdminRoom[]}
 */
export function selectRooms(rooms, options = {}) {
  const normalizedQuery = normalizeSearch(options.query);
  const lifecycle = options.lifecycle;
  const quotaClass = options.quotaClass;
  const sortBy = options.sortBy ?? "name";
  const direction = options.direction ?? "asc";
  return rooms
    .filter((room) => {
      if (lifecycle !== undefined && lifecycle !== "ALL" && room.lifecycle !== lifecycle) {
        return false;
      }
      if (quotaClass !== undefined && quotaClass !== "ALL" && room.quotaClass !== quotaClass) {
        return false;
      }
      return (
        normalizedQuery === "" ||
        [room.name, room.ownerUsername, room.roomId].some((value) =>
          normalizeSearch(value).includes(normalizedQuery),
        )
      );
    })
    .slice()
    .sort((left, right) => {
      const primary = compareRoomField(left, right, sortBy);
      const deterministic = primary === 0 ? compareText(left.roomId, right.roomId) : primary;
      return direction === "desc" ? -deterministic : deterministic;
    });
}

/**
 * @param {{
 *   users: ReadonlyArray<AdminUser>;
 *   rooms: ReadonlyArray<AdminRoom>;
 *   diagnostics: AdminDiagnostics;
 * }} input
 * @returns {OverviewMetric[]}
 */
export function buildOverviewMetrics(input) {
  const ordinaryActiveRooms = input.rooms.filter(
    (room) => room.lifecycle === "ACTIVE" && room.quotaClass === "ORDINARY",
  ).length;
  const exemptActiveRooms = input.rooms.filter(
    (room) => room.lifecycle === "ACTIVE" && room.quotaClass === "EXEMPT",
  ).length;
  const pendingUsers = input.diagnostics.counts.pendingUsers;
  return [
    {
      id: "pending",
      label: "待审批账号",
      value: String(pendingUsers),
      tone: pendingUsers > 0 ? "warning" : "neutral",
    },
    {
      id: "ordinaryRooms",
      label: "普通房间",
      value: `${String(ordinaryActiveRooms)} / 5`,
      tone: ordinaryActiveRooms >= 5 ? "danger" : "info",
    },
    {
      id: "exemptRooms",
      label: "管理员房间",
      value: `${String(exemptActiveRooms)} · 配额豁免`,
      tone: "success",
    },
    {
      id: "sessions",
      label: "活跃会话",
      value: String(input.diagnostics.counts.activeDeviceSessions),
      tone: "neutral",
    },
    {
      id: "system",
      label: "系统状态",
      value: input.diagnostics.database === "ready" ? "正常" : "异常",
      tone: input.diagnostics.database === "ready" ? "success" : "danger",
    },
  ];
}

/**
 * @param {RoomQuotaClass} quotaClass
 * @returns {string}
 */
export function quotaClassLabel(quotaClass) {
  return quotaClass === "EXEMPT" ? "配额豁免" : "普通配额";
}

/**
 * @param {RoomLifecycle} lifecycle
 * @returns {string}
 */
export function lifecycleLabel(lifecycle) {
  return lifecycle === "ACTIVE" ? "活跃" : "已删除";
}

/**
 * @param {UserStatus} status
 * @returns {string}
 */
export function userStatusLabel(status) {
  const labels = {
    PENDING: "待审批",
    ACTIVE: "活跃",
    SUSPENDED: "已暂停",
    REVOKED: "已撤销",
  };
  return labels[status];
}

/**
 * @param {string} name
 * @param {number} [maxLength]
 * @returns {{ text: string; fullText: string; isTruncated: boolean; title: string | null }}
 */
export function presentName(name, maxLength = 28) {
  const characters = [...name];
  if (characters.length <= maxLength) {
    return {
      text: name,
      fullText: name,
      isTruncated: false,
      title: null,
    };
  }
  const visibleLength = Math.max(1, Math.trunc(maxLength) - 1);
  return {
    text: `${characters.slice(0, visibleLength).join("")}…`,
    fullText: name,
    isTruncated: true,
    title: name,
  };
}

/**
 * @param {RoomAction} action
 * @param {AdminRoom} room
 * @param {{ newOwnerUserId?: string; newOwnerUsername?: string }} [options]
 * @returns {RoomConfirmation}
 */
export function buildRoomConfirmation(action, room, options = {}) {
  if (action === "soft-delete") {
    return {
      action,
      roomId: room.roomId,
      title: "软删除房间",
      confirmLabel: "确认软删除",
      reasonCode: "ADMIN_CLEANUP",
      tone: "danger",
      summary: `房间“${room.name}”将被软删除。`,
      impact: [
        room.quotaClass === "ORDINARY" ? "立即释放一个普通房间名额" : "管理员房间不占用普通配额",
        "撤销未决邀请并递增房间世代",
      ],
    };
  }
  if (action === "restore") {
    return {
      action,
      roomId: room.roomId,
      title: "恢复房间",
      confirmLabel: "确认恢复",
      reasonCode: "ADMIN_RECOVERY",
      tone: "warning",
      summary: `房间“${room.name}”将恢复为活跃状态。`,
      impact: [
        room.quotaClass === "ORDINARY" ? "重新校验普通房间与打开标签页配额" : "恢复后仍为配额豁免",
        "成功恢复后递增房间世代",
      ],
    };
  }
  if (options.newOwnerUserId === undefined || options.newOwnerUsername === undefined) {
    throw new Error("TRANSFER_OWNER_REQUIRED");
  }
  return {
    action,
    roomId: room.roomId,
    newOwnerUserId: options.newOwnerUserId,
    title: "转移所有权",
    confirmLabel: "确认转移",
    reasonCode: "OWNER_RECOVERY",
    tone: "warning",
    summary: `房间“${room.name}”将转移给 ${options.newOwnerUsername}。`,
    impact: ["原所有者将变为普通成员", "服务端将原子地重新校验房间与打开标签页配额"],
  };
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
function normalizeSearch(value) {
  return (value ?? "").trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareText(left, right) {
  return textCollator.compare(left, right);
}

/**
 * @param {AdminUser} left
 * @param {AdminUser} right
 * @param {"username" | "displayName" | "status" | "createdAt" | "updatedAt"} field
 * @returns {number}
 */
function compareUserField(left, right, field) {
  if (field === "createdAt" || field === "updatedAt") {
    return new Date(left[field]).getTime() - new Date(right[field]).getTime();
  }
  return compareText(left[field], right[field]);
}

/**
 * @param {AdminRoom} left
 * @param {AdminRoom} right
 * @param {"name" | "ownerUsername" | "memberCount" | "openTabCount" | "serverSeq"} field
 * @returns {number}
 */
function compareRoomField(left, right, field) {
  if (field === "memberCount" || field === "openTabCount" || field === "serverSeq") {
    return left[field] - right[field];
  }
  return compareText(left[field], right[field]);
}
