import Fastify from "fastify";
import { expect, it } from "vitest";
import { TRUSTED_PROXY_CIDRS } from "../src/app.js";

it("accepts forwarded client addresses only from loopback admin proxies", async () => {
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
