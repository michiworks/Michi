// Trash: soft delete and restore, single-node trim and its undo, and the purges that
// tombstone trashed nodes.
import { edgeRowId, isArchiveGroupId } from 'michi-shared';
import { getDb, runInTransaction } from '../db';
import { trashGroupSql } from '../nodeLifecycleSql';
import { recordStructureChange } from '../structureEvents';
import { runTombstoneGc } from './tombstones';

/**
 * Undo payload written to `nodes.trim_snapshot` at trim time. Captures
 * everything `restoreTrimmedNode` needs to put the node back:
 *
 * - `parentId`     — the original parent of the trimmed node. If that
 *                    node is itself trimmed or gone by restore time, the
 *                    resolver walks the snapshot chain up to the nearest
 *                    live ancestor.
 * - `childrenIds`  — the ids that were the node's children at trim time.
 *                    Restore re-steals those still alive (and still parented
 *                    to the trim target) back under the node.
 * - `wasTreeRoot`  — set when the trimmed node was a tree root, so restore
 *                    can put the tree-root pointer back (or recreate the
 *                    tree row if it was dropped because the node had no
 *                    children at trim time).
 */
export interface TrimSnapshot {
  parentId: string | null;
  childrenIds: string[];
  wasTreeRoot: { treeId: string } | null;
}

export function softDeleteNode(id: string, deletedAt: number, groupId: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    getDb().prepare(
      'UPDATE nodes SET deleted_at = ?, deletion_group_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).run(deletedAt, groupId, id, id, userId);
    return;
  }
  getDb().prepare('UPDATE nodes SET deleted_at = ?, deletion_group_id = ? WHERE id = ?').run(deletedAt, groupId, id);
}

export function restoreNode(id: string, userId?: string): void {
  if (process.env.MICHI_CLOUD === '1' && userId !== undefined) {
    getDb().prepare(
      'UPDATE nodes SET deleted_at = NULL, deletion_group_id = NULL WHERE id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = (SELECT workspace_id FROM nodes WHERE id = ?) AND owner_user_id = ?)'
    ).run(id, id, userId);
    return;
  }
  getDb().prepare('UPDATE nodes SET deleted_at = NULL, deletion_group_id = NULL WHERE id = ?').run(id);
}

/**
 * Empty a workspace's trash by tombstoning every soft-deleted node. Returns
 * the count of rows newly tombstoned (already-tombstoned rows are skipped).
 *
 * Why tombstones instead of physical DELETE: a stale POST /sync from another
 * tab carries a snapshot in which the just-purged ids are still alive. With
 * `purged_at` non-null, `saveNode` refuses to revive them.
 *
 * Messages and edges of tombstoned nodes are physically deleted in the same
 * transaction — they only matter when joined to a live node, and the node
 * tombstone already blocks anything from re-creating that join. Trees whose
 * root is now tombstoned (or never had any live nodes) are dropped.
 *
 * Triggers `runTombstoneGc()` at the end so old tombstones don't accumulate.
 */
export function emptyWorkspaceTrash(workspaceId: string): number {
  const changed = runInTransaction(() => {
    const now = Date.now();
    const db = getDb();
    // Archived nodes also carry deleted_at (archive reuses the trim engine),
    // so they are explicitly excluded here — "empty trash" must never touch the
    // archived lane. They are removed only via explicit purgeWorkspaceNodes.
    const purgedIds = db.prepare(
      `SELECT id FROM nodes
       WHERE workspace_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL
         AND ${trashGroupSql('deletion_group_id')}`,
    ).all(workspaceId) as Array<{ id: string }>;
    const result = db.prepare(
      `UPDATE nodes SET purged_at = ?
       WHERE workspace_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL
         AND ${trashGroupSql('deletion_group_id')}`,
    ).run(now, workspaceId);
    recordPurgedNodes(workspaceId, purgedIds.map((row) => row.id));
    // Drop dependent rows for the just-tombstoned nodes. These are physically
    // deleted because a tombstoned node can never come back, so its messages /
    // edges have nowhere to attach.
    db.prepare(
      `DELETE FROM messages
       WHERE node_id IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NOT NULL)`,
    ).run(workspaceId);
    db.prepare(
      `DELETE FROM edges
       WHERE workspace_id = ?
         AND (source_node_id IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NOT NULL)
              OR target_node_id IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NOT NULL))`,
    ).run(workspaceId, workspaceId, workspaceId);
    deleteOrphanedTrees(workspaceId);
    return result.changes as number;
  });
  runTombstoneGc();
  return changed;
}

