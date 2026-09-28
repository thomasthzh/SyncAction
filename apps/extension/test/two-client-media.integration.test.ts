import { createDatabase, migrateToLatest, type Database } from "@syncaction/database";
import { AccountService, createAccessTokenCodec } from "@syncaction/identity";
import {
  MediaTargetSchema,
  RoomSnapshotMessageSchema,
  type ClientOperationEnvelope,
  type MediaCommand,
  type MediaCommandAck,
  type MediaHeartbeat,
  type MediaObservedState,
  type MediaTarget,
} from "@syncaction/protocol";
import { ReplicaRecordSchema, type ReplicaRecord } from "@syncaction/replica";
import { RoomService } from "@syncaction/rooms";
import { buildPublicApp } from "@syncaction/server/app";
import {
  DocumentAuthorizationService,
  RoomMediaGroupService,
  RoomPresenceService,
  RoomSequencer,
} from "@syncaction/sync";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActiveTabPresenceController, type PresenceScheduler } from "../src/active-tab-presence.js";
import type {
  ExtensionCollaborationMemberSummary,
  ExtensionCollaborationPageSummary,
} from "../src/app-controller.js";
import {
  MediaController,
  type MediaNavigationPort,
  type MediaPagePort,
  type MediaScheduler,
} from "../src/media-controller.js";
import {
  MediaObservedMessageSchema,
  type MediaObservedMessage,
  type MediaObservedTrigger,
  type MediaPageApplyAction,
} from "../src/page-collaboration/messages.js";
import { SocketReplicaTransport } from "../src/socket-transport.js";
import { createMediaViewModel } from "../src/ui/media-view-model.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

const initialNowMs = Date.parse("2026-07-28T00:00:00.000Z");
const password = "correct horse battery";
let uuidCounter = 1;
let clock: ControlledClock;
let db: ReturnType<typeof createDatabase>;
let accounts: AccountService;
let rooms: RoomService;
let sequencer: RoomSequencer;
let app: Awaited<ReturnType<typeof buildPublicApp>> | undefined;
let baseUrl = "";
const liveClients = new Set<MediaClient>();
const serverConnections = new Set<{ destroy(): void }>();

beforeAll(async () => {
  clock = new ControlledClock(initialNowMs);
  db = createDatabase(connectionString);
  await migrateToLatest(db);
  accounts = new AccountService({
    db,
    accessTokens: createAccessTokenCodec({
      issuer: "syncaction",
      audience: "syncaction-extension",
      secret: new Uint8Array(32).fill(61),
      now: () => new Date(clock.now),
    }),
    now: () => new Date(clock.now),
  });
  rooms = new RoomService({ db, now: () => new Date(clock.now) });
  sequencer = new RoomSequencer({ db, now: () => new Date(clock.now) });
  await startServer();
});

afterAll(async () => {
  await cleanupClients();
  await stopServer();
  await db.destroy();
});

beforeEach(async () => {
  await cleanupClients();
  clock = new ControlledClock(initialNowMs);
  uuidCounter = 1;
  if (app === undefined) {
    await startServer();
  }
  await db.deleteFrom("rooms").execute();
  await db.deleteFrom("users").execute();
});

