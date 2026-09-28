import {
  CanonicalUuidSchema,
  PointerFrameEventSchema,
  PointerFrameSchema,
  type PointerFrameEvent,
  type PointerLeaseRecord,
} from "@syncaction/protocol";
import { SyncError } from "./errors.js";
import type { PresencePrincipal } from "./presence-service.js";

export interface ActivePointerLeasePort {
  findActiveLease(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    roomId: unknown;
    leaseId: unknown;
  }): PointerLeaseRecord | null;
}

export interface RoomPointerFrameServiceOptions {
  leases: ActivePointerLeasePort;
  now?: () => Date;
}

export class RoomPointerFrameService {
  readonly #leases: ActivePointerLeasePort;
  readonly #now: () => Date;
  readonly #latestSequenceByLease = new Map<string, number>();

  public constructor(options: RoomPointerFrameServiceOptions) {
    this.#leases = options.leases;
    this.#now = options.now ?? (() => new Date());
  }

  public accept(input: {
    principal: PresencePrincipal;
    socketId: unknown;
    frame: unknown;
  }): PointerFrameEvent | null {
    const receivedAtServerMs = this.#validatedNowMs();
    const parsed = PointerFrameSchema.safeParse(input.frame);
    if (!parsed.success) {
      throw new SyncError("INVALID_SYNC_MESSAGE", { cause: parsed.error });
    }
    const frame = parsed.data;
    const lease = this.#leases.findActiveLease({
      principal: input.principal,
      socketId: input.socketId,
      roomId: frame.roomId,
      leaseId: frame.leaseId,
    });
    if (lease === null) {
      return null;
    }
    const latestSequence = this.#latestSequenceByLease.get(frame.leaseId);
    if (latestSequence !== undefined && frame.seq <= latestSequence) {
      return null;
    }
    this.#latestSequenceByLease.set(frame.leaseId, frame.seq);
    return PointerFrameEventSchema.parse({
      type: "pointer.frame",
      protocolVersion: 1,
      roomId: frame.roomId,
      userId: lease.userId,
      deviceId: lease.deviceId,
      leaseId: frame.leaseId,
      seq: frame.seq,
      xQuantized: frame.xQuantized,
      yQuantized: frame.yQuantized,
      viewport: frame.viewport,
      receivedAtServerMs,
    });
  }

  public latestSequence(leaseIdInput: unknown): number | null {
    const leaseId = CanonicalUuidSchema.parse(leaseIdInput);
    return this.#latestSequenceByLease.get(leaseId) ?? null;
  }

  public forget(leaseIdInput: unknown): void {
    const leaseId = CanonicalUuidSchema.parse(leaseIdInput);
    this.#latestSequenceByLease.delete(leaseId);
  }

  #validatedNowMs(): number {
    const nowMs = this.#now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
      throw new SyncError("RECOVERY_REQUIRED");
    }
    return nowMs;
  }
}
