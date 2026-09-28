import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiError } from "../public/api.js";
import type { createAdminApi } from "../public/api.js";
import { createConsoleApp } from "../public/app.js";

const publicOrigin = "https://admin.syncaction.example.com";
const publicDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const activeUserA = {
  id: "user-active-a",
  username: "active-alpha",
  displayName: "活跃账号甲",
  status: "ACTIVE" as const,
  passwordResetRequired: false,
  createdAt: "2026-07-27T01:00:00.000Z",
  updatedAt: "2026-07-27T01:00:00.000Z",
};
const activeUserB = {
  ...activeUserA,
  id: "user-active-b",
  username: "active-beta",
  displayName: "活跃账号乙",
};
const pendingUserA = {
  ...activeUserA,
  id: "user-pending-a",
  username: "pending-alpha",
  displayName: "待审批账号甲",
  status: "PENDING" as const,
};
const pendingUserB = {
  ...pendingUserA,
  id: "user-pending-b",
  username: "pending-beta",
  displayName: "待审批账号乙",
};
const activeRoom = {
  roomId: "room-active",
  name: "管理员协作房间",
  ownerUserId: activeUserA.id,
  ownerUsername: activeUserA.username,
  memberCount: 2,
  openTabCount: 8,
  roomEpoch: 0,
  serverSeq: 22,
  lifecycle: "ACTIVE" as const,
  quotaClass: "EXEMPT" as const,
};
const roomMembers = [
  {
    userId: activeUserA.id,
    username: activeUserA.username,
    displayName: activeUserA.displayName,
    status: "ACTIVE" as const,
    role: "OWNER" as const,
    createdAt: "2026-07-27T01:00:00.000Z",
  },
  {
    userId: activeUserB.id,
    username: activeUserB.username,
    displayName: activeUserB.displayName,
    status: "ACTIVE" as const,
    role: "MEMBER" as const,
    createdAt: "2026-07-27T02:00:00.000Z",
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator authoritative refresh", () => {
  it("serializes post-success refreshes without allowing detail reads or a second mutation to abort them", async () => {
    const firstRefresh = deferred<{ users: (typeof pendingUserA)[] }>();
    let userReadCount = 0;
    let firstRefreshSignal: AbortSignal | undefined;
    const listUsers = vi.fn(async (_filters: unknown, signal?: AbortSignal) => {
      void _filters;
      userReadCount += 1;
      if (userReadCount === 2) {
        firstRefreshSignal = signal;
        return firstRefresh.promise;
      }
      return { users: [pendingUserA, pendingUserB] };
    });
    const approveUser = vi.fn(async () => undefined);
    const api = createApi({
      listUsers,
      approveUser,
      listRooms: vi.fn(async () => ({ rooms: [activeRoom] })),
      listRoomMembers: vi.fn(async () => ({ members: roomMembers })),
    });
    const mounted = await mountConsole(api);

    click(mounted.window, queryButton(mounted.root, `approve-user`, "user-pending-a"));
    await flushTasks();
    expect(firstRefreshSignal?.aborted).toBe(false);

    click(mounted.window, queryButton(mounted.root, "open-room", "room-active"));
    await flushTasks();
    expect(firstRefreshSignal?.aborted).toBe(false);

    click(mounted.window, queryButton(mounted.root, `approve-user`, "user-pending-b"));
    await flushTasks();
    expect(firstRefreshSignal?.aborted).toBe(false);
    expect(listUsers).toHaveBeenCalledTimes(2);

    firstRefresh.resolve({ users: [pendingUserB] });
    await flushTasks();
    await flushTasks();
    expect(listUsers).toHaveBeenCalledTimes(3);
  });

  it("keeps write success distinct when the authoritative refresh fails", async () => {
    let userReadCount = 0;
    const listUsers = vi.fn(async () => {
      userReadCount += 1;
      if (userReadCount === 2) {
        throw new AdminApiError("ADMIN_RESPONSE_INVALID", 502, "refresh-request");
      }
      return { users: [pendingUserA] };
    });
    const approveUser = vi.fn(async () => undefined);
    const api = createApi({ listUsers, approveUser });
    const mounted = await mountConsole(api);

    click(mounted.window, queryButton(mounted.root, "approve-user", pendingUserA.id));
    await flushTasks();
    await flushTasks();

    expect(approveUser).toHaveBeenCalledTimes(1);
    expect(mounted.root.querySelector('[data-region="mutation-notice"]')?.textContent).toContain(
      "账号已批准",
    );
    expect(mounted.root.querySelector('[data-region="refresh-warning"]')?.textContent).toContain(
      "操作已完成",
    );
    expect(
      mounted.root.querySelector('[data-region="refresh-warning"]')?.getAttribute("role"),
    ).toBe("status");
    expect(mounted.root.querySelector('[data-region="mutation-error"]')).toBeNull();
    expect(
      mounted.root.querySelector(`[data-action="approve-user"][data-user-id="${pendingUserA.id}"]`),
    ).toBeNull();
  });
});

