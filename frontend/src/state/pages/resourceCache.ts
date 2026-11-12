import { useSyncExternalStore } from 'react';
import { startVisiblePoll } from '../visiblePoll';

export type ResourceStatus = 'loading' | 'ready' | 'error';

export interface ResourceSnapshot<T> {
  data: T | null;
  status: ResourceStatus;
  error: string | null;
  stale: boolean;
}

interface Entry<T> {
  snapshot: ResourceSnapshot<T>;
  generation: number;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry<unknown>>();

function entry<T>(key: string): Entry<T> {
  let current = entries.get(key) as Entry<T> | undefined;
  if (!current) {
    current = {
      snapshot: { data: null, status: 'loading', error: null, stale: false },
      generation: 0,
      listeners: new Set(),
    };
    entries.set(key, current as Entry<unknown>);
  }
  return current;
}

export function resourceKey(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => encodeURIComponent(part ?? '')).join('|');
}

export function readResource<T>(key: string): ResourceSnapshot<T> {
  return entry<T>(key).snapshot;
}

export function subscribeResource(key: string, listener: () => void): () => void {
  const current = entry(key);
  current.listeners.add(listener);
  return () => current.listeners.delete(listener);
}

export function useResource<T>(key: string): ResourceSnapshot<T> {
  return useSyncExternalStore(
    (listener) => subscribeResource(key, listener),
    () => readResource<T>(key),
    () => readResource<T>(key),
  );
}

export function startResourceRead(key: string): number {
  const current = entry(key);
  current.generation += 1;
  publish(current, {
    ...current.snapshot,
    status: current.snapshot.data === null ? 'loading' : 'ready',
    error: null,
    // A request in flight is not evidence that the retained snapshot is stale.
    // Keep confirmed data usable until a refresh actually fails or a scoped
    // invalidation says that its underlying resource changed.
    stale: current.snapshot.data === null ? false : current.snapshot.stale,
  });
  return current.generation;
}

export function commitResourceRead<T>(key: string, generation: number, data: T): boolean {
  const current = entry<T>(key);
  if (current.generation !== generation) return false;
  publish(current, { data, status: 'ready', error: null, stale: false });
  return true;
}

export function retainResource(key: string, generation: number): boolean {
  const current = entry(key);
  if (current.generation !== generation) return false;
  publish(current, { ...current.snapshot, status: current.snapshot.data === null ? 'error' : 'ready', error: null, stale: false });
  return true;
}

export function failResourceRead(key: string, generation: number, error: unknown): boolean {
  const current = entry(key);
  if (current.generation !== generation) return false;
  const message = error instanceof Error ? error.message : 'Could not load this resource';
  publish(current, {
    data: current.snapshot.data,
    status: current.snapshot.data === null ? 'error' : 'ready',
    error: message,
    stale: current.snapshot.data !== null,
  });
  return true;
}

/**
 * Reads `load` into `key`: a read started later wins, and a failed read
 * keeps the last data, marked stale. A read aborted through `signal` changes
 * nothing.
 */
export function loadResource<T>(key: string, load: () => Promise<T>, signal?: AbortSignal): Promise<void> {
  const generation = startResourceRead(key);
  return load().then(
    (data) => { commitResourceRead(key, generation, data); },
    (error: unknown) => { if (!signal?.aborted) failResourceRead(key, generation, error); },
  );
}

export function writeResource<T>(key: string, data: T): void {
  const current = entry<T>(key);
  current.generation += 1;
  publish(current, { data, status: 'ready', error: null, stale: false });
}

function publish<T>(current: Entry<T>, snapshot: ResourceSnapshot<T>): void {
  const prev = current.snapshot;
  if (prev.data === snapshot.data && prev.status === snapshot.status && prev.error === snapshot.error && prev.stale === snapshot.stale) return;
  current.snapshot = snapshot;
  for (const listener of current.listeners) listener();
}

interface PollHolder { refresh: () => void; deferred: boolean }
const pollers = new Map<string, { holders: PollHolder[]; stop: () => void }>();

/**
 * One visible-tab poll and focus refresh per key, however many readers mount
 * it; each mount still reads on its own mount and page events. The poll runs
 * the newest reader that doesn't defer to a remote's first paint.
 */
export function pollResource(key: string, intervalMs: number, refresh: () => void, { deferred = false } = {}): () => void {
  let poller = pollers.get(key);
  if (!poller) {
    const holders: PollHolder[] = [];
    const run = () => {
      let chosen = holders[holders.length - 1];
      for (let index = holders.length - 1; index >= 0; index -= 1) {
        if (!holders[index].deferred) { chosen = holders[index]; break; }
      }
      chosen?.refresh();
    };
    poller = { holders, stop: startVisiblePoll(run, { intervalMs }) };
    pollers.set(key, poller);
  }
  const owned = poller;
  const holder = { refresh, deferred };
  owned.holders.push(holder);
  return () => {
    const index = owned.holders.indexOf(holder);
    if (index >= 0) owned.holders.splice(index, 1);
    if (owned.holders.length === 0 && pollers.get(key) === owned) {
      owned.stop();
      pollers.delete(key);
    }
  };
}
