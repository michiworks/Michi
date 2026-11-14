import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalListResponse } from 'michi-shared';
import type { LauncherPaneItem } from '../../state/paneItems';
import PaneChooser from './PaneChooser';

const state = vi.hoisted(() => ({
  list: vi.fn(),
  actions: {
    activateLauncherPane: vi.fn(), adoptTerminalPane: vi.fn(), adoptBackendTerminal: vi.fn(), openNodeInLauncherPane: vi.fn(),
    focusPane: vi.fn(), closePane: vi.fn(), setFocusedNodeId: vi.fn(),
  },
  electron: undefined as Record<string, unknown> | undefined,
  phone: false,
  focusedPane: null as string | null,
  openPanes: ['pane:launcher:1'],
  nodes: {} as Record<string, unknown>,
  project: { id: 'p1', cwd: '/home/me/Michi', trees: [] as Array<{ id: string; rootNodeId: string; name?: string }>, edges: [] as Array<{ source: string; target: string }> },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));
vi.mock('../../hooks/usePhoneLayout', () => ({ usePhoneLayout: () => state.phone }));
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => state.electron }));
vi.mock('../../services/api/terminals', () => ({ listTerminals: state.list }));
vi.mock('../../state/chatStore', () => ({
  useChatActions: () => state.actions,
  useChatPanes: () => ({ paneItems: {}, openPanes: state.openPanes, focusedPane: state.focusedPane }),
  useOptionalChatProjects: () => ({ projects: [state.project] }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector(state.nodes),
}));

const launcher: LauncherPaneItem = { id: 'pane:launcher:1', kind: 'launcher', projectId: 'p1', treeId: null, title: 'New pane', createdAt: 1 };
const running = {
  terminalId: 't1', instance: 'r', cwd: '/home/me/MichiWorkspace/src/Michi', createdAt: 1, lastActiveAt: Date.now(),
  exited: false, cols: 120, rows: 40, clients: { phone: 0, desktop: 1 },
};

beforeEach(() => {
  state.list.mockReset().mockResolvedValue({ available: true, terminals: [] } satisfies TerminalListResponse);
  state.electron = undefined;
  state.phone = false;
  state.focusedPane = null;
  state.openPanes = ['pane:launcher:1'];
  state.nodes = {};
  state.project = { id: 'p1', cwd: '/home/me/Michi', trees: [], edges: [] };
  for (const action of Object.values(state.actions)) action.mockReset();
});

const chat = (nodeId: string, title: string, extra: Record<string, unknown> = {}) => ({ nodeId, kind: 'chat', title, projectId: 'p1', messages: [], ...extra });

describe('PaneChooser', () => {
  it('leaves no hover border on a choice whose launch failed after the pointer left', async () => {
    let fail!: (error: Error) => void;
    state.actions.activateLauncherPane.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(<PaneChooser item={launcher} />);
    await act(async () => {});
    const review = screen.getByRole('button', { name: 'Review' });
    fireEvent.mouseEnter(review);
    fireEvent.click(review);
    fireEvent.mouseLeave(review);
    await act(async () => { fail(new Error('no review')); });
    expect((review as HTMLButtonElement).disabled).toBe(false);
    expect(review.style.borderColor).not.toBe('var(--term-line)');
    expect(review.style.background).not.toBe('var(--term-alt)');
  });

  it('marks each choice with its digit and picks it by that key', async () => {
    render(<PaneChooser item={launcher} />);
    await act(async () => {});
    ['Review', 'Terminal', 'Files', 'Blank branch'].forEach((label, i) => {
      const row = screen.getByRole('button', { name: label });
      expect(row.getAttribute('aria-keyshortcuts')).toBe(String(i + 1));
      expect(row.querySelector('kbd')?.textContent).toBe(String(i + 1));
    });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Review' }), { key: '4' });
    expect(state.actions.activateLauncherPane).toHaveBeenCalledWith('pane:launcher:1', 'side-chat');
  });

  it('takes the keyboard when its pane is focused, and moves with the arrows', async () => {
    state.focusedPane = 'pane:launcher:1';
    render(<PaneChooser item={launcher} />);
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Terminal' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Blank branch' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Blank branch' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Files' }));
  });

  it('leaves focus where it is when another pane is focused', async () => {
    render(<PaneChooser item={launcher} />);
    await act(async () => {});
    expect(document.activeElement).toBe(document.body);
  });

  it('closes on Escape and hands focus back to the + that opened it', async () => {
    state.focusedPane = 'pane:launcher:1';
    render(<><button type="button" aria-label="New pane">+</button><PaneChooser item={launcher} /></>);
    await act(async () => {});
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(state.actions.closePane).toHaveBeenCalledWith('pane:launcher:1');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New pane' }));
  });

  it('lists the thread’s conversations no pane shows, and opens one in this pane', async () => {
    state.project = {
      id: 'p1', cwd: '/home/me/Michi',
      trees: [{ id: 't1', rootNodeId: 'root', name: 'Body rhythm' }],
      edges: [{ source: 'root', target: 'a' }, { source: 'root', target: 'b' }, { source: 'a', target: 'gone' }],
    };
    state.nodes = { root: chat('root', 'root title'), a: chat('a', 'File link underline'), b: chat('b', 'Table toolbar'), gone: chat('gone', 'Deleted', { deletedAt: 1 }) };
    state.openPanes = ['a', 'pane:launcher:1'];
    state.focusedPane = 'pane:launcher:1';
    render(<PaneChooser item={{ ...launcher, treeId: 't1' }} />);
    await act(async () => {});
    expect(screen.getByText('In this thread, not open')).not.toBeNull();
    const rows = screen.getAllByRole('button').slice(0, 2).map((row) => row.textContent);
    // The thread's own name for its root; the open one and the deleted one are not offered.
    expect(rows).toEqual(['Body rhythm', 'Table toolbar']);
    expect(document.activeElement?.textContent).toBe('Body rhythm');
    fireEvent.click(screen.getByRole('button', { name: 'Table toolbar' }));
    expect(state.actions.openNodeInLauncherPane).toHaveBeenCalledWith('pane:launcher:1', 'b');
    // The digits still pick the four choices below.
    fireEvent.keyDown(document.activeElement!, { key: '1' });
    expect(state.actions.activateLauncherPane).toHaveBeenCalledWith('pane:launcher:1', 'review');
  });
});

