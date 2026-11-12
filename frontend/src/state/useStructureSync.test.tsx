import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceStructureChange, WorkspaceStructureChangedEvent, WorkspaceStructureCursor } from 'michi-shared';
import type { ChatNodeState, Project } from './chatTypes';
import type { StructureEditGuards } from './structureMerge';

const mocks = vi.hoisted(() => ({
  fetchWorkspaceStructure: vi.fn(),
  fetchAllWorkspacesMeta: vi.fn(),
  takeHydrationStructureCursor: vi.fn<(connectionId: string) => WorkspaceStructureCursor | undefined>(),
}));

vi.mock('../services/api', () => ({
  fetchWorkspaceStructure: mocks.fetchWorkspaceStructure,
  fetchAllWorkspacesMeta: mocks.fetchAllWorkspacesMeta,
  takeHydrationStructureCursor: mocks.takeHydrationStructureCursor,
}));

import { hydrateBackendWorkspaces } from './chatHydration';
import { ORIGIN_WINDOW_ID } from '../config/windowIdentity';
import { useStructureSync, type StructureSyncDeps } from './useStructureSync';
import { requestWorkspaceStructureRead } from './workspaceSyncNotices';

function raw(id: string, trees: Array<[treeId: string, rootId: string]>, extra: { name?: string } = {}) {
  return {
    workspace: { id, name: extra.name ?? id, created_at: 1, updated_at: 1, settings: null, active_tree_id: trees[0]?.[0] ?? null, deleted_at: null, archived_at: null },
    trees: trees.map(([treeId, rootId], index) => ({ id: treeId, workspace_id: id, root_node_id: rootId, last_active_at: 10 - index, created_at: 1 })),
    nodes: trees.map(([treeId, rootId], index) => ({
      id: rootId, workspace_id: id, tree_id: treeId, kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: index + 1, message_count: 0,
    })),
    edges: [],
    messages: [],
    contexts: [],
  };
}

const quietGuards: StructureEditGuards = {
  workspaceFieldEdited: () => false,
  treeFieldEdited: () => false,
  nodeFieldEdited: () => false,
  pendingDeletes: () => ({ treeIds: new Set(), edgeIds: new Set() }),
  pendingEdgeUpserts: () => new Set(),
  // Everything the harness loaded came from the backend.
  heldByBackendBefore: () => true,
};

function harness(...workspaces: ReturnType<typeof raw>[]) {
  const hydrated = hydrateBackendWorkspaces(workspaces);
  const projectsRef = { current: hydrated.projects as Project[] };
  const nodesRef = { current: hydrated.nodes as Record<string, ChatNodeState> };
  const deps: StructureSyncDeps = {
    hydrated: true,
    projectsRef,
    nodesRef,
    activeProjectIdRef: { current: hydrated.projects[0].id },
    setProjects: vi.fn((update) => {
      projectsRef.current = typeof update === 'function' ? update(projectsRef.current) : update;
    }),
    setNodes: vi.fn(),
    setActiveProjectId: vi.fn(),
    structureVersionRef: { current: 0 },
    prunePaneIds: vi.fn(),
    persistence: {
      adoptBackendStructure: vi.fn(),
      structureGuards: quietGuards,
      workspacesBusy: vi.fn(() => false),
      whenWorkspacesSettled: vi.fn(async () => {}),
    },
    debounceMs: 50,
    retryDelayMs: 1_000,
  };
  const { result } = renderHook(() => useStructureSync(deps));
  const send = (event: WorkspaceStructureChangedEvent) => act(() => result.current('local', event));
  return { deps, send };
}

