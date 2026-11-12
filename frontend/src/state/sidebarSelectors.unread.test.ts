import { describe, it, expect } from 'vitest';
import { branchSubtreeHasUnread, selectUnreadTotal, treeHasUnread, workspaceHasUnread } from './sidebarSelectors';
import type { ChatNodeState, Project, Tree, ProjectEdge } from './chatTypes';

function n(over: Partial<ChatNodeState>): ChatNodeState {
  return {
    nodeId: 'x',
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...over,
  };
}

function unread(nodeId: string, over: Partial<ChatNodeState> = {}): ChatNodeState {
  return n({ nodeId, lastAssistantAt: 5, viewedAt: 1, ...over });
}

function t(id: string, rootNodeId: string, over: Partial<Tree> = {}): Tree {
  return { id, rootNodeId, createdAt: 0, lastActiveAt: 0, ...over };
}

function p(id: string, trees: Tree[], edges: ProjectEdge[] = [], over: Partial<Project> = {}): Project {
  return { id, name: id, chatIds: [], edges, createdAt: 0, trees, activeTreeId: trees[0]?.id ?? null, ...over };
}

describe('selectUnreadTotal', () => {
  it('counts the unread chat nodes of listed threads, not the focused one', () => {
    const nodes = {
      a: unread('a'),
      b: n({ nodeId: 'b', lastAssistantAt: 5, viewedAt: 5 }),
      c: unread('c'),
      d: unread('d', { kind: 'digest' }),
    };
    const projects = [p('p1', [t('ta', 'a'), t('tb', 'b'), t('tc', 'c'), t('td', 'd')])];
    expect(selectUnreadTotal(projects, nodes, null)).toBe(2);
    expect(selectUnreadTotal(projects, nodes, 'a')).toBe(1);
  });

  it('counts unread branches below the root, at any depth', () => {
    const nodes = { a: n({ nodeId: 'a' }), b: unread('b'), c: unread('c') };
    const edges: ProjectEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c', kind: 'branch' }];
    expect(selectUnreadTotal([p('p1', [t('t1', 'a')], edges)], nodes, null)).toBe(2);
  });

  it('leaves out the assistant\'s system workspace', () => {
    const nodes = { a: unread('a'), s: unread('s', { projectId: 'sys' }) };
    const projects = [p('p1', [t('ta', 'a')]), p('sys', [t('ts', 's')], [], { system: 'assistant' })];
    expect(selectUnreadTotal(projects, nodes, null)).toBe(1);
  });

  it('leaves out Meta agent maintenance runs, which no conversation list shows', () => {
    const nodes = {
      a: unread('a'),
      run: unread('run', { maintenanceJobId: 'job-maint' }),
      run2: unread('run2', { lastAssistantAt: 6, maintenanceJobId: 'job-maint' }),
    };
    const edges: ProjectEdge[] = [{ source: 'run', target: 'run2', kind: 'branch' }];
    expect(selectUnreadTotal([p('p1', [t('ta', 'a'), t('tr', 'run')], edges)], nodes, null)).toBe(1);
    expect(treeHasUnread({ rootNodeId: 'run' }, edges, nodes, null)).toBe(false);
  });

  // Each of these sat in the store while the Activity view had no row for it:
  // the badge read 1 over a list with nothing unread.
  it('leaves out what the Activity view does not list', () => {
    const nodes = {
      listed: n({ nodeId: 'listed' }),
      archived: unread('archived'),
      trashedWs: unread('trashedWs', { projectId: 'trash' }),
      archivedWs: unread('archivedWs', { projectId: 'shelf' }),
      deletedRoot: unread('deletedRoot', { deletedAt: 9 }),
      deletedBranch: unread('deletedBranch', { deletedAt: 9 }),
      belowDeleted: unread('belowDeleted'),
      unreached: unread('unreached'),
      merged: unread('merged'),
      noProject: unread('noProject', { projectId: 'gone' }),
    };
    const edges: ProjectEdge[] = [
      { source: 'listed', target: 'deletedBranch' },
      { source: 'deletedBranch', target: 'belowDeleted' },
      { source: 'listed', target: 'merged', kind: 'merge' },
    ];
    const projects = [
      p('p1', [t('t1', 'listed'), t('t2', 'archived', { archivedAt: 9 }), t('t3', 'deletedRoot')], edges),
      p('trash', [t('t4', 'trashedWs')], [], { deletedAt: 9 }),
      p('shelf', [t('t5', 'archivedWs')], [], { archivedAt: 9 }),
    ];
    expect(selectUnreadTotal(projects, nodes, null)).toBe(0);
    // The collapsed workspace's ring follows the same list (it lists every node in chatIds).
    const workspace = { ...projects[0], chatIds: Object.keys(nodes).filter((id) => nodes[id as keyof typeof nodes].projectId === 'p1') };
    expect(workspaceHasUnread(workspace, nodes, null)).toBe(false);
  });

  it('rings a workspace exactly when the badge counts one of its threads', () => {
    const nodes = {
      a: n({ nodeId: 'a' }),
      b: unread('b'),
      hidden: unread('hidden', { pageId: 'pg-1' }),
      shelved: unread('shelved'),
      binned: unread('binned', { deletedAt: 9 }),
    };
    const edges: ProjectEdge[] = [{ source: 'a', target: 'b' }];
    const chatIds = Object.keys(nodes);
    const cases: Project[] = [
      p('p1', [t('ta', 'a')], edges, { chatIds }),
      p('p1', [t('ta', 'a'), t('th', 'hidden'), t('ts', 'shelved', { archivedAt: 9 }), t('tb', 'binned')], [], { chatIds }),
    ];
    for (const project of cases) {
      expect(workspaceHasUnread(project, nodes, null)).toBe(selectUnreadTotal([project], nodes, null) > 0);
    }
    expect(workspaceHasUnread(cases[0], nodes, null)).toBe(true);
    expect(workspaceHasUnread(cases[0], nodes, 'b')).toBe(false);
  });
});

