import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatNodeState, Project } from './chatTypes';
import type { WorkspaceCommand } from '../services/api';
import type { StructureAdoption } from './structureAdoption';

const apiMocks = vi.hoisted(() => ({
  applyWorkspaceCommands: vi.fn(async (_workspaceId: string, _operationId: string, _commands: readonly WorkspaceCommand[]) => {}),
}));

vi.mock('../services/api', () => ({
  fetchPersistenceCapabilities: vi.fn(() => new Promise(() => {})),
  fetchAllWorkspacesMeta: vi.fn(() => new Promise(() => {})),
  fetchWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
  applyWorkspaceCommands: apiMocks.applyWorkspaceCommands,
}));

import { serializeWorkspaceForSync, useWorkspacePersistence } from './workspacePersistence';
import { reduceNodes } from './chatReducers';
import { reconcileWorkspaceStructure, type StructureMergeResult } from './structureMerge';

const project: Project = {
  id: 'ws-1', name: 'Workspace', chatIds: ['n1', 'n2', 'n3'],
  edges: [{ source: 'n1', target: 'n2' }], createdAt: 1,
  trees: [
    { id: 't1', rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 },
    { id: 't2', rootNodeId: 'n3', createdAt: 1, lastActiveAt: 1 },
  ],
  activeTreeId: 't2', artifacts: [],
};
const node = (nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState => ({
  nodeId, projectId: 'ws-1', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', ...extra,
});
const initialNodes = { n1: node('n1'), n2: node('n2', { parentNodeId: 'n1' }), n3: node('n3') };

function useHarness() {
  const [projects, setProjects] = useState([project]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>('ws-1');
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>(initialNodes);
  const [hydrated, setHydrated] = useState(true);
  const [structureVersion, setStructureVersion] = useState(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const persistence = useWorkspacePersistence({
    projects, activeProjectId, nodes, structureVersion, hydrated, nodesRef,
    setProjects, setActiveProjectId, setNodes, setHydrated,
    dirtyDraftNodeIdsRef: useRef(new Set<string>()), syncPausedRef: useRef(false), windowId: 'window-a',
  });
  return {
    persistence,
    projects,
    nodes,
    /** What structureSync does: note the adoption, then put it in the store. */
    adopt(adoption: StructureAdoption, update: (p: Project) => Project, nodeUpdate?: (n: Record<string, ChatNodeState>) => Record<string, ChatNodeState>) {
      persistence.adoptBackendStructure(adoption);
      setProjects((prev) => prev.map((p) => (p.id === 'ws-1' ? update(p) : p)));
      if (nodeUpdate) setNodes(nodeUpdate);
      setStructureVersion((version) => version + 1);
    },
    edit(update: (p: Project) => Project) {
      setProjects((prev) => prev.map((p) => (p.id === 'ws-1' ? update(p) : p)));
    },
    editNode(nodeId: string, patch: Partial<ChatNodeState>) {
      setNodes((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId], ...patch } }));
      setStructureVersion((version) => version + 1);
    },
    /** The user renames a thread (the reducer marks the title for saving). */
    rename(nodeId: string, title: string) {
      setNodes((prev) => reduceNodes(prev, { type: 'rename-node', nodeId, title }));
      setStructureVersion((version) => version + 1);
    },
    /** A branch made in this window: in the store, not saved yet. */
    addBranch(parentId: string, child: ChatNodeState) {
      setNodes((prev) => ({ ...prev, [child.nodeId]: child }));
      setProjects((prev) => prev.map((p) => (p.id === 'ws-1'
        ? { ...p, chatIds: [...p.chatIds, child.nodeId], edges: [...p.edges, { source: parentId, target: child.nodeId }] }
        : p)));
      setStructureVersion((version) => version + 1);
    },
    /** What structureSync's applyStructureMerge does with a re-read. */
    apply(merged: StructureMergeResult | null) {
      if (!merged) return;
      for (const adoption of merged.adoptions) persistence.adoptBackendStructure(adoption);
      setProjects(merged.projects);
      setNodes(merged.nodes);
      setStructureVersion((version) => version + 1);
    },
  };
}

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
const sentCommands = () => apiMocks.applyWorkspaceCommands.mock.calls.flatMap((call) => call[2]);