describe("multi-client media collaboration through the live public server", () => {
  it("keeps media ephemeral while coordinating controls, proposals, recommendation, grace, and restart", async () => {
    const owner = await activeSession("media-e2e-owner");
    const firstFollower = await activeSession("media-e2e-follower-a");
    const secondFollower = await activeSession("media-e2e-follower-b");
    const room = await rooms.createRoom({
      actorUserId: owner.account.id,
      name: "Media E2E",
    });
    for (const follower of [firstFollower, secondFollower]) {
      const invitation = await rooms.inviteByUsername({
        actorUserId: owner.account.id,
        roomId: room.id,
        username: follower.account.username,
      });
      await rooms.acceptInvitation({
        actorUserId: follower.account.id,
        invitationId: invitation.id,
      });
    }

    const firstLogicalTabId = nextUuid();
    const secondLogicalTabId = nextUuid();
    await commitTab(owner, room.id, firstLogicalTabId, null, 0, {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "发布会回放",
    });
    await commitTab(owner, room.id, secondLogicalTabId, firstLogicalTabId, 1, {
      url: "https://www.bilibili.com/video/BV17x411w7KC",
      title: "教学视频",
    });
    const roomSnapshot = await currentSnapshot(owner, room.id);
    const firstTarget = MediaTargetSchema.parse({
      logicalTabId: firstLogicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 1 },
      frameKey: "top",
      provider: "YOUTUBE",
      mediaKey: "youtube:dQw4w9WgXcQ",
      durationMs: 120_000,
    });
    const secondTarget = MediaTargetSchema.parse({
      logicalTabId: secondLogicalTabId,
      documentRevision: { roomEpoch: 0, tabUpdatedAtSeq: 2 },
      frameKey: "top",
      provider: "BILIBILI",
      mediaKey: "bilibili:av170001",
      durationMs: 180_000,
    });
    const ownerPage = new SimulatedMediaPage();
    const firstFollowerPage = new SimulatedMediaPage();
    const secondFollowerPage = new SimulatedMediaPage();
    let leader = await connectClient({
      session: owner,
      roomId: room.id,
      snapshot: roomSnapshot,
      tabIds: { first: 101, second: 102 },
      activeLogicalTabId: firstLogicalTabId,
      page: ownerPage,
    });
    const followerA = await connectClient({
      session: firstFollower,
      roomId: room.id,
      snapshot: roomSnapshot,
      tabIds: { first: 201, second: 202 },
      activeLogicalTabId: firstLogicalTabId,
      page: firstFollowerPage,
    });
    const followerB = await connectClient({
      session: secondFollower,
      roomId: room.id,
      snapshot: roomSnapshot,
      tabIds: { first: 301, second: 302 },
      activeLogicalTabId: firstLogicalTabId,
      page: secondFollowerPage,
    });
    await waitFor(
      () =>
        [leader, followerA, followerB].every(
          (client) => client.presence.getStatus().presences.length === 3,
        ),
      "three media clients did not become present",
    );
    await Promise.all(
      [leader, followerA, followerB].map((client) => client.media.handleBindingsChanged()),
    );

    const initialState = observedState({
      positionMs: 10_000,
      paused: true,
    });
    await Promise.all(
      [leader, followerA, followerB].map((client) =>
        emitObservation(client, firstTarget, initialState, "DISCOVERED"),
      ),
    );
    const durableBaseline = await durableSnapshot(room.id);

    const createAck = await leader.media.createGroup();
    const playbackGroupId = createAck.playbackGroupId;
    if (playbackGroupId === null) {
      throw new Error("expected playback group id");
    }
    await waitFor(
      () =>
        [leader, followerA, followerB].every(
          (client) => client.media.getStatus().playbackGroups.length === 1,
        ),
      "all clients did not receive the created group",
    );
    await followerA.media.joinGroup(playbackGroupId);
    await waitFor(
      () =>
        leader.media
          .getStatus()
          .playbackGroups[0]?.members.some(
            (member) => member.userId === firstFollower.account.id,
          ) === true,
      "first follower did not join",
    );
    await followerB.media.joinGroup(playbackGroupId);
    await waitFor(
      () =>
        [leader, followerA, followerB].every(
          (client) => client.media.getStatus().playbackGroups[0]?.members.length === 3,
        ),
      "the three-member group did not converge",
    );
    await acknowledgeAllApplies([leader, followerA, followerB]);

    const mediaView = createMediaViewModel({
      media: leader.media.getStatus(),
      pages: pageSummaries(firstLogicalTabId, secondLogicalTabId),
      members: memberSummaries(owner, firstFollower, secondFollower, firstLogicalTabId),
      nowMs: clock.now,
    });
    expect(mediaView.groups).toHaveLength(1);
    expect(mediaView.groups[0]?.members.map((member) => member.role)).toEqual([
      "LEADER",
      "FOLLOWER",
      "FOLLOWER",
    ]);
    expect(mediaView.outsideMembers).toEqual([]);

    const discreteLatenciesMs: number[] = [];
    await publishLeaderControl({
      leader,
      followers: [followerA, followerB],
      target: firstTarget,
      state: observedState({ positionMs: 12_000, paused: false }),
      trigger: "PLAYED",
      expectedAction: "PLAY",
      latencies: discreteLatenciesMs,
    });
    await publishLeaderControl({
      leader,
      followers: [followerA, followerB],
      target: firstTarget,
      state: observedState({ positionMs: 15_000, paused: true }),
      trigger: "PAUSED",
      expectedAction: "PAUSE",
      latencies: discreteLatenciesMs,
    });
    await publishLeaderControl({
      leader,
      followers: [followerA, followerB],
      target: firstTarget,
      state: observedState({ positionMs: 40_000, paused: true }),
      trigger: "SEEKED",
      expectedAction: "SEEK",
      latencies: discreteLatenciesMs,
    });
    expect(percentile95(discreteLatenciesMs)).toBeLessThan(750);

    await followerB.media.leaveGroup(playbackGroupId);
    await waitFor(
      () =>
        followerB.media.getStatus().localMembership === null &&
        followerB.media.getStatus().recommendedPlaybackGroupId === playbackGroupId,
      "ungrouped follower did not receive the group recommendation",
    );
    const alignMark = secondFollowerPage.applies.length;
    await followerB.media.alignOnce(playbackGroupId);
    expect(actionsSince(secondFollowerPage, alignMark)).toContainEqual({
      type: "SEEK",
      positionMs: 40_000,
    });
    expect(followerB.media.getStatus().localMembership).toBeNull();
    await acknowledgeAllApplies([followerB]);
    await followerB.media.joinGroup(playbackGroupId);
    await waitFor(
      () =>
        [leader, followerA, followerB].every(
          (client) =>
            client.media.getStatus().localMembership !== null &&
            client.media.getStatus().playbackGroups[0]?.members.length === 3,
        ),
      "recommended user did not converge after joining",
    );
    await acknowledgeAllApplies([followerB]);

    const followerCorrectionMark = firstFollowerPage.applies.length;
    await emitObservation(
      followerA,
      firstTarget,
      observedState({ positionMs: 70_000, paused: true }),
      "STATE_CHANGED",
      "SEEKED",
    );
    try {
      await waitFor(
        () => leader.media.getStatus().playbackGroups[0]?.proposals.length === 1,
        "follower seek proposal did not reach the leader",
      );
    } catch (cause) {
      throw new Error(
        `follower commands: ${JSON.stringify(
          followerA.transport.commands,
        )}; follower status: ${JSON.stringify(
          followerA.media.getStatus(),
        )}; correction actions: ${JSON.stringify(
          actionsSince(firstFollowerPage, followerCorrectionMark),
        )}`,
        { cause },
      );
    }
    expect(actionsSince(firstFollowerPage, followerCorrectionMark)).toContainEqual({
      type: "SEEK",
      positionMs: 40_000,
    });
    const proposedGroup = leader.media.getStatus().playbackGroups[0]!;
    expect(proposedGroup.observed?.positionMs).toBe(40_000);
    const proposalId = proposedGroup.proposals[0]!.proposalId;
    await acknowledgeAllApplies([followerA]);

    const approvalMarks = new Map(
      [leader, followerA, followerB].map((client) => [client, client.page.applies.length]),
    );
    const approvalStartedAt = Date.now();
    await leader.media.decide(playbackGroupId, proposalId, "APPROVE");
    await waitFor(
      () =>
        [leader, followerA, followerB].every((client) =>
          actionsSince(client.page, approvalMarks.get(client) ?? 0).some(
            (action) => action.type === "SEEK" && action.positionMs === 70_000,
          ),
        ),
      "approved seek did not reach every page runtime",
    );
    discreteLatenciesMs.push(Date.now() - approvalStartedAt);
    expect(percentile95(discreteLatenciesMs)).toBeLessThan(750);
    await acknowledgeAllApplies([leader, followerA, followerB]);

    await emitObservation(
      leader,
      firstTarget,
      observedState({
        positionMs: firstTarget.durationMs,
        paused: true,
        ended: true,
      }),
      "STATE_CHANGED",
      "ENDED",
    );
    await flushLeaderHeartbeat(leader);
    await waitFor(
      () => leader.media.getStatus().playbackGroups[0]?.status === "ENDED_WAITING",
      "ended media did not retain the group in waiting state",
    );
    expect(leader.media.getStatus().playbackGroups[0]?.playbackGroupId).toBe(playbackGroupId);

    const secondState = observedState({ positionMs: 5_000, paused: false });
    await activateLogicalTab(leader, secondLogicalTabId);
    await emitObservation(leader, secondTarget, secondState, "DISCOVERED");
    await leader.media.switchTarget(playbackGroupId, secondTarget, secondState);
    await waitFor(
      () =>
        [leader, followerA, followerB].every(
          (client) =>
            client.media.getStatus().playbackGroups[0]?.target?.mediaKey === secondTarget.mediaKey,
        ),
      "leader target switch did not converge",
    );
    for (const follower of [followerA, followerB]) {
      expect(follower.navigation.activated).toContain(
        follower.tabIdByLogicalId.get(secondLogicalTabId),
      );
      await activateLogicalTab(follower, secondLogicalTabId);
      await emitObservation(follower, secondTarget, secondState, "DISCOVERED");
    }
    await acknowledgeAllApplies([leader, followerA, followerB]);

    const leaderSession = leader.session;
    const leaderRecord = leader.record;
    const leaderTabIds = { first: 101, second: 102 };
    await disconnectClient(leader);
    await waitFor(
      () =>
        [followerA, followerB].every(
          (client) => client.media.getStatus().playbackGroups[0]?.status === "LEADER_GRACE",
        ),
      "followers did not enter leader grace",
    );
    clock.advanceBy(9_000);
    leader = await connectClient({
      session: leaderSession,
      roomId: room.id,
      snapshot: roomSnapshot,
      record: leaderRecord,
      tabIds: leaderTabIds,
      activeLogicalTabId: secondLogicalTabId,
      page: ownerPage,
    });
    await waitFor(
      () =>
        [leader, followerA, followerB].every(
          (client) =>
            client.media.getStatus().playbackGroups[0]?.status !== "LEADER_GRACE" &&
            client.media.getStatus().playbackGroups.length === 1,
        ),
      "leader did not recover within grace",
    );
    await emitObservation(leader, secondTarget, secondState, "DISCOVERED");
    await acknowledgeAllApplies([leader, followerA, followerB]);

    const expirationMarks = new Map(
      [followerA, followerB].map((client) => [client, client.page.applies.length]),
    );
    await disconnectClient(leader);
    await waitFor(
      () => followerA.media.getStatus().playbackGroups[0]?.status === "LEADER_GRACE",
      "second grace window did not begin",
    );
    clock.advanceBy(10_001);
    await waitFor(
      () =>
        followerA.media.getStatus().playbackGroups.length === 0 &&
        followerB.media.getStatus().playbackGroups.length === 0,
      "expired leader grace did not close the group",
      3_000,
    );
    for (const follower of [followerA, followerB]) {
      expect(
        actionsSince(follower.page, expirationMarks.get(follower) ?? 0).some(
          (action) => action.type === "PAUSE",
        ),
      ).toBe(true);
    }
    await acknowledgeAllApplies([followerA, followerB]);

    const restartState = observedState({ positionMs: 22_000, paused: false });
    await emitObservation(followerA, secondTarget, restartState, "DISCOVERED");
    const restartGroupAck = await followerA.media.createGroup();
    await waitFor(
      () => followerA.media.getStatus().playbackGroups.length === 1,
      "pre-restart group was not created",
    );
    expect(restartGroupAck.playbackGroupId).not.toBeNull();
    await expect(durableSnapshot(room.id)).resolves.toEqual(durableBaseline);

    await stopServer();
    await cleanupClients();
    await startServer();
    const afterRestart = await connectClient({
      session: firstFollower,
      roomId: room.id,
      snapshot: roomSnapshot,
      record: followerA.record,
      tabIds: { first: 201, second: 202 },
      activeLogicalTabId: secondLogicalTabId,
      page: firstFollowerPage,
    });
    expect(afterRestart.media.getStatus()).toMatchObject({
      roomMediaRevision: 0,
      playbackGroups: [],
      localMembership: null,
    });
    await expect(durableSnapshot(room.id)).resolves.toEqual(durableBaseline);
    const durableRoom = await currentSnapshot(owner, room.id);
    expect(durableRoom).toMatchObject({
      serverSeq: 2,
      order: [firstLogicalTabId, secondLogicalTabId],
    });
    expect(durableRoom.tabs.map((tab) => [tab.id, tab.url])).toEqual([
      [firstLogicalTabId, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      [secondLogicalTabId, "https://www.bilibili.com/video/BV17x411w7KC"],
    ]);
    if (process.env.SYNCACTION_CAPTURE_MEDIA_METRICS === "1") {
      console.info(
        `[media-e2e-metrics] ${JSON.stringify({
          discreteLatenciesMs,
          p95DiscreteLatencyMs: percentile95(discreteLatenciesMs),
        })}`,
      );
    }
  }, 30_000);
});

