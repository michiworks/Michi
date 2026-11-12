import { BACKEND_CONNECTION_READY, BACKEND_CONNECTION_UNAVAILABLE, backendConnectionUnavailable } from '../config/backendConnectionState';

/**
 * Skeleton episodes: how long a pane showed a conversation's loading skeleton,
 * and where that time went. An episode runs from the skeleton's first mount for
 * a node until no pane shows it. Requests, responses, installs and connection
 * outages for that node are stamped on it as they happen.
 *
 * An episode that lasts past SLOW_SKELETON_MS writes one JSON line to the
 * console (`type: 'message_load_slow'`) with its phase durations and the reason
 * it is still waiting, and keeps a row in the ring at
 * `window.__michiLoadDiagnostics`. That row keeps updating until the episode
 * ends (`waitingOn`, phases, `ended`), so DevTools shows the final timings.
 * Ids and timings only, no content.
 */
export const SLOW_SKELETON_MS = 2000;
const RING_SIZE = 50;

export type SkeletonStallReason =
  | 'no_request_issued'
  | 'waiting_for_response'
  | 'installing'
  | 'connection_unavailable'
  | 'retrying_after_error';
type RequestSource = 'tree' | 'prefetch' | 'node';
/** `prefetched`: a speculative read answered, but nothing was waiting to install it. */
type Outcome = 'responded' | 'prefetched' | 'failed' | 'aborted' | 'not_in_response' | 'changed';

export interface SkeletonDiagnosticRow {
  type: 'message_load_slow';
  source: 'renderer';
  nodeId: string;
  connectionId: string;
  shownAt: number;
  /** Why the skeleton was still up when the episode was reported. */
  reason: SkeletonStallReason;
  /** What it waits on now; frozen once the episode ends. */
  waitingOn: SkeletonStallReason;
  elapsedMs: number;
  /** When the first read covering the node started, from shownAt; null before any. */
  firstRequestMs: number | null;
  /**
   * Where elapsedMs went: no read in flight, a read in flight, a response
   * waiting to install. unavailableMs overlaps the others.
   */
  phases: { noRequestMs: number; awaitingResponseMs: number; installingMs: number; unavailableMs: number };
  requests: number;
  failures: number;
  sources: RequestSource[];
  lastOutcome?: Outcome;
  lastError?: string;
  /** Set when no pane shows the skeleton any more. */
  ended?: 'installed' | 'hidden';
}

interface Episode {
  nodeId: string;
  connectionId: string;
  shownAt: number;
  holders: number;
  firstRequestAt?: number;
  awaitingMs: number;
  inFlightSince?: number;
  respondedAt?: number;
  installedAt?: number;
  requests: number;
  failures: number;
  sources: Set<RequestSource>;
  lastOutcome?: Outcome;
  lastError?: string;
  retryPending: boolean;
  unavailableMs: number;
  unavailableSince?: number;
  timer?: ReturnType<typeof setTimeout>;
  row?: SkeletonDiagnosticRow;
}

const episodes = new Map<string, Episode>();
const inFlight = new Map<string, number>();
const ring: SkeletonDiagnosticRow[] = [];
let listening = false;
(globalThis as { __michiLoadDiagnostics?: SkeletonDiagnosticRow[] }).__michiLoadDiagnostics = ring;

function onConnectionEvent(event: Event) {
  const connectionId = (event as CustomEvent<{ connectionId?: string }>).detail?.connectionId;
  const now = Date.now();
  for (const episode of episodes.values()) {
    if (episode.connectionId !== connectionId) continue;
    if (event.type === BACKEND_CONNECTION_UNAVAILABLE) episode.unavailableSince ??= now;
    else if (episode.unavailableSince !== undefined) {
      episode.unavailableMs += now - episode.unavailableSince;
      episode.unavailableSince = undefined;
    }
    refresh(episode, now);
  }
}

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(BACKEND_CONNECTION_UNAVAILABLE, onConnectionEvent);
  window.addEventListener(BACKEND_CONNECTION_READY, onConnectionEvent);
}

function reasonFor(episode: Episode): SkeletonStallReason {
  if (backendConnectionUnavailable(episode.connectionId)) return 'connection_unavailable';
  if ((inFlight.get(episode.nodeId) ?? 0) > 0) return 'waiting_for_response';
  if (episode.lastOutcome === 'responded' && episode.installedAt === undefined) return 'installing';
  if (episode.lastOutcome === 'failed' && episode.retryPending) return 'retrying_after_error';
  return 'no_request_issued';
}

