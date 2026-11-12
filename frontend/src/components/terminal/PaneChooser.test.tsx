import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalListResponse } from 'michi-shared';
import type { LauncherPaneItem } from '../../state/paneItems';
import PaneChooser from './PaneChooser';

const state = vi.hoisted(() => ({
  list: vi.fn(),
  actions: { activateLauncherPane: vi.fn(), adoptTerminalPane: vi.fn(), adoptBackendTerminal: vi.fn(), focusPane: vi.fn(), setFocusedNodeId: vi.fn() },
  electron: undefined as Record<string, unknown> | undefined,
  phone: false,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));
vi.mock('../../hooks/usePhoneLayout', () => ({ usePhoneLayout: () => state.phone }));
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => state.electron }));
vi.mock('../../services/api/terminals', () => ({ listTerminals: state.list }));
vi.mock('../../state/chatStore', () => ({
  useChatActions: () => state.actions,
  useChatPanes: () => ({ paneItems: {}, openPanes: ['pane:launcher:1'] }),
  useOptionalChatProjects: () => ({ projects: [{ id: 'p1', cwd: '/home/me/Michi' }] }),
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
  for (const action of Object.values(state.actions)) action.mockReset();
});

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

  it('advertises no keyboard shortcut, since none of its choices has one', async () => {
    const { container } = render(<PaneChooser item={launcher} />);
    await act(async () => {});
    for (const label of ['Review', 'Terminal', 'Files', 'Side chat']) {
      expect(screen.getByRole('button', { name: label })).not.toBeNull();
    }
    expect(container.querySelector('kbd')).toBeNull();
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
