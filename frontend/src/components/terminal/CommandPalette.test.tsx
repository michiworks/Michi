import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';
import { __resetHomeDraftForTests, receiveHomeDraft } from '../../state/homeDraft';
import { paletteRow } from '../../test/paletteRow';
import { resetTemporaryChatDraft, useTemporaryChatDraft } from '../../state/temporaryChatDraft';
import type { NodeGroupedResult } from '../../services/api';

const selectProject = vi.hoisted(() => vi.fn());
const revealNode = vi.hoisted(() => vi.fn());

vi.mock('../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: {
      id: 'workspace-1',
      name: 'Workspace A',
      trees: [],
      activeTreeId: null,
    },
    projects: [
      { id: 'workspace-1', name: 'Workspace A', trees: [] },
      { id: 'workspace-2', name: 'Workspace B', trees: [] },
    ],
    selection: new Set<string>(),
    clearSelection: vi.fn(),
    openPane: vi.fn(),
    createDigest: vi.fn(),
    createMergedChat: vi.fn(),
    createThread: vi.fn(),
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    selectProject,
    revealNode,
    setSearchHighlightTerm: vi.fn(),
  }),
  useChatNodesSnapshot: () => ({}),
  selectAllChats: () => [
    {
      id: 'chat-2',
      title: 'Pricing',
      projectId: 'workspace-2',
      projectName: 'Workspace B',
    },
  ],
}));

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({
    prefs: { bypassPermissions: false },
    setPref: vi.fn(),
  }),
}));

vi.mock('../../lib/digestPrompt', () => ({ requestDigest: vi.fn() }));

const messageSearch = vi.hoisted(() => ({
  status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
  nodes: [] as NodeGroupedResult[],
  attempt: 0,
}));
vi.mock('../../state/useNodeSearch', () => ({
  useNodeSearch: (_query: string, _backends: unknown, attempt = 0) => {
    messageSearch.attempt = attempt;
    return { nodes: messageSearch.nodes, totalNodes: messageSearch.nodes.length, status: messageSearch.status };
  },
}));

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  selectProject.mockReset();
  revealNode.mockReset();
  messageSearch.status = 'ready';
  messageSearch.attempt = 0;
});

describe('CommandPalette workspace routing', () => {
  it('keeps a specific chat result on the dashboard', () => {
    const setPage = vi.fn();
    render(<CommandPalette activePage="home" setPage={setPage} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), {
      target: { value: 'Pricing' },
    });
    // Its name, marked where the words sit, with its workspace at the row's end.
    const row = screen.getByText(paletteRow('Pricing')).closest('li')!;
    expect(row.querySelector('mark')?.textContent).toBe('Pricing');
    expect(row.querySelector('.michi-menu-where')?.textContent).toBe('Workspace B');
    fireEvent.click(row);

    expect(selectProject).toHaveBeenCalledWith('workspace-2');
    // revealNode opens it in its own slot and shows the Dashboard.
    expect(revealNode).toHaveBeenCalledWith('chat-2');
  });
});

