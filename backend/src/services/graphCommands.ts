import { DomainError } from './domainErrors';
import { assertActiveTree, assertEdgePlacement, assertNodePlacement, assertTreeRoot } from './nodePlacement';
import { assertGraphNodeInput, requiredGraphId as requiredId } from './graphCommandValidation';
import { nodePlacementRepository } from './nodePlacementRepository';
import { getDb, runInTransaction } from './db';
import { recordStructureChange, recordTreeRowChange } from './structureEvents';
import {
  getNode,
  getWorkspace,
  listEdges,
  listTrees,
  saveEdge,
  saveNode,
  saveTree,
  saveWorkspace,
  type EdgeRow,
  type NodeRow,
  type TreeRow,
  type WorkspaceRow,
} from './dbRepository';
import type { EnsureDurableGraphNodeInput, TreeRowChange } from './graphCommandTypes';

export type { EnsureDurableGraphNodeInput };

export interface EnsureDurableGraphNodeResult {
  workspace: WorkspaceRow;
  tree: TreeRow | null;
  node: NodeRow;
  edges: EdgeRow[];
}

/** Remove only an untouched agent-spawn prerequisite whose runtime session
 * failed to materialize. The guards prevent compensation from deleting a
 * child that another concurrent path already bound or started. */
export function rollbackProvisionalSpawnNode(
  nodeId: string,
  workspaceId: string,
  ownerUserId?: string | null,
): boolean {
  return runInTransaction(() => {
    const row = getDb().prepare(`
      SELECT n.spawned_by_agent, n.status, n.acp_session_id,
             (SELECT COUNT(*) FROM messages m WHERE m.node_id = n.id) AS message_count,
             w.owner_user_id
        FROM nodes n JOIN workspaces w ON w.id = n.workspace_id
       WHERE n.id = ? AND n.workspace_id = ?
    `).get(nodeId, workspaceId) as {
      spawned_by_agent: number;
      status: string;
      acp_session_id: string | null;
      message_count: number;
      owner_user_id: string | null;
    } | undefined;
    if (!row) return false;
    if (process.env.MICHI_CLOUD === '1' && row.owner_user_id !== (ownerUserId ?? null)) return false;
    if (
      row.spawned_by_agent !== 1
      || row.status !== 'idle'
      || row.acp_session_id
      || row.message_count !== 0
    ) return false;
    getDb().prepare('DELETE FROM nodes WHERE id = ? AND workspace_id = ?').run(nodeId, workspaceId);
    recordStructureChange({ entity: 'node', op: 'purged', workspaceId, nodeId, ownerUserId: row.owner_user_id });
    return true;
  });
}

/** What of a graph prerequisite existed before the worker thread ensures it. */
export interface GraphNodePresence {
  workspaceName: string | null;
  node: boolean;
}

export function graphNodePresence(input: EnsureDurableGraphNodeInput): GraphNodePresence {
  return {
    workspaceName: getWorkspace(input.workspace.id)?.name ?? null,
    node: !!getNode(input.node.id),
  };
}

/**
 * The worker thread writes on its own connection, out of sight of the
 * repository's change records: record what its committed ensure changed.
 * `treeChange` is what the worker's saveTree read and wrote, recorded as
 * dbRepository.saveTree records it.
 */
export function recordEnsuredGraphNode(
  input: EnsureDurableGraphNodeInput,
  before: GraphNodePresence,
  treeChange: TreeRowChange | null,
): void {
  const workspaceId = input.workspace.id;
  const after = getWorkspace(workspaceId);
  if (!after) return;
  const ownerUserId = after.owner_user_id ?? null;
  if (before.workspaceName === null) {
    recordStructureChange({ entity: 'workspace', op: 'created', workspaceId, ownerUserId });
  } else if (before.workspaceName !== after.name) {
    recordStructureChange({ entity: 'workspace', op: 'renamed', workspaceId, ownerUserId });
  }
  if (treeChange) recordTreeRowChange(treeChange.before, treeChange.after);
  if (!before.node && getNode(input.node.id)) {
    recordStructureChange({
      entity: 'node',
      op: 'created',
      workspaceId,
      nodeId: input.node.id,
      ...(input.node.treeId ? { treeId: input.node.treeId } : {}),
      ownerUserId,
    });
  }
}

