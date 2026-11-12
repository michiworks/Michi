import { LOCAL_BACKEND_CONNECTION_ID } from './backendIdentity';

export const BACKEND_CONNECTION_UNAVAILABLE = 'michi:backend-connection-unavailable';
export const BACKEND_CONNECTION_READY = 'michi:backend-connection-ready';
const generations = new Map<string, number>();
const unavailable = new Set<string>();

export function backendConnectionGeneration(connectionId: string): number {
  return generations.get(connectionId) ?? 0;
}

export function backendConnectionUnavailable(connectionId: string): boolean {
  return unavailable.has(connectionId);
}

export function markBackendConnectionReady(connectionId: string): void {
  if (unavailable.delete(connectionId) && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId } }));
  }
}

export function markBackendConnectionUnavailable(connectionId: string, invalidatePendingReads = false): void {
  if (connectionId === LOCAL_BACKEND_CONNECTION_ID || (unavailable.has(connectionId) && !invalidatePendingReads)) return;
  unavailable.add(connectionId);
  generations.set(connectionId, backendConnectionGeneration(connectionId) + 1);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_UNAVAILABLE, { detail: { connectionId } }));
  }
}

// ── Provisional connections ────────────────────────────────────────────────
// A remote whose workspaces are on screen from this machine's cache, before
// the remote itself has answered. What it shows is read-only: writes to it
// wait (bounded) for its own metadata, so nothing built on cached state is
// ever sent. Confirmation is the remote's fresh metadata landing (or the
// cached copy being dropped).

/** How long a write waits for a provisional connection to confirm before going anyway. */
export const PROVISIONAL_CONFIRM_WAIT_MS = 10_000;

const provisional = new Map<string, Set<() => void>>();

export function markBackendConnectionProvisional(connectionId: string): void {
  if (connectionId === LOCAL_BACKEND_CONNECTION_ID || provisional.has(connectionId)) return;
  provisional.set(connectionId, new Set());
}

export function backendConnectionProvisional(connectionId: string | null | undefined): boolean {
  return !!connectionId && provisional.has(connectionId);
}

/** The connection's own data replaced its cached copy (or the copy is gone): writes may go. */
export function confirmBackendConnection(connectionId: string): void {
  const waiters = provisional.get(connectionId);
  if (!waiters) return;
  provisional.delete(connectionId);
  for (const wake of waiters) wake();
}

/**
 * Resolves true once `connectionId` is not provisional, or false after
 * `maxWaitMs` (or on abort). Never rejects: a caller goes ahead either way.
 */
export function whenBackendConnectionConfirmed(
  connectionId: string,
  maxWaitMs = PROVISIONAL_CONFIRM_WAIT_MS,
  signal?: AbortSignal | null,
): Promise<boolean> {
  const waiters = provisional.get(connectionId);
  if (!waiters) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (confirmed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.delete(wake);
      signal?.removeEventListener('abort', onAbort);
      resolve(confirmed);
    };
    const wake = () => finish(true);
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(!provisional.has(connectionId)), Math.max(0, maxWaitMs));
    waiters.add(wake);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** @internal Test isolation only: forget every provisional connection, releasing their waiters. */
export function resetBackendConnectionProvisional(): void {
  for (const id of [...provisional.keys()]) confirmBackendConnection(id);
}
