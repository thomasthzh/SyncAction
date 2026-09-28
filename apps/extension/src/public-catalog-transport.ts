import { PublicRoomsInvalidatedSchema, type PublicRoomsInvalidated } from "@syncaction/protocol";
import { io } from "socket.io-client";
import { parsePublicServerOrigin } from "./server-origin.js";

export interface PublicCatalogSocket {
  connected: boolean;
  on(event: string, handler: (...args: unknown[]) => void): this;
  once(event: string, handler: (...args: unknown[]) => void): this;
  off(event: string, handler: (...args: unknown[]) => void): this;
  connect(): this;
  disconnect(): this;
  removeAllListeners(): this;
}

export interface PublicCatalogSocketOptions {
  autoConnect: false;
  reconnection: true;
  reconnectionDelay: 500;
  reconnectionDelayMax: 30_000;
  randomizationFactor: 0.5;
  transports: ["websocket", "polling"];
  tryAllTransports: true;
  upgrade: true;
}

export type PublicCatalogSocketFactory = (
  namespaceUrl: string,
  options: PublicCatalogSocketOptions,
) => PublicCatalogSocket;

export interface PublicCatalogTransportOptions {
  baseUrl: unknown;
  socketFactory?: PublicCatalogSocketFactory;
}

export class PublicCatalogTransport {
  readonly #baseUrl: string;
  readonly #socketFactory: PublicCatalogSocketFactory;
  #socket: PublicCatalogSocket | undefined;
  #active = false;
  #invalidatedHandler: ((message: PublicRoomsInvalidated) => void) | undefined;

  public constructor(options: PublicCatalogTransportOptions) {
    this.#baseUrl = parsePublicServerOrigin(options.baseUrl);
    this.#socketFactory =
      options.socketFactory ??
      ((namespaceUrl, socketOptions) =>
        io(namespaceUrl, socketOptions) as unknown as PublicCatalogSocket);
  }

  public setInvalidatedHandler(
    handler: ((message: PublicRoomsInvalidated) => void) | undefined,
  ): void {
    this.#invalidatedHandler = handler;
  }

  public async start(): Promise<void> {
    if (this.#socket !== undefined) {
      throw new Error("PUBLIC_CATALOG_ALREADY_STARTED");
    }
    const socket = this.#socketFactory(`${this.#baseUrl}/public`, {
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
      transports: ["websocket", "polling"],
      tryAllTransports: true,
      upgrade: true,
    });
    this.#socket = socket;
    this.#active = true;
    socket.on("public-rooms.invalidated", (input: unknown) => {
      const parsed = PublicRoomsInvalidatedSchema.safeParse(input);
      if (this.#active && parsed.success) {
        this.#invalidatedHandler?.(parsed.data);
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", (cause: unknown) => reject(cause));
        socket.connect();
      });
    } catch (cause) {
      await this.stop();
      throw new Error("PUBLIC_CATALOG_CONNECT_FAILED", { cause });
    }
  }

  public async stop(): Promise<void> {
    const socket = this.#socket;
    this.#active = false;
    this.#socket = undefined;
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  }
}
