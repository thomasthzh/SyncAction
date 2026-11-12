import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { capturePageShareContext } from "../page-share-context.js";
import type { UiStore } from "../store.js";
import { shareResult } from "../share-result.js";
import { useCommandFeedback } from "../use-command-feedback.js";
import { ActionableStatus } from "./actionable-status.js";

interface StartWatchingCardProps {
  readonly store: UiStore;
  readonly playbackGroupId?: string;
  readonly collapsible?: boolean;
  readonly onRequestPagePermission: (intentKey: string, expectedUrl?: string) => void;
}

export function StartWatchingCard({
  store,
  playbackGroupId,
  collapsible = false,
  onRequestPagePermission,
}: StartWatchingCardProps): JSX.Element {
  const feedback = useCommandFeedback();
  const access = store.pageAccess.value;
  const [stage, setStage] = useState<"IDLE" | "SHARING" | "WAITING_PAGE">("IDLE");
  const requestedTab = useRef<number | null>(null);
  const requestedOrigin = useRef<string | null>(null);
  const requestedProfile = useRef<string | null>(null);
  const requestedRoom = useRef<typeof store.room.value.selectedRoomId>(null);
  const requestedRevision = useRef<typeof access.documentRevision>(null);
  const requestedUrl = useRef<string | null>(null);
  const requestedPageUrl = useRef<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const membership = store.room.value.runtime?.media?.localMembership;
  const switching = playbackGroupId !== undefined;
  const hasGroup = membership !== null && membership !== undefined && !switching;

  useLayoutEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  function isCurrent(): boolean {
    const current = store.pageAccess.value;
    const revision = requestedRevision.current;
    return (
      mounted.current &&
      store.shell.value.selectedProfileId === requestedProfile.current &&
      store.room.value.selectedRoomId === requestedRoom.current &&
      current.tabId === requestedTab.current &&
      current.origin === requestedOrigin.current &&
      (requestedPageUrl.current === null ||
        current.url === undefined ||
        current.url === requestedPageUrl.current) &&
      (revision === null ||
        (revision.roomEpoch === current.documentRevision?.roomEpoch &&
          revision.tabUpdatedAtSeq === current.documentRevision?.tabUpdatedAtSeq))
    );
  }

  async function createOrAuthorize(): Promise<void> {
    if (!isCurrent()) return;
    // Known-media synchronization validates its target in the runtime. Full-page
    // content equality is a separate gate for positional collaboration.
    const grant = store.pageAccess.value;
    if (!grant.browserPermissionGranted || !grant.termsAccepted) {
      const intent = switching ? `media-switch:${playbackGroupId}` : "media-create";
      if (requestedUrl.current === null) onRequestPagePermission(intent);
      else onRequestPagePermission(intent, requestedUrl.current);
      return;
    }
    const current = store.pageAccess.value;
    const tabId = current.tabId;
    const documentRevision = current.documentRevision;
    if (tabId === null || documentRevision === null) return;
    const expectedContext = {
      profileId: store.shell.value.selectedProfileId,
      tabId,
      documentRevision,
      ...(requestedRoom.current === null ? {} : { roomId: requestedRoom.current }),
      ...(requestedUrl.current === null ? {} : { url: requestedUrl.current }),
    };
    await feedback.run(
      switching ? "继续一起看" : "开始一起看",
      () =>
        store.command(
          playbackGroupId === undefined
            ? { name: "MEDIA_GROUP_CREATE", payload: { expectedContext } }
            : { name: "MEDIA_GROUP_SWITCH_CURRENT", payload: { playbackGroupId, expectedContext } },
        ),
      switching ? "已切换当前视频，同伴继续在原播放组跟随" : "播放组已创建，邀请朋友加入跟随",
    );
  }

  useEffect(() => {
    if (stage !== "WAITING_PAGE") return;
    if (!isCurrent()) {
      setStage("IDLE");
      inFlight.current = false;
      feedback.setErrorCode("PAGE_CHANGED_DURING_PERMISSION");
      return;
    }
    if (access.documentRevision !== null) {
      requestedRevision.current = access.documentRevision;
      setStage("IDLE");
      void createOrAuthorize().finally(() => {
        inFlight.current = false;
      });
      return;
    }
    const timeout = setTimeout(() => {
      setStage("IDLE");
      inFlight.current = false;
      feedback.setErrorCode("MEDIA_PAGE_PREPARING");
    }, 10_000);
    return () => clearTimeout(timeout);
  }, [
    stage,
    access.tabId,
    access.origin,
    access.url,
    access.documentRevision,
    store.shell.value.selectedProfileId,
    store.room.value.selectedRoomId,
  ]);

  async function start(): Promise<void> {
    if (inFlight.current || hasGroup) return;
    if (!access.supported || access.tabId === null) {
      feedback.setErrorCode("PROTECTED_PAGE");
      return;
    }
    inFlight.current = true;
    requestedTab.current = access.tabId;
    requestedProfile.current = store.shell.value.selectedProfileId;
    requestedRoom.current = store.room.value.selectedRoomId;
    requestedOrigin.current = access.origin;
    requestedRevision.current = access.documentRevision;
    requestedUrl.current = access.url ?? null;
    requestedPageUrl.current = access.url ?? null;
    feedback.setErrorCode(null);
    if (access.documentRevision !== null) {
      try {
        await createOrAuthorize();
      } finally {
        inFlight.current = false;
      }
      return;
    }
    setStage("SHARING");
    const expectedContext = capturePageShareContext(store);
    if (expectedContext === null) {
      inFlight.current = false;
      setStage("IDLE");
      feedback.setErrorCode("PROTECTED_PAGE");
      return;
    }
    const result = await feedback.run(
      "分享当前视频页面",
      async () =>
        shareResult(
          await store.command({ name: "CURRENT_TAB_SHARE", payload: { expectedContext } }),
        ).result,
    );
    if (!isCurrent()) {
      inFlight.current = false;
      if (mounted.current) {
        setStage("IDLE");
        feedback.setErrorCode("MEDIA_CONTEXT_CHANGED");
      }
      return;
    }
    if (result?.ok !== true) {
      setStage("IDLE");
      inFlight.current = false;
      return;
    }
    const value = result.value;
    const context =
      typeof value === "object" && value !== null && "sharedPageContext" in value
        ? value.sharedPageContext
        : null;
    if (
      typeof context !== "object" ||
      context === null ||
      !("tabId" in context) ||
      context.tabId !== requestedTab.current ||
      !("url" in context) ||
      typeof context.url !== "string"
    ) {
      setStage("IDLE");
      inFlight.current = false;
      feedback.setErrorCode("MEDIA_CONTEXT_CHANGED");
      return;
    }
    requestedUrl.current = context.url;
    await store.command({ name: "PAGE_PERMISSION_REFRESH" }).catch(() => undefined);
    if (isCurrent()) setStage("WAITING_PAGE");
    else {
      inFlight.current = false;
      if (mounted.current) setStage("IDLE");
    }
  }

  const pending = stage !== "IDLE" || feedback.pending !== null;
  const pageShared = access.documentRevision !== null;
  const siteAllowed = access.browserPermissionGranted && access.termsAccepted;
  const creating = feedback.pending !== null && stage === "IDLE";
  const visibleStage = hasGroup
    ? "JOINED"
    : stage !== "IDLE"
      ? stage
      : feedback.pending !== null
        ? "CREATING"
        : !pageShared
          ? "NEEDS_PAGE"
          : !siteAllowed
            ? "NEEDS_PERMISSION"
            : "READY";
  const card = (
    <section
      class="start-watching watch-workspace editorial-surface"
      aria-labelledby="start-watching-heading"
      data-watch-stage={visibleStage}
    >
      <div>
        <h2 id="start-watching-heading">
          {switching ? "换个视频，继续一起看" : "从当前视频开始一起看"}
        </h2>
        <p class="section-description">
          {switching
            ? pageShared
              ? "切换到当前视频，保留原播放组和同伴的跟随关系。"
              : "提交当前页面并切换视频，同伴继续留在原播放组。"
            : !pageShared
              ? "先分享当前页面，再按需允许此网站的媒体同步。"
              : !siteAllowed
                ? "页面已共享，继续允许当前网站后才能创建播放组。"
                : "页面与网站许可已具备，创建时仍会确认视频能否同步。"}
        </p>
      </div>
      {!switching ? (
        <ol class="start-watching__steps" aria-label="开始观看的步骤">
          <li data-step-state={pageShared ? "DONE" : "ACTIVE"}>
            <span class="start-watching__step-number" aria-hidden="true">
              1
            </span>
            <span>
              共享页面
              <small>
                {pageShared
                  ? "已共享"
                  : stage === "WAITING_PAGE"
                    ? "等待房间确认"
                    : stage === "SHARING"
                      ? "正在分享"
                      : "从当前页开始"}
              </small>
            </span>
          </li>
          <li data-step-state={siteAllowed ? "DONE" : pageShared ? "ACTIVE" : "PENDING"}>
            <span class="start-watching__step-number" aria-hidden="true">
              2
            </span>
            <span>
              网站许可<small>{siteAllowed ? "已允许" : "需要本人同意"}</small>
            </span>
          </li>
          <li
            data-step-state={hasGroup ? "DONE" : pageShared && siteAllowed ? "ACTIVE" : "PENDING"}
          >
            <span class="start-watching__step-number" aria-hidden="true">
              3
            </span>
            <span>
              创建播放组
              <small>{hasGroup ? "已加入" : creating ? "确认视频中" : "确认可同步的视频"}</small>
            </span>
          </li>
        </ol>
      ) : null}
      <button
        class="primary-button"
        data-start-watching-action
        type="button"
        disabled={pending || hasGroup}
        aria-busy={pending}
        onClick={() => void start()}
      >
        {hasGroup
          ? "你已在播放组中"
          : stage === "SHARING"
            ? "正在分享页面…"
            : stage === "WAITING_PAGE"
              ? "正在准备共享页面…"
              : feedback.pending !== null
                ? switching
                  ? "正在切换视频…"
                  : "正在创建播放组…"
                : switching
                  ? pageShared
                    ? "用当前视频继续一起看"
                    : "分享当前视频并继续一起看"
                  : "开始一起看"}
      </button>
      <ActionableStatus errorCode={feedback.errorCode} />
      {feedback.message === null ? null : (
        <p class="command-feedback" role="status">
          {feedback.message}
        </p>
      )}
    </section>
  );
  return (
    <details
      class={collapsible ? "watch-new-group" : "watch-primary-start"}
      open={!collapsible || pending ? true : undefined}
    >
      <summary hidden={!collapsible}>用当前视频开始一起看</summary>
      {card}
    </details>
  );
}
