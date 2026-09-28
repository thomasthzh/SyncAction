export type RoomErrorCode =
  | "INVALID_ROOM_INPUT"
  | "ROOM_NOT_FOUND"
  | "ROOM_OWNER_REQUIRED"
  | "USER_NOT_INVITABLE"
  | "INVITATION_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_CONFLICT"
  | "MEMBERSHIP_CONFLICT"
  | "OWNER_MUST_TRANSFER"
  | "ORDINARY_ROOM_LIMIT_REACHED"
  | "ROOM_TAB_LIMIT_REACHED"
  | "NOTIFICATION_NOT_FOUND"
  | "ROOM_NOT_PUBLIC"
  | "ROOM_JOIN_POLICY_MISMATCH"
  | "JOIN_REQUEST_NOT_FOUND"
  | "JOIN_REQUEST_CONFLICT"
  | "POLICY_VERSION_MISMATCH"
  | "INVALID_ROOM_TRANSITION";

export class RoomError extends Error {
  public readonly code: RoomErrorCode;

  public constructor(code: RoomErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "RoomError";
    this.code = code;
  }
}
