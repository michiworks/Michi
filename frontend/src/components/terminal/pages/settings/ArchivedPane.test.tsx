import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from '../../../../state/chatTypes';
import { ArchivedPane } from './ArchivedPane';
import { buildArchiveEntries, groupArchiveEntries } from './archiveModel';

const state = vi.hoisted(() => ({
  nodes: {} as Record<string, ChatNodeState>,
  projects: [] as Project[],
  hydrated: true,
  restoreDeletion: vi.fn(), moveDeletionGroupLane: vi.fn(), unarchiveTree: vi.fn(), deleteTree: vi.fn(),
  openPane: vi.fn(), revealNode: vi.fn(() => true), selectProject: vi.fn(), activateTree: vi.fn(), success: vi.fn(), fetchWorkspaceStructure: vi.fn(),
}));
vi.mock('../../../../state/chatStore', () => ({
  useChatStore: () => state,
  useChatNodesSnapshot: () => state.nodes,
  chatLabel: () => '',
}));
vi.mock('../../../../services/api', () => ({ fetchWorkspaceStructure: (...args: unknown[]) => state.fetchWorkspaceStructure(...args) }));
vi.mock('sonner', () => ({ toast: { success: (...args: unknown[]) => state.success(...args) } }));

const now = Date.now();
const day = 86_400_000;
function node(nodeId: string, projectId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, projectId, title: nodeId, kind: 'chat', chatId: null, status: 'idle', messages: [], messagesLoaded: false, messageCount: 2, followUps: [], ...extra } as ChatNodeState;
}
function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return { id, name, chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1, ...extra };
}
function fixture() {
  state.nodes = {
    plan: node('plan', 'm', { title: 'Canvas removal plan' }),
    planChild: node('planChild', 'm', { parentNodeId: 'plan', messageCount: 3 }),
    titles: node('titles', 'm', { title: 'Title generation' }),
    haiku: node('haiku', 'm', { title: 'Try Haiku for titles', parentNodeId: 'titles', deletionGroupId: 'arch-1', deletedAt: now - 2 * day, trimSnapshot: { parentId: 'titles', childrenIds: [], wasTreeRoot: null } }),
    trashed: node('trashed', 'm', { title: 'Moved to Trash', deletionGroupId: 'del-9', deletedAt: now - day }),
    phone: node('phone', 'r', { title: 'Long-press menu' }),
    helper: node('helper', 'sys', { title: 'Assistant history' }),
  };
  state.projects = [
    project('m', 'Michi', {
      edges: [{ source: 'plan', target: 'planChild' }],
      trees: [
        { id: 'plan-tree', rootNodeId: 'plan', createdAt: 1, lastActiveAt: 1, archivedAt: now - 30 * day },
        { id: 'titles-tree', rootNodeId: 'titles', name: 'Title generation', createdAt: 1, lastActiveAt: 1 },
        // Archived, then moved to Trash: Trash lists it now.
        { id: 'trashed-tree', rootNodeId: 'trashed', createdAt: 1, lastActiveAt: 1, archivedAt: now - 5 * day },
      ],
    }),
    project('r', 'Michi-Remote', { trees: [{ id: 'phone-tree', rootNodeId: 'phone', createdAt: 1, lastActiveAt: 1, archivedAt: now - day }] }),
    project('sys', 'Michi Assistant', { system: 'assistant', trees: [{ id: 'helper-tree', rootNodeId: 'helper', createdAt: 1, lastActiveAt: 1, archivedAt: now }] } as Partial<Project>),
  ];
}
const rowKeys = () => Array.from(document.querySelectorAll('[data-history-key]')).map(row => row.getAttribute('data-history-key'));
beforeEach(() => {
  vi.clearAllMocks();
  fixture();
  state.hydrated = true;
  state.restoreDeletion.mockImplementation((id: string) => Object.values(state.nodes).find(item => item.deletionGroupId === id)?.nodeId ?? null);
  state.deleteTree.mockReturnValue('del-new');
  state.moveDeletionGroupLane.mockReturnValue('trim-1');
});