class ControlledClock implements MediaScheduler, PresenceScheduler {
  public now: number;
  #nextId = 1;
  readonly #tasks = new Map<
    number,
    { callback: () => void; at: number; intervalMs: number | null }
  >();

  public constructor(now: number) {
    this.now = now;
  }

  public setTimeout(callback: () => void, delayMs: number): number {
    return this.#schedule(callback, delayMs, null);
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.#tasks.delete(handle);
    }
  }

  public setInterval(callback: () => void, intervalMs: number): number {
    return this.#schedule(callback, intervalMs, intervalMs);
  }

  public clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }

  public advanceBy(deltaMs: number): void {
    const destination = this.now + deltaMs;
    for (;;) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.at <= destination)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (next === undefined) {
        break;
      }
      const [id, task] = next;
      this.now = task.at;
      if (task.intervalMs === null) {
        this.#tasks.delete(id);
      } else {
        task.at += task.intervalMs;
      }
      task.callback();
    }
    this.now = destination;
  }

  #schedule(callback: () => void, delayMs: number, intervalMs: number | null): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, {
      callback,
      at: this.now + delayMs,
      intervalMs,
    });
    return id;
  }
}

interface SimulatedPageApply {
  readonly tabId: number;
  readonly frameId: number;
  readonly context: MediaObservedMessage["context"];
  readonly target: MediaTarget;
  readonly action: MediaPageApplyAction;
  readonly applyToken: string;
  readonly observedAfter: MediaObservedState;
}

