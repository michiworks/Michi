import { getDb } from '../db';
import { isNodeTombstoned, isWorkspaceTombstoned } from './tombstones';

export interface EdgeRow {
  id: string;
  workspace_id: string;
  source_node_id: string;
  target_node_id: string;
  kind: string;
  anchor_message_id?: string | null;
  /** Immutable fork cut (migration 0030), unlike the UI-owned anchor. */
  fork_boundary_message_id?: string | null;
  /** How the child session was seeded: native | text | extracted. */
  fork_kind?: string | null;
  created_at?: number | null;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

// --- Edge CRUD ---

export function listEdges(workspaceId: string, userId?: string): EdgeRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    return getDb().prepare(
      'SELECT e.* FROM edges e JOIN workspaces w ON e.workspace_id = w.id WHERE e.workspace_id = ? AND w.owner_user_id = ?'
    ).all(workspaceId, userId) as unknown as EdgeRow[];
  }
  return getDb().prepare('SELECT * FROM edges WHERE workspace_id = ?').all(workspaceId) as unknown as EdgeRow[];
}

export function saveEdge(edge: EdgeRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    const owned = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(edge.workspace_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — refuse if either endpoint or the workspace is purged.
  if (
    isWorkspaceTombstoned(edge.workspace_id)
    || isNodeTombstoned(edge.source_node_id)
    || isNodeTombstoned(edge.target_node_id)
  ) return;
  const forkBoundaryMessageId = edge.fork_boundary_message_id
    ?? (edge.kind === 'branch' ? edge.anchor_message_id ?? null : null);
  const { fork_boundary_message_id: _ignoredBoundary, fork_kind: forkKind, ...edgeRest } = edge;
  getDb().prepare(`
    INSERT INTO edges (id, workspace_id, source_node_id, target_node_id, kind, anchor_message_id,
      fork_boundary_message_id, fork_kind, created_at, rev)
    VALUES (@id, @workspace_id, @source_node_id, @target_node_id, @kind, @anchor_message_id,
      @fork_boundary_message_id, @fork_kind, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      source_node_id=excluded.source_node_id,
      target_node_id=excluded.target_node_id,
      kind=excluded.kind,
      anchor_message_id=excluded.anchor_message_id,
      -- Immutable fork provenance survives both UI anchor cleanup and stale
      -- graph snapshots that do not know the column.
      fork_boundary_message_id=COALESCE(edges.fork_boundary_message_id, excluded.fork_boundary_message_id),
      fork_kind=COALESCE(excluded.fork_kind, edges.fork_kind),
      created_at=excluded.created_at,
      rev=COALESCE(excluded.rev, edges.rev)
  `).run({
    anchor_message_id: null,
    created_at: null,
    rev: null,
    ...edgeRest,
    fork_kind: forkKind ?? null,
    fork_boundary_message_id: forkBoundaryMessageId,
  });
}

/** Record how a branch session was actually seeded and persist its immutable cut. */
export function setEdgeForkProvenance(edgeId: string, input: {
  forkKind?: 'native' | 'text' | 'extracted' | null;
  forkBoundaryMessageId?: string | null;
}): void {
  getDb().prepare(`
    UPDATE edges
    SET fork_kind = COALESCE(?, fork_kind),
        fork_boundary_message_id = COALESCE(fork_boundary_message_id, ?)
    WHERE id = ?
  `).run(input.forkKind ?? null, input.forkBoundaryMessageId ?? null, edgeId);
}

export function deleteEdge(id: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    getDb().prepare(
      'DELETE FROM edges WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM edges WHERE id = ?) AND owner_user_id = ?)'
    ).run(id, id, userId);
    return;
  }
  getDb().prepare('DELETE FROM edges WHERE id = ?').run(id);
}
