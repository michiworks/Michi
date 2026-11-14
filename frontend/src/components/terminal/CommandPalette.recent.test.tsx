/**
 * The ⌘K palette without a title bar: an empty query lists the latest
 * threads across workspaces first, then Navigate and Actions, with the keys
 * in a hint row under the list.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';
import { paletteRow } from '../../test/paletteRow';

const store = vi.hoisted(() => {
  const tree = (id: string, rootNodeId: string, lastActiveAt: number, extra: Record<string, unknown> = {}) =>
    ({ id, rootNodeId, name: '', createdAt: 1, lastActiveAt, ...extra });
  const a = {
    id: 'ws-a', name: 'Tokyo trip', chatIds: ['n-a1', 'n-a2', 'n-a3', 'n-gone'], edges: [], createdAt: 1, activeTreeId: 't-a1',
    trees: [
      tree('t-a1', 'n-a1', 900),
      tree('t-a2', 'n-a2', 500, { name: 'Fireworks' }),
      tree('t-a3', 'n-a3', 990, { archivedAt: 5 }),
      tree('t-gone', 'n-gone', 995),
    ],
  };
  const b = {
    id: 'ws-b', name: 'Michi', chatIds: ['n-b1', 'n-b2', 'n-b3', 'n-b4', 'n-b5'], edges: [], createdAt: 2, activeTreeId: 't-b1',
    trees: [
      tree('t-b1', 'n-b1', 800),
      tree('t-b2', 'n-b2', 700),
      tree('t-b3', 'n-b3', 600),
      tree('t-b4', 'n-b4', 400),
      tree('t-b5', 'n-b5', 300),
    ],
  };
  const archivedWorkspace = { id: 'ws-old', name: 'Old', chatIds: ['n-o'], edges: [], createdAt: 3, activeTreeId: null, archivedAt: 9, trees: [tree('t-o', 'n-o', 999)] };
  const nodes: Record<string, unknown> = {
    'n-a1': { nodeId: 'n-a1', title: 'Search and tool calls' },
    'n-a2': { nodeId: 'n-a2', title: 'ignored: the tree is named' },
    'n-a3': { nodeId: 'n-a3', title: 'Archived thread' },
    'n-gone': { nodeId: 'n-gone', title: 'In the trash', deletedAt: 3 },
    'n-b1': { nodeId: 'n-b1', title: 'Pages visibility' },
    'n-b2': { nodeId: 'n-b2', title: 'Small talk' },
    'n-b3': { nodeId: 'n-b3', title: 'Tool tour' },
    'n-b4': { nodeId: 'n-b4', title: 'Fifth' },
    'n-b5': { nodeId: 'n-b5', title: 'Sixth' },
    'n-o': { nodeId: 'n-o', title: 'In an archived workspace' },
  };
  return {
    a, b, archivedWorkspace, nodes,
    selectProject: vi.fn(),
    activateTree: vi.fn(),
  };
});

vi.mock('../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: store.a,
    projects: [store.a, store.b, store.archivedWorkspace],
    selection: new Set<string>(),
    clearSelection: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), createDigest: vi.fn(),
    createMergedChat: vi.fn(), createThread: vi.fn(), activateTree: store.activateTree, archiveTree: vi.fn(),
    unarchiveTree: vi.fn(), selectProject: store.selectProject, setFocusedNodeId: vi.fn(), setSearchHighlightTerm: vi.fn(),
  }),
  useChatNodesSnapshot: () => store.nodes,
  selectAllChats: () => [{ id: 'n-b2', title: 'Small talk', projectId: 'ws-b', projectName: 'Michi' }],
}));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { bypassPermissions: false }, setPref: vi.fn() }) }));
vi.mock('../../state/navigateToNode', () => ({ navigateToNode: vi.fn() }));
vi.mock('../../lib/digestPrompt', () => ({ requestDigest: vi.fn() }));
vi.mock('../../state/useNodeSearch', () => ({ useNodeSearch: () => ({ nodes: [], totalNodes: 0, status: 'ready' }) }));

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  store.selectProject.mockReset();
  store.activateTree.mockReset();
});

const input = () => screen.getByPlaceholderText('Search chats, commands, messages…');
const groupNames = () => [...document.querySelectorAll('[data-menu="palette"] > ul')].map((ul) => ul.getAttribute('aria-label'));
const rowsOf = (group: string) => [...screen.getByRole('list', { name: group }).querySelectorAll('.ui-menu-item')];
const recentRows = () => rowsOf('Recent');
const activeRow = () => document.querySelector('[data-menu="palette"] [data-active="true"]');

describe('CommandPalette — no title bar', () => {
  it('has no Command palette header or close button, keeps its dialog name, and closes on Esc or the scrim', () => {
    const onClose = vi.fn();
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog.querySelector('.ui-overlay-header')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(dialog.textContent).not.toMatch(/command palette/i);

    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();
    fireEvent.mouseDown(document.querySelector('.ui-scrim')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the keys in a hint row under the list: move, open, close, and no ⌘↵ it has no action for', () => {
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    const hints = document.querySelector('.palette-hints')!;
    expect([...hints.children].map((hint) => hint.textContent)).toEqual(['↑↓move', '↵open', 'escclose']);
    expect([...hints.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['↑', '↓', '↵', 'esc']);
    expect(hints.textContent).not.toContain('⌘');
    // Under the list, last in the panel.
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog.lastElementChild).toBe(hints);
  });
});

describe('CommandPalette — Recent', () => {
  it('lists the five latest threads across workspaces first, each with its workspace, then Navigate and Actions', () => {
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    expect(groupNames()).toEqual(['Recent', 'Navigate', 'Actions']);
    // Newest first; archived threads, trashed roots and archived workspaces are left out.
    expect(recentRows().map((row) => [row.querySelector('.michi-menu-label')!.textContent, row.querySelector('.michi-menu-where')!.textContent])).toEqual([
      ['Search and tool calls', 'Tokyo trip'],
      ['Pages visibility', 'Michi'],
      ['Small talk', 'Michi'],
      ['Tool tour', 'Michi'],
      ['Fireworks', 'Tokyo trip'],
    ]);
    // The palette opens on the newest.
    expect(activeRow()).toBe(recentRows()[0]);
  });

  it('leaves out the thread on screen', () => {
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
    const labels = recentRows().map((row) => row.querySelector('.michi-menu-label')!.textContent);
    expect(labels).not.toContain('Search and tool calls');
    expect(labels).toEqual(['Pages visibility', 'Small talk', 'Tool tour', 'Fireworks', 'Fifth']);
  });

  it('opens a thread in another workspace as the sidebar does, on Enter', () => {
    const setPage = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={setPage} onClose={onClose} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(store.selectProject).toHaveBeenCalledWith('ws-b');
    expect(store.activateTree).toHaveBeenCalledWith('t-b1', 'ws-b');
    expect(setPage).toHaveBeenCalledWith('dashboard');
    expect(onClose).toHaveBeenCalled();
  });

  it('opens a thread in the active workspace without switching workspace, on click', () => {
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Fireworks'));
    expect(store.selectProject).not.toHaveBeenCalled();
    expect(store.activateTree).toHaveBeenCalledWith('t-a2', 'ws-a');
  });

  it('moves through the rows in the order they show: Recent into Navigate', () => {
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeRow()).toBe(rowsOf('Navigate')[0]);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(activeRow()).toBe(recentRows()[4]);
  });

  it('gives way to the search groups once typing starts, chats included', () => {
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(input(), { target: { value: 'Small' } });
    expect(screen.queryByRole('list', { name: 'Recent' })).toBeNull();
    // Shaped as its Recent row was: the name, then its workspace at the row's end.
    const row = screen.getByText(paletteRow('Small talk')).closest('li')!;
    expect(row.querySelector('.michi-menu-where')?.textContent).toBe('Michi');
  });

  it('shows a mouse that has not moved no highlight: the palette opening under it keeps the first row', () => {
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    const rows = recentRows();
    // A pointer lying still over the list gets mouse events where it already is as the rows appear.
    fireEvent.mouseMove(rows[3], { screenX: 300, screenY: 300 });
    fireEvent.mouseMove(rows[3], { screenX: 300, screenY: 300 });
    expect(activeRow()).toBe(rows[0]);
    fireEvent.mouseMove(rows[3], { screenX: 304, screenY: 302 });
    expect(activeRow()).toBe(rows[3]);
  });
});