class SimulatedMediaPage implements MediaPagePort {
  public readonly observations: Array<{
    tabId: number;
    frameId: number;
    target?: MediaTarget;
  }> = [];
  public readonly applies: SimulatedPageApply[] = [];
  public readonly locks: Array<{ target: MediaTarget; locked: boolean }> = [];
  readonly #states = new Map<string, MediaObservedState>();

  public async observe(
    tabId: number,
    frameId: number,
    _context: MediaObservedMessage["context"],
    target?: MediaTarget,
  ): Promise<void> {
    this.observations.push({
      tabId,
      frameId,
      ...(target === undefined ? {} : { target: structuredClone(target) }),
    });
  }

  public async apply(
    tabId: number,
    frameId: number,
    context: MediaObservedMessage["context"],
    target: MediaTarget,
    action: MediaPageApplyAction,
    applyToken: string,
  ): Promise<void> {
    const current =
      this.#states.get(target.mediaKey) ??
      observedState({
        positionMs: 0,
        paused: true,
      });
    const observedAfter = applyPageAction(current, action, target);
    this.#states.set(target.mediaKey, observedAfter);
    this.applies.push({
      tabId,
      frameId,
      context: structuredClone(context),
      target: structuredClone(target),
      action: structuredClone(action),
      applyToken,
      observedAfter,
    });
  }

