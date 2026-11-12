import { getDb, runInTransaction } from '../db';
import { recordStructureChange, recordTreeRowChange } from '../structureEvents';
import { isWorkspaceTombstoned } from './tombstones';

export interface TreeRow {
  id: string;
  workspace_id: string;
  root_node_id: string;
  name?: string | null;
  archived_at?: number | null;
  pinned_at?: number | null;
  last_active_at: number;
  created_at: number;
  /** Per-row sync version (sync L2, migration 0006). NULL = predates versioning
   *  / no claim. Stamped by leaf save* via COALESCE; guard reads it in L2.2. */
  rev?: number | null;
}

// --- Tree CRUD ---

export function listTrees(workspaceId: string, userId?: string): TreeRow[] {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    return getDb().prepare(
      'SELECT t.* FROM trees t JOIN workspaces w ON t.workspace_id = w.id WHERE t.workspace_id = ? AND w.owner_user_id = ? ORDER BY t.last_active_at DESC'
    ).all(workspaceId, userId) as unknown as TreeRow[];
  }
  return getDb().prepare('SELECT * FROM trees WHERE workspace_id = ? ORDER BY last_active_at DESC').all(workspaceId) as unknown as TreeRow[];
}

export function saveTree(tree: TreeRow, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    const owned = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(tree.workspace_id, userId);
    if (!owned) return;
  }
  // Tombstone guard — refuse to revive trees inside a purged workspace.
  if (isWorkspaceTombstoned(tree.workspace_id)) return;
  const existing = getDb().prepare('SELECT workspace_id, name, archived_at FROM trees WHERE id = ?')
    .get(tree.id) as { workspace_id: string; name: string | null; archived_at: number | null } | undefined;
  getDb().prepare(`
    INSERT INTO trees (id, workspace_id, root_node_id, name, archived_at, pinned_at, last_active_at, created_at, rev)
    VALUES (@id, @workspace_id, @root_node_id, @name, @archived_at, @pinned_at, @last_active_at, @created_at, @rev)
    ON CONFLICT(id) DO UPDATE SET
      root_node_id=excluded.root_node_id, name=excluded.name,
      archived_at=excluded.archived_at, pinned_at=excluded.pinned_at,
      last_active_at=excluded.last_active_at,
      rev=COALESCE(excluded.rev, trees.rev)
  `).run({ name: null, archived_at: null, pinned_at: null, rev: null, ...tree });
  // An upsert never moves a tree: the stored workspace stands.
  recordTreeRowChange(existing ?? null, { ...tree, workspace_id: existing?.workspace_id ?? tree.workspace_id });
}

export function deleteTree(id: string, userId?: string): void {
  // nodes.tree_id cascades, so the Tree's nodes go too.
  const existing = getDb().prepare('SELECT workspace_id FROM trees WHERE id = ?')
    .get(id) as { workspace_id: string } | undefined;
  const result = process.env.MICHI_CLOUD === '1' && userId !== undefined
    ? getDb().prepare(
      'DELETE FROM trees WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM trees WHERE id = ?) AND owner_user_id = ?)'
    ).run(id, id, userId)
    : getDb().prepare('DELETE FROM trees WHERE id = ?').run(id);
  if (existing && Number(result.changes) > 0) {
    recordStructureChange({ entity: 'tree', op: 'deleted', workspaceId: existing.workspace_id, treeId: id });
  }
}

/**
 * Move a tree (its row + every node + every edge with both endpoints in the
 * tree's node set) from one workspace to another. Edges that cross the
 * boundary (only one endpoint inside the tree) are dropped — they would
 * otherwise violate the workspace_id invariant on the edges table.
 *
 * Idempotent on retry: ON CONFLICT in saveTree/saveNode/saveEdge handles
 * partial completion. The whole operation runs in a single transaction so
 * a crash leaves nothing half-moved.
 */
