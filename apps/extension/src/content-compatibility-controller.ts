import {
  CONTENT_SIGNATURE_VERSION,
  CanonicalUuidSchema,
  ContentSignatureSchema,
  DeviceIdSchema,
  LogicalTabIdSchema,
  PageCompatibilityReportSchema,
  RoomIdSchema,
  type ContentCompatibility,
  type ContentSignature,
  type DocumentRevision,
  type MediaIdentity,
  type PageCompatibilityReport,
  type RoomId,
} from "@syncaction/protocol";

export type PositionalCapability =
  | "TAB_LIFECYCLE"
  | "MEMBER_PAGE_PRESENCE"
  | "KNOWN_MEDIA_SYNC"
  | "REMOTE_POINTER"
  | "ROOT_DRAWING"
  | "ELEMENT_DRAWING"
  | "BOTTOM_DANMAKU"
  | "SCROLL_FOLLOW";

export interface CapabilityDecision {
  allowed: boolean;
  compatibility: ContentCompatibility;
  reason: "CONTENT_MISMATCH" | "CONTENT_UNKNOWN" | "MEDIA_MISMATCH" | null;
}

export interface CompatibilityScope {
  roomId: RoomId;
  logicalTabId: ReturnType<typeof LogicalTabIdSchema.parse>;
  documentRevision: DocumentRevision;
  remoteUserId: string;
  remoteDeviceId: ReturnType<typeof DeviceIdSchema.parse>;
}

export interface CompatibilityEvidence {
  localAnchorSignature?: ContentSignature | null;
  remoteAnchorSignature?: ContentSignature | null;
}

export interface CapabilityDecisionInput {
  capability: PositionalCapability;
  scope: CompatibilityScope;
  evidence?: CompatibilityEvidence;
  knownMedia?: MediaIdentity;
}

export interface LocalCompatibilityReportInput {
  roomId: RoomId;
  report: PageCompatibilityReport;
}

export interface RemoteCompatibilityReportInput {
  roomId: RoomId;
  remoteUserId: string;
  remoteDeviceId: ReturnType<typeof DeviceIdSchema.parse>;
  report: PageCompatibilityReport;
}

interface StoredReport {
  roomId: RoomId;
  report: PageCompatibilityReport;
}

interface StoredRemoteReport extends StoredReport {
  remoteUserId: string;
  remoteDeviceId: ReturnType<typeof DeviceIdSchema.parse>;
}

export class ContentCompatibilityController {
  readonly #localReports = new Map<string, StoredReport>();
  readonly #remoteReports = new Map<string, StoredRemoteReport>();

