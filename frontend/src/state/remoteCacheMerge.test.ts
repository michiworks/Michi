import { describe, expect, it } from 'vitest';
import type { ChatNodeState, Project } from './chatTypes';
import { installMatchingPage, mergeFreshOverCached, pageBehindNodes, pageMatchesNode } from './remoteCacheMerge';

function node(nodeId: string, overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId, projectId: 'ws', kind: 'chat', chatId: null, messages: [], messagesLoaded: false,
    messageCount: 2, followUps: [], status: 'idle', title: 'Cached', lastAppliedTurnId: 'turn-1', ...overrides,
  };
}
const message = (id: string) => ({ id, role: 'user' as const, text: id, toolCalls: [], createdAt: 1 });
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'ws', name: 'Cached', chatIds: ['a', 'b'], edges: [{ source: 'a', target: 'b' }], artifacts: [], createdAt: 1,
    trees: [{ id: 't1', rootNodeId: 'a', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 't1', backendConnectionId: 'r', ...overrides,
  };
}

describe('replacing a cached copy with the remote\'s answer', () => {
  const cachedA = node('a', { messages: [message('m1'), message('m2')], messagesLoaded: true });
  const cachedB = node('b');
  const origin = { projects: new Map([['ws', project()]]), nodes: new Map([['a', cachedA], ['b', cachedB]]) };

  it('takes the answer wherever this window changed nothing, the cached node never winning', () => {
    const fresh = { projects: [project({ name: 'Fresh' })], nodes: { a: node('a', { title: 'Fresh', messageCount: 2 }), b: node('b', { title: 'Fresh b' }) } };
    const merged = mergeFreshOverCached(origin, { projects: [project()], nodes: { a: cachedA, b: cachedB } }, fresh);
    expect(merged.projects[0].name).toBe('Fresh');
    expect(merged.nodes.a.title).toBe('Fresh');
    expect(merged.nodes.b).toEqual(fresh.nodes.b);
    expect(merged.editedNodeIds.size).toBe(0);
    // The cached messages still answer for it (same count, same latest turn).
    expect(merged.nodes.a.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(merged.rereadNodeIds.size).toBe(0);
  });

  it('keeps what this window changed meanwhile, and its live messages whole', () => {
    const base = origin.projects.get('ws')!;
    const held = {
      projects: [{ ...base, name: 'Renamed here', activeTreeId: 't2', trees: [...base.trees, { id: 't2', rootNodeId: 'c', createdAt: 2, lastActiveAt: 2 }], chatIds: ['a', 'b', 'c'] }],
      nodes: {
        a: { ...cachedA, composerDraft: { value: 'draft', mentions: [] } },
        b: { ...cachedB, messages: [message('sent')], status: 'streaming' as const, messageCount: 3 },
        c: node('c', { title: 'Made here' }),
      },
    };
    const fresh = { projects: [project({ name: 'Fresh' })], nodes: { a: node('a', { title: 'Fresh' }), b: node('b', { title: 'Fresh b', messageCount: 2 }) } };
    const merged = mergeFreshOverCached(origin, held, fresh);
    expect(merged.projects[0]).toMatchObject({ name: 'Renamed here', activeTreeId: 't2', chatIds: ['a', 'b', 'c'] });
    expect(merged.projects[0].trees.map((tree) => tree.id)).toEqual(['t1', 't2']);
    expect(merged.localTreeIds).toEqual(new Set(['t2']));
    expect(merged.nodes.a).toMatchObject({ title: 'Fresh', composerDraft: { value: 'draft' } });
    expect(merged.nodes.b).toMatchObject({ title: 'Fresh b', status: 'streaming', messageCount: 3 });
    expect(merged.nodes.b.messages.map((m) => m.id)).toEqual(['sent']);
    expect(merged.nodes.c.title).toBe('Made here');
    expect(merged.editedNodeIds).toEqual(new Set(['a']));
  });

  it('lets removals win: the remote\'s, and this window\'s still to be written', () => {
    const held = { projects: [{ ...origin.projects.get('ws')!, edges: [] }], nodes: { a: cachedA, b: cachedB } };
    const fresh = { projects: [project({ chatIds: ['a'], edges: [{ source: 'a', target: 'b' }] })], nodes: { a: node('a') } };
    const merged = mergeFreshOverCached(origin, held, fresh);
    expect(merged.projects[0].chatIds).toEqual(['a']);
    expect(merged.nodes.b).toBeUndefined();
    expect(merged.projects[0].edges).toEqual([]);
    // A workspace the remote no longer has is gone.
    expect(mergeFreshOverCached(origin, held, { projects: [], nodes: {} }).projects).toEqual([]);
  });

  it('writes only what this window changed of a tree, over the remote\'s rename and archive', () => {
    const base = origin.projects.get('ws')!;
    const held = { projects: [{ ...base, trees: [{ ...base.trees[0], lastActiveAt: 5 }] }], nodes: { a: cachedA, b: cachedB } };
    const fresh = {
      projects: [project({ trees: [{ id: 't1', rootNodeId: 'a', createdAt: 1, lastActiveAt: 1, name: 'Renamed elsewhere', archivedAt: 3 }] })],
      nodes: { a: node('a'), b: cachedB },
    };
    const merged = mergeFreshOverCached(origin, held, fresh);
    expect(merged.projects[0].trees).toEqual([{ id: 't1', rootNodeId: 'a', createdAt: 1, lastActiveAt: 5, name: 'Renamed elsewhere', archivedAt: 3 }]);
    expect(merged.localTreeIds).toEqual(new Set(['t1']));
    // A tree replaced here with the same values is no change.
    const same = { projects: [{ ...base, trees: [{ ...base.trees[0] }] }], nodes: { a: cachedA, b: cachedB } };
    expect(mergeFreshOverCached(origin, same, fresh).localTreeIds.size).toBe(0);
  });

  it('marks cached messages the remote moved past to be read again', () => {
    const held = { projects: [project()], nodes: { a: cachedA, b: cachedB } };
    const idle = mergeFreshOverCached(origin, held, { projects: [project()], nodes: { a: node('a', { messageCount: 4, lastAppliedTurnId: 'turn-2' }), b: cachedB } });
    expect(idle.rereadNodeIds).toEqual(new Set(['a']));
    // Still shown until the re-read lands.
    expect(idle.nodes.a).toMatchObject({ messagesLoaded: false, historyBefore: undefined, messageCount: 4 });
    expect(idle.nodes.a.messages).toHaveLength(2);
    const running = mergeFreshOverCached(origin, held, { projects: [project()], nodes: { a: node('a', { status: 'streaming', activeTurnId: 'turn-2' }), b: cachedB } });
    // A running turn reloads from its checkpoint instead.
    expect(running.nodes.a).toMatchObject({ messages: [], messagesLoaded: false, status: 'streaming' });
  });
});

describe('a first page read beside the metadata', () => {
  const page = {
    messages: [{ id: 'm1', node_id: 'a', role: 'user', content: 'q', seq: 0, created_at: 1 }, { id: 'm2', node_id: 'a', role: 'user', content: 'r', seq: 1, created_at: 2 }],
    pages: [{ nodeId: 'a', total: 2, before: null }],
    turns: [{ node_id: 'a', turn_id: 'turn-1', status: 'completed', last_seq: 4 }],
  };
  it('goes in only where it matches what the metadata says', () => {
    expect(pageMatchesNode(page, 'a', node('a'))).toBe(true);
    expect(pageMatchesNode(page, 'a', node('a', { messageCount: 3 }))).toBe(false);
    expect(pageMatchesNode(page, 'a', node('a', { lastAppliedTurnId: 'turn-2' }))).toBe(false);
    expect(pageMatchesNode(page, 'a', node('a', { status: 'streaming' }))).toBe(false);
    const { nodes, installed } = installMatchingPage({ a: node('a'), b: node('b') }, page, ['a', 'b']);
    expect(installed).toEqual(['a']);
    expect(nodes.a).toMatchObject({ messagesLoaded: true, messageCount: 2 });
    expect(nodes.b.messagesLoaded).toBe(false);
  });
  it('is behind when the metadata already counts more or a newer turn', () => {
    expect(pageBehindNodes(page, new Map([['a', { messageCount: 2, lastAppliedTurnId: 'turn-1' }]]))).toBe(false);
    expect(pageBehindNodes(page, new Map([['a', { messageCount: 3, lastAppliedTurnId: 'turn-1' }]]))).toBe(true);
    expect(pageBehindNodes(page, new Map([['a', { messageCount: 2, lastAppliedTurnId: 'turn-2' }]]))).toBe(true);
    expect(pageBehindNodes({ messages: [] }, new Map())).toBe(true);
  });
});
