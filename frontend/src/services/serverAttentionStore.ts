import {
  ATTENTION_EVENTS,
  ATTENTION_PROTOCOL,
  isAttentionEventName,
  parseAttentionNotification,
  parseAttentionResolved,
  parseAttentionSnapshot,
  type AttentionNotificationV1,
  type AttentionResolvedV1,
} from 'michi-shared';
import { LOCAL_BACKEND_CONNECTION_ID } from '../config/backendConnections';

/**
 * The attention records each backend connection delivered on its background
 * feed (attention_* frames, shared/src/attention.ts). Kept per connection:
 * a snapshot replaces that connection's records, a notification adds (and
 * may supersede) one, a resolution removes one. A leaf module on purpose:
 * the feed parser (services/api/stream.ts) writes here without importing the
 * presentation adapter (services/serverAttention.ts), which reads here.
 */

export type ServerAttentionFrame =
  | { type: 'snapshot'; connectionId: string; notifications: AttentionNotificationV1[] }
  | { type: 'notification'; connectionId: string; notification: AttentionNotificationV1 }
  | { type: 'resolved'; connectionId: string; resolved: AttentionResolvedV1 };

const recordsByConnection = new Map<string, Map<string, AttentionNotificationV1>>();
/** Connections whose feed delivered a snapshot: their backend decides attention. */
const deciding = new Set<string>();
/** Connections whose capability probe advertised server attention. */
const capable = new Set<string>();
const listeners = new Set<(frame: ServerAttentionFrame) => void>();

/** The backend advertises server attention (GET /persistence/capabilities). */
export function supportsServerAttention(capabilities: { attention?: unknown } | null | undefined): boolean {
  return capabilities?.attention === ATTENTION_PROTOCOL;
}

/** Records what a capability probe of `connectionId` answered. */
export function noteServerAttentionCapabilities(connectionId: string, capabilities: { attention?: unknown } | null | undefined): void {
  if (supportsServerAttention(capabilities)) capable.add(connectionId);
  else capable.delete(connectionId);
}

/**
 * The backend of this connection decides notifications: it advertised the
 * capability, or its feed delivered an attention snapshot. While true, the
 * window's own triggers for that connection would duplicate the server's.
 */
export function isServerAttentionActive(connectionId = LOCAL_BACKEND_CONNECTION_ID): boolean {
  return capable.has(connectionId) || deciding.has(connectionId);
}

export function isServerAttentionEvent(event: string): boolean {
  return isAttentionEventName(event);
}

function parseFrame(connectionId: string, event: string, value: unknown): ServerAttentionFrame | null {
  if (event === ATTENTION_EVENTS.snapshot) {
    const snapshot = parseAttentionSnapshot(value);
    return snapshot ? { type: 'snapshot', connectionId, notifications: snapshot.notifications } : null;
  }
  if (event === ATTENTION_EVENTS.notification) {
    const notification = parseAttentionNotification(value);
    return notification ? { type: 'notification', connectionId, notification } : null;
  }
  if (event === ATTENTION_EVENTS.resolved) {
    const resolved = parseAttentionResolved(value);
    return resolved ? { type: 'resolved', connectionId, resolved } : null;
  }
  return null;
}

function apply(frame: ServerAttentionFrame): void {
  if (frame.type === 'snapshot') {
    deciding.add(frame.connectionId);
    recordsByConnection.set(frame.connectionId, new Map(frame.notifications.map((record) => [record.id, record])));
    return;
  }
  let records = recordsByConnection.get(frame.connectionId);
  if (!records) {
    records = new Map();
    recordsByConnection.set(frame.connectionId, records);
  }
  if (frame.type === 'notification') {
    // One active record per key: a newer one replaces the older (its resolution follows).
    for (const [id, record] of records) if (record.key === frame.notification.key) records.delete(id);
    records.set(frame.notification.id, frame.notification);
    return;
  }
  records.delete(frame.resolved.id);
}

/**
 * One attention_* frame from the background feed of `connectionId`.
 * Malformed frames are ignored, like the feed's other control frames.
 */
export function receiveServerAttentionFrame(connectionId: string, event: string, data: string): void {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return;
  }
  const frame = parseFrame(connectionId, event, value);
  if (!frame) return;
  apply(frame);
  for (const listener of [...listeners]) {
    try {
      listener(frame);
    } catch {
      // A failing presenter must not stop the feed.
    }
  }
}

/** Every frame after it is applied to the store. Returns the unsubscribe function. */
export function onServerAttentionFrame(listener: (frame: ServerAttentionFrame) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The active record, or undefined once it resolved (or was never seen). */
export function activeServerAttentionRecord(connectionId: string, id: string): AttentionNotificationV1 | undefined {
  return recordsByConnection.get(connectionId)?.get(id);
}

/**
 * The connection's active records, oldest first.
 * @testonly
 */
export function activeServerAttentionRecords(connectionId: string): AttentionNotificationV1[] {
  return [...(recordsByConnection.get(connectionId)?.values() ?? [])].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Forget every connection and listener between test cases.
 * @testonly
 */
export function resetServerAttentionStore(): void {
  recordsByConnection.clear();
  deciding.clear();
  capable.clear();
  listeners.clear();
}
