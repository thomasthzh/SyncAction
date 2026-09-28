// @vitest-environment happy-dom

import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicRoomSummarySchema } from "@syncaction/protocol";
import { App } from "../src/ui-vnext/app.js";
import {
  TestUiStore,
  byRole,
  change,
  click,
  failure,
  input,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

const rooms = [
  {
    roomId: "018f8f8e-4b5c-7d6e-8f90-123456789c41",
    name: "开放客厅",
    joinPolicy: "OPEN" as const,
    onlineCount: 3,
    memberCount: 5,
    openTabCount: 4,
    hasActivePlayback: true,
    updatedAt: "2026-07-30T00:00:00.000Z",
  },
  {
    roomId: "018f8f8e-4b5c-7d6e-8f90-123456789c42",
    name: "申请加入的房间",
    joinPolicy: "APPROVAL" as const,
    onlineCount: 1,
    memberCount: 2,
    openTabCount: 1,
    hasActivePlayback: false,
    updatedAt: "2026-07-30T00:00:00.000Z",
  },
  {
    roomId: "018f8f8e-4b5c-7d6e-8f90-123456789c43",
    name: "仅邀请",
    joinPolicy: "INVITE_ONLY" as const,
    onlineCount: 1,
    memberCount: 1,
    openTabCount: 0,
    hasActivePlayback: false,
    updatedAt: "2026-07-30T00:00:00.000Z",
  },
].map((room) => PublicRoomSummarySchema.parse(room));

async function flushUi(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
    }
  });
}

