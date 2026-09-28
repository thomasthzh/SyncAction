import {
  CanonicalUuidSchema,
  DirectoryUserSchema,
  DeviceIdSchema,
  NotificationAfterCursorSchema,
  NotificationCursorSchema,
  NotificationSchema,
  PublicRoomMemberSchema,
  PublicRoomSummarySchema,
  RoomIdSchema,
  RoomJoinDecisionInputSchema,
  RoomJoinPolicySchema,
  RoomJoinRequestSchema,
  RoomRevisionSchema,
  RoomVisibilitySchema,
  ServerMetaSchema,
  type Notification,
  type RoomJoinPolicy,
  type RoomJoinRequest,
  type RoomVisibility,
  type ServerMeta,
} from "@syncaction/protocol";
import { z } from "zod";
import { parsePublicServerOrigin } from "./server-origin.js";

const DateTimeSchema = z.string().datetime({ offset: true });
const UserIdSchema = CanonicalUuidSchema;
const SessionIdSchema = CanonicalUuidSchema;
const InvitationIdSchema = CanonicalUuidSchema;
const AccessTokenSchema = z.string().min(1).max(8_192);
const RefreshTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const ActivationKeySchema = z.string().regex(/^sak_[A-Za-z0-9_-]{43}$/u);
const HealthResponseSchema = z.object({ status: z.literal("ok") }).strict();
const ListCursorSchema = z.string().min(1).max(1_024);
const RoomNameSchema = z.string().min(1).max(120);
const ProductQuerySchema = z.string().max(200);
const PublicListLimitSchema = z.number().int().min(1).max(50).safe();
const NotificationListLimitSchema = z.number().int().min(1).max(100).safe();

export const PublicAccountSchema = z
  .object({
    id: UserIdSchema,
    username: z.string().min(1).max(32),
    displayName: z.string().min(1).max(64),
    status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"]),
    passwordResetRequired: z.boolean(),
    createdAt: DateTimeSchema,
  })
  .strict();

export const PublicSessionResponseSchema = z
  .object({
    sessionId: SessionIdSchema,
    accessToken: AccessTokenSchema,
    refreshToken: RefreshTokenSchema,
    expiresInSeconds: z.number().int().positive().safe(),
    refreshExpiresInSeconds: z.number().int().positive().safe(),
    account: PublicAccountSchema,
  })
  .strict()
  .refine((session) => session.account.status === "ACTIVE", {
    message: "A public session must belong to an active account",
    path: ["account", "status"],
  });

export const PublicRoomSchema = z
  .object({
    id: RoomIdSchema,
    name: RoomNameSchema,
    role: z.enum(["OWNER", "MEMBER"]),
    roomEpoch: z.number().int().nonnegative().safe(),
    visibility: RoomVisibilitySchema,
    joinPolicy: RoomJoinPolicySchema,
    roomRevision: RoomRevisionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  })
  .strict();

export const PublicPendingInvitationSchema = z
  .object({
    id: InvitationIdSchema,
    invitedUserId: UserIdSchema,
    username: z.string().min(1).max(32),
    displayName: z.string().min(1).max(64),
    status: z.literal("PENDING"),
    expiresAt: DateTimeSchema,
    createdAt: DateTimeSchema,
  })
  .strict();

export const PublicRoomDetailSchema = PublicRoomSchema.extend({
  members: z.array(PublicRoomMemberSchema),
  pendingInvitations: z.array(PublicPendingInvitationSchema).nullable(),
}).strict();

export const PublicReceivedInvitationSchema = z
  .object({
    id: InvitationIdSchema,
    roomId: RoomIdSchema,
    roomName: z.string().min(1).max(120),
    invitedByUserId: UserIdSchema,
    invitedByUsername: z.string().min(1).max(32),
    expiresAt: DateTimeSchema,
    createdAt: DateTimeSchema,
  })
  .strict();

