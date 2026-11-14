import {
  ATTENTION_EVENTS,
  ATTENTION_PROTOCOL,
  encodeAttentionFrame,
  type AttentionNotificationV1,
  type AttentionResolvedV1,
} from 'michi-shared';

/** One feed: `send` receives complete SSE frames. */
export interface AttentionFeedSubscriber {
  send(frame: string): void;
  /**
   * Electron main's desktop notifier (routes/attention.ts,
   * ATTENTION_DESKTOP_STREAM_PATH), not a window: it gets only the records
   * `accepts` lets through (the user's level), snapshot included, and every
   * resolution. Its presence is what desktopAbsentForMs measures.
   */
  desktop?: { accepts(notification: AttentionNotificationV1): boolean };
}

/**
 * Owner-scoped fan-out of attention records to the renderer background feeds
 * (routes/michi.ts, POST /chats/background/subscribe) and to the desktop
 * notifier. Until the attention service connects its record store
 * (server.ts), a subscription receives no frame at all, not even a snapshot:
 * the snapshot is also how a window learns this backend decides
 * notifications.
 */
export class AttentionFeed {
  private readonly subscribers = new Map<string, Set<AttentionFeedSubscriber>>();
  private snapshotSource: ((ownerUserId: string) => AttentionNotificationV1[]) | null = null;
  private desktops = 0;
  /** When a desktop notifier was last connected; boot counts, so one reconnecting after a restart is not taken for a quit app. */
  private desktopSeenAt: number;

  constructor(private readonly clock: () => number = Date.now) {
    this.desktopSeenAt = clock();
  }

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
    if (subscriber.desktop) {
      this.desktops += 1;
      this.desktopSeenAt = this.clock();
    }
    let notifications: AttentionNotificationV1[] = [];
    try {
      notifications = source(ownerUserId).filter((notification) => accepted(subscriber, notification));
    } catch {
      // An unreadable store still gets the window a (empty) snapshot.
    }
    this.deliver(subscriber, encodeAttentionFrame(ATTENTION_EVENTS.snapshot, { protocol: ATTENTION_PROTOCOL, notifications }));
    return () => {
      const current = this.subscribers.get(ownerUserId);
      if (!current?.delete(subscriber)) return;
      if (current.size === 0) this.subscribers.delete(ownerUserId);
      if (subscriber.desktop) {
        this.desktops -= 1;
        this.desktopSeenAt = this.clock();
      }
    };
  }

  publishNotification(ownerUserId: string, notification: AttentionNotificationV1): void {
    const frame = encodeAttentionFrame(ATTENTION_EVENTS.notification, notification);
    for (const subscriber of [...(this.subscribers.get(ownerUserId) ?? [])]) {
      if (accepted(subscriber, notification)) this.deliver(subscriber, frame);
    }
  }

  publishResolved(ownerUserId: string, resolved: AttentionResolvedV1): void {
    this.publish(ownerUserId, encodeAttentionFrame(ATTENTION_EVENTS.resolved, resolved));
  }

  subscriberCount(ownerUserId: string): number {
    return this.subscribers.get(ownerUserId)?.size ?? 0;
  }

  /** Milliseconds since a desktop notifier was last connected (0 while one is). */
  desktopAbsentForMs(): number {
    return this.desktops > 0 ? 0 : Math.max(0, this.clock() - this.desktopSeenAt);
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

function accepted(subscriber: AttentionFeedSubscriber, notification: AttentionNotificationV1): boolean {
  if (!subscriber.desktop) return true;
  try {
    return subscriber.desktop.accepts(notification);
  } catch {
    return true;
  }
}

export const attentionFeed = new AttentionFeed();
