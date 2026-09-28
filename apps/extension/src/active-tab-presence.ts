import {
  CanonicalUuidSchema,
  ContentSignatureSchema,
  DeviceIdSchema,
  DocumentRevisionSchema,
  LogicalTabIdSchema,
  MediaTargetSchema,
  PageCompatibilityReportSchema,
  PresenceDeltaMessageSchema,
  PresenceSnapshotMessageSchema,
  PresenceSnapshotV2MessageSchema,
  RoomIdSchema,
  type ContentSignature,
  type DocumentRevision,
  type MediaTarget,
  type PresenceDeltaMessage,
  type PageCompatibilityReport,
  type PresenceRecord,
  type PresenceRecordV2,
} from "@syncaction/protocol";
import type { DurableReplica } from "@syncaction/replica";
import { ContentCompatibilityController } from "./content-compatibility-controller.js";
import type { PresenceTransport } from "./socket-transport.js";

const HEARTBEAT_MS = 10_000;

export interface PresenceScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ActiveTabPresenceStatus {
  state: "OFFLINE" | "ONLINE" | "DEGRADED";
  presences: PresenceRecord[];
  compatibilities?: ActiveTabPresenceCompatibility[] | undefined;
  lastAckExpiresAt: number | null;
  errorCode: string | null;
}

export interface ActiveTabPresenceCompatibility {
  userId: string;
  deviceId: string;
  logicalTabId: string;
  compatibility: "EXACT" | "MISMATCH" | "UNKNOWN";
  warning: boolean;
}

export interface ActiveTabPresenceOptions {
  roomId: unknown;
  browserSessionId: unknown;
  userId: unknown;
  deviceId: unknown;
  replica: Pick<DurableReplica, "getRecord">;
  transport: PresenceTransport;
  requestRoomSync?: () => void | Promise<void>;
  onRemotePresenceChanged?: (logicalTabIds: readonly string[]) => void | Promise<void>;
  now?: () => number;
  scheduler?: PresenceScheduler;
}

export class ActiveTabPresenceController {
  readonly #roomId: ReturnType<typeof RoomIdSchema.parse>;
  readonly #browserSessionId: string;
  readonly #userId: ReturnType<typeof CanonicalUuidSchema.parse>;
  readonly #deviceId: ReturnType<typeof DeviceIdSchema.parse>;
  readonly #replica: Pick<DurableReplica, "getRecord">;
  readonly #transport: PresenceTransport;
  readonly #requestRoomSync: (() => void | Promise<void>) | undefined;
  readonly #onRemotePresenceChanged:
    ((logicalTabIds: readonly string[]) => void | Promise<void>) | undefined;
  readonly #now: () => number;
  readonly #scheduler: PresenceScheduler;
  #synchronized = false;
  #activeTabId: number | undefined;
  #interval: unknown;
  #generation = 0;
  #tail: Promise<void> = Promise.resolve();
  readonly #presences = new Map<string, PresenceRecordV2>();
  readonly #localReports = new Map<string, PageCompatibilityReport>();
  readonly #compatibility = new ContentCompatibilityController();
  #presenceSeq: number | null = null;
  #awaitingV2Snapshot = true;
  #roomSyncRequested = false;
  #lastAckExpiresAt: number | null = null;
  #errorCode: string | null = null;

  public constructor(options: ActiveTabPresenceOptions) {
    this.#roomId = RoomIdSchema.parse(options.roomId);
    if (
      typeof options.browserSessionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        options.browserSessionId,
      )
    ) {
      throw new Error("INVALID_BROWSER_SESSION_ID");
    }
    this.#browserSessionId = options.browserSessionId;
    this.#userId = CanonicalUuidSchema.parse(options.userId);
    this.#deviceId = DeviceIdSchema.parse(options.deviceId);
    this.#replica = options.replica;
    this.#transport = options.transport;
    this.#requestRoomSync = options.requestRoomSync;
    this.#onRemotePresenceChanged = options.onRemotePresenceChanged;
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? {
      setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
    this.#transport.setPresenceHandler((message) => this.handleMessage(message));
  }

