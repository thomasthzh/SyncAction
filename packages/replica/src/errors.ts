import type { SyncErrorCode } from "@syncaction/protocol";

export type ReplicaPermanentServerCode = Extract<SyncErrorCode, "ROOM_TAB_LIMIT_REACHED">;

export type ReplicaErrorCode =
  | "CORRUPT_REPLICA"
  | "STORAGE_FAILURE"
  | "INVALID_REPLICA_TRANSITION"
  | "INVALID_REMOTE_STATE"
  | "LOCAL_INTENT_NOT_ALLOWED"
  | "OPTIMISTIC_CONFLICT"
  | "OUTBOX_OPERATION_NOT_FOUND"
  | "ACK_MISMATCH"
  | "SEQUENCE_GAP";

export class ReplicaError extends Error {
  public readonly code: ReplicaErrorCode;

  public constructor(code: ReplicaErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "ReplicaError";
    this.code = code;
  }
}

export class ReplicaPermanentOperationError extends Error {
  public readonly code = "PERMANENT_OPERATION_REJECTED";
  public readonly serverCode: ReplicaPermanentServerCode;

  public constructor(serverCode: ReplicaPermanentServerCode, options?: ErrorOptions) {
    super("PERMANENT_OPERATION_REJECTED", options);
    this.name = "ReplicaPermanentOperationError";
    this.serverCode = serverCode;
  }
}
