import type { AnnotationErrorCode, DanmakuErrorCode, SyncErrorCode } from "@syncaction/protocol";

export class SyncError extends Error {
  public readonly code: SyncErrorCode;

  public constructor(code: SyncErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "SyncError";
    this.code = code;
  }
}

export class AnnotationServiceError extends Error {
  public readonly code: AnnotationErrorCode;

  public constructor(code: AnnotationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "AnnotationServiceError";
    this.code = code;
  }
}

export class DanmakuServiceError extends Error {
  public readonly code: DanmakuErrorCode;

  public constructor(code: DanmakuErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "DanmakuServiceError";
    this.code = code;
  }
}
