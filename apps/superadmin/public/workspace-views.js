import {
  buildOverviewMetrics,
  lifecycleLabel,
  presentName,
  quotaClassLabel,
  selectRooms,
  selectUsers,
  userStatusLabel,
} from "./view-model.js";
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
/** @typedef {import("./app.js").AdminUser} AdminUser */
/** @typedef {import("./app.js").AdminDevice} AdminDevice */
/** @typedef {import("./app.js").ActivationGrant} ActivationGrant */
/**
 * Stateless task presentation. Commands and request lifetime stay in the app.
 * @param {{ state: import("./app.js").ConsoleState; document: Document; dom: ReturnType<typeof import("./dom.js").createConsoleDom> }} options
 */
export function createWorkspaceViews({ state, document: documentObject, dom }) {
  const {
    sectionHeading,
    panel,
    baseTable,
    tableBody,
    appendCell,
    appendPillCell,
    formField,
    filterInput,
    filterSelect,
    actionButton,
    emptyState,
    node,
    textNode,
  } = dom;
  function renderOverview() {
    const fragment = documentObject.createDocumentFragment();
    const intro = node("div", "workspace-intro");
    intro.append(
      textNode(
        "h2",
        "",
        state.diagnostics.counts.pendingUsers > 0 ? "从需要你处理的事开始。" : "协作已就绪。",
      ),
      textNode("p", "", "处理账号准入，查看房间与设备。每一步都在当前对象上完成。"),
    );
    fragment.append(intro);
    const metrics = node("section", "metric-strip");
    metrics.setAttribute("aria-label", "容量与系统指标");
    for (const metric of buildOverviewMetrics({
      users: state.users,
      rooms: state.rooms,
      diagnostics: state.diagnostics,
    })) {
      const item = node("div", "metric-item");
      item.setAttribute("data-metric-id", metric.id);
      item.setAttribute("data-tone", metric.tone);
      item.append(
        textNode("span", "metric-label", metric.label),
        textNode("strong", "metric-value", metric.value),
      );
      metrics.append(item);
    }
    const grid = node("div", "overview-grid");
    const approvals = panel("待审批账号", "按已加载账号的注册时间排序");
    approvals.append(renderPendingUsers());
    const capacity = panel("正在协作的房间", "已加载的活跃房间");
    capacity.append(renderRoomCapacity());
    grid.append(approvals, capacity);
    fragment.append(grid, metrics);
    return fragment;
  }

  function renderPendingUsers() {
    const pendingUsers = selectUsers(state.pendingUsers, {
      status: "PENDING",
      sortBy: "createdAt",
      direction: "asc",
    });
    if (pendingUsers.length === 0) {
      return emptyState(
        state.pendingTotal > 0
          ? `共有 ${state.pendingTotal} 个待审批账号，本次未能加载列表，请刷新重试。`
          : "当前没有待审批账号",
      );
    }
    const table = baseTable(["账号", "显示名称", "注册时间", "状态", "操作"]);
    table.setAttribute(
      "aria-label",
      `待审批账号：已加载 ${pendingUsers.length} / ${state.pendingTotal}`,
    );
    const caption = documentObject.createElement("caption");
    caption.textContent = `已加载 ${pendingUsers.length} / ${state.pendingTotal} 个待审批账号，按申请时间排序`;
    table.prepend(caption);
    table.classList.add("approval-table");
    const body = tableBody(table);
    for (const user of pendingUsers) {
      const row = body.insertRow();
      appendCell(row, user.username, "mono");
      appendCell(row, presentName(user.displayName, 22), "truncate");
      appendCell(row, formatDate(user.createdAt));
      appendPillCell(row, userStatusLabel(user.status), statusTone(user.status));
      const actionCell = row.insertCell();
      const button = actionButton("批准", "primary-small");
      button.setAttribute("data-action", "approve-user");
      button.setAttribute("data-user-id", user.id);
      button.disabled = state.pendingActions.has(`approve:${user.id}`);
      actionCell.append(button);
    }
    return table;
  }

  function renderActivationKeys() {
    const fragment = documentObject.createDocumentFragment();
    fragment.append(
      sectionHeading("账户密钥", "创建一次性激活凭据，并查看密钥与最终账户之间的对应关系"),
    );
    const layout = node("div", "activation-layout");
    const createPanel = panel("创建密钥", "有效期 7 天；备注用于区分接收者或设备");
    const form = documentObject.createElement("form");
    form.className = "activation-form";
    form.setAttribute("data-form", "activation-grant");
    const noteField = formField("备注", "note", "text", "off");
    const noteInput = noteField.querySelector("input");
    if (noteInput !== null) {
      noteInput.maxLength = 120;
      noteInput.placeholder = "例如：Alice / 设计组笔记本";
      noteInput.value = state.activationDraft;
    }
    const create = actionButton("生成账户密钥", "primary");
    create.type = "submit";
    create.disabled = state.pendingActions.has("create-activation-grant");
    form.append(noteField, create);
    createPanel.append(form);
    layout.append(createPanel);

    if (state.oneTimeActivation !== null) {
      const oneTime = node("section", "activation-one-time");
      oneTime.setAttribute("data-region", "one-time-activation-key");
      oneTime.append(
        textNode("h3", "activation-one-time-title", "立即保存并传递完整密钥"),
        textNode(
          "p",
          "activation-warning",
          "完整密钥只显示这一次；关闭卡片、切换页面或退出登录后都无法再次查看。",
        ),
        textNode("span", "activation-path-label", "用户密钥登录路径"),
        textNode("code", "activation-path", "/v1/auth/key-login"),
        textNode("p", "activation-one-time-meta", `备注：${state.oneTimeActivation.grant.note}`),
        textNode(
          "p",
          "activation-one-time-meta",
          `到期：${formatDate(state.oneTimeActivation.grant.expiresAt)}`,
        ),
        textNode("code", "activation-secret", state.oneTimeActivation.activationKey),
      );
      const actions = node("div", "activation-actions");
      const copy = actionButton("复制完整密钥", "primary");
      copy.setAttribute("data-action", "copy-activation-key");
      const dismiss = actionButton("我已安全保存", "quiet");
      dismiss.setAttribute("data-action", "dismiss-activation-key");
      actions.append(copy, dismiss);
      oneTime.append(actions);
      layout.append(oneTime);
    }
    fragment.append(layout);

    const mapping = panel("密钥与账户关系", "列表不保存、不返回完整密钥");
    if (state.activationGrants.length === 0) {
      mapping.append(emptyState("尚未创建账户密钥"));
      fragment.append(mapping);
      return fragment;
    }
    const table = baseTable([
      "备注",
      "对应账户",
      "密钥尾号",
      "状态",
      "创建时间",
      "使用时间",
      "操作",
    ]);
    const body = tableBody(table);
    for (const grant of state.activationGrants) {
      const row = body.insertRow();
      appendCell(row, presentName(grant.note, 36), "truncate");
      appendCell(
        row,
        grant.account === null
          ? "尚未激活"
          : `@${grant.account.username} · ${grant.account.displayName}`,
      );
      appendCell(row, `…${grant.keyTail}`, "mono");
      appendPillCell(row, activationStatusLabel(grant.status), activationStatusTone(grant.status));
      appendCell(row, formatDate(grant.createdAt));
      appendCell(row, grant.usedAt === null ? "尚未使用" : formatDate(grant.usedAt));
      const actionCell = row.insertCell();
      if (grant.status === "ACTIVE" || grant.status === "CLAIMED") {
        const revoke = actionButton("撤销", "danger");
        revoke.setAttribute("data-action", "revoke-activation-grant");
        revoke.setAttribute("data-grant-id", grant.id);
        revoke.disabled = state.pendingActions.has(`revoke-activation-grant:${grant.id}`);
        actionCell.append(revoke);
      } else {
        actionCell.textContent = "—";
      }
    }
    mapping.append(table);
    fragment.append(mapping);
    return fragment;
  }

  function renderRoomCapacity() {
    const list = node("div", "capacity-list");
    const selected = selectRooms(state.rooms, {
      lifecycle: "ACTIVE",
      sortBy: "openTabCount",
      direction: "desc",
    });
    if (selected.length === 0) {
      return emptyState("当前没有活跃房间");
    }
    for (const room of selected.slice(0, 8)) {
      const row = node("div", "capacity-row");
      const name = presentName(room.name, 24);
      const identity = node("div", "capacity-identity");
      const nameNode = textNode("strong", "truncate-text", name.text);
      if (name.title !== null) {
        nameNode.title = name.title;
      }
      identity.append(
        nameNode,
        textNode("span", "muted", `@${room.ownerUsername} · ${quotaClassLabel(room.quotaClass)}`),
      );
      const usage = node("div", "capacity-usage");
      usage.append(
        textNode(
          "strong",
          "",
          room.quotaClass === "EXEMPT"
            ? `${String(room.openTabCount)} · 配额豁免`
            : `${String(room.openTabCount)} / 20`,
        ),
        textNode("span", "muted", `${String(room.memberCount)} 名成员`),
      );
      const button = actionButton("管理", "quiet");
      button.setAttribute("data-action", "open-room");
      button.setAttribute("data-room-id", room.roomId);
      row.append(identity, usage, button);
      list.append(row);
    }
    return list;
  }

  function renderRoomManagement() {
    const fragment = documentObject.createDocumentFragment();
    fragment.append(sectionHeading("所有房间", "查看房间、成员与参与状态，处置前再次确认。"));
    const toolbar = node("div", "filter-bar");
    toolbar.append(
      filterInput("搜索房间或所有者", "room-query", state.roomFilters.query),
      filterSelect("生命周期", "room-lifecycle", state.roomFilters.lifecycle, [
        ["ALL", "全部状态"],
        ["ACTIVE", "活跃"],
        ["DELETED", "已删除"],
      ]),
      filterSelect("配额类别", "room-quota", state.roomFilters.quotaClass, [
        ["ALL", "全部配额"],
        ["ORDINARY", "普通配额"],
        ["EXEMPT", "配额豁免"],
      ]),
      filterSelect("排序字段", "room-sort", state.roomFilters.sortBy, [
        ["name", "房间名称"],
        ["ownerUsername", "所有者"],
        ["memberCount", "成员数"],
        ["openTabCount", "打开标签"],
        ["serverSeq", "服务器序号"],
      ]),
      filterSelect("排序方向", "room-direction", state.roomFilters.direction, [
        ["asc", "升序"],
        ["desc", "降序"],
      ]),
    );
    fragment.append(toolbar);
    const selected = selectRooms(state.rooms, state.roomFilters);
    fragment.append(
      textNode(
        "p",
        "result-count",
        `当前显示 ${selected.length} 个房间 · 已加载 ${state.rooms.length} 个（最多 200）`,
      ),
    );
    const table = baseTable(["房间", "所有者", "成员", "打开标签", "配额", "状态", "操作"]);
    const body = tableBody(table);
    for (const room of selected) {
      const row = body.insertRow();
      appendCell(row, presentName(room.name, 30), "truncate");
      appendCell(row, `@${room.ownerUsername}`);
      appendCell(row, String(room.memberCount), "numeric");
      appendCell(
        row,
        room.quotaClass === "EXEMPT"
          ? `${String(room.openTabCount)} · 豁免`
          : `${String(room.openTabCount)} / 20`,
        "numeric",
      );
      appendPillCell(
        row,
        quotaClassLabel(room.quotaClass),
        room.quotaClass === "EXEMPT" ? "success" : "neutral",
      );
      appendPillCell(
        row,
        lifecycleLabel(room.lifecycle),
        room.lifecycle === "ACTIVE" ? "success" : "neutral",
      );
      const cell = row.insertCell();
      const button = actionButton("详情", "quiet");
      button.setAttribute("data-action", "open-room");
      button.setAttribute("data-room-id", room.roomId);
      cell.append(button);
    }
    fragment.append(table);
    if (selected.length === 0) fragment.append(emptyState("没有符合条件的房间，试试调整筛选。"));
    return fragment;
  }

  function renderUsersAndDevices() {
    const fragment = documentObject.createDocumentFragment();
    fragment.append(
      sectionHeading("账号与当前设备", "选择账号查看当前可用会话，不显示历史失效会话。"),
    );
    const toolbar = node("div", "filter-bar");
    toolbar.append(
      filterInput("搜索账号或显示名称", "user-query", state.userFilters.query),
      filterSelect("账号状态", "user-status", state.userFilters.status, [
        ["ALL", "全部状态"],
        ["PENDING", "待审批"],
        ["ACTIVE", "活跃"],
        ["SUSPENDED", "已暂停"],
        ["REVOKED", "已撤销"],
      ]),
    );
    fragment.append(toolbar);
    const selected = selectUsers(state.users, state.userFilters);
    fragment.append(
      textNode(
        "p",
        "result-count",
        `当前显示 ${selected.length} 个账号 · 已加载 ${state.users.length} 个（最多 200）`,
      ),
    );
    const table = baseTable(["账号", "显示名称", "状态", "密码重置", "设备"]);
    const body = tableBody(table);
    for (const user of selected) {
      const row = body.insertRow();
      appendCell(row, user.username, "mono");
      appendCell(row, presentName(user.displayName, 26), "truncate");
      appendPillCell(row, userStatusLabel(user.status), statusTone(user.status));
      appendCell(row, user.passwordResetRequired ? "需要" : "否");
      const cell = row.insertCell();
      const button = actionButton("查看设备", "quiet");
      button.setAttribute("data-action", "view-devices");
      button.setAttribute("data-user-id", user.id);
      cell.append(button);
      if (state.selectedUserId === user.id) {
        const detailRow = body.insertRow();
        const detailCell = detailRow.insertCell();
        detailCell.colSpan = 5;
        detailCell.append(renderDevices(state.devicesByUserId.get(user.id) ?? []));
      }
    }
    fragment.append(table);
    if (selected.length === 0)
      fragment.append(emptyState("没有符合条件的账号，试试调整搜索或状态。"));
    return fragment;
  }

  /**
   * @param {AdminDevice[]} devices
   */
  function renderDevices(devices) {
    if (devices.length === 0) {
      return emptyState("没有当前可用设备会话");
    }
    const list = node("div", "device-list");
    for (const device of devices) {
      const row = node("div", "device-row");
      row.append(
        textNode("code", "", device.deviceId),
        textNode("span", "", `${String(device.activeSessionCount)} 个会话`),
        textNode("span", "muted", formatDate(device.lastRotatedAt)),
      );
      list.append(row);
    }
    return list;
  }

  function renderAudit() {
    const fragment = documentObject.createDocumentFragment();
    fragment.append(sectionHeading("安全审计", "结构化事件只显示标识符、计数和稳定原因码"));
    const table = baseTable(["时间", "事件", "目标", "安全详情"]);
    const body = tableBody(table);
    for (const event of state.auditEvents) {
      const row = body.insertRow();
      appendCell(row, formatDate(event.createdAt));
      appendCell(row, event.eventType, "mono");
      appendCell(row, `${event.targetType}:${event.targetId}`, "mono");
      appendCell(row, JSON.stringify(event.details ?? {}), "mono audit-detail");
    }
    fragment.append(table);
    return fragment;
  }

  function renderDiagnostics() {
    const fragment = documentObject.createDocumentFragment();
    fragment.append(sectionHeading("系统诊断", "管理员服务与聚合计数"));
    const grid = node("dl", "diagnostic-grid");
    const entries = [
      ["数据库", state.diagnostics.database === "ready" ? "正常" : "异常"],
      ["用户总数", state.diagnostics.counts.users],
      ["待审批", state.diagnostics.counts.pendingUsers],
      ["活跃用户", state.diagnostics.counts.activeUsers],
      ["已暂停", state.diagnostics.counts.suspendedUsers],
      ["已撤销", state.diagnostics.counts.revokedUsers],
      ["活跃房间", state.diagnostics.counts.rooms],
      ["活跃会话", state.diagnostics.counts.activeDeviceSessions],
    ];
    for (const [label, value] of entries) {
      const item = node("div", "diagnostic-item");
      item.append(textNode("dt", "", String(label)), textNode("dd", "", String(value)));
      grid.append(item);
    }
    fragment.append(grid);
    return fragment;
  }

  return {
    renderOverview,
    renderPendingUsers,
    renderActivationKeys,
    renderRoomManagement,
    renderUsersAndDevices,
    renderAudit,
    renderDiagnostics,
  };
}

/**
 * @param {AdminUser["status"]} status
 */
function statusTone(status) {
  if (status === "ACTIVE") {
    return "success";
  }
  if (status === "PENDING") {
    return "warning";
  }
  if (status === "SUSPENDED") {
    return "danger";
  }
  return "neutral";
}

/**
 * @param {ActivationGrant["status"]} status
 */
function activationStatusLabel(status) {
  return {
    ACTIVE: "未领取",
    CLAIMED: "待完善（密钥仍可登录）",
    USED: "已完成",
    REVOKED: "已撤销",
    EXPIRED: "已过期",
  }[status];
}

/**
 * @param {ActivationGrant["status"]} status
 */
function activationStatusTone(status) {
  if (status === "ACTIVE") {
    return "success";
  }
  if (status === "CLAIMED" || status === "EXPIRED") {
    return "warning";
  }
  return "neutral";
}

/**
 * @param {string | Date} value
 */
function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return dateFormatter.format(date);
}
