/**
 * ChatProvider end to end: moving a thread to another workspace. The backend
 * moves the tree, its threads and its edges itself (POST /trees/:id/move), so
 * the dirty tracker must not send that move again: the workspace the thread
 * left refuses deletes of rows that now belong to the destination, and that
 * failing batch would be retried every two seconds until a reload.
 */
import React, { useCallback } from 'react';
import { vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => {
  const workspace = (id: string, trees: Array<[treeId: string, nodeIds: string[]]>) => ({
    workspace: { id, name: id, created_at: 1, updated_at: 1, settings: null, active_tree_id: trees[0]?.[0] ?? null, deleted_at: null, archived_at: null },
    trees: trees.map(([treeId, [root]], index) => ({ id: treeId, workspace_id: id, root_node_id: root, last_active_at: 10 - index, created_at: 1 })),
    nodes: trees.flatMap(([treeId, nodeIds]) => nodeIds.map((nodeId, index) => ({
      id: nodeId, workspace_id: id, tree_id: treeId, parent_node_id: index === 0 ? null : nodeIds[0],
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: index + 1, message_count: 0,
    }))),
    edges: trees.flatMap(([, [root, ...children]]) => children.map((child) => ({
      id: `branch-${root}-${child}`, workspace_id: id, source_node_id: root, target_node_id: child, kind: 'branch',
    }))),
    messages: [], contexts: [],
  });
  return {
    workspaces: () => [
      workspace('ws-1', [['t1', ['n1', 'n2']], ['t2', ['n3']]]),
      workspace('ws-2', [['t9', ['n9']]]),
    ],
    applyWorkspaceCommands: vi.fn(async (..._args: unknown[]) => {}),
    moveTreeToWorkspace: vi.fn(async (..._args: unknown[]) => ({ movedNodes: 2, movedEdges: 1, droppedEdges: 0 })),
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
  applyWorkspaceCommands: api.applyWorkspaceCommands,
  moveTreeToWorkspace: api.moveTreeToWorkspace,
  takeHydrationStructureCursor: () => ({ epoch: 'e1', seq: 0 }),
}));


import { ChatProvider, useChatStore, useStructuralSelector } from './chatStore';
import type { ChatNodeState } from './chatTypes';
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

type SentCommand = { type: string; payload: Record<string, unknown> };
const sent = () => api.applyWorkspaceCommands.mock.calls.flatMap(([workspaceId, , commands]) =>
  (commands as SentCommand[]).map((command) => [workspaceId, command.type, command.payload.id]));

describe('ChatProvider moving a thread to another workspace', () => {
  beforeEach(() => {
    localStorage.clear();
    api.applyWorkspaceCommands.mockClear();
    api.moveTreeToWorkspace.mockClear();
  });

  it('sends the workspace it left no deletes for what the backend already moved', async () => {
    const { result } = renderHook(() => useChatStore(), { wrapper });
    await waitFor(() => expect(result.current.projects.map((project) => project.id)).toEqual(['ws-1', 'ws-2']));
    await waitFor(() => expect(result.current.activeProject?.id).toBe('ws-1'));
    // Let the hydration baseline settle before acting.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    await act(async () => { await result.current.moveTreeToWorkspace('t1', 'ws-2'); });
    expect(api.moveTreeToWorkspace).toHaveBeenCalledWith('t1', 'ws-1', 'ws-2');
    const [source, destination] = result.current.projects;
    expect(source.trees.map((tree) => tree.id)).toEqual(['t2']);
    expect(source.chatIds).toEqual(['n3']);
    expect(source.activeTreeId).toBe('t2');
    expect(destination.trees.map((tree) => tree.id)).toEqual(['t9', 't1']);
    expect([...destination.chatIds].sort()).toEqual(['n1', 'n2', 'n9']);
    expect(destination.edges.map((edge) => `${edge.source}>${edge.target}`)).toEqual(['n1>n2']);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_300)); });
    // The source records only its new active thread; nothing that moved is written again.
    expect(sent()).toEqual([['ws-1', 'workspace.upsert', 'ws-1']]);
    const upsert = api.applyWorkspaceCommands.mock.calls.flatMap(([, , commands]) => commands as SentCommand[])[0];
    expect(upsert.payload).toMatchObject({ id: 'ws-1', active_tree_id: 't2' });

    // Edits after the move go to the workspace the thread now belongs to.
    api.applyWorkspaceCommands.mockClear();
    act(() => result.current.renameNode('n2', 'Moved branch'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_300)); });
    expect(sent()).toEqual([['ws-2', 'node.upsert', 'n2'], ['ws-2', 'node.patch', 'n2']]);
  });

  it('moves the threads for structural selectors too', async () => {
    const { result } = renderHook(() => ({
      store: useChatStore(),
      workspaceOfN1: useStructuralSelector(useCallback((nodes: Record<string, ChatNodeState>) => nodes.n1?.projectId, [])),
    }), { wrapper });
    await waitFor(() => expect(result.current.store.activeProject?.id).toBe('ws-1'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    await act(async () => { await result.current.store.moveTreeToWorkspace('t1', 'ws-2'); });

    expect(result.current.workspaceOfN1).toBe('ws-2');
  });
});
