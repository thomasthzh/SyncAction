import {
  CanonicalUuidSchema,
  ContentCompatibilitySchema,
  DeviceIdSchema,
  DocumentRevisionSchema,
  LogicalTabIdSchema,
  MediaObservedStateSchema,
  MediaTargetSchema,
  NotificationSchema,
  PlaybackGroupSnapshotSchema,
  PresenceRecordSchema,
  PublicRoomSummarySchema,
  RoomIdSchema,
} from "@syncaction/protocol";
import { z } from "zod";
import {
  PublicAccountSchema,
  PublicReceivedInvitationSchema,
  PublicRoomDetailSchema,
  PublicRoomSchema,
} from "../api-client.js";
import { ServerProfileIdSchema, ServerProfileSchema } from "../server-profile.js";
import { parsePublicServerOrigin } from "../server-origin.js";

const NonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const PositiveIntegerSchema = z.number().int().positive().safe();
const ErrorCodeSchema = z.string().min(1).max(128).nullable();
const ShortTextSchema = z.string().max(512);
const OptionalReasonSchema = z.string().min(1).max(256).nullable();
const RoomNameSchema = z.string().trim().min(1).max(100);
const UsernameSchema = z.string().trim().min(1).max(32);
const DisplayNameSchema = z.string().trim().min(1).max(64);
const PasswordSchema = z.string().min(1).max(1_024);
const SearchQuerySchema = z.string().max(200);
const ListCursorSchema = z.string().min(1).max(1_024).nullable();
const ListLimitSchema = z.number().int().min(1).max(50).safe();

const ExtensionAppPhaseSchema = z.enum([
  "SIGNED_OUT",
  "ACCOUNT_PENDING",
  "AUTHENTICATED_NO_ROOM",
  "CONNECTING_ROOM",
  "ROOM_ACTIVE",
  "SESSION_EXPIRED",
  "ERROR",
]);

const PageToolCommandBindingSchema = z
  .object({
    command: z.enum(["toggle-danmaku-input", "toggle-page-pen"]),
    suggestedShortcut: z.enum(["Alt+T", "Alt+P"]),
    actualShortcut: z.string().trim().min(1).max(128).nullable(),
    state: z.enum(["BOUND", "UNBOUND"]),
  })
  .strict()
  .superRefine((binding, context) => {
    if ((binding.state === "BOUND") !== (binding.actualShortcut !== null)) {
      context.addIssue({
        code: "custom",
        path: ["actualShortcut"],
        message: "shortcut binding state does not match the actual shortcut",
      });
    }
  });

export const PageToolCommandBindingsSchema = z
  .object({
    danmaku: PageToolCommandBindingSchema.superRefine((binding, context) => {
      if (binding.command !== "toggle-danmaku-input" || binding.suggestedShortcut !== "Alt+T") {
        context.addIssue({ code: "custom", message: "invalid danmaku command binding" });
      }
    }),
    pen: PageToolCommandBindingSchema.superRefine((binding, context) => {
      if (binding.command !== "toggle-page-pen" || binding.suggestedShortcut !== "Alt+P") {
        context.addIssue({ code: "custom", message: "invalid pen command binding" });
      }
    }),
  })
  .strict();

const BrowserStatusReasonSchema = z.enum([
  "REPLICA_NOT_ACTUATABLE",
  "ROOM_TAB_LIMIT_REACHED",
  "AMBIGUOUS_ROOM_GROUP",
  "UNSAFE_ROOM_GROUP",
  "STALE_BROWSER_SESSION",
  "UNBOUND_ROOM_TABS",
  "UNSUPPORTED_ROOM_TAB",
  "BOUND_TAB_OUTSIDE_ROOM_GROUP",
  "MISSING_BOUND_TAB",
  "WINDOW_CLOSING",
  "TAB_DETACHED",
  "TAB_ATTACHED",
  "TAB_REPLACED",
  "STALE_BINDINGS",
  "UNBOUND_ROOM_TAB",
  "BROWSER_API_FAILURE",
  "POST_EFFECT_MISMATCH",
  "CIRCUIT_BREAKER",
]);

