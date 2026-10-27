// @vitest-environment happy-dom

import { RoomIdSchema } from "@syncaction/protocol";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiCommandResult, UiPageAccessSlice } from "../src/ui/ui-protocol.js";
import { BottomActionDock } from "../src/ui-vnext/components/bottom-action-dock.js";
import {
  TestUiStore,
  byRole,
  click,
  failure,
  renderPanel,
  success,
  unmountPanel,
} from "./ui-vnext-test-harness.js";

const roomId = RoomIdSchema.parse("00000000-0000-4000-8000-000000000501");
const otherRoomId = RoomIdSchema.parse("00000000-0000-4000-8000-000000000502");
const url = "https://watch.example/watch?id=1";
const revision = { roomEpoch: 1, tabUpdatedAtSeq: 7 };

function harness(access: Partial<UiPageAccessSlice> = {}) {
  const store = new TestUiStore();
  store.update({
    room: { ...store.room.value, selectedRoomId: roomId },
    pageAccess: {
      ...store.pageAccess.value,
      tabId: 42,
      origin: "https://watch.example",
      supported: true,
      browserPermissionGranted: true,
      termsAccepted: true,
      serverTermsVersion: "v1",
      reason: "ROOM_DOCUMENT_UNAVAILABLE",
      ...access,
    },
  });
  store.responder = async (command) =>
    command.name === "CURRENT_TAB_SHARE"
      ? success({ kind: "INTENT_RECORDED", sharedPageContext: { tabId: 42, url } })
      : success();
  const requestPermission = vi.fn();
  const root = renderPanel(
    <BottomActionDock
      store={store}
      isOwner
      onOpenInvite={() => {}}
      onOpenRoomLifecycle={() => {}}
      onRequestPagePermission={requestPermission}
    />,
  );
  return { store, root, requestPermission };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  });
}

async function ready(store: TestUiStore, next: Partial<UiPageAccessSlice> = {}): Promise<void> {
  act(() =>
    store.update({
      pageAccess: {
        ...store.pageAccess.value,
        documentRevision: revision,
        contentCompatibility: "EXACT",
        enabledFeatures: ["DANMAKU", "DRAWING"],
        reason: null,
        ...next,
      },
    }),
  );
  await flush();
}

afterEach(() => {
  unmountPanel();
  vi.useRealTimers();
});

