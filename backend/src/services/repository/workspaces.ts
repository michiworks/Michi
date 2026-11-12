import { isSystemWorkspaceSettings, mergeServerOwnedSettings } from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { purgeWorkspacePages } from '../pages/repository';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { purgeScheduledJobsForWorkspace } from '../scheduledJobs/workspacePurge';
import { purgeWorkspaceMemories } from '../memory/memoryRepository';
import { recordStructureChange, recordWorkspaceRowChange } from '../structureEvents';
import path from 'node:path';
import { runTombstoneGc } from './tombstones';

/** A registered folder within a workspace. folders[0] is the immutable cwd. */
export interface FolderEntry {
  id: string;
  path: string;
  label?: string;
  addedAt: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  cwd?: string | null;
  active_tree_id?: string | null;
  created_at: number;
  updated_at: number;
  settings?: string | null;
  deleted_at?: number | null;
  archived_at?: number | null;
  backend?: string | null;
  /** Cloud-mode owner. Nullable in SQLite (NOT NULL enforced in app code).
   *  The route layer sets this to req.user.id on INSERT in cloud mode.
   *  Desktop mode: always null / ignored. */
  owner_user_id?: string | null;
  pinned_at?: number | null;
  /** Tombstone — Unix ms when this workspace was permanently purged. Non-null
   *  rows are filtered out of reads and refused on write so a stale POST /sync
   *  from another tab cannot resurrect them. GC'd by `runTombstoneGc()` after
   *  TOMBSTONE_TTL_MS. See migration 0004. */
  purged_at?: number | null;
  /** Per-workspace monotonic sync version (sync L2, migration 0006). Bumped
   *  once per sync txn; managed by bumpWorkspaceRev (L2.2), NOT bound by
   *  saveWorkspace's INSERT (defaults to 0 on insert, preserved on conflict). */
  sync_rev?: number;
  /** Persistence ownership protocol. v2 workspaces reject legacy snapshot sync. */
  persistence_version?: number;
  /** JSON-serialized FolderEntry[]. folders[0].path is the immutable cwd.
   *  NULL/empty + cwd present → auto-upgrade to [{path: cwd}]. */
  folders?: string | null;
}

// --- Workspace CRUD ---

// Omitting userId is the trusted background/server API. Request adapters must
// obtain it through requestOwnerUserId after requireRequestAccess; an explicitly
// supplied empty id remains scoped and can never become a global read.
export function listWorkspaces(userId?: string): WorkspaceRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    return getDb().prepare(
      'SELECT * FROM workspaces WHERE owner_user_id = ? AND purged_at IS NULL ORDER BY updated_at DESC',
    ).all(userId) as unknown as WorkspaceRow[];
  }
  return getDb()
    .prepare('SELECT * FROM workspaces WHERE purged_at IS NULL ORDER BY updated_at DESC')
    .all() as unknown as WorkspaceRow[];
}

export function getWorkspace(id: string, userId?: string): WorkspaceRow | null {
  const row =
    (getDb().prepare('SELECT * FROM workspaces WHERE id = ? AND purged_at IS NULL').get(id) as unknown as WorkspaceRow)
    ?? null;
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined && row) {
    if (row.owner_user_id !== userId) return null;
  }
  return row;
}

// ── Multi-folder helpers ─────────────────────────────────────────────────────

/**
 * Parse `WorkspaceRow.folders` JSON with fallback to legacy `cwd`.
 * Returns a guaranteed non-null array (may be empty if workspace has no cwd).
 */
export function parseFolders(ws: WorkspaceRow): FolderEntry[] {
  if (ws.folders) {
    try {
      const arr = JSON.parse(ws.folders);
      if (Array.isArray(arr) && arr.length > 0) return arr as FolderEntry[];
    } catch { /* fall through to cwd fallback */ }
  }
  // Legacy fallback: single cwd → synthesized folder entry
  if (ws.cwd) {
    return [{ id: 'legacy-cwd', path: ws.cwd, addedAt: ws.created_at }];
  }
  return [];
}

/** Max folders per workspace. */
export const MAX_FOLDERS = 10;

/**
 * Check whether `newPath` nests with any existing folder.
 * Returns an error message string, or null if valid.
 */
export function validateNoNesting(existing: FolderEntry[], newPath: string): string | null {
  const resolved = path.resolve(newPath);
  for (const f of existing) {
    const existingResolved = path.resolve(f.path);
    if (resolved === existingResolved) {
      return `"${newPath}" is already registered`;
    }
    if (resolved.startsWith(existingResolved + path.sep)) {
      return `"${newPath}" is already contained within "${f.path}"`;
    }
    if (existingResolved.startsWith(resolved + path.sep)) {
      return `"${f.path}" is inside "${newPath}" — remove it first`;
    }
  }
  return null;
}

/**
 * Upsert a workspace row. Refuses to write if a tombstone exists for this id
 * (purged_at IS NOT NULL) — that's the multi-tab anti-revival guard. The
 * caller's POST /sync will silently no-op for tombstoned ids; nodes / edges
 * referencing the workspace are skipped by their own guards (FK still works).
 */
