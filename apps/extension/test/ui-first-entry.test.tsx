// @vitest-environment happy-dom

import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import { createVisualStore } from "../visual/fixture-store.js";
import type { PendingRoomJoin, PendingRoomJoinStorage } from "../src/pending-room-join.js";
import {
  TestUiStore,
  byRole,
  click,
  failure,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

afterEach(() => unmountPanel());

function lobby() {
  const store = new TestUiStore();
  const room = createVisualStore("lobby").discovery.value.publicRooms.find(
    ({ joinPolicy }) => joinPolicy === "OPEN",
  )!;
  store.update({ discovery: { ...store.discovery.value, publicRooms: [room] } });
  return { store, room };
}

function destination(store: TestUiStore, room: ReturnType<typeof lobby>["room"]): PendingRoomJoin {
  const profile = store.shell.value.profiles[0]!;
  return {
    version: 1,
    profileId: profile.profileId,
    serverOrigin: profile.baseUrl,
    serverId: profile.metadata!.serverId,
    roomId: room.roomId,
    roomName: room.name,
    joinPolicy: "OPEN",
  };
}

describe("first entry and recoverable room destination", () => {
  it("opens authentication for the actual SESSION_REQUIRED code", async () => {
    const { store } = lobby();
    store.responder = async () => failure("SESSION_REQUIRED");
    const root = renderPanel(<App store={store} />);
    await click(byRole(root, "button", "直接加入"));
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain("登录 SyncAction");
    expect(root.textContent).not.toContain("操作未完成（SESSION_REQUIRED）");
  });

  it("shows pending approval as a login task, with no create or account-settings action", () => {
    const { store } = lobby();
    store.update({
      shell: {
        ...store.shell.value,
        phase: "ACCOUNT_PENDING",
        account: {
          id: "018f8f8e-4b5c-7d6e-8f90-123456789c44",
          username: "waiting",
          displayName: "等待批准",
          status: "PENDING",
          passwordResetRequired: false,
          createdAt: "2026-07-30T00:00:00.000Z",
        },
      },
    });
    const root = renderPanel(<App store={store} />);
    expect(root.textContent).toContain("批准后登录");
    expect(root.textContent).not.toContain("创建房间");
    expect(root.querySelector('[aria-label^="账户设置"]')).toBeNull();
    expect(byRole(root, "button", "登录 | 注册")).toBeTruthy();
  });

  it("does not probe the distribution placeholder and starts directly with server input", async () => {
    const store = new TestUiStore();
    store.update({
      shell: {
        ...store.shell.value,
        profiles: [
          {
            ...store.shell.value.profiles[0]!,
            baseUrl: "https://syncaction.example.com",
            mode: "UNVERIFIED",
            metadata: null,
          },
        ],
      },
    });
    const probe = vi.fn(async () => ({ latencyMs: 1 }));
    const candidate = {
      baseUrl: "https://friends.example",
      mode: "VNEXT" as const,
      metadata: { ...new TestUiStore().shell.value.profiles[0]!.metadata! },
      healthyAt: 1,
    };
    const verifyFromClick = vi.fn(async () => candidate);
    store.responder = async (command) => {
      if (command.name === "SERVER_ADD") {
        store.update({
          shell: {
            ...store.shell.value,
            profiles: [
              ...store.shell.value.profiles,
              { ...candidate, profileId: "friends", lastHealthyAt: 1 },
            ],
          },
        });
        return success("friends");
      }
      if (command.name === "SERVER_SELECT") {
        store.update({ shell: { ...store.shell.value, selectedProfileId: "friends" } });
      }
      return success();
    };
    const root = renderPanel(
      <App store={store} serviceStatusProbe={{ probe }} serverVerifier={{ verifyFromClick }} />,
    );
    expect(root.textContent).toContain("先连接你的服务器");
    expect(probe).not.toHaveBeenCalled();
    await click(byRole(root, "button", "配置服务器"));
    input(root.querySelector('input[name="serverUrl"]')!, candidate.baseUrl);
    await click(byRole(root, "button", "验证服务器"));
    await click(byRole(root, "button", "保存并连接"));
    expect(store.commandCalls.map(({ name }) => name)).toEqual(["SERVER_ADD", "SERVER_SELECT"]);
    expect(root.textContent).not.toContain("先连接你的服务器");
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not let a late storage read replace a newly chosen room", async () => {
    const { store, room } = lobby();
    let resolveRead!: (value: PendingRoomJoin | null) => void;
    const storage: PendingRoomJoinStorage = {
      read: () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
      write: vi.fn(async () => undefined),
    };
    store.responder = async () => failure("SESSION_REQUIRED");
    const root = renderPanel(<App store={store} pendingRoomJoinStorage={storage} />);
    await click(byRole(root, "button", "直接加入"));
    await act(async () =>
      resolveRead({
        ...destination(store, room),
        roomName: "旧的任务",
        roomId: "018f8f8e-4b5c-7d6e-8f90-123456789c99",
      }),
    );
    await click(byRole(root, "button", "取消"));
    expect(root.textContent).not.toContain("旧的任务");
    expect(storage.write).toHaveBeenLastCalledWith(null);
  });

  it("clears the saved destination when switching profiles before login", async () => {
    const { store, room } = lobby();
    const storage: PendingRoomJoinStorage = {
      read: async () => destination(store, room),
      write: vi.fn(async () => undefined),
    };
    const other = {
      ...store.shell.value.profiles[0]!,
      profileId: "other-team",
      baseUrl: "https://other-team.example",
    };
    store.update({
      shell: { ...store.shell.value, profiles: [...store.shell.value.profiles, other] },
    });
    store.responder = async (command) => {
      if (command.name === "SERVER_SELECT")
        store.update({ shell: { ...store.shell.value, selectedProfileId: other.profileId } });
      return success();
    };
    const root = renderPanel(<App store={store} pendingRoomJoinStorage={storage} />);
    await vi.waitFor(() => expect(root.textContent).toContain(`继续加入 ${room.name}`));
    await click(byRole(root, "button", "切换服务器，当前 demo.syncaction.example"));
    await click(byRole(root, "button", `选择 ${other.metadata!.displayName}`));
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledWith(null));
    expect(root.textContent).not.toContain(`继续加入 ${room.name}`);
    expect(store.commandCalls.filter(({ name }) => name === "ROOM_JOIN_OPEN")).toHaveLength(0);
  });

  it("invalidates a target removed from the public catalog instead of joining it", async () => {
    const { store, room } = lobby();
    const storage: PendingRoomJoinStorage = {
      read: async () => destination(store, room),
      write: vi.fn(async () => undefined),
    };
    const root = renderPanel(<App store={store} pendingRoomJoinStorage={storage} />);
    await vi.waitFor(() => expect(root.textContent).toContain(`继续加入 ${room.name}`));
    act(() => store.update({ discovery: { ...store.discovery.value, publicRooms: [] } }));
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledWith(null));
    expect(root.textContent).not.toContain(`继续加入 ${room.name}`);
    expect(store.commandCalls).toHaveLength(0);
  });

  it("retains a destination when a failed catalog load does not prove that the room disappeared", async () => {
    const { store, room } = lobby();
    const saved = destination(store, room);
    store.update({
      shell: { ...store.shell.value, errorCode: "PUBLIC_CATALOG_UNAVAILABLE" },
      discovery: { ...store.discovery.value, publicRooms: [] },
    });
    const storage: PendingRoomJoinStorage = {
      read: async () => saved,
      write: vi.fn(async () => undefined),
    };
    const root = renderPanel(<App store={store} pendingRoomJoinStorage={storage} />);
    await vi.waitFor(() => expect(root.textContent).toContain(`继续加入 ${room.name}`));
    expect(storage.write).not.toHaveBeenCalled();
    expect(store.commandCalls).toHaveLength(0);
  });

  it.each(["serverOrigin", "serverId"] as const)(
    "drops a restored destination if %s changed under the same profile",
    async (field) => {
      const { store, room } = lobby();
      const old = {
        ...destination(store, room),
        [field]:
          field === "serverOrigin"
            ? "https://other.example"
            : "018f8f8e-4b5c-7d6e-8f90-123456789c99",
      };
      const storage: PendingRoomJoinStorage = {
        read: async () => old,
        write: vi.fn(async () => undefined),
      };
      const root = renderPanel(<App store={store} pendingRoomJoinStorage={storage} />);
      await vi.waitFor(() => expect(storage.write).toHaveBeenCalledWith(null));
      expect(root.textContent).not.toContain("继续加入");
      expect(store.commandCalls).toEqual([]);
    },
  );

  it("restores a room destination without restoring credentials, and allows explicit cancellation", async () => {
    const { store, room } = lobby();
    const storage: PendingRoomJoinStorage = {
      read: async () => destination(store, room),
      write: vi.fn(async () => undefined),
    };
    const root = renderPanel(<App store={store} pendingRoomJoinStorage={storage} />);
    await vi.waitFor(() => expect(root.textContent).toContain(`继续加入 ${room.name}`));
    await click(byRole(root, "button", `继续加入 ${room.name}`));
    expect(root.querySelector<HTMLInputElement>('input[name="password"]')?.value).toBe("");
    await click(byRole(root, "button", "取消"));
    expect(storage.write).toHaveBeenLastCalledWith(null);
  });
});
