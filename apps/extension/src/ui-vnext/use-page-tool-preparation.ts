import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { UiStore } from "./store.js";
import { shareResult } from "./share-result.js";
import { announce } from "./accessibility.js";
import { capturePageShareContext } from "./page-share-context.js";
import type { PageShareExpectedContext } from "../ui/ui-protocol.js";

export type PageToolIntentKey = "danmaku" | "pen";
const pageTools = {
  danmaku: { label: "弹幕", feature: "DANMAKU", command: "DANMAKU_TOGGLE" },
  pen: { label: "画笔", feature: "DRAWING", command: "PEN_TOGGLE" },
} as const;
type Stage = "CONFIRM" | "SHARING" | "WAITING_PAGE" | "ACTIVATING";
type Captured = {
  key: PageToolIntentKey;
  profileId: string;
  roomId: NonNullable<UiStore["room"]["value"]["selectedRoomId"]>;
  tabId: number;
  origin: string;
  url: string | null;
  activated: boolean;
  shareContext: PageShareExpectedContext;
};
type Preparation = { captured: Captured; stage: Stage };

/** A confirmed share continues only in the original server/room/browser page.
 * A transport ACK is insufficient: wait for the real room document projection. */
export function usePageToolPreparation(
  store: UiStore,
  onRequestPagePermission: (intentKey: string, expectedUrl?: string) => void,
) {
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const current = useRef<Captured | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const access = store.pageAccess.value;
  const profileId = store.shell.value.selectedProfileId;
  const roomId = store.room.value.selectedRoomId;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current = null;
      inFlight.current = false;
    };
  }, []);

  function isCurrent(captured: Captured): boolean {
    const latest = store.pageAccess.value;
    return (
      mounted.current &&
      current.current === captured &&
      store.shell.value.selectedProfileId === captured.profileId &&
      store.room.value.selectedRoomId === captured.roomId &&
      latest.supported &&
      latest.tabId === captured.tabId &&
      latest.origin === captured.origin &&
      (captured.shareContext.url === undefined ||
        latest.url === undefined ||
        latest.url === captured.shareContext.url)
    );
  }

  function finish(
    captured: Captured,
    error: string | null = null,
    text: string | null = null,
  ): void {
    if (!mounted.current || current.current !== captured) return;
    current.current = null;
    inFlight.current = false;
    setPreparation(null);
    setErrorCode(error);
    setMessage(text);
    if (text !== null) announce(text);
  }

  function cancel(): void {
    const captured = current.current;
    if (captured !== null) finish(captured);
    else {
      setErrorCode(null);
      setMessage(null);
    }
  }

  useLayoutEffect(() => {
    const captured = current.current;
    if (captured !== null && !isCurrent(captured)) finish(captured, "PAGE_TOOL_CONTEXT_CHANGED");
  }, [access.tabId, access.origin, access.url, access.supported, profileId, roomId]);

  function request(key: PageToolIntentKey): void {
    if (inFlight.current) return;
    const latest = store.pageAccess.value;
    const selectedRoom = store.room.value.selectedRoomId;
    const shareContext = capturePageShareContext(store);
    if (!latest.supported || latest.tabId === null || latest.origin === null) {
      setErrorCode("PROTECTED_PAGE");
      return;
    }
    if (selectedRoom === null || shareContext === null) {
      setErrorCode("ROOM_DOCUMENT_UNAVAILABLE");
      return;
    }
    const captured: Captured = {
      key,
      profileId: store.shell.value.selectedProfileId,
      roomId: selectedRoom,
      tabId: latest.tabId,
      origin: latest.origin,
      url: shareContext.url ?? null,
      shareContext,
      activated: false,
    };
    current.current = captured;
    setErrorCode(null);
    setMessage(null);
    setPreparation({ captured, stage: "CONFIRM" });
  }

  async function activate(captured: Captured): Promise<void> {
    if (!isCurrent(captured) || captured.activated) return;
    const latest = store.pageAccess.value;
    if (latest.documentRevision === null || captured.url === null) return;
    captured.activated = true;
    const tool = pageTools[captured.key];
    if (!latest.browserPermissionGranted || !latest.termsAccepted) {
      finish(captured);
      onRequestPagePermission(captured.key, captured.url);
      return;
    }
    if (!latest.enabledFeatures.includes(tool.feature)) {
      finish(captured, latest.reason ?? "PAGE_FEATURE_UNAVAILABLE");
      return;
    }
    setPreparation({ captured, stage: "ACTIVATING" });
    try {
      const result = await store.command({
        name: tool.command,
        payload: {
          expectedContext: {
            profileId: captured.profileId,
            roomId: captured.roomId,
            tabId: captured.tabId,
            url: captured.url,
            documentRevision: latest.documentRevision,
          },
        },
      });
      if (!isCurrent(captured)) return;
      finish(
        captured,
        result.ok ? null : result.errorCode,
        result.ok ? `${tool.label}操作已完成` : null,
      );
    } catch {
      if (isCurrent(captured)) finish(captured, "NETWORK_ERROR");
    }
  }

  useEffect(() => {
    if (preparation === null || preparation.stage === "CONFIRM") return;
    const { captured, stage } = preparation;
    if (stage === "WAITING_PAGE" && access.documentRevision !== null) {
      void activate(captured);
      return;
    }
    const timer = setTimeout(() => {
      if (isCurrent(captured))
        finish(
          captured,
          stage === "ACTIVATING" ? "PAGE_TOOL_RESULT_UNCONFIRMED" : "PAGE_DOCUMENT_PREPARING",
        );
    }, 10_000);
    return () => clearTimeout(timer);
  }, [preparation, access.documentRevision]);

  async function confirm(): Promise<void> {
    const captured = current.current;
    if (captured === null || inFlight.current || !isCurrent(captured)) return;
    inFlight.current = true;
    setErrorCode(null);
    setMessage(null);
    setPreparation({ captured, stage: "SHARING" });
    try {
      const outcome = shareResult(
        await store.command({
          name: "CURRENT_TAB_SHARE",
          payload: { expectedContext: captured.shareContext },
        }),
      );
      if (!isCurrent(captured)) return;
      if (!outcome.result.ok) {
        finish(captured, outcome.result.errorCode);
        return;
      }
      const value = outcome.result.value;
      const context =
        typeof value === "object" && value !== null && "sharedPageContext" in value
          ? value.sharedPageContext
          : null;
      if (
        typeof context !== "object" ||
        context === null ||
        !("tabId" in context) ||
        context.tabId !== captured.tabId ||
        !("url" in context) ||
        typeof context.url !== "string"
      ) {
        finish(captured, "PAGE_TOOL_CONTEXT_CHANGED");
        return;
      }
      const url = new URL(context.url);
      if (url.origin !== captured.origin || !["http:", "https:"].includes(url.protocol)) {
        finish(captured, "PAGE_TOOL_CONTEXT_CHANGED");
        return;
      }
      captured.url = context.url;
      const refreshed = await store.command({ name: "PAGE_PERMISSION_REFRESH" });
      if (!isCurrent(captured)) return;
      if (!refreshed.ok) {
        finish(captured, refreshed.errorCode);
        return;
      }
      setPreparation({ captured, stage: "WAITING_PAGE" });
    } catch {
      if (isCurrent(captured)) finish(captured, "NETWORK_ERROR");
    }
  }

  return {
    request,
    confirm,
    cancel,
    errorCode,
    message,
    isBusy: () => inFlight.current,
    busy: preparation !== null && preparation.stage !== "CONFIRM",
    preparation:
      preparation === null
        ? null
        : {
            label: pageTools[preparation.captured.key].label,
            origin: preparation.captured.origin,
            stage: preparation.stage,
          },
  };
}
