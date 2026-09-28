/* global AbortController, DOMException, HTMLElement, document */

import { AdminApiError, createAdminApi } from "./api.js";
import {
  buildOverviewMetrics,
  buildRoomConfirmation,
  lifecycleLabel,
  presentName,
  quotaClassLabel,
  selectRooms,
  selectUsers,
  userStatusLabel,
} from "./view-model.js";

/**
 * @typedef {ReturnType<typeof createAdminApi>} AdminApi
 * @typedef {{
 *   id: string;
 *   username: string;
 *   displayName: string;
 *   status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
 *   passwordResetRequired: boolean;
 *   createdAt: string;
 *   updatedAt: string;
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
 *   lifecycle: "ACTIVE" | "DELETED";
 *   quotaClass: "ORDINARY" | "EXEMPT";
 * }} AdminRoom
 * @typedef {{
 *   userId: string;
 *   username: string;
 *   displayName: string;
 *   status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
 *   role: "OWNER" | "MEMBER";
 *   createdAt: string;
 * }} RoomMember
 * @typedef {{
 *   deviceId: string;
 *   activeSessionCount: number;
 *   lastRotatedAt: string;
 * }} AdminDevice
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
 *   administratorId: string;
 *   username: string;
 *   linkedUserId: string | null;
 *   sessionId: string;
 *   passwordChangeRequired: boolean;
 *   totpEnrollmentRequired: boolean;
 * }} AdminPrincipal
 * @typedef {{
 *   passwordChangeRequired: boolean;
 *   totpEnrollmentRequired: boolean;
 * }} AdminOnboarding
 * @typedef {{
 *   administrator: {
 *     id: string;
 *     username: string;
 *     linkedUserId: string | null;
 *   };
 *   onboarding: AdminOnboarding;
 * }} AdminOnboardingSnapshot
 * @typedef {{
 *   secret: string;
 *   otpauthUri: string;
 * }} TotpEnrollment
 * @typedef {{
 *   id?: number;
 *   eventType: string;
 *   targetType: string;
 *   targetId: string;
 *   details: unknown;
 *   createdAt: string;
 * }} AuditEvent
 * @typedef {{
 *   id: string;
 *   note: string;
 *   keyTail: string;
 *   status: "ACTIVE" | "CLAIMED" | "USED" | "REVOKED" | "EXPIRED";
 *   account: { id: string; username: string; displayName: string } | null;
 *   expiresAt: string;
 *   usedAt: string | null;
 *   revokedAt: string | null;
 *   createdAt: string;
 * }} ActivationGrant
 * @typedef {{
 *   room: AdminRoom;
 *   members: RoomMember[];
 *   confirmation: ReturnType<typeof buildRoomConfirmation> | null;
 *   error: string | null;
 * }} DrawerState
 * @typedef {{
 *   tagName: string;
 *   attributes: Record<string, string>;
 * }} FocusToken
 * @typedef {{
 *   authenticated: boolean;
 *   principal: AdminPrincipal | null;
 *   onboarding: AdminOnboarding | null;
 *   totpEnrollment: TotpEnrollment | null;
 *   currentView: "overview" | "approvals" | "activation-keys" | "rooms" | "users" | "audit" | "diagnostics";
 *   users: AdminUser[];
 *   rooms: AdminRoom[];
 *   diagnostics: AdminDiagnostics;
 *   auditEvents: AuditEvent[];
 *   activationGrants: ActivationGrant[];
 *   oneTimeActivation: { activationKey: string; grant: ActivationGrant } | null;
 *   devicesByUserId: Map<string, AdminDevice[]>;
 *   selectedUserId: string | null;
 *   drawer: DrawerState | null;
 *   bindingTargetUserId: string | null;
 *   drawerReturnFocus: FocusToken | null;
 *   focusIntent: "drawer-initial" | "drawer-return" | null;
 *   userFilters: {
 *     query: string;
 *     status: "ALL" | "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
 *     sortBy: "username" | "displayName" | "status" | "createdAt";
 *     direction: "asc" | "desc";
 *   };
 *   roomFilters: {
 *     query: string;
 *     lifecycle: "ALL" | "ACTIVE" | "DELETED";
 *     quotaClass: "ALL" | "ORDINARY" | "EXEMPT";
 *     sortBy: "name" | "ownerUsername" | "memberCount" | "openTabCount" | "serverSeq";
 *     direction: "asc" | "desc";
 *   };
 *   pendingActions: Set<string>;
 *   error: string | null;
 *   notice: string | null;
 *   refreshWarning: string | null;
 * }} ConsoleState
 */

/** @type {Array<[ConsoleState["currentView"], string]>} */
const navigation = [
  ["overview", "概览"],
  ["approvals", "用户审批"],
  ["activation-keys", "账户密钥"],
  ["rooms", "房间管理"],
  ["users", "用户与设备"],
  ["audit", "安全审计"],
  ["diagnostics", "系统诊断"],
];

/** @type {AdminDiagnostics} */
const emptyDiagnostics = {
  database: "ready",
  counts: {
    users: 0,
    pendingUsers: 0,
    activeUsers: 0,
    suspendedUsers: 0,
    revokedUsers: 0,
    rooms: 0,
    activeDeviceSessions: 0,
  },
};

/**
 * @param {{ root: HTMLElement; document: Document; api?: AdminApi }} options
 */