  public setSynchronized(synchronized: boolean): Promise<void> {
    if (synchronized === this.#synchronized) {
      return this.whenIdle();
    }
    this.#synchronized = synchronized;
    this.#generation += 1;
    if (!synchronized) {
      this.#stopHeartbeat();
      this.#presences.clear();
      this.#localReports.clear();
      this.#compatibility.leaveRoom(this.#roomId);
      this.#presenceSeq = null;
      this.#awaitingV2Snapshot = true;
      this.#roomSyncRequested = false;
      this.#lastAckExpiresAt = null;
      this.#errorCode = null;
      return this.whenIdle();
    }
    const generation = this.#generation;
    this.#interval = this.#scheduler.setInterval(() => {
      void this.#publish(generation);
    }, HEARTBEAT_MS);
    return this.#publish(generation);
  }

  public handleActiveTabChanged(tabIdInput: unknown): Promise<void> {
    if (typeof tabIdInput !== "number" || !Number.isSafeInteger(tabIdInput) || tabIdInput < 0) {
      return Promise.reject(new Error("INVALID_ACTIVE_TAB_ID"));
    }
    this.#activeTabId = tabIdInput;
    return this.#synchronized ? this.#publish(this.#generation) : this.whenIdle();
  }

  public handleBindingsChanged(): Promise<void> {
    return this.#synchronized ? this.#publish(this.#generation) : this.whenIdle();
  }

  public async handlePageCompatibilityReport(
    tabIdInput: unknown,
    reportInput: unknown,
  ): Promise<boolean> {
    if (typeof tabIdInput !== "number" || !Number.isSafeInteger(tabIdInput) || tabIdInput < 0) {
      throw new Error("INVALID_ACTIVE_TAB_ID");
    }
    const report = PageCompatibilityReportSchema.parse(reportInput);
    let accepted = false;
    await this.#enqueue(async () => {
      if (!this.#synchronized) {
        return;
      }
      const record = await this.#replica.getRecord();
      const snapshot = record.confirmedSnapshot;
      const binding = record.bindings.find(
        (candidate) =>
          candidate.browserSessionId === this.#browserSessionId &&
          candidate.tabId === tabIdInput &&
          candidate.logicalTabId === report.logicalTabId,
      );
      const tab = snapshot?.tabs.find(
        (candidate) => candidate.id === report.logicalTabId && candidate.closedAtSeq === null,
      );
      if (
        record.mode !== "SYNCED" ||
        snapshot === null ||
        binding === undefined ||
        binding.validatedAtServerSeq !== snapshot.serverSeq ||
        tab === undefined ||
        report.contentContext.documentRevision.roomEpoch !== snapshot.roomEpoch ||
        report.contentContext.documentRevision.tabUpdatedAtSeq !== tab.updatedAtSeq
      ) {
        return;
      }
      accepted = this.#compatibility.upsertLocalReport({
        roomId: this.#roomId,
        report,
      });
      if (accepted) {
        this.#localReports.set(report.logicalTabId, structuredClone(report));
      }
    });
    if (accepted && this.#synchronized && tabIdInput === this.#activeTabId) {
      await this.#publish(this.#generation);
    }
    return accepted;
  }

  public async handlePermissionBoundaryChanged(): Promise<void> {
    await this.#enqueue(async () => {
      this.#localReports.clear();
      this.#compatibility.clearLocalReports(this.#roomId);
    });
    if (this.#synchronized) {
      await this.#publish(this.#generation);
    }
  }

  public getLocalContentSignature(context: {
    roomId: string;
    logicalTabId: string;
    documentRevision: { roomEpoch: number; tabUpdatedAtSeq: number };
  }): ContentSignature | null {
    if (context.roomId !== this.#roomId) {
      return null;
    }
    const report = this.#currentReport(
      context.logicalTabId,
      context.documentRevision.roomEpoch,
      context.documentRevision.tabUpdatedAtSeq,
    );
    const signature = report?.contentContext.contentSignature;
    return signature === null || signature === undefined
      ? null
      : structuredClone(ContentSignatureSchema.parse(signature));
  }

  public canRenderRemotePointer(input: {
    logicalTabId: string;
    documentRevision: DocumentRevision;
    remoteUserId: string;
    remoteDeviceId: string;
  }): boolean {
    if (this.#isLocalIdentity(input.remoteUserId, input.remoteDeviceId)) {
      return false;
    }
    return this.#compatibility.decide({
      capability: "REMOTE_POINTER",
      scope: {
        roomId: this.#roomId,
        logicalTabId: LogicalTabIdSchema.parse(input.logicalTabId),
        documentRevision: DocumentRevisionSchema.parse(input.documentRevision),
        remoteUserId: CanonicalUuidSchema.parse(input.remoteUserId),
        remoteDeviceId: DeviceIdSchema.parse(input.remoteDeviceId),
      },
    }).allowed;
  }

  public canSynchronizeKnownMedia(input: {
    target: MediaTarget;
    remoteUserId: string;
    remoteDeviceId: string;
  }): boolean {
    const target = MediaTargetSchema.parse(input.target);
    if (this.#isLocalIdentity(input.remoteUserId, input.remoteDeviceId)) {
      return false;
    }
    return this.#compatibility.decide({
      capability: "KNOWN_MEDIA_SYNC",
      scope: {
        roomId: this.#roomId,
        logicalTabId: target.logicalTabId,
        documentRevision: target.documentRevision,
        remoteUserId: CanonicalUuidSchema.parse(input.remoteUserId),
        remoteDeviceId: DeviceIdSchema.parse(input.remoteDeviceId),
      },
      knownMedia: {
        provider: target.provider,
        mediaKey: target.mediaKey,
      },
    }).allowed;
  }

  public hasCompatibleRemotePointerObserver(input: {
    logicalTabId: string;
    documentRevision: DocumentRevision;
  }): boolean {
    const logicalTabId = LogicalTabIdSchema.parse(input.logicalTabId);
    const documentRevision = DocumentRevisionSchema.parse(input.documentRevision);
    const now = this.#now();
    return [...this.#presences.values()].some(
      (presence) =>
        presence.expiresAt > now &&
        !this.#isLocalIdentity(presence.userId, presence.deviceId) &&
        presence.logicalTabId === logicalTabId &&
        this.#compatibility.decide({
          capability: "REMOTE_POINTER",
          scope: {
            roomId: this.#roomId,
            logicalTabId,
            documentRevision,
            remoteUserId: CanonicalUuidSchema.parse(presence.userId),
            remoteDeviceId: DeviceIdSchema.parse(presence.deviceId),
          },
        }).allowed,
    );
  }

  public handleMessage(messageInput: unknown): void {
    if (!this.#synchronized) {
      return;
    }
    const snapshotV2 = PresenceSnapshotV2MessageSchema.safeParse(messageInput);
    if (snapshotV2.success) {
      if (snapshotV2.data.roomId === this.#roomId) {
        const changedLogicalTabs = this.#remoteLogicalTabIds(snapshotV2.data.presences);
        this.#replacePresences(snapshotV2.data.presences);
        this.#presenceSeq = snapshotV2.data.presenceSeq;
        this.#awaitingV2Snapshot = false;
        this.#roomSyncRequested = false;
        this.#scheduleRemotePresenceChanged(changedLogicalTabs);
      }
      return;
    }
    const delta = PresenceDeltaMessageSchema.safeParse(messageInput);
    if (delta.success) {
      if (delta.data.roomId === this.#roomId) {
        const changedLogicalTabs = this.#remoteLogicalTabIdsFromDelta(delta.data);
        this.#applyDelta(delta.data);
        this.#scheduleRemotePresenceChanged(changedLogicalTabs);
      }
      return;
    }
    const legacySnapshot = PresenceSnapshotMessageSchema.safeParse(messageInput);
    if (!legacySnapshot.success || legacySnapshot.data.roomId !== this.#roomId) {
      return;
    }
    const changedLogicalTabs = this.#remoteLogicalTabIds(
      legacySnapshot.data.presences.map((presence) => ({
        ...presence,
        contentContext: null,
      })),
    );
    this.#replacePresences(
      legacySnapshot.data.presences.map((presence) => ({
        ...presence,
        contentContext: null,
      })),
    );
    this.#presenceSeq = null;
    this.#awaitingV2Snapshot = false;
    this.#roomSyncRequested = false;
    this.#scheduleRemotePresenceChanged(changedLogicalTabs);
  }

  public getStatus(): ActiveTabPresenceStatus {
    const now = this.#now();
    this.#pruneExpired(now);
    return structuredClone({
      state: !this.#synchronized ? "OFFLINE" : this.#errorCode === null ? "ONLINE" : "DEGRADED",
      presences: [...this.#presences.values()].sort(comparePresence).map(toLegacyPresence),
      compatibilities: [...this.#presences.values()]
        .sort(comparePresence)
        .flatMap((presence) => this.#projectCompatibility(presence)),
      lastAckExpiresAt: this.#lastAckExpiresAt,
      errorCode: this.#errorCode,
    });
  }

  public async dispose(): Promise<void> {
    this.#synchronized = false;
    this.#generation += 1;
    this.#stopHeartbeat();
    this.#transport.setPresenceHandler(undefined);
    await this.whenIdle();
    this.#presences.clear();
    this.#localReports.clear();
    this.#compatibility.leaveRoom(this.#roomId);
    this.#presenceSeq = null;
    this.#awaitingV2Snapshot = true;
    this.#roomSyncRequested = false;
    this.#lastAckExpiresAt = null;
  }

  public async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.#tail;
      await observed;
    } while (observed !== this.#tail);
  }

  #publish(generation: number): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#synchronized || generation !== this.#generation) {
        return;
      }
      try {
        const record = await this.#replica.getRecord();
        if (!this.#synchronized || generation !== this.#generation || record.mode !== "SYNCED") {
          return;
        }
        const activeLogicalTabs = new Set(record.confirmedSnapshot?.order ?? []);
        const binding = record.bindings.find(
          (candidate) =>
            candidate.browserSessionId === this.#browserSessionId &&
            candidate.tabId === this.#activeTabId &&
            activeLogicalTabs.has(candidate.logicalTabId),
        );
        const snapshot = record.confirmedSnapshot;
        const tab = snapshot?.tabs.find(
          (candidate) => candidate.id === binding?.logicalTabId && candidate.closedAtSeq === null,
        );
        const report =
          binding === undefined || tab === undefined || snapshot === null
            ? undefined
            : this.#currentReport(binding.logicalTabId, snapshot.roomEpoch, tab.updatedAtSeq);
        const ack = await this.#transport.publishPresence(
          report === undefined
            ? {
                type: "presence.update",
                protocolVersion: 1,
                roomId: this.#roomId,
                logicalTabId: binding?.logicalTabId ?? null,
              }
            : {
                type: "presence.update.v2",
                protocolVersion: 1,
                roomId: this.#roomId,
                logicalTabId: report.logicalTabId,
                contentContext: structuredClone(report.contentContext),
              },
        );
        if (!this.#synchronized || generation !== this.#generation) {
          return;
        }
        this.#lastAckExpiresAt = ack.expiresAt;
        this.#errorCode = null;
      } catch (cause) {
        if (!this.#synchronized || generation !== this.#generation) {
          return;
        }
        this.#errorCode = presenceErrorCode(cause);
      }
    });
  }

  #stopHeartbeat(): void {
    if (this.#interval !== undefined) {
      this.#scheduler.clearInterval(this.#interval);
      this.#interval = undefined;
    }
  }

  #replacePresences(presences: readonly PresenceRecordV2[]): void {
    this.#presences.clear();
    const now = this.#now();
    for (const presence of presences) {
      if (presence.expiresAt > now) {
        this.#presences.set(presenceIdentity(presence.userId, presence.deviceId), presence);
      }
    }
    this.#compatibility.replaceRemoteReports(
      this.#roomId,
      [...this.#presences.values()].flatMap((presence) => {
        if (this.#isLocalIdentity(presence.userId, presence.deviceId)) {
          return [];
        }
        const report = compatibilityReportFromPresence(presence);
        return report === null
          ? []
          : [
              {
                roomId: this.#roomId,
                remoteUserId: presence.userId,
                remoteDeviceId: presence.deviceId,
                report,
              },
            ];
      }),
    );
  }

  #applyDelta(delta: PresenceDeltaMessage): void {
    if (
      this.#awaitingV2Snapshot ||
      this.#presenceSeq === null ||
      delta.fromPresenceSeq !== this.#presenceSeq
    ) {
      this.#requestSnapshotAfterGap();
      return;
    }
    for (const change of delta.changes) {
      if (change.kind === "UPSERT") {
        this.#presences.set(
          presenceIdentity(change.presence.userId, change.presence.deviceId),
          change.presence,
        );
        if (this.#isLocalIdentity(change.presence.userId, change.presence.deviceId)) {
          continue;
        }
        const report = compatibilityReportFromPresence(change.presence);
        if (report === null) {
          this.#compatibility.removeRemoteReport({
            roomId: this.#roomId,
            remoteUserId: change.presence.userId,
            remoteDeviceId: change.presence.deviceId,
          });
        } else {
          this.#compatibility.upsertRemoteReport({
            roomId: this.#roomId,
            remoteUserId: change.presence.userId,
            remoteDeviceId: change.presence.deviceId,
            report,
          });
        }
      } else {
        this.#presences.delete(presenceIdentity(change.userId, change.deviceId));
        if (this.#isLocalIdentity(change.userId, change.deviceId)) {
          continue;
        }
        this.#compatibility.removeRemoteReport({
          roomId: this.#roomId,
          remoteUserId: change.userId,
          remoteDeviceId: change.deviceId,
        });
      }
    }
    this.#presenceSeq = delta.toPresenceSeq;
    this.#pruneExpired(this.#now());
  }

  #requestSnapshotAfterGap(): void {
    this.#awaitingV2Snapshot = true;
    if (this.#roomSyncRequested) {
      return;
    }
    this.#roomSyncRequested = true;
    const requestRoomSync = this.#requestRoomSync;
    if (requestRoomSync === undefined) {
      this.#errorCode = "PRESENCE_SEQUENCE_GAP";
      return;
    }
    const generation = this.#generation;
    void this.#enqueue(async () => {
      try {
        await requestRoomSync();
      } catch (cause) {
        if (this.#synchronized && generation === this.#generation) {
          this.#errorCode = presenceErrorCode(cause);
        }
      }
    });
  }

  #pruneExpired(now: number): void {
    for (const [identity, presence] of this.#presences) {
      if (presence.expiresAt <= now) {
        this.#presences.delete(identity);
        this.#compatibility.removeRemoteReport({
          roomId: this.#roomId,
          remoteUserId: presence.userId,
          remoteDeviceId: presence.deviceId,
        });
      }
    }
  }

  #currentReport(
    logicalTabId: string,
    roomEpoch: number,
    tabUpdatedAtSeq: number,
  ): PageCompatibilityReport | undefined {
    const report = this.#localReports.get(logicalTabId);
    if (
      report !== undefined &&
      report.contentContext.documentRevision.roomEpoch === roomEpoch &&
      report.contentContext.documentRevision.tabUpdatedAtSeq === tabUpdatedAtSeq
    ) {
      return report;
    }
    if (report !== undefined) {
      this.#localReports.delete(logicalTabId);
      this.#compatibility.clearLocalDocument({
        roomId: this.#roomId,
        logicalTabId: report.logicalTabId,
      });
    }
    return undefined;
  }

  #projectCompatibility(presence: PresenceRecordV2): ActiveTabPresenceCompatibility[] {
    if (
      presence.logicalTabId === null ||
      this.#isLocalIdentity(presence.userId, presence.deviceId)
    ) {
      return [];
    }
    const compatibility =
      presence.contentContext === null
        ? "UNKNOWN"
        : this.#compatibility.classify({
            roomId: this.#roomId,
            logicalTabId: presence.logicalTabId,
            documentRevision: presence.contentContext.documentRevision,
            remoteUserId: presence.userId,
            remoteDeviceId: presence.deviceId,
          });
    return [
      {
        userId: presence.userId,
        deviceId: presence.deviceId,
        logicalTabId: presence.logicalTabId,
        compatibility,
        warning: compatibility !== "EXACT",
      },
    ];
  }

  #remoteLogicalTabIds(next: readonly PresenceRecordV2[]): string[] {
    return [
      ...new Set(
        [...this.#presences.values(), ...next].flatMap((presence) =>
          presence.logicalTabId === null ||
          this.#isLocalIdentity(presence.userId, presence.deviceId)
            ? []
            : [presence.logicalTabId],
        ),
      ),
    ].sort();
  }

  #remoteLogicalTabIdsFromDelta(delta: PresenceDeltaMessage): string[] {
    const logicalTabIds = new Set<string>();
    for (const change of delta.changes) {
      const previous =
        change.kind === "UPSERT"
          ? this.#presences.get(presenceIdentity(change.presence.userId, change.presence.deviceId))
          : this.#presences.get(presenceIdentity(change.userId, change.deviceId));
      if (
        previous?.logicalTabId !== null &&
        previous?.logicalTabId !== undefined &&
        !this.#isLocalIdentity(previous.userId, previous.deviceId)
      ) {
        logicalTabIds.add(previous.logicalTabId);
      }
      if (
        change.kind === "UPSERT" &&
        change.presence.logicalTabId !== null &&
        !this.#isLocalIdentity(change.presence.userId, change.presence.deviceId)
      ) {
        logicalTabIds.add(change.presence.logicalTabId);
      }
    }
    return [...logicalTabIds].sort();
  }

  #isLocalIdentity(userId: string, deviceId: string): boolean {
    return userId === this.#userId && deviceId === this.#deviceId;
  }

  #scheduleRemotePresenceChanged(logicalTabIds: readonly string[]): void {
    const listener = this.#onRemotePresenceChanged;
    if (listener === undefined || logicalTabIds.length === 0) {
      return;
    }
    void this.#enqueue(async () => {
      if (this.#synchronized) {
        await listener(logicalTabIds);
      }
    });
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function presenceIdentity(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

function comparePresence(left: PresenceRecordV2, right: PresenceRecordV2): number {
  return left.userId.localeCompare(right.userId) || left.deviceId.localeCompare(right.deviceId);
}

function toLegacyPresence(presence: PresenceRecordV2): PresenceRecord {
  return {
    userId: presence.userId,
    username: presence.username,
    displayName: presence.displayName,
    deviceId: presence.deviceId,
    logicalTabId: presence.logicalTabId,
    expiresAt: presence.expiresAt,
  };
}

function compatibilityReportFromPresence(
  presence: PresenceRecordV2,
): PageCompatibilityReport | null {
  if (presence.logicalTabId === null || presence.contentContext === null) {
    return null;
  }
  return PageCompatibilityReportSchema.parse({
    type: "page.compatibility.report",
    protocolVersion: 1,
    logicalTabId: presence.logicalTabId,
    contentContext: presence.contentContext,
  });
}

function presenceErrorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code;
  }
  return cause instanceof Error ? cause.message : "PRESENCE_FAILURE";
}