describe("administrator resource locks and identity binding", () => {
  it("resolves binding only from loaded ACTIVE users and holds one global lock until completion", async () => {
    const binding = deferred<unknown>();
    let linked = false;
    const bindLinkedUser = vi.fn(async () => {
      await binding.promise;
      linked = true;
      return { administratorId: "admin-1", linkedUserId: activeUserA.id };
    });
    const api = createApi({
      me: vi.fn(async () => principal(linked ? activeUserA.id : null)),
      listUsers: vi.fn(async () => ({
        users: [activeUserA, activeUserB, pendingUserA],
      })),
      bindLinkedUser,
    });
    const mounted = await mountConsole(api);

    let form = mounted.root.querySelector(
      '[data-form="prepare-linked-user"]',
    ) as HTMLFormElement | null;
    let select = form?.querySelector('select[name="linkedUserId"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect([...select!.options].map((option) => option.value)).toEqual([
      "",
      activeUserA.id,
      activeUserB.id,
    ]);

    const forged = mounted.window.document.createElement("option");
    forged.value = pendingUserA.id;
    forged.textContent = pendingUserA.username;
    select?.append(forged as unknown as Node);
    if (select !== null) {
      select.value = pendingUserA.id;
    }
    submit(mounted.window, form);
    await flushTasks();
    expect(mounted.root.querySelector('[data-region="binding-confirmation"]')).toBeNull();
    expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
      "请选择已加载的活跃普通账号",
    );

    form = mounted.root.querySelector(
      '[data-form="prepare-linked-user"]',
    ) as HTMLFormElement | null;
    select = form?.querySelector('select[name="linkedUserId"]') as HTMLSelectElement | null;
    if (select !== null) {
      select.value = activeUserA.id;
    }
    submit(mounted.window, form);
    await flushTasks();
    const identity = mounted.root.querySelector('[data-region="binding-confirmation"]');
    expect(identity?.textContent).toContain(activeUserA.username);
    expect(identity?.textContent).toContain(activeUserA.displayName);
    expect(identity?.textContent).toContain(activeUserA.id);
    expect(identity?.textContent).toContain("活跃");

    click(mounted.window, mounted.root.querySelector('[data-action="confirm-linked-user"]'));
    await flushTasks();
    expect(mounted.app.getState().pendingActions.has("bind-linked-user")).toBe(true);
    expect(bindLinkedUser).toHaveBeenCalledTimes(1);

    click(mounted.window, mounted.root.querySelector('[data-action="cancel-linked-user"]'));
    await flushTasks();
    expect(
      mounted.root.querySelector('[data-region="binding-confirmation"]')?.textContent,
    ).toContain(activeUserA.id);
    expect(mounted.root.querySelector('[data-form="prepare-linked-user"]')).toBeNull();
    expect(bindLinkedUser).toHaveBeenCalledTimes(1);

    binding.resolve({});
    await flushTasks();
    await flushTasks();
    expect(mounted.root.querySelector('[data-region="linked-user-binding"]')).toBeNull();
  });

  it("locks every dangerous action for a room across close and reopen", async () => {
    const deletion = deferred<unknown>();
    const softDeleteRoom = vi.fn(async () => deletion.promise);
    const transferOwnership = vi.fn(async () => undefined);
    const api = createApi({
      listUsers: vi.fn(async () => ({ users: [activeUserA, activeUserB] })),
      listRooms: vi.fn(async () => ({ rooms: [activeRoom] })),
      listRoomMembers: vi.fn(async () => ({ members: roomMembers })),
      softDeleteRoom,
      transferOwnership,
    });
    const mounted = await mountConsole(api);

    click(mounted.window, queryButton(mounted.root, "open-room", activeRoom.roomId));
    await flushTasks();
    click(
      mounted.window,
      mounted.root.querySelector(
        '[data-action="prepare-room-action"][data-room-action="soft-delete"]',
      ),
    );
    click(mounted.window, mounted.root.querySelector('[data-action="confirm-room-action"]'));
    await flushTasks();
    expect(mounted.app.getState().pendingActions.has(`room:${activeRoom.roomId}`)).toBe(true);
    expect(softDeleteRoom).toHaveBeenCalledTimes(1);

    click(mounted.window, mounted.root.querySelector('[data-action="close-drawer"]'));
    click(mounted.window, queryButton(mounted.root, "open-room", activeRoom.roomId));
    await flushTasks();
    const transferTarget = mounted.root.querySelector(
      '[data-field="transfer-target"]',
    ) as HTMLSelectElement | null;
    if (transferTarget !== null) {
      transferTarget.value = activeUserB.id;
    }
    click(
      mounted.window,
      mounted.root.querySelector(
        '[data-action="prepare-room-action"][data-room-action="transfer"]',
      ),
    );
    await flushTasks();
    expect(mounted.root.querySelector('[data-action="confirm-room-action"]')).toBeNull();
    expect(transferOwnership).not.toHaveBeenCalled();

    deletion.resolve({});
    await flushTasks();
    await flushTasks();
  });
});

