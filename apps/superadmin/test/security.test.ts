import type { createDatabase } from "@syncaction/database";
import type { AdminService } from "@syncaction/identity";
import type { RoomService } from "@syncaction/rooms";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAdminApp } from "../src/app.js";
import type { AdminCookieConfig } from "../src/config.js";

const publicOrigin = "https://admin.syncaction.example.com";
const cookie: AdminCookieConfig = {
  name: "syncaction_admin_session",
  httpOnly: true,
  sameSite: "strict",
  path: "/",
  maxAgeSeconds: 28_800,
  secure: true,
};
const db = {} as ReturnType<typeof createDatabase>;
const administrators = {} as AdminService;
const rooms = {} as RoomService;
let app: FastifyInstance;

beforeEach(async () => {
  app = await buildAdminApp({
    db,
    administrators,
    rooms,
    cookie,
    publicOrigin,
    logger: false,
    readinessCheck: async () => undefined,
  });
});

afterEach(async () => {
  await app.close();
});

describe("administrator browser request boundary", () => {
  it("rejects a mutation without an Origin before route validation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ADMIN_ORIGIN_REQUIRED" });
  });

  it("rejects the public sibling origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: {
        origin: "https://syncaction.example.com",
        "content-type": "application/json",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ADMIN_ORIGIN_REQUIRED" });
  });

  it("rejects a same-origin mutation that is not JSON", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: { origin: publicOrigin },
      payload: "{}",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ code: "ADMIN_JSON_REQUIRED" });
  });

  it("allows an exact-origin JSON mutation to reach route validation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: {
        origin: publicOrigin,
        "content-type": "application/json; charset=utf-8",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("preserves a trusted Fastify malformed-JSON client error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      headers: {
        origin: publicOrigin,
        "content-type": "application/json",
      },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "FST_ERR_CTP_INVALID_JSON_BODY",
      message: "FST_ERR_CTP_INVALID_JSON_BODY",
    });
  });

  it("does not trust a route error that merely claims a client status and Fastify code", async () => {
    app.get("/test/untrusted-status", async () => {
      throw Object.assign(new Error("spoofed"), {
        code: "FST_ERR_CTP_INVALID_JSON_BODY",
        statusCode: 429,
      });
    });

    const response = await app.inject({ method: "GET", url: "/test/untrusted-status" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("retains the configured authentication rate-limit response", async () => {
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/v1/admin/auth/login",
          headers: {
            origin: publicOrigin,
            "content-type": "application/json",
          },
          payload: {},
        }),
      );
    }

    expect(responses.slice(0, 5).every((response) => response.statusCode === 400)).toBe(true);
    expect(responses[5]?.statusCode).toBe(429);
    expect(responses[5]?.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("keeps health requests safe and emits fixed browser policies", async () => {
    const health = await app.inject({ method: "GET", url: "/healthz" });

    expect(health.statusCode).toBe(200);
    expect(health.headers).toMatchObject({
      "content-security-policy":
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });

    const adminApi = await app.inject({ method: "GET", url: "/v1/admin/me" });
    expect(adminApi.headers["cache-control"]).toBe("no-store");
  });
});