function recordPurgedNodes(workspaceId: string, nodeIds: readonly string[]): void {
  for (const nodeId of nodeIds) recordStructureChange({ entity: 'node', op: 'purged', workspaceId, nodeId });
}

/** Drop the trees whose root is gone (purged); records each as deleted. */
function deleteOrphanedTrees(workspaceId: string): void {
  const db = getDb();
  const orphaned = db.prepare(
    `SELECT id FROM trees
     WHERE workspace_id = ?
       AND root_node_id NOT IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NULL)`,
  ).all(workspaceId, workspaceId) as Array<{ id: string }>;
  if (orphaned.length === 0) return;
  db.prepare(
    `DELETE FROM trees
     WHERE workspace_id = ?
       AND root_node_id NOT IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NULL)`,
  ).run(workspaceId, workspaceId);
  for (const { id } of orphaned) recordStructureChange({ entity: 'tree', op: 'deleted', workspaceId, treeId: id });
}

/**
 * Tombstone an explicit list of node ids inside a workspace. Used for the
 * "delete permanently" action on a single trash group. nodeIds outside the
 * given workspace are ignored (defence in depth). Same cascade rules as
 * `emptyWorkspaceTrash` — messages/edges/orphan-trees are physically dropped
 * in the same transaction; the tombstone is the anti-revival mechanism.
 */
export function purgeWorkspaceNodes(workspaceId: string, nodeIds: readonly string[]): number {
  if (nodeIds.length === 0) return 0;
  const changed = runInTransaction(() => {
    const now = Date.now();
    const placeholders = nodeIds.map(() => '?').join(',');
    const db = getDb();
    const purgedIds = db.prepare(
      `SELECT id FROM nodes WHERE workspace_id = ? AND id IN (${placeholders}) AND purged_at IS NULL`,
    ).all(workspaceId, ...nodeIds) as Array<{ id: string }>;
    const result = db.prepare(
      `UPDATE nodes SET purged_at = ?
       WHERE workspace_id = ? AND id IN (${placeholders}) AND purged_at IS NULL`,
    ).run(now, workspaceId, ...nodeIds);
    recordPurgedNodes(workspaceId, purgedIds.map((row) => row.id));
    db.prepare(
      `DELETE FROM messages
       WHERE node_id IN (SELECT id FROM nodes WHERE workspace_id = ? AND purged_at IS NOT NULL
                           AND id IN (${placeholders}))`,
    ).run(workspaceId, ...nodeIds);
    db.prepare(
      `DELETE FROM edges
       WHERE workspace_id = ?
         AND (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))`,
    ).run(workspaceId, ...nodeIds, ...nodeIds);
    deleteOrphanedTrees(workspaceId);
    return result.changes as number;
  });
  runTombstoneGc();
  return changed;
}

/**
 * Single-node trim: send a node to trash while keeping its descendants live by
 * reparenting them up. Used for "prune this node out of the conversation"
 * (Phase 2 of the trash redesign). All mutations run in one transaction so a
 * crash leaves the workspace in a consistent state.
 *
 * Algorithm:
 * 1. Snapshot { parentId, childrenIds, wasTreeRoot } into `nodes.trim_snapshot`
 *    so `restoreTrimmedNode` can reverse this operation byte-for-byte.
 * 2. Mark the node trashed (deleted_at, deletion_group_id).
 * 3. Re-home the node's children:
 *    - Normal case (node is mid-tree): every child's parent_node_id becomes
 *      the trimmed node's old parent. New branch edges (old_parent → child)
 *      replace (trimmed → child); the (old_parent → trimmed) edge is dropped.
 *    - Tree-root case with at least one live child: promote the oldest live
 *      child to the new tree root (parent_node_id = NULL). The remaining
 *      children become children of that new root — preserving the
 *      single-root invariant the rest of the codebase relies on. The tree
 *      row's root_node_id pointer is updated in the same step.
 *    - Tree-root case with no live children: the tree row is dropped — there
 *      is no node left to host it.
 *
 * Edge ids are edgeRowId's (`branch-<src>-<tgt>`); INSERT OR
 * IGNORE skips duplicates so a re-run on an already-rewired graph is safe.
 */