  public async setFollowerLock(
    _tabId: number,
    _frameId: number,
    _context: MediaObservedMessage["context"],
    target: MediaTarget,
    locked: boolean,
  ): Promise<void> {
    this.locks.push({ target: structuredClone(target), locked });
  }

  public setObserved(target: MediaTarget, observed: MediaObservedState): void {
    this.#states.set(target.mediaKey, structuredClone(observed));
  }
}

class SimulatedNavigation implements MediaNavigationPort {
  public readonly activated: number[] = [];

  public async activateTab(tabId: number): Promise<void> {
    this.activated.push(tabId);
  }
}

interface MediaClient {
  readonly session: ActiveSession;
  readonly roomId: string;
  readonly record: ReplicaRecord;
  readonly transport: RecordingSocketTransport;
  readonly presence: ActiveTabPresenceController;
  readonly media: MediaController;
  readonly page: SimulatedMediaPage;
  readonly navigation: SimulatedNavigation;
  readonly tabIdByLogicalId: ReadonlyMap<string, number>;
  acknowledgedApplyCount: number;
  activeLogicalTabId: string;
}

type ActiveSession = Awaited<ReturnType<typeof activeSession>>;

class RecordingSocketTransport extends SocketReplicaTransport {
  public readonly commands: MediaCommand[] = [];
  public readonly heartbeats: MediaHeartbeat[] = [];

  public override async sendMediaCommand(command: MediaCommand): Promise<MediaCommandAck> {
    this.commands.push(structuredClone(command));
    return super.sendMediaCommand(command);
  }

  public override publishMediaHeartbeat(heartbeat: MediaHeartbeat): void {
    this.heartbeats.push(structuredClone(heartbeat));
    super.publishMediaHeartbeat(heartbeat);
  }
}

