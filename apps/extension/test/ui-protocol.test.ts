import { describe, expect, it } from "vitest";
import {
  UiCommandNameSchema,
  UiCommandResultSchema,
  UiCommandSchema,
  UiResyncSchema,
  UiStatePatchSchema,
  UiStateSnapshotSchema,
  type UiStateSlices,
} from "../src/ui/ui-protocol.js";

const commandId = "018f8f8e-4b5c-7d6e-8f90-123456789c01";
const roomId = "018f8f8e-4b5c-7d6e-8f90-123456789c02";

function emptyCollaboration(): UiStateSlices["collaboration"] {
  return {
    capacity: {
      openTabCount: 0,
      limit: 20,
      exemption: "NOT_EXEMPT",
    },
    navigation: {
      canJump: false,
      disabledReason: "ROOM_NOT_SELECTED",
    },
    pages: [],
    members: [],
    playbackGroups: [],
    tools: [],
    proposals: [],
    annotation: {
      used: 0,
      capacity: null,
      lockedCount: 0,
      state: "UNAVAILABLE",
      canCreate: false,
      disabledReason: "ROOM_NOT_SELECTED",
    },
    activities: [],
  };
}

function slices(): UiStateSlices {
  return {
    shell: {
      phase: "SIGNED_OUT",
      account: null,
      profiles: [
        {
          profileId: "syncaction-production",
          baseUrl: "https://syncaction.example.com",
          mode: "UNVERIFIED",
          metadata: null,
          lastHealthyAt: null,
        },
      ],
      selectedProfileId: "syncaction-production",
      onboardingRequired: true,
      errorCode: null,
    },
    discovery: {
      publicRooms: [],
      rooms: [],
      invitations: [],
    },
    room: {
      selectedRoomId: null,
      detail: null,
      runtime: null,
    },
    collaboration: emptyCollaboration(),
    notifications: {
      items: [],
      unreadCount: 0,
      cursor: 0,
    },
    pageAccess: {
      bindings: null,
      tabId: null,
      documentRevision: null,
      contentCompatibility: null,
      origin: null,
      supported: false,
      browserPermissionGranted: false,
      termsAccepted: false,
      serverTermsVersion: null,
      disclosureVersion: 1,
      enabledFeatures: [],
      policySyncPendingCount: 0,
      reason: "NO_ACTIVE_TAB",
    },
  };
}

function versions(value = 0): Record<keyof UiStateSlices, number> {
  return {
    shell: value,
    discovery: value,
    room: value,
    collaboration: value,
    notifications: value,
    pageAccess: value,
  };
}