export function trimNode(
  workspaceId: string,
  nodeId: string,
  deletedAt: number,
  groupId: string,
): { trimmed: number } {
  return runInTransaction(() => {
    const db = getDb();

    const x = db.prepare(`SELECT id, parent_node_id, workspace_id
                          FROM nodes WHERE id = ? AND workspace_id = ?`)
      .get(nodeId, workspaceId) as { id: string; parent_node_id: string | null; workspace_id: string } | undefined;
    if (!x) return { trimmed: 0 };

    // Children = every node currently pointing at X as parent. Includes both
    // live and already-trashed children — trashed ones still need reparenting
    // at the DB level so that, post-trim, no `parent_node_id` dangles at X.
    // Their own trim_snapshot / deletion_group_id keep them in the trash view.
    const childRows = db.prepare(
      'SELECT id FROM nodes WHERE workspace_id = ? AND parent_node_id = ? AND id <> ?',
    ).all(workspaceId, nodeId, nodeId) as { id: string }[];
    const childrenIds = childRows.map((c) => c.id);

    const treeRow = db.prepare(
      'SELECT id FROM trees WHERE workspace_id = ? AND root_node_id = ?',
    ).get(workspaceId, nodeId) as { id: string } | undefined;
    const wasTreeRoot: TrimSnapshot['wasTreeRoot'] = treeRow ? { treeId: treeRow.id } : null;

    const snapshot: TrimSnapshot = {
      parentId: x.parent_node_id,
      childrenIds,
      wasTreeRoot,
    };

    // Mark the node trashed and stamp the undo data on the same row.
    db.prepare(`UPDATE nodes
                SET trim_snapshot = ?, deleted_at = ?, deletion_group_id = ?
                WHERE id = ?`)
      .run(JSON.stringify(snapshot), deletedAt, groupId, nodeId);

    // Drop the trimmed node's branch edges in both directions. The
    // surrounding-graph rewires (below) re-add the parent→children
    // bypass edges as appropriate.
    db.prepare(
      `DELETE FROM edges WHERE workspace_id = ? AND source_node_id = ? AND kind = 'branch'`,
    ).run(workspaceId, nodeId);
    db.prepare(
      `DELETE FROM edges WHERE workspace_id = ? AND target_node_id = ? AND kind = 'branch'`,
    ).run(workspaceId, nodeId);

    if (wasTreeRoot) {
      // Tree root branch: a tree must always have exactly one root, so we
      // pick the oldest LIVE child as the new root and re-parent the
      // surviving siblings under it. Trashed children stay parented to the
      // new root too — keeping their parent pointer stable so that if they
      // are later restored, they still find a live ancestor.
      const liveChildren = childrenIds.length > 0
        ? (db.prepare(
            `SELECT id FROM nodes
             WHERE workspace_id = ? AND id IN (${childrenIds.map(() => '?').join(',')})
               AND deleted_at IS NULL
             ORDER BY created_at ASC`,
          ).all(workspaceId, ...childrenIds) as { id: string }[])
        : [];

      if (liveChildren.length === 0) {
        // No live children — there is no candidate root. Drop the tree row,
        // but FIRST null out tree_id on any node still pointing at it
        // (including the trimmed node itself, which holds the snapshot we
        // need for restore). Without this, the trees.id FK CASCADE on
        // nodes.tree_id would physically delete those rows.
        db.prepare('UPDATE nodes SET tree_id = NULL WHERE workspace_id = ? AND tree_id = ?')
          .run(workspaceId, wasTreeRoot.treeId);
        db.prepare('DELETE FROM trees WHERE id = ?').run(wasTreeRoot.treeId);
        recordStructureChange({ entity: 'tree', op: 'deleted', workspaceId, treeId: wasTreeRoot.treeId });
      } else {
        const newRoot = liveChildren[0].id;
        // Promote newRoot — tree root carries parent_node_id = NULL.
        db.prepare('UPDATE nodes SET parent_node_id = NULL WHERE id = ?').run(newRoot);
        // Every other child (live or trashed) becomes a child of newRoot.
        const others = childrenIds.filter((id) => id !== newRoot);
        if (others.length > 0) {
          const ph = others.map(() => '?').join(',');
          db.prepare(`UPDATE nodes SET parent_node_id = ? WHERE id IN (${ph})`)
            .run(newRoot, ...others);
          // Add the (newRoot → other) branch edges that replace the dropped
          // (trimmed → other) edges. INSERT OR IGNORE handles re-runs and
          // any pre-existing edge from earlier graph shapes.
          const insert = db.prepare(
            `INSERT OR IGNORE INTO edges (id, workspace_id, source_node_id, target_node_id, kind)
             VALUES (?, ?, ?, ?, 'branch')`,
          );
          for (const oid of others) {
            insert.run(edgeRowId('branch', newRoot, oid), workspaceId, newRoot, oid);
          }
        }
        db.prepare('UPDATE trees SET root_node_id = ? WHERE id = ?').run(newRoot, wasTreeRoot.treeId);
      }
    } else {
      // Normal trim: every child slides up to the trimmed node's old parent.
      if (childrenIds.length > 0) {
        const ph = childrenIds.map(() => '?').join(',');
        db.prepare(`UPDATE nodes SET parent_node_id = ? WHERE id IN (${ph})`)
          .run(x.parent_node_id, ...childrenIds);
        if (x.parent_node_id) {
          const insert = db.prepare(
            `INSERT OR IGNORE INTO edges (id, workspace_id, source_node_id, target_node_id, kind)
             VALUES (?, ?, ?, ?, 'branch')`,
          );
          for (const cid of childrenIds) {
            insert.run(edgeRowId('branch', x.parent_node_id, cid), workspaceId, x.parent_node_id, cid);
          }
        }
      }
    }

    recordStructureChange({
      entity: 'node',
      op: isArchiveGroupId(groupId) ? 'archived' : 'deleted',
      workspaceId,
      nodeId,
      ...(wasTreeRoot ? { treeId: wasTreeRoot.treeId } : {}),
    });
    return { trimmed: 1 };
  });
}

