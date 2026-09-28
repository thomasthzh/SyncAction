export type IdentityErrorCode =
  | "INVALID_INPUT"
  | "USERNAME_TAKEN"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_PENDING"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_REVOKED"
  | "SESSION_INVALID"
  | "SESSION_REPLAYED"
  | "RESET_GRANT_INVALID"
  | "ACTIVATION_KEY_INVALID"
  | "ACTIVATION_KEY_EXPIRED"
  | "ACTIVATION_KEY_USED"
  | "ACTIVATION_KEY_REVOKED"
  | "ACTIVATION_GRANT_NOT_FOUND"
  | "ACTIVATION_GRANT_NOT_ACTIVE"
  | "CURRENT_PASSWORD_INVALID"
  | "PASSWORD_ALREADY_CONFIGURED"
  | "ADMIN_INVALID_CREDENTIALS"
  | "ADMIN_SESSION_INVALID"
  | "ADMIN_ONBOARDING_REQUIRED"
  | "ADMIN_TOTP_REPLAYED"
  | "ADMIN_LINK_ALREADY_SET"
  | "ADMIN_LINK_TARGET_INVALID"
  | "INVALID_ACCOUNT_TRANSITION";

export class IdentityError extends Error {
  public readonly code: IdentityErrorCode;

  public constructor(code: IdentityErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "IdentityError";
    this.code = code;
  }
}
