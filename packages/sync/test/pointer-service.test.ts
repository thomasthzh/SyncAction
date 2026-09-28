import {
  DeviceIdSchema,
  LogicalTabIdSchema,
  RoomIdSchema,
  type PointerLeaseUpdate,
  type PointerUpdate,
  type PresenceRecord,
} from "@syncaction/protocol";
import { RoomPointerService, type PointerAuthorizationPort } from "../src/index.js";
import { describe, expect, it } from "vitest";

const roomId = RoomIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b01");
const logicalTabId = LogicalTabIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b02");
const userId = "018f8f8e-4b5c-7d6e-8f90-123456789b03";
const secondUserId = "018f8f8e-4b5c-7d6e-8f90-123456789b04";
const deviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b05");
const secondDeviceId = DeviceIdSchema.parse("018f8f8e-4b5c-7d6e-8f90-123456789b06");
const sessionId = "018f8f8e-4b5c-7d6e-8f90-123456789b07";
const leaseId = "018f8f8e-4b5c-7d6e-8f90-123456789b08";
const replacementLeaseId = "018f8f8e-4b5c-7d6e-8f90-123456789b09";
let nowMs = new Date("2026-07-27T00:00:00.000Z").getTime();

const update: PointerUpdate = {
  type: "pointer.update",
  protocolVersion: 1,
  roomId,
  logicalTabId,
  documentRevision: {
    roomEpoch: 0,
    tabUpdatedAtSeq: 1,
  },
  anchor: {
    path: [
      { tagName: "html", nthOfType: 1 },
      { tagName: "body", nthOfType: 1 },
      { tagName: "button", nthOfType: 2 },
    ],
    x: 0.25,
    y: 0.75,
  },
  viewport: { x: 0.4, y: 0.6 },
};

const leaseUpdate: PointerLeaseUpdate = {
  type: "pointer.lease",
  protocolVersion: 1,
  roomId,
  deviceId,
  leaseId,
  logicalTabId,
  documentRevision: update.documentRevision,
  anchor: update.anchor,
};

class FakeAuthorization implements PointerAuthorizationPort {
  public authorizePointer(input: {
    principal: {
      userId: string;
      deviceId: string;
      sessionId: string;
    };
    socketId: unknown;
    roomId: unknown;
    logicalTabId: unknown;
  }): PresenceRecord {
    const second = input.principal.userId === secondUserId;
    return {
      userId: input.principal.userId,
      username: second ? "second" : "owner",
      displayName: second ? "Second" : "Owner",
      deviceId: DeviceIdSchema.parse(input.principal.deviceId),
      logicalTabId,
      expiresAt: nowMs + 30_000,
    };
  }
}

function principal(
  identity: {
    userId: string;
    deviceId: string;
  } = { userId, deviceId },
) {
  return {
    ...identity,
    sessionId,
  };
}

function createPointers(
  options: {
    minimumIntervalMs?: number;
    maxRoomEntries?: number;
  } = {},
): RoomPointerService {
  nowMs = new Date("2026-07-27T00:00:00.000Z").getTime();
  return new RoomPointerService({
    authorization: new FakeAuthorization(),
    now: () => new Date(nowMs),
    ...options,
  });
}

