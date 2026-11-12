/**
 * ChatProvider end to end over a workspace that holds threads no list shows
 * (page helpers, Meta agent maintenance runs, Scheduled-only runs, Trash, the
 * archive): bulk selection never takes one, and the open thread going away
 * never lands on one.
 */
import React from 'react';
import { vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => {
  type Root = { tree: string; node: string; at: number; archived?: boolean; extra?: Record<string, unknown> };
  const roots: Root[] = [
    { tree: 't-old', node: 'n-old', at: 10 },
    { tree: 't-new', node: 'n-new', at: 20 },
    { tree: 't-arch', node: 'n-arch', at: 50, archived: true },
    { tree: 't-trash', node: 'n-trash', at: 60, extra: { deleted_at: 5, deletion_group_id: 'del-earlier' } },
    { tree: 't-sched', node: 'n-sched', at: 70, extra: { scheduled_only_job_id: 'job-hidden' } },
    { tree: 't-maint', node: 'n-maint', at: 80, extra: { maintenance_job_id: 'job-maint' } },
    { tree: 't-page', node: 'n-page', at: 90, extra: { page_id: 'pg-1' } },
  ];
  return {
    moveTreeToWorkspace: vi.fn(async (..._args: unknown[]) => ({ movedNodes: 1, movedEdges: 0, droppedEdges: 0 })),
    workspaces: () => [{
      workspace: { id: 'ws-1', name: 'ws-1', created_at: 1, updated_at: 1, settings: null, active_tree_id: 't-new', deleted_at: null, archived_at: null },
      trees: roots.map((r) => ({ id: r.tree, workspace_id: 'ws-1', root_node_id: r.node, last_active_at: r.at, created_at: 1, archived_at: r.archived ? 40 : null })),
      nodes: roots.map((r, index) => ({
        id: r.node, workspace_id: 'ws-1', tree_id: r.tree, parent_node_id: null, kind: 'chat', status: 'idle', title: r.node,
        minimized: 0, spawned_by_agent: 0, created_at: index + 1, message_count: 0, ...r.extra,
      })),
      edges: [], messages: [], contexts: [],
    }, {
      workspace: { id: 'ws-2', name: 'ws-2', created_at: 1, updated_at: 1, settings: null, active_tree_id: 't-other', deleted_at: null, archived_at: null },
      trees: [{ id: 't-other', workspace_id: 'ws-2', root_node_id: 'n-other', last_active_at: 1, created_at: 1 }],
      nodes: [{ id: 'n-other', workspace_id: 'ws-2', tree_id: 't-other', parent_node_id: null, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1, message_count: 0 }],
      edges: [], messages: [], contexts: [],
    }],
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
  moveTreeToWorkspace: api.moveTreeToWorkspace,
  takeHydrationStructureCursor: () => ({ epoch: 'e1', seq: 0 }),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

import { ChatProvider, useChatNodesSnapshot, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';
import { buildTrashSections } from '../components/terminal/pages/trashModel';
import { isArchiveGroupId } from './trashActions';

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

async function hydratedStore() {
  const hook = renderHook(() => ({ store: useChatStore(), nodes: useChatNodesSnapshot() }), { wrapper });
  await waitFor(() => expect(hook.result.current.store.activeProject?.id).toBe('ws-1'));
  await waitFor(() => expect(hook.result.current.nodes['n-page']).toBeTruthy());
  return hook.result;
}

const selected = (result: Awaited<ReturnType<typeof hydratedStore>>) => [...result.current.store.treeSelection].sort();

describe('ChatProvider bulk thread selection', () => {
  beforeEach(() => localStorage.clear());

  it('Select all takes the threads the sidebar lists: no hidden helper, Trash, archive or merge chat', async () => {
    const result = await hydratedStore();
    await act(async () => { await result.current.store.createMergedChat(['n-old', 'n-new']); });
    act(() => result.current.store.selectAllTrees());
    expect(selected(result)).toEqual(['t-new', 't-old']);
  });

  it('selectTrees takes the ids a surface shows', async () => {
    const result = await hydratedStore();
    act(() => result.current.store.selectTrees(['t-old']));
    expect(selected(result)).toEqual(['t-old']);
  });

  it('deleting everything Select all took leaves nothing in Trash that Trash does not list', async () => {
    const result = await hydratedStore();
    act(() => result.current.store.selectAllTrees());
    act(() => result.current.store.bulkDeleteTrees());
    const { projects } = result.current.store;
    const nodes = result.current.nodes;
    const trashed = new Set(Object.values(nodes).flatMap((node) => (
      node.deletedAt && node.deletionGroupId && !isArchiveGroupId(node.deletionGroupId) ? [node.deletionGroupId] : []
    )));
    const listed = buildTrashSections(projects, nodes).flatMap((section) => section.groups.map((group) => group.id));
    expect(listed.sort()).toEqual([...trashed].sort());
    expect(trashed.size).toBe(3);
    expect(['n-page', 'n-maint', 'n-sched'].map((id) => nodes[id]?.deletedAt)).toEqual([undefined, undefined, undefined]);
  });
});

describe('ChatProvider landing when the open thread goes away', () => {
  beforeEach(() => localStorage.clear());
  const activeTree = (result: Awaited<ReturnType<typeof hydratedStore>>) =>
    result.current.store.projects.find((p) => p.id === 'ws-1')?.activeTreeId;

  it('starts on the requested thread', async () => {
    expect(activeTree(await hydratedStore())).toBe('t-new');
  });

  it('archiving it opens the newest listed thread, not a newer hidden one', async () => {
    const result = await hydratedStore();
    act(() => result.current.store.archiveTree('t-new'));
    expect(activeTree(result)).toBe('t-old');
  });

  it('deleting it opens the newest listed thread', async () => {
    const result = await hydratedStore();
    act(() => { result.current.store.deleteTree('t-new'); });
    expect(activeTree(result)).toBe('t-old');
  });

  it('trimming its root, which has no branch to promote, opens the newest listed thread', async () => {
    const result = await hydratedStore();
    act(() => result.current.store.trimNode('n-new'));
    expect(activeTree(result)).toBe('t-old');
  });

  it('moving it to another workspace opens the newest listed thread', async () => {
    const result = await hydratedStore();
    await act(async () => { await result.current.store.moveTreeToWorkspace('t-new', 'ws-2'); });
    expect(api.moveTreeToWorkspace).toHaveBeenCalledWith('t-new', 'ws-1', 'ws-2');
    expect(activeTree(result)).toBe('t-old');
  });
});