const RoomBrowserStatusSchema = z
  .object({
    state: z.enum([
      "IDLE",
      "SYNCHRONIZED",
      "CONFIRMATION_REQUIRED",
      "RECOVERY_REQUIRED",
      "BLOCKED",
    ]),
    reason: BrowserStatusReasonSchema.nullable(),
    missingTabCount: NonNegativeIntegerSchema,
    effectsApplied: NonNegativeIntegerSchema,
  })
  .strict();

const PresenceStatusSchema = z
  .object({
    state: z.enum(["OFFLINE", "ONLINE", "DEGRADED"]),
    presences: z.array(PresenceRecordSchema).max(256),
    compatibilities: z
      .array(
        z
          .object({
            userId: CanonicalUuidSchema,
            deviceId: DeviceIdSchema,
            logicalTabId: LogicalTabIdSchema,
            compatibility: ContentCompatibilitySchema,
            warning: z.boolean(),
          })
          .strict(),
      )
      .max(256)
      .optional(),
    lastAckExpiresAt: PositiveIntegerSchema.nullable(),
    errorCode: ErrorCodeSchema,
  })
  .strict();

const PointerStatusSchema = z
  .object({
    state: z.enum(["OFFLINE", "ONLINE", "DEGRADED"]),
    lastAckExpiresAt: PositiveIntegerSchema.nullable(),
    errorCode: ErrorCodeSchema,
  })
  .strict();

const MediaLocalObservationSchema = z
  .object({
    target: MediaTargetSchema,
    observed: MediaObservedStateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.observed.positionMs > value.target.durationMs) {
      context.addIssue({
        code: "custom",
        path: ["observed", "positionMs"],
        message: "observed position exceeds target duration",
      });
    }
  });

const MediaStatusSchema = z
  .object({
    state: z.enum(["OFFLINE", "ONLINE", "DEGRADED"]),
    roomMediaRevision: NonNegativeIntegerSchema.nullable(),
    playbackGroups: z.array(PlaybackGroupSnapshotSchema).max(256),
    localObservation: MediaLocalObservationSchema.nullable(),
    localMembership: z
      .object({
        playbackGroupId: CanonicalUuidSchema,
        role: z.enum(["LEADER", "FOLLOWER", "READ_ONLY"]),
        activeDevice: z.boolean(),
      })
      .strict()
      .nullable(),
    recommendedPlaybackGroupId: CanonicalUuidSchema.nullable(),
    navigation: z
      .array(
        z
          .object({
            userId: CanonicalUuidSchema,
            deviceId: CanonicalUuidSchema,
            logicalTabId: LogicalTabIdSchema.nullable(),
            canJump: z.boolean(),
            disabledReason: OptionalReasonSchema,
          })
          .strict(),
      )
      .max(256),
    errorCode: ErrorCodeSchema,
  })
  .strict();

const DanmakuStatusSchema = z
  .object({
    state: z.enum(["OFFLINE", "ONLINE", "DEGRADED"]),
    errorCode: ErrorCodeSchema,
    lastMessageId: CanonicalUuidSchema.nullable(),
    ready: z.boolean(),
    canRetry: z.boolean(),
    hidden: z.boolean(),
    inputOpen: z.boolean(),
  })
  .strict();

const DrawingStatusSchema = z
  .object({
    state: z.enum(["OFFLINE", "SYNCING", "ONLINE", "DEGRADED"]),
    errorCode: ErrorCodeSchema,
    pageKey: z.string().min(1).max(512).nullable(),
    used: NonNegativeIntegerSchema,
    capacity: NonNegativeIntegerSchema,
    lockedCount: NonNegativeIntegerSchema,
    capacityState: z.enum(["AVAILABLE", "NEAR_LIMIT", "FULL"]),
    canCreate: z.boolean(),
    pendingDraftCount: NonNegativeIntegerSchema,
    errorDraftCount: NonNegativeIntegerSchema,
    unlocatableCount: NonNegativeIntegerSchema,
    ready: z.boolean(),
    canRetry: z.boolean(),
    active: z.boolean(),
    tool: z.enum(["PEN", "ERASER", "SELECT"]),
    rgb: z
      .object({
        r: z.number().int().min(0).max(255),
        g: z.number().int().min(0).max(255),
        b: z.number().int().min(0).max(255),
      })
      .strict(),
    width: z.number().finite().positive().max(128),
    selectedCount: NonNegativeIntegerSchema,
    selectedLockedCount: NonNegativeIntegerSchema,
  })
  .strict();