describe("administrator modal focus and lifecycle", () => {
  it("makes the drawer modal, traps Tab, handles Escape, and restores stable focus", async () => {
    const api = createApi({
      listUsers: vi.fn(async () => ({ users: [activeUserA, activeUserB] })),
      listRooms: vi.fn(async () => ({ rooms: [activeRoom] })),
      listRoomMembers: vi.fn(async () => ({ members: roomMembers })),
    });
    const mounted = await mountConsole(api);
    const opener = queryButton(mounted.root, "open-room", activeRoom.roomId);
    opener.focus();
    click(mounted.window, opener);
    await flushTasks();

    const dialog = mounted.root.querySelector('[data-region="drawer"]') as HTMLElement | null;
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const close = mounted.root.querySelector(
      '[data-action="close-drawer"]',
    ) as HTMLButtonElement | null;
    expect(mounted.window.document.activeElement).toBe(close);
    const focusable = [
      ...(dialog?.querySelectorAll("button:not(:disabled), select:not(:disabled)") ?? []),
    ] as HTMLElement[];
    const last = focusable.at(-1);
    expect(last).toBeDefined();

    last?.focus();
    last?.dispatchEvent(
      new mounted.window.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
      }) as unknown as Event,
    );
    expect(mounted.window.document.activeElement).toBe(close);

    close?.focus();
    close?.dispatchEvent(
      new mounted.window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }) as unknown as Event,
    );
    expect(mounted.window.document.activeElement).toBe(last);

    last?.dispatchEvent(
      new mounted.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }) as unknown as Event,
    );
    await flushTasks();
    expect(mounted.root.querySelector('[data-region="drawer"]')).toBeNull();
    expect(mounted.window.document.activeElement).toBe(
      queryButton(mounted.root, "open-room", activeRoom.roomId),
    );

    click(mounted.window, mounted.root.querySelector('[data-nav-view="rooms"]'));
    const roomQuery = mounted.root.querySelector(
      '[data-filter="room-query"]',
    ) as HTMLInputElement | null;
    roomQuery?.focus();
    if (roomQuery !== null) {
      roomQuery.value = "管理员";
      roomQuery.dispatchEvent(
        new mounted.window.Event("change", { bubbles: true }) as unknown as Event,
      );
    }
    expect(mounted.window.document.activeElement).toBe(
      mounted.root.querySelector('[data-filter="room-query"]'),
    );
  });

  it("aborts initial reads and prevents a destroyed start from rendering later", async () => {
    const onboardingResult = deferred<unknown>();
    let onboardingSignal: AbortSignal | undefined;
    const api = createApi({
      onboarding: vi.fn(async (signal?: AbortSignal) => {
        onboardingSignal = signal;
        return onboardingResult.promise;
      }),
    });
    const mounted = mountConsoleWithoutStarting(api);

    const starting = mounted.app.start();
    await flushTasks();
    mounted.app.destroy();
    expect(onboardingSignal?.aborted).toBe(true);
    onboardingResult.resolve({
      administrator: {
        id: "admin-1",
        username: "SyncAdmin",
        linkedUserId: activeUserA.id,
      },
      onboarding: {
        passwordChangeRequired: false,
        totpEnrollmentRequired: false,
      },
    });
    await starting;
    await flushTasks();
    expect(mounted.root.childNodes).toHaveLength(0);
  });

  it("aborts login and mutation work and never zombie-renders after destroy", async () => {
    const loginResult = deferred<unknown>();
    let loginSignal: AbortSignal | undefined;
    const loginApi = createApi({
      onboarding: vi.fn(async () => {
        throw new AdminApiError("ADMIN_SESSION_INVALID", 401, undefined);
      }),
      login: vi.fn(async (_credentials: unknown, signal?: AbortSignal) => {
        void _credentials;
        loginSignal = signal;
        return loginResult.promise;
      }),
    });
    const loginMounted = await mountConsole(loginApi);
    vi.stubGlobal("FormData", loginMounted.window.FormData);
    setInput(loginMounted.root, "username", "SyncAdmin");
    setInput(loginMounted.root, "password", "administrator horse battery");
    setInput(loginMounted.root, "totp", "123456");
    submit(
      loginMounted.window,
      loginMounted.root.querySelector('[data-form="login"]') as HTMLFormElement | null,
    );
    await flushTasks();
    loginMounted.app.destroy();
    expect(loginSignal?.aborted).toBe(true);
    loginResult.resolve({});
    await flushTasks();
    expect(loginMounted.root.childNodes).toHaveLength(0);

    const mutationResult = deferred<unknown>();
    let mutationSignal: AbortSignal | undefined;
    const approveUser = vi.fn(async (_userId: string, signal?: AbortSignal) => {
      void _userId;
      mutationSignal = signal;
      return mutationResult.promise;
    });
    const mutationApi = createApi({
      listUsers: vi.fn(async () => ({ users: [pendingUserA] })),
      approveUser,
    });
    const mutationMounted = await mountConsole(mutationApi);
    click(
      mutationMounted.window,
      queryButton(mutationMounted.root, "approve-user", pendingUserA.id),
    );
    await flushTasks();
    mutationMounted.app.destroy();
    expect(mutationSignal?.aborted).toBe(true);
    mutationResult.resolve({});
    await flushTasks();
    expect(mutationMounted.root.childNodes).toHaveLength(0);
  });
});