describe('CommandPalette quick number shortcuts', () => {
  it('displays number shortcut badges and triggers result via Cmd+1 when searching', () => {
    const setPage = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={setPage} onClose={onClose} />);

    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    fireEvent.change(input, {
      target: { value: 'Workspace B' },
    });

    // Match row exists and shows quick number shortcut
    const badge = screen.getByText(/1$/);
    expect(badge).not.toBeNull();

    // Press Cmd+1 (or Ctrl+1)
    fireEvent.keyDown(input, {
      key: '1',
      metaKey: true,
    });

    expect(selectProject).toHaveBeenCalledWith('workspace-2');
    expect(setPage).toHaveBeenCalledWith('home');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CommandPalette message search', () => {
  it('says No matches only after the message search answered with none', async () => {
    messageSearch.status = 'loading';
    const setPage = vi.fn();
    const onClose = vi.fn();
    const palette = () => <CommandPalette activePage="dashboard" setPage={setPage} onClose={onClose} />;
    const view = render(palette());
    fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), { target: { value: 'zzz-unmatched' } });
    expect(screen.getByText('Searching…')).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(screen.getByText('Searching…')).toBeTruthy();

    messageSearch.status = 'error';
    view.rerender(palette());
    expect(screen.getByText('Couldn’t search messages')).toBeTruthy();

    messageSearch.status = 'ready';
    view.rerender(palette());
    expect(screen.getByText('No matches for “zzz-unmatched”')).toBeTruthy();
  });

  it('makes each matching message a row ↓ reaches, which opens its thread at that message', () => {
    messageSearch.nodes = [{
      nodeId: 'n1', nodeTitle: 'Launch', workspaceId: 'workspace-1', workspaceName: 'Workspace A', treeId: null,
      lastMessageAt: 1, totalMatches: 2, breadcrumb: ['Launch'],
      snippets: [{ messageId: 'm1', role: 'user', snippet: 'first draft' }, { messageId: 'm2', role: 'assistant', snippet: 'second draft' }],
    }];
    try {
      render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
      const input = screen.getByPlaceholderText('Search chats, commands, messages…');
      fireEvent.change(input, { target: { value: 'draft' } });
      const activeRow = () => document.querySelector('[data-active="true"]')?.textContent ?? '';
      for (let i = 0; i < 20 && activeRow() !== 'second draft'; i += 1) fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(revealNode).toHaveBeenCalledWith('n1', { workspaceId: 'workspace-1', messageId: 'm2' });
    } finally {
      messageSearch.nodes = [];
    }
  });

  it('offers to start a thread with words that found nothing, and leaves them in the Home composer', async () => {
    const setPage = vi.fn();
    const onClose = vi.fn();
    const received: string[] = [];
    const stop = receiveHomeDraft((text) => received.push(text));
    try {
      render(<CommandPalette activePage="dashboard" setPage={setPage} onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), { target: { value: 'zzz-unmatched' } });
      // Not while the message search may still find something.
      expect(screen.queryByText(paletteRow('New thread: “zzz-unmatched”'))).toBeNull();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
      fireEvent.click(screen.getByText(paletteRow('New thread: “zzz-unmatched”')));
      expect(received).toEqual(['zzz-unmatched']);
      expect(setPage).toHaveBeenCalledWith('home');
      expect(onClose).toHaveBeenCalled();
    } finally {
      stop();
      __resetHomeDraftForTests();
    }
  });

  it('says a failed message search failed, with a Retry row that searches again', async () => {
    messageSearch.status = 'error';
    const onClose = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={onClose} />);
    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    fireEvent.change(input, { target: { value: 'zzz-unmatched' } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t search messages');
    expect(screen.queryByText('No matches for “zzz-unmatched”')).toBeNull();
    // Last of the rows, after those that use the words anyway; ↓ reaches it.
    const retry = screen.getByText(paletteRow('Retry')).closest('li')!;
    for (let i = 0; i < 5; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(retry.getAttribute('data-active')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(messageSearch.attempt).toBe(1);
    fireEvent.click(retry);
    expect(messageSearch.attempt).toBe(2);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CommandPalette New temporary chat', () => {
  it('turns on Home’s temporary-chat switch and opens Home', () => {
    act(() => resetTemporaryChatDraft());
    const draft = renderHook(() => useTemporaryChatDraft());
    const setPage = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={setPage} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), { target: { value: 'temporary' } });
    fireEvent.click(screen.getByText(paletteRow('New temporary chat')));
    expect(draft.result.current).toBe(true);
    expect(setPage).toHaveBeenCalledWith('home');
    expect(onClose).toHaveBeenCalled();
    act(() => resetTemporaryChatDraft());
  });
});

describe('CommandPalette IME handling', () => {
  it('does not run the active command when Enter confirms IME composition', () => {
    const onClose = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={onClose} />);

    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    fireEvent.keyDown(input, {
      key: 'Enter',
      isComposing: true,
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('stays open on the Esc that dismisses IME candidates (%o)', (ime) => {
    const onClose = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={onClose} />);
    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    fireEvent.keyDown(input, { key: 'Escape', ...ime });
    fireEvent.keyDown(input, { key: 'Enter', ...ime });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
