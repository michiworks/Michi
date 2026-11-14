/**
 * Electron main's one notification subscription (DESIGN P4, D12): the
 * backend's attention records on its desktop feed
 * (GET /api/attention/desktop/stream, routes/attention.ts), which also
 * carries `companion_changed` for the tray (tray.ts). It replaces the
 * Companion's and the scheduler's own notice streams.
 *
 * The attention service alone decides what deserves the user's attention;
 * the feed sends only what the user's level lets through. Windows present
 * the records themselves (frontend/src/services/serverAttention.ts), so
 * Electron main shows one only while no Michi window is open: it claims the
 * record for the desktop notifier first (the claim is the acknowledgement;
 * a window that opens later lists it without raising it again), then raises
 * an OS banner whose click opens the record's target. A resolved record
 * takes its banner down. On (re)connect the snapshot's records not claimed
 * yet and not older than ATTENTION_DESKTOP_REPLAY_MS are shown, the newest
 * ATTENTION_DESKTOP_REPLAY_MAX of them: what a woken app was woken for.
 *
 * Also here, because a click needs them: the Companion targets a click opens
 * (CompanionTarget, mirrored from shared), the window parameter a banner's
 * click puts its target in, and CompanionRenderers, which holds a click for
 * a window whose renderer does not listen yet.
 *
 * Nothing here imports `electron`: main injects its Notification class and
 * windows, so all of it is testable in Node.
 */
import * as http from 'node:http';

// ── Mirrors of shared (Electron main does not load workspace packages) ───────
// scripts/electron-attention-notifications.test.mjs keeps them equal to shared's.

export type CompanionTab = 'chat' | 'today';

/** shared CompanionTarget: where clicking a Companion row or notice takes the user. */
export type CompanionTarget =
  | { kind: 'node'; workspaceId: string; nodeId: string }
  | { kind: 'url'; url: string }
  /** itemId (Today only): the item to scroll to and highlight. */
  | { kind: 'companion'; tab: CompanionTab; itemId?: string }
  | { kind: 'settings' };

/** shared AttentionTargetV1. */
export type AttentionTarget =
  | { type: 'node'; nodeId: string; workspaceId: string }
  | { type: 'agent_run'; runId: string; workspaceId: string }
  | { type: 'agent'; ref: string; open: CompanionTarget; workspaceId: string }
  | { type: 'scheduled_run'; runId: string; jobId: string; nodeId: string | null; workspaceId: string };

/** The part of shared AttentionNotificationV1 a banner needs. */
export interface AttentionRecord {
  id: string;
  key: string;
  kind: 'needs_input' | 'finished' | 'failed';
  reason: string;
  title: string;
  body: string;
  target: AttentionTarget;
  createdAt: number;
  claimedByWindowId: string | null;
}

/** shared ATTENTION_EVENTS. */
export const ATTENTION_SNAPSHOT_EVENT = 'attention_snapshot';
export const ATTENTION_NOTIFICATION_EVENT = 'attention_notification';
export const ATTENTION_RESOLVED_EVENT = 'attention_resolved';
/** shared ATTENTION_PROTOCOL. */
export const ATTENTION_PROTOCOL = 'v1';

/** `'/api' + ATTENTION_DESKTOP_STREAM_PATH` (shared). */
export const ATTENTION_DESKTOP_STREAM_PATH = '/api/attention/desktop/stream';

/** `'/api' + attentionDesktopClaimPath(id)` (shared). */
export function attentionDesktopClaimPath(id: string): string {
  return `/api/attention/desktop/notifications/${encodeURIComponent(id)}/claim`;
}

/**
 * The tray's refresh signal on the same feed: the agent's state moved, so the
 * tray fetches its menu data again. The frame is shared CompanionChangedEvent;
 * main reads only that it arrived.
 */
export const COMPANION_CHANGED_EVENT = 'companion_changed';

export interface CompanionChangedFrame {
  type: 'companion_changed';
  revision: number;
  reason: string;
}

/**
 * Query parameter carrying a click's Companion target (JSON) into the window
 * it opened; preload.ts reads it into `initialCompanionTarget`.
 */
export const COMPANION_TARGET_PARAM = 'michiCompanionTarget';

