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
  return {
    enabledFeatures: ["DANMAKU"],
    contentReason:
      input.contentCompatibility === "MISMATCH" ? "CONTENT_MISMATCH" : "CONTENT_UNKNOWN",
  };
}