describe("administrator responsive and announcement boundary", () => {
  it("keeps mobile logout visible, scopes live announcements, and uses AA light tones", async () => {
    const [indexSource, styleSource] = await Promise.all([
      readFile(resolve(publicDirectory, "index.html"), "utf8"),
      readFile(resolve(publicDirectory, "style.css"), "utf8"),
    ]);
    expect(indexSource).not.toMatch(/data-admin-app[^>]*aria-live/iu);

    const mobile = styleSource.match(
      /@media \(max-width: 720px\) \{(?<rules>[\s\S]*?)\n\}\n\n@media \(min-resolution/u,
    )?.groups?.rules;
    expect(mobile).toBeDefined();
    expect(mobile).not.toMatch(/\.sidebar-brand,\s*\.sidebar-identity\s*\{\s*display:\s*none/iu);
    expect(mobile).toMatch(/\.sidebar-brand\s*\{\s*display:\s*none/iu);
    expect(mobile).toMatch(/\.sidebar-identity\s*\{[\s\S]*display:\s*grid/iu);

    const lightRoot = styleSource.match(/^:root \{(?<rules>[\s\S]*?)\n\}/u)?.groups?.rules ?? "";
    const success = cssHexVariable(lightRoot, "--sa-success");
    const warning = cssHexVariable(lightRoot, "--sa-warning");
    expect(contrastRatio(success, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(warning, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    const contrastRules =
      styleSource.match(
        /@media \(prefers-contrast: more\), \(forced-colors: active\) \{(?<rules>[\s\S]*?)\n\}/u,
      )?.groups?.rules ?? "";
    expect(contrastRules).toContain("--sa-success:");
    expect(contrastRules).toContain("--sa-warning:");
  });
});

function createApi(overrides: Record<string, unknown> = {}) {
  return {
    login: vi.fn(async () => ({})),
    logout: vi.fn(async () => undefined),
    onboarding: vi.fn(async () => ({
      administrator: {
        id: "admin-1",
        username: "SyncAdmin",
        linkedUserId: activeUserA.id,
      },
      onboarding: {
        passwordChangeRequired: false,
        totpEnrollmentRequired: false,
      },
    })),
    totpEnrollment: vi.fn(async () => ({
      secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/SyncAction%3ASyncAdmin",
    })),
    completeOnboarding: vi.fn(async () => principal(activeUserA.id)),
    me: vi.fn(async () => principal(activeUserA.id)),
    bindLinkedUser: vi.fn(async () => ({})),
    listUsers: vi.fn(async () => ({ users: [activeUserA] })),
    listUserDevices: vi.fn(async () => ({ devices: [] })),
    approveUser: vi.fn(async () => undefined),
    suspendUser: vi.fn(async () => undefined),
    revokeUser: vi.fn(async () => undefined),
    revokeAllSessions: vi.fn(async () => undefined),
    revokeDevice: vi.fn(async () => undefined),
    issuePasswordReset: vi.fn(async () => undefined),
    listRooms: vi.fn(async () => ({ rooms: [activeRoom] })),
    listRoomMembers: vi.fn(async () => ({ members: roomMembers })),
    softDeleteRoom: vi.fn(async () => undefined),
    restoreRoom: vi.fn(async () => undefined),
    transferOwnership: vi.fn(async () => undefined),
    listAuditEvents: vi.fn(async () => ({ events: [] })),
    diagnostics: vi.fn(async () => diagnostics()),
    ...overrides,
  } as unknown as ReturnType<typeof createAdminApi>;
}

async function mountConsole(api: ReturnType<typeof createAdminApi>) {
  const mounted = mountConsoleWithoutStarting(api);
  await mounted.app.start();
  return mounted;
}

function mountConsoleWithoutStarting(api: ReturnType<typeof createAdminApi>) {
  const window = new Window({ url: publicOrigin });
  const root = window.document.createElement("div");
  window.document.body.append(root);
  const app = createConsoleApp({
    root: root as unknown as HTMLElement,
    document: window.document as unknown as Document,
    api,
  });
  return { window, root, app };
}

function principal(linkedUserId: string | null) {
  return {
    administratorId: "admin-1",
    username: "SyncAdmin",
    linkedUserId,
    sessionId: "session-1",
    passwordChangeRequired: false,
    totpEnrollmentRequired: false,
  };
}

function diagnostics() {
  return {
    database: "ready" as const,
    counts: {
      users: 4,
      pendingUsers: 2,
      activeUsers: 2,
      suspendedUsers: 0,
      revokedUsers: 0,
      rooms: 1,
      activeDeviceSessions: 2,
    },
  };
}

function queryButton(root: unknown, action: string, id: string): HTMLButtonElement {
  const domRoot = root as unknown as HTMLElement;
  const identifier = action === "open-room" ? `data-room-id="${id}"` : `data-user-id="${id}"`;
  const button = domRoot.querySelector(
    `[data-action="${action}"][${identifier}]`,
  ) as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  if (button === null) {
    throw new Error("BUTTON_MISSING");
  }
  return button;
}

function click(window: Window, target: unknown) {
  expect(target).not.toBeNull();
  const eventTarget = target as {
    dispatchEvent(event: unknown): boolean;
  };
  eventTarget.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function submit(window: Window, form: unknown) {
  expect(form).not.toBeNull();
  const eventTarget = form as {
    dispatchEvent(event: unknown): boolean;
  };
  eventTarget.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

function setInput(root: unknown, name: string, value: string) {
  const domRoot = root as unknown as HTMLElement;
  const input = domRoot.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  if (input !== null) {
    input.value = value;
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromiseValue, rejectPromiseValue) => {
    resolvePromise = resolvePromiseValue;
    rejectPromise = rejectPromiseValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushTasks() {
  await Promise.resolve();
  await new Promise<void>((resolveTask) => {
    setTimeout(resolveTask, 0);
  });
}

function cssHexVariable(rules: string, name: string) {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "iu").exec(rules);
  if (match?.[1] === undefined) {
    throw new Error(`Missing ${name}`);
  }
  return match[1];
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const light = Math.max(foregroundLuminance, backgroundLuminance);
  const dark = Math.min(foregroundLuminance, backgroundLuminance);
  return (light + 0.05) / (dark + 0.05);
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
