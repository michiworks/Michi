import { randomUUID } from 'node:crypto';
import { assertOwner, interactiveOwner, ownerMode, type AgentSession, type RuntimeSessionOwner } from '../contract/types';

/**
 * The owner and public id a new or loaded session opens under: a headless
 * owner's key, which a requested id must equal, else the requested id, else
 * the owner's key. No owner stands for the interactive owner of that id.
 */
export function sessionIdentity(owner: RuntimeSessionOwner | undefined, requestedId: string | undefined): { owner: RuntimeSessionOwner; id: string } {
  if (!owner) {
    const id = requestedId ?? randomUUID();
    return { owner: interactiveOwner(id), id };
  }
  if (ownerMode(owner) === 'headless') {
    if (requestedId && requestedId !== owner.key) throw new Error('Agent Run public session id must equal attemptId');
    return { owner, id: owner.key };
  }
  return { owner, id: requestedId ?? owner.key };
}

/**
 * Whether a caller may reuse a live or pending session: the same owner, user
 * and runtime profile. `userOf` is the session's user; undefined (unknown)
 * never matches. A reused session's idle retention restarts.
 */
export function assertSessionReusable<T extends AgentSession>(
  session: T,
  expected: { owner: RuntimeSessionOwner; ownerUserId?: string | null; profileHash?: string | null },
  userOf: (session: T) => string | null | undefined,
): T {
  assertOwner(session.owner ?? interactiveOwner(session.id), expected.owner);
  if (userOf(session) !== (expected.ownerUserId ?? null)) throw new Error('session user owner mismatch');
  if ((session.runtimeProfileHash ?? null) !== (expected.profileHash ?? null)) {
    throw new Error(`session ${session.id} runtime profile hash mismatch`);
  }
  session.touch?.();
  return session;
}

/**
 * A public session id has one in-flight acquisition. Compatible callers join
 * its result; each caller validates the returned owner/profile before use.
 * Native pools, capacity, recovery and release barriers stay with the runtime.
 */
export class PendingSessionAcquisitions<T> extends Map<string, Promise<T>> {
  private readonly releases = new Map<string, {
    work: Promise<void>;
    failedCleanup: boolean;
    cleanupError?: unknown;
  }>();

  async acquire(id: string, create: () => Promise<T>, compatible: (session: T) => T): Promise<T> {
    const releasing = this.releases.get(id);
    if (releasing) {
      await this.awaitRelease(releasing);
      return this.acquire(id, create, compatible);
    }
    const pending = this.get(id);
    if (pending) return compatible(await pending);
    // Reserve before any creation work, including synchronous reentrant calls.
    const work = Promise.resolve().then(create);
    this.set(id, work);
    try { return compatible(await work); }
    finally { if (this.get(id) === work) this.delete(id); }
  }
  async waitForRelease(id: string): Promise<void> {
    while (this.releases.has(id)) await this.awaitRelease(this.releases.get(id)!);
  }

  private async awaitRelease(barrier: { work: Promise<void>; failedCleanup: boolean; cleanupError?: unknown }): Promise<void> {
    try { await barrier.work; }
    catch (error) {
      // A refused stale-owner release never began cleanup. It must not poison
      // a compatible owner's queued acquisition. Unconfirmed native cleanup
      // still fails closed, so two providers cannot overlap under one id.
      if (barrier.failedCleanup) throw barrier.cleanupError;
      if ((error as { code?: string }).code !== 'SESSION_OWNER_MISMATCH') throw error;
    }
  }

  async release(id: string, cleanup: () => Promise<void> | void): Promise<void> {
    const pending = this.get(id);
    const previous = this.releases.get(id);
    const barrier = { work: Promise.resolve(), failedCleanup: false, cleanupError: undefined as unknown };
    const work = Promise.resolve().then(async () => {
      if (previous) {
        await previous.work.catch(() => {});
        barrier.failedCleanup = previous.failedCleanup;
        barrier.cleanupError = previous.cleanupError;
      }
      // Failed acquisition has already retired its provider resources.
      if (pending) await pending.catch(() => {});
      try {
        await cleanup();
        barrier.failedCleanup = false;
        barrier.cleanupError = undefined;
      } catch (error) {
        if ((error as { code?: string }).code !== 'SESSION_OWNER_MISMATCH') {
          barrier.failedCleanup = true;
          barrier.cleanupError = error;
        }
        throw error;
      }
    });
    barrier.work = work;
    this.releases.set(id, barrier);
    let reusable = false;
    try { await work; reusable = true; }
    catch (error) {
      reusable = !barrier.failedCleanup && (error as { code?: string }).code === 'SESSION_OWNER_MISMATCH';
      throw error;
    } finally {
      // Retain a failed native cleanup as a tombstone. A later release may
      // retry it, but acquisition must not reuse the id while stop is unknown.
      if (reusable && this.releases.get(id) === barrier) this.releases.delete(id);
    }
  }
}
