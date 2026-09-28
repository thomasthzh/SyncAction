import type {
  ColumnType,
  Generated,
  Insertable,
  JSONColumnType,
  Selectable,
  Updateable,
} from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type JsonObject = Record<string, unknown>;
type Json = JSONColumnType<JsonObject, JsonObject, JsonObject>;
type JsonArray = JSONColumnType<JsonObject[], string, string>;

export interface UserTable {
  id: string;
  username: string;
  usernameNormalized: string;
  displayName: string;
  passwordHash: string;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  passwordResetRequired: Generated<boolean>;
  createdAt: GeneratedTimestamp;
  updatedAt: GeneratedTimestamp;
}

export interface DeviceSessionTable {
  id: string;
  userId: string;
  deviceId: string;
  refreshTokenHash: string;
  tokenFamilyId: string;
  generation: Generated<number>;
  expiresAt: Timestamp;
  usedAt: Timestamp | null;
  revokedAt: Timestamp | null;
  replacedBySessionId: string | null;
  createdAt: GeneratedTimestamp;
  updatedAt: GeneratedTimestamp;
}

export interface AdministratorTable {
  id: string;
  username: string;
  usernameNormalized: string;
  passwordHash: string;
  totpSecretCiphertext: string;
  lastTotpCounter: Generated<number>;
  linkedUserId: string | null;
  passwordChangeRequired: Generated<boolean>;
  totpEnrollmentRequired: Generated<boolean>;
  createdAt: GeneratedTimestamp;
  updatedAt: GeneratedTimestamp;
}

export interface ServerPolicyTable {
  id: "GLOBAL";
  ordinaryActiveRoomLimit: number;
  ordinaryOpenTabLimit: number;
  updatedAt: GeneratedTimestamp;
}

export interface AdminSessionTable {
  id: string;
  administratorId: string;
  sessionTokenHash: string;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
  createdAt: GeneratedTimestamp;
}

export interface PasswordResetGrantTable {
  id: string;
  userId: string;
  tokenHash: string;
  issuedByAdministratorId: string;
  expiresAt: Timestamp;
  usedAt: Timestamp | null;
  createdAt: GeneratedTimestamp;
}

export interface AccountActivationGrantTable {
  id: string;
  note: string;
  tokenHash: string;
  tokenTail: string;
  issuedByAdministratorId: string;
  userId: string | null;
  expiresAt: Timestamp;
  usedAt: Timestamp | null;
  revokedAt: Timestamp | null;
  createdAt: GeneratedTimestamp;
  updatedAt: GeneratedTimestamp;
}

export interface RoomTable {
  id: string;
  name: string;
  ownerUserId: string;
  roomEpoch: Generated<number>;
  serverSeq: Generated<number>;
  visibility: Generated<"PRIVATE" | "PUBLIC">;
  joinPolicy: Generated<"OPEN" | "APPROVAL" | "INVITE_ONLY">;
  roomRevision: Generated<number>;
  deletedAt: Timestamp | null;
  createdAt: GeneratedTimestamp;
  updatedAt: GeneratedTimestamp;
}

export interface RoomMembershipTable {
  roomId: string;
  userId: string;
  role: "OWNER" | "MEMBER";
  createdAt: GeneratedTimestamp;
}

export interface RoomInvitationTable {
  id: string;
  roomId: string;
  invitedUserId: string;
  invitedByUserId: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  expiresAt: Timestamp;
  createdAt: GeneratedTimestamp;
  updatedAt: GeneratedTimestamp;
}

export interface RoomTabTable {
  roomId: string;
  logicalTabId: string;
  url: string;
  title: string | null;
  favIconUrl: string | null;
  position: number;
  createdAtSeq: number;
  updatedAtSeq: number;
  closedAtSeq: number | null;
}

export interface RoomOperationTable {
  roomId: string;
  serverSeq: number;
  roomEpoch: number;
  clientOpId: string;
  deviceId: string;
  payload: Json;
  createdAt: GeneratedTimestamp;
}

export interface ClientOperationTable {
  roomId: string;
  deviceId: string;
  clientOpId: string;
  serverSeq: number;
  createdAt: GeneratedTimestamp;
}

export interface RoomSnapshotTable {
  roomId: string;
  roomEpoch: number;
  serverSeq: number;
  state: Json;
  createdAt: GeneratedTimestamp;
}

export interface AuditEventTable {
  id: Generated<number>;
  actorUserId: string | null;
  actorAdministratorId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  details: Json;
  createdAt: GeneratedTimestamp;
}

export interface AnnotationPageTable {
  roomId: string;
  pageKey: string;
  annotationSeq: Generated<number>;
  liveStrokeCount: Generated<number>;
  liveStrokeBytes: Generated<number>;
  updatedAt: GeneratedTimestamp;
}

export interface AnnotationStrokeTable {
  roomId: string;
  pageKey: string;
  strokeId: string;
  authorUserId: string;
  frameKey: string;
  anchor: Json;
  points: JsonArray;
  rgb: Json;
  width: number;
  byteSize: number;
  lockedAt: Timestamp | null;
  version: number;
  contentSignature: ColumnType<string | null, string | null | undefined, string | null>;
  signatureVersion: ColumnType<number | null, number | null | undefined, number | null>;
  createdAt: GeneratedTimestamp;
  deletedAt: Timestamp | null;
}

export interface AnnotationOperationTable {
  roomId: string;
  pageKey: string;
  annotationSeq: number;
  clientOpId: string;
  actorUserId: string;
  operation: Json;
  createdAt: GeneratedTimestamp;
}

export interface ServerMetadataTable {
  id: "GLOBAL";
  serverId: string;
  displayName: string;
  protocolVersion: number;
  termsVersion: string;
  createdAt: GeneratedTimestamp;
  updatedAt: GeneratedTimestamp;
}

export interface RoomJoinRequestTable {
  id: string;
  roomId: string;
  applicantUserId: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
  decidedByUserId: string | null;
  decisionClientOpId: string | null;
  createdAt: GeneratedTimestamp;
  updatedAt: GeneratedTimestamp;
  decidedAt: Timestamp | null;
}

export interface NotificationTable {
  sequence: Generated<number>;
  id: string;
  recipientUserId: string;
  type: string;
  payload: Json;
  createdAt: GeneratedTimestamp;
  readAt: Timestamp | null;
}

export interface PolicyAcceptanceTable {
  userId: string;
  termsVersion: string;
  clientVersion: string;
  acceptedAt: GeneratedTimestamp;
}

export interface Database {
  users: UserTable;
  deviceSessions: DeviceSessionTable;
  administrators: AdministratorTable;
  serverPolicies: ServerPolicyTable;
  adminSessions: AdminSessionTable;
  passwordResetGrants: PasswordResetGrantTable;
  accountActivationGrants: AccountActivationGrantTable;
  rooms: RoomTable;
  roomMemberships: RoomMembershipTable;
  roomInvitations: RoomInvitationTable;
  roomTabs: RoomTabTable;
  roomOperations: RoomOperationTable;
  clientOperations: ClientOperationTable;
  roomSnapshots: RoomSnapshotTable;
  auditEvents: AuditEventTable;
  annotationPages: AnnotationPageTable;
  annotationStrokes: AnnotationStrokeTable;
  annotationOperations: AnnotationOperationTable;
  serverMetadata: ServerMetadataTable;
  roomJoinRequests: RoomJoinRequestTable;
  notifications: NotificationTable;
  policyAcceptances: PolicyAcceptanceTable;
}

export type User = Selectable<UserTable>;
export type NewUser = Insertable<UserTable>;
export type UserUpdate = Updateable<UserTable>;
