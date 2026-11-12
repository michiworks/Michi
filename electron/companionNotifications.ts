/**
 * Electron-main client for the Companion's desktop notices
 * (GET /api/companion/notifications/stream), and the stream's change
 * signal for the tray (tray.ts).
 *
 * The scheduled-run pipeline (scheduledNotifications.ts) for the Companion:
 * a self-reconnecting SSE feed, one delivery plan (a focused Michi window
 * gets an in-app toast; otherwise an OS banner whose click opens the
 * Companion at the notice's target), then an acknowledgement so the backend
 * stops replaying the notice. Stale notices are never shown.
 *
 * A toast needs a renderer that listens: Electron drops a message nothing
 * listens for, and the renderer subscribes only once the workspace has
 * loaded, seconds after its window has focus. Each window's preload reports
 * when its renderer listens (COMPANION_READY_CHANNEL, CompanionRenderers);
 * until then a notice for that window waits, neither shown nor acknowledged
 * (CompanionNotifier), and so does a notification click (CompanionRenderers).
 *
 * Nothing here imports `electron`: main injects its Notification class and
 * windows, so all of it is testable in Node.
 */
import * as http from 'node:http';
import { createSseParser } from './scheduledNotifications';

// ── Mirror of shared/src/companion.ts (Electron main does not load workspace packages) ──

export type CompanionTab = 'chat' | 'today';

/** Where clicking a notice takes the user. */
export type CompanionTarget =
  | { kind: 'node'; workspaceId: string; nodeId: string }
  | { kind: 'url'; url: string }
  /** itemId (Today only): the item to scroll to and highlight, e.g. the one a notice is about. */
  | { kind: 'companion'; tab: CompanionTab; itemId?: string }
  | { kind: 'settings' };

/**
 * Which gate a notice came through (DESIGN-v2 §5.2): the agent's own
 * (`companion`), or a conversation's approval, question or reply that the
 * backend sends while no Michi window is open (`chat`). Both show the same way.
 */
export type CompanionNoticeChannel = 'companion' | 'chat';

/** One desktop notice the Companion wants shown (replayed until acknowledged). */
export interface CompanionNotice {
  id: string;
  title: string;
  body: string;
  target: CompanionTarget;
  itemIds: string[];
  createdAt: number;
  /** After this the notice is stale and must not be shown. */
  expiresAt: number;
  /**
   * Set on a parsed notice only for `chat`; absent is `companion`, the way
   * the backend writes it (shared CompanionNotice). Read it with
   * companionNoticeChannel.
   */
  channel?: CompanionNoticeChannel;
}

export const COMPANION_NOTICE_EVENT = 'companion_notice';

/**
 * The notifier feed's change signal (W3-H adds it to the stream): the
 * agent's state moved, so the tray fetches its menu data again. The frame is
 * shared CompanionChangedEvent; main reads only that it arrived.
 */
export const COMPANION_CHANGED_EVENT = 'companion_changed';

export interface CompanionChangedFrame {
  type: 'companion_changed';
  revision: number;
  reason: string;
}

/** `'/api' + COMPANION_NOTIFICATIONS_PATH` (shared; scripts/electron-tray.test.mjs checks the two agree). */
export const COMPANION_NOTIFICATIONS_STREAM_PATH = '/api/companion/notifications/stream';

/**
 * Query parameter carrying a notice's target (JSON) into the window its
 * click opened; preload.ts reads it into `initialCompanionTarget`.
 */
export const COMPANION_TARGET_PARAM = 'michiCompanionTarget';

/**
 * Preload → main, `[kind, listening]`: a window's renderer started or
 * stopped listening for Companion notices ('notice') or notification clicks
 * ('open'). Only the preload sends it; the renderer bridge has no method for
 * it. preload.ts mirrors the name (a sandboxed preload loads only 'electron').
 */
export const COMPANION_READY_CHANNEL = 'companion:ready';

/** What a renderer listens for: notices (shown as toasts) or notification clicks. */
export type CompanionListenerKind = 'notice' | 'open';