export function moveTreeToWorkspace(
  treeId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
  userId?: string,
): { movedNodes: number; movedEdges: number; droppedEdges: number } {
  return runInTransaction(() => {
    const db = getDb();
    if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
      const srcOwned = db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(fromWorkspaceId, userId);
      if (!srcOwned) throw new Error(`source workspace ${fromWorkspaceId} not found`);
      const dstOwned = db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?').get(toWorkspaceId, userId);
      if (!dstOwned) throw new Error(`target workspace ${toWorkspaceId} not found`);
    }
    const tree = db
      .prepare('SELECT * FROM trees WHERE id = ? AND workspace_id = ?')
      .get(treeId, fromWorkspaceId) as TreeRow | undefined;
    if (!tree) throw new Error(`tree ${treeId} not found in workspace ${fromWorkspaceId}`);
    const toWs = db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(toWorkspaceId);
    if (!toWs) throw new Error(`target workspace ${toWorkspaceId} not found`);

    // Tree row: just flip workspace_id.
    db.prepare('UPDATE trees SET workspace_id = ? WHERE id = ?').run(toWorkspaceId, treeId);

    // The source must not keep the moved tree as its active tree: every later
    // graph command there rejects an active tree from another workspace. Fall
    // back the way the renderer does (pickLandingTreeId): the most recently
    // active unarchived tree whose root is live and no page helper, Meta agent
    // maintenance run or Scheduled-only run, else none. The test fixture
    // landingTree/cases.json holds both to the same pick.
    if (fromWorkspaceId !== toWorkspaceId) {
      db.prepare(`
        UPDATE workspaces SET active_tree_id = (
          SELECT t.id FROM trees t JOIN nodes n ON n.id = t.root_node_id
          WHERE t.workspace_id = workspaces.id AND t.archived_at IS NULL
            AND n.deleted_at IS NULL AND n.purged_at IS NULL
            AND n.page_id IS NULL AND n.maintenance_job_id IS NULL AND n.scheduled_only_job_id IS NULL
          ORDER BY t.last_active_at DESC, t.id LIMIT 1
        )
        WHERE id = ? AND active_tree_id = ?
      `).run(fromWorkspaceId, treeId);
    }

    // Nodes: every node carrying this tree_id, regardless of source workspace.
    const nodeRows = db
      .prepare('SELECT id FROM nodes WHERE tree_id = ?')
      .all(treeId) as { id: string }[];
    const nodeIds = new Set(nodeRows.map((r) => r.id));
    if (nodeIds.size > 0) {
      const placeholders = Array.from(nodeIds).map(() => '?').join(',');
      if (fromWorkspaceId !== toWorkspaceId) {
        db.prepare(`UPDATE turns SET completion_seq = NULL WHERE node_id IN (${placeholders})`)
          .run(...Array.from(nodeIds));
      }
      db.prepare(
        `UPDATE nodes SET workspace_id = ? WHERE id IN (${placeholders})`,
      ).run(toWorkspaceId, ...Array.from(nodeIds));
    }

    // Edges: take edges in the source workspace where BOTH endpoints are in
    // the moved node set, flip them to the target. Drop edges that straddle
    // the boundary — those would land in a workspace whose chatIds no longer
    // contain one of the endpoints.
    const sourceEdges = db
      .prepare('SELECT id, source_node_id, target_node_id FROM edges WHERE workspace_id = ?')
      .all(fromWorkspaceId) as { id: string; source_node_id: string; target_node_id: string }[];
    const moveIds: string[] = [];
    const dropIds: string[] = [];
    for (const e of sourceEdges) {
      const a = nodeIds.has(e.source_node_id);
      const b = nodeIds.has(e.target_node_id);
      if (a && b) moveIds.push(e.id);
      else if (a !== b) dropIds.push(e.id);
    }
    if (moveIds.length > 0) {
      const ph = moveIds.map(() => '?').join(',');
      db.prepare(`UPDATE edges SET workspace_id = ? WHERE id IN (${ph})`)
        .run(toWorkspaceId, ...moveIds);
    }
    if (dropIds.length > 0) {
      const ph = dropIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM edges WHERE id IN (${ph})`).run(...dropIds);
    }
    if (fromWorkspaceId !== toWorkspaceId) {
      recordStructureChange({ entity: 'tree', op: 'moved', workspaceId: toWorkspaceId, fromWorkspaceId, treeId });
    }

    return {
      movedNodes: nodeIds.size,
      movedEdges: moveIds.length,
      droppedEdges: dropIds.length,
    };
  });
}

/** Whether the thread is archived; false for no thread. */
export function isTreeArchived(treeId: string | null | undefined): boolean {
  if (!treeId) return false;
  const row = getDb().prepare('SELECT archived_at FROM trees WHERE id = ?').get(treeId) as { archived_at: number | null } | undefined;
  return row?.archived_at != null;
}
