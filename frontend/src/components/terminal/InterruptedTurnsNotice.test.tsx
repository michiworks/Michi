import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InterruptedTurnsNotice from './InterruptedTurnsNotice';
import type { ChatNodeState } from '../../state/chatTypes';
import type { InterruptedTurn } from '../../services/api/interruptedTurns';

vi.mock('../../state/chatStore', () => ({
  useChatProjects: vi.fn(),
  useChatActions: vi.fn(),
  useStructuralSelector: vi.fn(),
}));
vi.mock('../../services/api/interruptedTurns', () => ({
  fetchInterruptedTurns: vi.fn(),
  dismissInterruptedTurn: vi.fn(),
}));

import * as chatStore from '../../state/chatStore';
import * as api from '../../services/api/interruptedTurns';

const project = {
  id: 'p-1', name: 'WS', chatIds: ['n1', 'n2'], edges: [],
  trees: [{ id: 't-1', rootNodeId: 'n1' }], activeTreeId: 't-1', createdAt: 0,
};

const actions = { revealNode: vi.fn(), resumeLastTurn: vi.fn() };

const item = (nodeId: string, turnId: string, title: string): InterruptedTurn => ({
  turnId, nodeId, workspaceId: 'p-1', workspaceName: 'WS', title, interruptedAt: Date.now() - 60_000,
  backendConnectionId: 'local',
});

let nodes: Record<string, Partial<ChatNodeState>> = {};
// StrictMode, as the app runs: its extra unmount must not leave the bar thinking it is gone.
const bar = () => <React.StrictMode><InterruptedTurnsNotice /></React.StrictMode>;

describe('InterruptedTurnsNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    nodes = {};
    vi.mocked(chatStore.useChatProjects).mockReturnValue({ projects: [project], activeProject: project } as never);
    vi.mocked(chatStore.useChatActions).mockReturnValue(actions as never);
    vi.mocked(chatStore.useStructuralSelector).mockImplementation(((selector: (n: unknown) => unknown) => selector(nodes)) as never);
    vi.mocked(api.dismissInterruptedTurn).mockResolvedValue();
  });

  it('lists every interrupted task with when it stopped', async () => {
    vi.mocked(api.fetchInterruptedTurns).mockResolvedValue([
      item('n1', 't1', 'Refactor the drawer'),
      item('n2', 't2', 'Deploy the stack'),
    ]);
    render(bar());
    expect(await screen.findByText('Refactor the drawer')).toBeTruthy();
    expect(screen.getByText('Deploy the stack')).toBeTruthy();
    expect(screen.getAllByText('1m')).toHaveLength(2);
  });

  it('Resume opens the chat and carries the turn on once its interruption has loaded', async () => {
    vi.mocked(api.fetchInterruptedTurns).mockResolvedValue([item('n1', 't1', 'Refactor the drawer')]);
    const { rerender } = render(bar());
    fireEvent.click(await screen.findByRole('button', { name: 'Resume Refactor the drawer' }));
    expect(actions.revealNode).toHaveBeenCalledWith('n1', { workspaceId: 'p-1' });
    expect(actions.resumeLastTurn).not.toHaveBeenCalled();
    nodes = { n1: { status: 'error', errorKind: 'backend_restarted', errorTurnId: 't1' } };
    rerender(bar());
    await waitFor(() => expect(actions.resumeLastTurn).toHaveBeenCalledWith('n1'));
    expect(actions.resumeLastTurn).toHaveBeenCalledTimes(1);
  });

  it('drops a task whose chat runs again, and dismisses one on request', async () => {
    vi.mocked(api.fetchInterruptedTurns).mockResolvedValue([
      item('n1', 't1', 'Refactor the drawer'),
      item('n2', 't2', 'Deploy the stack'),
    ]);
    nodes = { n2: { status: 'streaming' } };
    render(bar());
    expect(await screen.findByText('Refactor the drawer')).toBeTruthy();
    expect(screen.queryByText('Deploy the stack')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Refactor the drawer' }));
    expect(api.dismissInterruptedTurn).toHaveBeenCalledWith(expect.objectContaining({ turnId: 't1', backendConnectionId: 'local' }));
    await waitFor(() => expect(screen.queryByText('Refactor the drawer')).toBeNull());
  });

  it('lists three, then all on request', async () => {
    vi.mocked(api.fetchInterruptedTurns).mockResolvedValue(
      ['a', 'b', 'c', 'd', 'e'].map((id, index) => item(`n-${id}`, `t-${id}`, `Task ${index + 1}`)),
    );
    render(bar());
    expect(await screen.findByText('Task 3')).toBeTruthy();
    expect(screen.queryByText('Task 4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All 5' }));
    expect(screen.getByText('Task 5')).toBeTruthy();
  });

  it('starts as its tab on a phone, and opens on a tap', async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      vi.mocked(api.fetchInterruptedTurns).mockResolvedValue([item('n1', 't1', 'Refactor the drawer')]);
      render(bar());
      fireEvent.click(await screen.findByRole('button', { name: 'Show the interrupted task' }));
      expect(await screen.findByText('Refactor the drawer')).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('Resume all carries every loaded task on in place, without opening them', async () => {
    vi.mocked(api.fetchInterruptedTurns).mockResolvedValue([
      item('n1', 't1', 'Refactor the drawer'),
      item('n2', 't2', 'Deploy the stack'),
    ]);
    nodes = {
      n1: { status: 'error', errorKind: 'backend_restarted', errorTurnId: 't1' },
      n2: { status: 'error', errorKind: 'credentials_expired', errorTurnId: 't2' },
    };
    render(bar());
    fireEvent.click(await screen.findByRole('button', { name: 'Resume all' }));
    expect(actions.resumeLastTurn.mock.calls).toEqual([['n1'], ['n2']]);
    expect(actions.revealNode).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Interrupted tasks' })).toBeNull());
  });

  it('moves the keyboard to the next task when one is dismissed', async () => {
    vi.mocked(api.fetchInterruptedTurns).mockResolvedValue([
      item('n1', 't1', 'Refactor the drawer'),
      item('n2', 't2', 'Deploy the stack'),
    ]);
    render(bar());
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Refactor the drawer' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Resume Deploy the stack' })));
  });
});