const PublicRoomInvitationSchema = z
  .object({
    id: InvitationIdSchema,
    roomId: RoomIdSchema,
    invitedUserId: UserIdSchema,
    invitedByUserId: UserIdSchema,
    status: z.literal("PENDING"),
    expiresAt: DateTimeSchema,
    createdAt: DateTimeSchema,
  })
  .strict();

const RegistrationResponseSchema = z
  .object({
    account: PublicAccountSchema,
  })
  .strict();
const RoomListResponseSchema = z.object({ rooms: z.array(PublicRoomSchema) }).strict();
const PublicRoomListSchema = z
  .object({
    items: z.array(PublicRoomSummarySchema),
    nextCursor: ListCursorSchema.nullable(),
  })
  .strict();
const DirectoryListSchema = z
  .object({
    items: z.array(DirectoryUserSchema),
    nextCursor: ListCursorSchema.nullable(),
  })
  .strict();
const BatchInvitationResultSchema = z
  .object({
    userId: CanonicalUuidSchema,
    status: z.enum(["CREATED", "ALREADY_MEMBER", "ALREADY_PENDING", "NOT_FOUND", "FORBIDDEN"]),
    invitationId: CanonicalUuidSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.status === "CREATED") !== (result.invitationId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["invitationId"],
        message: "created batch invitation requires exactly one invitation id",
      });
    }
  });
const BatchInvitationResponseSchema = z.array(BatchInvitationResultSchema).min(1).max(20);
const NotificationListSchema = z
  .object({
    items: z.array(NotificationSchema),
    nextCursor: NotificationCursorSchema.nullable(),
    unreadCount: z.number().int().nonnegative().safe(),
  })
  .strict();
const NotificationReadThroughSchema = z
  .object({
    readAt: DateTimeSchema,
    throughCursor: NotificationCursorSchema,
  })
  .strict();
const PolicyAcceptanceSchema = z
  .object({
    termsVersion: z.string().min(1).max(64),
    accepted: z.boolean(),
  })
  .strict();
const PublicRoomListInputSchema = z
  .object({
    query: ProductQuerySchema,
    cursor: ListCursorSchema.nullable(),
    limit: PublicListLimitSchema,
  })
  .strict();
const DirectorySearchInputSchema = PublicRoomListInputSchema.extend({
  roomId: RoomIdSchema,
}).strict();
const NotificationListInputSchema = z
  .object({
    after: NotificationAfterCursorSchema,
    limit: NotificationListLimitSchema,
  })
  .strict();
const RoomMutationInputSchema = z
  .object({
    name: RoomNameSchema,
    visibility: RoomVisibilitySchema,
    joinPolicy: RoomJoinPolicySchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.visibility === "PRIVATE" && input.joinPolicy !== "INVITE_ONLY") {
      context.addIssue({
        code: "custom",
        path: ["joinPolicy"],
        message: "private rooms must be invite-only",
      });
    }
  });
const PolicyAcceptanceInputSchema = z
  .object({
    termsVersion: z.string().min(1).max(64),
    clientVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  })
  .strict();
const BatchUserIdsSchema = z
  .array(CanonicalUuidSchema)
  .min(1)
  .max(20)
  .superRefine((userIds, context) => {
    if (new Set(userIds).size !== userIds.length) {
      context.addIssue({
        code: "custom",
        message: "batch user ids must be unique",
      });
    }
  });
const InvitationListResponseSchema = z
  .object({ invitations: z.array(PublicReceivedInvitationSchema) })
  .strict();
const ApiErrorResponseSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
  })
  .strict();