const frame = (seq: number, changes: WorkspaceStructureChange[] = []): WorkspaceStructureChangedEvent => ({ epoch: 'e1', seq, changes });
const settle = (ms = 60) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useStructureSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchWorkspaceStructure.mockReset();
    mocks.fetchAllWorkspacesMeta.mockReset();
    mocks.takeHydrationStructureCursor.mockReset().mockReturnValue({ epoch: 'e1', seq: 5 });
  });
  afterEach(() => vi.useRealTimers());

  it('re-reads what another window changed, merges it, and leaves focus and the active tree alone', async () => {
    const { deps, send } = harness(raw('ws-1', [['t1', 'n1'], ['t2', 'n2']]));
    send(frame(5));
    await settle();
    expect(mocks.fetchWorkspaceStructure).not.toHaveBeenCalled();

    mocks.fetchWorkspaceStructure.mockResolvedValue(raw('ws-1', [['t1', 'n1'], ['t2', 'n2'], ['t3', 'n3']], { name: 'Renamed' }));
    send(frame(6, [
      { entity: 'tree', op: 'created', workspaceId: 'ws-1', treeId: 't3', originWindowId: 'another-window' },
      { entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' },
    ]));
    await settle(30);
    expect(mocks.fetchWorkspaceStructure).not.toHaveBeenCalled(); // still debouncing
    await settle(30);
    expect(mocks.fetchWorkspaceStructure).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWorkspaceStructure).toHaveBeenCalledWith('ws-1');
    const project = deps.projectsRef.current[0];
    expect(project.name).toBe('Renamed');
    expect(project.trees.map((tree) => tree.id)).toEqual(['t1', 't2', 't3']);
    expect(project.activeTreeId).toBe('t1');
    expect(deps.nodesRef.current.n3).toMatchObject({ projectId: 'ws-1' });
    expect(deps.persistence.adoptBackendStructure).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'ws-1', chatIds: ['n3'], workspace: { name: 'Renamed' },
    }));
    expect(deps.setActiveProjectId).not.toHaveBeenCalled();
    expect(deps.prunePaneIds).not.toHaveBeenCalled();
  });

  it('re-reads when the persistence layer asks, dropping a reported removal only where the backend lacks it', async () => {
    // t-local was made here and its write discarded; t1 is reported too but the backend has it.
    const { deps } = harness(raw('ws-1', [['t1', 'n1'], ['t-local', 'n-local']]));
    mocks.fetchWorkspaceStructure.mockResolvedValue(raw('ws-1', [['t1', 'n1']], { name: 'Backend name' }));
    act(() => requestWorkspaceStructureRead({ connectionId: 'local', changes: [
      { entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' },
      { entity: 'tree', op: 'deleted', workspaceId: 'ws-1', treeId: 't-local' },
      { entity: 'tree', op: 'deleted', workspaceId: 'ws-1', treeId: 't1' },
    ] }));
    await settle();
    expect(mocks.fetchWorkspaceStructure).toHaveBeenCalledWith('ws-1');
    const project = deps.projectsRef.current[0];
    expect(project.name).toBe('Backend name');
    expect(project.trees.map((tree) => tree.id)).toEqual(['t1']);
    expect(deps.nodesRef.current['n-local']).toBeUndefined();
    expect(deps.nodesRef.current.n1).toBeDefined();
  });

  it('skips its own changes', async () => {
    const { send } = harness(raw('ws-1', [['t1', 'n1']]));
    send(frame(5));
    send(frame(6, [{ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1', originWindowId: ORIGIN_WINDOW_ID! }]));
    await settle(200);
    expect(mocks.fetchWorkspaceStructure).not.toHaveBeenCalled();
    expect(mocks.fetchAllWorkspacesMeta).not.toHaveBeenCalled();
  });

  it('re-reads everything in one request after a gap or a load that missed frames', async () => {
    mocks.fetchAllWorkspacesMeta.mockResolvedValue([raw('ws-1', [['t1', 'n1']], { name: 'Caught up' })]);
    const { deps, send } = harness(raw('ws-1', [['t1', 'n1']]));
    send(frame(8)); // the load saw seq 5
    await settle();
    expect(mocks.fetchAllWorkspacesMeta).toHaveBeenCalledWith('local');
    expect(deps.projectsRef.current[0].name).toBe('Caught up');

    send(frame(10, [{ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' }]));
    await settle();
    expect(mocks.fetchAllWorkspacesMeta).toHaveBeenCalledTimes(2);
    expect(mocks.fetchWorkspaceStructure).not.toHaveBeenCalled();
  });

  it('changes nothing while the backend cannot answer, and retries', async () => {
    const { deps, send } = harness(raw('ws-1', [['t1', 'n1']]));
    send(frame(5));
    mocks.fetchWorkspaceStructure
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(raw('ws-1', [['t1', 'n1']], { name: 'Later' }));
    send(frame(6, [{ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' }]));
    await settle();
    expect(mocks.fetchWorkspaceStructure).toHaveBeenCalledTimes(1);
    expect(deps.setProjects).not.toHaveBeenCalled();
    await settle(1_000);
    expect(mocks.fetchWorkspaceStructure).toHaveBeenCalledTimes(2);
    expect(deps.projectsRef.current[0].name).toBe('Later');
  });

  it('reads again when one of its own writes overlapped the read', async () => {
    const { deps, send } = harness(raw('ws-1', [['t1', 'n1']]));
    send(frame(5));
    vi.mocked(deps.persistence.workspacesBusy).mockReturnValueOnce(true);
    mocks.fetchWorkspaceStructure.mockResolvedValue(raw('ws-1', [['t1', 'n1']], { name: 'After the write' }));
    send(frame(6, [{ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' }]));
    await settle();
    expect(mocks.fetchWorkspaceStructure).toHaveBeenCalledTimes(2);
    expect(deps.persistence.whenWorkspacesSettled).toHaveBeenCalledTimes(2);
    expect(deps.projectsRef.current[0].name).toBe('After the write');
  });

  it('closes the panes of threads purged elsewhere and leaves a purged active workspace for a live one', async () => {
    const { deps, send } = harness(raw('ws-1', [['t1', 'n1'], ['t2', 'n2']]), raw('ws-2', [['t9', 'n9']]));
    send(frame(5));
    mocks.fetchWorkspaceStructure.mockResolvedValueOnce(raw('ws-1', [['t1', 'n1']]));
    send(frame(6, [
      { entity: 'node', op: 'purged', workspaceId: 'ws-1', nodeId: 'n2' },
      { entity: 'tree', op: 'deleted', workspaceId: 'ws-1', treeId: 't2' },
    ]));
    await settle();
    expect(deps.prunePaneIds).toHaveBeenCalledWith(new Set(['n2']));
    expect(deps.nodesRef.current.n2).toBeUndefined();
    expect(deps.setActiveProjectId).not.toHaveBeenCalled();

    mocks.fetchWorkspaceStructure.mockResolvedValueOnce(null);
    send(frame(7, [{ entity: 'workspace', op: 'purged', workspaceId: 'ws-1' }]));
    await settle();
    expect(deps.projectsRef.current.map((project) => project.id)).toEqual(['ws-2']);
    expect(deps.prunePaneIds).toHaveBeenLastCalledWith(new Set(['n1']));
    expect(deps.setActiveProjectId).toHaveBeenCalledWith('ws-2');
  });

  it('after a gap, removes what was purged elsewhere meanwhile and closes its panes', async () => {
    const { deps, send } = harness(raw('ws-1', [['t1', 'n1'], ['t2', 'n2']]), raw('ws-2', [['t9', 'n9']]));
    deps.activeProjectIdRef.current = 'ws-2';
    send(frame(5));
    // Missed frames 6-7: ws-2 was purged and t2 deleted while this window was away.
    mocks.fetchAllWorkspacesMeta.mockResolvedValue([raw('ws-1', [['t1', 'n1']])]);
    send(frame(8, [{ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' }]));
    await settle();
    expect(mocks.fetchAllWorkspacesMeta).toHaveBeenCalledWith('local');
    expect(deps.projectsRef.current.map((project) => project.id)).toEqual(['ws-1']);
    expect(deps.projectsRef.current[0].trees.map((tree) => tree.id)).toEqual(['t1']);
    expect(deps.prunePaneIds).toHaveBeenCalledWith(new Set(['n9', 'n2']));
    expect(deps.nodesRef.current.n2).toBeUndefined();
    // The active workspace is gone: the window moves to a live one.
    expect(deps.setActiveProjectId).toHaveBeenCalledWith('ws-1');
  });

  it('keeps what the backend never held when a full read lacks it', async () => {
    const { deps, send } = harness(raw('ws-1', [['t1', 'n1']]), raw('ws-new', [['tn', 'nn']]));
    deps.persistence.structureGuards = { ...quietGuards, heldByBackendBefore: (_entity, id) => id !== 'ws-new' && id !== 'tn' && id !== 'nn' };
    send(frame(5));
    mocks.fetchAllWorkspacesMeta.mockResolvedValue([raw('ws-1', [['t1', 'n1']], { name: 'Caught up' })]);
    send(frame(9));
    await settle();
    expect(deps.projectsRef.current.map((project) => project.id)).toEqual(['ws-1', 'ws-new']);
    expect(deps.projectsRef.current[0].name).toBe('Caught up');
    expect(deps.prunePaneIds).not.toHaveBeenCalled();
  });

  it('reads many named workspaces in one batched request, and a few one by one', async () => {
    const ids = ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6'];
    const { deps, send } = harness(...ids.map((id, index) => raw(id, [[`t${index}`, `n${index}`]])));
    send(frame(5));
    const renamedAll = (count: number) => ids.slice(0, count).map((workspaceId): WorkspaceStructureChange => ({
      entity: 'workspace', op: 'renamed', workspaceId,
    }));
    mocks.fetchWorkspaceStructure.mockImplementation(async (id: string) => raw(id, [[`t${ids.indexOf(id)}`, `n${ids.indexOf(id)}`]], { name: `${id} renamed` }));
    send(frame(6, renamedAll(5)));
    await settle();
    expect(mocks.fetchWorkspaceStructure).toHaveBeenCalledTimes(5);
    expect(mocks.fetchAllWorkspacesMeta).not.toHaveBeenCalled();

    mocks.fetchWorkspaceStructure.mockClear();
    // ws-6 was purged too: the batched list lacks it, and the record says so.
    mocks.fetchAllWorkspacesMeta.mockResolvedValue(ids.slice(0, 5).map((id, index) => raw(id, [[`t${index}`, `n${index}`]], { name: `${id} again` })));
    send(frame(7, [...renamedAll(5), { entity: 'workspace', op: 'purged', workspaceId: 'ws-6' }]));
    await settle();
    expect(mocks.fetchAllWorkspacesMeta).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAllWorkspacesMeta).toHaveBeenCalledWith('local');
    expect(mocks.fetchWorkspaceStructure).not.toHaveBeenCalled();
    expect(deps.projectsRef.current.map((project) => project.name)).toEqual(['ws-1 again', 'ws-2 again', 'ws-3 again', 'ws-4 again', 'ws-5 again']);
    expect(deps.prunePaneIds).toHaveBeenCalledWith(new Set(['n5']));
  });

  it('ignores frames until the store has loaded', async () => {
    const { deps, send } = harness(raw('ws-1', [['t1', 'n1']]));
    deps.hydrated = false;
    send(frame(9, [{ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' }]));
    await settle(200);
    expect(mocks.fetchWorkspaceStructure).not.toHaveBeenCalled();
    expect(mocks.fetchAllWorkspacesMeta).not.toHaveBeenCalled();
  });
});
