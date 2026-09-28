import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { createDatabase } from "@syncaction/database";
import { IdentityError, type AdminService } from "@syncaction/identity";
import type { RoomService } from "@syncaction/rooms";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminApi } from "../public/api.js";
import { createConsoleApp } from "../public/app.js";
import { buildAdminApp } from "../src/app.js";
import type { AdminCookieConfig } from "../src/config.js";

const publicOrigin = "https://admin.syncaction.example.com";
const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const cookie: AdminCookieConfig = {
  name: "syncaction_admin_session",
  httpOnly: true,
  sameSite: "strict",
  path: "/",
  maxAgeSeconds: 28_800,
  secure: true,
};
const openApps: Array<Awaited<ReturnType<typeof buildAdminApp>>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("administrator console API client", () => {
  it("uses only relative same-origin credentialed fetches and never carries credentials forward", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        void _input;
        void _init;
        return new Response(JSON.stringify({ rooms: [], administrator: { id: "admin" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const api = createAdminApi(fetchMock);

    await api.login({
      username: "SyncAdmin",
      password: "administrator horse battery",
      totp: "123456",
    });
    await api.listRooms({ lifecycle: "ACTIVE", quotaClass: "EXEMPT", limit: 25 });
    await api.bindLinkedUser("user-linked");
    await api.me();
    await api.onboarding();
    await api.totpEnrollment();
    await api.completeOnboarding({
      newPassword: "replacement administrator password",
      totp: "654321",
    });
    await api.listActivationGrants();
    await api.createActivationGrant("Alice / design team");
    await api.revokeActivationGrant("grant-1");

    expect(fetchMock).toHaveBeenCalledTimes(10);
    const [loginUrl, loginInit] = fetchMock.mock.calls[0] ?? [];
    expect(loginUrl).toBe("/v1/admin/auth/login");
    expect(loginInit?.credentials).toBe("same-origin");
    expect(new Headers(loginInit?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(loginInit?.body))).toEqual({
      username: "SyncAdmin",
      password: "administrator horse battery",
      totp: "123456",
    });
    const [roomsUrl, roomsInit] = fetchMock.mock.calls[1] ?? [];
    expect(roomsUrl).toBe("/v1/admin/rooms?lifecycle=ACTIVE&quotaClass=EXEMPT&limit=25");
    expect(roomsInit?.credentials).toBe("same-origin");
    const [bindingUrl, bindingInit] = fetchMock.mock.calls[2] ?? [];
    expect(bindingUrl).toBe("/v1/admin/me/linked-user");
    expect(bindingInit?.credentials).toBe("same-origin");
    expect(JSON.parse(String(bindingInit?.body))).toEqual({ userId: "user-linked" });
    const [meUrl, meInit] = fetchMock.mock.calls[3] ?? [];
    expect(meUrl).toBe("/v1/admin/me");
    expect(meInit?.body).toBeUndefined();
    expect(new Headers(meInit?.headers).has("cookie")).toBe(false);
    expect(new Headers(meInit?.headers).has("authorization")).toBe(false);
    const [onboardingUrl] = fetchMock.mock.calls[4] ?? [];
    expect(onboardingUrl).toBe("/v1/admin/onboarding");
    const [enrollmentUrl] = fetchMock.mock.calls[5] ?? [];
    expect(enrollmentUrl).toBe("/v1/admin/onboarding/totp");
    const [completionUrl, completionInit] = fetchMock.mock.calls[6] ?? [];
    expect(completionUrl).toBe("/v1/admin/onboarding/complete");
    expect(JSON.parse(String(completionInit?.body))).toEqual({
      newPassword: "replacement administrator password",
      totp: "654321",
    });
    const [grantListUrl, grantListInit] = fetchMock.mock.calls[7] ?? [];
    expect(grantListUrl).toBe("/v1/admin/account-activation-grants");
    expect(grantListInit?.credentials).toBe("same-origin");
    const [grantCreateUrl, grantCreateInit] = fetchMock.mock.calls[8] ?? [];
    expect(grantCreateUrl).toBe("/v1/admin/account-activation-grants");
    expect(JSON.parse(String(grantCreateInit?.body))).toEqual({ note: "Alice / design team" });
    const [grantRevokeUrl, grantRevokeInit] = fetchMock.mock.calls[9] ?? [];
    expect(grantRevokeUrl).toBe("/v1/admin/account-activation-grants/grant-1/revoke");
    expect(JSON.parse(String(grantRevokeInit?.body))).toEqual({});
    expect(JSON.stringify(api)).not.toMatch(/123456|horse battery|cookie/iu);
  });
});

describe("administrator console rendering", () => {
  it("renders the authenticated approval-first console and requires a second room-action step", async () => {
    const window = new Window({ url: publicOrigin });
    const root = window.document.createElement("div");
    window.document.body.append(root);
    const approval = deferred<unknown>();
    const roomMutation = deferred<unknown>();
    let approvalSucceeded = false;
    let roomDeleted = false;
    const api = {
      onboarding: vi.fn(async () => ({
        administrator: {
          id: "admin-1",
          username: "SyncAdmin",
          linkedUserId: "user-linked",
        },
        onboarding: {
          passwordChangeRequired: false,
          totpEnrollmentRequired: false,
        },
      })),
      me: vi.fn(async () => ({
        administratorId: "admin-1",
        username: "SyncAdmin",
        linkedUserId: "user-linked",
        sessionId: "session-1",
      })),
      listUsers: vi.fn(async () => ({
        users: approvalSucceeded
          ? []
          : [
              {
                id: "user-pending",
                username: "pending-user",
                displayName: "待审批用户",
                status: "PENDING",
                passwordResetRequired: false,
                createdAt: "2026-07-27T01:00:00.000Z",
                updatedAt: "2026-07-27T01:00:00.000Z",
              },
            ],
        total: approvalSucceeded ? 0 : 1,
      })),
      listRooms: vi.fn(async () => ({
        rooms: [
          {
            roomId: "room-exempt",
            name: "管理员协作房间",
            ownerUserId: "user-linked",
            ownerUsername: "linked-user",
            memberCount: 2,
            openTabCount: 21,
            roomEpoch: 0,
            serverSeq: 22,
            lifecycle: roomDeleted ? "DELETED" : "ACTIVE",
            quotaClass: "EXEMPT",
          },
        ],
      })),
      diagnostics: vi.fn(async () => ({
        database: "ready",
        counts: {
          users: 1,
          pendingUsers: approvalSucceeded ? 0 : 1,
          activeUsers: approvalSucceeded ? 1 : 0,
          suspendedUsers: 0,
          revokedUsers: 0,
          rooms: roomDeleted ? 0 : 1,
          activeDeviceSessions: 2,
        },
      })),
      listAuditEvents: vi.fn(async () => ({ events: [] })),
      listRoomMembers: vi.fn(async () => ({
        members: [
          {
            userId: "user-linked",
            username: "linked-user",
            displayName: "Linked User",
            status: "ACTIVE",
            role: "OWNER",
            createdAt: "2026-07-27T01:00:00.000Z",
          },
          {
            userId: "user-target",
            username: "target-user",
            displayName: "Target User",
            status: "ACTIVE",
            role: "MEMBER",
            createdAt: "2026-07-27T02:00:00.000Z",
          },
        ],
      })),
      approveUser: vi.fn(async () => {
        await approval.promise;
        approvalSucceeded = true;
      }),
      softDeleteRoom: vi.fn(async () => {
        await roomMutation.promise;
        roomDeleted = true;
      }),
    } as unknown as ReturnType<typeof createAdminApi>;
    const consoleApp = createConsoleApp({
      root: root as unknown as HTMLElement,
      document: window.document as unknown as Document,
      api,
    });

    await consoleApp.start();

    expect(root.querySelectorAll("[data-nav-view]")).toHaveLength(7);
    expect(root.querySelectorAll("[data-metric-id]")).toHaveLength(5);
    expect(root.textContent).toContain("待审批账号");
    expect(root.textContent).toContain("房间容量");
    expect(root.textContent).toContain("配额豁免");
    expect(root.querySelector('[data-region="linked-user-binding"]')).toBeNull();

    const approveButton = root.querySelector(
      '[data-action="approve-user"][data-user-id="user-pending"]',
    ) as unknown as HTMLButtonElement | null;
    expect(approveButton).not.toBeNull();
    approveButton?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }) as unknown as Event,
    );
    await flushTasks();
    expect(approveButton?.disabled).toBe(true);
    expect(api.listUsers).toHaveBeenCalledTimes(1);
    expect(api.diagnostics).toHaveBeenCalledTimes(1);
    expect(api.listAuditEvents).toHaveBeenCalledTimes(1);
    approval.resolve({});
    await flushTasks();
    expect(api.listUsers).toHaveBeenCalledTimes(2);
    expect(api.diagnostics).toHaveBeenCalledTimes(2);
    expect(api.listAuditEvents).toHaveBeenCalledTimes(2);
    expect(root.querySelector('[data-metric-id="pending"] .metric-value')?.textContent).toBe("0");

    const roomButton = root.querySelector(
      '[data-action="open-room"][data-room-id="room-exempt"]',
    ) as unknown as HTMLButtonElement | null;
    roomButton?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }) as unknown as Event,
    );
    await flushTasks();
    expect(root.querySelector('[data-region="drawer"]')?.textContent).toContain("管理员协作房间");
    const prepareDelete = root.querySelector(
      '[data-action="prepare-room-action"][data-room-action="soft-delete"]',
    ) as unknown as HTMLButtonElement | null;
    expect(prepareDelete).not.toBeNull();
    prepareDelete?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }) as unknown as Event,
    );
    await flushTasks();
    expect(root.querySelector('[data-action="confirm-room-action"]')?.textContent).toContain(
      "确认软删除",
    );
    const confirmDelete = root.querySelector(
      '[data-action="confirm-room-action"]',
    ) as unknown as HTMLButtonElement | null;
    confirmDelete?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }) as unknown as Event,
    );
    await flushTasks();
    expect(confirmDelete?.disabled).toBe(true);
    expect(api.listRooms).toHaveBeenCalledTimes(1);
    expect(api.diagnostics).toHaveBeenCalledTimes(2);
    expect(api.listAuditEvents).toHaveBeenCalledTimes(2);
    roomMutation.resolve({});
    await flushTasks();
    expect(api.listRooms).toHaveBeenCalledTimes(2);
    expect(api.diagnostics).toHaveBeenCalledTimes(3);
    expect(api.listAuditEvents).toHaveBeenCalledTimes(3);
    expect(root.querySelector('[data-region="drawer"]')).toBeNull();

    const roomsNavigation = root.querySelector(
      '[data-action="navigate"][data-nav-view="rooms"]',
    ) as unknown as HTMLButtonElement | null;
    roomsNavigation?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }) as unknown as Event,
    );
    await flushTasks();
    expect(root.querySelector('[data-filter="room-sort"]')).not.toBeNull();
    expect(root.querySelector('[data-filter="room-direction"]')).not.toBeNull();
  });

  it("binds an unbound administrator only after explicit confirmation and refreshes all related projections", async () => {
    const window = new Window({ url: publicOrigin });
    const root = window.document.createElement("div");
    window.document.body.append(root);
    const binding = deferred<unknown>();
    let bindingAttempt = 0;
    let linked = false;
    const api = {
      onboarding: vi.fn(async () => ({
        administrator: {
          id: "admin-1",
          username: "SyncAdmin",
          linkedUserId: linked ? "user-link-target" : null,
        },
        onboarding: {
          passwordChangeRequired: false,
          totpEnrollmentRequired: false,
        },
      })),
      me: vi.fn(async () => ({
        administratorId: "admin-1",
        username: "SyncAdmin",
        linkedUserId: linked ? "user-link-target" : null,
        sessionId: "session-1",
      })),
      listUsers: vi.fn(async () => ({
        users: [
          {
            id: "user-link-target",
            username: "linked-target",
            displayName: "绑定目标账号",
            status: "ACTIVE",
            passwordResetRequired: false,
            createdAt: "2026-07-27T01:00:00.000Z",
            updatedAt: "2026-07-27T01:00:00.000Z",
          },
        ],
        total: 1,
      })),
      listRooms: vi.fn(async () => ({ rooms: [] })),
      diagnostics: vi.fn(async () => ({
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
      })),
      listAuditEvents: vi.fn(async () => ({ events: [] })),
      bindLinkedUser: vi.fn(async (_userId: string) => {
        void _userId;
        bindingAttempt += 1;
        if (bindingAttempt === 1) {
          throw new AdminApiError("ADMIN_LINK_TARGET_INVALID", 409, "request-secret");
        }
        await binding.promise;
        linked = true;
        return { administratorId: "admin-1", linkedUserId: "user-link-target" };
      }),
    } as unknown as ReturnType<typeof createAdminApi>;
    const consoleApp = createConsoleApp({
      root: root as unknown as HTMLElement,
      document: window.document as unknown as Document,
      api,
    });

    await consoleApp.start();

    const bindingRegion = root.querySelector('[data-region="linked-user-binding"]');
    expect(bindingRegion?.textContent).toContain("一次性绑定");
    const form = bindingRegion?.querySelector(
      '[data-form="prepare-linked-user"]',
    ) as unknown as HTMLFormElement | null;
    const input = form?.querySelector(
      'select[name="linkedUserId"]',
    ) as unknown as HTMLSelectElement | null;
    expect(form).not.toBeNull();
    expect(input).not.toBeNull();
    if (input !== null) {
      input.value = "user-link-target";
    }
    form?.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await flushTasks();

    expect(api.bindLinkedUser).not.toHaveBeenCalled();
    expect(root.querySelector('[data-region="binding-confirmation"]')?.textContent).toContain(
      "user-link-target",
    );
    expect(root.querySelector('[data-region="binding-confirmation"]')?.textContent).toContain(
      "绑定后不能更改",
    );

    let confirm = root.querySelector(
      '[data-action="confirm-linked-user"]',
    ) as unknown as HTMLButtonElement | null;
    confirm?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await flushTasks();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("目标普通账号不存在或尚未激活");
    expect(root.textContent).not.toContain("request-secret");
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.listRooms).toHaveBeenCalledTimes(1);

    confirm = root.querySelector(
      '[data-action="confirm-linked-user"]',
    ) as unknown as HTMLButtonElement | null;
    confirm?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await flushTasks();
    expect(confirm?.disabled).toBe(true);
    expect(api.bindLinkedUser).toHaveBeenLastCalledWith(
      "user-link-target",
      expect.any(AbortSignal),
    );
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.listUsers).toHaveBeenCalledTimes(1);
    expect(api.listRooms).toHaveBeenCalledTimes(1);
    expect(api.diagnostics).toHaveBeenCalledTimes(1);
    expect(api.listAuditEvents).toHaveBeenCalledTimes(1);

    binding.resolve({});
    await flushTasks();
    expect(api.me).toHaveBeenCalledTimes(2);
    expect(api.listUsers).toHaveBeenCalledTimes(2);
    expect(api.listRooms).toHaveBeenCalledTimes(2);
    expect(api.diagnostics).toHaveBeenCalledTimes(2);
    expect(api.listAuditEvents).toHaveBeenCalledTimes(2);
    expect(root.querySelector('[data-region="linked-user-binding"]')).toBeNull();
    expect(root.textContent).toContain("已绑定豁免账号");
  });

  it("renders a restricted setup session without loading management projections", async () => {
    const window = new Window({ url: publicOrigin });
    const root = window.document.createElement("div");
    window.document.body.append(root);
    let completed = false;
    const api = {
      onboarding: vi.fn(async () => ({
        administrator: {
          id: "admin-1",
          username: "admin",
          linkedUserId: null,
        },
        onboarding: {
          passwordChangeRequired: !completed,
          totpEnrollmentRequired: !completed,
        },
      })),
      totpEnrollment: vi.fn(async () => ({
        secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        otpauthUri:
          "otpauth://totp/SyncAction%3Aadmin?issuer=SyncAction&secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&digits=6&period=30",
      })),
      completeOnboarding: vi.fn(async () => {
        completed = true;
        return {
          administratorId: "admin-1",
          username: "admin",
          linkedUserId: null,
          sessionId: "session-1",
          passwordChangeRequired: false,
          totpEnrollmentRequired: false,
        };
      }),
      me: vi.fn(async () => {
        if (!completed) {
          throw new AdminApiError("ADMIN_ONBOARDING_REQUIRED", 403, undefined);
        }
        return {
          administratorId: "admin-1",
          username: "admin",
          linkedUserId: null,
          sessionId: "session-1",
          passwordChangeRequired: false,
          totpEnrollmentRequired: false,
        };
      }),
      listUsers: vi.fn(async () => ({ users: [], total: 0 })),
      listRooms: vi.fn(async () => ({ rooms: [] })),
      diagnostics: vi.fn(async () => ({
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
      })),
      listAuditEvents: vi.fn(async () => ({ events: [] })),
    } as unknown as ReturnType<typeof createAdminApi>;
    const consoleApp = createConsoleApp({
      root: root as unknown as HTMLElement,
      document: window.document as unknown as Document,
      api,
    });

    await consoleApp.start();

    expect(root.querySelector('[data-region="administrator-onboarding"]')).not.toBeNull();
    expect(root.textContent).toContain("完成管理员设置");
    expect(root.textContent).toContain("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(api.me).not.toHaveBeenCalled();
    expect(api.listUsers).not.toHaveBeenCalled();
    expect(api.listRooms).not.toHaveBeenCalled();
    const form = root.querySelector(
      '[data-form="administrator-onboarding"]',
    ) as unknown as HTMLFormElement | null;
    const password = form?.querySelector(
      'input[name="newPassword"]',
    ) as unknown as HTMLInputElement | null;
    const confirmation = form?.querySelector(
      'input[name="newPasswordConfirmation"]',
    ) as unknown as HTMLInputElement | null;
    const totp = form?.querySelector('input[name="totp"]') as unknown as HTMLInputElement | null;
    if (form === null || password === null || confirmation === null || totp === null) {
      throw new Error("Administrator onboarding fields were not rendered");
    }
    password.value = "replacement administrator password";
    confirmation.value = "different administrator password";
    totp.value = "654321";
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await flushTasks();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(root.textContent).toContain("两次输入的密码不一致");

    const rerenderedForm = root.querySelector(
      '[data-form="administrator-onboarding"]',
    ) as unknown as HTMLFormElement | null;
    const rerenderedPassword = rerenderedForm?.querySelector(
      'input[name="newPassword"]',
    ) as unknown as HTMLInputElement | null;
    const rerenderedConfirmation = rerenderedForm?.querySelector(
      'input[name="newPasswordConfirmation"]',
    ) as unknown as HTMLInputElement | null;
    const rerenderedTotp = rerenderedForm?.querySelector(
      'input[name="totp"]',
    ) as unknown as HTMLInputElement | null;
    if (
      rerenderedForm === null ||
      rerenderedPassword === null ||
      rerenderedConfirmation === null ||
      rerenderedTotp === null
    ) {
      throw new Error("Administrator onboarding form did not survive validation");
    }
    rerenderedPassword.value = "replacement administrator password";
    rerenderedConfirmation.value = "replacement administrator password";
    rerenderedTotp.value = "654321";
    rerenderedForm.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await flushTasks();

    expect(api.completeOnboarding).toHaveBeenCalledWith(
      {
        newPassword: "replacement administrator password",
        totp: "654321",
      },
      expect.any(AbortSignal),
    );
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[data-region="administrator-onboarding"]')).toBeNull();
    expect(root.textContent).not.toContain("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(root.querySelectorAll("[data-nav-view]")).toHaveLength(7);
  });

  it("shows activation keys once and keeps only the account mapping afterward", async () => {
    const window = new Window({ url: publicOrigin });
    const root = window.document.createElement("div");
    window.document.body.append(root);
    const existingGrant = {
      id: "grant-used",
      note: "Bob / support laptop",
      keyTail: "deadbeef",
      status: "USED",
      account: { id: "user-bob", username: "bob", displayName: "Bob" },
      expiresAt: "2026-09-07T01:00:00.000Z",
      usedAt: "2026-08-31T02:00:00.000Z",
      revokedAt: null,
      createdAt: "2026-08-31T01:00:00.000Z",
    } as const;
    const createdGrant = {
      id: "grant-new",
      note: "Alice / design team",
      keyTail: "A1b2C3d4",
      status: "ACTIVE",
      account: null,
      expiresAt: "2026-09-07T03:00:00.000Z",
      usedAt: null,
      revokedAt: null,
      createdAt: "2026-08-31T03:00:00.000Z",
    } as const;
    const claimedGrant = {
      id: "grant-claimed",
      note: "Carol / waiting for setup",
      keyTail: "cafebabe",
      status: "CLAIMED",
      account: {
        id: "user-carol",
        username: "s0000000000000000000000000",
        displayName: "未命名用户",
      },
      expiresAt: "2026-09-07T02:00:00.000Z",
      usedAt: "2026-08-31T02:30:00.000Z",
      revokedAt: null,
      createdAt: "2026-08-31T01:30:00.000Z",
    } as const;
    const activationKey = `sak_${"X".repeat(35)}A1b2C3d4`;
    const api = {
      onboarding: vi.fn(async () => ({
        administrator: { id: "admin-1", username: "SyncAdmin", linkedUserId: "user-linked" },
        onboarding: { passwordChangeRequired: false, totpEnrollmentRequired: false },
      })),
      me: vi.fn(async () => ({
        administratorId: "admin-1",
        username: "SyncAdmin",
        linkedUserId: "user-linked",
        sessionId: "session-1",
      })),
      listUsers: vi.fn(async () => ({ users: [], total: 0 })),
      listRooms: vi.fn(async () => ({ rooms: [] })),
      diagnostics: vi.fn(async () => ({
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
      })),
      listAuditEvents: vi.fn(async () => ({ events: [] })),
      listActivationGrants: vi.fn(async () => ({ grants: [existingGrant, claimedGrant] })),
      createActivationGrant: vi.fn(async () => ({ activationKey, grant: createdGrant })),
      revokeActivationGrant: vi.fn(async () => ({ ...createdGrant, status: "REVOKED" })),
      logout: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof createAdminApi>;
    const consoleApp = createConsoleApp({
      root: root as unknown as HTMLElement,
      document: window.document as unknown as Document,
      api,
    });

    await consoleApp.start();
    const navigation = root.querySelector(
      '[data-action="navigate"][data-nav-view="activation-keys"]',
    ) as unknown as HTMLButtonElement | null;
    navigation?.click();
    await flushTasks();

    expect(root.textContent).toContain("账户密钥");
    expect(root.textContent).toContain("Bob / support laptop");
    expect(root.textContent).toContain("@bob · Bob");
    expect(root.textContent).toContain("…deadbeef");
    expect(root.textContent).toContain("已完成");
    expect(root.textContent).toContain("待完善");
    expect(root.textContent).toContain("密钥仍可登录");
    expect(
      root.querySelector('[data-action="revoke-activation-grant"][data-grant-id="grant-claimed"]'),
    ).not.toBeNull();
    expect(root.textContent).not.toContain(activationKey);

    const form = root.querySelector(
      '[data-form="activation-grant"]',
    ) as unknown as HTMLFormElement | null;
    const note = form?.querySelector('input[name="note"]') as unknown as HTMLInputElement | null;
    if (form === null || note === null) {
      throw new Error("Activation grant form was not rendered");
    }
    expect(note.required).toBe(true);
    expect(note.maxLength).toBe(120);
    note.value = "Alice / design team";
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await flushTasks();

    expect(api.createActivationGrant).toHaveBeenCalledWith(
      "Alice / design team",
      expect.any(AbortSignal),
    );
    expect(root.querySelector('[data-region="one-time-activation-key"]')?.textContent).toContain(
      activationKey,
    );
    expect(root.textContent).toContain("/v1/auth/key-login");
    expect(root.textContent).toContain("完整密钥只显示这一次");
    expect(root.textContent).toContain("Alice / design team");
    expect(root.textContent).toContain("2026年9月7日");

    const overview = root.querySelector(
      '[data-action="navigate"][data-nav-view="overview"]',
    ) as unknown as HTMLButtonElement | null;
    overview?.click();
    const activationKeysNavigation = root.querySelector(
      '[data-action="navigate"][data-nav-view="activation-keys"]',
    ) as unknown as HTMLButtonElement | null;
    activationKeysNavigation?.click();
    await flushTasks();
    expect(root.textContent).not.toContain(activationKey);
    expect(root.textContent).toContain("Alice / design team");
    expect(root.textContent).toContain("…A1b2C3d4");
    expect(root.textContent).toContain("尚未使用");

    let resolveSecondCreation: () => void = () => {
      throw new Error("Second activation creation was not started");
    };
    const secondActivationKey = `sak_${"B".repeat(43)}`;
    vi.mocked(api.createActivationGrant).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecondCreation = () =>
            resolve({
              activationKey: secondActivationKey,
              grant: {
                ...createdGrant,
                id: "grant-second",
                note: "Second in flight",
                keyTail: "BBBBBBBB",
              },
            });
        }),
    );
    const secondForm = root.querySelector(
      '[data-form="activation-grant"]',
    ) as unknown as HTMLFormElement | null;
    const secondNote = secondForm?.querySelector(
      'input[name="note"]',
    ) as unknown as HTMLInputElement | null;
    if (secondForm === null || secondNote === null) {
      throw new Error("Activation grant form was not rendered for in-flight navigation test");
    }
    secondNote.value = "Second in flight";
    secondForm.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await flushTasks();
    const overviewDuringCreation = root.querySelector(
      '[data-action="navigate"][data-nav-view="overview"]',
    ) as unknown as HTMLButtonElement | null;
    overviewDuringCreation?.click();
    await flushTasks();
    expect(root.textContent).toContain("账户密钥");
    const logoutDuringCreation = root.querySelector(
      '[data-action="logout"]',
    ) as unknown as HTMLButtonElement | null;
    logoutDuringCreation?.click();
    await flushTasks();
    expect(api.logout).not.toHaveBeenCalled();
    expect(root.textContent).toContain("账户密钥");
    resolveSecondCreation();
    await flushTasks();
    expect(root.textContent).toContain(secondActivationKey);

    const revoke = root.querySelector(
      '[data-action="revoke-activation-grant"][data-grant-id="grant-new"]',
    ) as unknown as HTMLButtonElement | null;
    revoke?.click();
    await flushTasks();
    expect(api.revokeActivationGrant).toHaveBeenCalledWith("grant-new", expect.any(AbortSignal));
    expect(root.textContent).toContain("已撤销");
    expect(root.textContent).not.toContain(activationKey);

    let resolveLogout: () => void = () => {
      throw new Error("Logout was not started");
    };
    vi.mocked(api.logout).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLogout = resolve;
        }),
    );
    const logout = root.querySelector(
      '[data-action="logout"]',
    ) as unknown as HTMLButtonElement | null;
    logout?.click();
    await flushTasks();

    const formDuringLogout = root.querySelector(
      '[data-form="activation-grant"]',
    ) as unknown as HTMLFormElement | null;
    const noteDuringLogout = formDuringLogout?.querySelector(
      'input[name="note"]',
    ) as unknown as HTMLInputElement | null;
    if (formDuringLogout === null || noteDuringLogout === null) {
      throw new Error("Activation grant form was not rendered while logout was pending");
    }
    noteDuringLogout.value = "Must not be created";
    formDuringLogout.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await flushTasks();

    expect(api.createActivationGrant).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain("正在退出登录");
    resolveLogout();
    await flushTasks();
    expect(root.querySelector('[data-form="login"]')).not.toBeNull();
    expect(root.querySelector('[data-region="one-time-activation-key"]')).toBeNull();
  });

  it("accepts an empty TOTP field on first login and transitions to setup", async () => {
    const window = new Window({ url: publicOrigin });
    const root = window.document.createElement("div");
    window.document.body.append(root);
    let authenticated = false;
    const api = {
      onboarding: vi.fn(async () => {
        if (!authenticated) {
          throw new AdminApiError("ADMIN_SESSION_INVALID", 401, undefined);
        }
        return {
          administrator: { id: "admin-1", username: "admin", linkedUserId: null },
          onboarding: {
            passwordChangeRequired: true,
            totpEnrollmentRequired: true,
          },
        };
      }),
      login: vi.fn(async () => {
        authenticated = true;
        return {
          administrator: {
            id: "admin-1",
            username: "admin",
            linkedUserId: null,
            passwordChangeRequired: true,
            totpEnrollmentRequired: true,
          },
          expiresInSeconds: 600,
          onboarding: {
            passwordChangeRequired: true,
            totpEnrollmentRequired: true,
          },
        };
      }),
      totpEnrollment: vi.fn(async () => ({
        secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/SyncAction%3Aadmin",
      })),
      me: vi.fn(async () => {
        throw new AdminApiError("ADMIN_ONBOARDING_REQUIRED", 403, undefined);
      }),
    } as unknown as ReturnType<typeof createAdminApi>;
    const consoleApp = createConsoleApp({
      root: root as unknown as HTMLElement,
      document: window.document as unknown as Document,
      api,
    });

    await consoleApp.start();
    const form = root.querySelector('[data-form="login"]') as unknown as HTMLFormElement | null;
    const username = form?.querySelector(
      'input[name="username"]',
    ) as unknown as HTMLInputElement | null;
    const password = form?.querySelector(
      'input[name="password"]',
    ) as unknown as HTMLInputElement | null;
    if (form === null || username === null || password === null) {
      throw new Error("Login form was not rendered");
    }
    username.value = "admin";
    password.value = "123456";
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await flushTasks();

    expect(api.login).toHaveBeenCalledWith(
      {
        username: "admin",
        password: "123456",
      },
      expect.any(AbortSignal),
    );
    expect(root.querySelector('[data-region="administrator-onboarding"]')).not.toBeNull();
    expect(api.me).not.toHaveBeenCalled();
  });

  it("preserves a TOTP-only setup after an API error and removes the secret on logout", async () => {
    const window = new Window({ url: publicOrigin });
    const root = window.document.createElement("div");
    window.document.body.append(root);
    const api = {
      onboarding: vi.fn(async () => ({
        administrator: {
          id: "admin-1",
          username: "admin",
          linkedUserId: null,
        },
        onboarding: {
          passwordChangeRequired: false,
          totpEnrollmentRequired: true,
        },
      })),
      totpEnrollment: vi.fn(async () => ({
        secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/SyncAction%3Aadmin",
      })),
      completeOnboarding: vi.fn(async () => {
        throw new AdminApiError("ADMIN_INVALID_CREDENTIALS", 401, undefined);
      }),
      logout: vi.fn(async () => undefined),
    } as unknown as ReturnType<typeof createAdminApi>;
    const consoleApp = createConsoleApp({
      root: root as unknown as HTMLElement,
      document: window.document as unknown as Document,
      api,
    });

    await consoleApp.start();

    expect(root.querySelector('input[name="newPassword"]')).toBeNull();
    expect(root.querySelector('input[name="newPasswordConfirmation"]')).toBeNull();
    const form = root.querySelector(
      '[data-form="administrator-onboarding"]',
    ) as unknown as HTMLFormElement | null;
    const totp = form?.querySelector('input[name="totp"]') as unknown as HTMLInputElement | null;
    if (form === null || totp === null) {
      throw new Error("TOTP-only administrator onboarding form was not rendered");
    }
    totp.value = "000000";
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    await flushTasks();

    expect(root.querySelector('[data-region="administrator-onboarding"]')).not.toBeNull();
    expect(root.textContent).toContain("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(root.querySelectorAll('[role="alert"]')).toHaveLength(1);

    const logout = root.querySelector('[data-action="logout"]');
    if (!(logout instanceof window.HTMLButtonElement)) {
      throw new Error("Administrator onboarding logout button was not rendered");
    }
    logout.click();
    await flushTasks();

    expect(api.logout).toHaveBeenCalledOnce();
    expect(root.querySelector('[data-region="administrator-onboarding"]')).toBeNull();
    expect(root.textContent).not.toContain("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(root.querySelector('[data-form="login"]')).not.toBeNull();
  });
});

