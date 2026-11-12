import type { MemoryRecord, MemoryScope } from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { extractedMemoryInUserScope } from './extractionPolicy';
import { memoryBodyHash, pendingMaybeGlobalMemoryIds } from './extractionRepository';
import { activeMemoryBodies, listOwnersWithPendingMemories } from './memoryRepository';
import { approveMemory, listMemories, rejectMemory, updateMemory, type MemoryCaller } from './memoryService';

/**
 * Michi Memory no longer waits for approval. Older versions stored a memory
 * as pending when an agent saved it in a turn that read untrusted content,
 * and every automatic extraction as pending; this boot step activates them
 * once, as if the user had approved each one.
 */

/** meta key: legacy pending memories were activated (once per database). */
const LEGACY_PENDING_META_KEY = 'memory_pending_activated_v1';

export interface LegacyPendingActivation {
  /** Pending memories made active. */
  activated: number;
  /** Pending memories removed because the same body was already active where they apply. */
  merged: number;
  /** Activated extracted memories moved to the user scope (maybe_global preferences and facts). */
  promoted: number;
}

/** The caller's pending memories, oldest first (listMemories pages newest first). */
function pendingOldestFirst(caller: MemoryCaller): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  let cursor: string | null = null;
  do {
    const page = listMemories(caller, { status: ['pending'], cursor, limit: 200 });
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return records.reverse();
}

/**
 * One owner's pending memories, oldest first, with approveMemory's semantics
 * (version + 1, scope versions bumped, the memory a pending correction names
 * becomes superseded, an 'approved' change event). A pending memory whose
 * normalized body (memoryBodyHash) is already active in the user scope, or in
 * the workspace it applies to, is rejected instead (rejectMemory: a hard
 * delete whose removal hooks leave the extraction tombstone). An extracted
 * memory the extractor marked maybe_global moves to the user scope when
 * extractedMemoryInUserScope says so, as new extraction commits it.
 * sourceRisk stays as provenance.
 */
function activateOwner(ownerUserId: string, totals: LegacyPendingActivation): void {
  const caller = { ownerUserId };
  const maybeGlobal = new Set(pendingMaybeGlobalMemoryIds(ownerUserId));
  for (const pending of pendingOldestFirst(caller)) {
    const promote = pending.origin === 'extracted' && pending.scope.kind === 'workspace' && maybeGlobal.has(pending.id)
      && extractedMemoryInUserScope(pending.kind, 'maybe_global');
    const target: MemoryScope = promote ? { kind: 'user' } : pending.scope;
    const hash = memoryBodyHash(pending.body);
    // Read again for every memory: an approval before it may have superseded or added one.
    const active = activeMemoryBodies(ownerUserId, target.kind === 'workspace' ? target.workspaceId : null);
    if (active.some((body) => memoryBodyHash(body) === hash)) {
      rejectMemory(caller, pending.id);
      totals.merged += 1;
      continue;
    }
    approveMemory(caller, pending.id);
    totals.activated += 1;
    if (promote) {
      updateMemory(caller, pending.id, { scope: target });
      totals.promoted += 1;
    }
  }
}

/**
 * Once per database, at startup, after the extraction hooks are installed
 * (installMemoryExtractionHooks, so merged duplicates leave tombstones) and
 * before any turn or the scheduler starts: every owner's pending memories
 * become active (activateOwner). One transaction: a failure leaves every
 * memory pending and the step runs again at the next start. Returns the
 * counts, or null when this already ran.
 */
export function activateLegacyPendingMemories(now = Date.now()): LegacyPendingActivation | null {
  return runInTransaction(() => {
    const db = getDb();
    if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(LEGACY_PENDING_META_KEY)) return null;
    const totals: LegacyPendingActivation = { activated: 0, merged: 0, promoted: 0 };
    for (const ownerUserId of listOwnersWithPendingMemories()) activateOwner(ownerUserId, totals);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(LEGACY_PENDING_META_KEY, String(now));
    return totals;
  });
}
