import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  StrokePreviewClearSchema,
  StrokePreviewUpdateSchema,
  type PresenceRecord,
} from "@syncaction/protocol";
import {
  MediaServiceError,
  StrokePreviewService,
  type AuthorizedDocument,
  type PresencePrincipal,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a02");
const userId = "018f8f8e-4b5c-7d6e-8f90-723456789a03";
const secondUserId = "018f8f8e-4b5c-7d6e-8f90-723456789a04";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a05");
const secondDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-723456789a06");
const stableFrameKey = "frame:sha256-0123456789abcdef0123456789abcdef";
const revision = { roomEpoch: 0, tabUpdatedAtSeq: 5 } as const;
const firstPreviewId = "018f8f8e-4b5c-7d6e-8f90-723456789a07";
const secondPreviewId = "018f8f8e-4b5c-7d6e-8f90-723456789a08";
let nowMs = new Date("2026-07-28T00:00:00.000Z").getTime();

function principal(second = false): PresencePrincipal {
  return {
    userId: second ? secondUserId : userId,
    deviceId: second ? secondDeviceId : deviceId,
    sessionId: second
      ? "018f8f8e-4b5c-7d6e-8f90-723456789a0a"
      : "018f8f8e-4b5c-7d6e-8f90-723456789a09",
  };
}

class FakeExactAuthorization {
  public async authorize(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
    documentRevision: unknown;
    frameKey?: unknown;
  }): Promise<AuthorizedDocument> {
    const second = input.principal.userId === secondUserId;
    const socketMatches = second
      ? input.socketId === "socket-second"
      : input.socketId === "socket-owner" || input.socketId === "socket-new";
    if (
      !socketMatches ||
      input.roomId !== roomId ||
      input.logicalTabId !== logicalTabId ||
      JSON.stringify(input.documentRevision) !== JSON.stringify(revision) ||
      input.frameKey !== stableFrameKey
    ) {
      throw new MediaServiceError("DOCUMENT_UNAUTHORIZED");
    }
    const member: PresenceRecord = {
      userId: second ? secondUserId : userId,
      username: second ? "second" : "owner",
      displayName: second ? "Second" : "Owner",
      deviceId: second ? secondDeviceId : deviceId,
      logicalTabId,
      expiresAt: nowMs + 30_000,
    };
    return {
      roomId,
      logicalTabId,
      documentRevision: revision,
      canonicalPageIdentity: "url:https://example.com/draw",
      role: "MEMBER",
      frameKey: stableFrameKey,
      member,
    };
  }
}

function update(previewId = firstPreviewId, points = [{ x: 0.1, y: 0.2, pressure: 0.5 }]) {
  return StrokePreviewUpdateSchema.parse({
    type: "stroke.preview.update",
    protocolVersion: 1,
    previewId,
    roomId,
    logicalTabId,
    documentRevision: revision,
    frameKey: stableFrameKey,
    anchor: {
      type: "document",
      layoutSignature: { widthCssPx: 1440, heightCssPx: 5000 },
    },
    points,
    rgb: { r: 31, g: 140, b: 255 },
    width: 5,
  });
}

function clear(previewId = firstPreviewId) {
  return StrokePreviewClearSchema.parse({
    type: "stroke.preview.clear",
    protocolVersion: 1,
    previewId,
    roomId,
    logicalTabId,
    documentRevision: revision,
    frameKey: stableFrameKey,
  });
}

function createPreviews(maxRoomEntries = 256): StrokePreviewService {
  nowMs = new Date("2026-07-28T00:00:00.000Z").getTime();
  return new StrokePreviewService({
    authorization: new FakeExactAuthorization(),
    now: () => new Date(nowMs),
    maxRoomEntries,
  });
}

