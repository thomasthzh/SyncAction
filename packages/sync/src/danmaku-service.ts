import {
  DanmakuAckSchema,
  DanmakuEventMessageSchema,
  DanmakuSendSchema,
  type DanmakuAck,
  type DanmakuEventMessage,
  type DanmakuSend,
} from "@syncaction/protocol";
import type { AuthorizedDocument, DocumentAuthorizationPort } from "./document-authorization.js";
import { DanmakuServiceError } from "./errors.js";
import type { PresencePrincipal } from "./presence-service.js";

const WINDOW_MS = 10_000;
const MAX_ACCEPTED_PER_WINDOW = 5;
const EVENT_LIFETIME_MS = 9_000;

export interface DanmakuServiceOptions {
  authorization: Pick<DocumentAuthorizationPort, "authorize">;
  now?: () => Date;
}

export interface DanmakuSendResult {
  ack: DanmakuAck;
  event: DanmakuEventMessage | null;
}

export class DanmakuService {
  readonly #authorization: Pick<DocumentAuthorizationPort, "authorize">;
  readonly #now: () => Date;
  readonly #acceptedAtByRoomUser = new Map<string, number[]>();

  public constructor(options: DanmakuServiceOptions) {
    this.#authorization = options.authorization;
    this.#now = options.now ?? (() => new Date());
  }

  public async send(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    message: unknown;
  }): Promise<DanmakuSendResult> {
    const parsed = DanmakuSendSchema.safeParse(input.message);
    if (!parsed.success) {
      throw new DanmakuServiceError("INVALID_DANMAKU_MESSAGE", {
        cause: parsed.error,
      });
    }
    const message = parsed.data;
    let authorized: AuthorizedDocument;
    try {
      authorized = await this.#authorization.authorize({
        principal: input.principal,
        socketId: input.socketId,
        roomId: message.roomId,
        logicalTabId: message.logicalTabId,
        documentRevision: message.documentRevision,
        frameKey: message.frameKey,
      });
    } catch {
      return rejected(message, "DOCUMENT_UNAUTHORIZED");
    }
    if (!authorizedMatches(message, authorized)) {
      return rejected(message, "DOCUMENT_UNAUTHORIZED");
    }

    const nowMs = timestampMs(this.#now());
    const key = `${message.roomId}:${authorized.member.userId}`;
    const prior = this.#acceptedAtByRoomUser.get(key) ?? [];
    if (prior.some((timestamp) => timestamp > nowMs)) {
      throw new DanmakuServiceError("INVALID_DANMAKU_MESSAGE");
    }
    const windowStart = nowMs - WINDOW_MS;
    const active = prior.filter((timestamp) => timestamp > windowStart);
    if (active.length >= MAX_ACCEPTED_PER_WINDOW) {
      this.#acceptedAtByRoomUser.set(key, active);
      return rejected(message, "DANMAKU_RATE_LIMITED");
    }
    active.push(nowMs);
    this.#acceptedAtByRoomUser.set(key, active);

    const expiresAtServerMs = nowMs + EVENT_LIFETIME_MS;
    return {
      ack: DanmakuAckSchema.parse({
        type: "danmaku.ack",
        protocolVersion: 1,
        messageId: message.messageId,
        roomId: message.roomId,
        accepted: true,
        code: null,
        sentAtServerMs: nowMs,
        expiresAtServerMs,
      }),
      event: DanmakuEventMessageSchema.parse({
        type: "danmaku.event",
        protocolVersion: 1,
        messageId: message.messageId,
        roomId: message.roomId,
        logicalTabId: message.logicalTabId,
        documentRevision: message.documentRevision,
        frameKey: message.frameKey,
        sender: {
          userId: authorized.member.userId,
          username: authorized.member.username,
          displayName: authorized.member.displayName,
          deviceId: authorized.member.deviceId,
        },
        text: message.text,
        sentAtServerMs: nowMs,
        expiresAtServerMs,
      }),
    };
  }
}

function rejected(
  message: DanmakuSend,
  code: "DOCUMENT_UNAUTHORIZED" | "DANMAKU_RATE_LIMITED",
): DanmakuSendResult {
  return {
    ack: DanmakuAckSchema.parse({
      type: "danmaku.ack",
      protocolVersion: 1,
      messageId: message.messageId,
      roomId: message.roomId,
      accepted: false,
      code,
      sentAtServerMs: null,
      expiresAtServerMs: null,
    }),
    event: null,
  };
}

function authorizedMatches(message: DanmakuSend, authorized: AuthorizedDocument): boolean {
  return (
    authorized.roomId === message.roomId &&
    authorized.logicalTabId === message.logicalTabId &&
    authorized.documentRevision.roomEpoch === message.documentRevision.roomEpoch &&
    authorized.documentRevision.tabUpdatedAtSeq === message.documentRevision.tabUpdatedAtSeq &&
    authorized.frameKey === message.frameKey
  );
}

function timestampMs(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new DanmakuServiceError("INVALID_DANMAKU_MESSAGE");
  }
  return milliseconds;
}
