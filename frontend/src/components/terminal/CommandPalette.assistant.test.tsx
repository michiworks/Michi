import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANION_SETTINGS } from 'michi-shared';
import CommandPalette from './CommandPalette';
import { getCompanionAssistant, resetCompanionStoreForTests, type CompanionAssistantState } from '../../state/companion/companionStore';
import { getCompanionPanelState, resetCompanionPanelForTests } from '../../state/companion/companionPanel';
import { companionSnapshot } from '../../test/companionFixtures';

// One user workspace and the assistant's hidden one, each with a chat whose
// title and messages match "plan".
const projects = vi.hoisted(() => [
  { id: 'w1', name: 'Workspace A', trees: [], chatIds: ['n1'], edges: [], createdAt: 1, activeTreeId: null },
  { id: 'sys', name: 'Assistant', system: 'assistant', trees: [], chatIds: ['n-sys'], edges: [], createdAt: 2, activeTreeId: null },
]);
const nodes = vi.hoisted(() => ({
  n1: { nodeId: 'n1', projectId: 'w1', title: 'Plan the launch', messages: [] },
  'n-sys': { nodeId: 'n-sys', projectId: 'sys', title: 'Plan with the assistant', messages: [] },
}));

const palette = vi.hoisted(() => ({ active: null as null | Record<string, unknown> }));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../state/chatStore')>('../../state/chatStore');
  return {
    selectAllChats: actual.selectAllChats,
    useChatNodesSnapshot: () => nodes,
    useChatStore: () => ({
      activeProject: palette.active,
      projects,
      selection: new Set<string>(),
      clearSelection: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), createDigest: vi.fn(),
      createMergedChat: vi.fn(), createThread: vi.fn(), activateTree: vi.fn(), archiveTree: vi.fn(),
      unarchiveTree: vi.fn(), selectProject: vi.fn(), setFocusedNodeId: vi.fn(), setSearchHighlightTerm: vi.fn(),
    }),
  };
});
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { bypassPermissions: false }, setPref: vi.fn() }) }));
vi.mock('../../state/useNodeSearch', () => ({
  useNodeSearch: (query: string) => ({
    nodes: query ? [
      { nodeId: 'n1', workspaceId: 'w1', workspaceName: 'Workspace A', nodeTitle: 'Plan the launch', treeId: null, lastMessageAt: 1, totalMatches: 1, breadcrumb: ['Workspace A'], snippets: [{ messageId: 'm1', role: 'user', snippet: 'plan A' }] },
      { nodeId: 'n-sys', workspaceId: 'sys', workspaceName: 'Assistant', nodeTitle: 'Plan with the assistant', treeId: null, lastMessageAt: 2, totalMatches: 1, breadcrumb: ['Assistant'], snippets: [{ messageId: 'm2', role: 'user', snippet: 'plan secret' }] },
    ] : [],
    totalNodes: query ? 2 : 0,
    status: query ? 'ready' : 'idle',
  }),
}));
vi.mock('../../lib/digestPrompt', () => ({ requestDigest: vi.fn() }));
const api = vi.hoisted(() => ({ reset: vi.fn(), check: vi.fn(), patch: vi.fn() }));
vi.mock('../../services/api/companion', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/companion')>('../../services/api/companion');
  return { ...actual, checkCompanionNow: api.check, patchCompanionSettings: api.patch };
});
vi.mock('../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/assistant')>('../../services/api/assistant');
  return { ...actual, resetAssistant: api.reset };
});

const runs = { runtimeId: 'claude' as const, providerId: null, modelId: null, reasoning: null };
const ready = (nodeId = 'n-sys', workspaceId = 'sys'): CompanionAssistantState => ({
  status: 'ready', error: null,
  info: { nodeId, workspaceId, treeId: 't', settings: runs, conversation: runs, supportedRuntimes: ['claude'] },
});

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  api.reset.mockReset();
  api.check.mockReset();
  api.patch.mockReset();
  resetCompanionStoreForTests();
  resetCompanionPanelForTests();
});
afterEach(() => { resetCompanionStoreForTests(); resetCompanionPanelForTests(); });

function search(query: string) {
  fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), { target: { value: query } });
}

function named(name: string) {
  const settings = { ...structuredClone(DEFAULT_COMPANION_SETTINGS), displayName: name };
  resetCompanionStoreForTests({ availability: 'available', snapshot: companionSnapshot({ settings }), assistant: ready() });
}