describe("RoomPointerService", () => {
  it("creates and renews one reliable three-second lease", () => {
    const pointers = createPointers();

    const created = pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate,
    });
    expect(created).toMatchObject({
      ack: {
        type: "pointer.lease.ack",
        roomId,
        leaseId,
        accepted: true,
        expiresAt: nowMs + 3_000,
      },
      event: {
        type: "pointer.lease.event",
        roomId,
        lease: {
          userId,
          deviceId,
          leaseId,
          logicalTabId,
          documentRevision: leaseUpdate.documentRevision,
          anchor: leaseUpdate.anchor,
          expiresAt: nowMs + 3_000,
        },
      },
      replaced: null,
      legacyClear: null,
    });

    nowMs += 2_000;
    const renewed = pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: {
        ...leaseUpdate,
        anchor: null,
      },
    });
    expect(renewed).toMatchObject({
      ack: {
        leaseId,
        expiresAt: nowMs + 3_000,
      },
      event: {
        lease: {
          leaseId,
          anchor: null,
          expiresAt: nowMs + 3_000,
        },
      },
      replaced: null,
    });
    expect(pointers.leaseSnapshot(roomId)).toMatchObject({
      type: "pointer.lease.snapshot",
      roomId,
      leases: [
        expect.objectContaining({
          userId,
          deviceId,
          leaseId,
          expiresAt: nowMs + 3_000,
        }),
      ],
    });
  });

  it("requires a new lease identity for a new document context", () => {
    const pointers = createPointers();
    pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate,
    });

    expect(() =>
      pointers.lease({
        principal: principal(),
        socketId: "socket-owner",
        update: {
          ...leaseUpdate,
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 2 },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_SYNC_MESSAGE" }));

    const replaced = pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: {
        ...leaseUpdate,
        leaseId: replacementLeaseId,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 2 },
      },
    });
    expect(replaced).toMatchObject({
      event: {
        lease: {
          leaseId: replacementLeaseId,
          documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 2 },
        },
      },
      replaced: {
        type: "pointer.lease.clear",
        roomId,
        userId,
        deviceId,
        leaseId,
      },
    });
    expect(pointers.leaseSnapshot(roomId).leases).toEqual([
      expect.objectContaining({ leaseId: replacementLeaseId }),
    ]);
  });

  it("rejects a lease that claims another authenticated device", () => {
    const pointers = createPointers();
    expect(() =>
      pointers.lease({
        principal: principal(),
        socketId: "socket-owner",
        update: {
          ...leaseUpdate,
          deviceId: secondDeviceId,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "SYNC_AUTH_REQUIRED" }));
  });

  it("clears reliable leases once on disconnect and exact expiry", () => {
    const pointers = createPointers();
    pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate,
    });
    expect(pointers.removeSocketLeases("socket-owner")).toEqual([
      {
        type: "pointer.lease.clear",
        protocolVersion: 1,
        roomId,
        userId,
        deviceId,
        leaseId,
      },
    ]);
    expect(pointers.removeSocketLeases("socket-owner")).toEqual([]);

    pointers.lease({
      principal: principal(),
      socketId: "socket-owner",
      update: leaseUpdate,
    });
    nowMs += 2_999;
    expect(pointers.sweepLeases()).toEqual([]);
    nowMs += 1;
    expect(pointers.sweepLeases()).toEqual([
      {
        type: "pointer.lease.clear",
        protocolVersion: 1,
        roomId,
        userId,
        deviceId,
        leaseId,
      },
    ]);
  });

  it("adapts legacy updates to one stable internal lease and synthetic frame", () => {
    const pointers = createPointers({ minimumIntervalMs: 1 });
    const first = pointers.update({
      principal: principal(),
      socketId: "socket-owner",
      update,
    });
    expect(first).toMatchObject({
      event: {
        pointer: {
          userId,
          deviceId,
          viewport: update.viewport,
        },
      },
      leaseEvent: {
        lease: {
          userId,
          deviceId,
          logicalTabId,
        },
      },
      frame: {
        seq: 1,
        xQuantized: 1_638,
        yQuantized: 2_457,
      },
    });
    expect(first.event?.pointer).not.toHaveProperty("leaseId");
    expect(first.event?.pointer).not.toHaveProperty("seq");
    const internalLeaseId = first.leaseEvent?.lease.leaseId;

    nowMs += 1;
    const renewal = pointers.update({
      principal: principal(),
      socketId: "socket-owner",
      update: {
        ...update,
        viewport: { x: 0.5, y: 0.5 },
      },
    });
    expect(renewal).toMatchObject({
      leaseEvent: { lease: { leaseId: internalLeaseId } },
      frame: { leaseId: internalLeaseId, seq: 2 },
      replacedLease: null,
    });

    nowMs += 1;
    const changedDocument = pointers.update({
      principal: principal(),
      socketId: "socket-owner",
      update: {
        ...update,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 2 },
      },
    });
    expect(changedDocument.leaseEvent?.lease.leaseId).not.toBe(internalLeaseId);
    expect(changedDocument).toMatchObject({
      replacedLease: { leaseId: internalLeaseId },
      frame: { seq: 1 },
    });
  });

  it("derives identity/color/expiry and drops over-rate updates without replacing state", () => {
    const pointers = createPointers();

    const first = pointers.update({
      principal: principal(),
      socketId: "socket-owner",
      update,
    });
    expect(first).toMatchObject({
      ack: {
        roomId,
        accepted: true,
        expiresAt: nowMs + 3_000,
      },
      event: {
        roomId,
        pointer: {
          userId,
          username: "owner",
          displayName: "Owner",
          deviceId,
          color: expect.stringMatching(/^#[0-9a-f]{6}$/u),
          logicalTabId,
          documentRevision: update.documentRevision,
          anchor: update.anchor,
          viewport: update.viewport,
          expiresAt: nowMs + 3_000,
        },
      },
    });

    nowMs += 40;
    expect(
      pointers.update({
        principal: principal(),
        socketId: "socket-owner",
        update: {
          ...update,
          viewport: { x: 0.9, y: 0.9 },
        },
      }),
    ).toEqual({
      ack: {
        type: "pointer.ack",
        protocolVersion: 1,
        roomId,
        accepted: false,
        expiresAt: null,
      },
      event: null,
    });
    expect(pointers.snapshot(roomId).pointers[0]?.viewport).toEqual(update.viewport);
    expect(JSON.stringify(first)).not.toMatch(/https?:|selector|className|text|password|token/iu);
  });

  it("replaces a device with its newer socket and ignores a stale disconnect", () => {
    const pointers = createPointers({ minimumIntervalMs: 1 });
    pointers.update({
      principal: principal(),
      socketId: "socket-old",
      update,
    });
    nowMs += 1;
    pointers.update({
      principal: principal(),
      socketId: "socket-new",
      update: {
        ...update,
        viewport: { x: 0.8, y: 0.7 },
      },
    });

    expect(pointers.removeSocket("socket-old")).toEqual([]);
    expect(pointers.snapshot(roomId).pointers).toHaveLength(1);
    expect(pointers.removeSocket("socket-new")).toEqual([
      {
        type: "pointer.clear",
        protocolVersion: 1,
        roomId,
        userId,
        deviceId,
      },
    ]);
  });

  it("expires exactly at three seconds and returns deterministic clear events", () => {
    const pointers = createPointers();
    pointers.update({
      principal: principal(),
      socketId: "socket-owner",
      update,
    });

    nowMs += 2_999;
    expect(pointers.sweep()).toEqual([]);
    expect(pointers.snapshot(roomId).pointers).toHaveLength(1);
    nowMs += 1;
    expect(pointers.sweep()).toEqual([
      {
        type: "pointer.clear",
        protocolVersion: 1,
        roomId,
        userId,
        deviceId,
      },
    ]);
    expect(pointers.snapshot(roomId).pointers).toEqual([]);
  });

  it("bounds each room while allowing an existing identity to refresh", () => {
    const pointers = createPointers({
      minimumIntervalMs: 1,
      maxRoomEntries: 1,
    });
    pointers.update({
      principal: principal(),
      socketId: "socket-owner",
      update,
    });
    nowMs += 1;
    expect(() =>
      pointers.update({
        principal: principal({
          userId: secondUserId,
          deviceId: secondDeviceId,
        }),
        socketId: "socket-second",
        update,
      }),
    ).toThrow(expect.objectContaining({ code: "OPERATION_RATE_LIMITED" }));
    expect(() =>
      pointers.update({
        principal: principal(),
        socketId: "socket-owner",
        update,
      }),
    ).not.toThrow();
  });

  it("rejects invalid options, socket IDs, clocks, and malformed updates", () => {
    expect(
      () =>
        new RoomPointerService({
          authorization: new FakeAuthorization(),
          leaseMs: 3_001,
        }),
    ).toThrow(expect.objectContaining({ code: "INVALID_SYNC_MESSAGE" }));
    const pointers = createPointers();
    expect(() =>
      pointers.update({
        principal: principal(),
        socketId: "",
        update,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_SYNC_MESSAGE" }));
    expect(() =>
      pointers.update({
        principal: principal(),
        socketId: "socket-owner",
        update: { ...update, viewport: { x: 2, y: 0 } },
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_SYNC_MESSAGE" }));

    nowMs = Number.NaN;
    expect(() =>
      pointers.update({
        principal: principal(),
        socketId: "socket-owner",
        update,
      }),
    ).toThrow(expect.objectContaining({ code: "RECOVERY_REQUIRED" }));
  });
});