/** The workspace as the backend would read it back (structure only), with `patch` applied to its node rows. */
function readBack(current: Project, nodes: Record<string, ChatNodeState>, patch: (row: Record<string, unknown>) => void = () => {}) {
  const wire = serializeWorkspaceForSync(current, nodes);
  const rows = (wire.nodes as Array<Record<string, unknown>>).map((row) => ({ ...row, message_count: 0 }));
  rows.forEach(patch);
  return { workspace: wire.workspace, trees: wire.trees, nodes: rows, edges: wire.edges, messages: [], contexts: [] };
}

function reread(state: { projects: Project[]; nodes: Record<string, ChatNodeState> }, raw: unknown, readStartedAt: number,
  guards: Parameters<typeof reconcileWorkspaceStructure>[0]['guards']) {
  return reconcileWorkspaceStructure({
    currentProjects: state.projects,
    currentNodes: state.nodes,
    snapshots: [{ workspaceId: 'ws-1', raw }],
    connectionId: 'local',
    removals: { workspaceIds: new Set(), treeIds: new Set(), nodeIds: new Set() },
    readStartedAt,
    guards,
  });
}

describe('structure re-reads in the persistence layer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    apiMocks.applyWorkspaceCommands.mockClear();
    Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined });
  });
  afterEach(() => vi.useRealTimers());

  it('never writes back a re-read rename, and still writes a local one after it', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.adopt(
      { projectId: 'ws-1', readStartedAt: 10, workspace: { name: 'Renamed elsewhere', archivedAt: 20 } },
      (p) => ({ ...p, name: 'Renamed elsewhere', archivedAt: 20 }),
    ));
    await flush();
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();

    act(() => result.current.edit((p) => ({ ...p, name: 'Mine' })));
    await flush();
    expect(sentCommands().map((command) => [command.type, command.payload.name, command.payload.archived_at]))
      .toEqual([['workspace.upsert', 'Mine', 20]]);
  });

  it('sends no tree or edge deletes for a tree that moved to another workspace', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.adopt(
      {
        projectId: 'ws-1', readStartedAt: 10,
        removedTreeIds: ['t1'], removedChatIds: ['n1', 'n2'], removedEdgeIds: ['branch-n1-n2'],
      },
      (p) => ({ ...p, trees: p.trees.filter((tree) => tree.id !== 't1'), chatIds: ['n3'], edges: [] }),
    ));
    await flush();
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();

    // The same removal made here is a delete the backend must hear about.
    act(() => result.current.edit((p) => ({ ...p, trees: [], chatIds: [], edges: [] })));
    await flush();
    expect(sentCommands().map((command) => [command.type, command.payload.id])).toEqual([['tree.delete', 't2']]);
  });

  it('writes a node field taken from elsewhere back when it is not adopted (control)', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.editNode('n2', { deletedAt: 50, deletionGroupId: 'del-x' }));
    await flush();
    expect(sentCommands().some((command) => command.type === 'node.patch' && command.payload.deleted_at === 50)).toBe(true);
  });

  it('folds adopted node fields into what it compares, so only local edits go out', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const trashed = { ...result.current.nodes.n2, deletedAt: 50, deletionGroupId: 'del-x' };
    act(() => result.current.adopt(
      { projectId: 'ws-1', readStartedAt: 10, nodes: [{ node: trashed, fields: ['deletedAt', 'deletionGroupId'] }] },
      (p) => p,
      (prev) => ({ ...prev, n2: trashed }),
    ));
    // A stream on the node afterwards changes the object but no structure.
    act(() => result.current.editNode('n2', { status: 'streaming' }));
    await flush();
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();

    act(() => result.current.editNode('n2', { paneWidth: 480 }));
    await flush();
    const patch = sentCommands().find((command) => command.type === 'node.patch')!;
    expect(patch.payload).toMatchObject({ id: 'n2', pane_width: 480, deleted_at: 50, deletion_group_id: 'del-x' });
  });

  it('waits for the scan that renders an adoption before taking it as durable', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    // Noted, then an unrelated local edit scans first, then the store changes.
    act(() => {
      result.current.persistence.adoptBackendStructure({ projectId: 'ws-1', readStartedAt: 10, workspace: { name: 'Elsewhere' } });
      result.current.editNode('n3', { paneWidth: 300 });
    });
    act(() => result.current.edit((p) => ({ ...p, name: 'Elsewhere' })));
    await flush();
    expect(sentCommands().map((command) => command.type)).toEqual(['node.upsert', 'node.patch']);
  });

  it('reports a local edit until the backend confirms it, and a confirmation newer than the read', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const guards = () => result.current.persistence.structureGuards;
    const current = () => result.current.projects[0];
    expect(guards().workspaceFieldEdited(current(), 'name', 0)).toBe(false);
    expect(guards().treeFieldEdited(current(), current().trees[0], 'name', 0)).toBe(false);

    act(() => result.current.edit((p) => ({ ...p, name: 'Mine', trees: p.trees.map((tree) => (tree.id === 't1' ? { ...tree, name: 'Thread' } : tree)) })));
    expect(guards().workspaceFieldEdited(current(), 'name', Date.now())).toBe(true);
    expect(guards().treeFieldEdited(current(), current().trees[0], 'name', Date.now())).toBe(true);

    const beforeFlush = Date.now();
    await flush();
    const afterFlush = Date.now();
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalled();
    // A read that began before the write landed may predate it.
    expect(guards().workspaceFieldEdited(current(), 'name', beforeFlush)).toBe(true);
    expect(guards().workspaceFieldEdited(current(), 'name', afterFlush)).toBe(false);
    expect(guards().treeFieldEdited(current(), current().trees[0], 'name', afterFlush)).toBe(false);
  });

  it('reports a node field only when this window writes it and changed it', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const guards = () => result.current.persistence.structureGuards;
    // This window never wrote n1's title: a title from elsewhere is not its edit.
    act(() => result.current.editNode('n1', { title: 'Streamed title' }));
    expect(guards().nodeFieldEdited(result.current.projects[0], result.current.nodes, 'n1', 'title', Date.now())).toBe(false);
    act(() => result.current.editNode('n1', { deletedAt: 9, deletionGroupId: 'del-local' }));
    expect(guards().nodeFieldEdited(result.current.projects[0], result.current.nodes, 'n1', 'deleted_at', Date.now())).toBe(true);
    expect(guards().pendingEdgeUpserts(result.current.projects[0], Date.now()).size).toBe(0);
    act(() => result.current.edit((p) => ({ ...p, edges: [...p.edges, { source: 'n1', target: 'n3', kind: 'link' }] })));
    expect([...guards().pendingEdgeUpserts(result.current.projects[0], Date.now())]).toEqual(['link-n1-n3']);
  });

  it('tells when this window has a write in flight', async () => {
    let release!: () => void;
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.edit((p) => ({ ...p, name: 'Slow write' })));
    await flush();
    expect(result.current.persistence.workspacesBusy(['ws-1'])).toBe(true);
    expect(result.current.persistence.workspacesBusy(['ws-2'])).toBe(false);
    let settled = false;
    const waiting = result.current.persistence.whenWorkspacesSettled(['ws-1']).then(() => { settled = true; });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);
    await act(async () => { release(); await waiting; });
    expect(settled).toBe(true);
    expect(result.current.persistence.workspacesBusy(['ws-1'])).toBe(false);
  });

  it('keeps a rename this window has not saved yet against a re-read, then saves it', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const guards = () => result.current.persistence.structureGuards;
    act(() => result.current.rename('n1', 'Mine'));
    expect(result.current.nodes.n1).toMatchObject({ title: 'Mine', titleNeedsPersistence: true });
    expect(guards().nodeFieldEdited(result.current.projects[0], result.current.nodes, 'n1', 'title', Date.now())).toBe(true);

    // Another window changed ws-1 before this rename was saved: the backend still has no title.
    const stale = readBack(project, initialNodes);
    act(() => result.current.apply(reread(result.current, stale, Date.now(), guards())));
    expect(result.current.nodes.n1.title).toBe('Mine');

    const beforeSave = Date.now();
    await flush();
    const patch = sentCommands().find((command) => command.type === 'node.patch' && command.payload.id === 'n1');
    expect(patch?.payload.title).toBe('Mine');
    // A read that began before the save landed may predate it; one after it may not.
    expect(guards().nodeFieldEdited(result.current.projects[0], result.current.nodes, 'n1', 'title', beforeSave)).toBe(true);
    expect(guards().nodeFieldEdited(result.current.projects[0], result.current.nodes, 'n1', 'title', Date.now())).toBe(false);

    // Saved: a later rename made elsewhere is taken, and not written back.
    apiMocks.applyWorkspaceCommands.mockClear();
    const theirs = readBack(result.current.projects[0], result.current.nodes, (row) => { if (row.id === 'n1') row.title = 'Theirs'; });
    act(() => result.current.apply(reread(result.current, theirs, Date.now(), guards())));
    expect(result.current.nodes.n1.title).toBe('Theirs');
    await flush();
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();
  });

  it('takes what it saved, or adopted from a read, as held by the backend from then on', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const held = (entity: 'workspace' | 'tree' | 'node', id: string, at: number) =>
      result.current.persistence.structureGuards.heldByBackendBefore(entity, id, at);
    act(() => result.current.addBranch('n3', node('n4', { parentNodeId: 'n3' })));
    expect(held('node', 'n4', Date.now())).toBe(false);
    const beforeSave = Date.now();
    await flush();
    expect(held('node', 'n4', beforeSave)).toBe(false);
    expect(held('node', 'n4', Date.now())).toBe(true);

    // A thread another window made, brought in by a read that began at 10.
    const tree = { id: 't5', rootNodeId: 'n5', createdAt: 1, lastActiveAt: 1 };
    const n5 = node('n5');
    act(() => result.current.adopt(
      {
        projectId: 'ws-1', readStartedAt: 10,
        trees: [{ tree, fields: ['name', 'archivedAt', 'pinnedAt', 'rootNodeId'], isNew: true }],
        chatIds: ['n5'], nodes: [{ node: n5, fields: [], isNew: true }],
      },
      (p) => ({ ...p, trees: [...p.trees, tree], chatIds: [...p.chatIds, 'n5'] }),
      (prev) => ({ ...prev, n5 }),
    ));
    expect(held('tree', 't5', 10)).toBe(true);
    expect(held('node', 'n5', 10)).toBe(true);
    expect(held('tree', 't5', 9)).toBe(false);
  });

  it('takes a re-read thread view and seen marks as the backend has them', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const tree = { id: 't5', rootNodeId: 'n5', createdAt: 1, lastActiveAt: 1 };
    const n5 = node('n5', { lastAssistantAt: 5, viewedAt: 6, completionSeq: 3, seenCompletionSeq: 3 });
    act(() => result.current.adopt(
      {
        projectId: 'ws-1', readStartedAt: 10,
        trees: [{ tree, fields: ['name', 'archivedAt', 'pinnedAt', 'rootNodeId'], isNew: true }],
        chatIds: ['n5'], nodes: [{ node: n5, fields: [], isNew: true }],
      },
      (p) => ({ ...p, trees: [...p.trees, tree], chatIds: [...p.chatIds, 'n5'] }),
      (prev) => ({ ...prev, n5 }),
    ));
    act(() => result.current.editNode('n5', { paneWidth: 480 }));
    await flush();
    const patches = sentCommands().filter((command) => command.type === 'node.patch' && command.payload.id === 'n5');
    expect(patches.some((command) => command.payload.pane_width === 480)).toBe(true);
    expect(patches.filter((command) => 'seen_completion_seq' in command.payload || 'viewed_at' in command.payload)).toEqual([]);
  });

  it('keeps every field of a thread made here until it is saved', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => { await Promise.resolve(); });
    const guards = () => result.current.persistence.structureGuards;
    act(() => result.current.addBranch('n3', node('n4', { parentNodeId: 'n3', pinnedAt: 7 })));
    const edited = (field: 'pinned_at' | 'deleted_at', at: number) =>
      guards().nodeFieldEdited(result.current.projects[0], result.current.nodes, 'n4', field, at);
    // The backend made it already (a send created it) but this window's pin has not been saved.
    expect(edited('pinned_at', Date.now())).toBe(true);
    const unpinned = readBack(result.current.projects[0], result.current.nodes, (row) => { if (row.id === 'n4') row.pinned_at = null; });
    act(() => result.current.apply(reread(result.current, unpinned, Date.now(), guards())));
    expect(result.current.nodes.n4.pinnedAt).toBe(7);

    await flush();
    expect(sentCommands().find((command) => command.type === 'node.patch' && command.payload.id === 'n4')?.payload.pinned_at).toBe(7);
    expect(edited('pinned_at', Date.now())).toBe(false);
    expect(edited('deleted_at', Date.now())).toBe(false);
  });
});
