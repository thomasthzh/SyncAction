import { z } from "zod";
import { ClientOpIdSchema, DeviceIdSchema, RoomIdSchema } from "./identifiers.js";
import { DurableOperationSchema } from "./operations.js";

export const ProtocolVersionSchema = z.literal(1);
export const SequenceSchema = z.number().int().nonnegative().safe();

export const ClientOperationEnvelopeSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    clientOpId: ClientOpIdSchema,
    roomId: RoomIdSchema,
    roomEpoch: SequenceSchema,
    deviceId: DeviceIdSchema,
    baseServerSeq: SequenceSchema,
    operation: DurableOperationSchema,
  })
  .strict();

export const OperationAckSchema = z
  .object({
    type: z.literal("op.ack"),
    protocolVersion: ProtocolVersionSchema,
    clientOpId: ClientOpIdSchema,
    roomId: RoomIdSchema,
    roomEpoch: SequenceSchema,
    serverSeq: SequenceSchema,
  })
  .strict();

export const CommittedOperationSchema = z
  .object({
    type: z.literal("op.committed"),
    protocolVersion: ProtocolVersionSchema,
    clientOpId: ClientOpIdSchema,
    roomId: RoomIdSchema,
    roomEpoch: SequenceSchema,
    deviceId: DeviceIdSchema,
    serverSeq: SequenceSchema,
    operation: DurableOperationSchema,
  })
  .strict();

export type ClientOperationEnvelope = z.infer<typeof ClientOperationEnvelopeSchema>;
export type OperationAck = z.infer<typeof OperationAckSchema>;
export type CommittedOperation = z.infer<typeof CommittedOperationSchema>;
