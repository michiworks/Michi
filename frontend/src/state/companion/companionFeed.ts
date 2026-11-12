import type { CompanionNotice } from 'michi-shared';
import { subscribeCompanionEvents } from '../../services/api/companion';
import { SseHttpError } from '../../services/api/sseParser';
import { getCompanionState, loadCompanion, noteCompanionChanged, refreshCompanion, subscribeCompanion } from './companionStore';

/**
 * The Companion's change feed (GET /api/companion/events), kept the way
 * memoryNotifications.ts keeps Memory's: open while anything uses it, a
 * reconnect after 1s doubling to 30s (back to 1s once a connection held for
 * 30s), and 401/403/404 taken as "no feed here" (reads on window focus
 * instead). Each frame names the backend's revision; the store reads the
 * snapshot again when it differs from its own. A `companion_notice` frame is
 * a notice the backend's gate produced; subscribeCompanionNotices hands it on.
 *
 * The backend also counts this feed as the window being open (DESIGN-v2
 * §5.2): while no window's feed is connected for five seconds, it notifies
 * conversations' approvals, questions and replies itself, and a window that
 * notifies them too would double them. So the feed opens as soon as the
 * shell mounts it, whether or not the first `GET /companion` answered (D20),
 * and until it has connected once, it retries within FIRST_CONNECT_RETRY_MAX_MS
 * rather than backing off to 30s.
 */

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** The longest wait between tries before the feed has connected once (D20): a few seconds, not 30. */
const FIRST_CONNECT_RETRY_MAX_MS = 3_000;
const STABLE_MS = 30_000;

let users = 0;
let stop: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let openedAt = 0;
/** The feed has connected since startCompanionFeed opened it: later drops back off up to RECONNECT_MAX_MS. */
let connectedOnce = false;
let feedState: 'idle' | 'open' | 'unavailable' = 'idle';
let unsubscribeStore: (() => void) | null = null;
const noticeListeners = new Set<(notice: CompanionNotice) => void>();

function publishNotice(notice: CompanionNotice): void {
  for (const listener of [...noticeListeners]) {
    try {
      listener(notice);
    } catch {
      // One listener must not stop the others.
    }
  }
}

/**
 * The notices the backend's notice gate sends over this feed (R2.7): what a
 * browser window shows, since it has no main process to show them. Only
 * while the feed is open (startCompanionFeed). Returns unsubscribe.
 */
export function subscribeCompanionNotices(listener: (notice: CompanionNotice) => void): () => void {
  noticeListeners.add(listener);
  return () => { noticeListeners.delete(listener); };
}

function connect(): void {
  // A reconnect already waiting keeps its backoff.
  if (stop || reconnectTimer !== null || users === 0 || feedState === 'unavailable') return;
  stop = subscribeCompanionEvents({
    onOpen: () => {
      feedState = 'open';
      openedAt = Date.now();
      connectedOnce = true;
    },
    onEvent: noteCompanionChanged,
    onNotice: publishNotice,
    onDisconnect: (error) => {
      stop = null;
      const status = error instanceof SseHttpError ? error.status : null;
      if (status === 401 || status === 403 || status === 404) { feedState = 'unavailable'; return; }
      if (feedState === 'open' && Date.now() - openedAt >= STABLE_MS) failures = 0;
      feedState = 'idle';
      failures += 1;
      if (users === 0) return;
      const delay = Math.min(connectedOnce ? RECONNECT_MAX_MS : FIRST_CONNECT_RETRY_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures - 1, 10));
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    },
  });
}

/** Back on the window: a feed that is not open may have missed changes. */
const onFocus = () => {
  if (feedState !== 'open' || getCompanionState().stale) void refreshCompanion();
};

/**
 * Keep the snapshot and its change feed live while the caller is mounted
 * (the shell mounts it once the workspaces have loaded). Returns release.
 */
export function startCompanionFeed(): () => void {
  users += 1;
  if (users === 1) {
    void loadCompanion();
    connectedOnce = false;
    // At once, not after the first snapshot (D20): a backend without a Companion answers the feed 404 and it stops.
    connect();
    // A snapshot that arrives while no connection is open or waiting: try again (a backend that came up meanwhile).
    unsubscribeStore = subscribeCompanion(() => {
      if (getCompanionState().availability === 'available') connect();
    });
    window.addEventListener('focus', onFocus);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users > 0) return;
    window.removeEventListener('focus', onFocus);
    unsubscribeStore?.();
    unsubscribeStore = null;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stop?.();
    stop = null;
    if (feedState === 'open') feedState = 'idle';
  };
}

/**
 * Forget the feed between test cases.
 * @testonly
 */
export function resetCompanionFeedForTests(): void {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stop?.();
  stop = null;
  unsubscribeStore?.();
  unsubscribeStore = null;
  noticeListeners.clear();
  users = 0;
  failures = 0;
  openedAt = 0;
  connectedOnce = false;
  feedState = 'idle';
  if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
}
