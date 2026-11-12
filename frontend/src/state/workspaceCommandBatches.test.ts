import { describe, expect, it } from 'vitest';
import type { WorkspaceCommand } from '../services/api';
import { WorkspaceCommandsError } from '../services/api/persistence';
import {
  chunkWorkspaceCommands,
  classifyCommandFailure,
  commandRetryDelay,
  MIN_COMMANDS_PER_BATCH,
  smallerCommandLimit,
} from './workspaceCommandBatches';
import { buildExplicitWorkspaceCommands, accumulateWorkspaceDirtyDelta, emptyWorkspaceDirtyDelta } from './workspacePersistence';
import type { ChatNodeState, Project } from './chatTypes';

const WS = 'ws-big';

/**
 * The checks backend/src/services/domainCommands.ts makes, per command and at
 * the end of each batch, over an in-memory store. A batch that fails leaves
 * the store as it was (one transaction).
 */
function backendStore() {
  const trees = new Map<string, { root: string }>();
  const nodes = new Map<string, { tree: string | null; parent: string | null }>();
  const edges = new Set<string>();
  let workspace: { activeTree: string | null } | null = null;
  const apply = (commands: readonly WorkspaceCommand[]) => {
    const snapshot = { trees: new Map(trees), nodes: new Map(nodes), edges: new Set(edges), workspace };
    try {
      const touched = new Set<string>();
      for (const { type, payload } of commands) {
        const id = String(payload.id);
        if (type === 'workspace.upsert') workspace = { activeTree: (payload.active_tree_id as string | null) ?? null };
        else if (type === 'tree.upsert') {
          if (!workspace) throw new Error(`tree ${id}: workspace row missing`);
          trees.set(id, { root: String(payload.root_node_id) });
          touched.add(id);
        } else if (type === 'node.upsert' || (type === 'node.patch' && ('tree_id' in payload || 'parent_node_id' in payload))) {
          const existing = nodes.get(id);
          if (type === 'node.patch' && !existing) throw new Error(`patch ${id}: node not found`);
          const tree = 'tree_id' in payload ? (payload.tree_id as string | null) : existing!.tree;
          const parent = 'parent_node_id' in payload ? (payload.parent_node_id as string | null) : existing!.parent;
          if (tree && !trees.has(tree)) throw new Error(`node ${id}: tree ${tree} missing`);
          if (parent && nodes.get(parent)?.tree !== tree) throw new Error(`node ${id}: parent ${parent} not in tree ${tree}`);
          if (type === 'node.upsert' && existing) continue;
          nodes.set(id, { tree, parent });
        } else if (type === 'edge.upsert') {
          const source = nodes.get(String(payload.source_node_id));
          const target = nodes.get(String(payload.target_node_id));
          if (!source || !target) throw new Error(`edge ${id}: endpoint missing`);
          if (source.tree !== target.tree) throw new Error(`edge ${id}: endpoints in different trees`);
          edges.add(id);
        } else if (type === 'context.upsert') {
          if (payload.origin_node_id && !nodes.has(String(payload.origin_node_id))) throw new Error(`context ${id}: origin missing`);
        } else if (type === 'tree.delete') {
          trees.delete(id);
          for (const [nodeId, node] of nodes) if (node.tree === id) nodes.delete(nodeId);
        }
      }
      for (const treeId of touched) {
        const tree = trees.get(treeId);
        if (tree && nodes.get(tree.root)?.tree !== treeId) throw new Error(`tree ${treeId}: root not in tree`);
      }
      if (workspace?.activeTree && !trees.has(workspace.activeTree)) throw new Error('active tree missing');
    } catch (error) {
      trees.clear(); snapshot.trees.forEach((v, k) => trees.set(k, v));
      nodes.clear(); snapshot.nodes.forEach((v, k) => nodes.set(k, v));
      edges.clear(); snapshot.edges.forEach((v) => edges.add(v));
      workspace = snapshot.workspace;
      throw error;
    }
  };
  return { apply, trees, nodes, edges };
}

/** A workspace like the one that outgrew the limit: many trees, each a root with a branch or two. */
function bigWorkspace(treeCount: number) {
  const trees: Project['trees'] = [];
  const edges: Project['edges'] = [];
  const chatIds: string[] = [];
  const nodes: Record<string, ChatNodeState> = {};
  const node = (nodeId: string, parentNodeId?: string): ChatNodeState => ({
    nodeId, projectId: WS, kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', parentNodeId,
    ...(nodeId.endsWith('-b') ? { viewedAt: 50, lastAssistantAt: 40 } : {}),
  });
  for (let i = 0; i < treeCount; i++) {
    const root = `n-${i}`;
    trees.push({ id: `t-${i}`, rootNodeId: root, createdAt: 1, lastActiveAt: 1 });
    // The branch is listed before its parent: chatIds order is not creation order.
    for (const [id, parent] of i % 3 === 0 ? [[`${root}-b`, root], [root, undefined]] as const : [[root, undefined]] as const) {
      chatIds.push(id);
      nodes[id] = node(id, parent);
      if (parent) edges.push({ source: parent, target: id, kind: 'branch' });
    }
  }
  const project: Project = {
    id: WS, name: 'Big', chatIds, edges, trees, activeTreeId: `t-${treeCount - 1}`, createdAt: 1,
    artifacts: [{ id: 'ctx-1', name: 'notes', filePath: 'notes.md', source: 'user', origin: { nodeId: 'n-0-b' }, createdAt: 1, updatedAt: 1 }],
  };
  return { project, nodes };
}

