import {
  CONTENT_SIGNATURE_VERSION,
  ContentSignatureSchema,
  DocumentRevisionSchema,
  LogicalTabIdSchema,
  MediaIdentitySchema,
  PageCompatibilityReportSchema,
  RoomIdSchema,
  canonicalSharedPageIdentity,
  type ContentSignature,
  type DocumentRevision,
  type LogicalTabId,
  type MediaIdentity,
  type PageCompatibilityReport,
  type RoomId,
} from "@syncaction/protocol";

const VIEWPORT_BUCKET_CSS_PX = 160;
const MAX_VIEWPORT_BUCKET = 64;
const LANDMARK_GRID_SIZE = 8;
const MAX_LANDMARKS_PER_KIND = 16;
const MAX_LANDMARKS = 96;
const MAX_ELEMENT_ANCESTORS = 4;
const MUTATION_DEBOUNCE_MS = 1_000;
const MIN_SIGNATURE_INTERVAL_MS = 5_000;

const LANDMARK_SELECTORS = [
  "main",
  "nav",
  "header",
  "footer",
  "article",
  "aside",
  "form",
  "video",
  "audio",
  "canvas",
  '[role="main"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="article"]',
  '[role="complementary"]',
].join(",");

const INTERACTIVE_SELECTORS = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "details",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");

const STABLE_ELEMENT_TAGS = new Set([
  "main",
  "nav",
  "header",
  "footer",
  "article",
  "aside",
  "form",
  "video",
  "audio",
  "canvas",
  "section",
  "figure",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "ul",
  "ol",
  "li",
]);

const STABLE_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "article",
  "complementary",
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
]);

type LandmarkKind =
  | "main"
  | "nav"
  | "header"
  | "footer"
  | "article"
  | "aside"
  | "form"
  | "video"
  | "audio"
  | "canvas";

interface SignatureViewport {
  widthCssPx: number;
  heightCssPx: number;
}

interface SemanticLandmarkV1 {
  kind: LandmarkKind;
  xBucket: number;
  yBucket: number;
  widthBucket: number;
  heightBucket: number;
}

interface SemanticSignatureSourceV1 {
  v: 1;
  viewport: {
    widthBucket: number;
    heightBucket: number;
  };
  landmarks: readonly SemanticLandmarkV1[];
  headingCountBuckets: readonly number[];
  interactiveCountBucket: number;
}

interface ElementSignatureSourceV1 {
  v: 1;
  tag: string;
  role: string | null;
  rectangle: {
    xBucket: number;
    yBucket: number;
    widthBucket: number;
    heightBucket: number;
  };
  ancestors: readonly {
    tag: string;
    role: string | null;
  }[];
}

export interface ComputePageContentSignatureOptions {
  document: Document;
  roomId: RoomId;
  pageUrl: string;
  viewport: SignatureViewport;
  subtle?: SubtleCrypto;
}

export interface ComputeElementContentSignatureOptions {
  element: Element;
  roomId: RoomId;
  viewport: SignatureViewport;
  subtle?: SubtleCrypto;
}

export interface BuildPageCompatibilityReportInput {
  logicalTabId: LogicalTabId | string;
  documentRevision: DocumentRevision;
  canonicalPageIdentity: string;
  contentSignature: ContentSignature | null;
  media: MediaIdentity | null;
}

export interface CompatibilityReporterScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CompatibilityMutationObserver {
  observe(
    target: Node,
    options?: {
      subtree?: boolean;
      childList?: boolean;
      attributes?: boolean;
      attributeFilter?: string[];
    },
  ): void;
  disconnect(): void;
}

export interface PageCompatibilityReporterContext {
  logicalTabId: string;
  documentRevision: DocumentRevision;
}

export interface PageContentCompatibilityReporterOptions {
  document: Document;
  roomId: RoomId | string;
  readPageUrl: () => string;
  readViewport: () => SignatureViewport;
  emit: (report: PageCompatibilityReport) => void | Promise<void>;
  subtle?: SubtleCrypto;
  now?: () => number;
  scheduler?: CompatibilityReporterScheduler;
  createMutationObserver?: (callback: () => void) => CompatibilityMutationObserver;
  addPageShowListener?: (listener: EventListener) => void;
  removePageShowListener?: (listener: EventListener) => void;
}

