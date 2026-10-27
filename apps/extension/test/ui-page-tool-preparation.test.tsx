// @vitest-environment happy-dom

import { RoomIdSchema } from "@syncaction/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomActionDock } from "../src/ui-vnext/components/bottom-action-dock.js";
import { TestUiStore, byRole, click, renderPanel, unmountPanel } from "./ui-vnext-test-harness.js";

const roomId = RoomIdSchema.parse("00000000-0000-4000-8000-000000000501");

afterEach(() => unmountPanel());

describe("page tool preparation", () => {
  it.each(["画笔", "弹幕"])(
    "offers an explicit share step for %s instead of a document error",
    async (label) => {
      const store = new TestUiStore();
      store.update({
        room: { ...store.room.value, selectedRoomId: roomId },
        pageAccess: {
          ...store.pageAccess.value,
          tabId: 42,
          origin: "https://watch.example",
          supported: true,
          browserPermissionGranted: true,
          termsAccepted: true,
          serverTermsVersion: "v1",
          reason: "ROOM_DOCUMENT_UNAVAILABLE",
        },
      });
      const requestPermission = vi.fn();
      const root = renderPanel(
        <BottomActionDock
          store={store}
          isOwner
          onOpenInvite={() => {}}
          onOpenRoomLifecycle={() => {}}
          onRequestPagePermission={requestPermission}
        />,
      );
      await click(byRole(root, "button", label));
      expect(root.textContent).toContain("先分享当前页面");
      expect(byRole(root, "button", `分享当前页并启用${label}`)).toBeDefined();
      expect(root.textContent).not.toContain("ROOM_DOCUMENT_UNAVAILABLE");
      expect(store.commandCalls).toEqual([]);
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );
});
