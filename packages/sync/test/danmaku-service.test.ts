import {
  DanmakuSendSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type PresenceRecord,
} from "@syncaction/protocol";
import {
  DanmakuService,
  MediaServiceError,
  type AuthorizedDocument,
  type PresencePrincipal,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-623456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-623456789a02");
const userId = "018f8f8e-4b5c-7d6e-8f90-623456789a03";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-623456789a04");
const stableFrameKey = "frame:sha256-0123456789abcdef0123456789abcdef";
const revision = { roomEpoch: 0, tabUpdatedAtSeq: 4 } as const;
let nowMs = new Date("2026-07-28T00:00:00.000Z").getTime();

const principal: PresencePrincipal = {
  userId,
  deviceId,
  sessionId: "018f8f8e-4b5c-7d6e-8f90-623456789a05",
};

const member: PresenceRecord = {
  userId,
  username: "member",
  displayName: "Member",
  deviceId,
  logicalTabId,
  expiresAt: nowMs + 30_000,
};

class FakeExactAuthorization {
  public async authorize(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    frameKey?: unknown;
  }): Promise<AuthorizedDocument> {
    if (
      input.principal.userId !== userId ||
      input.socketId !== "socket-member" ||
      input.roomId !== roomId ||
      input.logicalTabId !== logicalTabId ||
      JSON.stringify(input.documentRevision) !== JSON.stringify(revision) ||
      input.frameKey !== stableFrameKey
    ) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }
    return {
      roomId,
      logicalTabId,
      documentRevision: revision,
      canonicalPageIdentity: "url:https://example.com/watch",
      role: "MEMBER",
      frameKey: stableFrameKey,
      member: { ...member, expiresAt: nowMs + 30_000 },
    };
  }
}

function message(text = "一起看") {
  return DanmakuSendSchema.parse({
    type: "danmaku.send",
    protocolVersion: 1,
    messageId: crypto.randomUUID(),
    roomId,
    logicalTabId,
    documentRevision: revision,
    frameKey: stableFrameKey,
    text,
  });
}

function createDanmaku(): DanmakuService {
  nowMs = new Date("2026-07-28T00:00:00.000Z").getTime();
  return new DanmakuService({
    authorization: new FakeExactAuthorization(),
    now: () => new Date(nowMs),
  });
}

describe("DanmakuService", () => {
  it("derives sender/time, ACKs, and expires an accepted event at exactly nine seconds", async () => {
    const service = createDanmaku();
    const outbound = message();

    await expect(
      service.send({
        principal,
        socketId: "socket-member",
        message: outbound,
      }),
    ).resolves.toEqual({
      ack: {
        type: "danmaku.ack",
        protocolVersion: 1,
        messageId: outbound.messageId,
        roomId,
        accepted: true,
        code: null,
        sentAtServerMs: nowMs,
        expiresAtServerMs: nowMs + 9_000,
      },
      event: {
        type: "danmaku.event",
        protocolVersion: 1,
        messageId: outbound.messageId,
        roomId,
        logicalTabId,
        documentRevision: revision,
        frameKey: stableFrameKey,
        sender: {
          userId,
          username: "member",
          displayName: "Member",
          deviceId,
        },
        text: "一起看",
        sentAtServerMs: nowMs,
        expiresAtServerMs: nowMs + 9_000,
      },
    });
  });

  it("accepts 120 Unicode code points and rejects malformed input before authorization", async () => {
    const service = createDanmaku();
    const unicodeText = "😀".repeat(120);
    await expect(
      service.send({
        principal,
        socketId: "socket-member",
        message: message(unicodeText),
      }),
    ).resolves.toMatchObject({ event: { text: unicodeText } });

    await expect(
      service.send({
        principal,
        socketId: "socket-member",
        message: { ...message(), text: "😀".repeat(121) },
      }),
    ).rejects.toMatchObject({ code: "INVALID_DANMAKU_MESSAGE" });
  });

  it("accepts five messages per user in ten seconds and lets old timestamps fall out", async () => {
    const service = createDanmaku();
    for (let index = 0; index < 5; index += 1) {
      await expect(
        service.send({
          principal,
          socketId: "socket-member",
          message: message(`message-${index}`),
        }),
      ).resolves.toMatchObject({ ack: { accepted: true } });
    }
    await expect(
      service.send({
        principal,
        socketId: "socket-member",
        message: message("sixth"),
      }),
    ).resolves.toMatchObject({
      ack: {
        accepted: false,
        code: "DANMAKU_RATE_LIMITED",
        sentAtServerMs: null,
        expiresAtServerMs: null,
      },
      event: null,
    });

    nowMs += 10_000;
    await expect(
      service.send({
        principal,
        socketId: "socket-member",
        message: message("after-window"),
      }),
    ).resolves.toMatchObject({ ack: { accepted: true } });
  });

  it("rejects stale socket, wrong revision, and wrong frame without retaining content", async () => {
    const service = createDanmaku();
    for (const mismatch of [
      { socketId: "socket-stale" },
      {
        message: {
          ...message(),
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 3 },
        },
      },
      {
        message: {
          ...message(),
          frameKey: "frame:sha256-ffffffffffffffffffffffffffffffff",
        },
      },
    ]) {
      await expect(
        service.send({
          principal,
          socketId: "socket-member",
          message: message(),
          ...mismatch,
        }),
      ).resolves.toMatchObject({
        ack: { accepted: false, code: "DOCUMENT_UNAUTHORIZED" },
        event: null,
      });
    }
    expect("snapshot" in service).toBe(false);
    expect("replay" in service).toBe(false);
    expect(JSON.stringify(service)).not.toMatch(/一起看|message-/u);
  });
});
