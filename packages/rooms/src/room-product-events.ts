import type {
  Notification,
  NotificationReadEvent,
  PublicRoomsInvalidated,
  RoomEventMessage,
} from "@syncaction/protocol";

export type ProductRealtimeEvent =
  | {
      readonly type: "ROOM_EVENT";
      readonly event: RoomEventMessage;
    }
  | {
      readonly type: "NOTIFICATION_CREATED";
      readonly recipientUserId: string;
      readonly notification: Notification;
    }
  | {
      readonly type: "NOTIFICATION_READ";
      readonly recipientUserId: string;
      readonly read: NotificationReadEvent;
    }
  | {
      readonly type: "PUBLIC_ROOMS_INVALIDATED";
      readonly message: PublicRoomsInvalidated;
    };

export interface RoomProductEventSink {
  publish(event: ProductRealtimeEvent): void;
}

export class RoomProductEventBus implements RoomProductEventSink {
  readonly #subscribers = new Set<(event: ProductRealtimeEvent) => void>();
  readonly #onSubscriberError: (cause: unknown) => void;

  public constructor(
    options: {
      onSubscriberError?: (cause: unknown) => void;
    } = {},
  ) {
    this.#onSubscriberError = options.onSubscriberError ?? (() => undefined);
  }

  public subscribe(subscriber: (event: ProductRealtimeEvent) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  public publish(event: ProductRealtimeEvent): void {
    for (const subscriber of [...this.#subscribers]) {
      try {
        subscriber(structuredClone(event));
      } catch (cause) {
        try {
          this.#onSubscriberError(cause);
        } catch {
          // A diagnostic callback cannot turn an already-committed mutation into a failure.
        }
      }
    }
  }
}

export const NULL_ROOM_PRODUCT_EVENT_SINK: RoomProductEventSink = Object.freeze({
  publish: () => undefined,
});