export class PageContentCompatibilityReporter {
  readonly #document: Document;
  readonly #roomId: RoomId;
  readonly #readPageUrl: () => string;
  readonly #readViewport: () => SignatureViewport;
  readonly #emit: (report: PageCompatibilityReport) => void | Promise<void>;
  readonly #subtle: SubtleCrypto | undefined;
  readonly #now: () => number;
  readonly #scheduler: CompatibilityReporterScheduler;
  readonly #observer: CompatibilityMutationObserver;
  readonly #removePageShowListener: (listener: EventListener) => void;
  readonly #pageShowListener: EventListener;
  #context:
    | {
        logicalTabId: LogicalTabId;
        documentRevision: DocumentRevision;
      }
    | undefined;
  #media: MediaIdentity | null = null;
  #observing = false;
  #disposed = false;
  #mutationTimer: unknown;
  #lastComputedAt: number | null = null;
  #lastReportJson: string | null = null;
  #tail: Promise<void> = Promise.resolve();

  public constructor(options: PageContentCompatibilityReporterOptions) {
    this.#document = options.document;
    this.#roomId = RoomIdSchema.parse(options.roomId);
    this.#readPageUrl = options.readPageUrl;
    this.#readViewport = options.readViewport;
    this.#emit = options.emit;
    this.#subtle = options.subtle;
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const createObserver =
      options.createMutationObserver ??
      ((callback: () => void) => {
        const Observer =
          this.#document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
        return new Observer(callback);
      });
    this.#observer = createObserver(() => this.#scheduleMutationReport());
    const addPageShowListener =
      options.addPageShowListener ??
      ((listener: EventListener) =>
        this.#document.defaultView?.addEventListener("pageshow", listener));
    this.#removePageShowListener =
      options.removePageShowListener ??
      ((listener: EventListener) =>
        this.#document.defaultView?.removeEventListener("pageshow", listener));
    this.#pageShowListener = () => {
      if (!this.#disposed && this.#context !== undefined) {
        void this.#enqueueCompute();
      }
    };
    addPageShowListener(this.#pageShowListener);
  }

  public setContext(contextInput: PageCompatibilityReporterContext): Promise<void> {
    if (this.#disposed) {
      return this.whenIdle();
    }
    this.#context = {
      logicalTabId: LogicalTabIdSchema.parse(contextInput.logicalTabId),
      documentRevision: DocumentRevisionSchema.parse(contextInput.documentRevision),
    };
    if (!this.#observing && this.#document.documentElement !== null) {
      this.#observer.observe(this.#document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["role"],
      });
      this.#observing = true;
    }
    return this.#enqueueCompute();
  }

  public setMedia(mediaInput: MediaIdentity | null): Promise<void> {
    if (this.#disposed) {
      return this.whenIdle();
    }
    const media = mediaInput === null ? null : MediaIdentitySchema.parse(mediaInput);
    if (
      (this.#media === null && media === null) ||
      (this.#media !== null &&
        media !== null &&
        this.#media.provider === media.provider &&
        this.#media.mediaKey === media.mediaKey)
    ) {
      return this.whenIdle();
    }
    this.#media = media === null ? null : structuredClone(media);
    return this.#context === undefined ? this.whenIdle() : this.#enqueueCompute();
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#observer.disconnect();
    this.#observing = false;
    if (this.#mutationTimer !== undefined) {
      this.#scheduler.clearTimeout(this.#mutationTimer);
      this.#mutationTimer = undefined;
    }
    this.#removePageShowListener(this.#pageShowListener);
    this.#context = undefined;
    this.#media = null;
  }

  public async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.#tail;
      await observed;
    } while (observed !== this.#tail);
  }

  #scheduleMutationReport(): void {
    if (this.#disposed || this.#context === undefined) {
      return;
    }
    if (this.#mutationTimer !== undefined) {
      this.#scheduler.clearTimeout(this.#mutationTimer);
    }
    const now = this.#now();
    const rateLimitDelay =
      this.#lastComputedAt === null
        ? 0
        : Math.max(0, this.#lastComputedAt + MIN_SIGNATURE_INTERVAL_MS - now);
    const delayMs = Math.max(MUTATION_DEBOUNCE_MS, rateLimitDelay);
    this.#mutationTimer = this.#scheduler.setTimeout(() => {
      this.#mutationTimer = undefined;
      void this.#enqueueCompute();
    }, delayMs);
  }

  #enqueueCompute(): Promise<void> {
    const result = this.#tail.then(async () => this.#computeAndEmit());
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #computeAndEmit(): Promise<void> {
    const context = this.#context;
    if (this.#disposed || context === undefined) {
      return;
    }
    const pageUrl = this.#readPageUrl();
    let canonicalPageIdentity: string;
    try {
      canonicalPageIdentity = canonicalSharedPageIdentity(pageUrl);
    } catch {
      return;
    }
    const viewport = this.#readViewport();
    const signature = await computePageContentSignature({
      document: this.#document,
      roomId: this.#roomId,
      pageUrl,
      viewport,
      ...(this.#subtle === undefined ? {} : { subtle: this.#subtle }),
    });
    if (this.#disposed || this.#context !== context) {
      return;
    }
    this.#lastComputedAt = this.#now();
    const report = buildPageCompatibilityReport({
      logicalTabId: context.logicalTabId,
      documentRevision: context.documentRevision,
      canonicalPageIdentity,
      contentSignature: signature,
      media: this.#media,
    });
    const reportJson = JSON.stringify(report);
    if (reportJson === this.#lastReportJson) {
      return;
    }
    this.#lastReportJson = reportJson;
    await this.#emit(report);
  }
}

