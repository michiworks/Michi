import { useSyncExternalStore } from 'react';

/**
 * One visible destination shared by the shell, sidebar, list and notifications.
 * A job with `runId` shows that run's thread (a Scheduled-only job's run).
 */
export type ScheduledRoute = { kind: 'list' } | { kind: 'job'; jobId: string; runId?: string };
export const SCHEDULED_HOME: ScheduledRoute = { kind: 'list' };
let route: ScheduledRoute = SCHEDULED_HOME;
const listeners = new Set<() => void>();

function sameRoute(a: ScheduledRoute, b: ScheduledRoute): boolean {
  if (a.kind !== 'job' || b.kind !== 'job') return a.kind === b.kind;
  return a.jobId === b.jobId && (a.runId ?? null) === (b.runId ?? null);
}

export function setScheduledRoute(next: ScheduledRoute): void {
  if (sameRoute(route, next)) return;
  route = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useScheduledRoute(): ScheduledRoute {
  return useSyncExternalStore(subscribe, () => route, () => SCHEDULED_HOME);
}

export function openScheduledHome(): void { setScheduledRoute(SCHEDULED_HOME); }

export const OPEN_SCHEDULED_JOB_EVENT = 'michi:open-scheduled-job';

/** Retained even before the Scheduled page mounts, including notification opens. */
export function requestScheduledJobDetail(jobId: string): void {
  setScheduledRoute({ kind: 'job', jobId });
  window.dispatchEvent(new CustomEvent(OPEN_SCHEDULED_JOB_EVENT, { detail: { jobId } }));
}

/** Show one run's thread on the Scheduled page (a Scheduled-only job's runs open there). */
export function requestScheduledRun(jobId: string, runId: string): void {
  setScheduledRoute({ kind: 'job', jobId, runId });
  window.dispatchEvent(new CustomEvent(OPEN_SCHEDULED_JOB_EVENT, { detail: { jobId, runId } }));
}

/** The top bar's title for a page inside Scheduled (a run's conversation); null: none. */
let crumb: string | null = null;
const crumbListeners = new Set<() => void>();

export function setScheduledCrumb(next: string | null): void {
  if (crumb === next) return;
  crumb = next;
  for (const listener of crumbListeners) listener();
}

export function useScheduledCrumb(): string | null {
  return useSyncExternalStore((listener) => {
    crumbListeners.add(listener);
    return () => { crumbListeners.delete(listener); };
  }, () => crumb, () => null);
}