describe("side-panel UI protocol", () => {
  it("accepts a complete strict snapshot and rejects unknown or missing state", () => {
    const message = {
      type: "ui.state.snapshot",
      versions: versions(),
      slices: slices(),
    };

    expect(UiStateSnapshotSchema.parse(message)).toEqual(message);
    expect(() => UiStateSnapshotSchema.parse({ ...message, unexpected: true })).toThrow();
    expect(() =>
      UiStateSnapshotSchema.parse({
        ...message,
        slices: {
          ...message.slices,
          shell: { ...message.slices.shell, unexpected: true },
        },
      }),
    ).toThrow();
    const incomplete = Object.fromEntries(
      Object.entries(message.slices).filter(([slice]) => slice !== "notifications"),
    );
    expect(() => UiStateSnapshotSchema.parse({ ...message, slices: incomplete })).toThrow();
  });

  it("accepts one strict slice replacement only for an exact version increment", () => {
    const room = slices().room;
    expect(
      UiStatePatchSchema.parse({
        type: "ui.state.patch",
        slice: "room",
        fromVersion: 4,
        toVersion: 5,
        value: room,
      }),
    ).toBeDefined();

    expect(() =>
      UiStatePatchSchema.parse({
        type: "ui.state.patch",
        slice: "room",
        fromVersion: 5,
        toVersion: 5,
        value: room,
      }),
    ).toThrow();
    expect(() =>
      UiStatePatchSchema.parse({
        type: "ui.state.patch",
        slice: "room",
        fromVersion: 4,
        toVersion: 5,
        value: slices().notifications,
      }),
    ).toThrow();
    expect(() =>
      UiStatePatchSchema.parse({
        type: "ui.state.patch",
        slice: "room",
        fromVersion: 4,
        toVersion: 5,
        value: room,
        extra: true,
      }),
    ).toThrow();
  });

  it("requires a complete strict version record when requesting resynchronization", () => {
    expect(
      UiResyncSchema.parse({
        type: "ui.resync",
        versions: versions(8),
      }),
    ).toBeDefined();
    expect(() =>
      UiResyncSchema.parse({
        type: "ui.resync",
        versions: { ...versions(8), shell: -1 },
      }),
    ).toThrow();
    expect(() =>
      UiResyncSchema.parse({
        type: "ui.resync",
        versions: { ...versions(8), extra: 8 },
      }),
    ).toThrow();
  });

  it("defines every supported command as a strict discriminated union", () => {
    expect(UiCommandNameSchema.options).toEqual([
      "AUTH_REGISTER",
      "AUTH_LOGIN",
      "AUTH_ACTIVATE",
      "AUTH_KEY_LOGIN",
      "AUTH_LOGOUT",
      "ACCOUNT_PROFILE_UPDATE",
      "ACCOUNT_PASSWORD_CHANGE",
      "ACCOUNT_PASSWORD_INITIALIZE",
      "SERVER_ADD",
      "SERVER_SELECT",
      "ONBOARDING_DISMISS",
      "PUBLIC_ROOMS_REFRESH",
      "ROOM_CREATE",
      "ROOM_UPDATE",
      "ROOM_SELECT",
      "ROOM_TAB_ACTIVATE",
      "ROOM_JOIN_OPEN",
      "ROOM_JOIN_REQUEST",
      "JOIN_REQUEST_DECIDE",
      "INVITATION_ACCEPT",
      "DIRECTORY_SEARCH",
      "INVITE_BATCH",
      "NOTIFICATION_READ",
      "NOTIFICATIONS_READ_ALL",
      "ROOM_LEAVE",
      "ROOM_MEMBER_REMOVE",
      "ROOM_OWNERSHIP_TRANSFER",
      "ROOM_DISSOLVE",
      "CURRENT_TAB_SHARE",
      "BROWSER_RECOVERY_CONFIRM",
      "PAGE_PERMISSION_REFRESH",
      "PAGE_PERMISSION_REMOVE",
      "POLICY_ACCEPTANCE_RECORD",
      "DANMAKU_TOGGLE",
      "DANMAKU_VISIBILITY",
      "PEN_TOGGLE",
      "MEDIA_MEMBER_JUMP",
      "MEDIA_GROUP_ALIGN_ONCE",
      "MEDIA_GROUP_JOIN",
      "MEDIA_GROUP_LEAVE",
      "MEDIA_GROUP_CLOSE",
      "MEDIA_DEVICE_TAKEOVER",
      "MEDIA_PROPOSAL_DECIDE",
    ]);

    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "AUTH_REGISTER",
        payload: {
          username: "alice",
          displayName: "Alice",
          password: "correct horse battery staple",
        },
      }),
    ).toBeDefined();
    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "AUTH_KEY_LOGIN",
        payload: { activationKey: `sak_${"B".repeat(43)}` },
      }),
    ).toBeDefined();
    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "AUTH_ACTIVATE",
        payload: {
          activationKey: `sak_${"A".repeat(43)}`,
          username: "alice",
          displayName: "Alice",
          password: "correct horse battery staple",
        },
      }),
    ).toBeDefined();
    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "ACCOUNT_PASSWORD_INITIALIZE",
        payload: { newPassword: "replacement horse battery staple" },
      }),
    ).toBeDefined();
    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "ACCOUNT_PROFILE_UPDATE",
        payload: { username: "alice.renamed", displayName: "Alice Renamed" },
      }),
    ).toBeDefined();
    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "ACCOUNT_PASSWORD_CHANGE",
        payload: {
          currentPassword: "correct horse battery staple",
          newPassword: "replacement horse battery staple",
        },
      }),
    ).toBeDefined();
    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "AUTH_LOGOUT",
      }),
    ).toBeDefined();
    expect(() =>
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "AUTH_LOGOUT",
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "POLICY_ACCEPTANCE_RECORD",
        payload: {
          termsVersion: "forged",
          clientVersion: "99.0.0",
        },
      }),
    ).toThrow();
  });

  it("normalizes server origins and accepts only exact page origins", () => {
    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "SERVER_ADD",
        payload: { baseUrl: "https://team.example/" },
      }),
    ).toMatchObject({
      payload: { baseUrl: "https://team.example" },
    });
    expect(
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "PAGE_PERMISSION_REMOVE",
        payload: { origin: "http://news.example:8080" },
      }),
    ).toBeDefined();
    expect(() =>
      UiCommandSchema.parse({
        type: "ui.command",
        commandId,
        name: "PAGE_PERMISSION_REMOVE",
        payload: { origin: "https://news.example/article" },
      }),
    ).toThrow();
  });

  it("models page access as a strict versioned, document-bound feature grant", () => {
    const access = {
      bindings: null,
      tabId: 42,
      documentRevision: { roomEpoch: 3, tabUpdatedAtSeq: 18 },
      contentCompatibility: "EXACT",
      origin: "https://video.example",
      supported: true,
      browserPermissionGranted: true,
      termsAccepted: true,
      serverTermsVersion: "2026-07-30",
      disclosureVersion: 1,
      enabledFeatures: ["POINTER", "DANMAKU", "DRAWING", "MEDIA_CONTROL"],
      policySyncPendingCount: 2,
      reason: null,
    };

    expect(
      UiStatePatchSchema.parse({
        type: "ui.state.patch",
        slice: "pageAccess",
        fromVersion: 1,
        toVersion: 2,
        value: access,
      }),
    ).toMatchObject({ value: access });
    expect(() =>
      UiStatePatchSchema.parse({
        type: "ui.state.patch",
        slice: "pageAccess",
        fromVersion: 1,
        toVersion: 2,
        value: {
          ...access,
          enabledFeatures: ["POINTER", "POINTER"],
        },
      }),
    ).toThrow();
    expect(() =>
      UiStatePatchSchema.parse({
        type: "ui.state.patch",
        slice: "pageAccess",
        fromVersion: 1,
        toVersion: 2,
        value: {
          ...access,
          origin: "https://video.example/watch",
        },
      }),
    ).toThrow();
    expect(() =>
      UiStatePatchSchema.parse({
        type: "ui.state.patch",
        slice: "pageAccess",
        fromVersion: 1,
        toVersion: 2,
        value: {
          ...access,
          browserPermissionGranted: false,
        },
      }),
    ).toThrow();
  });

  it("correlates strict success and failure results without accepting foreign fields", () => {
    expect(
      UiCommandResultSchema.parse({
        type: "ui.command.result",
        commandId,
        ok: true,
        value: { roomId },
      }),
    ).toEqual({
      type: "ui.command.result",
      commandId,
      ok: true,
      value: { roomId },
    });
    expect(
      UiCommandResultSchema.parse({
        type: "ui.command.result",
        commandId,
        ok: false,
        errorCode: "ROOM_NOT_FOUND",
      }),
    ).toBeDefined();
    expect(() =>
      UiCommandResultSchema.parse({
        type: "ui.command.result",
        commandId,
        ok: false,
        errorCode: "ROOM_NOT_FOUND",
        value: null,
      }),
    ).toThrow();
  });
});
