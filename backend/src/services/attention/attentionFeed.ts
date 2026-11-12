import {
  ATTENTION_EVENTS,
  ATTENTION_PROTOCOL,
  encodeAttentionFrame,
  type AttentionNotificationV1,
  type AttentionResolvedV1,
} from 'michi-shared';

/** One renderer feed: `send` receives complete SSE frames. */
export interface AttentionFeedSubscriber {
  send(frame: string): void;
}

/**
 * Owner-scoped fan-out of attention records to the renderer background feeds
 * (routes/michi.ts, POST /chats/background/subscribe). Until the attention
 * service connects its record store (server.ts), a subscription receives no
 * frame at all, not even a snapshot: the snapshot is also how a window learns
 * this backend decides notifications.
 */
export class AttentionFeed {
  private readonly subscribers = new Map<string, Set<AttentionFeedSubscriber>>();
  private snapshotSource: ((ownerUserId: string) => AttentionNotificationV1[]) | null = null;

  connect(snapshotSource: (ownerUserId: string) => AttentionNotificationV1[]): void {
    this.snapshotSource = snapshotSource;
  }

  disconnect(): void {
    this.snapshotSource = null;
  }

  /** Sends the owner's active records first, then every later change. */
  subscribe(ownerUserId: string, subscriber: AttentionFeedSubscriber): () => void {
    const source = this.snapshotSource;
    if (!source) return () => {};
    let set = this.subscribers.get(ownerUserId);
    if (!set) {
      set = new Set();
      this.subscribers.set(ownerUserId, set);
    }
    set.add(subscriber);
    let notifications: AttentionNotificationV1[] = [];
    try {
      notifications = source(ownerUserId);
    } catch {
      // An unreadable store still gets the window a (empty) snapshot.
    }
    this.deliver(subscriber, encodeAttentionFrame(ATTENTION_EVENTS.snapshot, { protocol: ATTENTION_PROTOCOL, notifications }));
    return () => {
      const current = this.subscribers.get(ownerUserId);
      if (!current?.delete(subscriber)) return;
      if (current.size === 0) this.subscribers.delete(ownerUserId);
    };
  }

  publishNotification(ownerUserId: string, notification: AttentionNotificationV1): void {
    this.publish(ownerUserId, encodeAttentionFrame(ATTENTION_EVENTS.notification, notification));
  }

  publishResolved(ownerUserId: string, resolved: AttentionResolvedV1): void {
    this.publish(ownerUserId, encodeAttentionFrame(ATTENTION_EVENTS.resolved, resolved));
  }

  subscriberCount(ownerUserId: string): number {
    return this.subscribers.get(ownerUserId)?.size ?? 0;
  }

  private publish(ownerUserId: string, frame: string): void {
    for (const subscriber of [...(this.subscribers.get(ownerUserId) ?? [])]) this.deliver(subscriber, frame);
  }

  private deliver(subscriber: AttentionFeedSubscriber, frame: string): void {
    try {
      subscriber.send(frame);
    } catch {
      // One broken stream must not stop the others.
    }
  }
}

export const attentionFeed = new AttentionFeed();
