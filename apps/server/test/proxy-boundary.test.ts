import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { TRUSTED_PROXY_CIDRS } from "../src/app.js";
import { publicConnectionAddress } from "../src/sync-socket.js";

describe("proxy address boundary", () => {
  it("ignores forged forwarding and vendor headers from a direct public peer", () => {
    expect(
      publicConnectionAddress({
        address: "198.51.100.24",
        headers: {
          "x-forwarded-for": "203.0.113.10",
          "cf-connecting-ip": "203.0.113.11",
        },
      }),
    ).toBe("198.51.100.24");
  });

  it("uses the rightmost valid forwarded address only from a loopback peer", () => {
    expect(
      publicConnectionAddress({
        address: "::ffff:127.0.0.1",
        headers: { "x-forwarded-for": "192.0.2.10, 198.51.100.24" },
      }),
    ).toBe("198.51.100.24");
    expect(
      publicConnectionAddress({
        address: "::1",
        headers: { "x-forwarded-for": "198.51.100.25" },
      }),
    ).toBe("198.51.100.25");
  });

  it("falls back to the peer when a forwarded address is invalid", () => {
    expect(
      publicConnectionAddress({
        address: "127.0.0.1",
        headers: {
          "x-forwarded-for": "192.0.2.10, not-an-ip",
          "cf-connecting-ip": "203.0.113.11",
        },
      }),
    ).toBe("127.0.0.1");
  });

  it("limits Fastify proxy trust to loopback peers", async () => {
    const app = Fastify({ trustProxy: TRUSTED_PROXY_CIDRS });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    try {
      const direct = await app.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "198.51.100.24",
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      expect(direct.json()).toEqual({ ip: "198.51.100.24" });

      const proxied = await app.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.25" },
      });
      expect(proxied.json()).toEqual({ ip: "198.51.100.25" });
    } finally {
      await app.close();
    }
  });
});
