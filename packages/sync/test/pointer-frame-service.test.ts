import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type PointerFrame,
  type PointerLeaseUpdate,
  type PresenceRecord,
} from "@syncaction/protocol";
import {
  RoomPointerFrameService,
  RoomPointerService,
  type PointerAuthorizationPort,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c02");
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789c03";
const otherUserId = "018f8f8e-4b5c-7d6e-8f90-123456789c04";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c05");
const otherDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789c06");
const sessionId = "018f8f8e-4b5c-7d6e-8f90-123456789c07";
const leaseId = "018f8f8e-4b5c-7d6e-8f90-123456789c08";
const replacementLeaseId = "018f8f8e-4b5c-7d6e-8f90-123456789c09";
let nowMs = new Date("2026-07-27T00:00:00.000Z").getTime();

class FakeAuthorization implements PointerAuthorizationPort {
  public authorizePointer(input: {
    principal: {
      userId: string;
      deviceId: string;
      sessionId: string;
    };
  }): PresenceRecord {
    return {
      userId: input.principal.userId,
      username: input.principal.userId === otherUserId ? "other" : "owner",
      displayName: input.principal.userId === otherUserId ? "Other" : "Owner",
      deviceId: DeviceIdSchema.parse(input.principal.deviceId),
      logicalTabId,
      expiresAt: nowMs + 30_000,
    };
  }
}

function principal(
  identity: { userId: string; deviceId: string } = {
    userId,
    deviceId,
  },
) {
  return {
    ...identity,
    sessionId,
  };
}

function leaseUpdate(id = leaseId): PointerLeaseUpdate {
  return {
    type: "pointer.lease",
    protocolVersion: 1,
    roomId,
    deviceId,
    leaseId: id as PointerLeaseUpdate["leaseId"],
    logicalTabId,
    documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: id === leaseId ? 1 : 2 },
    anchor: null,
  };
}

function frame(seq: number, id = leaseId): PointerFrame {
  return {
    type: "pointer.frame",
    protocolVersion: 1,
    roomId,
    leaseId: id as PointerFrame["leaseId"],
    seq,
    xQuantized: Math.min(4_095, seq),
    yQuantized: Math.max(0, 4_095 - seq),
    viewport: { widthBucket: 8, heightBucket: 5 },
    sentAtClientMs: nowMs - 25,
  };
}

function createServices() {
  nowMs = new Date("2026-07-27T00:00:00.000Z").getTime();
  const pointers = new RoomPointerService({
    authorization: new FakeAuthorization(),
    now: () => new Date(nowMs),
  });
  const frames = new RoomPointerFrameService({
    leases: pointers,
    now: () => new Date(nowMs),
  });
  return { pointers, frames };
}

describe("RoomPointerFrameService", () => {
  it("drops frames without the exact active lease or authenticated socket", () => {
    const { pointers, frames } = createServices();
    expect(
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: frame(1),
      }),
    ).toBeNull();

    pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate(),
    });
    expect(
      frames.accept({
        principal: principal(),
        socketId: "socket-stale",
        frame: frame(1),
      }),
    ).toBeNull();
    expect(
      frames.accept({
        principal: principal({ userId: otherUserId, deviceId: otherDeviceId }),
        socketId: "socket-owner",
        frame: frame(1),
      }),
    ).toBeNull();
    expect(frames.latestSequence(leaseId)).toBeNull();
  });

  it("accepts only increasing frames and returns authenticated sender identity", () => {
    const { pointers, frames } = createServices();
    pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate(),
    });

    expect(
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: frame(1),
      }),
    ).toEqual({
      type: "pointer.frame",
      protocolVersion: 1,
      roomId,
      userId,
      deviceId,
      leaseId,
      seq: 1,
      xQuantized: 1,
      yQuantized: 4_094,
      viewport: { widthBucket: 8, heightBucket: 5 },
      receivedAtServerMs: nowMs,
    });
    expect(
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: frame(1),
      }),
    ).toBeNull();
    expect(
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: frame(200),
      }),
    ).toMatchObject({ leaseId, seq: 200 });
    expect(
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: frame(199),
      }),
    ).toBeNull();
    expect(frames.latestSequence(leaseId)).toBe(200);
  });

  it("resets accepted sequence when a new document lease replaces the old identity", () => {
    const { pointers, frames } = createServices();
    pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate(),
    });
    expect(
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: frame(200),
      }),
    ).toMatchObject({ seq: 200 });

    const replacement = pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate(replacementLeaseId),
    });
    expect(replacement.replaced).toMatchObject({ leaseId });
    frames.forget(leaseId);
    expect(
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: frame(1, replacementLeaseId),
      }),
    ).toMatchObject({ leaseId: replacementLeaseId, seq: 1 });
    expect(frames.latestSequence(leaseId)).toBeNull();
    expect(frames.latestSequence(replacementLeaseId)).toBe(1);
  });

  it("rejects malformed frames and invalid clocks without storing state", () => {
    const { pointers, frames } = createServices();
    pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate(),
    });
    expect(() =>
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: { ...frame(1), xQuantized: 4_096 },
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_SYNC_MESSAGE" }));
    expect(frames.latestSequence(leaseId)).toBeNull();

    nowMs = Number.NaN;
    expect(() =>
      frames.accept({
        principal: principal(),
        socketId: "socket-owner",
        frame: frame(1),
      }),
    ).toThrow(expect.objectContaining({ code: "RECOVERY_REQUIRED" }));
    expect(frames.latestSequence(leaseId)).toBeNull();
  });
});
