import { describe, expect, it } from 'vitest';
import type { ChatNodeState, Project } from './chatTypes';
import { durableNodePrerequisite, serializeEdgeRow, serializeNodeRow, serializeTreeRow, serializeWorkspaceRow } from './workspacePersistence';

function chat(nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, projectId: 'w', kind: 'chat', messages: [], followUps: [], status: 'idle', ...extra } as ChatNodeState;
}

const tree = { id: 't', rootNodeId: 'root', lastActiveAt: 4, createdAt: 3 };

function project(edges: Project['edges']): Project {
  return { id: 'w', name: 'W', chatIds: ['root'], edges, createdAt: 1, trees: [tree], activeTreeId: null };
}

// The prerequisite is a node's first graph write; the next sync writes the
// same rows again, so both must carry the same values.
describe('durable node prerequisite', () => {
  const fixtures: Array<[string, Project, Record<string, ChatNodeState>, string]> = [
    ['a node a branch edge reaches', project([{ source: 'root', target: 'n', kind: 'branch', createdAt: 5 }]),
      { root: chat('root'), n: chat('n', { parentNodeId: 'root' }) }, 'n'],
    ['a new branch with only its parent', project([]),
      { root: chat('root'), n: chat('n', { parentNodeId: 'root' }) }, 'n'],
    // Trash dropped mid's branch edge; the backend keeps both in root's tree.
    ['a node under a trimmed ancestor', project([]),
      { root: chat('root'), mid: chat('mid', { parentNodeId: 'root' }), n: chat('n', { parentNodeId: 'mid' }) }, 'n'],
  ];

  it.each(fixtures)('matches the row serializers for %s', (_label, p, nodes, nodeId) => {
    const prerequisite = durableNodePrerequisite(p, nodes, nodes[nodeId]) as {
      workspace: Record<string, unknown>; tree?: Record<string, unknown>; node: Record<string, unknown>;
      edges: Array<Record<string, unknown>>;
    };
    const nodeRow = serializeNodeRow(p, nodes, nodeId)!;
    expect(prerequisite.node).toMatchObject({ id: nodeId, treeId: nodeRow.tree_id, parentNodeId: nodeRow.parent_node_id, kind: nodeRow.kind });
    expect(prerequisite.node.treeId).toBe('t');
    const treeRow = serializeTreeRow(p, tree);
    expect(prerequisite.tree).toEqual({
      id: treeRow.id, rootNodeId: treeRow.root_node_id, name: treeRow.name, archivedAt: treeRow.archived_at,
      pinnedAt: treeRow.pinned_at, lastActiveAt: treeRow.last_active_at, createdAt: treeRow.created_at,
    });
    const workspaceRow = serializeWorkspaceRow(p);
    expect(prerequisite.workspace).toMatchObject({ id: 'w', cwd: workspaceRow.cwd, activeTreeId: workspaceRow.active_tree_id });
    const target = p.edges.filter((edge) => edge.target === nodeId);
    const expectedEdges = target.length > 0 ? target : [{ source: nodes[nodeId].parentNodeId!, target: nodeId, kind: 'branch' as const }];
    expect(prerequisite.edges.map((edge) => edge.id)).toEqual(expectedEdges.map((edge) => serializeEdgeRow(p, edge).id));
  });

  it('sends no workspace settings when the row has none, and the row settings otherwise', () => {
    const nodes = { root: chat('root') };
    expect((durableNodePrerequisite(project([]), nodes, nodes.root).workspace as { settings: unknown }).settings).toBeNull();
    const instructed = { ...project([]), instructions: 'x', aiGlobalContext: false };
    expect((durableNodePrerequisite(instructed, nodes, nodes.root).workspace as { settings: unknown }).settings)
      .toEqual(JSON.parse(serializeWorkspaceRow(instructed).settings!));
  });
});