/**
 * Idempotent graph prerequisite command used before a node can own a runtime
 * session. It intentionally creates only the addressed graph slice, never a
 * full workspace snapshot. `server` carries server-owned marks for a node it
 * creates (never from a request body): `scheduledOnlyJobId` hides a
 * Scheduled-only run's thread in the same transaction that creates it.
 */
export function ensureDurableGraphNode(
  input: EnsureDurableGraphNodeInput,
  server: { scheduledOnlyJobId?: string } = {},
): EnsureDurableGraphNodeResult {
  assertGraphNodeInput(input);
  return runInTransaction(() => {
    const workspaceId = requiredId(input.workspace.id, 'workspace.id');
    const nodeId = requiredId(input.node.id, 'node.id');
    const existingWorkspace = getWorkspace(workspaceId);
    if (
      process.env.MICHI_CLOUD === '1'
      && existingWorkspace
      && existingWorkspace.owner_user_id !== input.ownerUserId
    ) {
      throw new DomainError('not_found', 'workspace_not_found', 'workspace not found');
    }

    saveWorkspace({
      id: workspaceId,
      name: input.workspace.name.trim() || 'Untitled',
      cwd: input.workspace.cwd ?? null,
      active_tree_id: input.workspace.activeTreeId ?? null,
      created_at: input.workspace.createdAt,
      updated_at: Date.now(),
      settings: input.workspace.settings === undefined
        ? existingWorkspace?.settings ?? null
        : input.workspace.settings
          ? JSON.stringify(input.workspace.settings)
          : null,
      deleted_at: existingWorkspace?.deleted_at ?? null,
      archived_at: existingWorkspace?.archived_at ?? null,
      pinned_at: existingWorkspace?.pinned_at ?? null,
      backend: existingWorkspace?.backend ?? 'kiro',
      owner_user_id: input.ownerUserId ?? existingWorkspace?.owner_user_id ?? null,
      folders: existingWorkspace?.folders ?? null,
    });

    let treeRow: TreeRow | null = null;
    if (input.tree) {
      const treeId = requiredId(input.tree.id, 'tree.id');
      if (input.node.treeId && input.node.treeId !== treeId) {
        throw new DomainError('conflict', 'node_tree_mismatch', 'node.treeId must match tree.id');
      }
      const existingTree = getDb().prepare(
        'SELECT workspace_id, root_node_id FROM trees WHERE id = ?',
      ).get(treeId) as { workspace_id: string; root_node_id: string } | undefined;
      if (existingTree?.workspace_id !== undefined && existingTree.workspace_id !== workspaceId) {
        throw new DomainError('conflict', 'tree_workspace_mismatch', `tree ${treeId} belongs to a different workspace`);
      }
      if (existingTree && existingTree.root_node_id !== input.tree.rootNodeId) {
        throw new DomainError('conflict', 'tree_identity_mismatch', `tree ${treeId} was replayed with a different root`);
      }
      saveTree({
        id: treeId,
        workspace_id: workspaceId,
        root_node_id: requiredId(input.tree.rootNodeId, 'tree.rootNodeId'),
        name: input.tree.name ?? null,
        archived_at: input.tree.archivedAt ?? null,
        pinned_at: input.tree.pinnedAt ?? null,
        last_active_at: input.tree.lastActiveAt,
        created_at: input.tree.createdAt,
      }, input.ownerUserId ?? undefined);
      treeRow = listTrees(workspaceId).find((tree) => tree.id === treeId) ?? null;
    }

    assertNodePlacement(workspaceId, input.node.treeId ?? null, input.node.parentNodeId ?? null, nodePlacementRepository);

    const existingNode = getNode(nodeId);
    if (existingNode) {
      if (
        existingNode.workspace_id !== workspaceId
        || (existingNode.tree_id ?? null) !== (input.node.treeId ?? null)
        || (existingNode.parent_node_id ?? null) !== (input.node.parentNodeId ?? null)
      ) {
        throw new DomainError('conflict', 'node_identity_mismatch', `node ${nodeId} was replayed with different graph identity`);
      }
    } else {
      saveNode({
        id: nodeId,
        workspace_id: workspaceId,
        tree_id: input.node.treeId ?? null,
        parent_node_id: input.node.parentNodeId ?? null,
        kind: input.node.kind ?? 'chat',
        title: input.node.title ?? null,
        status: 'idle',
        minimized: 0,
        spawned_by_agent: input.node.spawnedByAgent ? 1 : 0,
        current_mode_id: input.node.currentModeId ?? null,
        composer_draft: input.node.composerDraft ?? null,
        created_at: input.node.createdAt,
      }, input.ownerUserId ?? undefined);
      if (server.scheduledOnlyJobId) {
        getDb().prepare('UPDATE nodes SET scheduled_only_job_id = ? WHERE id = ? AND workspace_id = ?')
          .run(server.scheduledOnlyJobId, nodeId, workspaceId);
      }
    }

    if (input.tree) {
      assertTreeRoot(workspaceId, { id: input.tree.id, workspace_id: workspaceId, root_node_id: input.tree.rootNodeId }, nodePlacementRepository);
    }
    assertActiveTree(getWorkspace(workspaceId)?.active_tree_id, () => listTrees(workspaceId));

    for (const edge of input.edges) {
      if (edge.targetNodeId !== nodeId) {
        throw new DomainError('conflict', 'edge_target_mismatch', 'graph prerequisite edges must target the ensured node');
      }
      assertEdgePlacement(workspaceId, edge, nodePlacementRepository);
      const existingEdge = getDb().prepare(`
        SELECT workspace_id, source_node_id, target_node_id, kind FROM edges WHERE id = ?
      `).get(edge.id) as {
        workspace_id: string;
        source_node_id: string;
        target_node_id: string;
        kind: string;
      } | undefined;
      if (existingEdge && existingEdge.workspace_id !== workspaceId) {
        throw new DomainError('conflict', 'edge_workspace_mismatch', `edge ${edge.id} belongs to a different workspace`);
      }
      if (
        existingEdge
        && (
          existingEdge.source_node_id !== edge.sourceNodeId
          || existingEdge.target_node_id !== edge.targetNodeId
          || existingEdge.kind !== edge.kind
        )
      ) {
        throw new DomainError('conflict', 'edge_identity_mismatch', `edge ${edge.id} was replayed with different graph identity`);
      }
      saveEdge({
        id: requiredId(edge.id, 'edge.id'),
        workspace_id: workspaceId,
        source_node_id: edge.sourceNodeId,
        target_node_id: edge.targetNodeId,
        kind: edge.kind,
        anchor_message_id: edge.anchorMessageId ?? null,
        created_at: edge.createdAt ?? null,
      }, input.ownerUserId ?? undefined);
    }

    getDb().prepare('UPDATE workspaces SET persistence_version = 2 WHERE id = ?').run(workspaceId);
    const workspace = getWorkspace(workspaceId);
    const node = getNode(nodeId);
    if (!workspace || !node) throw new Error('graph prerequisite transaction did not materialize canonical rows');
    const edgeIds = new Set(input.edges.map((edge) => edge.id));
    return {
      workspace,
      tree: treeRow,
      node,
      edges: listEdges(workspaceId).filter((edge) => edgeIds.has(edge.id)),
    };
  });
}