/**
 * Preload → main, `[kind, listening]`: a window's renderer started or
 * stopped listening for notification clicks ('open'). Only the preload sends
 * it; the renderer bridge has no method for it. preload.ts mirrors the name
 * (a sandboxed preload loads only 'electron').
 */
export const COMPANION_READY_CHANNEL = 'companion:ready';

/** How long a record is worth a banner when the feed (re)connects: what a woken app was woken for. */
export const ATTENTION_DESKTOP_REPLAY_MS = 60 * 60_000;
/** At most this many banners on (re)connect, the newest. */
export const ATTENTION_DESKTOP_REPLAY_MAX = 3;

const MAX_ID_CHARS = 160;
const MAX_URL_CHARS = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** An http(s) URL; the prefix test is the one preload.ts applies to a target in a window URL. */
function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS || !/^https?:\/\/\S/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** A well-formed Companion target rebuilt from its known fields; null for anything else (shared parseAttentionOpenTarget). */
export function parseCompanionTarget(value: unknown): CompanionTarget | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'node':
      return isId(value.workspaceId) && isId(value.nodeId)
        ? { kind: 'node', workspaceId: value.workspaceId, nodeId: value.nodeId }
        : null;
    case 'url':
      return isWebUrl(value.url) ? { kind: 'url', url: value.url } : null;
    case 'companion':
      if (value.tab !== 'chat' && value.tab !== 'today') return null;
      // The item to bring into view, on Today only; a malformed one leaves just the tab.
      return value.tab === 'today' && isId(value.itemId)
        ? { kind: 'companion', tab: 'today', itemId: value.itemId }
        : { kind: 'companion', tab: value.tab };
    case 'settings':
      return { kind: 'settings' };
    default:
      return null;
  }
}

/** shared parseAttentionTarget. */
export function parseAttentionTarget(value: unknown): AttentionTarget | null {
  if (!isRecord(value) || !isText(value.workspaceId)) return null;
  const workspaceId = value.workspaceId;
  switch (value.type) {
    case 'node':
      return isText(value.nodeId) ? { type: 'node', nodeId: value.nodeId, workspaceId } : null;
    case 'agent_run':
      return isText(value.runId) ? { type: 'agent_run', runId: value.runId, workspaceId } : null;
    case 'agent': {
      const open = parseCompanionTarget(value.open);
      return isText(value.ref) && open ? { type: 'agent', ref: value.ref, open, workspaceId } : null;
    }
    case 'scheduled_run':
      return isText(value.runId) && isText(value.jobId) && (value.nodeId === null || isText(value.nodeId))
        ? { type: 'scheduled_run', runId: value.runId, jobId: value.jobId, nodeId: value.nodeId, workspaceId }
        : null;
    default:
      return null;
  }
}

const KINDS: ReadonlySet<string> = new Set(['needs_input', 'finished', 'failed']);

/** A record from the feed, rebuilt from its known fields; null for a malformed one (a target this build cannot place included). */
export function parseAttentionRecord(value: unknown): AttentionRecord | null {
  if (!isRecord(value)) return null;
  const { id, key, kind, reason, title, body, createdAt, claimedByWindowId } = value;
  if (!isText(id) || !isText(key) || typeof kind !== 'string' || !KINDS.has(kind) || !isText(reason)) return null;
  if (typeof title !== 'string' || typeof body !== 'string' || !isTime(createdAt)) return null;
  if (claimedByWindowId !== null && claimedByWindowId !== undefined && !isText(claimedByWindowId)) return null;
  const target = parseAttentionTarget(value.target);
  if (!target) return null;
  return {
    id, key, kind: kind as AttentionRecord['kind'], reason, title, body, target, createdAt,
    claimedByWindowId: typeof claimedByWindowId === 'string' ? claimedByWindowId : null,
  };
}

/** A `companion_changed` frame's data, or null for a malformed one. */
export function parseCompanionChangedFrame(value: unknown): CompanionChangedFrame | null {
  if (!isRecord(value) || value.type !== 'companion_changed') return null;
  if (typeof value.revision !== 'number' || !Number.isFinite(value.revision) || typeof value.reason !== 'string') return null;
  return { type: 'companion_changed', revision: value.revision, reason: value.reason };
}