describe('Archive entries', () => {
  it('lists archived threads and nodes, leaves out threads moved to Trash, and names a node’s thread', () => {
    const entries = buildArchiveEntries(state.projects.slice(0, 2), state.nodes);
    expect(entries.map(entry => entry.key).sort()).toEqual(['node:arch-1', 'tree:phone-tree', 'tree:plan-tree']);
    const plan = entries.find(entry => entry.key === 'tree:plan-tree')!;
    expect([plan.nodeCount, plan.messageCount]).toEqual([2, 5]);
    expect(entries.find(entry => entry.kind === 'node')).toMatchObject({ fromTitle: 'Title generation', nodeCount: 1 });
    const { groups } = groupArchiveEntries(entries, { query: '', workspaceId: null, sort: 'newest' });
    expect(groups.map(group => [group.project.name, group.entries.map(entry => entry.title)])).toEqual([
      ['Michi-Remote', ['Long-press menu']],
      ['Michi', ['Try Haiku for titles', 'Canvas removal plan']],
    ]);
  });

  it('names a renamed thread by the name the user gave it, in its search and its sort', () => {
    state.projects[0].trees[0].name = 'Payment bug';
    const entries = buildArchiveEntries(state.projects.slice(0, 2), state.nodes);
    expect(entries.find(entry => entry.key === 'tree:plan-tree')?.title).toBe('Payment bug');
    expect(groupArchiveEntries(entries, { query: 'payment', workspaceId: null, sort: 'newest' }).matching.map(entry => entry.key)).toEqual(['tree:plan-tree']);
    expect(groupArchiveEntries(entries, { query: '', workspaceId: null, sort: 'name' }).matching.map(entry => entry.title))
      .toEqual(['Long-press menu', 'Payment bug', 'Try Haiku for titles']);
  });

  it('names the thread an archived former root came from when the thread was never renamed', () => {
    const tree = state.projects[0].trees[1];
    delete tree.name;
    state.nodes.oldRoot = { ...state.nodes.haiku, nodeId: 'oldRoot', title: 'First try', parentNodeId: undefined, deletionGroupId: 'arch-2',
      trimSnapshot: { parentId: null, childrenIds: ['titles'], wasTreeRoot: { treeId: tree.id } } };
    const entries = buildArchiveEntries(state.projects.slice(0, 1), state.nodes);
    expect(entries.find(entry => entry.key === 'node:arch-2')).toMatchObject({ fromTitle: 'Title generation' });
  });
});

describe('Settings › Archived', () => {
  it('groups archived threads by workspace, without the assistant’s system workspace', () => {
    render(<ArchivedPane />);
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['MMichi-Remote 1', 'MMichi 2']);
    expect(screen.queryByText('Assistant history')).toBeNull();
    expect(screen.getByText('Node from “Title generation”')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), { target: { value: 'm' } });
    expect(rowKeys()).toEqual(['node:arch-1', 'tree:plan-tree']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort archived threads' }), { target: { value: 'name' } });
    expect(rowKeys()).toEqual(['tree:plan-tree', 'node:arch-1']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search archived threads' }), { target: { value: 'nothing like it' } });
    expect(screen.getByRole('heading', { name: 'No matching threads' })).toBeTruthy();
  });

  it('unarchives a thread or a node and opens it only from the toast', () => {
    const onNav = vi.fn();
    render(<ArchivedPane onNav={onNav} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive Canvas removal plan' }));
    expect(state.unarchiveTree).toHaveBeenCalledWith('plan-tree');
    expect(onNav).not.toHaveBeenCalled();
    state.success.mock.calls[0][1].action.onClick();
    expect(state.selectProject).toHaveBeenCalledWith('m');
    expect(state.activateTree).toHaveBeenCalledWith('plan-tree', 'm');
    expect(onNav).toHaveBeenCalledWith('dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive Try Haiku for titles' }));
    expect(state.restoreDeletion).toHaveBeenCalledWith('arch-1');
    expect(state.success).toHaveBeenLastCalledWith('Node unarchived', expect.anything());
    state.success.mock.lastCall![1].action.onClick();
    expect(state.revealNode).toHaveBeenCalledWith('haiku', { workspaceId: 'm' });
    expect(state.openPane).not.toHaveBeenCalled();
  });

  it('moves selected items to Trash, and Undo puts them back in Archived', () => {
    render(<ArchivedPane />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Canvas removal plan' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Try Haiku for titles' }));
    expect(screen.getByRole('status').textContent).toBe('2 selected');
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(state.moveDeletionGroupLane).toHaveBeenCalledWith('arch-1', 'trash');
    expect(state.deleteTree).toHaveBeenCalledWith('plan-tree');
    expect(state.success.mock.calls[0][0]).toBe('2 items moved to Trash');
    state.success.mock.calls[0][1].action.onClick();
    expect(state.restoreDeletion).toHaveBeenCalledWith('del-new');
    expect(state.moveDeletionGroupLane).toHaveBeenLastCalledWith('trim-1', 'archive', now - 2 * day);
  });

  it('opens an item read-only with its conversation, and returns to the list', () => {
    state.fetchWorkspaceStructure.mockReturnValue(new Promise(() => {}));
    render(<ArchivedPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Try Haiku for titles' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Try Haiku for titles' })).toBe(document.activeElement);
    expect(screen.getByText(/“Title generation”\. Unarchiving puts the node back under its parent\./)).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading conversation' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All archived' }));
    expect(screen.getByRole('searchbox', { name: 'Search archived threads' })).toBeTruthy();
  });

  it('teaches how to archive when nothing is archived', () => {
    state.projects = [project('m', 'Michi')];
    state.nodes = {};
    render(<ArchivedPane />);
    expect(screen.getByRole('heading', { name: 'Nothing archived' })).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
