import type {
  ClientOperationEnvelope,
  CommittedOperation,
  OperationAck,
  RoomDeltaMessage,
  RoomSnapshotMessage,
  RoomSyncRequest,
} from "@syncaction/protocol";

export interface ReplicaTransportHandlers {
  onCommitted(operation: CommittedOperation): void;
  onDisconnect(): void;
  onReconnect(): void;
}

export interface ReplicaTransport {
  connect(handlers: ReplicaTransportHandlers): Promise<void>;
  synchronize(request: RoomSyncRequest): Promise<RoomSnapshotMessage | RoomDeltaMessage>;
  submit(envelope: ClientOperationEnvelope): Promise<OperationAck>;
  disconnect(): Promise<void>;
}
