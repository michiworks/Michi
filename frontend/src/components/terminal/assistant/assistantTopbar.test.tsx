/**
 * The assistant's conversation opened as a pane makes its hidden workspace
 * the active one: the topbar names it "Assistant" and offers none of the
 * launchers that act on the active workspace.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-tb-${++i}`); })(),
  checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }),
  triggerUpdate: vi.fn(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
}));
vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => null }));
vi.mock('../PaneLauncher', () => ({ default: () => <button type="button">Pane launcher</button> }));
vi.mock('../BrowserLauncher', () => ({ default: () => <button type="button">Browser launcher</button> }));

import TerminalTopbar from '../Topbar';
import { SidebarViewTabs } from '../sidebar/SidebarChrome';
import { ChatProvider, useChatActions, useChatStore } from '../../../state/chatStore';
import { PrefsProvider } from '../../../state/prefs';
import { navigateToNode } from '../../../state/navigateToNode';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const SYSTEM = {
  workspace: { id: 'sys', name: 'Michi assistant workspace', created_at: 1, settings: JSON.stringify({ system: 'assistant' }) },
  trees: [{ id: 't-sys', root_node_id: 'n-sys', last_active_at: 1 }],
  nodes: [{ id: 'n-sys', created_at: 1, title: 'Archive the chat-only threads' }],
  edges: [],
  messages: [],
};

let store: ReturnType<typeof useChatStore>;
let actions: ReturnType<typeof useChatActions>;
const navigation = { canBack: false, canForward: false, onBack: () => {}, onForward: () => {} };

function Harness() {
  store = useChatStore();
  actions = useChatActions();
  return null;
}

describe('the topbar with the assistant open as a pane', () => {
  it('names the agent and drops the workspace launchers', async () => {
    localStorage.clear();
    render(
      <PrefsProvider>
        <ChatProvider>
          <Harness />
          <TerminalTopbar page="dashboard" onNav={vi.fn()} sidebarCollapsed={false} onToggleSidebar={() => {}} workspaceReady navigation={navigation} />
        </ChatProvider>
      </PrefsProvider>,
    );
    await waitFor(() => expect(store.hydrated).toBe(true));
    await act(async () => { await store.createProject('Work', '/work'); });
    act(() => { store.createThread(); });
    // The thread views: Map (Overview folded into it; Digest is off by default).
    expect(await screen.findByRole('button', { name: 'Map' })).toBeTruthy();
    expect(screen.getByText('Pane launcher')).toBeTruthy();

    act(() => { actions.installWorkspaceSnapshot(SYSTEM); });
    await waitFor(() => expect(store.projects.some((p) => p.id === 'sys')).toBe(true));
    act(() => {
      navigateToNode({
        projects: store.projects, activeProjectId: store.activeProjectId,
        selectProject: store.selectProject, openPane: store.openPane, openPaneInTree: store.openPaneInTree,
        activateTree: store.activateTree, setFocusedNodeId: store.setFocusedNodeId,
      }, 'n-sys', 'sys');
    });
    await waitFor(() => expect(store.activeProject?.id).toBe('sys'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Map' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Digest' })).toBeNull();
    expect(screen.queryByText('Pane launcher')).toBeNull();
    expect(screen.queryByText('Browser launcher')).toBeNull();
    // Named by the agent's name (DESIGN-v2 §1.5); 'Michi' before a snapshot names it.
    expect((await screen.findAllByText('Michi')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Archive the chat-only threads')).toBeNull();
    expect(screen.queryByText('Michi assistant workspace')).toBeNull();
  });

  // The unread count moved from the topbar's Activity button to the sidebar's Recent tab.
  it('never counts an unread assistant reply on the Recent tab', async () => {
    localStorage.clear();
    render(
      <PrefsProvider>
        <ChatProvider>
          <Harness />
          <SidebarViewTabs id="tabs" />
        </ChatProvider>
      </PrefsProvider>,
    );
    await waitFor(() => expect(store.hydrated).toBe(true));
    const recent = () => screen.getByRole('tab', { name: /^Recent/ });
    // An unseen completion, as hydration reads it from a node row.
    const unseen = { completion_seq: 1, seen_completion_seq: 0 };

    // The assistant answered in the panel: nothing for the user to find in Recent.
    act(() => {
      actions.installWorkspaceSnapshot({ ...SYSTEM, nodes: SYSTEM.nodes.map((node) => ({ ...node, ...unseen })) });
    });
    await waitFor(() => expect(store.projects.some((p) => p.id === 'sys')).toBe(true));
    expect(recent().textContent).toBe('Recent');
    expect(recent().getAttribute('aria-label')).toBeNull();

    // A reply in the user's own thread still counts.
    act(() => {
      actions.installWorkspaceSnapshot({
        workspace: { id: 'work', name: 'Work', created_at: 1 },
        trees: [{ id: 't-work', root_node_id: 'n-work', last_active_at: 2 }],
        nodes: [{ id: 'n-work', created_at: 1, title: 'My own thread', ...unseen }],
        edges: [],
        messages: [],
      });
    });
    await waitFor(() => expect(recent().textContent).toBe('Recent1'));
    expect(recent().getAttribute('aria-label')).toBe('Recent, 1 unread');
  });
});
