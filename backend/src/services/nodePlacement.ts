import { DomainError } from './domainErrors';

export interface NodePlacementLookup {
  getTree(id: string): { workspace_id: string } | null | undefined;
  getNode(id: string): { workspace_id: string; tree_id?: string | null } | null | undefined;
}

/**
 * The tree a node placed like this belongs in: its parent's tree when it has
 * a parent, else the tree it names (none for a legacy or trashed root). A
 * tree or parent from another workspace is refused.
 */
export function resolveNodeTree(
  workspaceId: string,
  treeId: string | null,
  parentId: string | null,
  lookup: NodePlacementLookup,
): string | null {
  if (treeId && lookup.getTree(treeId)?.workspace_id !== workspaceId) {
    throw new DomainError('conflict', 'node_tree_workspace_mismatch', 'node tree must belong to the same workspace');
  }
  if (!parentId) return treeId;
  const parent = lookup.getNode(parentId);
  if (!parent || parent.workspace_id !== workspaceId) {
    throw new DomainError('conflict', 'node_parent_workspace_mismatch', 'node parent and child must belong to the same workspace');
  }
  return parent.tree_id ?? null;
}

/** Legacy nodes remain valid when both parent and child have no tree. A null
 * tree is an actual placement, not a wildcard for a node in another tree. */
export function assertNodePlacement(
  workspaceId: string,
  treeId: string | null,
  parentId: string | null,
  lookup: NodePlacementLookup,
): void {
  if (resolveNodeTree(workspaceId, treeId, parentId, lookup) !== treeId) {
    throw new DomainError('conflict', 'node_parent_tree_mismatch', 'node parent and child must belong to the same tree');
  }
}

/** Edge endpoints are nodes of the workspace, and a branch or link edge stays inside one tree. */
export function assertEdgePlacement(
  workspaceId: string,
  edge: { kind: string; sourceNodeId: string; targetNodeId: string },
  lookup: Pick<NodePlacementLookup, 'getNode'>,
): void {
  const source = lookup.getNode(edge.sourceNodeId);
  const target = lookup.getNode(edge.targetNodeId);
  if (!source || !target || source.workspace_id !== workspaceId || target.workspace_id !== workspaceId) {
    throw new DomainError('conflict', 'edge_workspace_mismatch', 'edge endpoints must belong to the same workspace');
  }
  if ((edge.kind === 'branch' || edge.kind === 'link') && source.tree_id !== target.tree_id) {
    throw new DomainError('conflict', 'edge_tree_mismatch', `${edge.kind} edge endpoints must belong to the same tree`);
  }
}

/** A tree of the workspace whose root node is in that tree. */
export function assertTreeRoot(
  workspaceId: string,
  tree: { id: string; workspace_id: string; root_node_id: string },
  lookup: Pick<NodePlacementLookup, 'getNode'>,
): void {
  const root = lookup.getNode(tree.root_node_id);
  if (tree.workspace_id !== workspaceId || !root || root.workspace_id !== workspaceId || root.tree_id !== tree.id) {
    throw new DomainError('conflict', 'tree_root_mismatch', `tree ${tree.id} root must belong to the same workspace and tree`);
  }
}

/** The workspace's active tree, when it names one, is one of its own trees. */
export function assertActiveTree(activeTreeId: string | null | undefined, workspaceTrees: () => Array<{ id?: unknown }>): void {
  if (activeTreeId && !workspaceTrees().some((tree) => tree.id === activeTreeId)) {
    throw new DomainError('conflict', 'active_tree_workspace_mismatch', 'active tree must belong to the same workspace');
  }
}
