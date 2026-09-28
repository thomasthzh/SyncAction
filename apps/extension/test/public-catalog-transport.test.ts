import { describe, expect, it, vi } from "vitest";
import {
  PublicCatalogTransport,
  type PublicCatalogSocket,
} from "../src/public-catalog-transport.js";

const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789ab4";

class FakeSocket implements PublicCatalogSocket {
  public readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  public connected = false;
  public connectCalls = 0;
  public disconnectCalls = 0;
  public removeAllListenersCalls = 0;

  public on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  public once(event: string, handler: (...args: unknown[]) => void): this {
    const once = (...args: unknown[]): void => {
      this.off(event, once);
      handler(...args);
    };
    return this.on(event, once);
  }

  public off(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler),
    );
    return this;
  }

  public connect(): this {
    this.connectCalls += 1;
    this.connected = true;
    queueMicrotask(() => this.emitInbound("connect"));
    return this;
  }

  public disconnect(): this {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }

  public removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    this.handlers.clear();
    return this;
  }

  public emitInbound(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(...args);
    }
  }
}

describe("PublicCatalogTransport", () => {
  it("connects to only the anonymous public namespace with bounded jittered reconnect", async () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn(() => socket);
    const transport = new PublicCatalogTransport({
      baseUrl: "https://team.example",
      socketFactory,
    });

    await transport.start();

    expect(socketFactory).toHaveBeenCalledWith("https://team.example/public", {
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
      transports: ["websocket", "polling"],
      tryAllTransports: true,
      upgrade: true,
    });
    expect(JSON.stringify(socketFactory.mock.calls[0])).not.toContain("token");
    expect(socket.connectCalls).toBe(1);
  });

  it("forwards only strict public invalidations while active", async () => {
    const socket = new FakeSocket();
    const invalidated = vi.fn();
    const transport = new PublicCatalogTransport({
      baseUrl: "https://team.example",
      socketFactory: () => socket,
    });
    transport.setInvalidatedHandler(invalidated);
    await transport.start();

    const valid = {
      type: "public-rooms.invalidated",
      roomId,
      reason: "ROOM",
      roomRevision: 2,
    };
    socket.emitInbound("public-rooms.invalidated", valid);
    socket.emitInbound("public-rooms.invalidated", { ...valid, secret: "reject" });
    socket.emitInbound("public-rooms.invalidated", {
      ...valid,
      reason: "PRESENCE",
      roomRevision: 2,
    });

    expect(invalidated).toHaveBeenCalledOnce();
    expect(invalidated).toHaveBeenCalledWith(valid);

    await transport.stop();
    socket.emitInbound("public-rooms.invalidated", valid);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(socket.disconnectCalls).toBe(1);
    expect(socket.removeAllListenersCalls).toBe(1);
  });

  it("rejects duplicate starts and allows a clean restart after stop", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const transport = new PublicCatalogTransport({
      baseUrl: "https://team.example",
      socketFactory: () => sockets.shift()!,
    });

    await transport.start();
    await expect(transport.start()).rejects.toThrow("PUBLIC_CATALOG_ALREADY_STARTED");
    await transport.stop();
    await expect(transport.start()).resolves.toBeUndefined();
    await transport.stop();
  });
});
