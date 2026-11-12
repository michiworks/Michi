import { describe, expect, it } from 'vitest';
import type { ChatNodeState, Project, Tree } from './chatTypes';
import { rebaseOnAdoption } from './structureAdoption';

const tree = (id: string, extra: Partial<Tree> = {}): Tree => ({ id, rootNodeId: `${id}-root`, createdAt: 1, lastActiveAt: 1, ...extra });
const node = (nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState => ({
  nodeId, projectId: 'ws', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', ...extra,
});
const project = (extra: Partial<Project> = {}): Project => ({
  id: 'ws', name: 'Before', chatIds: ['a', 'b'], edges: [{ source: 'a', target: 'b' }], createdAt: 1,
  trees: [tree('t1'), tree('t2')], activeTreeId: 't1', ...extra,
});

describe('rebaseOnAdoption', () => {
  it('rebases what the store shows and keeps the rest for a later scan', () => {
    const prev = project();
    const cur = project({ name: 'After', trees: [tree('t1', { archivedAt: 5 })], chatIds: ['a'], edges: [] });
    const result = rebaseOnAdoption(prev, {}, cur, {}, {
      projectId: 'ws',
      readStartedAt: 9,
      workspace: { name: 'After', pinnedAt: 3 },
      trees: [{ tree: tree('t1', { archivedAt: 5 }), fields: ['archivedAt'] }],
      removedTreeIds: ['t2'],
      removedChatIds: ['b'],
      removedEdgeIds: ['branch-a-b'],
    });
    expect(result.prevProject).toMatchObject({ name: 'After', chatIds: ['a'], edges: [] });
    expect(result.prevProject?.trees).toEqual([tree('t1', { archivedAt: 5 })]);
    expect(result.prevProject?.pinnedAt).toBeUndefined();
    expect(result.landed.workspaceFields).toEqual(['name']);
    expect(result.remaining).toEqual({ projectId: 'ws', readStartedAt: 9, workspace: { pinnedAt: 3 } });
  });

  it('nothing lands before the store changes', () => {
    const prev = project();
    const adoption = { projectId: 'ws', readStartedAt: 1, workspace: { name: 'After' }, removedTreeIds: ['t2'] };
    const result = rebaseOnAdoption(prev, {}, prev, {}, adoption);
    expect(result.prevProject).toEqual(prev);
    expect(result.remaining).toEqual(adoption);
  });

  it('takes an untouched entity as the adopted object and keeps an unscanned edit an edit', () => {
    const before = tree('t1');
    const adopted = { ...before, name: 'Elsewhere' };
    const untouched = rebaseOnAdoption(project({ trees: [before] }), {}, project({ trees: [adopted] }), {}, {
      projectId: 'ws', readStartedAt: 1, trees: [{ tree: adopted, fields: ['name'] }],
    });
    expect(untouched.prevProject?.trees[0]).toBe(adopted);

    // The window pinned t1 before the re-read was merged into it: still a change to write.
    const pinned = { ...before, pinnedAt: 4 };
    const merged = { ...pinned, name: 'Elsewhere' };
    const edited = rebaseOnAdoption(project({ trees: [before] }), {}, project({ trees: [merged] }), {}, {
      projectId: 'ws', readStartedAt: 1, trees: [{ tree: merged, fields: ['name'] }],
    });
    expect(edited.prevProject?.trees[0]).toEqual({ ...before, name: 'Elsewhere' });
    expect(edited.prevProject?.trees[0]).not.toBe(merged);

    const prevNode = node('a');
    const adoptedNode = { ...node('a', { status: 'streaming' }), deletedAt: 7 };
    const nodes = rebaseOnAdoption(project(), { a: prevNode }, project(), { a: { ...adoptedNode, messages: [] } }, {
      projectId: 'ws', readStartedAt: 1, nodes: [{ node: adoptedNode, fields: ['deletedAt'] }],
    });
    expect(nodes.prevNodes.a).toEqual({ ...prevNode, deletedAt: 7 });
    expect(nodes.landed.nodes).toHaveLength(1);
  });

  it('takes a new workspace whole once it renders', () => {
    const cur = project();
    const result = rebaseOnAdoption(undefined, {}, cur, { a: node('a'), b: node('b') }, {
      projectId: 'ws', readStartedAt: 1, newProject: true,
    });
    expect(result.prevProject).toBe(cur);
    expect(Object.keys(result.prevNodes)).toEqual(['a', 'b']);
    expect(result.landed.trees.every((entry) => entry.isNew)).toBe(true);
    expect(result.remaining).toBeNull();
    expect(rebaseOnAdoption(undefined, {}, undefined, {}, { projectId: 'ws', readStartedAt: 1, newProject: true }).remaining)
      .not.toBeNull();
  });
});
