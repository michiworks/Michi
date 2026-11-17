import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatTreeList from './ChatTreeList';
import type { ChatNodeState, Project } from '../../../state/chatTypes';

function mkProject(): Project {
  return {
    id: 'p1',
    name: 'p1',
    chatIds: ['r', 'b1'],
    edges: [{ source: 'r', target: 'b1', kind: 'branch' }],
    createdAt: 0,
    trees: [{ id: 't1', rootNodeId: 'r', createdAt: 0, lastActiveAt: 100 }],
    activeTreeId: 't1',
    artifacts: [],
  };
}

const NODES: Record<string, ChatNodeState> = {
  r: {
    nodeId: 'r',
    projectId: 'p1',
    chatId: null,
    kind: 'chat',
    title: 'root chat',
    status: 'idle',
    messages: [],
    followUps: [],
    currentModeId: null,
  } as any,
  b1: {
    nodeId: 'b1',
    projectId: 'p1',
    chatId: null,
    kind: 'chat',
    title: 'failure modes regression',
    status: 'idle',
    messages: [],
    followUps: [],
    currentModeId: null,
  } as any,
};

describe('ChatTreeList', () => {
  it('filter hides non-matching tree and says nothing matched, with a way to clear it', () => {
    const onClearFilter = vi.fn();
    render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter="zzz-no-match"
        onClearFilter={onClearFilter}
        onOpen={() => {}}
      />,
    );
    expect(screen.queryByText('root chat')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('No matches for “zzz-no-match”');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onClearFilter).toHaveBeenCalledOnce();
  });

  it('opens the chat from its row button', () => {
    const onOpen = vi.fn();
    render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter=""
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'root chat' }));
    expect(onOpen).toHaveBeenCalledWith('r');
  });

  it('menu shows Pin when tree is unpinned, Unpin when pinned', () => {
    const baseActions = {
      activateTree: vi.fn(),
      archiveTree: vi.fn(),
      unarchiveTree: vi.fn(),
      pinTree: vi.fn(),
      unpinTree: vi.fn(),
      renameTree: vi.fn(),
      deleteTree: vi.fn(),
      exportTree: vi.fn(),
    };
    const { unmount } = render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter=""
        onOpen={() => {}}
        menuActions={baseActions}
      />,
    );
    let listitems = screen.getAllByRole('listitem');
    let rootItem = listitems.find((el) => el.textContent?.includes('root chat'))!;
    fireEvent.mouseEnter(rootItem);
    fireEvent.click(screen.getByLabelText(/more actions/i));
    expect(screen.queryByText('Pin')).not.toBeNull();
    expect(screen.queryByText('Unpin')).toBeNull();
    unmount();

    const pinnedProject = mkProject();
    pinnedProject.trees[0].pinnedAt = 999;
    render(
      <ChatTreeList
        workspace={pinnedProject}
        nodes={NODES}
        filter=""
        onOpen={() => {}}
        menuActions={baseActions}
      />,
    );
    listitems = screen.getAllByRole('listitem');
    rootItem = listitems.find((el) => el.textContent?.includes('root chat'))!;
    fireEvent.mouseEnter(rootItem);
    fireEvent.click(screen.getByLabelText(/more actions/i));
    expect(screen.queryByText('Unpin')).not.toBeNull();
  });

  it('shows a renamed thread by the name the user gave it, and offers no Rename it cannot carry out', () => {
    const renamed = mkProject();
    renamed.trees[0].name = 'Payment bug';
    render(
      <ChatTreeList
        workspace={renamed}
        nodes={NODES}
        filter=""
        onOpen={() => {}}
        menuActions={{
          activateTree: vi.fn(), archiveTree: vi.fn(), unarchiveTree: vi.fn(), pinTree: vi.fn(),
          unpinTree: vi.fn(), renameTree: vi.fn(), deleteTree: vi.fn(), exportTree: vi.fn(),
        }}
      />,
    );
    const rootItem = screen.getAllByRole('listitem').find((el) => el.textContent?.includes('Payment bug'))!;
    expect(rootItem.textContent).not.toContain('root chat');
    expect(screen.getByText('failure modes regression')).toBeTruthy();
    fireEvent.mouseEnter(rootItem);
    fireEvent.click(screen.getByLabelText(/more actions/i));
    expect(screen.queryByText('Pin')).not.toBeNull();
    expect(screen.queryByText(/Rename/)).toBeNull();
  });

  it('selects threads with their checkboxes in manage mode, Shift extending the range', () => {
    const project = mkProject();
    project.chatIds = ['r', 'b1', 'r2', 'r3'];
    project.trees = [
      { id: 't1', rootNodeId: 'r', createdAt: 0, lastActiveAt: 300 },
      { id: 't2', rootNodeId: 'r2', createdAt: 0, lastActiveAt: 200 },
      { id: 't3', rootNodeId: 'r3', createdAt: 0, lastActiveAt: 100 },
    ];
    const nodes = { ...NODES, r2: { ...NODES.r, nodeId: 'r2', title: 'second' }, r3: { ...NODES.r, nodeId: 'r3', title: 'third' } };
    const treeSelection = new Set<string>();
    const toggleTreeSelection = vi.fn((id: string) => { if (!treeSelection.delete(id)) treeSelection.add(id); });
    const onOpen = vi.fn();
    render(
      <ChatTreeList
        workspace={project}
        nodes={nodes}
        filter=""
        onOpen={onOpen}
        manageMode
        bulkActions={{
          treeSelection, toggleTreeSelection, clearTreeSelection: vi.fn(), selectAllTrees: vi.fn(),
          bulkArchiveTrees: vi.fn(), bulkDeleteTrees: vi.fn(), bulkUnarchiveTrees: vi.fn(),
        }}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select root chat' }));
    expect([...treeSelection]).toEqual(['t1']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select third' }), { shiftKey: true });
    expect([...treeSelection]).toEqual(['t1', 't2', 't3']);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens the row menu from ⋯ without a hover and without opening the thread', () => {
    const onOpen = vi.fn();
    render(
      <ChatTreeList
        workspace={mkProject()}
        nodes={NODES}
        filter=""
        onOpen={onOpen}
        menuActions={{
          activateTree: vi.fn(), archiveTree: vi.fn(), unarchiveTree: vi.fn(), pinTree: vi.fn(),
          unpinTree: vi.fn(), renameTree: vi.fn(), deleteTree: vi.fn(), exportTree: vi.fn(),
        }}
      />,
    );
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    expect(screen.queryByText('Pin')).not.toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(onOpen).not.toHaveBeenCalled();
  });
});