  public upsertLocalReport(input: LocalCompatibilityReportInput): boolean {
    const roomId = RoomIdSchema.parse(input.roomId);
    const report = PageCompatibilityReportSchema.parse(input.report);
    const key = localReportKey(roomId, report.logicalTabId);
    const previous = this.#localReports.get(key);
    if (
      previous !== undefined &&
      compareDocumentRevision(
        report.contentContext.documentRevision,
        previous.report.contentContext.documentRevision,
      ) < 0
    ) {
      return false;
    }
    this.#localReports.set(key, { roomId, report: structuredClone(report) });
    if (
      previous !== undefined &&
      !sameDocumentRevision(
        previous.report.contentContext.documentRevision,
        report.contentContext.documentRevision,
      )
    ) {
      this.#purgeRemoteDocumentRevisions(
        roomId,
        report.logicalTabId,
        report.contentContext.documentRevision,
      );
    }
    return true;
  }

  public upsertRemoteReport(input: RemoteCompatibilityReportInput): boolean {
    const roomId = RoomIdSchema.parse(input.roomId);
    const remoteUserId = CanonicalUuidSchema.parse(input.remoteUserId);
    const remoteDeviceId = DeviceIdSchema.parse(input.remoteDeviceId);
    const report = PageCompatibilityReportSchema.parse(input.report);
    const key = remoteReportKey(roomId, remoteUserId, remoteDeviceId, report.logicalTabId);
    const previous = this.#remoteReports.get(key);
    if (
      previous !== undefined &&
      compareDocumentRevision(
        report.contentContext.documentRevision,
        previous.report.contentContext.documentRevision,
      ) < 0
    ) {
      return false;
    }
    this.#remoteReports.set(key, {
      roomId,
      remoteUserId,
      remoteDeviceId,
      report: structuredClone(report),
    });
    return true;
  }

  public replaceRemoteReports(
    roomIdInput: RoomId,
    reports: readonly RemoteCompatibilityReportInput[],
  ): void {
    const roomId = RoomIdSchema.parse(roomIdInput);
    this.clearRemoteReports(roomId);
    for (const report of reports) {
      if (report.roomId === roomId) {
        this.upsertRemoteReport(report);
      }
    }
  }

  public removeRemoteReport(input: {
    roomId: RoomId;
    remoteUserId: string;
    remoteDeviceId: ReturnType<typeof DeviceIdSchema.parse>;
  }): void {
    const roomId = RoomIdSchema.parse(input.roomId);
    const remoteUserId = CanonicalUuidSchema.parse(input.remoteUserId);
    const remoteDeviceId = DeviceIdSchema.parse(input.remoteDeviceId);
    const prefix = remoteIdentityPrefix(roomId, remoteUserId, remoteDeviceId);
    for (const key of this.#remoteReports.keys()) {
      if (key.startsWith(prefix)) {
        this.#remoteReports.delete(key);
      }
    }
  }

  public clearRemoteReports(roomIdInput: RoomId): void {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const prefix = `${roomId}:`;
    for (const key of this.#remoteReports.keys()) {
      if (key.startsWith(prefix)) {
        this.#remoteReports.delete(key);
      }
    }
  }

  public clearLocalDocument(input: {
    roomId: RoomId;
    logicalTabId: ReturnType<typeof LogicalTabIdSchema.parse>;
  }): void {
    const roomId = RoomIdSchema.parse(input.roomId);
    const logicalTabId = LogicalTabIdSchema.parse(input.logicalTabId);
    this.#localReports.delete(localReportKey(roomId, logicalTabId));
  }

  public clearLocalReports(roomIdInput: RoomId): void {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const prefix = `${roomId}:`;
    for (const key of this.#localReports.keys()) {
      if (key.startsWith(prefix)) {
        this.#localReports.delete(key);
      }
    }
  }

  public clearDocument(input: {
    roomId: RoomId;
    logicalTabId: ReturnType<typeof LogicalTabIdSchema.parse>;
  }): void {
    const roomId = RoomIdSchema.parse(input.roomId);
    const logicalTabId = LogicalTabIdSchema.parse(input.logicalTabId);
    this.clearLocalDocument({ roomId, logicalTabId });
    for (const [key, stored] of this.#remoteReports) {
      if (stored.roomId === roomId && stored.report.logicalTabId === logicalTabId) {
        this.#remoteReports.delete(key);
      }
    }
  }

  public leaveRoom(roomIdInput: RoomId): void {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const prefix = `${roomId}:`;
    for (const key of this.#localReports.keys()) {
      if (key.startsWith(prefix)) {
        this.#localReports.delete(key);
      }
    }
    this.clearRemoteReports(roomId);
  }

  public classify(scope: CompatibilityScope): ContentCompatibility {
    const local = this.#localReports.get(localReportKey(scope.roomId, scope.logicalTabId));
    const remote = this.#remoteReports.get(
      remoteReportKey(scope.roomId, scope.remoteUserId, scope.remoteDeviceId, scope.logicalTabId),
    );
    if (
      local === undefined ||
      remote === undefined ||
      !sameDocumentRevision(local.report.contentContext.documentRevision, scope.documentRevision) ||
      !sameDocumentRevision(remote.report.contentContext.documentRevision, scope.documentRevision)
    ) {
      return "UNKNOWN";
    }
    const localContext = local.report.contentContext;
    const remoteContext = remote.report.contentContext;
    if (localContext.canonicalPageIdentity !== remoteContext.canonicalPageIdentity) {
      return "UNKNOWN";
    }
    const localSignature = localContext.contentSignature;
    const remoteSignature = remoteContext.contentSignature;
    if (
      localSignature === null ||
      remoteSignature === null ||
      localSignature.signatureVersion !== CONTENT_SIGNATURE_VERSION ||
      remoteSignature.signatureVersion !== CONTENT_SIGNATURE_VERSION ||
      localSignature.signatureVersion !== remoteSignature.signatureVersion
    ) {
      return "UNKNOWN";
    }
    return localSignature.digest === remoteSignature.digest ? "EXACT" : "MISMATCH";
  }

  public decide(input: CapabilityDecisionInput): CapabilityDecision {
    const compatibility = this.classify(input.scope);
    if (input.capability === "KNOWN_MEDIA_SYNC") {
      const reports = this.#reportsFor(input.scope);
      if (
        reports === null ||
        reports.local.report.contentContext.media === null ||
        reports.remote.report.contentContext.media === null ||
        reports.local.report.contentContext.media.provider !==
          reports.remote.report.contentContext.media.provider ||
        reports.local.report.contentContext.media.mediaKey !==
          reports.remote.report.contentContext.media.mediaKey ||
        (input.knownMedia !== undefined &&
          (reports.local.report.contentContext.media.provider !== input.knownMedia.provider ||
            reports.local.report.contentContext.media.mediaKey !== input.knownMedia.mediaKey))
      ) {
        return { allowed: false, compatibility, reason: "MEDIA_MISMATCH" };
      }
      return warningDecision(true, compatibility);
    }
    if (input.capability === "TAB_LIFECYCLE" || input.capability === "BOTTOM_DANMAKU") {
      return { allowed: true, compatibility, reason: null };
    }
    if (input.capability === "MEMBER_PAGE_PRESENCE") {
      return warningDecision(true, compatibility);
    }
    if (input.capability === "ELEMENT_DRAWING") {
      if (compatibility === "UNKNOWN") {
        return warningDecision(false, compatibility);
      }
      if (
        !sameCurrentSignature(
          input.evidence?.localAnchorSignature,
          input.evidence?.remoteAnchorSignature,
        )
      ) {
        return {
          allowed: false,
          compatibility,
          reason: "CONTENT_MISMATCH",
        };
      }
      return warningDecision(true, compatibility);
    }
    return warningDecision(compatibility === "EXACT", compatibility);
  }

  #reportsFor(
    scope: CompatibilityScope,
  ): { local: StoredReport; remote: StoredRemoteReport } | null {
    const local = this.#localReports.get(localReportKey(scope.roomId, scope.logicalTabId));
    const remote = this.#remoteReports.get(
      remoteReportKey(scope.roomId, scope.remoteUserId, scope.remoteDeviceId, scope.logicalTabId),
    );
    if (
      local === undefined ||
      remote === undefined ||
      !sameDocumentRevision(local.report.contentContext.documentRevision, scope.documentRevision) ||
      !sameDocumentRevision(remote.report.contentContext.documentRevision, scope.documentRevision)
    ) {
      return null;
    }
    return { local, remote };
  }

  #purgeRemoteDocumentRevisions(
    roomId: RoomId,
    logicalTabId: string,
    documentRevision: DocumentRevision,
  ): void {
    for (const [key, stored] of this.#remoteReports) {
      if (
        stored.roomId === roomId &&
        stored.report.logicalTabId === logicalTabId &&
        !sameDocumentRevision(stored.report.contentContext.documentRevision, documentRevision)
      ) {
        this.#remoteReports.delete(key);
      }
    }
  }
}