/** Where a notice without a usable target goes: the backend's own fallback. */
const CHAT_TARGET: CompanionTarget = { kind: 'companion', tab: 'chat' };

const MAX_ID_CHARS = 160;
const MAX_URL_CHARS = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
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

/** A well-formed target rebuilt from its known fields; null for anything else. */
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

/**
 * A notice from the stream, rebuilt from its known fields, or null for a
 * malformed frame. A target this app cannot place opens the Companion chat.
 */
export function parseCompanionNotice(value: unknown): CompanionNotice | null {
  if (!isRecord(value)) return null;
  const { id, title, body, target, itemIds, createdAt, expiresAt } = value;
  if (!isId(id) || typeof title !== 'string' || typeof body !== 'string') return null;
  if (!isRecord(target) || !Array.isArray(itemIds) || !isTime(createdAt) || !isTime(expiresAt)) return null;
  return {
    id,
    title,
    body,
    target: parseCompanionTarget(target) ?? { ...CHAT_TARGET },
    itemIds: itemIds.filter(isId),
    createdAt,
    expiresAt,
    ...(companionNoticeChannel(value) === 'chat' ? { channel: 'chat' as const } : {}),
  };
}

/**
 * shared companionNoticeChannel: `chat` only when the notice says so. A
 * notice without the field (written before v2), with null (a nullable column
 * read back) or with a value this build does not know is the Companion's own,
 * so it is still shown.
 */
export function companionNoticeChannel(notice: { channel?: unknown }): CompanionNoticeChannel {
  return notice.channel === 'chat' ? 'chat' : 'companion';
}