export type PublicAccount = z.infer<typeof PublicAccountSchema>;
export type PublicSessionResponse = z.infer<typeof PublicSessionResponseSchema>;
export type PublicRoom = z.infer<typeof PublicRoomSchema>;
export type PublicRoomDetail = z.infer<typeof PublicRoomDetailSchema>;
export type PublicReceivedInvitation = z.infer<typeof PublicReceivedInvitationSchema>;
export type PublicRoomInvitation = z.infer<typeof PublicRoomInvitationSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type PublicRoomList = z.infer<typeof PublicRoomListSchema>;
export type DirectoryList = z.infer<typeof DirectoryListSchema>;
export type BatchInvitationResult = z.infer<typeof BatchInvitationResultSchema>;
export type NotificationList = z.infer<typeof NotificationListSchema>;
export type NotificationReadThrough = z.infer<typeof NotificationReadThroughSchema>;
export type PolicyAcceptance = z.infer<typeof PolicyAcceptanceSchema>;

export interface PublicRoomListInput {
  query: string;
  cursor: string | null;
  limit: number;
}

export interface DirectorySearchInput extends PublicRoomListInput {
  roomId: string;
}

export interface NotificationListInput {
  after: number;
  limit: number;
}

export interface RoomMutationInput {
  name: string;
  visibility: RoomVisibility;
  joinPolicy: RoomJoinPolicy;
}

export interface PolicyAcceptanceInput {
  termsVersion: string;
  clientVersion: string;
}

export type SyncActionApiErrorCode =
  "NETWORK_ERROR" | "INVALID_RESPONSE" | "CROSS_ORIGIN_REDIRECT" | (string & {});

export class SyncActionApiError extends Error {
  public readonly code: SyncActionApiErrorCode;
  public readonly status: number;
  public readonly requestId: string | undefined;

  public constructor(
    code: SyncActionApiErrorCode,
    status: number,
    options: ErrorOptions & { requestId?: string } = {},
  ) {
    super(code, options);
    this.name = "SyncActionApiError";
    this.code = code;
    this.status = status;
    this.requestId = options.requestId;
  }

  public toJSON(): { code: SyncActionApiErrorCode; status: number; requestId?: string } {
    return {
      code: this.code,
      status: this.status,
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
    };
  }
}

export interface SyncActionApiClientOptions {
  serverUrl: unknown;
  fetch?: typeof globalThis.fetch;
}

interface RequestOptions<T> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  schema?: z.ZodType<T>;
  accessToken?: string;
  body?: unknown;
  timeoutMs?: number;
}

export class SyncActionApiClient {
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;

  public constructor(options: SyncActionApiClientOptions) {
    try {
      this.#origin = parsePublicServerOrigin(options.serverUrl);
    } catch (cause) {
      throw new SyncActionApiError("INVALID_SERVER_URL", 0, { cause });
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async register(input: {
    username: string;
    displayName: string;
    password: string;
  }): Promise<PublicAccount> {
    const response = await this.#request("/v1/auth/register", {
      method: "POST",
      body: input,
      schema: RegistrationResponseSchema,
    });
    return response.account;
  }

