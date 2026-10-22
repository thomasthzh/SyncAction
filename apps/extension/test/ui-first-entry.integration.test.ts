// @vitest-environment happy-dom

import { randomUUID } from "node:crypto";
import { h } from "preact";
import { createDatabase, migrateToLatest } from "@syncaction/database";
import { AccountService, AdminService, createAccessTokenCodec } from "@syncaction/identity";
import { RoomService } from "@syncaction/rooms";
import { buildPublicApp } from "@syncaction/server/app";
import { RoomSequencer } from "@syncaction/sync";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncActionApiClient } from "../src/api-client.js";
import { ExtensionAppController, type RoomRuntime } from "../src/app-controller.js";
import { ExtensionCommandRouter } from "../src/extension-command-router.js";
import { getOrCreateInstallationId } from "../src/installation-identity.js";
import { createPendingRoomJoinStorage, PENDING_ROOM_JOIN_KEY } from "../src/pending-room-join.js";
import { ExtensionSessionManager } from "../src/product-session.js";
import { ServerProfileStore } from "../src/server-profile.js";
import { CustomServerVerifier } from "../src/server-host-permission.js";
import { UiStateHub, type UiStateHubPort } from "../src/ui/ui-state-hub.js";
import { UiPortClient, type UiPortClientPort } from "../src/ui/ui-port-client.js";
import { App } from "../src/ui-vnext/app.js";
import { createUiStore } from "../src/ui-vnext/store.js";
import {
  baseSlices,
  byRole,
  click,
  input,
  renderPanel,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined)
  throw new Error("TEST_DATABASE_URL is required for integration tests");
const origin = "https://entry.example";
const password = "first collaboration password";
let db: ReturnType<typeof createDatabase>;
let http: Awaited<ReturnType<typeof buildPublicApp>>;
let api: SyncActionApiClient;
let admins: AdminService;
let administratorId: string;
const requestedPaths: string[] = [];
const disposePanels: Array<() => void> = [];

class MemoryArea {
  public readonly values: Record<string, unknown> = {};
  async get(key: string) {
    return { [key]: structuredClone(this.values[key]) };
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.values, structuredClone(items));
  }
  async remove(key: string) {
    delete this.values[key];
  }
}

class LinkedPort implements UiStateHubPort, UiPortClientPort {
  peer!: LinkedPort;
  readonly messages = new Set<(message: unknown) => void>();
  readonly disconnects = new Set<() => void>();
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => {
      this.messages.add(listener);
    },
    removeListener: (listener: (message: unknown) => void) => {
      this.messages.delete(listener);
    },
  };
  readonly onDisconnect = {
    addListener: (listener: () => void) => {
      this.disconnects.add(listener);
    },
    removeListener: (listener: () => void) => {
      this.disconnects.delete(listener);
    },
  };
  postMessage(message: unknown) {
    queueMicrotask(() =>
      this.peer.messages.forEach((listener) => listener(structuredClone(message))),
    );
  }
  disconnect() {
    this.disconnects.forEach((listener) => listener());
    this.peer.disconnects.forEach((listener) => listener());
  }
}

const injectFetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : input.url,
  );
  if (url.origin !== origin) throw new Error("Unexpected test origin");
  requestedPaths.push(`${init?.method ?? "GET"} ${url.pathname}`);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const response = await http.inject({
    method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE",
    url: `${url.pathname}${url.search}`,
    headers,
    ...(init?.body === undefined ? {} : { payload: String(init.body) }),
  });
  return new Response(response.statusCode === 204 ? null : response.body, {
    status: response.statusCode,
    headers: { "content-type": "application/json" },
  });
};

beforeAll(async () => {
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  const accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "entry-test",
      audience: "extension",
      secret: new Uint8Array(32).fill(57),
    }),
  });
  admins = new AdminService({ db, totpEncryptionKey: new Uint8Array(32).fill(59) });
  http = await buildPublicApp({
    db,
    accounts,
    rooms: new RoomService({ db }),
    sequencer: new RoomSequencer({ db }),
    annotationHmacKey: new Uint8Array(32).fill(61),
    authRateLimitMax: 100,
    logger: false,
  });
  api = new SyncActionApiClient({ serverUrl: origin, fetch: injectFetch });
});

beforeEach(async () => {
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("passwordResetGrants").execute();
  await db.deleteFrom("adminSessions").execute();
  await db.deleteFrom("administrators").execute();
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
  administratorId = (
    await admins.bootstrap({
      username: "EntryAdmin",
      password,
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    })
  ).id;
  requestedPaths.length = 0;
});

afterEach(() => {
  unmountPanel();
  disposePanels.splice(0).forEach((dispose) => dispose());
});
afterAll(async () => {
  await http.close();
  await db.destroy();
});