/**
 * Undo a `trimNode`: put the node back where it came from. Mirrors the
 * algorithm in `trimNode` step-for-step, with one twist: the original parent
 * recorded in the snapshot may itself have been trimmed (or hard-purged) in
 * the meantime. The walk-up resolver follows the chain of `trim_snapshot`s
 * until it finds the nearest live ancestor, or `null` if every ancestor is
 * gone (the restored node becomes a tree root in that case).
 *
 * Children that are still live AND whose current parent is the resolved
 * target parent are re-stolen back under the restored node. Children that
 * have since been trashed, purged, or reparented further are left alone —
 * restore is intent-driven, not history-rewriting.
 *
 * Returns { restored: false } if there is no `trim_snapshot` on the node
 * (e.g. it was subtree-deleted, not trimmed) so callers know to fall back
 * to `restoreNode`.
 */
export function restoreTrimmedNode(
  workspaceId: string,
  nodeId: string,
): { restored: boolean } {
  return runInTransaction(() => {
    const db = getDb();

    const x = db.prepare(
      `SELECT id, trim_snapshot FROM nodes WHERE id = ? AND workspace_id = ?`,
    ).get(nodeId, workspaceId) as { id: string; trim_snapshot: string | null } | undefined;
    if (!x || !x.trim_snapshot) return { restored: false };

    const snap = JSON.parse(x.trim_snapshot) as TrimSnapshot;

    // Walk up: from snap.parentId, climb until we hit a live ancestor or run
    // out. Each hop prefers the ancestor's own trim_snapshot.parentId over
    // its current parent_node_id — that preserves the conceptual chain
    // ("under what I was originally under, transitively") instead of the
    // post-trim collapsed chain.
    let targetParent: string | null = snap.parentId;
    const seen = new Set<string>();
    while (targetParent) {
      if (seen.has(targetParent)) {
        // Defensive: should never loop, but if a corrupted snapshot points
        // back at itself, bail out and make the node a root.
        targetParent = null;
        break;
      }
      seen.add(targetParent);
      const p = db.prepare(
        `SELECT id, parent_node_id, deleted_at, trim_snapshot
         FROM nodes WHERE id = ? AND workspace_id = ?`,
      ).get(targetParent, workspaceId) as
        | { id: string; parent_node_id: string | null; deleted_at: number | null; trim_snapshot: string | null }
        | undefined;
      if (!p) { targetParent = null; break; }
      if (p.deleted_at === null) break;
      if (p.trim_snapshot) {
        targetParent = (JSON.parse(p.trim_snapshot) as TrimSnapshot).parentId;
      } else {
        // Subtree-deleted ancestor — its parent_node_id is the last known
        // structural parent; keep climbing.
        targetParent = p.parent_node_id;
      }
    }

    // Apply: restore X with the resolved parent and clear all trash markers.
    db.prepare(`UPDATE nodes
                SET parent_node_id = ?, deleted_at = NULL, deletion_group_id = NULL, trim_snapshot = NULL
                WHERE id = ?`)
      .run(targetParent, nodeId);

    // Re-steal: any snapshot child that's still live and currently parented
    // to the same target parent (i.e. it slid up to where X used to be)
    // moves back under X. Children that were trashed, purged, or reparented
    // further by another trim stay where they are.
    const liveStolenIds: string[] = [];
    if (snap.childrenIds.length > 0) {
      const childRows = db.prepare(
        `SELECT id, parent_node_id, deleted_at
         FROM nodes WHERE workspace_id = ? AND id IN (${snap.childrenIds.map(() => '?').join(',')})`,
      ).all(workspaceId, ...snap.childrenIds) as { id: string; parent_node_id: string | null; deleted_at: number | null }[];
      for (const c of childRows) {
        if (c.deleted_at !== null) continue;
        if (c.parent_node_id !== targetParent) continue;
        liveStolenIds.push(c.id);
      }
      if (liveStolenIds.length > 0) {
        const ph = liveStolenIds.map(() => '?').join(',');
        db.prepare(`UPDATE nodes SET parent_node_id = ? WHERE id IN (${ph})`)
          .run(nodeId, ...liveStolenIds);
      }
    }

    // Rewire edges in step with the new parent/child topology.
    if (targetParent) {
      db.prepare(
        `INSERT OR IGNORE INTO edges (id, workspace_id, source_node_id, target_node_id, kind)
         VALUES (?, ?, ?, ?, 'branch')`,
      ).run(edgeRowId('branch', targetParent, nodeId), workspaceId, targetParent, nodeId);
      if (liveStolenIds.length > 0) {
        // Drop the (targetParent → stolen) bypass edges that trim added.
        const ph = liveStolenIds.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM edges WHERE workspace_id = ? AND source_node_id = ?
             AND target_node_id IN (${ph}) AND kind = 'branch'`,
        ).run(workspaceId, targetParent, ...liveStolenIds);
      }
    }
    if (liveStolenIds.length > 0) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO edges (id, workspace_id, source_node_id, target_node_id, kind)
         VALUES (?, ?, ?, ?, 'branch')`,
      );
      for (const cid of liveStolenIds) {
        insert.run(edgeRowId('branch', nodeId, cid), workspaceId, nodeId, cid);
      }
    }

    // Tree-root restoration: re-seat the root pointer (or recreate the row
    // if trim dropped it because there were no live children at the time).
    if (snap.wasTreeRoot) {
      const tree = db.prepare('SELECT id FROM trees WHERE id = ? AND workspace_id = ?')
        .get(snap.wasTreeRoot.treeId, workspaceId);
      if (tree) {
        db.prepare('UPDATE trees SET root_node_id = ? WHERE id = ?')
          .run(nodeId, snap.wasTreeRoot.treeId);
      } else {
        const now = Date.now();
        db.prepare(
          `INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(snap.wasTreeRoot.treeId, workspaceId, nodeId, now, now);
        // Trim cleared tree_id on the node when it dropped the tree (to
        // avoid the CASCADE wiping the snapshot row). Re-bind it now.
        db.prepare('UPDATE nodes SET tree_id = ? WHERE id = ?')
          .run(snap.wasTreeRoot.treeId, nodeId);
        recordStructureChange({ entity: 'tree', op: 'created', workspaceId, treeId: snap.wasTreeRoot.treeId });
      }
    }

    recordStructureChange({
      entity: 'node',
      op: 'restored',
      workspaceId,
      nodeId,
      ...(snap.wasTreeRoot ? { treeId: snap.wasTreeRoot.treeId } : {}),
    });
    return { restored: true };
  });
}
