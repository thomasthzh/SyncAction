import type {
  DocumentRevision,
  LogicalTabId,
  MediaObservedState,
  MediaTarget,
  PlaybackAction,
} from "@syncaction/protocol";

export const MEDIA_DISCOVERY_RESULT_CODES = [
  "MEDIA_NOT_FOUND",
  "MEDIA_METADATA_PENDING",
  "MEDIA_LIVE_UNSUPPORTED",
  "MEDIA_DRM_UNSUPPORTED",
  "MEDIA_FRAME_UNAUTHORIZED",
] as const;

export const MEDIA_APPLY_RESULT_CODES = [
  "AUTOPLAY_BLOCKED",
  "MEDIA_NOT_SUPPORTED",
  "MEDIA_PLAY_ABORTED",
  "MEDIA_APPLY_FAILED",
  "MEDIA_NOT_FOUND",
  "MEDIA_DRM_UNSUPPORTED",
] as const;

export const MEDIA_PAGE_RESULT_CODES = [
  "MEDIA_NOT_FOUND",
  "MEDIA_METADATA_PENDING",
  "MEDIA_LIVE_UNSUPPORTED",
  "MEDIA_DRM_UNSUPPORTED",
  "MEDIA_FRAME_UNAUTHORIZED",
  "AUTOPLAY_BLOCKED",
  "MEDIA_NOT_SUPPORTED",
  "MEDIA_PLAY_ABORTED",
  "MEDIA_APPLY_FAILED",
  "TARGET_MISMATCH",
] as const;

export type MediaDiscoveryResultCode = (typeof MEDIA_DISCOVERY_RESULT_CODES)[number];
export type MediaApplyResultCode = (typeof MEDIA_APPLY_RESULT_CODES)[number];
export type MediaPageResultCode = (typeof MEDIA_PAGE_RESULT_CODES)[number];
export type MediaApplyAction = Exclude<PlaybackAction, { type: "SWITCH_TARGET" }>;

export interface MediaDiscoveryContext {
  logicalTabId: LogicalTabId | string;
  documentRevision: DocumentRevision;
  frameKey: string;
  pageUrl: string;
}

export interface MediaApplyCommand {
  applyToken: string;
  action: MediaApplyAction;
}

export interface MediaApplyResult {
  applied: boolean;
  code: MediaApplyResultCode | null;
  observed: MediaObservedState;
}

export type MediaDiscreteEvent =
  | {
      type: "PLAYED" | "PAUSED" | "SEEKED" | "RATE_CHANGED" | "ENDED" | "BUFFERING" | "READY";
    }
  | { type: "DURATION_CHANGED" }
  | { type: "UNSUPPORTED"; code: "MEDIA_DRM_UNSUPPORTED" };

export interface MediaAdapter {
  readonly target: MediaTarget;
  getMediaElement(): HTMLMediaElement;
  isUsable(): boolean;
  read(): MediaObservedState;
  apply(command: MediaApplyCommand): Promise<MediaApplyResult>;
  subscribe(listener: (event: MediaDiscreteEvent) => void): () => void;
}

export type MediaDiscoveryResult =
  { adapter: MediaAdapter; code: null } | { adapter: null; code: MediaDiscoveryResultCode };

export interface MediaDiscoveryOptions {
  document: Document;
  window: Window;
  context: MediaDiscoveryContext;
  target?: MediaTarget;
  now?: () => number;
}

export interface MediaAdapterFactoryOptions {
  media: HTMLMediaElement;
  window: Window;
  context: MediaDiscoveryContext;
  durationMs: number;
  now?: () => number;
}