describe("page tool preparation continuation", () => {
  it("waits for the real room document and resumes exactly once with the captured context", async () => {
    const { store, root } = harness();
    await click(byRole(root, "button", "画笔"));
    await click(byRole(root, "button", "分享当前页并启用画笔"));
    expect(store.commandCalls.map((command) => command.name)).toEqual([
      "CURRENT_TAB_SHARE",
      "PAGE_PERMISSION_REFRESH",
    ]);
    expect(root.textContent).toContain("正在确认房间页面");
    expect(root.textContent).not.toContain("操作已完成");
    await ready(store);
    expect(store.commandCalls[2]).toEqual({
      name: "PEN_TOGGLE",
      payload: {
        expectedContext: {
          profileId: "syncaction-production",
          roomId,
          tabId: 42,
          url,
          documentRevision: revision,
        },
      },
    });
    expect(root.textContent).toContain("画笔操作已完成");
    expect(root.querySelector('[aria-label="准备画笔"]')).toBeNull();
    await ready(store, { documentRevision: { ...revision, tabUpdatedAtSeq: 8 } });
    expect(store.commandCalls).toHaveLength(3);
  });

  it("waits for sharing before opening the original site-permission dialog", async () => {
    const { store, root, requestPermission } = harness({
      browserPermissionGranted: false,
      termsAccepted: false,
    });
    await click(byRole(root, "button", "弹幕"));
    expect(requestPermission).not.toHaveBeenCalled();
    await click(byRole(root, "button", "分享当前页并启用弹幕"));
    await ready(store, { enabledFeatures: [] });
    expect(requestPermission).toHaveBeenCalledExactlyOnceWith("danmaku", url);
    expect(store.commandCalls.map((command) => command.name)).toEqual([
      "CURRENT_TAB_SHARE",
      "PAGE_PERMISSION_REFRESH",
    ]);
    expect(root.textContent).not.toContain("操作已完成");
  });

  it.each([
    [{ kind: "BLOCKED", reason: "ROOM_NOT_READY" }, "房间尚未准备好"],
    [{ kind: "IGNORED", reason: "LOADING" }, "页面仍在加载"],
    [{ kind: "RECOVERY_REQUIRED" }, "恢复提示"],
  ])(
    "does not continue a share result that did not submit the page: %j",
    async (value, message) => {
      const { store, root } = harness();
      store.responder = async () => success(value);
      await click(byRole(root, "button", "画笔"));
      await click(byRole(root, "button", "分享当前页并启用画笔"));
      expect(store.commandCalls).toEqual([
        {
          name: "CURRENT_TAB_SHARE",
          payload: {
            expectedContext: { profileId: store.shell.value.selectedProfileId, roomId, tabId: 42 },
          },
        },
      ]);
      expect(root.textContent).toContain(message);
      expect(root.textContent).not.toContain("操作已完成");
      await ready(store);
      expect(store.commandCalls).toHaveLength(1);
    },
  );

  it.each([undefined, { tabId: 43, url }, { tabId: 42, url: "https://another.example/watch" }])(
    "rejects a share ACK without the exact browser-page context: %j",
    async (sharedPageContext) => {
      const { store, root } = harness();
      store.responder = async () => success({ kind: "INTENT_RECORDED", sharedPageContext });
      await click(byRole(root, "button", "画笔"));
      await click(byRole(root, "button", "分享当前页并启用画笔"));
      expect(root.textContent).toContain("页面、房间或服务器已变化");
      expect(store.commandCalls).toHaveLength(1);
    },
  );

  it.each([
    ["UNKNOWN", "CONTENT_UNKNOWN", "页面一致性尚未验证"],
    ["MISMATCH", "CONTENT_MISMATCH", "页面内容与对方不同"],
  ] as const)(
    "keeps positional-content protection for %s while allowing the policy-approved text tool",
    async (compatibility, reason, explanation) => {
      const { store, root } = harness();
      await click(byRole(root, "button", "画笔"));
      await click(byRole(root, "button", "分享当前页并启用画笔"));
      await ready(store, {
        contentCompatibility: compatibility,
        enabledFeatures: ["DANMAKU"],
        reason,
      });
      expect(root.textContent).toContain(explanation);
      expect(store.commandCalls).not.toContainEqual(
        expect.objectContaining({ name: "PEN_TOGGLE" }),
      );
      await click(byRole(root, "button", "弹幕"));
      expect(store.commandCalls.at(-1)).toEqual({ name: "DANMAKU_TOGGLE" });
    },
  );

  it.each(["tab", "origin", "profile", "room"])(
    "cancels a pending share if the %s changes",
    async (change) => {
      const { store, root, requestPermission } = harness();
      let resolveShare: (result: UiCommandResult) => void = () => {};
      store.responder = async () =>
        new Promise((resolve) => {
          resolveShare = resolve;
        });
      await click(byRole(root, "button", "画笔"));
      await click(byRole(root, "button", "分享当前页并启用画笔"));
      act(() => {
        if (change === "tab")
          store.update({ pageAccess: { ...store.pageAccess.value, tabId: 43 } });
        if (change === "origin")
          store.update({
            pageAccess: { ...store.pageAccess.value, origin: "https://another.example" },
          });
        if (change === "profile")
          store.update({ shell: { ...store.shell.value, selectedProfileId: "another-profile" } });
        if (change === "room")
          store.update({ room: { ...store.room.value, selectedRoomId: otherRoomId } });
      });
      expect(root.textContent).toContain("页面、房间或服务器已变化");
      resolveShare(success({ kind: "INTENT_RECORDED", sharedPageContext: { tabId: 42, url } }));
      await flush();
      expect(store.commandCalls).toHaveLength(1);
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );

  it("does not revive an intent after cancellation or a late share response", async () => {
    const { store, root } = harness();
    let resolveShare: (result: UiCommandResult) => void = () => {};
    store.responder = async () =>
      new Promise((resolve) => {
        resolveShare = resolve;
      });
    await click(byRole(root, "button", "画笔"));
    const confirm = byRole(root, "button", "分享当前页并启用画笔");
    await act(async () => {
      confirm.click();
      confirm.click();
      await Promise.resolve();
    });
    expect(store.commandCalls).toHaveLength(1);
    await click(byRole(root, "button", "取消启用"));
    await click(byRole(root, "button", "弹幕"));
    resolveShare(success({ kind: "INTENT_RECORDED", sharedPageContext: { tabId: 42, url } }));
    await flush();
    expect(store.commandCalls).toHaveLength(1);
    expect(byRole(root, "button", "分享当前页并启用弹幕")).toBeDefined();
  });

  it("blocks a second dock command in the same render as share confirmation", async () => {
    const { store, root } = harness();
    let resolveShare: (result: UiCommandResult) => void = () => {};
    store.responder = async () =>
      new Promise((resolve) => {
        resolveShare = resolve;
      });
    await click(byRole(root, "button", "画笔"));
    const confirm = byRole(root, "button", "分享当前页并启用画笔");
    const manualShare = byRole(root, "button", "分享当前页");
    await act(async () => {
      confirm.click();
      manualShare.click();
      await Promise.resolve();
    });
    expect(store.commandCalls).toHaveLength(1);
    await click(byRole(root, "button", "取消启用"));
    resolveShare(success({ kind: "INTENT_RECORDED", sharedPageContext: { tabId: 42, url } }));
    await flush();
  });

  it("stops waiting on timeout and ignores a later document projection", async () => {
    vi.useFakeTimers();
    const { store, root } = harness();
    await click(byRole(root, "button", "画笔"));
    await click(byRole(root, "button", "分享当前页并启用画笔"));
    await act(async () => {
      vi.advanceTimersByTime(10_001);
      await Promise.resolve();
    });
    expect(root.textContent).toContain("页面协作仍在准备");
    await ready(store);
    expect(store.commandCalls.map((command) => command.name)).toEqual([
      "CURRENT_TAB_SHARE",
      "PAGE_PERMISSION_REFRESH",
    ]);
  });

  it("does not send a continuation after the dock unmounts", async () => {
    const { store, root } = harness();
    let resolveShare: (result: UiCommandResult) => void = () => {};
    store.responder = async () =>
      new Promise((resolve) => {
        resolveShare = resolve;
      });
    await click(byRole(root, "button", "画笔"));
    await click(byRole(root, "button", "分享当前页并启用画笔"));
    unmountPanel();
    resolveShare(success({ kind: "INTENT_RECORDED", sharedPageContext: { tabId: 42, url } }));
    await flush();
    expect(store.commandCalls).toHaveLength(1);
  });

  it("reports an unconfirmed tool result truthfully without retrying an in-flight toggle", async () => {
    vi.useFakeTimers();
    const { store, root } = harness();
    const original = store.responder;
    let resolveTool: (result: UiCommandResult) => void = () => {};
    store.responder = (command) =>
      command.name === "PEN_TOGGLE"
        ? new Promise((resolve) => {
            resolveTool = resolve;
          })
        : original(command);
    await click(byRole(root, "button", "画笔"));
    await click(byRole(root, "button", "分享当前页并启用画笔"));
    await ready(store);
    expect(byRole(root, "button", "停止等待")).toBeDefined();
    await act(async () => {
      vi.advanceTimersByTime(10_001);
      await Promise.resolve();
    });
    expect(root.textContent).toContain("尚未确认操作结果");
    expect(root.textContent).not.toContain("操作已完成");
    resolveTool(success());
    await flush();
    expect(root.textContent).not.toContain("操作已完成");
    expect(store.commandCalls).toHaveLength(3);
  });

  it("keeps a rejected feature command truthful instead of showing success", async () => {
    const { store, root } = harness();
    const original = store.responder;
    store.responder = (command) =>
      command.name === "PEN_TOGGLE"
        ? Promise.resolve(failure("PAGE_TOOL_CONTEXT_CHANGED"))
        : original(command);
    await click(byRole(root, "button", "画笔"));
    await click(byRole(root, "button", "分享当前页并启用画笔"));
    await ready(store);
    expect(root.textContent).toContain("页面、房间或服务器已变化");
    expect(root.textContent).not.toContain("操作已完成");
  });

  it("retains the already-shared direct action and protected-page denial", async () => {
    const { store, root } = harness({
      documentRevision: revision,
      enabledFeatures: ["DANMAKU", "DRAWING"],
      reason: null,
    });
    await click(byRole(root, "button", "画笔"));
    expect(store.commandCalls).toEqual([{ name: "PEN_TOGGLE" }]);
    act(() =>
      store.update({
        pageAccess: {
          ...store.pageAccess.value,
          supported: false,
          enabledFeatures: [],
          documentRevision: null,
        },
      }),
    );
    await click(byRole(root, "button", "弹幕"));
    expect(root.textContent).toContain("浏览器保护页");
    expect(store.commandCalls).toHaveLength(1);
  });
});