describe('chunkWorkspaceCommands', () => {
  it('splits a whole-workspace write into chunks the backend commits one after another', () => {
    const { project, nodes } = bigWorkspace(200);
    const delta = accumulateWorkspaceDirtyDelta(undefined, project, {}, nodes, emptyWorkspaceDirtyDelta());
    const { commands } = buildExplicitWorkspaceCommands(project, nodes, delta, new Map(), 'w', new Map(), new Map());
    expect(commands.length).toBeGreaterThan(500);

    const chunks = chunkWorkspaceCommands(commands, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.flat()).toHaveLength(commands.length);
    expect(new Set(chunks.flat())).toEqual(new Set(commands));
    // In order, each chunk passes the backend's checks on what earlier ones committed
    // (branches come before their parents in chatIds here).
    const store = backendStore();
    for (const chunk of chunks) expect(() => store.apply(chunk)).not.toThrow();
    expect(store.trees.size).toBe(200);
    expect(store.edges.size).toBe(project.edges.length);
  });

  it('keeps each tree with its root, the workspace with its active tree, and each node with its view mark', () => {
    const { project, nodes } = bigWorkspace(30);
    const delta = accumulateWorkspaceDirtyDelta(undefined, project, {}, nodes, emptyWorkspaceDirtyDelta());
    const { commands } = buildExplicitWorkspaceCommands(project, nodes, delta, new Map(), 'w', new Map(), new Map());
    for (const limit of [MIN_COMMANDS_PER_BATCH, 9, 13, 50]) {
      const chunks = chunkWorkspaceCommands(commands, limit);
      const store = backendStore();
      for (const chunk of chunks) expect(() => store.apply(chunk)).not.toThrow();
      const chunkOf = (type: string, id: string) => chunks.findIndex((chunk) => chunk.some((c) => c.type === type && c.payload.id === id));
      expect(chunkOf('workspace.upsert', WS)).toBe(chunkOf('tree.upsert', project.activeTreeId!));
      expect(chunkOf('tree.upsert', 't-3')).toBe(chunkOf('node.upsert', 'n-3'));
      const viewMarks = commands.filter((c) => c.type === 'node.patch' && 'viewed_at' in c.payload);
      expect(viewMarks.length).toBeGreaterThan(0);
      for (const mark of viewMarks) expect(chunkOf('node.upsert', String(mark.payload.id))).toBe(chunks.findIndex((chunk) => chunk.includes(mark)));
    }
  });

  it('orders deletes after every upsert', () => {
    const commands: WorkspaceCommand[] = [
      { type: 'tree.delete', payload: { id: 'gone' } },
      { type: 'edge.delete', payload: { id: 'branch-a-b' } },
      { type: 'node.patch', payload: { id: 'moved', tree_id: 'keep', parent_node_id: null } },
      { type: 'context.delete', payload: { id: 'c-1' } },
      { type: 'edge.upsert', payload: { id: 'e', source_node_id: 'a', target_node_id: 'moved', kind: 'branch' } },
    ];
    const order = chunkWorkspaceCommands(commands, 2).flat().map((c) => c.type);
    expect(order).toEqual(['node.patch', 'edge.upsert', 'edge.delete', 'context.delete', 'tree.delete']);
  });
});

describe('classifyCommandFailure', () => {
  const answered = (status: number, message: string, code?: string, maxCommands?: number) =>
    new WorkspaceCommandsError(message, status, code, maxCommands === undefined ? {} : { maxCommands });

  it('retries what never got an answer and what the backend could not take right now', () => {
    expect(classifyCommandFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'retry' });
    expect(classifyCommandFailure(new Error('Remote connection is unavailable'))).toEqual({ kind: 'retry' });
    for (const status of [500, 502, 503, 408, 429]) expect(classifyCommandFailure(answered(status, 'busy'))).toEqual({ kind: 'retry' });
  });

  it('takes a 409 as a conflict to rebase', () => {
    expect(classifyCommandFailure(answered(409, 'node parent and child must belong to the same tree', 'node_parent_tree_mismatch')))
      .toEqual({ kind: 'conflict', message: 'node parent and child must belong to the same tree' });
  });

  it('recognizes an oversized batch from current and older backends', () => {
    expect(classifyCommandFailure(answered(400, 'too many', 'too_many_commands', 500))).toEqual({ kind: 'too_many', maxCommands: 500 });
    expect(classifyCommandFailure(answered(400, 'commands must be an array of at most 500 items')))
      .toEqual({ kind: 'too_many', maxCommands: 500 });
    expect(classifyCommandFailure(answered(400, 'commands must be an array of at most 500 items', 'invalid_commands')))
      .toEqual({ kind: 'too_many', maxCommands: 500 });
  });

  it('takes any other 4xx as a refusal, with the server message', () => {
    expect(classifyCommandFailure(answered(400, 'node.id must be a non-empty string <=160 chars', 'invalid_entity_id')))
      .toEqual({ kind: 'rejected', status: 400, code: 'invalid_entity_id', message: 'node.id must be a non-empty string <=160 chars' });
    expect(classifyCommandFailure(answered(404, 'node not found'))).toEqual({ kind: 'rejected', status: 404, message: 'node not found' });
  });
});

describe('retry pacing', () => {
  it('backs off from 2 s, doubling to a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(commandRetryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('splits a refused chunk smaller, never below what must commit together', () => {
    expect(smallerCommandLimit(500, 500, 100)).toBe(100);
    // An older backend repeats its own limit: halve what was sent.
    expect(smallerCommandLimit(400, 500, 500)).toBe(200);
    expect(smallerCommandLimit(10, 10)).toBe(MIN_COMMANDS_PER_BATCH);
  });
});