/** A `companion_changed` frame's data, or null for a malformed one. */
export function parseCompanionChangedFrame(value: unknown): CompanionChangedFrame | null {
  if (!isRecord(value) || value.type !== 'companion_changed') return null;
  if (typeof value.revision !== 'number' || !Number.isFinite(value.revision) || typeof value.reason !== 'string') return null;
  return { type: 'companion_changed', revision: value.revision, reason: value.reason };
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * How long a notice waits for the focused window's renderer to listen
 * before it goes up as a banner instead. The renderer listens once the
 * workspace has loaded, about 2 s after launch.
 */
export const COMPANION_HOLD_MS = 10_000;

/**
 * How Electron main handles a notice (as planNoticeDelivery for scheduled
 * runs). `ack` tells the backend to stop replaying it; a deferred notice
 * stays pending and is replayed when the feed next connects.
 */
export type CompanionNoticeDeliveryPlan =
  /** Stale, or already shown before a lost acknowledgement: nothing appears. */
  | { kind: 'skip'; ack: true; reason: 'expired' | 'duplicate' }
  /** The user is looking at Michi: an in-app toast in the focused window. */
  | { kind: 'toast'; ack: true }
  /** Michi is in the background: an OS banner; its click opens the Companion at the target. */
  | { kind: 'banner'; ack: true }
  /**
   * A Michi window has focus but its renderer does not listen yet: the
   * notice waits, unacknowledged, to become a toast once it does, or a
   * banner once Michi loses focus or COMPANION_HOLD_MS have passed.
   */
  | { kind: 'hold'; ack: false }
  /** Nothing can show it now. */
  | { kind: 'defer'; ack: false };

export interface CompanionNoticeDeliveryEnv {
  now: number;
  /** The focused Michi window: none, one whose renderer does not listen for notices yet, or one that shows toasts. */
  focusedWindow: 'none' | 'loading' | 'ready';
  /** How long the notice has waited for the focused window (0 when it has just arrived). */
  heldForMs: number;
  osNotificationsSupported: boolean;
  /** This notice was shown already (the backend replays until it hears the acknowledgement). */
  alreadyShown: boolean;
}

export function planCompanionNoticeDelivery(notice: CompanionNotice, env: CompanionNoticeDeliveryEnv): CompanionNoticeDeliveryPlan {
  if (env.alreadyShown) return { kind: 'skip', ack: true, reason: 'duplicate' };
  if (notice.expiresAt <= env.now) return { kind: 'skip', ack: true, reason: 'expired' };
  if (env.focusedWindow === 'ready') return { kind: 'toast', ack: true };
  if (env.focusedWindow === 'loading' && env.heldForMs < COMPANION_HOLD_MS) return { kind: 'hold', ack: false };
  if (env.osNotificationsSupported) return { kind: 'banner', ack: true };
  // No banner either: the focused window may still finish loading.
  return env.focusedWindow === 'loading' ? { kind: 'hold', ack: false } : { kind: 'defer', ack: false };
}

/** The part of an Electron Notification a banner uses. */
export interface CompanionBanner {
  on(event: 'click' | 'close', listener: () => void): unknown;
  show(): void;
}

/** Electron's Notification class (a double in tests). */
export interface CompanionBannerClass {
  new (options: { title: string; body: string }): CompanionBanner;
  isSupported(): boolean;
}

/** The focused Michi window, as a place to show an in-app toast. */
export interface CompanionToastWindow {
  /** Its renderer listens for notices (its preload said so); a notice sent before that is lost. */
  listening: boolean;
  showNotice(notice: CompanionNotice): void;
}

export interface CompanionNotifierHost {
  Notification: CompanionBannerClass;
  /** The focused Michi window, or null when no Michi window has focus. */
  focusedWindow(): CompanionToastWindow | null;
  /** Bring Michi forward at the target (focus or open a window): a banner click. */
  open(target: CompanionTarget): void;
  /** The backend may stop replaying the notice. */
  acknowledge(noticeId: string): void;
  now(): number;
  /** A banner went up or the notice was deferred: Michi may have no window open. */
  onBackgroundDelivery?(): void;
  /** What became of a notice: when it arrives, and again when a held notice is shown or given up. */
  onHandled?(notice: CompanionNotice, plan: CompanionNoticeDeliveryPlan): void;
  /** Runs `callback` after `delayMs`; the returned function cancels it. Default: an unref'd setTimeout. */
  setTimer?(callback: () => void, delayMs: number): () => void;
}

/** Ids remembered so a replayed notice is not shown twice. */
const MAX_REMEMBERED_NOTICES = 200;
/** Banners on screen the notifier keeps references to. */
const MAX_LIVE_BANNERS = 50;
/** Notices waiting for a window; beyond this the oldest is dropped unacknowledged, so the backend replays it. */
const MAX_HELD_NOTICES = 20;

/**
 * Shows each Companion notice once: a toast, a banner or nothing, then the
 * acknowledgement. A notice for a focused window whose renderer does not
 * listen yet is held instead: main calls refresh() when focus moves or a
 * renderer starts or stops listening, and dropHeld() when the feed connects.
 */
export class CompanionNotifier {
  /** Banners on screen, held so their click handlers are not garbage-collected. */
  private readonly banners = new Set<CompanionBanner>();
  private readonly shown = new Set<string>();
  /** Held notices by id, oldest first, each with when it began to wait. */
  private readonly held = new Map<string, { notice: CompanionNotice; since: number }>();
  private cancelHoldTimer: (() => void) | null = null;

  constructor(private readonly host: CompanionNotifierHost) {}

  deliver(notice: CompanionNotice): CompanionNoticeDeliveryPlan {
    // Notices already waiting go first.
    this.replanHeld();
    const plan: CompanionNoticeDeliveryPlan = this.held.has(notice.id) ? { kind: 'hold', ack: false } : this.handle(notice, null);
    this.armHoldTimer();
    return plan;
  }

  /** Focus moved, or a renderer started or stopped listening: held notices are planned again. */
  refresh(): void {
    this.replanHeld();
    this.armHoldTimer();
  }

  /**
   * Forget the held notices without acknowledging them. For a feed that
   * (re)connects: the backend replays every unacknowledged notice then,
   * folded into one when there are several.
   */
  dropHeld(): void {
    this.held.clear();
    this.armHoldTimer();
  }

  private replanHeld(): void {
    for (const [id, entry] of [...this.held]) {
      this.held.delete(id);
      this.handle(entry.notice, entry.since);
    }
  }

  /** `heldSince`: when a held notice began to wait; null for one that has just arrived. */
  private handle(notice: CompanionNotice, heldSince: number | null): CompanionNoticeDeliveryPlan {
    const now = this.host.now();
    const focused = this.host.focusedWindow();
    const plan = planCompanionNoticeDelivery(notice, {
      now,
      focusedWindow: focused === null ? 'none' : focused.listening ? 'ready' : 'loading',
      heldForMs: heldSince === null ? 0 : now - heldSince,
      osNotificationsSupported: this.host.Notification.isSupported(),
      alreadyShown: this.shown.has(notice.id),
    });
    if (plan.kind === 'toast' && focused) {
      focused.showNotice(notice);
      this.remember(notice.id);
    } else if (plan.kind === 'banner') {
      this.showBanner(notice);
      this.remember(notice.id);
    } else if (plan.kind === 'hold') {
      // Not remembered: when the backend replays it, it is not taken for a duplicate.
      this.held.set(notice.id, { notice, since: heldSince ?? now });
      trimOldest(this.held, MAX_HELD_NOTICES);
    }
    if (plan.ack) this.host.acknowledge(notice.id);
    if (plan.kind === 'banner' || plan.kind === 'defer') this.host.onBackgroundDelivery?.();
    // A held notice that still waits is not reported again.
    if (heldSince === null || plan.kind !== 'hold') this.host.onHandled?.(notice, plan);
    return plan;
  }

  /** Wakes up when the next held notice has waited COMPANION_HOLD_MS. */
  private armHoldTimer(): void {
    this.cancelHoldTimer?.();
    this.cancelHoldTimer = null;
    const now = this.host.now();
    let due = Infinity;
    for (const { since } of this.held.values()) {
      const at = since + COMPANION_HOLD_MS;
      if (at > now && at < due) due = at;
    }
    if (due === Infinity) return;
    this.cancelHoldTimer = (this.host.setTimer ?? unrefTimer)(() => {
      this.cancelHoldTimer = null;
      this.refresh();
    }, due - now);
  }

  private showBanner(notice: CompanionNotice): void {
    const banner = new this.host.Notification({ title: notice.title, body: notice.body });
    const target = notice.target;
    this.banners.add(banner);
    banner.on('click', () => {
      this.banners.delete(banner);
      this.host.open(target);
    });
    banner.on('close', () => this.banners.delete(banner));
    banner.show();
    trimOldest(this.banners, MAX_LIVE_BANNERS);
  }

  private remember(noticeId: string): void {
    this.shown.add(noticeId);
    trimOldest(this.shown, MAX_REMEMBERED_NOTICES);
  }
}

/** Sets and maps iterate in insertion order: drop the oldest entries beyond `max`. */
function trimOldest<K>(collection: { readonly size: number; keys(): Iterable<K>; delete(key: K): unknown }, max: number): void {
  for (const key of collection.keys()) {
    if (collection.size <= max) return;
    collection.delete(key);
  }
}

function unrefTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

// ── Windows ──────────────────────────────────────────────────────────────────

/**
 * Michi windows (by webContents id) as the Companion sees them: which
 * renderers listen for notices and for notification clicks, as each
 * window's preload reports on COMPANION_READY_CHANNEL, and the click
 * waiting for a window whose renderer does not listen yet (it would be lost
 * while the window it brought forward is still loading).
 */
export class CompanionRenderers {
  private readonly listening = new Map<number, Set<CompanionListenerKind>>();
  private readonly pendingOpen = new Map<number, CompanionTarget>();

  /** `sendOpen` hands a click to the window's renderer ('companion:open'). */
  constructor(private readonly sendOpen: (windowId: number, target: CompanionTarget) => void) {}

  /** A preload's report, `[kind, listening]` as it arrived; a malformed one is ignored. True when it changed anything. */
  report(windowId: number, kind: unknown, listening: unknown): boolean {
    if ((kind !== 'notice' && kind !== 'open') || typeof listening !== 'boolean') return false;
    const kinds = this.listening.get(windowId) ?? new Set<CompanionListenerKind>();
    if (kinds.has(kind) === listening) return false;
    if (listening) kinds.add(kind);
    else kinds.delete(kind);
    if (kinds.size > 0) this.listening.set(windowId, kinds);
    else this.listening.delete(windowId);
    if (kind === 'open' && listening) this.flushOpen(windowId);
    return true;
  }

  listens(windowId: number, kind: CompanionListenerKind): boolean {
    return this.listening.get(windowId)?.has(kind) ?? false;
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
    if (this.listens(windowId, 'open')) this.flushOpen(windowId);
  }

  private flushOpen(windowId: number): void {
    const target = this.pendingOpen.get(windowId);
    if (!target) return;
    this.pendingOpen.delete(windowId);
    this.sendOpen(windowId, target);
  }
}

// ── Feed ─────────────────────────────────────────────────────────────────────

export interface CompanionNotificationFeedOptions {
  /** Current backend port; null pauses the feed. */
  port(): number | null;
  onNotice(notice: CompanionNotice): void;
  /** A connection opened: the backend now replays every notice not acknowledged yet, before this connection's other frames. */
  onConnected?(): void;
  /** A `companion_changed` frame: the agent's state moved (the tray fetches its data again). */
  onChanged?(event: CompanionChangedFrame): void;
  log?(level: 'INFO' | 'WARN', message: string, meta?: Record<string, unknown>): void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Wait after the backend refuses the stream (a backend without the Companion, auth required…). */
  refusedRetryMs?: number;
  /** A connection silent this long is dead: the backend sends a keepalive every 15s. */
  idleTimeoutMs?: number;
}

/** Long-lived, self-reconnecting subscription to /api/companion/notifications/stream. */
export class CompanionNotificationFeed {
  private request: http.ClientRequest | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  /** Status of the last refusal: a backend without the Companion is logged once, not on every retry. */
  private refusedStatus: number | null = null;

  constructor(private readonly options: CompanionNotificationFeedOptions) {}

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

  acknowledge(noticeId: string): void {
    const port = this.options.port();
    if (!port) return;
    const payload = '{}';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: `/api/companion/notifications/${encodeURIComponent(noticeId)}/ack`,
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
      timeout: 5_000,
    }, (res) => res.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', () => { /* replayed on the next connection */ });
    req.end(payload);
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
    if (event === COMPANION_CHANGED_EVENT) {
      this.handleChanged(data);
      return;
    }
    if (event !== COMPANION_NOTICE_EVENT) return;
    let notice: CompanionNotice | null;
    try {
      notice = parseCompanionNotice(JSON.parse(data));
    } catch {
      return; // A malformed frame.
    }
    if (!notice) return;
    try {
      this.options.onNotice(notice);
    } catch (error) {
      // Not acknowledged: the backend replays it on the next connection.
      this.options.log?.('WARN', 'companion notice delivery failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleChanged(data: string): void {
    let event: CompanionChangedFrame | null;
    try {
      event = parseCompanionChangedFrame(JSON.parse(data));
    } catch {
      return; // A malformed frame.
    }
    if (!event) return;
    try {
      this.options.onChanged?.(event);
    } catch (error) {
      this.options.log?.('WARN', 'companion change handling failed', { error: error instanceof Error ? error.message : String(error) });
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
      path: COMPANION_NOTIFICATIONS_STREAM_PATH,
      headers: { accept: 'text/event-stream' },
    }, (res) => {
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      if (res.statusCode !== 200 || !contentType.startsWith('text/event-stream')) {
        res.resume();
        refused = true;
        // 404: no Companion on this backend (an older build); retry slowly in case it restarts.
        if (this.refusedStatus !== res.statusCode) {
          this.options.log?.('WARN', 'companion notification feed refused', { status: res.statusCode });
        }
        this.refusedStatus = res.statusCode ?? 0;
        return;
      }
      this.attempt = 0;
      this.refusedStatus = null;
      this.options.log?.('INFO', 'companion notification feed connected', { port });
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