export function createConsoleApp(options) {
  const { root, document: documentObject } = options;
  const api = options.api ?? createAdminApi();
  /** @type {ConsoleState} */
  const state = {
    authenticated: false,
    principal: null,
    onboarding: null,
    totpEnrollment: null,
    currentView: "overview",
    users: [],
    rooms: [],
    diagnostics: emptyDiagnostics,
    auditEvents: [],
    activationGrants: [],
    oneTimeActivation: null,
    devicesByUserId: new Map(),
    selectedUserId: null,
    drawer: null,
    bindingTargetUserId: null,
    drawerReturnFocus: null,
    focusIntent: null,
    userFilters: {
      query: "",
      status: "ALL",
      sortBy: "username",
      direction: "asc",
    },
    roomFilters: {
      query: "",
      lifecycle: "ALL",
      quotaClass: "ALL",
      sortBy: "name",
      direction: "asc",
    },
    pendingActions: new Set(),
    error: null,
    notice: null,
    refreshWarning: null,
  };
  let started = false;
  let generation = 0;
  /** @type {AbortController | null} */
  let transientReadController = null;
  /** @type {Set<AbortController>} */
  const activeControllers = new Set();
  /** @type {Promise<void>} */
  let authoritativeRefreshTail = Promise.resolve();

  /** @param {Event} event */
  const clickHandler = (event) => void handleClick(/** @type {MouseEvent} */ (event));
  /** @param {Event} event */
  const submitHandler = (event) => void handleSubmit(/** @type {SubmitEvent} */ (event));
  /** @param {Event} event */
  const changeHandler = (event) => handleChange(event);
  /** @param {Event} event */
  const keydownHandler = (event) => handleKeydown(/** @type {KeyboardEvent} */ (event));

  async function start() {
    if (!started) {
      started = true;
      generation += 1;
      root.addEventListener("click", clickHandler);
      root.addEventListener("submit", submitHandler);
      root.addEventListener("change", changeHandler);
      root.addEventListener("keydown", keydownHandler);
    }
    const operationGeneration = generation;
    const controller = beginTransientRead();
    try {
      await loadAuthenticatedState(controller.signal);
      if (!isLive(operationGeneration, controller)) {
        return;
      }
      state.error = null;
    } catch (error) {
      if (!isLive(operationGeneration, controller) || isAbort(error)) {
        return;
      }
      if (isUnauthorized(error)) {
        state.authenticated = false;
        state.principal = null;
        state.onboarding = null;
        state.totpEnrollment = null;
      } else {
        state.error = errorMessage(error);
      }
    } finally {
      releaseController(controller);
    }
    if (isLive(operationGeneration)) {
      render();
    }
  }

  function destroy() {
    generation += 1;
    started = false;
    for (const controller of activeControllers) {
      controller.abort();
    }
    activeControllers.clear();
    transientReadController = null;
    authoritativeRefreshTail = Promise.resolve();
    state.pendingActions.clear();
    state.totpEnrollment = null;
    state.oneTimeActivation = null;
    root.removeEventListener("click", clickHandler);
    root.removeEventListener("submit", submitHandler);
    root.removeEventListener("change", changeHandler);
    root.removeEventListener("keydown", keydownHandler);
    root.replaceChildren();
  }

  /**
   * @param {AbortSignal} signal
   */
  async function loadAuthenticatedState(signal) {
    const onboardingResult = /** @type {AdminOnboardingSnapshot} */ (await api.onboarding(signal));
    state.authenticated = true;
    state.onboarding = onboardingResult.onboarding;
    const onboardingRequired =
      onboardingResult.onboarding.passwordChangeRequired ||
      onboardingResult.onboarding.totpEnrollmentRequired;
    if (onboardingRequired) {
      state.principal = null;
      state.totpEnrollment = onboardingResult.onboarding.totpEnrollmentRequired
        ? /** @type {TotpEnrollment} */ (await api.totpEnrollment(signal))
        : null;
      state.users = [];
      state.rooms = [];
      state.auditEvents = [];
      state.activationGrants = [];
      state.oneTimeActivation = null;
      return;
    }

    state.totpEnrollment = null;
    const principalResult = await api.me(signal);
    const snapshot = await fetchConsoleData(signal);
    state.principal = /** @type {AdminPrincipal} */ (principalResult);
    applyConsoleSnapshot(snapshot);
  }

  /**
   * @param {AbortSignal} signal
   */
  async function fetchConsoleData(signal) {
    const activationGrantsPromise =
      typeof api.listActivationGrants === "function"
        ? api.listActivationGrants(signal)
        : Promise.resolve({ grants: [] });
    const [usersResult, roomsResult, diagnosticsResult, auditResult, activationResult] =
      await Promise.all([
        api.listUsers({ limit: 200 }, signal),
        api.listRooms({ limit: 200 }, signal),
        api.diagnostics(signal),
        api.listAuditEvents(100, signal),
        activationGrantsPromise,
      ]);
    return {
      users: /** @type {{ users: AdminUser[] }} */ (usersResult).users,
      rooms: /** @type {{ rooms: AdminRoom[] }} */ (roomsResult).rooms,
      diagnostics: /** @type {AdminDiagnostics} */ (diagnosticsResult),
      auditEvents: /** @type {{ events: AuditEvent[] }} */ (auditResult).events,
      activationGrants: /** @type {{ grants: ActivationGrant[] }} */ (activationResult).grants,
    };
  }

  /** @param {Awaited<ReturnType<typeof fetchConsoleData>>} snapshot */
  function applyConsoleSnapshot(snapshot) {
    state.users = snapshot.users;
    state.rooms = snapshot.rooms;
    state.diagnostics = snapshot.diagnostics;
    state.auditEvents = snapshot.auditEvents;
    state.activationGrants = snapshot.activationGrants;
  }

  /** @param {AbortSignal} signal */
  async function fetchApprovalProjection(signal) {
    const [usersResult, diagnosticsResult, auditResult] = await Promise.all([
      api.listUsers({ limit: 200 }, signal),
      api.diagnostics(signal),
      api.listAuditEvents(100, signal),
    ]);
    return () => {
      state.users = /** @type {{ users: AdminUser[] }} */ (usersResult).users;
      state.diagnostics = /** @type {AdminDiagnostics} */ (diagnosticsResult);
      state.auditEvents = /** @type {{ events: AuditEvent[] }} */ (auditResult).events;
    };
  }

  /** @param {AbortSignal} signal */
  async function fetchRoomProjection(signal) {
    const [roomsResult, diagnosticsResult, auditResult] = await Promise.all([
      api.listRooms({ limit: 200 }, signal),
      api.diagnostics(signal),
      api.listAuditEvents(100, signal),
    ]);
    return () => {
      state.rooms = /** @type {{ rooms: AdminRoom[] }} */ (roomsResult).rooms;
      state.diagnostics = /** @type {AdminDiagnostics} */ (diagnosticsResult);
      state.auditEvents = /** @type {{ events: AuditEvent[] }} */ (auditResult).events;
    };
  }

  /** @param {AbortSignal} signal */
  async function fetchBindingProjection(signal) {
    const [principalResult, usersResult, roomsResult, diagnosticsResult, auditResult] =
      await Promise.all([
        api.me(signal),
        api.listUsers({ limit: 200 }, signal),
        api.listRooms({ limit: 200 }, signal),
        api.diagnostics(signal),
        api.listAuditEvents(100, signal),
      ]);
    return () => {
      state.principal = /** @type {AdminPrincipal} */ (principalResult);
      state.users = /** @type {{ users: AdminUser[] }} */ (usersResult).users;
      state.rooms = /** @type {{ rooms: AdminRoom[] }} */ (roomsResult).rooms;
      state.diagnostics = /** @type {AdminDiagnostics} */ (diagnosticsResult);
      state.auditEvents = /** @type {{ events: AuditEvent[] }} */ (auditResult).events;
    };
  }

  function createController() {
    const controller = new AbortController();
    activeControllers.add(controller);
    return controller;
  }

  function beginTransientRead() {
    transientReadController?.abort();
    if (transientReadController !== null) {
      activeControllers.delete(transientReadController);
    }
    const controller = createController();
    transientReadController = controller;
    return controller;
  }

  /** @param {AbortController} controller */
  function releaseController(controller) {
    activeControllers.delete(controller);
    if (transientReadController === controller) {
      transientReadController = null;
    }
  }

  /**
   * @param {number} operationGeneration
   * @param {AbortController} [controller]
   */
  function isLive(operationGeneration, controller) {
    return (
      started &&
      generation === operationGeneration &&
      (controller === undefined || !controller.signal.aborted)
    );
  }

  /**
   * @param {(signal: AbortSignal) => Promise<() => void>} fetchProjection
   * @param {number} operationGeneration
   */
  function queueAuthoritativeRefresh(fetchProjection, operationGeneration) {
    const refresh = authoritativeRefreshTail
      .catch(() => undefined)
      .then(async () => {
        if (!isLive(operationGeneration)) {
          throw new DOMException("Console destroyed", "AbortError");
        }
        const controller = createController();
        try {
          const applyProjection = await fetchProjection(controller.signal);
          if (!isLive(operationGeneration, controller)) {
            throw new DOMException("Console destroyed", "AbortError");
          }
          applyProjection();
        } finally {
          releaseController(controller);
        }
      });
    authoritativeRefreshTail = refresh.catch(() => undefined);
    return refresh;
  }

  /**
   * @param {SubmitEvent} event
   */
  async function handleSubmit(event) {
    const form = event.target;
    if (!isElement(form)) {
      return;
    }
    const formName = form.getAttribute("data-form");
    if (formName === "activation-grant") {
      event.preventDefault();
      if (state.pendingActions.has("logout")) {
        state.notice = "正在退出登录，不能再生成账户密钥";
        render();
        return;
      }
      const submitButton = form.querySelector('button[type="submit"]');
      if (!isButton(submitButton)) {
        return;
      }
      const note = formValue(form, "note").trim();
      if (note === "") {
        state.error = "请填写用于区分接收者或设备的备注";
        render();
        return;
      }
      await runMutation(
        submitButton,
        "create-activation-grant",
        (signal) => api.createActivationGrant(note, signal),
        (result) => {
          const created = /** @type {{ activationKey: string; grant: ActivationGrant }} */ (result);
          state.oneTimeActivation = created;
          state.activationGrants = [
            created.grant,
            ...state.activationGrants.filter((grant) => grant.id !== created.grant.id),
          ];
          /** @type {HTMLFormElement} */ (form).reset();
          state.notice = "账户密钥已创建，请立即安全传递给对应用户";
        },
        null,
      );
      return;
    }
    if (formName === "prepare-linked-user") {
      event.preventDefault();
      if (
        state.principal === null ||
        state.principal.linkedUserId !== null ||
        state.pendingActions.has("bind-linked-user")
      ) {
        return;
      }
      const select = form.querySelector('select[name="linkedUserId"]');
      const userId = isSelect(select) ? select.value : "";
      const targetUser = state.users.find((user) => user.id === userId && user.status === "ACTIVE");
      if (targetUser === undefined) {
        state.bindingTargetUserId = null;
        state.error = "请选择已加载的活跃普通账号";
        render();
        return;
      }
      state.bindingTargetUserId = targetUser.id;
      state.error = null;
      state.notice = null;
      render();
      return;
    }
    if (formName === "administrator-onboarding") {
      event.preventDefault();
      if (state.onboarding === null) {
        return;
      }
      const submitButton = form.querySelector('button[type="submit"]');
      if (!isButton(submitButton)) {
        return;
      }
      /** @type {{ newPassword?: string; totp: string }} */
      const completion = {
        totp: formValue(form, "totp"),
      };
      if (state.onboarding.passwordChangeRequired) {
        const newPassword = formValue(form, "newPassword");
        if (newPassword !== formValue(form, "newPasswordConfirmation")) {
          state.error = "两次输入的密码不一致";
          render();
          return;
        }
        completion.newPassword = newPassword;
      }
      const operationGeneration = generation;
      const controller = createController();
      submitButton.disabled = true;
      state.error = null;
      try {
        await api.completeOnboarding(completion, controller.signal);
        if (!isLive(operationGeneration, controller)) {
          return;
        }
        state.totpEnrollment = null;
        await loadAuthenticatedState(controller.signal);
        if (!isLive(operationGeneration, controller)) {
          return;
        }
        state.notice = "管理员设置已完成";
      } catch (error) {
        if (!isLive(operationGeneration, controller) || isAbort(error)) {
          return;
        }
        state.error = errorMessage(error);
      } finally {
        releaseController(controller);
        if (isLive(operationGeneration)) {
          submitButton.disabled = false;
          render();
        }
      }
      return;
    }
    if (formName !== "login") {
      return;
    }
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    if (!isButton(submitButton)) {
      return;
    }
    const totp = formValue(form, "totp");
    const credentials = {
      username: formValue(form, "username"),
      password: formValue(form, "password"),
      ...(totp === "" ? {} : { totp }),
    };
    const operationGeneration = generation;
    const controller = createController();
    submitButton.disabled = true;
    state.error = null;
    try {
      await api.login(credentials, controller.signal);
      if (!isLive(operationGeneration, controller)) {
        return;
      }
      /** @type {HTMLFormElement} */ (form).reset();
      await loadAuthenticatedState(controller.signal);
      if (!isLive(operationGeneration, controller)) {
        return;
      }
    } catch (error) {
      if (!isLive(operationGeneration, controller) || isAbort(error)) {
        return;
      }
      state.error = errorMessage(error);
      state.authenticated = false;
      state.onboarding = null;
      state.totpEnrollment = null;
      /** @type {HTMLFormElement} */ (form).reset();
    } finally {
      releaseController(controller);
      if (isLive(operationGeneration)) {
        submitButton.disabled = false;
        render();
      }
    }
  }

  /**
   * @param {MouseEvent} event
   */
  async function handleClick(event) {
    const target = isElement(event.target) ? event.target.closest("[data-action]") : null;
    if (!isElement(target)) {
      return;
    }
    const action = target.getAttribute("data-action");
    if (action === "navigate") {
      if (state.pendingActions.has("create-activation-grant")) {
        state.notice = "正在生成账户密钥，请等待完整密钥显示后再离开";
        render();
        return;
      }
      const view = target.getAttribute("data-nav-view");
      if (isView(view)) {
        state.oneTimeActivation = null;
        state.currentView = view;
        state.notice = null;
        state.error = null;
        render();
      }
      return;
    }
    if (action === "dismiss-activation-key") {
      state.oneTimeActivation = null;
      state.notice = null;
      render();
      return;
    }
    if (action === "copy-activation-key" && state.oneTimeActivation !== null) {
      try {
        const clipboard = documentObject.defaultView?.navigator.clipboard;
        if (clipboard === undefined) {
          throw new Error("Clipboard unavailable");
        }
        await clipboard.writeText(state.oneTimeActivation.activationKey);
        state.notice = "完整密钥已复制；关闭卡片后无法再次查看";
        state.error = null;
      } catch {
        state.error = "浏览器未允许复制，请手动选中密钥复制";
      }
      render();
      return;
    }
    if (action === "revoke-activation-grant" && isButton(target)) {
      const grantId = target.getAttribute("data-grant-id");
      if (grantId !== null) {
        await runMutation(
          target,
          `revoke-activation-grant:${grantId}`,
          (signal) => api.revokeActivationGrant(grantId, signal),
          (result) => {
            const revoked = /** @type {ActivationGrant} */ (result);
            state.activationGrants = state.activationGrants.map((grant) =>
              grant.id === revoked.id ? revoked : grant,
            );
            if (state.oneTimeActivation?.grant.id === revoked.id) {
              state.oneTimeActivation = null;
            }
            state.notice = "账户密钥已撤销";
          },
          null,
        );
      }
      return;
    }
    if (action === "cancel-linked-user") {
      if (state.pendingActions.has("bind-linked-user")) {
        return;
      }
      state.bindingTargetUserId = null;
      state.error = null;
      render();
      return;
    }
    if (
      action === "confirm-linked-user" &&
      isButton(target) &&
      state.principal?.linkedUserId === null &&
      state.bindingTargetUserId !== null
    ) {
      const userId = state.bindingTargetUserId;
      const targetUser = state.users.find((user) => user.id === userId && user.status === "ACTIVE");
      if (targetUser === undefined) {
        state.bindingTargetUserId = null;
        state.error = "请选择已加载的活跃普通账号";
        render();
        return;
      }
      await runMutation(
        target,
        "bind-linked-user",
        (signal) => api.bindLinkedUser(userId, signal),
        () => {
          if (state.principal !== null) {
            state.principal = { ...state.principal, linkedUserId: userId };
          }
          state.bindingTargetUserId = null;
          state.notice = "普通账号绑定成功";
        },
        fetchBindingProjection,
      );
      return;
    }
    if (action === "logout" && isButton(target)) {
      if (state.pendingActions.has("create-activation-grant")) {
        state.notice = "正在生成账户密钥，请等待完整密钥显示后再退出";
        render();
        return;
      }
      await runMutation(
        target,
        "logout",
        (signal) => api.logout(signal),
        () => {
          state.authenticated = false;
          state.principal = null;
          state.onboarding = null;
          state.totpEnrollment = null;
          state.users = [];
          state.rooms = [];
          state.auditEvents = [];
          state.activationGrants = [];
          state.oneTimeActivation = null;
        },
        null,
      );
      return;
    }
    if (action === "approve-user" && isButton(target)) {
      const userId = target.getAttribute("data-user-id");
      if (userId !== null) {
        await runMutation(
          target,
          `approve:${userId}`,
          (signal) => api.approveUser(userId, signal),
          () => {
            applyApprovalSuccess(userId);
            state.notice = "账号已批准";
          },
          fetchApprovalProjection,
        );
      }
      return;
    }
    if (action === "view-devices" && isButton(target)) {
      const userId = target.getAttribute("data-user-id");
      if (userId !== null) {
        const operationGeneration = generation;
        const controller = beginTransientRead();
        try {
          const result = /** @type {{ devices: AdminDevice[] }} */ (
            await api.listUserDevices(userId, controller.signal)
          );
          if (!isLive(operationGeneration, controller)) {
            return;
          }
          state.devicesByUserId.set(userId, result.devices);
          state.selectedUserId = userId;
          state.error = null;
        } catch (error) {
          if (isLive(operationGeneration, controller) && !isAbort(error)) {
            state.error = errorMessage(error);
          }
        } finally {
          releaseController(controller);
        }
        if (isLive(operationGeneration)) {
          render();
        }
      }
      return;
    }
    if (action === "open-room" && isButton(target)) {
      const roomId = target.getAttribute("data-room-id");
      const room = state.rooms.find((candidate) => candidate.roomId === roomId);
      if (room !== undefined) {
        const operationGeneration = generation;
        const controller = beginTransientRead();
        state.drawerReturnFocus = focusTokenForElement(target);
        try {
          const result = /** @type {{ members: RoomMember[] }} */ (
            await api.listRoomMembers(room.roomId, controller.signal)
          );
          if (!isLive(operationGeneration, controller)) {
            return;
          }
          state.drawer = { room, members: result.members, confirmation: null, error: null };
          state.focusIntent = "drawer-initial";
        } catch (error) {
          if (isLive(operationGeneration, controller) && !isAbort(error)) {
            state.error = errorMessage(error);
          }
        } finally {
          releaseController(controller);
        }
        if (isLive(operationGeneration)) {
          render();
        }
      }
      return;
    }
    if (action === "close-drawer") {
      closeDrawer();
      return;
    }
    if (action === "cancel-confirmation" && state.drawer !== null) {
      if (state.pendingActions.has(roomLockKey(state.drawer.room.roomId))) {
        return;
      }
      state.drawer.confirmation = null;
      state.drawer.error = null;
      render();
      return;
    }
    if (action === "prepare-room-action" && state.drawer !== null) {
      if (state.pendingActions.has(roomLockKey(state.drawer.room.roomId))) {
        return;
      }
      const roomAction = target.getAttribute("data-room-action");
      if (roomAction === "soft-delete" || roomAction === "restore") {
        state.drawer.confirmation = buildRoomConfirmation(roomAction, state.drawer.room);
        state.drawer.error = null;
        render();
      } else if (roomAction === "transfer") {
        const select = root.querySelector('[data-field="transfer-target"]');
        if (isSelect(select) && select.value !== "") {
          const member = state.drawer.members.find(
            (candidate) => candidate.userId === select.value,
          );
          if (member !== undefined) {
            state.drawer.confirmation = buildRoomConfirmation("transfer", state.drawer.room, {
              newOwnerUserId: member.userId,
              newOwnerUsername: member.username,
            });
            state.drawer.error = null;
            render();
          }
        }
      }
      return;
    }
    if (
      action === "confirm-room-action" &&
      state.drawer?.confirmation !== null &&
      state.drawer !== null &&
      isButton(target)
    ) {
      const confirmation = state.drawer.confirmation;
      const transferTarget =
        confirmation.action === "transfer"
          ? state.drawer.members.find((member) => member.userId === confirmation.newOwnerUserId)
          : undefined;
      await runMutation(
        target,
        roomLockKey(confirmation.roomId),
        async (signal) => {
          if (confirmation.action === "soft-delete") {
            await api.softDeleteRoom(confirmation.roomId, confirmation.reasonCode, signal);
          } else if (confirmation.action === "restore") {
            await api.restoreRoom(confirmation.roomId, confirmation.reasonCode, signal);
          } else {
            await api.transferOwnership(
              confirmation.roomId,
              confirmation.newOwnerUserId ?? "",
              confirmation.reasonCode,
              signal,
            );
          }
        },
        () => {
          applyRoomSuccess(confirmation, transferTarget);
          closeDrawer(false);
          state.notice = "房间状态已更新";
        },
        fetchRoomProjection,
        true,
      );
    }
  }

  /**
   * @param {Event} event
   */
  function handleChange(event) {
    if (!isInput(event.target) && !isSelect(event.target)) {
      return;
    }
    const field = event.target.getAttribute("data-filter");
    if (field === "user-query") {
      state.userFilters.query = event.target.value;
    } else if (field === "user-status" && isUserStatusFilter(event.target.value)) {
      state.userFilters.status = event.target.value;
    } else if (field === "room-query") {
      state.roomFilters.query = event.target.value;
    } else if (field === "room-lifecycle" && isLifecycleFilter(event.target.value)) {
      state.roomFilters.lifecycle = event.target.value;
    } else if (field === "room-quota" && isQuotaFilter(event.target.value)) {
      state.roomFilters.quotaClass = event.target.value;
    } else if (field === "room-sort" && isRoomSort(event.target.value)) {
      state.roomFilters.sortBy = event.target.value;
    } else if (field === "room-direction" && isSortDirection(event.target.value)) {
      state.roomFilters.direction = event.target.value;
    } else {
      return;
    }
    render();
  }

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (state.drawer === null) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const dialog = root.querySelector('[data-region="drawer"]');
    if (!isElement(dialog)) {
      return;
    }
    const focusable = [...dialog.querySelectorAll("button, input, select, [tabindex]")].filter(
      (element) =>
        isFocusableElement(element) &&
        (!("disabled" in element) || element.disabled !== true) &&
        element.getAttribute("tabindex") !== "-1",
    );
    if (focusable.length === 0) {
      event.preventDefault();
      if (isFocusableElement(dialog)) {
        dialog.focus();
      }
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (
      (!event.shiftKey && documentObject.activeElement === last) ||
      (event.shiftKey && documentObject.activeElement === first)
    ) {
      event.preventDefault();
      const destination = event.shiftKey ? last : first;
      if (isFocusableElement(destination)) {
        destination.focus();
      }
    }
  }

  /** @param {string} userId */
  function applyApprovalSuccess(userId) {
    const approved = state.users.find((user) => user.id === userId && user.status === "PENDING");
    state.users = state.users.map((user) =>
      user.id === userId ? { ...user, status: /** @type {const} */ ("ACTIVE") } : user,
    );
    if (approved !== undefined) {
      state.diagnostics = {
        ...state.diagnostics,
        counts: {
          ...state.diagnostics.counts,
          pendingUsers: Math.max(0, state.diagnostics.counts.pendingUsers - 1),
          activeUsers: state.diagnostics.counts.activeUsers + 1,
        },
      };
    }
  }

  /**
   * @param {ReturnType<typeof buildRoomConfirmation>} confirmation
   * @param {RoomMember | undefined} transferTarget
   */
  function applyRoomSuccess(confirmation, transferTarget) {
    const previous = state.rooms.find((room) => room.roomId === confirmation.roomId);
    state.rooms = state.rooms.map((room) => {
      if (room.roomId !== confirmation.roomId) {
        return room;
      }
      if (confirmation.action === "soft-delete") {
        return {
          ...room,
          lifecycle: /** @type {const} */ ("DELETED"),
          roomEpoch: room.roomEpoch + 1,
        };
      }
      if (confirmation.action === "restore") {
        return {
          ...room,
          lifecycle: /** @type {const} */ ("ACTIVE"),
          roomEpoch: room.roomEpoch + 1,
        };
      }
      return transferTarget === undefined
        ? room
        : {
            ...room,
            ownerUserId: transferTarget.userId,
            ownerUsername: transferTarget.username,
          };
    });
    const roomDelta =
      confirmation.action === "soft-delete" && previous?.lifecycle === "ACTIVE"
        ? -1
        : confirmation.action === "restore" && previous?.lifecycle === "DELETED"
          ? 1
          : 0;
    if (roomDelta !== 0) {
      state.diagnostics = {
        ...state.diagnostics,
        counts: {
          ...state.diagnostics.counts,
          rooms: Math.max(0, state.diagnostics.counts.rooms + roomDelta),
        },
      };
    }
  }

  /**
   * @param {boolean} [renderNow]
   */
  function closeDrawer(renderNow = true) {
    state.drawer = null;
    state.focusIntent = "drawer-return";
    if (renderNow) {
      render();
    }
  }

  /** @param {string} roomId */
  function roomLockKey(roomId) {
    return `room:${roomId}`;
  }

  /**
   * @param {HTMLButtonElement} button
   * @param {string} key
   * @param {(signal: AbortSignal) => Promise<unknown>} operation
   * @param {(result: unknown) => void} onWriteSuccess
   * @param {((signal: AbortSignal) => Promise<() => void>) | null} fetchProjection
   * @param {boolean} [preserveDrawerError]
   */
  async function runMutation(
    button,
    key,
    operation,
    onWriteSuccess,
    fetchProjection,
    preserveDrawerError = false,
  ) {
    if (!started || state.pendingActions.has(key)) {
      return;
    }
    const operationGeneration = generation;
    const controller = createController();
    state.pendingActions.add(key);
    button.disabled = true;
    state.error = null;
    state.notice = null;
    if (state.drawer !== null) {
      state.drawer.error = null;
    }
    let writeSucceeded = false;
    try {
      const result = await operation(controller.signal);
      if (!isLive(operationGeneration, controller)) {
        return;
      }
      writeSucceeded = true;
      onWriteSuccess(result);
      state.error = null;
      render();
      if (fetchProjection !== null) {
        await queueAuthoritativeRefresh(fetchProjection, operationGeneration);
        if (isLive(operationGeneration)) {
          state.refreshWarning = null;
        }
      }
    } catch (error) {
      if (!isLive(operationGeneration) || isAbort(error)) {
        return;
      }
      if (writeSucceeded) {
        state.refreshWarning =
          "操作已完成，但最新数据刷新失败。当前界面已按成功结果更新，请稍后重新登录核对。";
      } else {
        const message = errorMessage(error);
        if (preserveDrawerError && state.drawer !== null) {
          state.drawer.error = message;
        } else {
          state.error = message;
        }
      }
    } finally {
      releaseController(controller);
      state.pendingActions.delete(key);
      if (isLive(operationGeneration)) {
        button.disabled = false;
        render();
      }
    }
  }

  function render() {
    const retainedFocus = focusTokenForElement(documentObject.activeElement);
    root.replaceChildren();
    root.setAttribute("data-authenticated", String(state.authenticated));
    if (!state.authenticated) {
      root.append(renderLogin());
      restoreFocusAfterRender(retainedFocus);
      return;
    }
    if (
      state.onboarding !== null &&
      (state.onboarding.passwordChangeRequired || state.onboarding.totpEnrollmentRequired)
    ) {
      root.append(renderOnboarding());
      restoreFocusAfterRender(retainedFocus);
      return;
    }
    const shell = node("div", "console-shell");
    shell.append(renderSidebar());
    const main = node("main", "console-main");
    main.append(renderHeader());
    if (state.error !== null) {
      const error = messageBanner(state.error, "danger");
      error.setAttribute("data-region", "mutation-error");
      main.append(error);
    }
    if (state.notice !== null) {
      const notice = messageBanner(state.notice, "success");
      notice.setAttribute("data-region", "mutation-notice");
      main.append(notice);
    }
    if (state.refreshWarning !== null) {
      const warning = messageBanner(state.refreshWarning, "warning");
      warning.setAttribute("data-region", "refresh-warning");
      main.append(warning);
    }
    const content = node("div", "console-content");
    if (state.principal?.linkedUserId === null) {
      content.append(renderLinkedUserBinding());
    }
    if (state.currentView === "overview") {
      content.append(renderOverview());
    } else if (state.currentView === "approvals") {
      content.append(sectionHeading("用户审批", "优先处理待审批账号"));
      content.append(renderPendingUsers());
    } else if (state.currentView === "activation-keys") {
      content.append(renderActivationKeys());
    } else if (state.currentView === "rooms") {
      content.append(renderRoomManagement());
    } else if (state.currentView === "users") {
      content.append(renderUsersAndDevices());
    } else if (state.currentView === "audit") {
      content.append(renderAudit());
    } else {
      content.append(renderDiagnostics());
    }
    main.append(content);
    shell.append(main);
    if (state.drawer !== null) {
      shell.append(renderDrawer(state.drawer));
    }
    root.append(shell);
    restoreFocusAfterRender(retainedFocus);
  }

  /** @param {unknown} value */
  function focusTokenForElement(value) {
    if (!isElement(value)) {
      return null;
    }
    /** @type {Record<string, string>} */
    const attributes = {};
    for (const name of [
      "data-action",
      "data-nav-view",
      "data-user-id",
      "data-room-id",
      "data-filter",
      "data-field",
      "name",
      "type",
    ]) {
      const attribute = value.getAttribute(name);
      if (attribute !== null) {
        attributes[name] = attribute;
      }
    }
    if (Object.keys(attributes).length === 0) {
      return null;
    }
    return { tagName: value.tagName, attributes };
  }

  /** @param {FocusToken | null} token */
  function findFocusToken(token) {
    if (token === null) {
      return null;
    }
    for (const candidate of root.querySelectorAll("button, input, select, [tabindex]")) {
      if (
        candidate.tagName === token.tagName &&
        Object.entries(token.attributes).every(
          ([name, value]) => candidate.getAttribute(name) === value,
        ) &&
        isFocusableElement(candidate)
      ) {
        return candidate;
      }
    }
    return null;
  }

  /** @param {FocusToken | null} retainedFocus */
  function restoreFocusAfterRender(retainedFocus) {
    if (state.focusIntent === "drawer-initial") {
      const close = root.querySelector('[data-action="close-drawer"]');
      if (isFocusableElement(close)) {
        close.focus();
      }
      state.focusIntent = null;
      return;
    }
    if (state.focusIntent === "drawer-return") {
      findFocusToken(state.drawerReturnFocus)?.focus();
      state.drawerReturnFocus = null;
      state.focusIntent = null;
      return;
    }
    findFocusToken(retainedFocus)?.focus();
  }

  function renderLogin() {
    const page = node("main", "login-page");
    const card = node("section", "login-card");
    const brand = node("div", "login-brand");
    const icon = documentObject.createElement("img");
    icon.src = "/syncaction-symbol.svg";
    icon.alt = "";
    icon.width = 44;
    icon.height = 44;
    brand.append(icon, textNode("div", "brand-title", "SyncAction 管理控制台"));
    card.append(brand);
    card.append(textNode("h1", "login-title", "超级管理员登录"));
    card.append(
      textNode("p", "login-description", "已完成设置的管理员需输入动态验证码；首次登录可以留空。"),
    );
    if (state.error !== null) {
      card.append(messageBanner(state.error, "danger"));
    }
    const form = documentObject.createElement("form");
    form.setAttribute("data-form", "login");
    const totpField = formField("动态验证码", "totp", "text", "one-time-code", "numeric");
    const totpInput = totpField.querySelector("input");
    if (isInput(totpInput)) {
      totpInput.required = false;
      totpInput.placeholder = "首次登录可留空";
    }
    form.append(
      formField("管理员账号", "username", "text", "username"),
      formField("管理员密码", "password", "password", "current-password"),
      totpField,
    );
    const submit = actionButton("登录", "primary");
    submit.type = "submit";
    form.append(submit);
    card.append(form);
    page.append(card);
    return page;
  }

  function renderOnboarding() {
    const page = node("main", "login-page onboarding-page");
    const card = node("section", "login-card onboarding-card");
    card.setAttribute("data-region", "administrator-onboarding");
    const brand = node("div", "login-brand");
    const icon = documentObject.createElement("img");
    icon.src = "/syncaction-symbol.svg";
    icon.alt = "";
    icon.width = 44;
    icon.height = 44;
    brand.append(icon, textNode("div", "brand-title", "SyncAction 管理控制台"));
    card.append(brand);
    card.append(textNode("h1", "login-title", "完成管理员设置"));
    card.append(
      textNode(
        "p",
        "login-description",
        state.onboarding?.passwordChangeRequired
          ? "请更换临时密码并绑定动态验证码，完成前不能使用管理功能。"
          : "当前生产密码将保持不变；绑定动态验证码后即可使用管理功能。",
      ),
    );
    if (state.error !== null) {
      card.append(messageBanner(state.error, "danger"));
    }
    if (state.onboarding?.totpEnrollmentRequired && state.totpEnrollment !== null) {
      const enrollment = node("section", "onboarding-enrollment");
      enrollment.append(textNode("h2", "onboarding-section-title", "绑定身份验证器"));
      enrollment.append(
        textNode("p", "onboarding-help", "在身份验证器中手动添加下方密钥，再输入当前六位验证码。"),
      );
      const secret = textNode("code", "onboarding-secret", state.totpEnrollment.secret);
      secret.setAttribute("aria-label", "TOTP Base32 密钥");
      const uri = textNode("code", "onboarding-uri", state.totpEnrollment.otpauthUri);
      uri.setAttribute("aria-label", "TOTP enrollment URI");
      enrollment.append(secret, uri);
      card.append(enrollment);
    }
    const form = documentObject.createElement("form");
    form.setAttribute("data-form", "administrator-onboarding");
    if (state.onboarding?.passwordChangeRequired) {
      form.append(
        formField("新管理员密码", "newPassword", "password", "new-password"),
        formField("再次输入新密码", "newPasswordConfirmation", "password", "new-password"),
      );
      form.append(
        textNode("p", "onboarding-password-rule", "使用 12–128 个字符，避免复用其他账号密码。"),
      );
    }
    form.append(formField("当前六位动态验证码", "totp", "text", "one-time-code", "numeric"));
    const actions = node("div", "onboarding-actions");
    const submit = actionButton("完成设置", "primary");
    submit.type = "submit";
    const logout = actionButton("退出登录", "secondary");
    logout.setAttribute("data-action", "logout");
    actions.append(submit, logout);
    form.append(actions);
    card.append(form);
    page.append(card);
    return page;
  }

  function renderSidebar() {
    const sidebar = node("aside", "console-sidebar");
    const brand = node("div", "sidebar-brand");
    const icon = documentObject.createElement("img");
    icon.src = "/syncaction-symbol.svg";
    icon.alt = "";
    icon.width = 30;
    icon.height = 30;
    brand.append(icon, textNode("span", "sidebar-brand-text", "SyncAction"));
    sidebar.append(brand);
    const nav = documentObject.createElement("nav");
    nav.setAttribute("aria-label", "管理员一级导航");
    for (const [view, label] of navigation) {
      const button = actionButton(label, "nav");
      button.setAttribute("data-action", "navigate");
      button.setAttribute("data-nav-view", view);
      button.setAttribute("aria-current", state.currentView === view ? "page" : "false");
      nav.append(button);
    }
    sidebar.append(nav);
    const identity = node("div", "sidebar-identity");
    identity.append(
      textNode("strong", "", state.principal?.username ?? "管理员"),
      textNode(
        "span",
        "",
        state.principal?.linkedUserId === null ? "尚未绑定普通账号" : "已绑定豁免账号",
      ),
    );
    const logout = actionButton("退出登录", "quiet");
    logout.setAttribute("data-action", "logout");
    identity.append(logout);
    sidebar.append(identity);
    return sidebar;
  }

  function renderLinkedUserBinding() {
    const section = node("section", "binding-card");
    section.setAttribute("data-region", "linked-user-binding");
    const heading = node("div", "binding-heading");
    heading.append(
      textNode("h2", "", "一次性绑定普通账号"),
      textNode("p", "", "绑定活跃普通账号后，其房间获得管理员配额豁免。"),
    );
    section.append(heading);
    const activeUsers = selectUsers(state.users, {
      status: "ACTIVE",
      sortBy: "username",
      direction: "asc",
    });
    if (state.bindingTargetUserId === null) {
      const form = documentObject.createElement("form");
      form.setAttribute("data-form", "prepare-linked-user");
      const field = node("label", "form-field");
      field.append(textNode("span", "", "已加载的活跃普通账号"));
      const select = documentObject.createElement("select");
      select.name = "linkedUserId";
      select.required = true;
      select.setAttribute("aria-label", "选择要绑定的活跃普通账号");
      const placeholder = documentObject.createElement("option");
      placeholder.value = "";
      placeholder.textContent =
        activeUsers.length === 0 ? "没有已加载的活跃普通账号" : "选择普通账号";
      select.append(placeholder);
      for (const user of activeUsers) {
        const option = documentObject.createElement("option");
        option.value = user.id;
        option.textContent = `@${user.username} · ${user.displayName}`;
        select.append(option);
      }
      field.append(select);
      const prepare = actionButton("检查绑定信息", "primary");
      prepare.type = "submit";
      prepare.disabled = activeUsers.length === 0 || state.pendingActions.has("bind-linked-user");
      form.append(field, prepare);
      section.append(form);
      return section;
    }
    const targetUser = activeUsers.find((user) => user.id === state.bindingTargetUserId);
    const confirmation = node("div", "binding-confirmation");
    confirmation.setAttribute("data-region", "binding-confirmation");
    confirmation.append(
      textNode("h3", "", "确认一次性绑定"),
      textNode("p", "", "即将绑定到以下已加载的活跃普通账号："),
    );
    const identity = node("dl", "binding-identity");
    for (const [label, value] of [
      ["账号", targetUser === undefined ? "不可用" : `@${targetUser.username}`],
      ["显示名称", targetUser?.displayName ?? "不可用"],
      ["userId", state.bindingTargetUserId],
      ["状态", targetUser === undefined ? "不可用" : userStatusLabel(targetUser.status)],
    ]) {
      const item = node("div", "");
      item.append(textNode("dt", "", String(label)), textNode("dd", "", String(value)));
      identity.append(item);
    }
    confirmation.append(
      identity,
      textNode("p", "binding-warning", "绑定后不能更改，请再次核对账号标识。"),
    );
    const actions = node("div", "binding-actions");
    const cancel = actionButton("返回修改", "quiet");
    cancel.setAttribute("data-action", "cancel-linked-user");
    cancel.disabled = state.pendingActions.has("bind-linked-user");
    const confirm = actionButton("确认绑定", "warning");
    confirm.setAttribute("data-action", "confirm-linked-user");
    confirm.disabled = targetUser === undefined || state.pendingActions.has("bind-linked-user");
    actions.append(cancel, confirm);
    confirmation.append(actions);
    section.append(confirmation);
    return section;
  }

  function renderHeader() {
    const header = node("header", "console-header");
    const title = navigation.find(([view]) => view === state.currentView)?.[1] ?? "概览";
    header.append(
      textNode("div", "header-context", "超级管理员工作区"),
      textNode("h1", "header-title", title),
    );
    const status = textNode("span", "service-status", "本机管理服务 · 已连接");
    status.setAttribute("data-tone", "success");
    header.append(status);
    return header;
  }

  function renderOverview() {
    const fragment = documentObject.createDocumentFragment();
    fragment.append(sectionHeading("审批与容量概览", "先处理准入，再观察普通房间容量"));
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
    fragment.append(metrics);
    const grid = node("div", "overview-grid");
    const approvals = panel("待审批账号", "按注册时间优先");
    approvals.append(renderPendingUsers());
    const capacity = panel("房间容量", "只显示数量与账号标识");
    capacity.append(renderRoomCapacity());
    grid.append(approvals, capacity);
    fragment.append(grid);
    return fragment;
  }

  function renderPendingUsers() {
    const pendingUsers = selectUsers(state.users, {
      status: "PENDING",
      sortBy: "createdAt",
      direction: "asc",
    });
    if (pendingUsers.length === 0) {
      return emptyState("当前没有待审批账号");
    }
    const table = baseTable(["账号", "显示名称", "注册时间", "状态", "操作"]);
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
    if (isInput(noteInput)) {
      noteInput.maxLength = 120;
      noteInput.placeholder = "例如：Alice / 设计组笔记本";
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
    fragment.append(sectionHeading("房间管理", "筛选、排序并从详情抽屉执行危险操作"));
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
    return fragment;
  }

  function renderUsersAndDevices() {
    const fragment = documentObject.createDocumentFragment();
    fragment.append(sectionHeading("用户与设备", "查看账号状态与当前可用设备会话"));
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

  /**
   * @param {DrawerState} drawer
   */
  function renderDrawer(drawer) {
    const backdrop = node("div", "drawer-backdrop");
    const aside = node("aside", "details-drawer");
    aside.setAttribute("data-region", "drawer");
    aside.setAttribute("aria-label", "房间详情与危险操作");
    aside.setAttribute("role", "dialog");
    aside.setAttribute("aria-modal", "true");
    aside.tabIndex = -1;
    const header = node("header", "drawer-header");
    const titleGroup = node("div", "");
    const name = presentName(drawer.room.name, 32);
    const title = textNode("h2", "", name.text);
    if (name.title !== null) {
      title.title = name.title;
    }
    titleGroup.append(title, textNode("span", "muted", drawer.room.roomId));
    const close = actionButton("关闭", "quiet");
    close.setAttribute("data-action", "close-drawer");
    header.append(titleGroup, close);
    aside.append(header);
    if (drawer.error !== null) {
      aside.append(messageBanner(drawer.error, "danger"));
    }
    if (drawer.confirmation === null) {
      aside.append(renderDrawerDetails(drawer));
    } else {
      aside.append(renderConfirmation(drawer));
    }
    backdrop.append(aside);
    return backdrop;
  }

  /**
   * @param {DrawerState} drawer
   */
  function renderDrawerDetails(drawer) {
    const content = node("div", "drawer-content");
    const roomLocked = state.pendingActions.has(roomLockKey(drawer.room.roomId));
    const facts = node("dl", "room-facts");
    for (const [label, value] of [
      ["所有者", `@${drawer.room.ownerUsername}`],
      ["成员数", drawer.room.memberCount],
      ["打开标签", drawer.room.openTabCount],
      ["配额类别", quotaClassLabel(drawer.room.quotaClass)],
      ["生命周期", lifecycleLabel(drawer.room.lifecycle)],
      ["服务器序号", drawer.room.serverSeq],
    ]) {
      const item = node("div", "");
      item.append(textNode("dt", "", String(label)), textNode("dd", "", String(value)));
      facts.append(item);
    }
    content.append(facts);
    content.append(textNode("h3", "drawer-section-title", "成员"));
    const memberList = node("div", "member-list");
    for (const member of drawer.members) {
      const row = node("div", "member-row");
      row.append(
        textNode("strong", "", `@${member.username}`),
        textNode("span", "muted", member.role === "OWNER" ? "所有者" : "成员"),
        textNode("span", "muted", userStatusLabel(member.status)),
      );
      memberList.append(row);
    }
    content.append(memberList);
    content.append(textNode("h3", "drawer-section-title", "危险操作"));
    const actions = node("div", "drawer-actions");
    if (drawer.room.lifecycle === "ACTIVE") {
      const targetMembers = drawer.members.filter(
        (member) => member.role === "MEMBER" && member.status === "ACTIVE",
      );
      if (targetMembers.length > 0) {
        const select = documentObject.createElement("select");
        select.setAttribute("data-field", "transfer-target");
        select.setAttribute("aria-label", "新的房间所有者");
        select.disabled = roomLocked;
        const placeholder = documentObject.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "选择新的所有者";
        select.append(placeholder);
        for (const member of targetMembers) {
          const option = documentObject.createElement("option");
          option.value = member.userId;
          option.textContent = `@${member.username}`;
          select.append(option);
        }
        actions.append(select);
        const transfer = actionButton("准备转移", "warning");
        transfer.setAttribute("data-action", "prepare-room-action");
        transfer.setAttribute("data-room-action", "transfer");
        transfer.disabled = roomLocked;
        actions.append(transfer);
      }
      const remove = actionButton("准备软删除", "danger");
      remove.setAttribute("data-action", "prepare-room-action");
      remove.setAttribute("data-room-action", "soft-delete");
      remove.disabled = roomLocked;
      actions.append(remove);
    } else {
      const restore = actionButton("准备恢复", "warning");
      restore.setAttribute("data-action", "prepare-room-action");
      restore.setAttribute("data-room-action", "restore");
      restore.disabled = roomLocked;
      actions.append(restore);
    }
    content.append(actions);
    return content;
  }

  /**
   * @param {DrawerState} drawer
   */
  function renderConfirmation(drawer) {
    const confirmation = drawer.confirmation;
    if (confirmation === null) {
      return node("div", "");
    }
    const content = node("div", "drawer-content confirmation-view");
    content.append(
      textNode("h3", "confirmation-title", confirmation.title),
      textNode("p", "confirmation-summary", confirmation.summary),
    );
    const impact = documentObject.createElement("ul");
    impact.className = "impact-list";
    for (const line of confirmation.impact) {
      impact.append(textNode("li", "", line));
    }
    content.append(impact);
    const callout = textNode("p", "confirmation-callout", "此操作需要再次明确确认。");
    callout.setAttribute("data-tone", confirmation.tone);
    content.append(callout);
    const actions = node("div", "confirmation-actions");
    const back = actionButton("返回详情", "quiet");
    back.setAttribute("data-action", "cancel-confirmation");
    const roomLocked = state.pendingActions.has(roomLockKey(confirmation.roomId));
    back.disabled = roomLocked;
    const confirm = actionButton(confirmation.confirmLabel, confirmation.tone);
    confirm.setAttribute("data-action", "confirm-room-action");
    confirm.disabled = roomLocked;
    actions.append(back, confirm);
    content.append(actions);
    return content;
  }

  /**
   * @param {string} title
   * @param {string} description
   */
  function sectionHeading(title, description) {
    const heading = node("div", "section-heading");
    heading.append(textNode("h2", "", title), textNode("p", "", description));
    return heading;
  }

  /**
   * @param {string} title
   * @param {string} description
   */
  function panel(title, description) {
    const section = node("section", "panel");
    const heading = node("header", "panel-heading");
    heading.append(textNode("h3", "", title), textNode("span", "", description));
    section.append(heading);
    return section;
  }

  /**
   * @param {string[]} headers
   */
  function baseTable(headers) {
    const table = documentObject.createElement("table");
    table.className = "data-table";
    const head = table.createTHead();
    const row = head.insertRow();
    for (const header of headers) {
      const cell = documentObject.createElement("th");
      cell.scope = "col";
      cell.textContent = header;
      row.append(cell);
    }
    table.createTBody();
    return table;
  }

  /**
   * @param {HTMLTableElement} table
   */
  function tableBody(table) {
    const body = table.tBodies.item(0);
    if (body === null) {
      throw new Error("TABLE_BODY_MISSING");
    }
    return body;
  }

  /**
   * @param {HTMLTableRowElement} row
   * @param {string | ReturnType<typeof presentName>} value
   * @param {string} [className]
   */
  function appendCell(row, value, className = "") {
    const cell = row.insertCell();
    if (className !== "") {
      cell.className = className;
    }
    if (typeof value === "string") {
      cell.textContent = value;
    } else {
      cell.textContent = value.text;
      if (value.title !== null) {
        cell.title = value.title;
      }
    }
  }

  /**
   * @param {HTMLTableRowElement} row
   * @param {string} label
   * @param {string} tone
   */
  function appendPillCell(row, label, tone) {
    const cell = row.insertCell();
    const pill = textNode("span", "status-pill", label);
    pill.setAttribute("data-tone", tone);
    cell.append(pill);
  }

  /**
   * @param {string} label
   * @param {string} name
   * @param {string} type
   * @param {string} autocomplete
   * @param {string} [inputMode]
   */
  function formField(label, name, type, autocomplete, inputMode) {
    const wrapper = node("label", "form-field");
    wrapper.append(textNode("span", "", label));
    const input = documentObject.createElement("input");
    input.name = name;
    input.type = type;
    input.setAttribute("autocomplete", autocomplete);
    input.required = true;
    if (inputMode !== undefined) {
      input.inputMode = inputMode;
    }
    wrapper.append(input);
    return wrapper;
  }

  /**
   * @param {string} placeholder
   * @param {string} field
   * @param {string} value
   */
  function filterInput(placeholder, field, value) {
    const input = documentObject.createElement("input");
    input.type = "search";
    input.placeholder = placeholder;
    input.value = value;
    input.setAttribute("aria-label", placeholder);
    input.setAttribute("data-filter", field);
    return input;
  }

  /**
   * @param {string} label
   * @param {string} field
   * @param {string} value
   * @param {Array<[string, string]>} choices
   */
  function filterSelect(label, field, value, choices) {
    const select = documentObject.createElement("select");
    select.setAttribute("aria-label", label);
    select.setAttribute("data-filter", field);
    for (const [choiceValue, choiceLabel] of choices) {
      const option = documentObject.createElement("option");
      option.value = choiceValue;
      option.textContent = choiceLabel;
      select.append(option);
    }
    select.value = value;
    return select;
  }

  /**
   * @param {string} label
   * @param {string} variant
   */
  function actionButton(label, variant) {
    const button = documentObject.createElement("button");
    button.type = "button";
    button.className = `button button-${variant}`;
    button.textContent = label;
    return button;
  }

  /**
   * @param {string} message
   * @param {string} tone
   */
  function messageBanner(message, tone) {
    const banner = textNode("div", "message-banner", message);
    banner.setAttribute("role", tone === "danger" ? "alert" : "status");
    banner.setAttribute("data-tone", tone);
    return banner;
  }

  /**
   * @param {string} message
   */
  function emptyState(message) {
    return textNode("p", "empty-state", message);
  }

  /**
   * @param {keyof HTMLElementTagNameMap} tag
   * @param {string} className
   */
  function node(tag, className) {
    const element = documentObject.createElement(tag);
    if (className !== "") {
      element.className = className;
    }
    return element;
  }

  /**
   * @param {keyof HTMLElementTagNameMap} tag
   * @param {string} className
   * @param {string} text
   */
  function textNode(tag, className, text) {
    const element = node(tag, className);
    element.textContent = text;
    return element;
  }

  return { start, destroy, getState: () => state };
}

/**
 * @param {unknown} value
 * @returns {value is Element}
 */
function isElement(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "closest" in value &&
    typeof value.closest === "function"
  );
}

/**
 * @param {unknown} value
 * @returns {value is HTMLElement}
 */
function isFocusableElement(value) {
  return (
    isElement(value) &&
    "focus" in value &&
    typeof (/** @type {{ focus?: unknown }} */ (value).focus) === "function"
  );
}

/**
 * @param {unknown} value
 * @returns {value is HTMLButtonElement}
 */
function isButton(value) {
  return isElement(value) && value.tagName === "BUTTON";
}

/**
 * @param {unknown} value
 * @returns {value is HTMLInputElement}
 */
function isInput(value) {
  return isElement(value) && value.tagName === "INPUT";
}

/**
 * @param {unknown} value
 * @returns {value is HTMLSelectElement}
 */
function isSelect(value) {
  return isElement(value) && value.tagName === "SELECT";
}

/**
 * @param {Element} form
 * @param {string} name
 */
function formValue(form, name) {
  const input = form.querySelector(`input[name="${name}"]`);
  return isInput(input) ? input.value : "";
}

/**
 * @param {string | null} value
 * @returns {value is ConsoleState["currentView"]}
 */
function isView(value) {
  return navigation.some(([view]) => view === value);
}

/**
 * @param {string} value
 * @returns {value is ConsoleState["userFilters"]["status"]}
 */
function isUserStatusFilter(value) {
  return ["ALL", "PENDING", "ACTIVE", "SUSPENDED", "REVOKED"].includes(value);
}

/**
 * @param {string} value
 * @returns {value is ConsoleState["roomFilters"]["lifecycle"]}
 */
function isLifecycleFilter(value) {
  return ["ALL", "ACTIVE", "DELETED"].includes(value);
}

/**
 * @param {string} value
 * @returns {value is ConsoleState["roomFilters"]["quotaClass"]}
 */
function isQuotaFilter(value) {
  return ["ALL", "ORDINARY", "EXEMPT"].includes(value);
}

/**
 * @param {string} value
 * @returns {value is ConsoleState["roomFilters"]["sortBy"]}
 */
function isRoomSort(value) {
  return ["name", "ownerUsername", "memberCount", "openTabCount", "serverSeq"].includes(value);
}

/**
 * @param {string} value
 * @returns {value is ConsoleState["roomFilters"]["direction"]}
 */
function isSortDirection(value) {
  return value === "asc" || value === "desc";
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
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * @param {unknown} error
 */
function isUnauthorized(error) {
  return (
    (error instanceof AdminApiError && error.status === 401) ||
    (typeof error === "object" && error !== null && "status" in error && error.status === 401)
  );
}

/**
 * @param {unknown} error
 */
function isAbort(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * @param {unknown} error
 */
function errorMessage(error) {
  const code =
    error instanceof AdminApiError
      ? error.code
      : error instanceof Error
        ? error.message
        : "ADMIN_REQUEST_FAILED";
  const labels = {
    ADMIN_INVALID_CREDENTIALS: "管理员账号、密码或动态验证码无效",
    ADMIN_SESSION_INVALID: "管理员会话已失效，请重新登录",
    ADMIN_LINK_ALREADY_SET: "普通账号已绑定，不能再次绑定",
    ADMIN_LINK_TARGET_INVALID: "目标普通账号不存在或尚未激活",
    ORDINARY_ROOM_LIMIT_REACHED: "普通房间容量已满",
    ROOM_TAB_LIMIT_REACHED: "目标房间打开标签页超过普通配额",
    INVALID_ROOM_TRANSITION: "房间状态已变化，请刷新后重试",
    ROOM_NOT_FOUND: "房间不存在或已不可用",
    RATE_LIMITED: "请求过于频繁，请稍后重试",
  };
  return /** @type {Record<string, string>} */ (labels)[code] ?? code;
}

if (typeof document !== "undefined") {
  const automaticRoot = document.querySelector("[data-admin-app]");
  if (automaticRoot instanceof HTMLElement) {
    const consoleApp = createConsoleApp({
      root: automaticRoot,
      document,
    });
    void consoleApp.start();
  }
}