export const ExtensionStatusUiSchema = z
  .object({
    state: z.enum([
      "DISCONNECTED",
      "AUTHENTICATING",
      "WAITING_SNAPSHOT",
      "SYNCED",
      "RECOVERING",
      "QUARANTINED",
      "NOT_CONFIGURED",
      "CONFIGURATION_ERROR",
    ]),
    roomName: z.string().min(1).max(120).nullable(),
    serverSeq: NonNegativeIntegerSchema.nullable(),
    sharedTabCount: NonNegativeIntegerSchema,
    outboxCount: NonNegativeIntegerSchema,
    pendingConfirmationCount: NonNegativeIntegerSchema,
    bindingCount: NonNegativeIntegerSchema,
    browser: RoomBrowserStatusSchema.nullable(),
    presence: PresenceStatusSchema.nullable(),
    pointer: PointerStatusSchema.nullable(),
    media: MediaStatusSchema.nullable(),
    danmaku: DanmakuStatusSchema.nullable().optional(),
    drawing: DrawingStatusSchema.nullable().optional(),
    tabs: z
      .array(
        z
          .object({
            logicalTabId: LogicalTabIdSchema,
            title: ShortTextSchema,
            domain: z.string().max(253),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

export const ExtensionCollaborationSummarySchema = z
  .object({
    capacity: z
      .object({
        openTabCount: NonNegativeIntegerSchema,
        limit: PositiveIntegerSchema.nullable(),
        exemption: z.enum(["EXEMPT", "NOT_EXEMPT", "UNKNOWN"]),
      })
      .strict(),
    navigation: z
      .object({
        canJump: z.boolean(),
        disabledReason: OptionalReasonSchema,
      })
      .strict(),
    pages: z
      .array(
        z
          .object({
            pageId: LogicalTabIdSchema,
            title: ShortTextSchema,
            domain: z.string().max(253),
            state: z.enum(["OPEN", "CLOSED"]),
            compatibility: ContentCompatibilitySchema.optional(),
            compatibilityWarning: OptionalReasonSchema.optional(),
          })
          .strict(),
      )
      .max(1_000),
    members: z
      .array(
        z
          .object({
            userId: CanonicalUuidSchema,
            displayName: DisplayNameSchema,
            roomRole: z.enum(["OWNER", "MEMBER"]),
            online: z.boolean(),
            deviceCount: NonNegativeIntegerSchema,
            activePageIds: z.array(LogicalTabIdSchema).max(256),
          })
          .strict(),
      )
      .max(1_000),
    playbackGroups: z
      .array(
        z
          .object({
            groupId: CanonicalUuidSchema,
            name: z.string().min(1).max(128),
            state: z.enum(["PLAYING", "PAUSED", "ENDED", "PENDING"]),
            statusText: z.string().max(256),
            participants: z
              .array(
                z
                  .object({
                    userId: CanonicalUuidSchema,
                    role: z.enum(["LEADER", "FOLLOWER"]),
                    statusText: z.string().max(256),
                    canJump: z.boolean(),
                    canAlign: z.boolean(),
                    disabledReason: OptionalReasonSchema,
                  })
                  .strict(),
              )
              .max(256),
            canJoin: z.boolean(),
            joinDisabledReason: OptionalReasonSchema,
          })
          .strict(),
      )
      .max(256),
    tools: z
      .array(
        z
          .object({
            toolId: z.string().min(1).max(64),
            kind: z.enum(["POINTER", "DANMAKU", "DRAWING"]),
            state: z.enum(["AVAILABLE", "ACTIVE", "DEGRADED", "UNAVAILABLE"]),
            statusText: z.string().max(256),
            errorCode: ErrorCodeSchema,
            canActivate: z.boolean(),
            disabledReason: OptionalReasonSchema,
          })
          .strict(),
      )
      .max(16),
    proposals: z
      .array(
        z
          .object({
            groupId: CanonicalUuidSchema,
            proposalId: CanonicalUuidSchema,
            title: z.string().min(1).max(160),
            detail: z.string().max(512),
            state: z.enum(["PENDING", "ACCEPTED", "REJECTED"]),
            canApprove: z.boolean(),
            canReject: z.boolean(),
            disabledReason: OptionalReasonSchema,
          })
          .strict(),
      )
      .max(256),
    annotation: z
      .object({
        used: NonNegativeIntegerSchema,
        capacity: NonNegativeIntegerSchema.nullable(),
        lockedCount: NonNegativeIntegerSchema,
        state: z.enum(["AVAILABLE", "NEAR_LIMIT", "FULL", "UNAVAILABLE"]),
        canCreate: z.boolean(),
        disabledReason: OptionalReasonSchema,
      })
      .strict(),
    activities: z
      .array(
        z
          .object({
            activityId: z.string().min(1).max(128),
            text: z.string().min(1).max(256),
            detail: z.string().max(512),
            tone: z.enum(["neutral", "info", "success", "warning", "danger"]),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export const UiShellSliceSchema = z
  .object({
    phase: ExtensionAppPhaseSchema,
    account: PublicAccountSchema.nullable(),
    profiles: z.array(ServerProfileSchema).min(1).max(20),
    selectedProfileId: ServerProfileIdSchema,
    onboardingRequired: z.boolean(),
    errorCode: ErrorCodeSchema,
  })
  .strict()
  .superRefine((shell, context) => {
    if (!shell.profiles.some((profile) => profile.profileId === shell.selectedProfileId)) {
      context.addIssue({
        code: "custom",
        path: ["selectedProfileId"],
        message: "selected profile is missing from the profile list",
      });
    }
  });

export const UiDiscoverySliceSchema = z
  .object({
    publicRooms: z.array(PublicRoomSummarySchema).max(1_000),
    rooms: z.array(PublicRoomSchema).max(1_000),
    invitations: z.array(PublicReceivedInvitationSchema).max(1_000),
  })
  .strict();

export const UiRoomSliceSchema = z
  .object({
    selectedRoomId: RoomIdSchema.nullable(),
    detail: PublicRoomDetailSchema.nullable(),
    runtime: ExtensionStatusUiSchema.nullable(),
  })
  .strict()
  .superRefine((room, context) => {
    if (
      room.selectedRoomId !== null &&
      room.detail !== null &&
      room.selectedRoomId !== room.detail.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["detail", "id"],
        message: "selected room and room detail do not match",
      });
    }
  });

export const UiNotificationsSliceSchema = z
  .object({
    items: z.array(NotificationSchema).max(1_000),
    unreadCount: NonNegativeIntegerSchema,
    cursor: NonNegativeIntegerSchema,
  })
  .strict();

function isExactPageOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      !url.hostname.includes("*") &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

const PageOriginSchema = z
  .string()
  .max(2_048)
  .refine(isExactPageOrigin, "invalid exact page origin");

export const PageFeatureSchema = z.enum(["POINTER", "DANMAKU", "DRAWING", "MEDIA_CONTROL"]);
export type PageFeature = z.infer<typeof PageFeatureSchema>;

export const PageAccessReasonSchema = z.enum([
  "NO_ACTIVE_TAB",
  "UNSUPPORTED_ORIGIN",
  "SERVER_TERMS_UNAVAILABLE",
  "ROOM_DOCUMENT_UNAVAILABLE",
  "BROWSER_PERMISSION_REQUIRED",
  "TERMS_ACCEPTANCE_REQUIRED",
  "CONTENT_MISMATCH",
  "CONTENT_UNKNOWN",
]);
export type PageAccessReason = z.infer<typeof PageAccessReasonSchema>;

export const UiPageAccessSliceSchema = z
  .object({
    bindings: PageToolCommandBindingsSchema.nullable(),
    tabId: NonNegativeIntegerSchema.nullable(),
    documentRevision: DocumentRevisionSchema.nullable(),
    contentCompatibility: ContentCompatibilitySchema.nullable(),
    origin: PageOriginSchema.nullable(),
    supported: z.boolean(),
    browserPermissionGranted: z.boolean(),
    termsAccepted: z.boolean(),
    serverTermsVersion: z.string().min(1).max(64).nullable(),
    disclosureVersion: z.literal(1),
    enabledFeatures: z.array(PageFeatureSchema).max(PageFeatureSchema.options.length),
    policySyncPendingCount: NonNegativeIntegerSchema,
    reason: PageAccessReasonSchema.nullable(),
  })
  .strict()
  .superRefine((access, context) => {
    if (new Set(access.enabledFeatures).size !== access.enabledFeatures.length) {
      context.addIssue({
        code: "custom",
        path: ["enabledFeatures"],
        message: "page features must be unique",
      });
    }
    if (access.tabId === null && access.documentRevision !== null) {
      context.addIssue({
        code: "custom",
        path: ["documentRevision"],
        message: "a document revision requires an active tab",
      });
    }
    if (access.documentRevision === null && access.contentCompatibility !== null) {
      context.addIssue({
        code: "custom",
        path: ["contentCompatibility"],
        message: "content compatibility requires a document revision",
      });
    }
    if (access.supported !== (access.origin !== null)) {
      context.addIssue({
        code: "custom",
        path: ["supported"],
        message: "supported page state must match an exact origin",
      });
    }
    if (access.origin === null && access.browserPermissionGranted) {
      context.addIssue({
        code: "custom",
        path: ["browserPermissionGranted"],
        message: "an unavailable origin cannot have browser permission",
      });
    }
    if (access.serverTermsVersion === null && access.termsAccepted) {
      context.addIssue({
        code: "custom",
        path: ["termsAccepted"],
        message: "terms cannot be accepted without a verified server terms version",
      });
    }
    if (
      access.enabledFeatures.length > 0 &&
      (!access.browserPermissionGranted ||
        !access.termsAccepted ||
        access.documentRevision === null ||
        !access.supported)
    ) {
      context.addIssue({
        code: "custom",
        path: ["enabledFeatures"],
        message: "enabled page features require a usable document-bound origin grant",
      });
    }
  });

export const UiStateSlicesSchema = z
  .object({
    shell: UiShellSliceSchema,
    discovery: UiDiscoverySliceSchema,
    room: UiRoomSliceSchema,
    collaboration: ExtensionCollaborationSummarySchema,
    notifications: UiNotificationsSliceSchema,
    pageAccess: UiPageAccessSliceSchema,
  })
  .strict();

export type UiStateSlices = z.infer<typeof UiStateSlicesSchema>;
export type UiShellSlice = z.infer<typeof UiShellSliceSchema>;
export type UiDiscoverySlice = z.infer<typeof UiDiscoverySliceSchema>;
export type UiRoomSlice = z.infer<typeof UiRoomSliceSchema>;
export type UiCollaborationSlice = z.infer<typeof ExtensionCollaborationSummarySchema>;
export type UiNotificationsSlice = z.infer<typeof UiNotificationsSliceSchema>;
export type UiPageAccessSlice = z.infer<typeof UiPageAccessSliceSchema>;

export const UiSliceNameSchema = z.enum([
  "shell",
  "discovery",
  "room",
  "collaboration",
  "notifications",
  "pageAccess",
]);
export type UiSliceName = z.infer<typeof UiSliceNameSchema>;
export type UiSliceHint = readonly UiSliceName[];

export const UiSliceVersionsSchema = z
  .object({
    shell: NonNegativeIntegerSchema,
    discovery: NonNegativeIntegerSchema,
    room: NonNegativeIntegerSchema,
    collaboration: NonNegativeIntegerSchema,
    notifications: NonNegativeIntegerSchema,
    pageAccess: NonNegativeIntegerSchema,
  })
  .strict();

export type UiSliceVersions = z.infer<typeof UiSliceVersionsSchema>;

export const UiStateSnapshotSchema = z
  .object({
    type: z.literal("ui.state.snapshot"),
    versions: UiSliceVersionsSchema,
    slices: UiStateSlicesSchema,
  })
  .strict();

function slicePatchSchema<const Name extends UiSliceName, Schema extends z.ZodType>(
  slice: Name,
  value: Schema,
) {
  return z
    .object({
      type: z.literal("ui.state.patch"),
      slice: z.literal(slice),
      fromVersion: NonNegativeIntegerSchema,
      toVersion: PositiveIntegerSchema,
      value,
    })
    .strict();
}

export const UiStatePatchSchema = z
  .discriminatedUnion("slice", [
    slicePatchSchema("shell", UiShellSliceSchema),
    slicePatchSchema("discovery", UiDiscoverySliceSchema),
    slicePatchSchema("room", UiRoomSliceSchema),
    slicePatchSchema("collaboration", ExtensionCollaborationSummarySchema),
    slicePatchSchema("notifications", UiNotificationsSliceSchema),
    slicePatchSchema("pageAccess", UiPageAccessSliceSchema),
  ])
  .superRefine((patch, context) => {
    if (patch.toVersion !== patch.fromVersion + 1) {
      context.addIssue({
        code: "custom",
        path: ["toVersion"],
        message: "a UI state patch must increment its slice version exactly once",
      });
    }
  });

export type UiStateSnapshot = z.infer<typeof UiStateSnapshotSchema>;
export type UiStatePatch = z.infer<typeof UiStatePatchSchema>;

export const UiResyncSchema = z
  .object({
    type: z.literal("ui.resync"),
    versions: UiSliceVersionsSchema,
  })
  .strict();
export type UiResync = z.infer<typeof UiResyncSchema>;

export const UiCommandNameSchema = z.enum([
  "AUTH_REGISTER",
  "AUTH_LOGIN",
  "AUTH_ACTIVATE",
  "AUTH_KEY_LOGIN",
  "AUTH_LOGOUT",
  "ACCOUNT_PROFILE_UPDATE",
  "ACCOUNT_PASSWORD_CHANGE",
  "ACCOUNT_PASSWORD_INITIALIZE",
  "SERVER_ADD",
  "SERVER_SELECT",
  "ONBOARDING_DISMISS",
  "PUBLIC_ROOMS_REFRESH",
  "ROOM_CREATE",
  "ROOM_UPDATE",
  "ROOM_SELECT",
  "ROOM_TAB_ACTIVATE",
  "ROOM_JOIN_OPEN",
  "ROOM_JOIN_REQUEST",
  "JOIN_REQUEST_DECIDE",
  "INVITATION_ACCEPT",
  "DIRECTORY_SEARCH",
  "INVITE_BATCH",
  "NOTIFICATION_READ",
  "NOTIFICATIONS_READ_ALL",
  "ROOM_LEAVE",
  "ROOM_MEMBER_REMOVE",
  "ROOM_OWNERSHIP_TRANSFER",
  "ROOM_DISSOLVE",
  "CURRENT_TAB_SHARE",
  "BROWSER_RECOVERY_CONFIRM",
  "PAGE_PERMISSION_REFRESH",
  "PAGE_PERMISSION_REMOVE",
  "POLICY_ACCEPTANCE_RECORD",
  "DANMAKU_TOGGLE",
  "DANMAKU_VISIBILITY",
  "PEN_TOGGLE",
  "MEDIA_MEMBER_JUMP",
  "MEDIA_GROUP_ALIGN_ONCE",
  "MEDIA_GROUP_JOIN",
  "MEDIA_GROUP_LEAVE",
  "MEDIA_GROUP_CLOSE",
  "MEDIA_DEVICE_TAKEOVER",
  "MEDIA_PROPOSAL_DECIDE",
]);

export type UiCommandName = z.infer<typeof UiCommandNameSchema>;

const CommandBaseFields = {
  type: z.literal("ui.command"),
  commandId: CanonicalUuidSchema,
} as const;

function commandWithoutPayload<const Name extends UiCommandName>(name: Name) {
  return z
    .object({
      ...CommandBaseFields,
      name: z.literal(name),
    })
    .strict();
}

function commandWithPayload<const Name extends UiCommandName, Schema extends z.ZodType>(
  name: Name,
  payload: Schema,
) {
  return z
    .object({
      ...CommandBaseFields,
      name: z.literal(name),
      payload,
    })
    .strict();
}

const RoomMutationPayloadSchema = z
  .object({
    name: RoomNameSchema,
    visibility: z.enum(["PRIVATE", "PUBLIC"]),
    joinPolicy: z.enum(["OPEN", "APPROVAL", "INVITE_ONLY"]),
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

const NormalizedServerOriginSchema = z.string().transform((value, context) => {
  try {
    return parsePublicServerOrigin(value);
  } catch {
    context.addIssue({ code: "custom", message: "INVALID_SERVER_URL" });
    return z.NEVER;
  }
});

const ExactPageOriginSchema = z
  .string()
  .max(2_048)
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.origin !== value
      ) {
        throw new Error("not an exact HTTP/HTTPS origin");
      }
    } catch {
      context.addIssue({ code: "custom", message: "INVALID_PAGE_ORIGIN" });
    }
  });

const UniqueUserIdsSchema = z
  .array(CanonicalUuidSchema)
  .min(1)
  .max(20)
  .superRefine((userIds, context) => {
    if (new Set(userIds).size !== userIds.length) {
      context.addIssue({ code: "custom", message: "user IDs must be unique" });
    }
  });

const ActivationKeySchema = z
  .string()
  .trim()
  .regex(/^sak_[A-Za-z0-9_-]{43}$/u);

export const UiCommandSchema = z.discriminatedUnion("name", [
  commandWithPayload(
    "AUTH_REGISTER",
    z
      .object({
        username: UsernameSchema,
        displayName: DisplayNameSchema,
        password: PasswordSchema,
      })
      .strict(),
  ),
  commandWithPayload(
    "AUTH_LOGIN",
    z.object({ username: UsernameSchema, password: PasswordSchema }).strict(),
  ),
  commandWithPayload(
    "AUTH_ACTIVATE",
    z
      .object({
        activationKey: ActivationKeySchema,
        username: UsernameSchema,
        displayName: DisplayNameSchema,
        password: PasswordSchema,
      })
      .strict(),
  ),
  commandWithPayload("AUTH_KEY_LOGIN", z.object({ activationKey: ActivationKeySchema }).strict()),
  commandWithoutPayload("AUTH_LOGOUT"),
  commandWithPayload(
    "ACCOUNT_PROFILE_UPDATE",
    z.object({ username: UsernameSchema, displayName: DisplayNameSchema }).strict(),
  ),
  commandWithPayload(
    "ACCOUNT_PASSWORD_CHANGE",
    z.object({ currentPassword: PasswordSchema, newPassword: PasswordSchema }).strict(),
  ),
  commandWithPayload(
    "ACCOUNT_PASSWORD_INITIALIZE",
    z.object({ newPassword: PasswordSchema }).strict(),
  ),
  commandWithPayload("SERVER_ADD", z.object({ baseUrl: NormalizedServerOriginSchema }).strict()),
  commandWithPayload("SERVER_SELECT", z.object({ profileId: ServerProfileIdSchema }).strict()),
  commandWithoutPayload("ONBOARDING_DISMISS"),
  commandWithoutPayload("PUBLIC_ROOMS_REFRESH"),
  commandWithPayload("ROOM_CREATE", RoomMutationPayloadSchema),
  commandWithPayload("ROOM_UPDATE", RoomMutationPayloadSchema),
  commandWithPayload("ROOM_SELECT", z.object({ roomId: RoomIdSchema }).strict()),
  commandWithPayload("ROOM_TAB_ACTIVATE", z.object({ logicalTabId: LogicalTabIdSchema }).strict()),
  commandWithPayload("ROOM_JOIN_OPEN", z.object({ roomId: RoomIdSchema }).strict()),
  commandWithPayload("ROOM_JOIN_REQUEST", z.object({ roomId: RoomIdSchema }).strict()),
  commandWithPayload(
    "JOIN_REQUEST_DECIDE",
    z
      .object({
        requestId: CanonicalUuidSchema,
        decision: z.enum(["APPROVE", "REJECT"]),
      })
      .strict(),
  ),
  commandWithPayload("INVITATION_ACCEPT", z.object({ invitationId: CanonicalUuidSchema }).strict()),
  commandWithPayload(
    "DIRECTORY_SEARCH",
    z
      .object({
        roomId: RoomIdSchema,
        query: SearchQuerySchema,
        cursor: ListCursorSchema,
        limit: ListLimitSchema,
      })
      .strict(),
  ),
  commandWithPayload("INVITE_BATCH", z.object({ userIds: UniqueUserIdsSchema }).strict()),
  commandWithPayload(
    "NOTIFICATION_READ",
    z.object({ notificationId: CanonicalUuidSchema }).strict(),
  ),
  commandWithoutPayload("NOTIFICATIONS_READ_ALL"),
  commandWithoutPayload("ROOM_LEAVE"),
  commandWithPayload("ROOM_MEMBER_REMOVE", z.object({ userId: CanonicalUuidSchema }).strict()),
  commandWithPayload("ROOM_OWNERSHIP_TRANSFER", z.object({ userId: CanonicalUuidSchema }).strict()),
  commandWithoutPayload("ROOM_DISSOLVE"),
  commandWithoutPayload("CURRENT_TAB_SHARE"),
  commandWithoutPayload("BROWSER_RECOVERY_CONFIRM"),
  commandWithoutPayload("PAGE_PERMISSION_REFRESH"),
  commandWithPayload(
    "PAGE_PERMISSION_REMOVE",
    z.object({ origin: ExactPageOriginSchema }).strict(),
  ),
  commandWithoutPayload("POLICY_ACCEPTANCE_RECORD"),
  commandWithoutPayload("DANMAKU_TOGGLE"),
  commandWithPayload("DANMAKU_VISIBILITY", z.object({ hidden: z.boolean() }).strict()),
  commandWithoutPayload("PEN_TOGGLE"),
  commandWithPayload("MEDIA_MEMBER_JUMP", z.object({ userId: CanonicalUuidSchema }).strict()),
  commandWithPayload(
    "MEDIA_GROUP_ALIGN_ONCE",
    z.object({ playbackGroupId: CanonicalUuidSchema }).strict(),
  ),
  commandWithPayload(
    "MEDIA_GROUP_JOIN",
    z.object({ playbackGroupId: CanonicalUuidSchema }).strict(),
  ),
  commandWithPayload(
    "MEDIA_GROUP_LEAVE",
    z.object({ playbackGroupId: CanonicalUuidSchema }).strict(),
  ),
  commandWithPayload(
    "MEDIA_GROUP_CLOSE",
    z.object({ playbackGroupId: CanonicalUuidSchema }).strict(),
  ),
  commandWithPayload(
    "MEDIA_DEVICE_TAKEOVER",
    z.object({ playbackGroupId: CanonicalUuidSchema }).strict(),
  ),
  commandWithPayload(
    "MEDIA_PROPOSAL_DECIDE",
    z
      .object({
        playbackGroupId: CanonicalUuidSchema,
        proposalId: CanonicalUuidSchema,
        decision: z.enum(["APPROVE", "REJECT"]),
      })
      .strict(),
  ),
]);

export type UiCommand = z.infer<typeof UiCommandSchema>;
export type UiCommandRequest = UiCommand extends infer Command
  ? Command extends UiCommand
    ? Omit<Command, "type" | "commandId">
    : never
  : never;

export const UiCommandResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("ui.command.result"),
      commandId: CanonicalUuidSchema,
      ok: z.literal(true),
      value: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ui.command.result"),
      commandId: CanonicalUuidSchema,
      ok: z.literal(false),
      errorCode: z.string().min(1).max(128),
    })
    .strict(),
]);

export type UiCommandResult = z.infer<typeof UiCommandResultSchema>;

export const UiClientMessageSchema = z.union([UiCommandSchema, UiResyncSchema]);
export const UiServerMessageSchema = z.union([
  UiStateSnapshotSchema,
  UiStatePatchSchema,
  UiCommandResultSchema,
]);

export type UiClientMessage = z.infer<typeof UiClientMessageSchema>;
export type UiServerMessage = z.infer<typeof UiServerMessageSchema>;