afterEach(() => {
  unmountPanel();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("vNext guest lobby", () => {
  it("places the default service status directly after the welcome strip", async () => {
    const store = new TestUiStore();
    const probe = vi.fn().mockResolvedValue({ latencyMs: 42 });
    const root = renderPanel(<App store={store} serviceStatusProbe={{ probe }} />);

    await flushUi();

    const card = root.querySelector(".welcome-strip + .service-status-card");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("默认节点 服务在线");
    expect(card?.textContent).toContain("v0.9.3");
    expect(card?.textContent).toContain("42 ms");
    expect(card?.textContent).toContain("syncaction.example.com");
    expect(probe).toHaveBeenCalledOnce();
    const publicRooms = root.querySelector('[data-editorial-surface="public-rooms"]')!;
    expect(card!.compareDocumentPosition(publicRooms) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows connection help while offline and retries in place", async () => {
    const store = new TestUiStore();
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ latencyMs: 55 });
    const root = renderPanel(<App store={store} serviceStatusProbe={{ probe }} />);

    await flushUi();
    expect(root.textContent).toContain("服务暂不可用");
    expect(root.textContent).toContain("请检查服务器地址、网络连接和服务器状态");

    await click(byRole(root, "button", "重新连接"));

    expect(probe).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain("默认节点 服务在线");
    expect(root.textContent).toContain("55 ms");
  });

  it("does not label a custom server as 默认节点 or invent its version", async () => {
    const store = new TestUiStore();
    store.update({
      shell: {
        ...store.shell.value,
        selectedProfileId: "team-server",
        profiles: [
          ...store.shell.value.profiles,
          {
            profileId: "team-server",
            baseUrl: "https://team.example:8443",
            mode: "VNEXT",
            metadata: {
              ...store.shell.value.profiles[0]!.metadata!,
              displayName: "Team Server",
              softwareVersion: null,
            },
            lastHealthyAt: 1,
          },
        ],
      },
    });
    const root = renderPanel(
      <App
        store={store}
        serviceStatusProbe={{ probe: vi.fn().mockResolvedValue({ latencyMs: 7 }) }}
      />,
    );

    await flushUi();

    const card = root.querySelector(".service-status-card");
    expect(card?.textContent).toContain("Team Server 服务在线");
    expect(card?.textContent).toContain("版本未提供");
    expect(card?.textContent).not.toContain("默认节点");
  });

  it("avoids overlapping or hidden health polling and refreshes when visible again", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((sample: { latencyMs: number }) => void) | undefined;
    const probe = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ latencyMs: number }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ latencyMs: 9 });
    renderPanel(<App store={new TestUiStore()} serviceStatusProbe={{ probe }} />);

    await flushUi();
    expect(probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledOnce();

    resolveFirst?.({ latencyMs: 8 });
    await flushUi();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledOnce();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushUi();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("places public rooms directly in the feed with policy-specific join actions", () => {
    const store = new TestUiStore();
    store.update({
      discovery: {
        ...store.discovery.value,
        publicRooms: rooms,
      },
    });
    const root = renderPanel(<App store={store} />);

    expect(root.textContent).toContain("公开房间");
    expect(root.querySelector('[data-editorial-surface="public-rooms"]')).not.toBeNull();
    expect(root.querySelector(".public-room-card")).toBeNull();
    expect(root.querySelectorAll(".public-room-row")).toHaveLength(3);
    expect(root.textContent).toContain("开放客厅");
    expect(root.textContent).toContain("3 在线");
    expect(root.textContent).toContain("4 个标签页");
    expect(root.textContent).toContain("正在播放");
    expect(byRole(root, "button", "直接加入")).toBeTruthy();
    expect(byRole(root, "button", "申请加入")).toBeTruthy();
    const inviteOnlyRow = [...root.querySelectorAll("[data-room-id]")].find(
      (row) => row.getAttribute("data-room-id") === rooms[2]!.roomId,
    );
    expect(inviteOnlyRow?.textContent).toContain("仅限邀请");
    expect(inviteOnlyRow?.querySelector("button")).toBeNull();
  });

  it("filters public rooms locally without changing the server-backed feed", async () => {
    const store = new TestUiStore();
    store.update({
      discovery: {
        ...store.discovery.value,
        publicRooms: rooms,
      },
    });
    const root = renderPanel(<App store={store} />);
    const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索公开房间"]');

    expect(search).not.toBeNull();
    expect(root.querySelectorAll(".public-room-row")).toHaveLength(3);

    input(search!, "申请");
    expect(root.querySelectorAll(".public-room-row")).toHaveLength(1);
    expect(root.textContent).toContain("申请加入的房间");
    expect(root.textContent).not.toContain("开放客厅");

    input(search!, "不存在");
    expect(root.querySelectorAll(".public-room-row")).toHaveLength(0);
    expect(root.textContent).toContain("没有匹配的公开房间");
    expect(store.commandCalls).toHaveLength(0);
  });

  it("keeps an empty or reconnecting feed useful and nonblocking", () => {
    const store = new TestUiStore();
    store.transport.value = "RECONNECTING";
    const root = renderPanel(<App store={store} />);

    expect(root.textContent).toContain("连接正在恢复");
    expect(root.textContent).toContain("暂时没有公开房间");
    expect(byRole(root, "button", "刷新")).toBeTruthy();
    expect(byRole(root, "button", "登录 | 注册")).toBeTruthy();
  });

  it("replays one authenticated join only while its server and room remain current", async () => {
    const store = new TestUiStore();
    store.update({
      discovery: {
        ...store.discovery.value,
        publicRooms: rooms,
      },
    });
    store.responder = async (command) => {
      if (command.name === "ROOM_JOIN_OPEN" && store.shell.value.phase === "SIGNED_OUT") {
        return failure("AUTHENTICATION_REQUIRED");
      }
      if (command.name === "AUTH_LOGIN") {
        store.update({
          shell: {
            ...store.shell.value,
            phase: "AUTHENTICATED_NO_ROOM",
            account: {
              id: "018f8f8e-4b5c-7d6e-8f90-123456789c44",
              username: "aming",
              displayName: "阿明",
              status: "ACTIVE",
              passwordResetRequired: false,
              createdAt: "2026-07-30T00:00:00.000Z",
            },
          },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "直接加入"));
    expect(root.querySelector('[role="dialog"]')?.textContent).toContain("登录 SyncAction");
    input(root.querySelector('input[name="username"]')!, "aming");
    input(root.querySelector('input[name="password"]')!, "correct horse");
    await click(root.querySelector('button[type="submit"]')!);

    expect(store.commandCalls.map(({ name }) => name)).toEqual([
      "ROOM_JOIN_OPEN",
      "AUTH_LOGIN",
      "ROOM_JOIN_OPEN",
    ]);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not replay a deferred join after the public room disappears", async () => {
    const store = new TestUiStore();
    store.update({
      discovery: {
        ...store.discovery.value,
        publicRooms: rooms,
      },
    });
    store.responder = async (command) => {
      if (command.name === "ROOM_JOIN_REQUEST") {
        return failure("AUTHENTICATION_REQUIRED");
      }
      if (command.name === "AUTH_LOGIN") {
        store.update({
          discovery: {
            ...store.discovery.value,
            publicRooms: [],
          },
        });
      }
      return success();
    };
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "申请加入"));
    input(root.querySelector('input[name="username"]')!, "aming");
    input(root.querySelector('input[name="password"]')!, "correct horse");
    await click(root.querySelector('button[type="submit"]')!);

    expect(store.commandCalls.map(({ name }) => name)).toEqual(["ROOM_JOIN_REQUEST", "AUTH_LOGIN"]);
  });

  it("creates private invite-only rooms by default and public approval rooms explicitly", async () => {
    const store = new TestUiStore();
    store.update({
      shell: {
        ...store.shell.value,
        phase: "AUTHENTICATED_NO_ROOM",
        account: {
          id: "018f8f8e-4b5c-7d6e-8f90-123456789c45",
          username: "owner",
          displayName: "房主",
          status: "ACTIVE",
          passwordResetRequired: false,
          createdAt: "2026-07-30T00:00:00.000Z",
        },
      },
    });
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "创建房间"));
    const visibility = root.querySelector<HTMLSelectElement>('select[name="visibility"]')!;
    const policy = root.querySelector<HTMLSelectElement>('select[name="joinPolicy"]')!;
    expect(visibility.value).toBe("PRIVATE");
    expect(policy.value).toBe("INVITE_ONLY");
    expect([...policy.options].map(({ value }) => value)).toEqual(["INVITE_ONLY"]);

    change(visibility, "PUBLIC");
    expect(policy.value).toBe("APPROVAL");
    expect([...policy.options].map(({ value }) => value)).toEqual([
      "OPEN",
      "APPROVAL",
      "INVITE_ONLY",
    ]);
    input(root.querySelector('input[name="name"]')!, "周末观影");
    await click(byRole(root, "button", "创建"));

    expect(store.commandCalls.at(-1)).toEqual({
      name: "ROOM_CREATE",
      payload: {
        name: "周末观影",
        visibility: "PUBLIC",
        joinPolicy: "APPROVAL",
      },
    });
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps five-room capacity failures inside the create dialog", async () => {
    const store = new TestUiStore();
    store.update({
      shell: {
        ...store.shell.value,
        phase: "AUTHENTICATED_NO_ROOM",
        account: {
          id: "018f8f8e-4b5c-7d6e-8f90-123456789c46",
          username: "owner",
          displayName: "房主",
          status: "ACTIVE",
          passwordResetRequired: false,
          createdAt: "2026-07-30T00:00:00.000Z",
        },
      },
    });
    store.responder = async () => failure("ROOM_CAPACITY_REACHED");
    const root = renderPanel(<App store={store} />);

    await click(byRole(root, "button", "创建房间"));
    input(root.querySelector('input[name="name"]')!, "第六个房间");
    await click(byRole(root, "button", "创建"));

    expect(root.textContent).toContain("本服务器普通用户同时最多创建 5 个房间");
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
