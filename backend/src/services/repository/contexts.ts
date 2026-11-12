// Artifacts: rows of the contexts table.
import { artifactNameKey, artifactTypeForPath } from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { randomUUID } from 'node:crypto';
import { getWorkspace } from './workspaces';
import { isWorkspaceTombstoned, TOMBSTONE_TTL_MS, gcContextTombstones } from './tombstones';

export interface ContextRow {
  id: string;
  workspace_id: string;
  name: string;
  /** Empty string for `link` artifacts (which carry `url`). */
  file_path: string;
  size?: number | null;
  /** Retired UI flag; column kept for back-compat, always written 0. */
  auto_inject: number;
  source: string;
  /** Artifact type (migration 0008): 'doc' | 'file' | 'image' | 'link'. */
  type?: string | null;
  /** External URL for `link` artifacts. */
  url?: string | null;
  /** Provenance: node/message this artifact came from. */
  origin_node_id?: string | null;
  origin_message_id?: string | null;
  /** 'embedded' | 'reference' — durable so injection resolves after reload. */
  kind?: string | null;
  /** UI pin (shelf ordering); independent of the removed auto-inject. */
  pinned_at?: number | null;
  created_at: number;
  updated_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

// --- Context CRUD ---

export function listContexts(workspaceId: string, userId?: string): ContextRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    return getDb().prepare(
      'SELECT c.* FROM contexts c JOIN workspaces w ON c.workspace_id = w.id WHERE c.workspace_id = ? AND w.owner_user_id = ? ORDER BY c.created_at ASC'
    ).all(workspaceId, userId) as unknown as ContextRow[];
  }
  return getDb().prepare('SELECT * FROM contexts WHERE workspace_id = ? ORDER BY created_at ASC').all(workspaceId) as unknown as ContextRow[];
}

export function saveContext(ctx: ContextRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    const owned = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(ctx.workspace_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — contexts inside a purged workspace stay purged.
  if (isWorkspaceTombstoned(ctx.workspace_id) || isContextTombstoned(ctx.id)) return;
  getDb().prepare(`
    INSERT INTO contexts (id, workspace_id, name, file_path, size, auto_inject, source, type, url, origin_node_id, origin_message_id, kind, pinned_at, created_at, updated_at, rev)
    VALUES (@id, @workspace_id, @name, @file_path, @size, @auto_inject, @source, @type, @url, @origin_node_id, @origin_message_id, @kind, @pinned_at, @created_at, @updated_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, file_path=excluded.file_path, size=excluded.size, auto_inject=excluded.auto_inject,
      source=excluded.source, type=excluded.type, url=excluded.url,
      origin_node_id=excluded.origin_node_id, origin_message_id=excluded.origin_message_id,
      kind=excluded.kind, pinned_at=excluded.pinned_at, updated_at=excluded.updated_at,
      rev=COALESCE(excluded.rev, contexts.rev)
  `).run({
    ...ctx,
    size: ctx.size ?? null,
    type: ctx.type ?? null,
    url: ctx.url ?? null,
    origin_node_id: ctx.origin_node_id ?? null,
    origin_message_id: ctx.origin_message_id ?? null,
    kind: ctx.kind ?? null,
    pinned_at: ctx.pinned_at ?? null,
    rev: ctx.rev ?? null,
  });
}

/**
 * Durable projection for agent save_artifact/update_artifact side effects.
 * Reuses the existing row id for a workspace/name pair so an SSE replay (or a
 * later full workspace load) observes one context rather than a duplicate.
 */
export function upsertAgentContextMetadata(input: {
  workspaceId: string;
  nodeId: string;
  name: string;
  filePath: string;
  size: number;
  userId?: string;
}): string | null {
  const workspace = getWorkspace(input.workspaceId, input.userId);
  if (!workspace) return null;
  const contexts = listContexts(input.workspaceId, input.userId);
  const key = artifactNameKey(input.name);
  // Exact first: of a pair saved before names folded, each keeps its own row.
  const existing = contexts.find((context) => context.name === input.name)
    ?? contexts.find((context) => artifactNameKey(context.name) === key);
  const now = Date.now();
  const id = existing?.id ?? `ctx-${randomUUID()}`;
  saveContext({
    id,
    workspace_id: input.workspaceId,
    name: input.name,
    file_path: input.filePath,
    size: input.size,
    auto_inject: existing?.auto_inject ?? 0,
    source: 'agent',
    type: artifactTypeForPath(input.filePath),
    url: null,
    origin_node_id: existing?.origin_node_id ?? input.nodeId,
    origin_message_id: existing?.origin_message_id ?? null,
    kind: 'embedded',
    pinned_at: existing?.pinned_at ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    rev: existing?.rev ?? null,
  } as ContextRow, input.userId);
  return id;
}

/**
 * Delete an artifact's row and tombstone its id (migration 0081): a later
 * write of that id (a stale window, a request in flight, a replayed
 * artifact_saved) is skipped instead of bringing it back. Only a delete that
 * removed a row writes one, so in cloud mode a caller who does not own the
 * workspace cannot tombstone its artifacts. The row goes first: an
 * interrupted delete leaves no tombstone on a live row.
 *
 * Opens no transaction (runInTransaction does not nest): the command batch
 * runs it inside its own, and a caller outside one uses deleteContextAtomically.
 * Returns whether a row was deleted.
 */
export function deleteContext(id: string, userId?: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT workspace_id FROM contexts WHERE id = ?').get(id) as { workspace_id: string } | undefined;
  if (!row) return false;
  const deleted = process.env.MICHI_CLOUD === '1' && userId !== undefined
    ? db.prepare(
        'DELETE FROM contexts WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?)'
      ).run(id, row.workspace_id, userId)
    : db.prepare('DELETE FROM contexts WHERE id = ?').run(id);
  if (Number(deleted.changes) === 0) return false;
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO context_tombstones (id, workspace_id, deleted_at) VALUES (?, ?, ?)')
    .run(id, row.workspace_id, now);
  gcContextTombstones(now - TOMBSTONE_TTL_MS);
  return true;
}

/** deleteContext in a transaction of its own, for a caller outside one (delete_artifact). */
export function deleteContextAtomically(id: string, userId?: string): boolean {
  return runInTransaction(() => deleteContext(id, userId));
}

/**
 * Whether `id` names a deleted artifact (deleteContext), which no write may
 * bring back, into any workspace: ids are global.
 */
export function isContextTombstoned(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM context_tombstones WHERE id = ?').get(id) !== undefined;
}

/** The workspace an artifact `id` was deleted from (deleteContext), or null when it was not. */
export function contextTombstoneWorkspace(id: string): string | null {
  const row = getDb().prepare('SELECT workspace_id FROM context_tombstones WHERE id = ?').get(id) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}