describe('CommandPalette and the assistant', () => {
  it('never offers the assistant workspace or its conversation', async () => {
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
    search('plan');
    // Message search runs on the debounced query.
    await screen.findByText(/Messages · 1 node$/);
    expect(document.body.textContent).toContain('Plan the launch');
    expect(document.body.textContent).not.toContain('Plan with the assistant');
    expect(document.body.textContent).not.toContain('plan secret');
    search('Assistant');
    expect(screen.queryByText('Switch to workspace ▸ Assistant')).toBeNull();
    search('Workspace A');
    expect(screen.getByText('Switch to workspace ▸ Workspace A')).toBeTruthy();
  });

  it('hides the assistant conversation from search before its workspace is loaded', async () => {
    const [sys] = projects.splice(1, 1);
    resetCompanionStoreForTests({ assistant: ready() });
    try {
      render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
      search('plan');
      await screen.findByText(/Messages · 1 node$/);
      expect(document.body.textContent).not.toContain('plan secret');
    } finally {
      projects.splice(1, 0, sys);
    }
  });

  it('offers none of the assistant workspace threads while it is the active one', () => {
    const tree = (id: string, archivedAt?: number) => ({ id, rootNodeId: 'n-sys', name: `Conversation ${id}`, createdAt: 1, lastActiveAt: 1, ...(archivedAt ? { archivedAt } : {}) });
    const user = { ...projects[0], trees: [tree('t-user')], activeTreeId: 't-user' };
    palette.active = user;
    try {
      const view = render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
      search('Archive current');
      expect(screen.getByText('Archive current thread')).toBeTruthy();
      view.unmount();
      palette.active = { ...projects[1], trees: [tree('t-new'), tree('t-old', 5)], activeTreeId: 't-new' };
      render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
      search('thread');
      expect(screen.queryByText('Archive current thread')).toBeNull();
      expect(screen.queryByText(/Switch to archived thread/)).toBeNull();
      expect(screen.getByText('New thread')).toBeTruthy();
    } finally {
      palette.active = null;
    }
  });

  it('names every row after the agent, with ⌘J and ⇧⌘J, and has no "Ask the assistant"', () => {
    named('Robin');
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    search('robin');
    for (const label of ['Ask Robin', 'Robin: Today', 'Robin: Check now', 'Robin: Pause check-ins', 'Robin: New conversation', 'Robin: Settings']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    search('ask the');
    expect(screen.queryByText('Ask the assistant')).toBeNull();
    search('companion');
    expect(screen.queryByText(/Companion/)).toBeNull();
  });

  it('opens the panel on Chat for Ask and on Today for Today', () => {
    const onClose = vi.fn();
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={onClose} />);
    search('Ask Michi');
    fireEvent.click(screen.getByText('Ask Michi'));
    expect(onClose).toHaveBeenCalled();
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat' });
    act(() => resetCompanionPanelForTests());
    search('Michi: Today');
    fireEvent.click(screen.getByText('Michi: Today'));
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today' });
  });

  it('offers Chat before the Companion state loads, check-ins only once it has', () => {
    resetCompanionStoreForTests({ assistant: ready() });
    const view = render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    search('michi');
    expect(screen.getByText('Ask Michi')).toBeTruthy();
    expect(screen.getByText('Michi: New conversation')).toBeTruthy();
    expect(screen.queryByText('Michi: Check now')).toBeNull();
    expect(screen.queryByText(/check-ins/)).toBeNull();
    view.unmount();
    named('Michi');
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    search('michi');
    expect(screen.getByText('Michi: Check now')).toBeTruthy();
    expect(screen.getByText('Michi: Pause check-ins')).toBeTruthy();
  });

  it('says Resume check-ins while they are paused', () => {
    const settings = { ...structuredClone(DEFAULT_COMPANION_SETTINGS), paused: true };
    resetCompanionStoreForTests({ availability: 'available', snapshot: companionSnapshot({ settings }), assistant: ready() });
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    search('check-ins');
    expect(screen.getByText('Michi: Resume check-ins')).toBeTruthy();
    expect(screen.queryByText('Michi: Pause check-ins')).toBeNull();
  });

  it('starts a new conversation on the one on screen and shows it in the panel', async () => {
    named('Michi');
    api.reset.mockResolvedValue(ready('n-new').info);
    const reset = vi.fn();
    window.addEventListener('michi:assistant-reset', reset);
    try {
      render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
      search('New conversation');
      fireEvent.click(screen.getByText('Michi: New conversation'));
      expect(api.reset).toHaveBeenCalledWith('n-sys');
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(getCompanionAssistant().info?.nodeId).toBe('n-new');
      expect(reset).toHaveBeenCalledOnce();
      expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat' });
    } finally {
      window.removeEventListener('michi:assistant-reset', reset);
    }
  });

  it('opens Settings › <name> for Settings', () => {
    const onSection = vi.fn();
    window.addEventListener('michi:open-settings-section', onSection);
    try {
      render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
      search('Michi: Settings');
      fireEvent.click(screen.getByText('Michi: Settings'));
      expect((onSection.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'companion' });
    } finally {
      window.removeEventListener('michi:open-settings-section', onSection);
    }
  });

  it('has no agent rows when this backend has no assistant', () => {
    resetCompanionStoreForTests({ assistant: { status: 'unsupported', info: null, error: null } });
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    search('michi');
    expect(screen.queryByText('Ask Michi')).toBeNull();
    expect(screen.queryByText('Michi: Today')).toBeNull();
  });
});