/** Incremental SSE parser: feed text chunks, receive complete events. */
export function createSseParser(onEvent: (event: string, data: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0) onEvent(event, data.join('\n'));
      boundary = buffer.indexOf('\n\n');
    }
    // Defend against a peer that never terminates a frame.
    if (buffer.length > 1_000_000) buffer = '';
  };
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/** The part of an Electron Notification a banner uses. */
export interface AttentionBanner {
  on(event: 'click' | 'close', listener: () => void): unknown;
  show(): void;
  close?(): void;
}

/** Electron's Notification class (a double in tests). */
export interface AttentionBannerClass {
  new (options: { title: string; body: string }): AttentionBanner;
  isSupported(): boolean;
}

/** What became of a record. */
export type AttentionDeliveryOutcome =
  /** A banner went up. */
  | 'banner'
  /** A Michi window is open: it presents the record itself. */
  | 'window'
  /** A window (or this notifier, before a reconnect) holds its claim already, or won the race for it. */
  | 'claimed'
  /** Shown here already. */
  | 'duplicate'
  /** A replayed record too old to be worth a banner. */
  | 'old'
  /** It was resolved before its claim came back. */
  | 'resolved'
  /** No OS notifications here, or the claim failed: nothing to show it with. */
  | 'unavailable';

export interface AttentionNotifierHost {
  Notification: AttentionBannerClass;
  /** A Michi window exists: its renderer presents the records (serverAttention.ts). */
  hasOpenWindow(): boolean;
  /** Claims the record for the desktop notifier; true when this notifier holds the claim. */
  claim(id: string): Promise<boolean>;
  /** Bring Michi forward at the record's target: a banner click. */
  open(target: AttentionTarget): void;
  now(): number;
  /** A banner went up: Michi may have no window open. */
  onBackgroundDelivery?(): void;
  /** What became of a record (ids and outcomes only: no text). */
  onHandled?(record: AttentionRecord, outcome: AttentionDeliveryOutcome): void;
}

/** Ids remembered so a record is not shown twice. */
const MAX_REMEMBERED = 200;
/** Banners on screen kept, so their click handlers are not garbage-collected. */
const MAX_LIVE_BANNERS = 50;

/**
 * Shows each record at most once, as an OS banner, while no Michi window is
 * open; takes the banner down once the record is resolved.
 */
export class AttentionNotifier {
  private readonly banners = new Map<string, AttentionBanner>();
  private readonly shown = new Set<string>();
  /** Records whose claim is on its way; true once one was resolved meanwhile. */
  private readonly claiming = new Map<string, boolean>();

  constructor(private readonly host: AttentionNotifierHost) {}

  /** The feed's first frame on each connection: the newest recent unclaimed records are shown. */
  snapshot(records: readonly AttentionRecord[]): void {
    const now = this.host.now();
    const recent = records.filter((record) => record.claimedByWindowId === null && now - record.createdAt <= ATTENTION_DESKTOP_REPLAY_MS)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-ATTENTION_DESKTOP_REPLAY_MAX);
    const wanted = new Set(recent.map((record) => record.id));
    for (const record of records) {
      if (wanted.has(record.id)) void this.deliver(record);
      else this.host.onHandled?.(record, record.claimedByWindowId === null ? 'old' : 'claimed');
    }
  }

  /** A record decided now. */
  notification(record: AttentionRecord): Promise<AttentionDeliveryOutcome> {
    return this.deliver(record);
  }

  /** A record is no longer active: its banner goes, and one still being claimed is not shown. */
  resolved(id: string): void {
    if (this.claiming.has(id)) this.claiming.set(id, true);
    const banner = this.banners.get(id);
    if (!banner) return;
    this.banners.delete(id);
    try {
      banner.close?.();
    } catch {
      // A banner the OS already took down.
    }
  }

  private async deliver(record: AttentionRecord): Promise<AttentionDeliveryOutcome> {
    const outcome = await this.decide(record);
    this.host.onHandled?.(record, outcome);
    return outcome;
  }

  private async decide(record: AttentionRecord): Promise<AttentionDeliveryOutcome> {
    if (this.shown.has(record.id) || this.claiming.has(record.id)) return 'duplicate';
    if (record.claimedByWindowId !== null) return 'claimed';
    if (this.host.hasOpenWindow()) return 'window';
    if (!this.host.Notification.isSupported()) return 'unavailable';
    this.claiming.set(record.id, false);
    let claimed = false;
    try {
      claimed = await this.host.claim(record.id);
    } catch {
      claimed = false;
    }
    const resolvedMeanwhile = this.claiming.get(record.id) === true;
    this.claiming.delete(record.id);
    if (resolvedMeanwhile) return 'resolved';
    if (!claimed) return 'claimed';
    // A window may have opened while the claim was on its way: it lists the record, and this banner still says it once.
    this.remember(record.id);
    this.showBanner(record);
    this.host.onBackgroundDelivery?.();
    return 'banner';
  }

  private showBanner(record: AttentionRecord): void {
    const banner = new this.host.Notification({ title: record.title, body: record.body });
    this.banners.set(record.id, banner);
    banner.on('click', () => {
      this.banners.delete(record.id);
      this.host.open(record.target);
    });
    banner.on('close', () => { if (this.banners.get(record.id) === banner) this.banners.delete(record.id); });
    banner.show();
    trimOldest(this.banners, MAX_LIVE_BANNERS);
  }

  private remember(id: string): void {
    this.shown.add(id);
    trimOldest(this.shown, MAX_REMEMBERED);
  }
}