describe('treeHasUnread / workspaceHasUnread', () => {
  // Tree uses rootNodeId + edges (not nodeIds). treeHasUnread accepts edges as 4th param.
  const edges: ProjectEdge[] = [
    { source: 'a', target: 'b' },
  ];
  const tree: Tree = { id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 0 };
  it('treeHasUnread true when any node in tree subtree is unread', () => {
    const nodes = {
      a: n({ nodeId: 'a', projectId: 'p1', lastAssistantAt: 5, viewedAt: 5 }),
      b: n({ nodeId: 'b', projectId: 'p1', lastAssistantAt: 5, viewedAt: 1 }),
    };
    expect(treeHasUnread(tree, edges, nodes, null)).toBe(true);
  });

  it('treeHasUnread ignores a deleted branch and what hangs below it', () => {
    const deep: ProjectEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    const nodes = {
      a: n({ nodeId: 'a', projectId: 'p1' }),
      b: n({ nodeId: 'b', projectId: 'p1', lastAssistantAt: 5, viewedAt: 1, deletedAt: 9 }),
      c: n({ nodeId: 'c', projectId: 'p1', lastAssistantAt: 5, viewedAt: 1 }),
    };
    expect(treeHasUnread(tree, deep, nodes, null)).toBe(false);
  });
});

describe('branchSubtreeHasUnread', () => {
  const sub = { nodeId: 'b', depth: 1, children: [{ nodeId: 'c', depth: 2, children: [] }] };

  it('finds an unread node at any depth below, ignoring the focused one', () => {
    const nodes = {
      b: n({ nodeId: 'b', lastAssistantAt: 5, viewedAt: 5 }),
      c: n({ nodeId: 'c', lastAssistantAt: 5, viewedAt: 1 }),
    };
    expect(branchSubtreeHasUnread([sub], nodes, null)).toBe(true);
    expect(branchSubtreeHasUnread([sub], nodes, 'c')).toBe(false);
    expect(branchSubtreeHasUnread([], nodes, null)).toBe(false);
  });
});