export async function computePageContentSignature(
  options: ComputePageContentSignatureOptions,
): Promise<ContentSignature | null> {
  if (
    !isReadySupportedDocument(options.document, options.pageUrl) ||
    !isValidViewport(options.viewport) ||
    !RoomIdSchema.safeParse(options.roomId).success
  ) {
    return null;
  }
  const source = buildPageSource(options.document, options.viewport);
  return hashSource(
    `SyncAction/content-signature/v${String(CONTENT_SIGNATURE_VERSION)}\0${options.roomId}\0`,
    source,
    options.subtle,
  );
}

export async function computeElementContentSignature(
  options: ComputeElementContentSignatureOptions,
): Promise<ContentSignature | null> {
  if (!isValidViewport(options.viewport) || !RoomIdSchema.safeParse(options.roomId).success) {
    return null;
  }
  const source = buildElementSource(options.element, options.viewport);
  if (source === null) {
    return null;
  }
  return hashSource(
    `SyncAction/element-signature/v${String(CONTENT_SIGNATURE_VERSION)}\0${options.roomId}\0`,
    source,
    options.subtle,
  );
}

export function buildPageCompatibilityReport(
  input: BuildPageCompatibilityReportInput,
): PageCompatibilityReport {
  return PageCompatibilityReportSchema.parse({
    type: "page.compatibility.report",
    protocolVersion: 1,
    logicalTabId: input.logicalTabId,
    contentContext: {
      documentRevision: input.documentRevision,
      canonicalPageIdentity: input.canonicalPageIdentity,
      contentSignature: input.contentSignature,
      media: input.media,
    },
  });
}

function isReadySupportedDocument(document: Document, pageUrl: string): boolean {
  if (
    document.readyState === "loading" ||
    document.documentElement === null ||
    document.body === null
  ) {
    return false;
  }
  try {
    canonicalSharedPageIdentity(pageUrl);
    return true;
  } catch {
    return false;
  }
}

function isValidViewport(viewport: SignatureViewport): boolean {
  return (
    Number.isFinite(viewport.widthCssPx) &&
    viewport.widthCssPx > 0 &&
    Number.isFinite(viewport.heightCssPx) &&
    viewport.heightCssPx > 0
  );
}

