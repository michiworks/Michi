import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ThreadRow from './ThreadRow';
import { reduceNodes } from '../../state/chatReducers';
import type { ChatNodeState, ProjectEdge } from '../../state/chatTypes';

function makeNode(): ChatNodeState {
  return {
    nodeId: 'n1', kind: 'chat', chatId: 'c1', projectId: 'p1',
    title: 'Root title', messages: [], followUps: [], status: 'idle', runtimeId: 'claude',
  };
}

const mockStoreState = {
  treeSelection: new Set<string>(),
  focusedNodeId: null as string | null,
  node: makeNode(),
  /** What useStructuralSelector reads: the tree's nodes, branches included. */
  nodes: {} as Record<string, ChatNodeState>,
  projects: [] as Array<{ id: string; edges: ProjectEdge[] }>,
};
const structuralSelectors: Array<(nodes: Record<string, unknown>) => unknown> = [];

const mockPrefs: Record<string, unknown> = { showSidebarTimestamps: false };
vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: mockPrefs }),
}));

// ThreadRow no longer owns selection: every click is forwarded to onActivate,
// and the parent (WorkspaceRow) inspects the modifier keys to decide between
// select vs. activate. These mocks only need to cover what ThreadRow reads for
// display (treeSelection / focusedNodeId / projects).
vi.mock('../../state/chatStore', () => ({
  useChatNode: () => mockStoreState.node,
  useChatActions: () => ({
    clearTreeSelection: vi.fn(),
  }),
  useChatProjects: () => ({
    projects: mockStoreState.projects,
    openPanes: [],
    focusedPane: null,
    treeSelection: mockStoreState.treeSelection,
    focusedNodeId: mockStoreState.focusedNodeId,
  }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => {
    structuralSelectors.push(selector);
    return selector(mockStoreState.nodes);
  },
}));

function renderThreadRow(overrides: Partial<React.ComponentProps<typeof ThreadRow>> = {}) {
  const actions = {
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    pinTree: vi.fn(),
    unpinTree: vi.fn(),
    renameTree: vi.fn(),
    deleteTree: vi.fn(),
  };
  const props: React.ComponentProps<typeof ThreadRow> = {
    tree: { id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: Date.now() },
    projectId: 'p1',
    isActive: true,
    hasBranches: false,
    expanded: false,
    openState: 'none',
    onActivate: vi.fn(),
    onToggleExpand: vi.fn(),
    actions,
    ...overrides,
  };
  const view = render(<ThreadRow {...props} />);
  return {
    actions,
    props,
    rerender: (next: Partial<React.ComponentProps<typeof ThreadRow>>) =>
      view.rerender(<ThreadRow {...props} {...next} />),
  };
}

describe('ThreadRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    structuralSelectors.length = 0;
    mockStoreState.node = makeNode();
    mockStoreState.nodes = {};
    mockStoreState.projects = [];
    delete mockPrefs.sidebarRowStyle;
    localStorage.clear();
  });

  describe('a thread with no title yet', () => {
    const label = () => document.querySelector('[data-sidebar-row="n1"] [data-provisional]') as HTMLElement | null;
    const untitled = (text?: string): ChatNodeState => ({
      ...makeNode(),
      title: undefined,
      messages: text === undefined ? [] : [{ id: 'm1', role: 'user', text, createdAt: 1 } as ChatNodeState['messages'][number]],
    });

    it.each(['classic', 'square-full'])('shows an excerpt of the first message as a provisional label in %s rows', (style) => {
      mockPrefs.sidebarRowStyle = style;
      mockStoreState.node = untitled('> a quoted line\nwhere does the warm-pool effort default live');
      renderThreadRow({ isActive: false });
      expect(label()?.textContent).toBe('where does the warm-pool effort default live');
      expect(label()?.style.fontStyle).toBe('italic');
      expect(label()?.style.color).toBe('var(--term-muted)');
      expect(screen.queryByText('Untitled')).toBeNull();
    });

    it('stays provisional above the workspace name in Activity rows', () => {
      mockPrefs.sidebarRowStyle = 'square-full';
      mockStoreState.node = untitled('tail-spacer e2e once more');
      renderThreadRow({ subtitle: 'Michi' });
      expect(label()?.textContent).toBe('tail-spacer e2e once more');
      expect(label()?.style.color).toBe('var(--term-muted)');
      expect(label()?.style.fontStyle).toBe('italic');
    });

    it('drops the provisional look once a title arrives, and says Untitled with nothing to quote', () => {
      mockStoreState.node = { ...untitled('first words'), title: 'A real title' };
      const { rerender } = renderThreadRow();
      expect(screen.getByText('A real title')).toBeTruthy();
      expect(label()).toBeNull();
      mockStoreState.node = untitled();
      rerender({});
      expect(screen.getByText('Untitled').style.fontStyle).toBe('');
      expect(label()).toBeNull();
    });
  });

  describe('keyboard', () => {
    const row = () => document.querySelector('[data-sidebar-row="n1"]') as HTMLElement;

    it('is a button to the keyboard: Tab stop, Enter/Space open, arrows fold, Shift+F10 opens the menu', () => {
      const { props } = renderThreadRow({ hasBranches: true, expanded: false });
      expect(row().getAttribute('role')).toBe('button');
      expect(row().tabIndex).toBe(0);
      expect(row().getAttribute('aria-label')).toBe('Root title');
      expect(row().getAttribute('aria-current')).toBe('true');
      expect(row().getAttribute('aria-expanded')).toBe('false');
      expect(row().classList.contains('t-row-focus')).toBe(true);

      fireEvent.keyDown(row(), { key: 'Enter' });
      fireEvent.keyDown(row(), { key: ' ' });
      expect(props.onActivate).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(row(), { key: 'ArrowRight' });
      expect(props.onToggleExpand).toHaveBeenCalledTimes(1);
      // ← on a folded row does nothing; shortcuts with ⌘ pass through.
      fireEvent.keyDown(row(), { key: 'ArrowLeft' });
      fireEvent.keyDown(row(), { key: 'Enter', metaKey: true });
      expect(props.onToggleExpand).toHaveBeenCalledTimes(1);
      expect(props.onActivate).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(row(), { key: 'F10', shiftKey: true });
      expect(screen.getByRole('menu')).toBeTruthy();
    });

    it('marks only the current row, and leaves keys typed into the rename field to it', async () => {
      const { props, actions } = renderThreadRow({ isActive: false });
      expect(row().hasAttribute('aria-current')).toBe(false);
      fireEvent.contextMenu(row());
      fireEvent.click(screen.getByText(/^Rename/));
      // ContextMenu runs the item after its confirm blink.
      const input = await screen.findByRole('textbox', { name: 'Thread name' });
      fireEvent.keyDown(input, { key: ' ' });
      fireEvent.change(input, { target: { value: 'Renamed' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(actions.renameTree).toHaveBeenCalledWith('t1', 'Renamed');
      expect(props.onActivate).not.toHaveBeenCalled();
    });

    it('keeps the current Activity row clear of its ⋯ in card rows', () => {
      mockPrefs.sidebarRowStyle = 'square-full';
      const { rerender } = renderThreadRow({ subtitle: 'Michi', isActive: false });
      expect(row().style.paddingRight).toBe('16px');
      rerender({ isActive: true });
      expect(row().style.paddingRight).toBe('calc(16px + 16px + var(--row-kebab-extra, 0px))');
    });
  });

  describe('workspace name (Activity view)', () => {
    const row = () => document.querySelector('[data-sidebar-row="n1"]') as HTMLElement;
    const workspace = () => row().querySelector('[data-row-workspace]') as HTMLElement | null;

    it.each(['square-full', 'rounded-inset'])('is a second muted line inside the row, under the title, in %s rows', (style) => {
      mockPrefs.sidebarRowStyle = style;
      renderThreadRow({ subtitle: 'Michi' });
      const title = screen.getByText('Root title');
      expect(workspace()?.textContent).toBe('Michi');
      // Below the title line, not on it: the title keeps the whole first line.
      expect(workspace()?.contains(title)).toBe(false);
      expect(title.parentElement?.nextElementSibling).toBe(workspace());
      expect(workspace()?.style.color).toBe('var(--term-muted)');
      expect(workspace()?.querySelector('svg')).not.toBeNull();
      expect(title.style.flex).toBe('1 1 0%');
    });

    it('is left to Activity view in classic rows, which draws it under the row', () => {
      mockPrefs.sidebarRowStyle = 'classic';
      renderThreadRow({ subtitle: 'Michi' });
      expect(workspace()).toBeNull();
    });

    it('is absent in Structure view, which passes no workspace name', () => {
      mockPrefs.sidebarRowStyle = 'square-full';
      renderThreadRow();
      expect(workspace()).toBeNull();
    });
  });

  describe('unread dot', () => {
    const dot = () => document.querySelector('[data-sidebar-row="n1"] .sb-unread-dot') as HTMLElement;
    const title = () => screen.getByText('Root title').closest('[data-sidebar-row]') as HTMLElement;
    const unreadBranch = (): ChatNodeState => ({
      ...makeNode(), nodeId: 'b1', title: 'Branch', lastAssistantAt: 5, viewedAt: 1,
    });

    it('is solid on an unread root and brightens its title, without the old 900 weight', () => {
      mockStoreState.node = { ...makeNode(), lastAssistantAt: 5, viewedAt: 1 };
      mockStoreState.nodes = { n1: mockStoreState.node };
      renderThreadRow({ isActive: false });
      expect(dot().dataset.unread).toBe('self');
      expect(title().style.fontWeight).toBe('520');
      expect(title().style.color).toBe('var(--term-fg)');
    });

    it('rings a collapsed thread whose unread reply is in a branch, and clears once expanded', () => {
      mockStoreState.nodes = { n1: mockStoreState.node, b1: unreadBranch() };
      mockStoreState.projects = [{ id: 'p1', edges: [{ source: 'n1', target: 'b1', kind: 'branch' } as ProjectEdge] }];
      const { rerender } = renderThreadRow({ isActive: false, hasBranches: true, expanded: false });
      expect(dot().dataset.unread).toBe('within');
      // The root itself is read: its title keeps the read weight and colour.
      expect(title().style.fontWeight).toBe('450');
      expect(title().style.color).toBe('var(--term-mid)');

      rerender({ isActive: false, hasBranches: true, expanded: true });
      expect(dot().dataset.unread).toBe('none');
    });

    it('stays mounted at "none" on a read row, so a reply arriving later animates in', () => {
      renderThreadRow();
      expect(dot().dataset.unread).toBe('none');
    });
  });

  it('shows the first message while waiting, then accepts the main response title', () => {
    const initial = { n1: { ...makeNode(), title: undefined } };
    const streaming = reduceNodes(initial, {
      type: 'user-send', nodeId: 'n1', userText: '/btw Claude 标题应该如何生成？', assistantId: 'a1',
    });
    mockStoreState.node = streaming.n1;
    const { rerender } = renderThreadRow();

    expect(screen.getByText('Claude 标题应该如何生成？')).toBeTruthy();
    expect(mockStoreState.node.title).toBeUndefined();
    expect(mockStoreState.node.titleNeedsPersistence).toBeUndefined();

    const titled = reduceNodes(streaming, { type: 'set-title', nodeId: 'n1', title: 'Claude 主对话标题生成' });
    mockStoreState.node = titled.n1;
    rerender({});

    expect(screen.getByText('Claude 主对话标题生成')).toBeTruthy();
    expect(screen.queryByText('Claude 标题应该如何生成？')).toBeNull();
  });

  it('ctrl+click (non-mac) forwards the modifier to onActivate', () => {
    const onActivate = vi.fn();
    renderThreadRow({ onActivate });

    const row = screen.getByText('Root title').closest('[data-sidebar-row]')!;
    fireEvent.click(row, { ctrlKey: true });

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toMatchObject({ ctrlKey: true });
  });

  describe('open rail', () => {
    const rail = () => {
      const last = document.querySelector('[data-sidebar-row="n1"]')!.lastElementChild as HTMLElement;
      return last.style.position === 'absolute' && last.style.width === '2px' ? last : null;
    };

    it('pulses in the run colour while the thread runs', () => {
      renderThreadRow({ openState: 'streaming' });
      expect(rail()!.style.background).toBe('var(--term-run)');
      expect(rail()!.className, 'the running dot class, which Reduce motion stops').toContain('term-dot-i--run');
      expect(rail()!.style.right).toBe('2px');
    });

    it('marks an open pane in the accent only while the thread is collapsed', () => {
      const { rerender } = renderThreadRow({ openState: 'idle' });
      expect(rail()!.style.background).toBe('var(--term-accent)');
      expect(rail()!.style.animation).toBe('');
      rerender({ openState: 'idle', expanded: true });
      expect(rail()).toBeNull();
    });
  });

  it('closes its menu on a second press of the ⋯', () => {
    renderThreadRow();
    const kebab = screen.getByRole('button', { name: 'Actions for Root title' });
    fireEvent.click(kebab);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(kebab);
    fireEvent.click(kebab);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renames a thread from the context menu inline editor', async () => {
    const { actions } = renderThreadRow();

    fireEvent.contextMenu(screen.getByText('Root title').closest('[data-sidebar-row]')!);
    fireEvent.click(screen.getByText(/Rename/));

    // ContextMenu fires the item action after a short confirm-blink timeout,
    // so the inline editor appears asynchronously.
    const input = await screen.findByLabelText('Thread name');
    expect((input as HTMLInputElement).value).toBe('Root title');

    fireEvent.change(input, { target: { value: 'Research plan' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(actions.renameTree).toHaveBeenCalledWith('t1', 'Research plan');
  });

  it('cancels inline rename on Escape', async () => {
    const { actions } = renderThreadRow();

    fireEvent.contextMenu(screen.getByText('Root title').closest('[data-sidebar-row]')!);
    fireEvent.click(screen.getByText(/Rename/));

    const input = await screen.findByLabelText('Thread name');
    fireEvent.change(input, { target: { value: 'Should not save' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(actions.renameTree).not.toHaveBeenCalled();
    expect(screen.getByText('Root title')).toBeTruthy();
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves Enter and Esc that end an IME composition to it (%o)', async (ime) => {
    const { actions } = renderThreadRow();
    fireEvent.contextMenu(screen.getByText('Root title').closest('[data-sidebar-row]')!);
    fireEvent.click(screen.getByText(/Rename/));
    const input = await screen.findByLabelText('Thread name');
    fireEvent.change(input, { target: { value: '研究计划' } });
    fireEvent.keyDown(input, { key: 'Enter', ...ime });
    fireEvent.keyDown(input, { key: 'Escape', ...ime });
    expect(actions.renameTree).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Thread name')).toBe(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.renameTree).toHaveBeenCalledWith('t1', '研究计划');
  });
});
