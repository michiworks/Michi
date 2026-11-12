import { peekLiveSession } from "./sessionRegistry";
import type { AgentSession } from "./types";

/** The thread's session was released or replaced after it was opened, before its turn started. */
export class SessionChangedError extends Error {
  constructor() {
    super("The thread's session changed before its turn could start; try again");
    this.name = "SessionChangedError";
  }
}

/**
 * Starts a backend-requested turn (ChatHub.startRequestedSelfTurn) while the
 * caller holds the node's restore lock (nativeResume.acquireSessionRestoreLock),
 * then releases the lock; a synchronous throw becomes a rejection. The session
 * was opened before the lock was taken, so a holder that ran first (idle
 * release, extract-tree, a model change) may have released or replaced it.
 * When isLive says so, nothing starts and the start rejects with
 * SessionChangedError, as POST /message re-resolves its session under the lock.
 */
export function startUnderRestoreLock<T>(
  release: () => void,
  session: AgentSession,
  isLive: ((session: AgentSession) => boolean) | undefined,
  start: () => Promise<T>,
): Promise<T> {
  try {
    return isLive && !isLive(session) ? Promise.reject(new SessionChangedError()) : start();
  } catch (error) {
    return Promise.reject(error);
  } finally {
    release();
  }
}

/** The production isLive: the session is still the live one registered under its id. */
export function isRegisteredLiveSession(session: AgentSession): boolean {
  return peekLiveSession(session.id) === session;
}