function rowFor(episode: Episode, now: number): SkeletonDiagnosticRow {
  const end = episode.installedAt ?? now;
  const settled = episode.installedAt !== undefined || !!episode.row?.ended;
  const waitingOn = settled && episode.row ? episode.row.waitingOn : reasonFor(episode);
  const elapsedMs = end - episode.shownAt;
  const awaitingResponseMs = episode.awaitingMs + (episode.inFlightSince !== undefined ? end - episode.inFlightSince : 0);
  const installingMs = episode.respondedAt !== undefined
    && (episode.installedAt !== undefined || episode.lastOutcome === 'responded')
    ? Math.max(0, end - episode.respondedAt) : 0;
  return {
    type: 'message_load_slow',
    source: 'renderer',
    nodeId: episode.nodeId,
    connectionId: episode.connectionId,
    shownAt: episode.shownAt,
    reason: episode.row?.reason ?? waitingOn,
    waitingOn,
    elapsedMs,
    firstRequestMs: episode.firstRequestAt === undefined ? null : episode.firstRequestAt - episode.shownAt,
    phases: {
      noRequestMs: Math.max(0, elapsedMs - awaitingResponseMs - installingMs),
      awaitingResponseMs,
      installingMs,
      unavailableMs: episode.unavailableMs + (episode.unavailableSince !== undefined ? now - episode.unavailableSince : 0),
    },
    requests: episode.requests,
    failures: episode.failures,
    sources: [...episode.sources],
    ...(episode.lastOutcome ? { lastOutcome: episode.lastOutcome } : {}),
    ...(episode.lastError ? { lastError: episode.lastError } : {}),
    ...(episode.row?.ended ? { ended: episode.row.ended } : {}),
  };
}

function refresh(episode: Episode, now = Date.now()) {
  if (episode.row) Object.assign(episode.row, rowFor(episode, now));
}

function report(episode: Episode) {
  episode.timer = undefined;
  if (episodes.get(episode.nodeId) !== episode || episode.row) return;
  episode.row = rowFor(episode, Date.now());
  ring.push(episode.row);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  console.info(JSON.stringify(episode.row));
}

/** A pane started showing the loading skeleton for `nodeId`. */
export function noteSkeletonShown(nodeId: string, connectionId: string): void {
  const existing = episodes.get(nodeId);
  if (existing) { existing.holders += 1; return; }
  listen();
  const now = Date.now();
  const pending = (inFlight.get(nodeId) ?? 0) > 0;
  const episode: Episode = {
    nodeId, connectionId, shownAt: now, holders: 1,
    // A read that was already on its way counts from the moment it showed.
    firstRequestAt: pending ? now : undefined,
    inFlightSince: pending ? now : undefined,
    awaitingMs: 0,
    requests: pending ? 1 : 0,
    failures: 0, sources: new Set(), retryPending: false, unavailableMs: 0,
    unavailableSince: backendConnectionUnavailable(connectionId) ? now : undefined,
  };
  episode.timer = setTimeout(() => report(episode), SLOW_SKELETON_MS);
  episodes.set(nodeId, episode);
}

/** A pane stopped showing it (bodies installed, pane closed or switched). */
export function noteSkeletonHidden(nodeId: string): void {
  const episode = episodes.get(nodeId);
  if (!episode || --episode.holders > 0) return;
  episodes.delete(nodeId);
  clearTimeout(episode.timer);
  if (!episode.row) return;
  refresh(episode);
  episode.row.ended = episode.installedAt === undefined ? 'hidden' : 'installed';
}

/**
 * A read covering `nodeIds` started. Call the returned function once when it
 * settles: with its error, or with `unclaimed` for a speculative read nothing
 * was waiting on.
 */
export function noteMessageRequest(nodeIds: Iterable<string>, source: RequestSource):
  (error?: unknown, unclaimed?: boolean) => void {
  const ids = [...nodeIds];
  const now = Date.now();
  for (const id of ids) {
    const count = inFlight.get(id) ?? 0;
    inFlight.set(id, count + 1);
    const episode = episodes.get(id);
    if (!episode) continue;
    episode.requests += 1;
    episode.firstRequestAt ??= now;
    if (count === 0) episode.inFlightSince = now;
    episode.sources.add(source);
    episode.retryPending = false;
    refresh(episode, now);
  }
  let settled = false;
  return (error?: unknown, unclaimed = false) => {
    if (settled) return;
    settled = true;
    const at = Date.now();
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    for (const id of ids) {
      const count = (inFlight.get(id) ?? 1) - 1;
      if (count > 0) inFlight.set(id, count); else inFlight.delete(id);
      const episode = episodes.get(id);
      if (!episode) continue;
      if (count === 0 && episode.inFlightSince !== undefined) {
        episode.awaitingMs += at - episode.inFlightSince;
        episode.inFlightSince = undefined;
      }
      if (error === undefined) {
        episode.lastOutcome = unclaimed ? 'prefetched' : 'responded';
        if (!unclaimed) episode.respondedAt = at;
      } else if (aborted) {
        episode.lastOutcome = 'aborted';
      } else {
        episode.failures += 1;
        episode.lastOutcome = 'failed';
        episode.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      }
      refresh(episode, at);
    }
  };
}

/** A failed read for `nodeIds` will be retried. */
export function noteMessageRetry(nodeIds: Iterable<string>): void {
  for (const id of nodeIds) {
    const episode = episodes.get(id);
    if (!episode) continue;
    episode.retryPending = true;
    refresh(episode);
  }
}

/** A response arrived but was not installed for these nodes. */
export function noteMessagesNotInstalled(nodeIds: Iterable<string>, outcome: 'not_in_response' | 'changed'): void {
  for (const id of nodeIds) {
    const episode = episodes.get(id);
    if (!episode) continue;
    episode.lastOutcome = outcome;
    refresh(episode);
  }
}

export function noteMessagesInstalled(nodeIds: Iterable<string>): void {
  const now = Date.now();
  for (const id of nodeIds) {
    const episode = episodes.get(id);
    if (!episode || episode.installedAt !== undefined) continue;
    episode.installedAt = now;
    refresh(episode, now);
  }
}
