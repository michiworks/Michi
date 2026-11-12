/**
 * ChatProvider end to end: a workspace_structure_changed frame from the
 * background feed re-reads the workspace it names and merges the result into
 * the store, without moving focus, switching the tree or writing it back.
 */
import React from 'react';
import { vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => {
  const raw = (trees: Array<[string, string]>, name = 'Workspace') => ({
    workspace: { id: 'ws-1', name, created_at: 1, updated_at: 1, settings: null, active_tree_id: 't1', deleted_at: null, archived_at: null },
    trees: trees.map(([id, root], index) => ({ id, workspace_id: 'ws-1', root_node_id: root, last_active_at: 10 - index, created_at: 1 })),
    nodes: trees.map(([id, root], index) => ({
      id: root, workspace_id: 'ws-1', tree_id: id, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0,
      created_at: index + 1, message_count: 0,
    })),
    edges: [], messages: [], contexts: [],
  });
  return {
    raw,
    subscribeBackground: vi.fn((..._args: unknown[]) => () => {}),
    fetchWorkspaceStructure: vi.fn(),
    applyWorkspaceCommands: vi.fn(async (..._args: unknown[]) => {}),
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
  subscribeBackground: api.subscribeBackground,
  fetchPersistenceCapabilities: () => Promise.resolve({
    protocolVersion: 2, authoritativeTurnPersistence: true, durableNodePrerequisite: true,
    explicitCommands: true, backgroundWorkspaceSync: false, legacySyncAccepted: true,
  }),
  fetchAllWorkspacesMeta: () => Promise.resolve([api.raw([['t1', 'n1']])]),
  fetchTreeMessages: () => Promise.resolve([]),
  fetchTreeMessagePage: () => Promise.resolve({ messages: [] }),
  listBackendConnections: () => Promise.resolve([]),
  applyWorkspaceCommands: api.applyWorkspaceCommands,
  fetchWorkspaceStructure: api.fetchWorkspaceStructure,
  takeHydrationStructureCursor: () => ({ epoch: 'e1', seq: 0 }),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

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

describe('ChatProvider and the structure feed', () => {
  beforeEach(() => {
    localStorage.clear();
    api.subscribeBackground.mockClear();
    api.fetchWorkspaceStructure.mockReset();
    api.applyWorkspaceCommands.mockClear();
  });

  it('merges a thread another window made, leaving the active tree and focus', async () => {
    const { result } = renderHook(() => useChatStore(), { wrapper });
    await waitFor(() => expect(result.current.activeProject?.id).toBe('ws-1'));
    await waitFor(() => expect(api.subscribeBackground).toHaveBeenCalled());
    const options = api.subscribeBackground.mock.calls.at(-1)![1] as {
      onWorkspaceStructureChanged: (event: unknown) => void;
    };
    const focusedBefore = result.current.focusedNodeId;

    api.fetchWorkspaceStructure.mockResolvedValue(api.raw([['t1', 'n1'], ['t2', 'n2']], 'Renamed elsewhere'));
    act(() => {
      options.onWorkspaceStructureChanged({ epoch: 'e1', seq: 0, changes: [] });
      options.onWorkspaceStructureChanged({
        epoch: 'e1', seq: 1,
        changes: [
          { entity: 'tree', op: 'created', workspaceId: 'ws-1', treeId: 't2', originWindowId: 'another-window' },
          { entity: 'workspace', op: 'renamed', workspaceId: 'ws-1', originWindowId: 'another-window' },
        ],
      });
    });

    await waitFor(() => expect(result.current.activeProject?.trees.map((tree) => tree.id)).toEqual(['t1', 't2']));
    expect(api.fetchWorkspaceStructure).toHaveBeenCalledWith('ws-1');
    expect(result.current.activeProject?.name).toBe('Renamed elsewhere');
    expect(result.current.activeProject?.activeTreeId).toBe('t1');
    expect(result.current.activeProject?.chatIds).toEqual(['n1', 'n2']);
    expect(result.current.focusedNodeId).toBe(focusedBefore);

    // What came from the backend is not written back to it.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(api.applyWorkspaceCommands).not.toHaveBeenCalled();
  });
});
