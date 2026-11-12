import { getDb } from './db';

/**
 * Graph rows that break an invariant the write paths enforce. Each query
 * counts rows; purged (tombstoned) nodes are ignored. A trashed or archived
 * node keeps its parent and tree but loses its branch edges, so only live
 * pairs need an edge.
 */
const CHECKS = {
  /** A child stored in a tree other than its parent's (no tree counts as one). */
  childOutsideParentTree: `
    SELECT COUNT(*) AS count FROM nodes c JOIN nodes p ON p.id = c.parent_node_id
    WHERE c.purged_at IS NULL AND p.purged_at IS NULL
      AND c.workspace_id = p.workspace_id AND c.tree_id IS NOT p.tree_id`,
  /** A live child of a live parent with no branch edge between them. */
  liveChildWithoutBranchEdge: `
    SELECT COUNT(*) AS count FROM nodes c JOIN nodes p ON p.id = c.parent_node_id
    WHERE c.purged_at IS NULL AND p.purged_at IS NULL AND c.deleted_at IS NULL AND p.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_node_id = p.id AND e.target_node_id = c.id
        AND COALESCE(e.kind, 'branch') = 'branch')`,
  /** A tree whose root node is gone, or stored in another tree or workspace. */
  treeWithoutRoot: `
    SELECT COUNT(*) AS count FROM trees t LEFT JOIN nodes r ON r.id = t.root_node_id AND r.purged_at IS NULL
    WHERE r.id IS NULL OR r.tree_id IS NOT t.id OR r.workspace_id <> t.workspace_id`,
  /** A node whose parent or tree belongs to another workspace. */
  crossWorkspacePlacement: `
    SELECT COUNT(*) AS count FROM nodes c
      LEFT JOIN nodes p ON p.id = c.parent_node_id LEFT JOIN trees t ON t.id = c.tree_id
    WHERE c.purged_at IS NULL AND ((p.id IS NOT NULL AND p.workspace_id <> c.workspace_id)
      OR (t.id IS NOT NULL AND t.workspace_id <> c.workspace_id))`,
} as const;

/** Counts per broken invariant, across every workspace. Reads only: nothing is repaired. */
export function scanGraphIntegrity(): Record<keyof typeof CHECKS, number> {
  const db = getDb();
  const report = {} as Record<keyof typeof CHECKS, number>;
  for (const [name, sql] of Object.entries(CHECKS) as Array<[keyof typeof CHECKS, string]>) {
    report[name] = Number((db.prepare(sql).get() as { count: number }).count);
  }
  return report;
}