async function approve(username: string) {
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("usernameNormalized", "=", username.toLowerCase())
    .executeTakeFirstOrThrow();
  await admins.approveUser({ administratorId, userId: user.id });
}

async function publicRoom() {
  await api.register({ username: "entry-owner", displayName: "Owner", password });
  await approve("entry-owner");
  const owner = await api.login({ username: "entry-owner", password, deviceId: randomUUID() });
  return api.createRoom(owner.accessToken, {
    name: "原来的观影房间",
    visibility: "PUBLIC",
    joinPolicy: "OPEN",
  });
}

async function panel(area = new MemoryArea(), configured = true) {
  const profiles = new ServerProfileStore({ area, createProfileId: () => "entry-server" });
  await profiles.initialize();
  const meta = await api.getMeta();
  if (
    configured &&
    !(await profiles.list()).some(({ profileId }) => profileId === "entry-server")
  ) {
    await profiles.addCandidate(
      { baseUrl: origin, mode: "VNEXT", metadata: meta, healthyAt: Date.now() },
      { select: true },
    );
  }
  if (!configured) {
    const state = {
      version: 1,
      selectedProfileId: "syncaction-production",
      profiles: [
        {
          profileId: "syncaction-production",
          baseUrl: "https://syncaction.example.com",
          mode: "UNVERIFIED",
          metadata: null,
          lastHealthyAt: null,
        },
      ],
    };
    await area.set({ "syncaction.server-profiles.v1": state });
  }
  const activeProfiles = configured
    ? profiles
    : new ServerProfileStore({ area, createProfileId: () => "entry-server" });
  const sessions = new ExtensionSessionManager({
    area,
    rotate: ({ refreshToken }) => api.refresh(refreshToken),
  });
  const controller = new ExtensionAppController({
    deviceId: await getOrCreateInstallationId(area, randomUUID),
    area,
    profiles: activeProfiles,
    sessions,
    clientVersion: "0.9.9",
    apiFactory: (baseUrl) => new SyncActionApiClient({ serverUrl: baseUrl, fetch: injectFetch }),
    publicTransportFactory: () => ({
      async start() {},
      async stop() {},
      setInvalidatedHandler() {},
    }),
    onboarding: {
      async isRequired() {
        return false;
      },
      async dismiss() {
        return true;
      },
    },
    // This test covers admission, not third-party browser execution or realtime media.
    runtimeFactory: async ({ room }): Promise<RoomRuntime> => {
      const unsupported = async (): Promise<never> => {
        throw new Error("Browser execution is outside this admission test");
      };
      return {
        async start() {},
        async stop() {},
        async getStatus() {
          return {
            state: "SYNCED",
            roomName: room.name,
            serverSeq: 0,
            sharedTabCount: 0,
            outboxCount: 0,
            pendingConfirmationCount: 0,
            bindingCount: 0,
            browser: null,
            presence: null,
            pointer: null,
            media: null,
            tabs: [],
          };
        },
        handleBrowserEvent: unsupported,
        handleActiveTabChanged: unsupported,
        handlePointerPageReady: unsupported,
        handleMediaPageReady: unsupported,
        handleMediaObserved: unsupported,
        handlePointerLocalSample: unsupported,
        handlePageCapability: unsupported,
        handlePagePermissionBoundaryChanged: unsupported,
        toggleDanmakuInput: unsupported,
        togglePagePen: unsupported,
        jumpToMediaMember: unsupported,
        alignMediaGroupOnce: unsupported,
        joinMediaGroup: unsupported,
        decideMediaProposal: unsupported,
        shareBrowserTab: unsupported,
        confirmBrowserRecovery: unsupported,
      };
    },
  });
  await controller.start();
  const router = new ExtensionCommandRouter({
    app: controller,
    browser: {
      tabs: {
        async query() {
          return [];
        },
      },
    },
    pageCollaborationPort: {
      async refreshOriginAccess() {},
      async removeOrigin() {
        return true;
      },
    },
    commandBindings: {
      async read() {
        throw new Error("Shortcut lookup is outside this admission test");
      },
    },
    originConsents: { async markPolicySynchronized() {} },
  });
  const hub = new UiStateHub({
    source: {
      readStatus: () => controller.getStatus(),
      readProfiles: () => activeProfiles.list(),
      async readPageAccess() {
        return baseSlices().pageAccess;
      },
      subscribeChanged: (listener) => controller.subscribe(listener),
      execute: (command) => router.execute(command),
    },
  });
  const serverPort = new LinkedPort();
  const clientPort = new LinkedPort();
  serverPort.peer = clientPort;
  clientPort.peer = serverPort;
  const client = new UiPortClient({
    connect: () => {
      void hub.attach(serverPort);
      return clientPort;
    },
  });
  const store = createUiStore(client);
  client.start();
  await vi.waitFor(() => expect(store.transport.value).toBe("CONNECTED"));
  const root = renderPanel(
    h(App, {
      store,
      pendingRoomJoinStorage: createPendingRoomJoinStorage(area),
      serverVerifier: new CustomServerVerifier({
        permissions: {
          async request() {
            return true;
          },
        },
        fetch: injectFetch,
      }),
    }),
  );
  const dispose = () => {
    store.dispose();
    client.dispose();
    hub.dispose();
  };
  disposePanels.push(dispose);
  return { root, store, area, dispose };
}

