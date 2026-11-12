// Tombstones: the purged_at TTL, the lazy GC and the guards the save* functions use to
// refuse writes that would revive a purged workspace or node.
import { getDb } from '../db';

/**
 * How long tombstone rows (workspaces / nodes with non-null `purged_at`) are
 * kept around before GC. The window has to outlast any reasonable offline-tab
 * snapshot age — 90 days covers laptops sleeping for weeks and phones offline
 * for a couple of months. Beyond that the user accepts that an extremely
 * stale client could revive a deleted row, in exchange for not letting
 * tombstone tables grow without bound.
 *
 * GC runs lazily: every successful purge cleans up rows older than this
 * threshold. There is no background timer.
 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Lazy garbage collector for tombstone rows. Drops nodes / workspaces whose
 * `purged_at` is older than `TOMBSTONE_TTL_MS`. Called at the end of every
 * successful purge / deleteWorkspace so the tables don't grow forever.
 *
 * Exported for tests and so an out-of-band ops command can trigger it.
 */
export function runTombstoneGc(): { workspaces: number; nodes: number; contexts: number } {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const db = getDb();
  const nodes = db.prepare(
    'DELETE FROM nodes WHERE purged_at IS NOT NULL AND purged_at < ?',
  ).run(cutoff).changes as number;
  const workspaces = db.prepare(
    'DELETE FROM workspaces WHERE purged_at IS NOT NULL AND purged_at < ?',
  ).run(cutoff).changes as number;
  return { nodes, workspaces, contexts: gcContextTombstones(cutoff) };
}

/**
 * Tombstone-status helpers used by the saveX functions to refuse writes that
 * would resurrect a tombstoned id. Cheap (single PK lookup), cached by
 * SQLite's prepared-statement cache.
 */
export function isWorkspaceTombstoned(workspaceId: string): boolean {
  const row = getDb()
    .prepare('SELECT purged_at FROM workspaces WHERE id = ?')
    .get(workspaceId) as { purged_at: number | null } | undefined;
  return row?.purged_at != null;
}

export function isNodeTombstoned(nodeId: string): boolean {
  const row = getDb()
    .prepare('SELECT purged_at FROM nodes WHERE id = ?')
    .get(nodeId) as { purged_at: number | null } | undefined;
  return row?.purged_at != null;
}

export function gcContextTombstones(cutoff: number): number {
  return Number(getDb().prepare("DELETE FROM context_tombstones WHERE deleted_at < ?").run(cutoff).changes);
}