/** Sets and maps iterate in insertion order: drop the oldest entries beyond `max`. */
function trimOldest<K>(collection: { readonly size: number; keys(): Iterable<K>; delete(key: K): unknown }, max: number): void {
  for (const key of collection.keys()) {
    if (collection.size <= max) return;
    collection.delete(key);
  }
}

// ── Windows ──────────────────────────────────────────────────────────────────

/**
 * Michi windows (by webContents id) whose renderers listen for notification
 * clicks, as each window's preload reports on COMPANION_READY_CHANNEL, and
 * the click waiting for a window whose renderer does not listen yet (it
 * would be lost while the window it brought forward is still loading).
 */
export class CompanionRenderers {
  private readonly listening = new Set<number>();
  private readonly pendingOpen = new Map<number, CompanionTarget>();

  /** `sendOpen` hands a click to the window's renderer ('companion:open'). */
  constructor(private readonly sendOpen: (windowId: number, target: CompanionTarget) => void) {}

  /** A preload's report, `[kind, listening]` as it arrived; a malformed one is ignored. True when it changed anything. */
  report(windowId: number, kind: unknown, listening: unknown): boolean {
    if (kind !== 'open' || typeof listening !== 'boolean') return false;
    if (this.listening.has(windowId) === listening) return false;
    if (listening) this.listening.add(windowId);
    else this.listening.delete(windowId);
    if (listening) this.flushOpen(windowId);
    return true;
  }

  listens(windowId: number): boolean {
    return this.listening.has(windowId);
  }

  /**
   * The window's document went away (a navigation, a crash): its next
   * renderer listens once it says so. A click waiting for the window goes to
   * that renderer. True when it changed anything.
   */
  documentGone(windowId: number): boolean {
    return this.listening.delete(windowId);
  }

  /** The window closed. */
  forget(windowId: number): void {
    this.listening.delete(windowId);
    this.pendingOpen.delete(windowId);
  }

  /** A notification click for the window: delivered now if its renderer listens for clicks, otherwise once it does. A later click replaces it. */
  open(windowId: number, target: CompanionTarget): void {
    this.pendingOpen.set(windowId, target);
    if (this.listens(windowId)) this.flushOpen(windowId);
  }

  private flushOpen(windowId: number): void {
    const target = this.pendingOpen.get(windowId);
    if (!target) return;
    this.pendingOpen.delete(windowId);
    this.sendOpen(windowId, target);
  }
}

// ── Feed ─────────────────────────────────────────────────────────────────────

export interface AttentionDesktopFeedOptions {
  /** Current backend port; null pauses the feed. */
  port(): number | null;
  /** The first frame on each connection: the records active now (as far as the level lets through). */
  onSnapshot(records: AttentionRecord[]): void;
  onNotification(record: AttentionRecord): void;
  onResolved(id: string): void;
  /** A connection opened (changes made while the feed was away sent no frame here). */
  onConnected?(): void;
  /** A `companion_changed` frame: the agent's state moved (the tray fetches its data again). */
  onChanged?(event: CompanionChangedFrame): void;
  log?(level: 'INFO' | 'WARN', message: string, meta?: Record<string, unknown>): void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Wait after the backend refuses the stream (an older backend without it, …). */
  refusedRetryMs?: number;
  /** A connection silent this long is dead: the backend sends a keepalive every 15s. */
  idleTimeoutMs?: number;
}

