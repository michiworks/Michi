/**
 * ChatProvider end to end: opening a multi-model run's branches side by
 * side with the chat that started them, in the active thread's slot and in
 * another thread's.
 */
import React from 'react';
import { vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => {
  type NodeSpec = [nodeId: string, parent: string | null, deleted?: boolean];
  const workspace = (id: string, trees: Array<[treeId: string, nodes: NodeSpec[]]>) => ({
    workspace: { id, name: id, created_at: 1, updated_at: 1, settings: null, active_tree_id: trees[0]?.[0] ?? null, deleted_at: null, archived_at: null },
    trees: trees.map(([treeId, nodes], index) => ({ id: treeId, workspace_id: id, root_node_id: nodes[0][0], last_active_at: 10 - index, created_at: 1 })),
    nodes: trees.flatMap(([treeId, nodes]) => nodes.map(([nodeId, parent, deleted], index) => ({
      id: nodeId, workspace_id: id, tree_id: treeId, parent_node_id: parent, kind: 'chat', status: 'idle', minimized: 0,
      spawned_by_agent: parent ? 1 : 0, created_at: index + 1, message_count: 0, deleted_at: deleted ? 5 : null,
      multi_model_run_id: parent ? 'wfr_1' : null, fresh_context: 0,
    }))),
    edges: trees.flatMap(([, nodes]) => nodes.filter(([, parent]) => parent).map(([nodeId, parent]) => ({
      id: `branch-${parent}-${nodeId}`, workspace_id: id, source_node_id: parent, target_node_id: nodeId, kind: 'branch',
    }))),
    messages: [], contexts: [],
  });
  return {
    workspaces: () => [
      workspace('ws-1', [
        ['t1', [['caller', null], ['b1', 'caller'], ['b2', 'caller'], ['gone', 'caller', true], ['other', 'caller']]],
        ['t2', [['caller-2', null], ['b3', 'caller-2']]],
      ]),
    ],
  };
});

vi.mock('../services/api', () => ({
  __esModule: true,
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-test-${++i}`); })(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(null),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  fetchPersistenceCapabilities: () => Promise.resolve({
    protocolVersion: 2, authoritativeTurnPersistence: true, durableNodePrerequisite: true,
    explicitCommands: true, backgroundWorkspaceSync: false, legacySyncAccepted: true,
  }),
  fetchAllWorkspacesMeta: () => Promise.resolve(api.workspaces()),
  fetchTreeMessages: () => Promise.resolve([]),
  fetchTreeMessagePage: () => Promise.resolve({ messages: [] }),
  listBackendConnections: () => Promise.resolve([]),
  applyWorkspaceCommands: vi.fn(async () => {}),
  takeHydrationStructureCursor: () => ({ epoch: 'e1', seq: 0 }),
}));


import { ChatProvider, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

async function hydrated() {
  const hook = renderHook(() => useChatStore(), { wrapper });
  await waitFor(() => expect(hook.result.current.activeProject?.activeTreeId).toBe('t1'));
  await waitFor(() => expect(hook.result.current.activeProject?.chatIds).toContain('b3'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  return hook;
}

describe('ChatProvider opening branches side by side', () => {
  const pages: unknown[] = [];
  const onPage = (event: Event) => pages.push((event as CustomEvent).detail);
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    pages.length = 0;
    window.addEventListener('michi:nav-page', onPage);
  });
  afterEach(() => window.removeEventListener('michi:nav-page', onPage));

  it('puts the branches right after the chat in the active slot, once each, and focuses the first', async () => {
    const { result } = await hydrated();
    act(() => { result.current.openPane('caller'); result.current.openPane('other'); result.current.openPane('b2'); });
    act(() => result.current.focusPane('other'));
    expect(result.current.openPanes).toEqual(['caller', 'other', 'b2']);

    act(() => result.current.openPanesSideBySide('caller', ['b1', 'b2', 'b1', 'gone', 'b3', 'missing']));
    expect(result.current.openPanes).toEqual(['caller', 'b1', 'b2', 'other']);
    expect(result.current.focusedPane).toBe('b1');
    expect(result.current.focusedNodeId).toBe('b1');
    expect(pages).toEqual([{ page: 'dashboard' }]);

    act(() => result.current.openPanesSideBySide('caller', ['b1', 'b2'], { focusNodeId: 'b2' }));
    expect(result.current.openPanes).toEqual(['caller', 'b1', 'b2', 'other']);
    expect(result.current.focusedPane).toBe('b2');
    expect(result.current.focusedNodeId).toBe('b2');
  });

  it('appends the chat and its branches when the chat is not open', async () => {
    const { result } = await hydrated();
    act(() => { result.current.openPane('other'); });
    act(() => { result.current.closePane('caller'); });
    expect(result.current.openPanes).toEqual(['other']);
    act(() => result.current.openPanesSideBySide('caller', ['b1']));
    expect(result.current.openPanes).toEqual(['other', 'caller', 'b1']);
    expect(result.current.focusedPane).toBe('b1');
  });

  it('opens a chat of another thread in that thread\'s slot and switches to it', async () => {
    const { result } = await hydrated();
    act(() => result.current.openPanesSideBySide('caller-2', ['b3', 'b1'], { focusNodeId: 'caller-2' }));
    await waitFor(() => expect(result.current.activeProject?.activeTreeId).toBe('t2'));
    expect(result.current.openPanes).toEqual(expect.arrayContaining(['caller-2', 'b3']));
    expect(result.current.openPanes).not.toContain('b1');
    expect(result.current.focusedPane).toBe('caller-2');
    expect(pages).toEqual([{ page: 'dashboard' }]);
  });

  it('views the branch it focuses in another thread, not that thread\'s root', async () => {
    const { result } = await hydrated();
    act(() => result.current.openPanesSideBySide('caller-2', ['b3'], { focusNodeId: 'b3' }));
    await waitFor(() => expect(result.current.activeProject?.activeTreeId).toBe('t2'));
    expect(result.current.focusedPane).toBe('b3');
    expect(result.current.focusedNodeId).toBe('b3');
  });
});