describe("administrator console static boundary", () => {
  it("serves external assets with the self-only CSP while API and health routes retain precedence", async () => {
    const administrators = {
      authenticateSession: async () => {
        throw new IdentityError("ADMIN_SESSION_INVALID");
      },
    } as unknown as AdminService;
    const app = await buildAdminApp({
      db: {} as ReturnType<typeof createDatabase>,
      administrators,
      rooms: {} as RoomService,
      cookie,
      publicOrigin,
      logger: false,
      readinessCheck: async () => undefined,
    });
    openApps.push(app);

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    const window = new Window({ url: publicOrigin });
    window.document.write(index.body);
    expect(window.document.querySelector("[data-admin-app]")).not.toBeNull();
    expect(window.document.querySelectorAll("style")).toHaveLength(0);
    expect(
      [...window.document.querySelectorAll("script")].every(
        (script) => script.getAttribute("src") !== null && script.textContent === "",
      ),
    ).toBe(true);

    for (const path of [
      "/style.css",
      "/app.js",
      "/api.js",
      "/view-model.js",
      "/syncaction-symbol.svg",
    ]) {
      const asset = await app.inject({ method: "GET", url: path });
      expect(asset.statusCode, path).toBe(200);
    }
    expect(index.headers["content-security-policy"]).toBe(
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'",
    );
    expect(index.headers["content-security-policy"]).not.toMatch(/https?:|data:/u);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/admin/me" })).statusCode).toBe(401);
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: {
        origin: "https://syncaction.example.com",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ code: "ADMIN_ORIGIN_REQUIRED" });
  });

  it("keeps server data out of innerHTML and browser credential storage", async () => {
    const [appSource, apiSource, indexSource, styleSource] = await Promise.all([
      readFile(resolve(publicDirectory, "app.js"), "utf8"),
      readFile(resolve(publicDirectory, "api.js"), "utf8"),
      readFile(resolve(publicDirectory, "index.html"), "utf8"),
      readFile(resolve(publicDirectory, "style.css"), "utf8"),
    ]);

    expect(appSource).not.toContain("innerHTML");
    expect(appSource).toContain("textContent");
    expect(appSource).toContain("new AbortController");
    expect(appSource).toContain('addEventListener("click"');
    expect(apiSource).not.toMatch(/localStorage|sessionStorage|document\.cookie/iu);
    expect(indexSource).not.toMatch(/<script(?![^>]+src=)[^>]*>/iu);
    expect(indexSource).not.toMatch(/<style[\s>]/iu);
    expect(styleSource).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.metric-item:last-child\s*\{\s*grid-column: 1 \/ -1;/u,
    );
  });
});

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flushTasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