async function startServer(): Promise<void> {
  if (app !== undefined) {
    throw new Error("public server is already running");
  }
  const presence = new RoomPresenceService({
    db,
    now: () => new Date(clock.now),
  });
  const media = new RoomMediaGroupService({
    authorization: new DocumentAuthorizationService({ db, presence }),
    now: () => clock.now,
  });
  app = await buildPublicApp({
    db,
    accounts,
    rooms,
    sequencer,
    annotationHmacKey: new Uint8Array(32).fill(23),
    presence,
    media,
    operationRateLimitMax: 1_000,
    presenceSweepIntervalMs: 1_000,
    logger: false,
  });
  app.server.on("connection", (connection) => {
    serverConnections.add(connection);
    connection.once("close", () => serverConnections.delete(connection));
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an ephemeral TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
  const running = app;
  app = undefined;
  if (running !== undefined) {
    for (const connection of serverConnections) {
      connection.destroy();
    }
    serverConnections.clear();
    await running.close();
  }
}

async function activeSession(username: string) {
  const account = await accounts.register({
    username,
    displayName: username,
    password,
  });
  await db.updateTable("users").set({ status: "ACTIVE" }).where("id", "=", account.id).execute();
  const deviceId = nextUuid();
  const session = await accounts.login({
    username,
    password,
    deviceId,
  });
  return {
    account,
    deviceId,
    accessToken: session.accessToken,
    principal: await accounts.authenticateAccessToken(session.accessToken),
  };
}

async function connectClient(input: {
  session: ActiveSession;
  roomId: string;
  snapshot: ReturnType<typeof RoomSnapshotMessageSchema.parse>["state"];
  record?: ReplicaRecord;
  tabIds: { first: number; second: number };
  activeLogicalTabId: string;
  page: SimulatedMediaPage;
}): Promise<MediaClient> {
  const browserSessionId = nextUuid();
  const record =
    input.record ??
    replicaRecord(input.snapshot, browserSessionId, [
      [input.snapshot.order[0]!, input.tabIds.first],
      [input.snapshot.order[1]!, input.tabIds.second],
    ]);
  const transport = new RecordingSocketTransport({
    serverUrl: baseUrl,
    accessToken: input.session.accessToken,
    clientVersion: "0.9.0",
    ackTimeoutMs: 3_000,
  });
  const presence = new ActiveTabPresenceController({
    roomId: input.roomId,
    browserSessionId: record.bindings[0]!.browserSessionId,
    userId: input.session.account.id,
    deviceId: input.session.deviceId,
    replica: { getRecord: async () => structuredClone(record) },
    transport,
    scheduler: clock,
    now: () => clock.now,
    requestRoomSync: async () => {
      const confirmed = record.confirmedSnapshot;
      await transport.synchronize({
        protocolVersion: 1,
        roomId: input.roomId as ClientOperationEnvelope["roomId"],
        roomEpoch: confirmed?.roomEpoch ?? 0,
        lastServerSeq: confirmed?.serverSeq ?? 0,
        hasConfirmedSnapshot: confirmed !== null,
      });
    },
  });
  const navigation = new SimulatedNavigation();
  const media = new MediaController({
    roomId: input.roomId,
    userId: input.session.account.id,
    deviceId: input.session.deviceId,
    browserSessionId: record.bindings[0]!.browserSessionId,
    replica: { getRecord: async () => structuredClone(record) },
    presence,
    page: input.page,
    transport,
    navigation,
    scheduler: clock,
    now: () => clock.now,
    createUuid: nextUuid,
  });
  const client: MediaClient = {
    session: input.session,
    roomId: input.roomId,
    record,
    transport,
    presence,
    media,
    page: input.page,
    navigation,
    tabIdByLogicalId: new Map(
      record.bindings.map((binding) => [binding.logicalTabId, binding.tabId]),
    ),
    acknowledgedApplyCount: input.page.applies.length,
    activeLogicalTabId: input.activeLogicalTabId,
  };
  liveClients.add(client);
  await transport.connect({
    onCommitted: () => undefined,
    onDisconnect: () => undefined,
    onReconnect: () => undefined,
  });
  const activeTabId = requiredTabId(client, input.activeLogicalTabId);
  await media.handleActiveTabChanged(activeTabId);
  await media.setSynchronized(true);
  await transport.synchronize({
    protocolVersion: 1,
    roomId: input.roomId as ClientOperationEnvelope["roomId"],
    roomEpoch: input.snapshot.roomEpoch,
    lastServerSeq: input.snapshot.serverSeq,
    hasConfirmedSnapshot: true,
  });
  await waitFor(
    () => media.getStatus().roomMediaRevision !== null,
    "media snapshot did not arrive after synchronization",
  );
  await presence.handleActiveTabChanged(activeTabId);
  await presence.setSynchronized(true);
  await waitFor(
    () => presence.getStatus().lastAckExpiresAt !== null,
    "presence acknowledgement did not arrive",
  );
  await media.handleBindingsChanged();
  return client;
}

function replicaRecord(
  snapshot: ReturnType<typeof RoomSnapshotMessageSchema.parse>["state"],
  browserSessionId: string,
  bindings: ReadonlyArray<readonly [string, number]>,
): ReplicaRecord {
  return ReplicaRecordSchema.parse({
    schemaVersion: 1,
    roomId: snapshot.roomId,
    mode: "SYNCED",
    confirmedSnapshot: snapshot,
    nextOutboxSeq: 1,
    outbox: [],
    pendingConfirmations: [],
    orphanedOutbox: [],
    bindings: bindings.map(([logicalTabId, tabId]) => ({
      logicalTabId,
      tabId,
      windowId: 1,
      groupId: 2,
      browserSessionId,
      validatedAtServerSeq: snapshot.serverSeq,
    })),
    quarantineReason: null,
    updatedAtMs: clock.now,
  });
}

async function commitTab(
  owner: ActiveSession,
  roomId: string,
  logicalTabId: string,
  after: string | null,
  baseServerSeq: number,
  page: { url: string; title: string },
): Promise<void> {
  await sequencer.commitOperation({
    principal: owner.principal,
    envelope: {
      protocolVersion: 1,
      clientOpId: nextUuid(),
      roomId: roomId as ClientOperationEnvelope["roomId"],
      roomEpoch: 0,
      deviceId: owner.deviceId,
      baseServerSeq,
      operation: {
        type: "tab.create",
        logicalTabId,
        url: page.url,
        title: page.title,
        after,
      },
    },
  });
}

async function currentSnapshot(owner: ActiveSession, roomId: string) {
  return RoomSnapshotMessageSchema.parse(
    await sequencer.synchronize({
      principal: owner.principal,
      request: {
        protocolVersion: 1,
        roomId: roomId as ClientOperationEnvelope["roomId"],
        roomEpoch: 0,
        lastServerSeq: 0,
        hasConfirmedSnapshot: false,
      },
    }),
  ).state;
}

async function activateLogicalTab(client: MediaClient, logicalTabId: string): Promise<void> {
  const tabId = requiredTabId(client, logicalTabId);
  client.activeLogicalTabId = logicalTabId;
  await client.media.handleActiveTabChanged(tabId);
  await client.presence.handleActiveTabChanged(tabId);
}

async function emitObservation(
  client: MediaClient,
  target: MediaTarget,
  observed: MediaObservedState,
  event: "DISCOVERED" | "STATE_CHANGED",
  trigger?: MediaObservedTrigger,
): Promise<void> {
  const tabId = requiredTabId(client, target.logicalTabId);
  client.page.setObserved(target, observed);
  await client.media.handleMediaObserved(
    tabId,
    0,
    MediaObservedMessageSchema.parse({
      type: "syncaction.media.observed",
      event,
      context: mediaContext(client.roomId, target),
      target,
      observed,
      applyToken: null,
      ...(event === "STATE_CHANGED" ? { trigger: trigger ?? null } : {}),
      resultCode: null,
    }),
  );
  await client.media.whenIdle();
}

async function acknowledgeAllApplies(clients: readonly MediaClient[]): Promise<void> {
  for (const client of clients) {
    const pending = client.page.applies.slice(client.acknowledgedApplyCount);
    client.acknowledgedApplyCount += pending.length;
    for (const apply of pending) {
      await client.media.handleMediaObserved(
        apply.tabId,
        apply.frameId,
        MediaObservedMessageSchema.parse({
          type: "syncaction.media.observed",
          event: "APPLY_RESULT",
          context: apply.context,
          target: apply.target,
          observed: apply.observedAfter,
          applyToken: apply.applyToken,
          resultCode: null,
        }),
      );
      await client.media.handleMediaObserved(
        apply.tabId,
        apply.frameId,
        MediaObservedMessageSchema.parse({
          type: "syncaction.media.observed",
          event: "STATE_CHANGED",
          context: apply.context,
          target: apply.target,
          observed: apply.observedAfter,
          applyToken: apply.applyToken,
          trigger: triggerForAction(apply.action),
          resultCode: null,
        }),
      );
    }
    await client.media.whenIdle();
  }
}

async function publishLeaderControl(input: {
  leader: MediaClient;
  followers: readonly MediaClient[];
  target: MediaTarget;
  state: MediaObservedState;
  trigger: MediaObservedTrigger;
  expectedAction: MediaPageApplyAction["type"];
  latencies: number[];
}): Promise<void> {
  const marks = new Map(
    input.followers.map((follower) => [follower, follower.page.applies.length]),
  );
  const startedAt = Date.now();
  await emitObservation(input.leader, input.target, input.state, "STATE_CHANGED", input.trigger);
  await flushLeaderHeartbeat(input.leader);
  try {
    await waitFor(
      () =>
        input.followers.every((follower) =>
          actionsSince(follower.page, marks.get(follower) ?? 0).some(
            (action) => action.type === input.expectedAction,
          ),
        ),
      `${input.expectedAction} did not reach both followers`,
    );
  } catch (cause) {
    throw new Error(
      `${input.expectedAction} follower actions: ${JSON.stringify(
        input.followers.map((follower) => actionsSince(follower.page, marks.get(follower) ?? 0)),
      )}; group states: ${JSON.stringify(
        input.followers.map((follower) => follower.media.getStatus().playbackGroups[0]),
      )}; leader status: ${JSON.stringify(
        input.leader.media.getStatus(),
      )}; leader heartbeats: ${JSON.stringify(input.leader.transport.heartbeats)}`,
      { cause },
    );
  }
  input.latencies.push(Date.now() - startedAt);
  await acknowledgeAllApplies([input.leader, ...input.followers]);
}

async function flushLeaderHeartbeat(leader: MediaClient): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  clock.advanceBy(500);
  await leader.media.whenIdle();
}

function applyPageAction(
  current: MediaObservedState,
  action: MediaPageApplyAction,
  target: MediaTarget,
): MediaObservedState {
  const base = {
    ...current,
    observedAtClientMs: clock.now,
    buffering: false,
  };
  switch (action.type) {
    case "PLAY":
      return { ...base, paused: false, ended: false };
    case "PAUSE":
      return { ...base, paused: true };
    case "SEEK":
      return {
        ...base,
        positionMs: Math.min(action.positionMs, target.durationMs),
        ended: false,
      };
    case "SET_RATE":
    case "SET_RATE_TEMPORARY":
      return { ...base, playbackRate: action.playbackRate };
  }
}

function triggerForAction(action: MediaPageApplyAction): MediaObservedTrigger {
  switch (action.type) {
    case "PLAY":
      return "PLAYED";
    case "PAUSE":
      return "PAUSED";
    case "SEEK":
      return "SEEKED";
    case "SET_RATE":
    case "SET_RATE_TEMPORARY":
      return "RATE_CHANGED";
  }
}

function observedState(
  overrides: Partial<MediaObservedState> & Pick<MediaObservedState, "positionMs" | "paused">,
): MediaObservedState {
  return {
    observedAtClientMs: clock.now,
    playbackRate: 1,
    ended: false,
    buffering: false,
    ...overrides,
  };
}

function mediaContext(roomId: string, target: MediaTarget): MediaObservedMessage["context"] {
  return {
    roomId: roomId as MediaObservedMessage["context"]["roomId"],
    logicalTabId: target.logicalTabId,
    documentRevision: target.documentRevision,
    frameKey: target.frameKey,
  };
}

function actionsSince(page: SimulatedMediaPage, index: number): MediaPageApplyAction[] {
  return page.applies.slice(index).map((apply) => apply.action);
}

function requiredTabId(client: MediaClient, logicalTabId: string): number {
  const tabId = client.tabIdByLogicalId.get(logicalTabId);
  if (tabId === undefined) {
    throw new Error(`missing browser binding for ${logicalTabId}`);
  }
  return tabId;
}

async function disconnectClient(client: MediaClient): Promise<void> {
  if (!liveClients.delete(client)) {
    return;
  }
  await client.media.dispose();
  await client.presence.dispose();
  await client.transport.disconnect();
}

async function cleanupClients(): Promise<void> {
  const clients = [...liveClients];
  liveClients.clear();
  for (const client of clients) {
    try {
      await client.media.dispose();
    } catch {
      // Continue integration cleanup after a failed assertion.
    }
    try {
      await client.presence.dispose();
    } catch {
      // Continue integration cleanup after a failed assertion.
    }
    try {
      await client.transport.disconnect();
    } catch {
      // Continue integration cleanup after a stopped server.
    }
  }
}

function pageSummaries(
  firstLogicalTabId: string,
  secondLogicalTabId: string,
): ExtensionCollaborationPageSummary[] {
  return [
    {
      pageId: firstLogicalTabId,
      title: "发布会回放",
      domain: "www.youtube.com",
      state: "OPEN",
    },
    {
      pageId: secondLogicalTabId,
      title: "教学视频",
      domain: "www.bilibili.com",
      state: "OPEN",
    },
  ];
}

function memberSummaries(
  owner: ActiveSession,
  firstFollower: ActiveSession,
  secondFollower: ActiveSession,
  logicalTabId: string,
): ExtensionCollaborationMemberSummary[] {
  return [
    {
      userId: owner.account.id,
      displayName: owner.account.displayName,
      roomRole: "OWNER",
      online: true,
      deviceCount: 1,
      activePageIds: [logicalTabId],
    },
    ...[firstFollower, secondFollower].map((session) => ({
      userId: session.account.id,
      displayName: session.account.displayName,
      roomRole: "MEMBER" as const,
      online: true,
      deviceCount: 1,
      activePageIds: [logicalTabId],
    })),
  ];
}

async function durableSnapshot(roomId: string): Promise<{
  readonly serverSeq: number;
  readonly counts: Readonly<Record<keyof Database, number>>;
  readonly tabs: readonly unknown[];
}> {
  const tableNames = [
    "users",
    "deviceSessions",
    "administrators",
    "serverPolicies",
    "adminSessions",
    "passwordResetGrants",
    "rooms",
    "roomMemberships",
    "roomInvitations",
    "roomTabs",
    "roomOperations",
    "clientOperations",
    "roomSnapshots",
    "auditEvents",
  ] as const satisfies readonly (keyof Database)[];
  const countValues = await Promise.all([
    numericCount(
      db
        .selectFrom("users")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("deviceSessions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("administrators")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("serverPolicies")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("adminSessions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("passwordResetGrants")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("rooms")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("roomMemberships")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("roomInvitations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("roomTabs")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("roomOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("clientOperations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("roomSnapshots")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
    numericCount(
      db
        .selectFrom("auditEvents")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ),
  ]);
  const room = await db
    .selectFrom("rooms")
    .select("serverSeq")
    .where("id", "=", roomId)
    .executeTakeFirstOrThrow();
  const tabs = await db
    .selectFrom("roomTabs")
    .select(["logicalTabId", "url", "title", "createdAtSeq", "updatedAtSeq", "closedAtSeq"])
    .where("roomId", "=", roomId)
    .orderBy("createdAtSeq")
    .execute();
  return {
    serverSeq: room.serverSeq,
    counts: Object.fromEntries(
      tableNames.map((tableName, index) => [tableName, countValues[index]!]),
    ) as Record<keyof Database, number>,
    tabs,
  };
}

async function numericCount(promise: Promise<{ count: number }>): Promise<number> {
  return Number((await promise).count);
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all(
      [...liveClients].flatMap((client) => [client.media.whenIdle(), client.presence.whenIdle()]),
    );
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function nextUuid(): string {
  const suffix = String(uuidCounter).padStart(12, "0");
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${suffix}`;
}