function credentials(root: HTMLElement, username: string) {
  input(root.querySelector('input[name="username"]')!, username);
  input(root.querySelector('input[name="password"]')!, password);
}

describe("first room entry through HTTP, controller, router, hub and UI", () => {
  it("authenticates after the real SESSION_REQUIRED result and joins once", async () => {
    const room = await publicRoom();
    await api.register({ username: "entry-reader", displayName: "Reader", password });
    await approve("entry-reader");
    const { root, store } = await panel();
    await click(byRole(root, "button", "直接加入"));
    await vi.waitFor(() => expect(root.querySelector('input[name="username"]')).not.toBeNull());
    credentials(root, "entry-reader");
    await click(root.querySelector('button[type="submit"]')!);
    await vi.waitFor(() => expect(store.room.value.selectedRoomId).toBe(room.id));
    expect(requestedPaths.filter((path) => path === `POST /v1/rooms/${room.id}/join`)).toHaveLength(
      1,
    );
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("retains the destination across registration and panel/controller restart, then explicitly logs in after actual approval", async () => {
    const room = await publicRoom();
    const first = await panel();
    await click(byRole(first.root, "button", "直接加入"));
    await vi.waitFor(() =>
      expect(first.root.querySelector('input[name="username"]')).not.toBeNull(),
    );
    await click(byRole(first.root, "button", "注册"));
    credentials(first.root, "pending-reader");
    input(first.root.querySelector('input[name="displayName"]')!, "等待批准的人");
    await click(first.root.querySelector('button[type="submit"]')!);
    await vi.waitFor(() => expect(first.store.shell.value.phase).toBe("ACCOUNT_PENDING"));
    await vi.waitFor(() => expect(first.root.querySelector('[role="dialog"]')).toBeNull());
    expect(first.root.textContent).not.toContain("创建房间");
    expect(
      await api.login({ username: "pending-reader", password, deviceId: randomUUID() }).then(
        () => "unexpected success",
        (error: unknown) => (error as { code: string }).code,
      ),
    ).toBe("ACCOUNT_PENDING");
    await vi.waitFor(() =>
      expect(first.area.values[PENDING_ROOM_JOIN_KEY]).toMatchObject({ roomId: room.id }),
    );
    expect(JSON.stringify(first.area.values[PENDING_ROOM_JOIN_KEY])).not.toContain(password);
    unmountPanel();
    first.dispose();
    await approve("pending-reader");
    const second = await panel(first.area);
    await vi.waitFor(() => expect(second.root.textContent).toContain(`继续加入 ${room.name}`));
    await click(byRole(second.root, "button", `继续加入 ${room.name}`));
    expect(second.root.querySelector<HTMLInputElement>('input[name="password"]')!.value).toBe("");
    credentials(second.root, "pending-reader");
    await click(second.root.querySelector('button[type="submit"]')!);
    await vi.waitFor(() => expect(second.store.room.value.selectedRoomId).toBe(room.id));
    expect(requestedPaths.filter((path) => path === `POST /v1/rooms/${room.id}/join`)).toHaveLength(
      1,
    );
    await vi.waitFor(() => expect(second.area.values[PENDING_ROOM_JOIN_KEY]).toBeUndefined());
  });

  it("configures a fresh placeholder installation through verifier, add and select without requesting the placeholder", async () => {
    const { root, store } = await panel(new MemoryArea(), false);
    expect(root.textContent).toContain("先连接你的服务器");
    await click(byRole(root, "button", "配置服务器"));
    input(root.querySelector('input[name="serverUrl"]')!, origin);
    await click(byRole(root, "button", "验证服务器"));
    await vi.waitFor(() => expect(root.querySelector('[aria-label="保存并连接"]')).not.toBeNull());
    await click(byRole(root, "button", "保存并连接"));
    await vi.waitFor(() => expect(store.shell.value.selectedProfileId).toBe("entry-server"));
    expect(store.shell.value.phase).toBe("SIGNED_OUT");
    await vi.waitFor(() => expect(root.querySelector('[role="dialog"]')).toBeNull());
    expect(root.textContent).not.toContain("先连接你的服务器");
  });
});
