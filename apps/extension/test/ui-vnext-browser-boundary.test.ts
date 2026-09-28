import { describe, expect, it, vi } from "vitest";
import { BrowserPagePermissionController } from "../src/ui-vnext/browser-boundary.js";

describe("vNext side-panel browser boundary", () => {
  it("refreshes the authoritative origin and requires another click after navigation", async () => {
    const request = vi.fn(async () => true);
    const refresh = vi.fn(async () => undefined);
    const granted = vi.fn(async () => undefined);
    const controller = new BrowserPagePermissionController({
      tabs: {
        query: vi.fn(async () => [{ url: "https://new.example/watch" }]),
      },
      permissions: { request },
      refresh,
      onGranted: granted,
    });

    await expect(
      controller.request({
        intentKey: "danmaku",
        cachedOriginPattern: "https://old.example/*",
      }),
    ).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(granted).not.toHaveBeenCalled();
  });

  it("requests only the current exact origin and resumes the original intent", async () => {
    const order: string[] = [];
    const request = vi.fn(async () => {
      order.push("permission");
      return true;
    });
    const refresh = vi.fn(async () => {
      order.push("refresh");
    });
    const onGranted = vi.fn(async () => {
      order.push("intent");
    });
    const controller = new BrowserPagePermissionController({
      tabs: {
        query: vi.fn(async () => [{ pendingUrl: "https://video.example/watch?v=1" }]),
      },
      permissions: { request },
      refresh,
      onGranted,
    });

    await expect(
      controller.request({
        intentKey: "pen",
        cachedOriginPattern: "https://video.example/*",
      }),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ["https://video.example/*"] });
    expect(onGranted).toHaveBeenCalledWith("pen");
    expect(order).toEqual(["permission", "refresh", "intent"]);
  });

  it("does not request host access for protected pages or resume denied actions", async () => {
    const request = vi.fn(async () => false);
    const refresh = vi.fn(async () => undefined);
    const onGranted = vi.fn(async () => undefined);
    const controller = new BrowserPagePermissionController({
      tabs: {
        query: vi
          .fn()
          .mockResolvedValueOnce([{ url: "chrome://extensions" }])
          .mockResolvedValueOnce([{ url: "https://video.example/watch" }]),
      },
      permissions: { request },
      refresh,
      onGranted,
    });

    await expect(
      controller.request({
        intentKey: "page-collaboration",
        cachedOriginPattern: null,
      }),
    ).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();

    await expect(
      controller.request({
        intentKey: "danmaku",
        cachedOriginPattern: "https://video.example/*",
      }),
    ).resolves.toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(onGranted).not.toHaveBeenCalled();
  });
});
