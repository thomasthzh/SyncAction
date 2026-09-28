// @vitest-environment happy-dom

import { act } from "preact/test-utils";
import {
  CanonicalUuidSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  NotificationSchema,
  RoomIdSchema,
} from "@syncaction/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/ui-vnext/app.js";
import type { UiStateSlices } from "../src/ui/ui-protocol.js";
import { TestUiStore, renderPanel, unmountPanel } from "./ui-vnext-test-harness.js";

const nowMs = 1_785_369_600_000;
const roomId = RoomIdSchema.parse(uuid(1));
const userIds = Array.from({ length: 20 }, (_, index) =>
  CanonicalUuidSchema.parse(uuid(100 + index)),
);
const pageIds = Array.from({ length: 20 }, (_, index) =>
  LogicalTabIdSchema.parse(uuid(200 + index)),
);
const groupIds = Array.from({ length: 5 }, (_, index) =>
  CanonicalUuidSchema.parse(uuid(300 + index)),
);

afterEach(() => unmountPanel());

describe("vNext dense UI performance acceptance", () => {
  it("commits thirty dense-state patches below 100 ms p95 without replacing stable rows", () => {
    const store = denseStore();
    const root = renderPanel(<App store={store} now={() => nowMs} />);
    const stableFirstRow = root.querySelector(`[data-page-id="${pageIds[0]}"]`);
    const stableLastRow = root.querySelector(`[data-page-id="${pageIds.at(-1)}"]`);
    const stablePlaybackGroup = root.querySelector(`[data-group-id="${groupIds[0]}"]`);
    expect(stableFirstRow).not.toBeNull();
    expect(stableLastRow).not.toBeNull();
    expect(stablePlaybackGroup).not.toBeNull();
    expect(root.querySelectorAll("[data-page-id]")).toHaveLength(20);
    expect(root.querySelectorAll("[data-group-id]")).toHaveLength(5);
    expect(store.notifications.value.items).toHaveLength(60);

    const durations: number[] = [];
    const mutationBatches: number[] = [];
    let mutationCount = 0;
    const observer = new MutationObserver(() => {
      mutationCount += 1;
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    for (let index = 0; index < 30; index += 1) {
      mutationCount = 0;
      const start = performance.now();
      act(() => {
        store.update({
          notifications: {
            ...store.notifications.value,
            unreadCount: index + 1,
            cursor: 60 + index + 1,
          },
        });
      });
      durations.push(performance.now() - start);
      mutationBatches.push(mutationCount);
      expect(root.querySelector(`[data-page-id="${pageIds[0]}"]`)).toBe(stableFirstRow);
      expect(root.querySelector(`[data-page-id="${pageIds.at(-1)}"]`)).toBe(stableLastRow);
      expect(root.querySelector(`[data-group-id="${groupIds[0]}"]`)).toBe(stablePlaybackGroup);
    }
    observer.disconnect();

    const sorted = [...durations].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    if (process.env.SYNCACTION_CAPTURE_UI_METRICS === "1") {
      console.info(
        `[ui-performance] ${JSON.stringify({ samples: durations, p95Ms: p95, mutationBatches })}`,
      );
    }
    expect(
      p95,
      `dense commit p95=${p95.toFixed(2)}ms; samples=${durations
        .map((duration) => duration.toFixed(2))
        .join(",")}`,
    ).toBeLessThan(100);
    expect(Math.max(...mutationBatches)).toBeLessThanOrEqual(1);
    expect(root.querySelectorAll(".syncaction-app")).toHaveLength(1);
  });
});

function denseStore(): TestUiStore {
  const store = new TestUiStore();
  const members = userIds.map((userId, index) => ({
    userId,
    username: `user-${index}`,
    displayName: `成员 ${index + 1}`,
    role: index === 0 ? ("OWNER" as const) : ("MEMBER" as const),
    joinedAt: "2026-07-30T00:00:00.000Z",
  }));
  const pages = pageIds.map((pageId, index) => ({
    pageId,
    title: `共享页面 ${String(index + 1).padStart(2, "0")}`,
    domain: `page-${index + 1}.example`,
    state: "OPEN" as const,
    compatibility: "EXACT" as const,
  }));
  const collaborationMembers = members.map((member, index) => ({
    userId: member.userId,
    displayName: member.displayName,
    roomRole: member.role,
    online: true,
    deviceCount: 1,
    activePageIds: [pageIds[index]!],
  }));
  const groups = groupIds.map((playbackGroupId, groupIndex) => {
    const groupMembers = members.slice(groupIndex * 4, groupIndex * 4 + 4);
    return {
      playbackGroupId,
      roomId,
      groupRevision: 1,
      status: "PLAYING" as const,
      leaderUserId: groupMembers[0]!.userId,
      leaderDeviceId: DeviceIdSchema.parse(uuid(400 + groupIndex * 4)),
      members: groupMembers.map((member, memberIndex) => ({
        userId: member.userId,
        username: member.username,
        displayName: member.displayName,
        activeDeviceId: DeviceIdSchema.parse(uuid(400 + groupIndex * 4 + memberIndex)),
        joinedAtServerMs: nowMs - 10_000 + memberIndex,
        online: true,
      })),
      target: {
        logicalTabId: pageIds[groupIndex]!,
        documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
        frameKey: "top",
        provider: "HTML5" as const,
        mediaKey: `html:video-${groupIndex}`,
        durationMs: 600_000,
      },
      observed: {
        observedAtClientMs: nowMs - 1_000,
        positionMs: groupIndex * 10_000,
        paused: false,
        playbackRate: 1,
        ended: false,
        buffering: false,
      },
      observedAtServerMs: nowMs - 1_000,
      proposals: [],
      leaderGraceExpiresAtServerMs: null,
      updatedAtServerMs: nowMs - 1_000,
    };
  });
  const notifications = Array.from({ length: 60 }, (_, index) =>
    NotificationSchema.parse({
      notificationId: uuid(500 + index),
      cursor: index + 1,
      type: "SYSTEM_UPDATE",
      actor: null,
      room: null,
      requestId: null,
      invitationId: null,
      decision: null,
      title: `系统消息 ${index + 1}`,
      body: "性能验收消息",
      version: "0.9.0",
      createdAt: "2026-07-30T00:00:00.000Z",
      readAt: null,
    }),
  );
  const next: Partial<UiStateSlices> = {
    shell: {
      ...store.shell.value,
      phase: "ROOM_ACTIVE",
      account: {
        id: userIds[0]!,
        username: "user-0",
        displayName: "成员 1",
        status: "ACTIVE",
        passwordResetRequired: false,
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    },
    discovery: {
      publicRooms: [],
      invitations: [],
      rooms: [
        {
          id: roomId,
          name: "密集验收房间",
          role: "OWNER",
          roomEpoch: 0,
          visibility: "PUBLIC",
          joinPolicy: "OPEN",
          roomRevision: 1,
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    },
    room: {
      selectedRoomId: roomId,
      detail: {
        id: roomId,
        name: "密集验收房间",
        role: "OWNER",
        roomEpoch: 0,
        visibility: "PUBLIC",
        joinPolicy: "OPEN",
        roomRevision: 1,
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
        members,
        pendingInvitations: [],
      },
      runtime: {
        state: "SYNCED",
        roomName: "密集验收房间",
        serverSeq: 1,
        sharedTabCount: 20,
        outboxCount: 0,
        pendingConfirmationCount: 0,
        bindingCount: 20,
        browser: {
          state: "SYNCHRONIZED",
          reason: null,
          missingTabCount: 0,
          effectsApplied: 0,
        },
        presence: null,
        pointer: null,
        media: {
          state: "ONLINE",
          roomMediaRevision: 1,
          playbackGroups: groups,
          localObservation: null,
          localMembership: null,
          recommendedPlaybackGroupId: groupIds[0]!,
          navigation: collaborationMembers.map((member, index) => ({
            userId: member.userId,
            deviceId: DeviceIdSchema.parse(uuid(400 + index)),
            logicalTabId: pageIds[index]!,
            canJump: true,
            disabledReason: null,
          })),
          errorCode: null,
        },
        danmaku: null,
        drawing: null,
        tabs: pages.map((page) => ({
          logicalTabId: page.pageId,
          title: page.title,
          domain: page.domain,
        })),
      },
    },
    collaboration: {
      capacity: { openTabCount: 20, limit: 20, exemption: "NOT_EXEMPT" },
      navigation: { canJump: true, disabledReason: null },
      pages,
      members: collaborationMembers,
      playbackGroups: [],
      tools: [],
      proposals: [],
      annotation: {
        used: 0,
        capacity: 2_000,
        lockedCount: 0,
        state: "AVAILABLE",
        canCreate: true,
        disabledReason: null,
      },
      activities: [],
    },
    notifications: {
      items: notifications,
      unreadCount: 0,
      cursor: 60,
    },
  };
  store.update(next);
  return store;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