function localReportKey(roomId: string, logicalTabId: string): string {
  return `${roomId}:${logicalTabId}`;
}

function remoteIdentityPrefix(roomId: string, userId: string, deviceId: string): string {
  return `${roomId}:${userId}:${deviceId}:`;
}

function remoteReportKey(
  roomId: string,
  userId: string,
  deviceId: string,
  logicalTabId: string,
): string {
  return `${remoteIdentityPrefix(roomId, userId, deviceId)}${logicalTabId}`;
}

function compareDocumentRevision(left: DocumentRevision, right: DocumentRevision): number {
  if (left.roomEpoch !== right.roomEpoch) {
    return left.roomEpoch - right.roomEpoch;
  }
  return left.tabUpdatedAtSeq - right.tabUpdatedAtSeq;
}

function sameDocumentRevision(left: DocumentRevision, right: DocumentRevision): boolean {
  return compareDocumentRevision(left, right) === 0;
}

function sameCurrentSignature(
  left: ContentSignature | null | undefined,
  right: ContentSignature | null | undefined,
): boolean {
  const parsedLeft = ContentSignatureSchema.safeParse(left);
  const parsedRight = ContentSignatureSchema.safeParse(right);
  return (
    parsedLeft.success &&
    parsedRight.success &&
    parsedLeft.data.signatureVersion === CONTENT_SIGNATURE_VERSION &&
    parsedRight.data.signatureVersion === CONTENT_SIGNATURE_VERSION &&
    parsedLeft.data.digest === parsedRight.data.digest
  );
}

function warningDecision(
  allowed: boolean,
  compatibility: ContentCompatibility,
): CapabilityDecision {
  return {
    allowed,
    compatibility,
    reason:
      compatibility === "MISMATCH"
        ? "CONTENT_MISMATCH"
        : compatibility === "UNKNOWN"
          ? "CONTENT_UNKNOWN"
          : null,
  };
}