describe('PaneChooser terminals on a phone', () => {
  beforeEach(() => { state.phone = true; });

  it('says why Terminal is off instead of opening a pane that cannot start', async () => {
    state.list.mockResolvedValue({ available: false, reason: 'phone-off', terminals: [] } satisfies TerminalListResponse);
    render(<PaneChooser item={launcher} />);
    await act(async () => {});
    expect(state.list).toHaveBeenCalledWith('local', expect.any(AbortSignal));
    const terminal = screen.getByRole('button', { name: 'Terminal' });
    expect(terminal.textContent).toContain('Off on this phone');
    fireEvent.click(terminal);
    expect(screen.getByRole('note').textContent).toMatch(/Settings › Phone access › Terminal/);
    expect(state.actions.activateLauncherPane).not.toHaveBeenCalled();
  });

  it('lists the terminals the machine runs, including the desktop one, and opens it here', async () => {
    state.list.mockResolvedValue({ available: true, terminals: [running] } satisfies TerminalListResponse);
    render(<PaneChooser item={launcher} />);
    await act(async () => {});
    const row = screen.getByRole('button', { name: 'Open terminal — /home/me/MichiWorkspace/src/Michi' });
    expect(row.textContent).toContain('…/src/Michi · also on desktop');
    fireEvent.click(row);
    expect(state.actions.adoptBackendTerminal).toHaveBeenCalledWith('pane:launcher:1', running, 'local');
  });

  it('leaves Electron local workspaces on the native terminal', async () => {
    state.electron = { terminalCreate: vi.fn(), terminalWrite: vi.fn(), terminalResize: vi.fn() };
    render(<PaneChooser item={launcher} />);
    await act(async () => {});
    expect(state.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(state.actions.activateLauncherPane).toHaveBeenCalledWith('pane:launcher:1', 'terminal');
  });
});
