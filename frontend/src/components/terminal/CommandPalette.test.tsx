import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';

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

const messageSearch = vi.hoisted(() => ({ status: 'ready' as 'idle' | 'loading' | 'ready' | 'error' }));
vi.mock('../../state/useNodeSearch', () => ({
  useNodeSearch: () => ({ nodes: [], totalNodes: 0, status: messageSearch.status }),
}));

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  selectProject.mockReset();
  revealNode.mockReset();
  messageSearch.status = 'ready';
});

describe('CommandPalette workspace routing', () => {
  it('keeps a specific chat result on the dashboard', () => {
    const setPage = vi.fn();
    render(<CommandPalette activePage="home" setPage={setPage} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), {
      target: { value: 'Pricing' },
    });
    fireEvent.click(screen.getByText('Pricing · Workspace B'));

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
    expect(screen.getByText('No matches')).toBeTruthy();
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
