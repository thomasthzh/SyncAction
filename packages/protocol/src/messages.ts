import { z } from "zod";
import { CommittedOperationSchema, OperationAckSchema } from "./envelopes.js";
import {
  AnnotationAckSchema,
  AnnotationCommittedOperationSchema,
  AnnotationDeltaMessageSchema,
  AnnotationSnapshotMessageSchema,
  DanmakuAckSchema,
  DanmakuEventMessageSchema,
  StrokePreviewClearMessageSchema,
  StrokePreviewEventMessageSchema,
} from "./collaboration.js";
import {
  MediaCommandAckSchema,
  MediaGroupsSnapshotMessageSchema,
  MediaHeartbeatAckSchema,
} from "./media.js";
import {
  PointerAckSchema,
  PointerClearMessageSchema,
  PointerEventMessageSchema,
  PointerSnapshotMessageSchema,
  PresenceAckSchema,
  PresenceSnapshotMessageSchema,
  RoomDeltaMessageSchema,
  RoomSnapshotMessageSchema,
  SyncErrorMessageSchema,
} from "./sync.js";

export * from "./envelopes.js";

const NonMediaAckServerMessageSchema = z.discriminatedUnion("type", [
  OperationAckSchema,
  CommittedOperationSchema,
  RoomSnapshotMessageSchema,
  RoomDeltaMessageSchema,
  SyncErrorMessageSchema,
  PresenceAckSchema,
  PresenceSnapshotMessageSchema,
  PointerAckSchema,
  PointerEventMessageSchema,
  PointerClearMessageSchema,
  PointerSnapshotMessageSchema,
  MediaGroupsSnapshotMessageSchema,
  AnnotationAckSchema,
  AnnotationCommittedOperationSchema,
  AnnotationSnapshotMessageSchema,
  AnnotationDeltaMessageSchema,
  StrokePreviewEventMessageSchema,
  StrokePreviewClearMessageSchema,
  DanmakuAckSchema,
  DanmakuEventMessageSchema,
]);

export const ServerMessageSchema = z.union([
  NonMediaAckServerMessageSchema,
  MediaCommandAckSchema,
  MediaHeartbeatAckSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
