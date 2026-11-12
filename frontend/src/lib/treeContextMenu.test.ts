import { describe, it, expect, vi } from 'vitest';
import { buildTreeContextMenu, type TreeMenuActions } from './treeContextMenu';
import type { ChatNodeState, Project } from '../state/chatTypes';

// treeContextMenu → chatStore → services/api. Only pure menu-building is
// exercised here, so the API surface can be an empty module (same trick as
// chatReducers.structural.test.ts).
vi.mock('../services/api', () => ({}));

function makeProject(): Project {
  return {
    id: 'p1',
    name: 'WS',
    chatIds: ['r1', 'b1'],
    edges: [{ source: 'r1', target: 'b1' }],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0 }],
    activeTreeId: 't1',
  };
}

function makeNode(nodeId: string, over: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...over,
  };
}

function makeActions(over: Partial<TreeMenuActions> = {}): TreeMenuActions {
  return {
    openPane: vi.fn(),
    createBlankChild: vi.fn(),
    toggleSelection: vi.fn(),
    clearSelection: vi.fn(),
    deleteNode: vi.fn(),
    trimNode: vi.fn(),
    archiveNode: vi.fn(),
    createMergedChat: vi.fn(async () => 'm1'),
    createDigest: vi.fn(async () => 'd1'),
    openExportPanel: vi.fn(),
    archiveTree: vi.fn(),
    focusOrOpen: vi.fn(),
    ...over,
  };
}

const itemIds = (sections: ReturnType<typeof buildTreeContextMenu>) =>
  sections.flatMap((s) => s.items.map((i) => i.id));

describe('extract node menu', () => {
  it('offers extraction for a live child and calls the action', () => {
    const extractNodeTree = vi.fn(async () => {});
    const sections = buildTreeContextMenu({ targetId: 'b1', project: makeProject(),
      nodes: { b1: makeNode('b1') }, selection: new Set(), actions: makeActions({ extractNodeTree }) });
    sections.flatMap(s => s.items).find(item => item.id === 'extract-tree')!.run();
    expect(extractNodeTree).toHaveBeenCalledWith('b1');
  });
  it('hides extraction for roots in other trees and for archived trees', () => {
    const project = makeProject();
    project.trees.push({ id: 'other', rootNodeId: 'r2', createdAt: 1, lastActiveAt: 1 });
    const build = (targetId: string) => buildTreeContextMenu({ targetId, project,
      nodes: { r2: makeNode('r2'), b1: makeNode('b1') }, selection: new Set(), actions: makeActions({ extractNodeTree: vi.fn() }) });
    expect(itemIds(build('r2'))).not.toContain('extract-tree');
    project.trees[0].archivedAt = 1;
    expect(itemIds(build('b1'))).not.toContain('extract-tree');
  });
});

describe('buildTreeContextMenu — rename', () => {
  it('offers Rename only to a surface that can rename inline', () => {
    const build = (actions: TreeMenuActions) => buildTreeContextMenu({ targetId: 'b1', project: makeProject(),
      nodes: { r1: makeNode('r1'), b1: makeNode('b1') }, selection: new Set(), actions });
    expect(itemIds(build(makeActions()))).not.toContain('rename');
    const beginInlineRename = vi.fn();
    build(makeActions({ beginInlineRename }))[0].items.find((i) => i.id === 'rename')!.run();
    expect(beginInlineRename).toHaveBeenCalledWith('b1');
  });
});

describe('buildTreeContextMenu — node pin', () => {
  it('offers Pin on an unpinned branch node and dispatches pinNode', () => {
    const pinNode = vi.fn();
    const sections = buildTreeContextMenu({
      targetId: 'b1',
      project: makeProject(),
      nodes: { r1: makeNode('r1'), b1: makeNode('b1') },
      selection: new Set(),
      actions: makeActions({ pinNode, unpinNode: vi.fn(), beginInlineRename: vi.fn() }),
    });
    const ids = itemIds(sections);
    expect(ids).toContain('pin');
    expect(ids).not.toContain('unpin');
    // Sits right after Rename, mirroring the thread-row menu.
    expect(ids.indexOf('pin')).toBe(ids.indexOf('rename') + 1);
    sections[0].items.find((i) => i.id === 'pin')!.run();
    expect(pinNode).toHaveBeenCalledWith('b1');
  });

  it('offers Unpin on a pinned branch node and dispatches unpinNode', () => {
    const unpinNode = vi.fn();
    const sections = buildTreeContextMenu({
      targetId: 'b1',
      project: makeProject(),
      nodes: { r1: makeNode('r1'), b1: makeNode('b1', { pinnedAt: 123 }) },
      selection: new Set(),
      actions: makeActions({ pinNode: vi.fn(), unpinNode }),
    });
    const ids = itemIds(sections);
    expect(ids).toContain('unpin');
    expect(ids).not.toContain('pin');
    sections[0].items.find((i) => i.id === 'unpin')!.run();
    expect(unpinNode).toHaveBeenCalledWith('b1');
  });

  it('does not add pin items to the multi-select menu', () => {
    const sections = buildTreeContextMenu({
      targetId: 'b1',
      project: makeProject(),
      nodes: { r1: makeNode('r1'), b1: makeNode('b1'), b2: makeNode('b2') },
      selection: new Set(['b1', 'b2']),
      actions: makeActions({ pinNode: vi.fn(), unpinNode: vi.fn() }),
    });
    const ids = itemIds(sections);
    expect(ids).not.toContain('pin');
    expect(ids).not.toContain('unpin');
  });
});

