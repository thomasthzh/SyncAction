import type { ContentCompatibility, DocumentRevision } from "@syncaction/protocol";
import type { PageAccessReason, PageFeature } from "./ui/ui-protocol.js";

export const ALL_PAGE_FEATURES = [
  "POINTER",
  "DANMAKU",
  "DRAWING",
  "MEDIA_CONTROL",
] as const satisfies readonly PageFeature[];

export interface DocumentFeatureAccess {
  enabledFeatures: PageFeature[];
  contentReason: PageAccessReason | null;
}

export function projectDocumentFeatureAccess(input: {
  grantEffective: boolean;
  documentRevision: DocumentRevision | null;
  contentCompatibility: ContentCompatibility | null;
  mediaCollaborationAvailable?: boolean | undefined;
}): DocumentFeatureAccess {
  if (!input.grantEffective || input.documentRevision === null) {
    return { enabledFeatures: [], contentReason: null };
  }
  if (input.contentCompatibility === "EXACT") {
    return {
      enabledFeatures: [...ALL_PAGE_FEATURES],
      contentReason: null,
    };
  }
  if (input.contentCompatibility === "MISMATCH" && input.mediaCollaborationAvailable === true) {
    // Media runtimes still enforce the matching identity and media-only anchors.
    return {
      enabledFeatures: [...ALL_PAGE_FEATURES],
      contentReason: "CONTENT_MISMATCH",
    };
  }
  return {
    enabledFeatures: ["DANMAKU"],
    contentReason:
      input.contentCompatibility === "MISMATCH" ? "CONTENT_MISMATCH" : "CONTENT_UNKNOWN",
  };
}
