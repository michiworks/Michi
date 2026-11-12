import { isLocalConnectionId } from '../config/backendConnections';

/**
 * Per-connection boot barrier: "this remote's first content is on screen".
 *
 * Over an SSH tunnel every request costs a full round trip and they all share
 * one link. During boot, the metadata snapshot and the visible conversation's
 * first page are the critical path; everything else (cards, settings, presence,
 * catalogs) waits here so it does not compete with them.
 *
 * Hydration marks a connection once its active conversation is installed (from
 * the local cache or a fresh read), or once it knows no visible conversation
 * comes from that connection. Waiters are always bounded by `maxWaitMs`: the
 * barrier only reorders requests, it never withholds one.
 */

export const REMOTE_FIRST_PAINT_MAX_WAIT_MS = 1500;

const painted = new Set<string>();
const waiters = new Map<string, Set<() => void>>();

function release(connectionId: string): void {
  const pending = waiters.get(connectionId);
  if (!pending) return;
  waiters.delete(connectionId);
  for (const wake of pending) wake();
}

export function markRemoteFirstPaint(connectionId: string): void {
  if (isLocalConnectionId(connectionId) || painted.has(connectionId)) return;
  painted.add(connectionId);
  release(connectionId);
}

export function remoteFirstPainted(connectionId: string | null | undefined): boolean {
  return !connectionId || isLocalConnectionId(connectionId) || painted.has(connectionId);
}

/**
 * Resolves once `connectionId` has painted, or after `maxWaitMs`, whichever
 * comes first. Local (or absent) connections resolve immediately.
 */
export function whenRemoteFirstPaint(
  connectionId: string | null | undefined,
  maxWaitMs = REMOTE_FIRST_PAINT_MAX_WAIT_MS,
): Promise<void> {
  if (remoteFirstPainted(connectionId)) return Promise.resolve();
  const id = connectionId as string;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.get(id)?.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, maxWaitMs));
    const set = waiters.get(id) ?? new Set<() => void>();
    set.add(finish);
    waiters.set(id, set);
  });
}

/**
 * Forget a connection's paint (it was removed or now points at another
 * machine), or every connection when no id is given (tests). Pending waiters
 * are released so nothing stays parked on a barrier that will not be marked.
 */
export function resetRemoteFirstPaint(connectionId?: string): void {
  if (connectionId === undefined) {
    painted.clear();
    for (const id of [...waiters.keys()]) release(id);
    return;
  }
  painted.delete(connectionId);
  release(connectionId);
}