it('offers Digest in the multi-select menu only while Settings › Digest is on', () => {
  const build = (digestEnabled?: boolean) => itemIds(buildTreeContextMenu({
    targetId: 'b1',
    project: makeProject(),
    nodes: { r1: makeNode('r1'), b1: makeNode('b1'), b2: makeNode('b2') },
    selection: new Set(['b1', 'b2']),
    actions: makeActions(),
    digestEnabled,
  }));
  expect(build()).not.toContain('digest');
  expect(build()).toEqual(expect.arrayContaining(['weave', 'export']));
  expect(build(true)).toContain('digest');
});

it('protects roots from inactive trees in single and mixed selection menus', () => {
  const project = makeProject();
  project.trees.push({ id: 't2', rootNodeId: 'r2', createdAt: 1, lastActiveAt: 1 });
  const actions = makeActions({ pinNode: vi.fn(), unpinNode: vi.fn() });
  const nodes = { r1: makeNode('r1'), r2: makeNode('r2'), b1: makeNode('b1') };
  const single = buildTreeContextMenu({ targetId: 'r2', project, nodes, selection: new Set(), actions });
  expect(single.flatMap((section) => section.items).find((item) => item.id === 'delete')?.disabled).toBe(true);
  expect(itemIds(single)).not.toContain('pin');
  const mixed = buildTreeContextMenu({ targetId: 'r2', project, nodes, selection: new Set(['r2', 'b1']), actions });
  mixed.flatMap((section) => section.items).find((item) => item.id === 'delete')?.run();
  expect(actions.deleteNode).toHaveBeenCalledExactlyOnceWith('b1');
});

describe('buildTreeContextMenu — multi-select rules', () => {
  const twoThreads = () => {
    const project = makeProject();
    project.chatIds.push('r2', 'b2');
    project.edges.push({ source: 'r2', target: 'b2' });
    project.trees.push({ id: 't2', rootNodeId: 'r2', createdAt: 1, lastActiveAt: 1 });
    return project;
  };
  const nodes = { r1: makeNode('r1'), b1: makeNode('b1', { status: 'streaming' }), r2: makeNode('r2'), b2: makeNode('b2') };
  const item = (sections: ReturnType<typeof buildTreeContextMenu>, id: string) =>
    sections.flatMap((s) => s.items).find((i) => i.id === id)!;

  it('keeps the store rules by default, so the sidebar can weave a streaming, cross-thread selection', () => {
    const sections = buildTreeContextMenu({ targetId: 'b1', project: twoThreads(), nodes,
      selection: new Set(['b1', 'b2']), actions: makeActions(), digestEnabled: true });
    expect(item(sections, 'weave').disabled).toBe(false);
    expect(item(sections, 'weave').sublabel).toBeUndefined();
    expect(item(sections, 'digest').disabled).toBe(false);
  });

  it('refuses Weave and Digest while a selected chat streams, then across threads, when asked to', () => {
    const rules = { requireIdle: true, requireSingleThread: true };
    const streaming = buildTreeContextMenu({ targetId: 'b1', project: twoThreads(), nodes,
      selection: new Set(['b1', 'b2']), actions: makeActions(), rules, digestEnabled: true });
    expect(item(streaming, 'weave')).toMatchObject({ disabled: true, sublabel: 'Wait for streaming to finish before merging.' });
    expect(item(streaming, 'digest')).toMatchObject({
      disabled: true, sublabel: 'Wait for streaming to finish before creating a digest.',
    });

    const idle = { ...nodes, b1: makeNode('b1') };
    const crossThread = buildTreeContextMenu({ targetId: 'b1', project: twoThreads(), nodes: idle,
      selection: new Set(['b1', 'b2']), actions: makeActions(), rules, digestEnabled: true });
    expect(item(crossThread, 'weave')).toMatchObject({ disabled: true, sublabel: 'Merge requires nodes from a single thread.' });
    expect(item(crossThread, 'digest')).toMatchObject({ disabled: true, sublabel: 'Digest requires nodes from a single thread.' });
  });

  it('exports the nodes it acts on', () => {
    const actions = makeActions();
    const sections = buildTreeContextMenu({ targetId: 'b1', project: twoThreads(), nodes,
      selection: new Set(['b1', 'b2']), actions });
    item(sections, 'export').run();
    expect(actions.openExportPanel).toHaveBeenCalledWith(['b1', 'b2']);
  });
});
