import {
  PageShareExpectedContextSchema,
  type PageShareExpectedContext,
} from "../ui/ui-protocol.js";
import type { UiStore } from "./store.js";

/** Capture before queuing a share, so switching tabs or rooms cannot publish another page. */
export function capturePageShareContext(store: UiStore): PageShareExpectedContext | null {
  const access = store.pageAccess.value;
  const result = PageShareExpectedContextSchema.safeParse({
    profileId: store.shell.value.selectedProfileId,
    roomId: store.room.value.selectedRoomId,
    tabId: access.tabId,
    ...(access.url == null ? {} : { url: access.url }),
  });
  return result.success ? result.data : null;
}