describe("StrokePreviewService", () => {
  it("emits server identity, replaces the latest preview, and accepts at 20 Hz", async () => {
    const previews = createPreviews();
    const first = await previews.update({
      principal: principal(),
      socketId: "socket-owner",
      update: update(),
    });
    expect(first).toMatchObject({
      accepted: true,
      event: {
        previewId: firstPreviewId,
        sender: {
          userId,
          username: "owner",
          displayName: "Owner",
          deviceId,
        },
        expiresAtServerMs: nowMs + 3_000,
      },
    });

    nowMs += 49;
    await expect(
      previews.update({
        principal: principal(),
        socketId: "socket-owner",
        update: update(firstPreviewId, [{ x: 0.8, y: 0.8, pressure: 0.5 }]),
      }),
    ).resolves.toEqual({ accepted: false, event: null });
    nowMs += 1;
    const replacement = await previews.update({
      principal: principal(),
      socketId: "socket-owner",
      update: update(firstPreviewId, [{ x: 0.9, y: 0.9, pressure: 0.5 }]),
    });
    expect(replacement).toMatchObject({
      accepted: true,
      event: {
        points: [{ x: 0.9, y: 0.9, pressure: 0.5 }],
        expiresAtServerMs: nowMs + 3_000,
      },
    });
    expect(JSON.stringify(replacement)).not.toMatch(/https?:|pageTitle|authorUserId/iu);
  });

  it("bounds a room while allowing an existing preview key to refresh", async () => {
    const previews = createPreviews(1);
    await previews.update({
      principal: principal(),
      socketId: "socket-owner",
      update: update(),
    });
    nowMs += 50;
    await expect(
      previews.update({
        principal: principal(),
        socketId: "socket-owner",
        update: update(),
      }),
    ).resolves.toMatchObject({ accepted: true });
    nowMs += 50;
    await expect(
      previews.update({
        principal: principal(),
        socketId: "socket-owner",
        update: update(secondPreviewId),
      }),
    ).rejects.toMatchObject({ code: "OPERATION_RATE_LIMITED" });
  });

  it("clears explicitly and ignores a stale socket after replacement", async () => {
    const previews = createPreviews();
    await previews.update({
      principal: principal(),
      socketId: "socket-owner",
      update: update(),
    });
    await expect(
      previews.clear({
        principal: principal(),
        socketId: "socket-owner",
        clear: clear(),
      }),
    ).resolves.toMatchObject({
      type: "stroke.preview.clear",
      previewId: firstPreviewId,
      sender: { userId, deviceId },
    });
    await expect(
      previews.clear({
        principal: principal(),
        socketId: "socket-owner",
        clear: clear(),
      }),
    ).resolves.toBeNull();

    nowMs += 50;
    await previews.update({
      principal: principal(),
      socketId: "socket-new",
      update: update(firstPreviewId, [{ x: 0.4, y: 0.4, pressure: 0.5 }]),
    });
    expect(previews.removeSocket("socket-stale")).toEqual([]);
    expect(previews.removeSocket("socket-owner")).toEqual([]);
    expect(previews.removeSocket("socket-new")).toHaveLength(1);
  });

  it("expires at three seconds and emits deterministic sweep clears", async () => {
    const previews = createPreviews();
    await previews.update({
      principal: principal(),
      socketId: "socket-owner",
      update: update(),
    });
    nowMs += 2_999;
    expect(previews.sweep()).toEqual([]);
    nowMs += 1;
    expect(previews.sweep()).toEqual([
      expect.objectContaining({
        previewId: firstPreviewId,
        sender: { userId, deviceId },
      }),
    ]);
  });

  it("requires exact document authorization and exposes no replay surface", async () => {
    const previews = createPreviews();
    for (const mismatch of [
      { socketId: "socket-stale" },
      {
        update: {
          ...update(),
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 4 },
        },
      },
      {
        update: {
          ...update(),
          frameKey: "frame:sha256-ffffffffffffffffffffffffffffffff",
        },
      },
    ]) {
      await expect(
        previews.update({
          principal: principal(),
          socketId: "socket-owner",
          update: update(),
          ...mismatch,
        }),
      ).rejects.toMatchObject({ code: "DOCUMENT_UNAUTHORIZED" });
    }
    expect("snapshot" in previews).toBe(false);
    expect("replay" in previews).toBe(false);
  });
});
