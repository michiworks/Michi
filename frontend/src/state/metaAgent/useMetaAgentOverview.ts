import { useEffect, useSyncExternalStore } from 'react';
import type { MetaAgentOverview } from 'michi-shared';
import { fetchMetaAgentOverview, setMetaAgentPaused } from '../../services/api/metaAgentOverview';
import { HttpResponseError } from '../../services/api/httpError';
import { useMetaAgentGuardFailed, useMetaAgentSnapshot } from './useMetaAgent';
import { useSpacesFirstRun } from './spacesFirstRun';
import { metaAgentStatus } from './metaAgentStatus';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../config/backendConnections';

/**
 * Scheduled › Meta agent's overview: whether maintenance is paused, each
 * workspace's cursor and the recent runs. One copy for every reader
 * (Scheduled, Settings › Meta agent, the Spaces Home and the rail's Settings
 * dot), so a pause or resume anywhere shows everywhere at once. One read at
 * a time; one poll at the shortest interval a mounted reader asks for, and a
 * read when the window regains focus. `unavailable`: the backend has no
 * overview route. `refused`: the backend refused the read (403, e.g. a host
 * name it does not trust); `message` is its reason. Asking again cannot
 * change either answer, so both stop the poll and the focus read.
 */
export type MetaAgentOverviewLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; overview: MetaAgentOverview; at: number }
  | { kind: 'unavailable' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string };

/** For the pages about the Meta agent itself; the always-mounted rail and the Spaces Home read every minute. */
export const META_AGENT_PAGE_POLL_MS = 15_000;
const DEFAULT_POLL_MS = 60_000;
const INITIAL: MetaAgentOverviewLoad = { kind: 'loading' };

let load: MetaAgentOverviewLoad = INITIAL;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let generation = 0;
/** The interval each mounted reader asked for. */
const pollIntervals: number[] = [];
let timer: number | null = null;
let timerMs: number | null = null;

function publish(next: MetaAgentOverviewLoad): void {
  load = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const isOverview = (value: unknown): value is MetaAgentOverview =>
  typeof value === 'object' && value !== null && typeof (value as MetaAgentOverview).state === 'string' && Array.isArray((value as MetaAgentOverview).cursors);

export function refreshMetaAgentOverview(): Promise<void> {
  if (inflight) return inflight;
  const current = ++generation;
  inflight = fetchMetaAgentOverview().then(
    (overview) => {
      if (current !== generation) return;
      if (!isOverview(overview)) { publish({ kind: 'unavailable' }); return; }
      publish({ kind: 'ready', overview, at: Date.now() });
    },
    (reason: unknown) => {
      if (current !== generation) return;
      if (reason instanceof HttpResponseError && reason.status === 404) { publish({ kind: 'unavailable' }); return; }
      if (reason instanceof HttpResponseError && reason.status === 403) { publish({ kind: 'refused', message: reason.message }); return; }
      // Keep showing the last answer when a poll fails.
      if (load.kind === 'ready') return;
      publish({ kind: 'failed', message: reason instanceof Error ? reason.message : 'Could not read the Pages upkeep status' });
    },
  ).finally(() => { inflight = null; });
  return inflight;
}

/** Pauses or resumes background maintenance in every workspace; the answer replaces the overview at once. */
export async function pauseMetaAgentMaintenance(paused: boolean): Promise<void> {
  const overview = await setMetaAgentPaused(paused);
  generation += 1;
  publish({ kind: 'ready', overview, at: Date.now() });
}

const settled = () => load.kind === 'unavailable' || load.kind === 'refused';
const poll = () => {
  if (document.visibilityState === 'visible' && !settled()) void refreshMetaAgentOverview();
};
const onFocus = () => { if (!settled()) void refreshMetaAgentOverview(); };

function schedulePoll(): void {
  const wanted = pollIntervals.length ? Math.min(...pollIntervals) : null;
  if (wanted === timerMs) return;
  if (timer !== null) window.clearInterval(timer);
  timer = wanted === null ? null : window.setInterval(poll, wanted);
  timerMs = wanted;
}

function startPolling(ms: number): () => void {
  pollIntervals.push(ms);
  if (pollIntervals.length === 1) window.addEventListener('focus', onFocus);
  schedulePoll();
  return () => {
    pollIntervals.splice(pollIntervals.indexOf(ms), 1);
    if (pollIntervals.length === 0) window.removeEventListener('focus', onFocus);
    schedulePoll();
  };
}

/** Observe navigation validity without keeping background polling mounted. */
export function useMetaAgentOverviewSnapshot(): MetaAgentOverviewLoad {
  return useSyncExternalStore(subscribe, () => load, () => load);
}

/** The overview, read when the caller mounts and kept fresh, at least every `pollMs`, while it stays mounted. */
export function useMetaAgentOverview(pollMs: number = DEFAULT_POLL_MS): MetaAgentOverviewLoad {
  const current = useMetaAgentOverviewSnapshot();
  useEffect(() => {
    void refreshMetaAgentOverview();
    return startPolling(pollMs);
  }, [pollMs]);
  return current;
}

/** @testonly */
export function resetMetaAgentOverviewStore(): void {
  load = INITIAL;
  inflight = null;
  generation += 1;
  for (const listener of listeners) listener();
}

/**
 * The rail's Settings red dot: the shared Meta agent status says Settings can
 * fix it (a failed restriction check, a runtime it cannot run on, or errors
 * that stopped background maintenance), not a pause or scheduled jobs being off.
 */
export function useMetaAgentSettingsAlert(): boolean {
  // Keeps the restriction checks fresh while the rail is mounted.
  useMetaAgentGuardFailed();
  const agent = useMetaAgentSnapshot();
  const overview = useMetaAgentOverview();
  const firstRun = useSpacesFirstRun(LOCAL_BACKEND_CONNECTION_ID);
  return metaAgentStatus({
    info: agent.info, infoStatus: agent.status, firstRun, overview: overview.kind === 'ready' ? overview.overview : null,
  }).settingsAlert;
}
