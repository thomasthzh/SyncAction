import type { ServerMeta } from "@syncaction/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  CustomServerVerifier,
  type ServerHostPermissionApi,
} from "../src/server-host-permission.js";

function metadata(): ServerMeta {
  return {
    serverId: "018f8f8e-4b5c-7d6e-8f90-123456789d01",
    displayName: "Team server",
    softwareVersion: "0.9.3",
    protocolVersion: "1",
    minimumClientVersion: "0.8.1",
    termsVersion: "2026-07-30",
    capabilities: ["public-rooms", "join-requests", "notifications"],
    limits: {
      ordinaryActiveRooms: 5,
      ordinaryOpenTabs: 20,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function permissionApi(request: ServerHostPermissionApi["request"]): ServerHostPermissionApi {
  return { request };
}

function healthyFetch(): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      return jsonResponse({ status: "ok" });
    }
    if (url.endsWith("/v1/meta")) {
      return jsonResponse(metadata());
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

describe("CustomServerVerifier", () => {
  it("samples health latency without requesting permission or metadata", async () => {
    const request = vi.fn<ServerHostPermissionApi["request"]>();
    const fetch = healthyFetch();
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(142);
    const verifier = new CustomServerVerifier({
      permissions: permissionApi(request),
      fetch,
      now,
    });

    await expect(verifier.probe("https://team.example:8443")).resolves.toEqual({
      latencyMs: 42,
    });
    expect(request).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://team.example:8443/healthz",
    ]);
  });

  it("starts the exact optional-host request synchronously from the click", async () => {
    let resolvePermission: (granted: boolean) => void = () => undefined;
    const request = vi.fn<ServerHostPermissionApi["request"]>(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const fetch = healthyFetch();
    const verifier = new CustomServerVerifier({
      permissions: permissionApi(request),
      fetch,
      now: () => 1_785_312_000_000,
    });

    const pending = verifier.verifyFromClick("https://team.example:8443");
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      origins: ["https://team.example:8443/*"],
    });
    expect(fetch).not.toHaveBeenCalled();

    resolvePermission(true);
    await expect(pending).resolves.toEqual({
      baseUrl: "https://team.example:8443",
      mode: "VNEXT",
      metadata: metadata(),
      healthyAt: 1_785_312_000_000,
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://team.example:8443/healthz",
      "https://team.example:8443/v1/meta",
    ]);
  });

  it("makes no network request after permission denial", async () => {
    const request = vi.fn<ServerHostPermissionApi["request"]>().mockResolvedValue(false);
    const fetch = healthyFetch();
    const verifier = new CustomServerVerifier({
      permissions: permissionApi(request),
      fetch,
    });

    await expect(verifier.verifyFromClick("https://denied.example")).rejects.toThrow(
      "SERVER_HOST_PERMISSION_DENIED",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a warning-only legacy preview for an exact metadata 404", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("/healthz")
        ? jsonResponse({ status: "ok" })
        : jsonResponse(
            {
              statusCode: 404,
              error: "Not Found",
              message: "Route GET:/v1/meta not found",
            },
            404,
          ),
    );
    const verifier = new CustomServerVerifier({
      permissions: permissionApi(
        vi.fn<ServerHostPermissionApi["request"]>().mockResolvedValue(true),
      ),
      fetch,
      now: () => 1_785_312_000_000,
    });

    await expect(verifier.verifyFromClick("https://legacy.example")).resolves.toEqual({
      baseUrl: "https://legacy.example",
      mode: "LEGACY_V081",
      metadata: null,
      healthyAt: 1_785_312_000_000,
    });
  });

  it.each([
    {
      name: "invalid health",
      response: (url: string) =>
        url.endsWith("/healthz") ? jsonResponse({ status: "degraded" }) : jsonResponse(metadata()),
    },
    {
      name: "health 5xx",
      response: (url: string) =>
        url.endsWith("/healthz")
          ? jsonResponse({ code: "DOWN", message: "DOWN", requestId: "req-1" }, 503)
          : jsonResponse(metadata()),
    },
    {
      name: "malformed metadata",
      response: (url: string) =>
        url.endsWith("/healthz")
          ? jsonResponse({ status: "ok" })
          : jsonResponse({ ...metadata(), unexpected: true }),
    },
  ])("rejects $name without producing a candidate", async ({ response }) => {
    const verifier = new CustomServerVerifier({
      permissions: permissionApi(
        vi.fn<ServerHostPermissionApi["request"]>().mockResolvedValue(true),
      ),
      fetch: vi.fn<typeof globalThis.fetch>(async (input) => response(String(input))),
    });

    await expect(verifier.verifyFromClick("https://invalid.example")).rejects.toBeInstanceOf(Error);
  });

  it("rejects timeout-like failures and cross-origin redirects", async () => {
    const timeoutVerifier = new CustomServerVerifier({
      permissions: permissionApi(
        vi.fn<ServerHostPermissionApi["request"]>().mockResolvedValue(true),
      ),
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new DOMException("timeout", "AbortError")),
    });
    await expect(timeoutVerifier.verifyFromClick("https://timeout.example")).rejects.toThrow();

    const redirected = jsonResponse({ status: "ok" });
    Object.defineProperties(redirected, {
      redirected: { value: true },
      url: { value: "https://attacker.example/healthz" },
    });
    const redirectVerifier = new CustomServerVerifier({
      permissions: permissionApi(
        vi.fn<ServerHostPermissionApi["request"]>().mockResolvedValue(true),
      ),
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(redirected),
    });
    await expect(
      redirectVerifier.verifyFromClick("https://redirect.example"),
    ).rejects.toMatchObject({ code: "CROSS_ORIGIN_REDIRECT" });
  });

  it("uses the manifest-granted production origin without a second prompt", async () => {
    const request = vi.fn<ServerHostPermissionApi["request"]>();
    const verifier = new CustomServerVerifier({
      permissions: permissionApi(request),
      fetch: healthyFetch(),
      now: () => 1_785_312_000_000,
    });

    await expect(verifier.verifyFromClick("https://syncaction.example.com")).resolves.toMatchObject(
      { mode: "VNEXT" },
    );
    expect(request).not.toHaveBeenCalled();
  });
});