/** Long-lived, self-reconnecting subscription to ATTENTION_DESKTOP_STREAM_PATH, and the claim it makes before a banner. */
export class AttentionDesktopFeed {
  private request: http.ClientRequest | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  /** Status of the last refusal: logged once, not on every retry. */
  private refusedStatus: number | null = null;

  constructor(private readonly options: AttentionDesktopFeedOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.request?.destroy();
    this.request = null;
  }

  /** Drop the current connection and reconnect now (e.g. after a backend handoff). */
  restart(): void {
    this.stop();
    this.attempt = 0;
    this.start();
  }

  /** POST the desktop claim; true when the desktop notifier holds it. A failure is no claim. */
  claim(id: string): Promise<boolean> {
    const port = this.options.port();
    if (!port) return Promise.resolve(false);
    return new Promise((resolve) => {
      const payload = '{}';
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: attentionDesktopClaimPath(id),
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
        timeout: 5_000,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { if (text.length < 10_000) text += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(false); return; }
          try {
            const answer = JSON.parse(text) as { claimed?: unknown };
            resolve(answer.claimed === true);
          } catch {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
      req.end(payload);
    });
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped) return;
    const base = this.options.reconnectBaseMs ?? 1_000;
    const max = this.options.reconnectMaxMs ?? 15_000;
    const delay = delayMs ?? Math.min(max, base * 2 ** this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  private handleFrame(event: string, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // A malformed frame.
    }
    try {
      switch (event) {
        case ATTENTION_SNAPSHOT_EVENT: {
          if (!isRecord(parsed) || parsed.protocol !== ATTENTION_PROTOCOL || !Array.isArray(parsed.notifications)) return;
          this.options.onSnapshot(parsed.notifications.map(parseAttentionRecord).filter((record): record is AttentionRecord => record !== null));
          return;
        }
        case ATTENTION_NOTIFICATION_EVENT: {
          const record = parseAttentionRecord(parsed);
          if (record) this.options.onNotification(record);
          return;
        }
        case ATTENTION_RESOLVED_EVENT:
          if (isRecord(parsed) && isText(parsed.id)) this.options.onResolved(parsed.id);
          return;
        case COMPANION_CHANGED_EVENT: {
          const changed = parseCompanionChangedFrame(parsed);
          if (changed) this.options.onChanged?.(changed);
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this.options.log?.('WARN', 'attention frame handling failed', { event, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const port = this.options.port();
    if (!port) {
      this.scheduleReconnect();
      return;
    }
    const parse = createSseParser((event, data) => this.handleFrame(event, data));
    let refused = false;
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: ATTENTION_DESKTOP_STREAM_PATH,
      headers: { accept: 'text/event-stream' },
    }, (res) => {
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      if (res.statusCode !== 200 || !contentType.startsWith('text/event-stream')) {
        res.resume();
        refused = true;
        // 404: an older backend without the desktop feed; retry slowly in case it restarts.
        if (this.refusedStatus !== res.statusCode) {
          this.options.log?.('WARN', 'attention desktop feed refused', { status: res.statusCode });
        }
        this.refusedStatus = res.statusCode ?? 0;
        return;
      }
      this.attempt = 0;
      this.refusedStatus = null;
      this.options.log?.('INFO', 'attention desktop feed connected', { port });
      this.options.onConnected?.();
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => parse(chunk));
    });
    // The backend writes a keepalive every 15s; silence means a dead connection.
    req.setTimeout(this.options.idleTimeoutMs ?? 60_000, () => req.destroy());
    req.on('close', () => {
      // A request replaced by restart() or ended by stop() must not reconnect.
      if (this.request !== req) return;
      this.request = null;
      this.scheduleReconnect(refused ? this.options.refusedRetryMs ?? 60_000 : undefined);
    });
    req.on('error', () => { /* close follows */ });
    this.request = req;
  }
}
