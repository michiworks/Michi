/**
 * OS notifications a renderer asks for over 'app:showNotification'. Kept free
 * of `electron` imports so it is testable in Node; main.ts owns the Electron
 * Notification objects and window focus.
 */

/** Real keys are a node or run id with a short prefix. */
const MAX_KEY_LENGTH = 1024;
/** Notifications held at once. An older one is let go (losing its click), so
 *  a session whose notifications never report 'close' stays bounded. */
const MAX_HELD = 32;

export interface RendererNotificationRequest {
  title: string;
  body: string;
  /** Set when a click should be reported back to the window that raised it. */
  key: string | null;
  silent: boolean;
}

/** Validates the IPC arguments: a string title, an optional `{ key, silent }` target. */
export function parseNotificationRequest(title: unknown, body: unknown, target: unknown): RendererNotificationRequest | null {
  if (typeof title !== 'string') return null;
  const fields = target && typeof target === 'object' ? target as Record<string, unknown> : null;
  const key = typeof fields?.key === 'string' && fields.key.length > 0 && fields.key.length <= MAX_KEY_LENGTH
    ? fields.key
    : null;
  return { title, body: typeof body === 'string' ? body : '', key, silent: fields?.silent === true };
}

interface Closable { close(): void }

/**
 * Holds each notification until it closes: Electron drops a Notification's
 * click handler once the object is garbage collected. One per window and key:
 * a newer notification for the same target closes the older one.
 */
export function createNotificationHolder<T extends Closable>(limit = MAX_HELD): {
  /** Returns the release to call when the notification is clicked or closed. */
  hold(windowId: number, key: string | null, notification: T): () => void;
} {
  const held = new Map<string, T>();
  let unkeyed = 0;
  return {
    hold(windowId, key, notification) {
      const slot = key === null ? `unkeyed:${++unkeyed}` : `${windowId}:${key}`;
      const previous = held.get(slot);
      held.delete(slot);
      if (previous && previous !== notification) previous.close();
      held.set(slot, notification);
      for (const oldest of held.keys()) {
        if (held.size <= limit) break;
        held.delete(oldest);
      }
      return () => {
        if (held.get(slot) === notification) held.delete(slot);
      };
    },
  };
}