  public activateAccount(input: {
    activationKey: string;
    username: string;
    displayName: string;
    password: string;
    deviceId: unknown;
  }): Promise<PublicSessionResponse> {
    return this.#request("/v1/auth/activation/complete", {
      method: "POST",
      body: {
        activationKey: ActivationKeySchema.parse(input.activationKey),
        username: input.username,
        displayName: input.displayName,
        password: input.password,
        deviceId: DeviceIdSchema.parse(input.deviceId),
      },
      schema: PublicSessionResponseSchema,
    });
  }

  public loginWithAccountKey(input: {
    activationKey: string;
    deviceId: unknown;
  }): Promise<PublicSessionResponse> {
    return this.#request("/v1/auth/key-login", {
      method: "POST",
      body: {
        activationKey: ActivationKeySchema.parse(input.activationKey),
        deviceId: DeviceIdSchema.parse(input.deviceId),
      },
      schema: PublicSessionResponseSchema,
    });
  }

  public getMeta(): Promise<ServerMeta> {
    return this.#request("/v1/meta", {
      method: "GET",
      schema: ServerMetaSchema,
    });
  }

  public getHealth(): Promise<HealthResponse> {
    return this.#request("/healthz", {
      method: "GET",
      schema: HealthResponseSchema,
      timeoutMs: 8_000,
    });
  }

  public listPublicRooms(input: PublicRoomListInput): Promise<PublicRoomList> {
    const parsed = PublicRoomListInputSchema.parse(input);
    return this.#request(
      withSearchParams("/v1/public-rooms", [
        ["query", parsed.query],
        ["cursor", parsed.cursor],
        ["limit", parsed.limit],
      ]),
      {
        method: "GET",
        schema: PublicRoomListSchema,
      },
    );
  }

  public login(input: {
    username: string;
    password: string;
    deviceId: unknown;
  }): Promise<PublicSessionResponse> {
    return this.#request("/v1/auth/login", {
      method: "POST",
      body: {
        username: input.username,
        password: input.password,
        deviceId: DeviceIdSchema.parse(input.deviceId),
      },
      schema: PublicSessionResponseSchema,
    });
  }

  public updateProfile(
    accessToken: string,
    input: { username: string; displayName: string },
  ): Promise<PublicAccount> {
    return this.#request("/v1/me/profile", {
      method: "PATCH",
      accessToken,
      body: input,
      schema: PublicAccountSchema,
    });
  }

  public changePassword(
    accessToken: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    return this.#request("/v1/me/password", {
      method: "POST",
      accessToken,
      body: input,
    });
  }

  public initializePassword(accessToken: string, input: { newPassword: string }): Promise<void> {
    return this.#request("/v1/me/password/initialize", {
      method: "POST",
      accessToken,
      body: input,
    });
  }

  public refresh(refreshToken: string): Promise<PublicSessionResponse> {
    return this.#request("/v1/auth/refresh", {
      method: "POST",
      body: { refreshToken },
      schema: PublicSessionResponseSchema,
    });
  }

  public logout(refreshToken: string): Promise<void> {
    return this.#request("/v1/auth/logout", {
      method: "POST",
      body: { refreshToken },
    });
  }

  public async listRooms(accessToken: string): Promise<PublicRoom[]> {
    const response = await this.#request("/v1/rooms", {
      method: "GET",
      accessToken,
      schema: RoomListResponseSchema,
    });
    return response.rooms;
  }

  public createRoom(accessToken: string, input: RoomMutationInput): Promise<PublicRoom>;
  public createRoom(accessToken: string, input: string): Promise<PublicRoom>;
  public createRoom(accessToken: string, input: RoomMutationInput | string): Promise<PublicRoom> {
    const parsed = RoomMutationInputSchema.parse(
      typeof input === "string"
        ? {
            name: input,
            visibility: "PRIVATE",
            joinPolicy: "INVITE_ONLY",
          }
        : input,
    );
    return this.#request("/v1/rooms", {
      method: "POST",
      accessToken,
      body: parsed,
      schema: PublicRoomSchema,
    });
  }

  public updateRoom(
    accessToken: string,
    roomIdInput: unknown,
    input: RoomMutationInput,
  ): Promise<PublicRoom> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const parsed = RoomMutationInputSchema.parse(input);
    return this.#request(`/v1/rooms/${roomId}`, {
      method: "PATCH",
      accessToken,
      body: parsed,
      schema: PublicRoomSchema,
    });
  }

  public getRoom(accessToken: string, roomIdInput: unknown): Promise<PublicRoomDetail> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#request(`/v1/rooms/${roomId}`, {
      method: "GET",
      accessToken,
      schema: PublicRoomDetailSchema,
    });
  }

  public async listInvitations(accessToken: string): Promise<PublicReceivedInvitation[]> {
    const response = await this.#request("/v1/invitations", {
      method: "GET",
      accessToken,
      schema: InvitationListResponseSchema,
    });
    return response.invitations;
  }

  public acceptInvitation(accessToken: string, invitationIdInput: unknown): Promise<PublicRoom> {
    const invitationId = InvitationIdSchema.parse(invitationIdInput);
    return this.#request(`/v1/invitations/${invitationId}/accept`, {
      method: "POST",
      accessToken,
      schema: PublicRoomSchema,
    });
  }

  public invite(
    accessToken: string,
    roomIdInput: unknown,
    username: string,
  ): Promise<PublicRoomInvitation> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#request(`/v1/rooms/${roomId}/invitations`, {
      method: "POST",
      accessToken,
      body: { username },
      schema: PublicRoomInvitationSchema,
    });
  }

  public searchDirectory(accessToken: string, input: DirectorySearchInput): Promise<DirectoryList> {
    const parsed = DirectorySearchInputSchema.parse(input);
    return this.#request(
      withSearchParams("/v1/directory/users", [
        ["roomId", parsed.roomId],
        ["query", parsed.query],
        ["cursor", parsed.cursor],
        ["limit", parsed.limit],
      ]),
      {
        method: "GET",
        accessToken,
        schema: DirectoryListSchema,
      },
    );
  }

  public joinOpenRoom(accessToken: string, roomIdInput: unknown): Promise<PublicRoom> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#request(`/v1/rooms/${roomId}/join`, {
      method: "POST",
      accessToken,
      schema: PublicRoomSchema,
    });
  }

  public requestRoomJoin(accessToken: string, roomIdInput: unknown): Promise<RoomJoinRequest> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#request(`/v1/rooms/${roomId}/join-requests`, {
      method: "POST",
      accessToken,
      schema: RoomJoinRequestSchema,
    });
  }

  public cancelJoinRequest(accessToken: string, requestIdInput: unknown): Promise<void> {
    const requestId = CanonicalUuidSchema.parse(requestIdInput);
    return this.#request(`/v1/room-join-requests/${requestId}`, {
      method: "DELETE",
      accessToken,
    });
  }

  public decideJoinRequest(
    accessToken: string,
    requestIdInput: unknown,
    input: {
      decision: "APPROVE" | "REJECT";
      clientOpId: unknown;
    },
  ): Promise<RoomJoinRequest> {
    const requestId = CanonicalUuidSchema.parse(requestIdInput);
    const parsed = RoomJoinDecisionInputSchema.parse(input);
    return this.#request(`/v1/room-join-requests/${requestId}/decision`, {
      method: "POST",
      accessToken,
      body: parsed,
      schema: RoomJoinRequestSchema,
    });
  }

  public batchInvite(
    accessToken: string,
    roomIdInput: unknown,
    userIdsInput: readonly unknown[],
  ): Promise<BatchInvitationResult[]> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const userIds = BatchUserIdsSchema.parse(userIdsInput);
    return this.#request(`/v1/rooms/${roomId}/invitations/batch`, {
      method: "POST",
      accessToken,
      body: { userIds },
      schema: BatchInvitationResponseSchema,
    });
  }

  public listNotifications(
    accessToken: string,
    input: NotificationListInput,
  ): Promise<NotificationList> {
    const parsed = NotificationListInputSchema.parse(input);
    return this.#request(
      withSearchParams("/v1/notifications", [
        ["after", parsed.after],
        ["limit", parsed.limit],
      ]),
      {
        method: "GET",
        accessToken,
        schema: NotificationListSchema,
      },
    );
  }

  public markNotificationRead(
    accessToken: string,
    notificationIdInput: unknown,
  ): Promise<Notification> {
    const notificationId = CanonicalUuidSchema.parse(notificationIdInput);
    return this.#request(`/v1/notifications/${notificationId}/read`, {
      method: "POST",
      accessToken,
      schema: NotificationSchema,
    });
  }

  public markNotificationsRead(
    accessToken: string,
    throughCursorInput: unknown,
  ): Promise<NotificationReadThrough> {
    const throughCursor = NotificationCursorSchema.parse(throughCursorInput);
    return this.#request("/v1/notifications/read-all", {
      method: "POST",
      accessToken,
      body: { throughCursor },
      schema: NotificationReadThroughSchema,
    });
  }

  public getCurrentPolicyAcceptance(accessToken: string): Promise<PolicyAcceptance> {
    return this.#request("/v1/policy-acceptances/current", {
      method: "GET",
      accessToken,
      schema: PolicyAcceptanceSchema,
    });
  }

  public acceptCurrentPolicy(
    accessToken: string,
    input: PolicyAcceptanceInput,
  ): Promise<PolicyAcceptance> {
    const parsed = PolicyAcceptanceInputSchema.parse(input);
    return this.#request("/v1/policy-acceptances", {
      method: "POST",
      accessToken,
      body: {
        ...parsed,
        accepted: true,
      },
      schema: PolicyAcceptanceSchema,
    });
  }

  public leaveRoom(accessToken: string, roomIdInput: unknown): Promise<void> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#request(`/v1/rooms/${roomId}/members/me`, {
      method: "DELETE",
      accessToken,
    });
  }

  public removeMember(
    accessToken: string,
    roomIdInput: unknown,
    userIdInput: unknown,
  ): Promise<void> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const userId = CanonicalUuidSchema.parse(userIdInput);
    return this.#request(`/v1/rooms/${roomId}/members/${userId}`, {
      method: "DELETE",
      accessToken,
    });
  }

  public transferOwnership(
    accessToken: string,
    roomIdInput: unknown,
    newOwnerUserIdInput: unknown,
  ): Promise<PublicRoom> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    const newOwnerUserId = CanonicalUuidSchema.parse(newOwnerUserIdInput);
    return this.#request(`/v1/rooms/${roomId}/ownership-transfer`, {
      method: "POST",
      accessToken,
      body: { newOwnerUserId },
      schema: PublicRoomSchema,
    });
  }

  public dissolveRoom(accessToken: string, roomIdInput: unknown): Promise<void> {
    const roomId = RoomIdSchema.parse(roomIdInput);
    return this.#request(`/v1/rooms/${roomId}`, {
      method: "DELETE",
      accessToken,
    });
  }

  async #request<T>(
    path: string,
    options: RequestOptions<T> & { schema: z.ZodType<T> },
  ): Promise<T>;
  async #request(path: string, options: RequestOptions<never>): Promise<void>;
  async #request<T>(path: string, options: RequestOptions<T>): Promise<T | void> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.accessToken !== undefined) {
      headers.authorization = `Bearer ${AccessTokenSchema.parse(options.accessToken)}`;
    }

    let response: Response;
    try {
      const request = this.#fetch;
      response = await request(`${this.#origin}${path}`, {
        method: options.method,
        headers,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        ...(options.timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(options.timeoutMs) }),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (cause) {
      throw new SyncActionApiError("NETWORK_ERROR", 0, { cause });
    }

    if (response.redirected) {
      const responseOrigin = safeOrigin(response.url);
      if (responseOrigin !== this.#origin) {
        throw new SyncActionApiError("CROSS_ORIGIN_REDIRECT", response.status);
      }
    }

    if (!response.ok) {
      const error = ApiErrorResponseSchema.safeParse(await readJson(response));
      if (!error.success) {
        throw new SyncActionApiError("INVALID_RESPONSE", response.status, {
          cause: error.error,
        });
      }
      throw new SyncActionApiError(error.data.code, response.status, {
        requestId: error.data.requestId,
      });
    }

    if (options.schema === undefined) {
      return;
    }
    const parsed = options.schema.safeParse(await readJson(response));
    if (!parsed.success) {
      throw new SyncActionApiError("INVALID_RESPONSE", response.status, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function withSearchParams(
  path: string,
  entries: ReadonlyArray<readonly [string, string | number | null]>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== null) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