export function saveWorkspace(ws: WorkspaceRow): void {
  // ON CONFLICT WHERE excluded.purged_at IS NULL would be cleaner but
  // sqlite3's WHERE clause on ON CONFLICT requires NOT NULL on the conflict
  // target's column — the row itself is the conflict, not excluded. Cheaper
  // and clearer to read-then-skip in app code.
  const existing = getDb()
    .prepare('SELECT purged_at, settings, name, deleted_at, archived_at FROM workspaces WHERE id = ?')
    .get(ws.id) as {
      purged_at: number | null;
      settings: string | null;
      name: string;
      deleted_at: number | null;
      archived_at: number | null;
    } | undefined;
  if (existing && existing.purged_at !== null) return;

  getDb().prepare(`
    INSERT INTO workspaces (id, name, cwd, active_tree_id, created_at, updated_at, settings, deleted_at, archived_at, pinned_at, backend, owner_user_id, folders)
    VALUES (@id, @name, @cwd, @active_tree_id, @created_at, @updated_at, @settings, @deleted_at, @archived_at, @pinned_at, @backend, @owner_user_id, @folders)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, cwd=excluded.cwd,
      active_tree_id=excluded.active_tree_id, updated_at=excluded.updated_at, settings=excluded.settings,
      deleted_at=excluded.deleted_at, archived_at=excluded.archived_at, pinned_at=excluded.pinned_at,
      backend=excluded.backend,
      owner_user_id=COALESCE(excluded.owner_user_id, workspaces.owner_user_id),
      folders=excluded.folders
  `).run({
    cwd: null, active_tree_id: null, deleted_at: null, archived_at: null, pinned_at: null, backend: 'kiro', owner_user_id: null, folders: null,
    ...ws,
    // Server-owned keys (the assistant's `system` marker) come only from the
    // stored row: no snapshot or insert can set, change or drop them.
    settings: mergeServerOwnedSettings(existing?.settings, ws.settings),
  });
  recordWorkspaceRowChange(existing ?? null, ws);
}

/**
 * Permanently delete a workspace by tombstoning it. Cascades by also
 * tombstoning every node in the workspace and physically deleting messages,
 * edges, trees, contexts (those only matter when joined to a live node;
 * the node tombstone already blocks revival of the workspace's structure).
 *
 * Triggers a lazy GC pass at the end to drop tombstones older than
 * TOMBSTONE_TTL_MS. In cloud mode the workspace must be owned by the
 * caller for the tombstone to land — otherwise the call is a no-op.
 */
export function deleteWorkspace(id: string, userId?: string): void {
  runInTransaction(() => purgeWorkspaceInTransaction(id, userId));
  runTombstoneGc();
}

/** deleteWorkspace's purge, for a caller that owns the surrounding transaction (backup replace import). */
export function purgeWorkspaceInTransaction(id: string, userId?: string): void {
  const now = Date.now();
  const db = getDb();
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    const owned = db
      .prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?')
      .get(id, userId);
    if (!owned) return;
  }
  const workspace = db.prepare('SELECT owner_user_id,purged_at,settings FROM workspaces WHERE id=?')
    .get(id) as { owner_user_id: string | null; purged_at: number | null; settings: string | null } | undefined;
  if (workspace && workspace.purged_at === null && !isSystemWorkspaceSettings(workspace.settings)) {
    purgeScheduledJobsForWorkspace(id);
    purgeWorkspacePages(id, workspace.owner_user_id ?? LOCAL_AGENT_OWNER_ID);
  }
  purgeWorkspaceMemories(id);
  const purged = db.prepare('UPDATE workspaces SET purged_at = ? WHERE id = ? AND purged_at IS NULL')
    .run(now, id);
  if (Number(purged.changes) > 0) {
    recordStructureChange({ entity: 'workspace', op: 'purged', workspaceId: id, ownerUserId: workspace?.owner_user_id ?? null });
  }
  db.prepare('UPDATE nodes SET purged_at = ? WHERE workspace_id = ? AND purged_at IS NULL')
    .run(now, id);
  db.prepare(
    'DELETE FROM messages WHERE node_id IN (SELECT id FROM nodes WHERE workspace_id = ?)',
  ).run(id);
  db.prepare('DELETE FROM edges WHERE workspace_id = ?').run(id);
  db.prepare('DELETE FROM trees WHERE workspace_id = ?').run(id);
  db.prepare('DELETE FROM contexts WHERE workspace_id = ?').run(id);
}

// --- Backend / external session helpers (v9) ---

export function setWorkspaceBackend(workspaceId: string, backend: string): void {
  getDb().prepare('UPDATE workspaces SET backend = ?, updated_at = ? WHERE id = ?')
         .run(backend, Date.now(), workspaceId);
}

export function getWorkspaceBackend(workspaceId: string): string | null {
  const row = getDb().prepare('SELECT backend FROM workspaces WHERE id = ?')
                     .get(workspaceId) as { backend: string | null } | undefined;
  return row?.backend ?? null;
}