function buildPageSource(
  document: Document,
  viewport: SignatureViewport,
): SemanticSignatureSourceV1 {
  const counts = new Map<LandmarkKind, number>();
  const landmarks: SemanticLandmarkV1[] = [];
  for (const element of document.querySelectorAll(LANDMARK_SELECTORS)) {
    const kind = landmarkKind(element);
    if (kind === null || (counts.get(kind) ?? 0) >= MAX_LANDMARKS_PER_KIND) {
      continue;
    }
    const rectangle = quantizedRectangle(element.getBoundingClientRect(), viewport);
    if (rectangle === null) {
      continue;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    landmarks.push({
      kind,
      ...rectangle,
    });
  }
  landmarks.sort(compareLandmarks);
  if (landmarks.length > MAX_LANDMARKS) {
    landmarks.length = MAX_LANDMARKS;
  }
  return {
    v: 1,
    viewport: {
      widthBucket: viewportBucket(viewport.widthCssPx),
      heightBucket: viewportBucket(viewport.heightCssPx),
    },
    landmarks,
    headingCountBuckets: ["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) =>
      countBucket(document.querySelectorAll(selector).length),
    ),
    interactiveCountBucket: countBucket(document.querySelectorAll(INTERACTIVE_SELECTORS).length),
  };
}

function buildElementSource(
  element: Element,
  viewport: SignatureViewport,
): ElementSignatureSourceV1 | null {
  const tag = element.localName.toLowerCase();
  const role = stableRole(element);
  if (!STABLE_ELEMENT_TAGS.has(tag) && role === null) {
    return null;
  }
  const rectangle = quantizedRectangle(element.getBoundingClientRect(), viewport);
  if (rectangle === null) {
    return null;
  }
  const ancestors: Array<{ tag: string; role: string | null }> = [];
  let current = element.parentElement;
  while (current !== null && ancestors.length < MAX_ELEMENT_ANCESTORS) {
    const ancestorTag = current.localName.toLowerCase();
    const ancestorRole = stableRole(current);
    if (STABLE_ELEMENT_TAGS.has(ancestorTag) || ancestorRole !== null) {
      ancestors.push({
        tag: ancestorTag,
        role: ancestorRole,
      });
    }
    current = current.parentElement;
  }
  return {
    v: 1,
    tag,
    role,
    rectangle,
    ancestors,
  };
}

function landmarkKind(element: Element): LandmarkKind | null {
  const tag = element.localName.toLowerCase();
  if (
    tag === "main" ||
    tag === "nav" ||
    tag === "header" ||
    tag === "footer" ||
    tag === "article" ||
    tag === "aside" ||
    tag === "form" ||
    tag === "video" ||
    tag === "audio" ||
    tag === "canvas"
  ) {
    return tag;
  }
  const role = element.getAttribute("role");
  switch (role) {
    case "main":
      return "main";
    case "navigation":
      return "nav";
    case "banner":
      return "header";
    case "contentinfo":
      return "footer";
    case "article":
      return "article";
    case "complementary":
      return "aside";
    default:
      return null;
  }
}

function stableRole(element: Element): string | null {
  const role = element.getAttribute("role");
  return role !== null && STABLE_ROLES.has(role) ? role : null;
}

function quantizedRectangle(
  rectangle: DOMRect,
  viewport: SignatureViewport,
): Omit<SemanticLandmarkV1, "kind"> | null {
  if (
    !Number.isFinite(rectangle.left) ||
    !Number.isFinite(rectangle.top) ||
    !Number.isFinite(rectangle.width) ||
    !Number.isFinite(rectangle.height) ||
    rectangle.width <= 0 ||
    rectangle.height <= 0
  ) {
    return null;
  }
  return {
    xBucket: positionBucket(rectangle.left, viewport.widthCssPx),
    yBucket: positionBucket(rectangle.top, viewport.heightCssPx),
    widthBucket: dimensionBucket(rectangle.width, viewport.widthCssPx),
    heightBucket: dimensionBucket(rectangle.height, viewport.heightCssPx),
  };
}

function viewportBucket(value: number): number {
  return Math.min(MAX_VIEWPORT_BUCKET, Math.max(1, Math.ceil(value / VIEWPORT_BUCKET_CSS_PX)));
}

function positionBucket(value: number, extent: number): number {
  const normalized = Math.min(1, Math.max(0, value / extent));
  return Math.min(LANDMARK_GRID_SIZE - 1, Math.floor(normalized * LANDMARK_GRID_SIZE));
}

function dimensionBucket(value: number, extent: number): number {
  const normalized = Math.min(1, Math.max(0, value / extent));
  return Math.min(LANDMARK_GRID_SIZE, Math.max(1, Math.ceil(normalized * LANDMARK_GRID_SIZE)));
}

function countBucket(count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (count === 1) {
    return 1;
  }
  if (count <= 4) {
    return 2;
  }
  if (count <= 9) {
    return 3;
  }
  return 4;
}

function compareLandmarks(left: SemanticLandmarkV1, right: SemanticLandmarkV1): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.xBucket - right.xBucket ||
    left.yBucket - right.yBucket ||
    left.widthBucket - right.widthBucket ||
    left.heightBucket - right.heightBucket
  );
}

async function hashSource(
  prefix: string,
  source: SemanticSignatureSourceV1 | ElementSignatureSourceV1,
  subtleInput?: SubtleCrypto,
): Promise<ContentSignature | null> {
  const subtle = subtleInput ?? globalThis.crypto?.subtle;
  if (subtle === undefined) {
    return null;
  }
  const bytes = new TextEncoder().encode(`${prefix}${JSON.stringify(source)}`);
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  const binary = String.fromCharCode(...digest);
  const encoded = globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return ContentSignatureSchema.parse({
    signatureVersion: CONTENT_SIGNATURE_VERSION,
    digest: encoded,
  });
}
