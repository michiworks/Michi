import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatNodeState, Project } from './chatTypes';
import type { WorkspaceCommand } from '../services/api';
import type { BackendConnectionSummary } from '../config/backendConnections';
import { WorkspaceCommandsError } from '../services/api/persistence';

const apiMocks = vi.hoisted(() => ({
  // An older backend's answer carries nothing (undefined here); a newer one may name artifacts gone or name-taken.
  applyWorkspaceCommands: vi.fn(async (_workspaceId: string, _operationId: string, _commands: readonly WorkspaceCommand[]):
    Promise<{ goneContextIds: string[]; nameTakenContextIds?: string[] } | void> => {}),
  fetchPersistenceCapabilities: vi.fn(),
  fetchAllWorkspacesMeta: vi.fn(),
  listBackendConnections: vi.fn(async (): Promise<BackendConnectionSummary[]> => []),
}));

vi.mock('../services/api', () => ({
  applyWorkspaceCommands: apiMocks.applyWorkspaceCommands,
  fetchPersistenceCapabilities: apiMocks.fetchPersistenceCapabilities,
  fetchAllWorkspacesMeta: apiMocks.fetchAllWorkspacesMeta,
  listBackendConnections: apiMocks.listBackendConnections,
  fetchTreeMessageSnapshot: vi.fn(async () => ({ messages: [] })),
  fetchTreeMessagePage: vi.fn(async () => ({ messages: [] })),
  fetchWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
}));

import { backendEntityId } from '../config/backendIdentity';
import { markBackendConnectionReady, markBackendConnectionUnavailable } from '../config/backendConnectionState';
import { setKnownBackendConnections } from '../config/backendConnections';
import { reduceProject } from './chatReducers';
import { useContextActions } from './contextActions';
import { retryRemoteWorkspace } from './remoteRecovery';
import {
  accumulateWorkspaceDirtyDelta, buildExplicitWorkspaceCommands, emptyWorkspaceDirtyDelta, mergeWorkspaceDirtyDelta, useWorkspacePersistence,
} from './workspacePersistence';
import {
  clearWorkspaceSyncNotice,
  getWorkspaceSyncNotices,
  WORKSPACE_STRUCTURE_READ_EVENT,
  type WorkspaceStructureReadRequest,
} from './workspaceSyncNotices';

const V2_CAPABILITIES = {
  protocolVersion: 2,
  authoritativeTurnPersistence: true,
  durableNodePrerequisite: true,
  explicitCommands: true,
  backgroundWorkspaceSync: false,
  legacySyncAccepted: false,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const calls = () => apiMocks.applyWorkspaceCommands.mock.calls;
const callsFor = (workspaceId: string) => calls().filter(([id]) => id === workspaceId);
const types = (commands: readonly WorkspaceCommand[]) => commands.map((command) => command.type);

const node = (projectId: string, nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState => ({
  nodeId, projectId, kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', ...extra,
});

/** A workspace of `treeCount` threads; every other one has a branch. */
function workspace(id: string, treeCount: number) {
  const project: Project = {
    id, name: 'Workspace', cwd: '/work', folders: [{ id: 'root', path: '/work', addedAt: 1 }],
    chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1,
    artifacts: [{ id: `${id}-ctx`, name: 'notes', filePath: 'notes.md', source: 'user', createdAt: 1, updatedAt: 1 }],
  };
  const nodes: Record<string, ChatNodeState> = {};
  for (let i = 0; i < treeCount; i++) {
    const root = `${id}-n${i}`;
    project.trees.push({ id: `${id}-t${i}`, rootNodeId: root, createdAt: 1, lastActiveAt: 1 });
    project.chatIds.push(root);
    nodes[root] = node(id, root);
    if (i % 2 === 0) {
      const branch = `${root}-b`;
      project.chatIds.push(branch);
      nodes[branch] = node(id, branch, { parentNodeId: root });
      project.edges.push({ source: root, target: branch, kind: 'branch', createdAt: 2 });
    }
  }
  project.activeTreeId = project.trees[0]?.id ?? null;
  return { project, nodes };
}

/** A hydrated store (no load in progress), as after boot. */
function useHarness(initial: { project: Project; nodes: Record<string, ChatNodeState> } | null) {
  const [projects, setProjects] = useState<Project[]>(initial ? [initial.project] : []);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initial?.project.id ?? null);
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>(initial?.nodes ?? {});
  const [hydrated, setHydrated] = useState(true);
  const [structureVersion, setStructureVersion] = useState(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const persistence = useWorkspacePersistence({
    projects, activeProjectId, nodes, structureVersion, hydrated, nodesRef,
    setProjects, setActiveProjectId, setNodes, setHydrated,
    dirtyDraftNodeIdsRef: useRef(new Set<string>()), syncPausedRef: useRef(false), windowId: 'window-a',
  });
  // The drawer's actions, wired as chatStore wires them.
  const contextActions = useContextActions({ projects, activeProjectId, setProjects, onArtifactNamed: persistence.noteArtifactNamed });
  return {
    persistence,
    contextActions,
    projects,
    nodes,
    /** A workspace made in this window. */
    add(fresh: { project: Project; nodes: Record<string, ChatNodeState> }) {
      setProjects((prev) => [...prev, fresh.project]);
      setNodes((prev) => ({ ...prev, ...fresh.nodes }));
      setStructureVersion((version) => version + 1);
    },
    change(projectId: string, update: (project: Project) => Project) {
      setProjects((prev) => prev.map((project) => (project.id === projectId ? update(project) : project)));
      setStructureVersion((version) => version + 1);
    },
  };
}

const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  apiMocks.applyWorkspaceCommands.mockReset().mockResolvedValue(undefined);
  apiMocks.fetchPersistenceCapabilities.mockReset().mockResolvedValue(V2_CAPABILITIES);
  apiMocks.fetchAllWorkspacesMeta.mockReset().mockImplementation(() => new Promise(() => {}));
  apiMocks.listBackendConnections.mockReset().mockResolvedValue([]);
  Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined });
});

afterEach(() => {
  for (const notice of getWorkspaceSyncNotices()) clearWorkspaceSyncNotice(notice.workspaceId);
  vi.useRealTimers();
});

describe('installing a remote snapshot writes nothing back', () => {
  const connection: BackendConnectionSummary = {
    id: 'remote-sync', name: 'Remote', transport: 'direct', apiUrl: 'https://remote.example/api', hasToken: true, createdAt: 1, updatedAt: 1,
  };
  const localRow = { workspace: { id: 'ws-local', name: 'Local', created_at: 1 }, nodes: [{ id: 'n-local', created_at: 1 }], trees: [], edges: [], messages: [], artifacts: [] };
  /** The remote workspace as /workspaces/all?meta=1 sends it: read threads with replies, a branch, an artifact. */
  const remoteRow = (treeName = 'Second') => ({
    workspace: { id: 'ws-r', name: 'Remote', cwd: '/srv/r', created_at: 1, active_tree_id: 't-r1' },
    trees: [
      { id: 't-r1', root_node_id: 'n-r1', created_at: 1, last_active_at: 5 },
      { id: 't-r2', root_node_id: 'n-r3', created_at: 2, last_active_at: 6, name: treeName },
    ],
    nodes: [
      { id: 'n-r1', tree_id: 't-r1', created_at: 1, title: 'Root', message_count: 4, viewed_at: 10 },
      { id: 'n-r2', tree_id: 't-r1', parent_node_id: 'n-r1', created_at: 2, message_count: 2, viewed_at: 11 },
      { id: 'n-r3', tree_id: 't-r2', created_at: 3, message_count: 6, viewed_at: 12 },
    ],
    edges: [{ id: 'branch-n-r1-n-r2', source_node_id: 'n-r1', target_node_id: 'n-r2', kind: 'branch', created_at: 2 }],
    messages: [],
    contexts: [{ id: 'ctx-r', name: 'spec', file_path: 'spec.md', source: 'user', created_at: 1, updated_at: 1 }],
  });
  const remoteId = backendEntityId(connection.id, 'ws-r');

  /** The real chatStore mount: only the hook flips hydrated. */
  function useBootHarness() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
    const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({});
    const [hydrated, setHydrated] = useState(false);
    const [structureVersion, setStructureVersion] = useState(0);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    useWorkspacePersistence({
      projects, activeProjectId, nodes, structureVersion, hydrated, nodesRef,
      setProjects, setActiveProjectId, setNodes, setHydrated, windowId: 'window-a',
    });
    return {
      hydrated, projects, nodes,
      change(projectId: string, update: (project: Project) => Project) {
        setProjects((prev) => prev.map((project) => (project.id === projectId ? update(project) : project)));
        setStructureVersion((version) => version + 1);
      },
      editNode(nodeId: string, patch: Partial<ChatNodeState>) {
        setNodes((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId], ...patch } }));
        nodesRef.current = { ...nodesRef.current, [nodeId]: { ...nodesRef.current[nodeId], ...patch } };
        setStructureVersion((version) => version + 1);
      },
    };
  }

  beforeEach(() => {
    markBackendConnectionReady(connection.id);
    apiMocks.listBackendConnections.mockResolvedValue([connection]);
  });

  it('when it lands after local hydration (boot), and an edit afterwards is one small batch', async () => {
    const remote = deferred<unknown[]>();
    apiMocks.fetchAllWorkspacesMeta.mockImplementation((id?: string) => (id === connection.id ? remote.promise : Promise.resolve([localRow])));
    const { result } = renderHook(() => useBootHarness());
    await settle(10);
    expect(result.current.hydrated).toBe(true);
    remote.resolve([remoteRow()]);
    await settle(10);
    expect(result.current.projects.map((project) => project.id)).toEqual(['ws-local', remoteId]);

    await settle(6_000);
    expect(calls()).toEqual([]);

    act(() => result.current.change(remoteId, (project) => ({ ...project, name: 'Renamed' })));
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    expect(types(calls()[0][2])).toEqual(['workspace.upsert']);
  });

  it('when it is read again after an outage, keeping only the edit made meanwhile', async () => {
    let online = true;
    let row = remoteRow();
    apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (id?: string) => {
      if (id !== connection.id) return [localRow];
      if (!online) throw new Error('disconnected');
      return [row];
    });
    apiMocks.applyWorkspaceCommands.mockImplementation(async (id: string) => {
      if (id === remoteId && !online) throw new Error('Remote connection is unavailable');
    });
    const { result } = renderHook(() => useBootHarness());
    await settle(10);
    expect(result.current.projects.map((project) => project.id)).toEqual(['ws-local', remoteId]);
    await settle(4_000);
    expect(calls()).toEqual([]);

    online = false;
    await act(async () => { markBackendConnectionUnavailable(connection.id); });
    // Offline, the user pins a thread: its write fails and waits.
    const pinned = backendEntityId(connection.id, 'n-r2');
    act(() => result.current.editNode(pinned, { pinnedAt: 99 }));
    await settle(2_000);
    expect(callsFor(remoteId)).toHaveLength(1);

    // Back online, with a tree another device renamed meanwhile.
    online = true;
    row = remoteRow('Renamed elsewhere');
    await act(async () => { retryRemoteWorkspace(connection.id); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.projects.find((project) => project.id === remoteId)?.trees[1].name).toBe('Renamed elsewhere');
    await settle(10_000);
    const sent = callsFor(remoteId).slice(1).map(([, , commands]) => commands);
    expect(sent).toHaveLength(1);
    // The pin goes; the snapshot's trees, edges and workspace row do not go back.
    expect(sent[0].map((command) => [command.type, command.payload.id])).toEqual([['node.upsert', pinned], ['node.patch', pinned]]);
    expect(sent[0][1].payload.pinned_at).toBe(99);
  });

  it('when a connection is edited and its workspaces load again', async () => {
    apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (id?: string) => (id === connection.id ? [remoteRow()] : [localRow]));
    const { result } = renderHook(() => useBootHarness());
    await settle(10);
    expect(result.current.projects.map((project) => project.id)).toEqual(['ws-local', remoteId]);
    await settle(4_000);
    const edited = { ...connection, updatedAt: 2 };
    apiMocks.listBackendConnections.mockResolvedValue([edited]);
    setKnownBackendConnections([edited]);
    await act(async () => { window.dispatchEvent(new Event('michi:backend-connections-changed')); });
    markBackendConnectionReady(connection.id);
    await settle(10);
    expect(result.current.projects.map((project) => project.id)).toEqual(['ws-local', remoteId]);
    await settle(6_000);
    expect(calls()).toEqual([]);
  });
});

describe('ordinary edits stay small', () => {
  it('takes fresh but equal trees, edges, artifacts and folders as unchanged', () => {
    const { project, nodes } = workspace('ws-1', 6);
    const fresh: Project = {
      ...project,
      folders: project.folders!.map((folder) => ({ ...folder })),
      trees: project.trees.map((tree) => ({ ...tree })),
      edges: project.edges.map((edge) => ({ ...edge })),
      artifacts: project.artifacts!.map((artifact) => ({ ...artifact })),
    };
    expect(accumulateWorkspaceDirtyDelta(project, fresh, nodes, nodes, emptyWorkspaceDirtyDelta())).toEqual(emptyWorkspaceDirtyDelta());
    const renamed = { ...fresh, trees: fresh.trees.map((tree, i) => (i === 2 ? { ...tree, name: 'Renamed' } : tree)) };
    const delta = accumulateWorkspaceDirtyDelta(project, renamed, nodes, nodes, emptyWorkspaceDirtyDelta());
    expect([...delta.treeUpsertIds]).toEqual(['ws-1-t2']);
    expect(delta.workspaceChanged).toBe(false);
  });

  it('writes nothing when a snapshot replaces every tree, edge and artifact with an equal copy', async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 6)));
    await settle();
    act(() => result.current.change('ws-1', (project) => ({
      ...project,
      folders: project.folders!.map((folder) => ({ ...folder })),
      trees: project.trees.map((tree) => ({ ...tree })),
      edges: project.edges.map((edge) => ({ ...edge })),
      artifacts: project.artifacts!.map((artifact) => ({ ...artifact })),
    })));
    await settle(4_000);
    expect(calls()).toEqual([]);
  });

  it('saves a workspace pin that changes nothing else', async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 2)));
    await settle();
    act(() => result.current.change('ws-1', (project) => ({ ...project, pinnedAt: 5 })));
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    expect(types(calls()[0][2])).toEqual(['workspace.upsert']);
    expect(calls()[0][2][0].payload.pinned_at).toBe(5);
  });

  it('sends only what changed while a whole-workspace write was in flight, then nothing', async () => {
    const first = deferred<void>();
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(() => first.promise);
    const { result } = renderHook(() => useHarness(null));
    await settle();
    act(() => result.current.add(workspace('ws-new', 30)));
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    expect(types(calls()[0][2]).filter((type) => type === 'tree.upsert')).toHaveLength(30);

    // A reply lands in one thread while the write is in flight (touch-tree).
    act(() => result.current.change('ws-new', (project) => ({
      ...project, trees: project.trees.map((tree) => (tree.id === 'ws-new-t3' ? { ...tree, lastActiveAt: 99 } : tree)),
    })));
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    await act(async () => { first.resolve(); await vi.advanceTimersByTimeAsync(0); });
    expect(calls()).toHaveLength(2);
    expect(calls()[1][2].map((command) => [command.type, command.payload.id])).toEqual([['tree.upsert', 'ws-new-t3']]);
    await settle(10_000);
    expect(calls()).toHaveLength(2);
  });
});

describe('artifact deletes and upserts: the later one wins', () => {
  const ctx = 'ws-1-ctx';
  const deltaOf = (kind: 'upsert' | 'delete', id: string) => {
    const delta = emptyWorkspaceDirtyDelta();
    (kind === 'upsert' ? delta.contextUpsertIds : delta.contextDeleteIds).add(id);
    return delta;
  };
  const contextCommands = (project: Project, nodes: Record<string, ChatNodeState>, delta: ReturnType<typeof emptyWorkspaceDirtyDelta>) =>
    buildExplicitWorkspaceCommands(project, nodes, delta, new Map()).commands.map((command) => [command.type, command.payload.id]);

  it('a pending upsert and a newer delete: the delete is sent', () => {
    const { project, nodes } = workspace('ws-1', 1);
    const merged = mergeWorkspaceDirtyDelta(deltaOf('upsert', ctx), deltaOf('delete', ctx));
    expect([...merged.contextUpsertIds]).toEqual([]);
    expect([...merged.contextDeleteIds]).toEqual([ctx]);
    expect(contextCommands({ ...project, artifacts: [] }, nodes, merged)).toEqual([['context.delete', ctx]]);
  });

  it('a pending delete and a newer upsert (created again): the upsert is sent', () => {
    const { project, nodes } = workspace('ws-1', 1);
    const merged = mergeWorkspaceDirtyDelta(deltaOf('delete', ctx), deltaOf('upsert', ctx));
    expect([...merged.contextUpsertIds]).toEqual([ctx]);
    expect([...merged.contextDeleteIds]).toEqual([]);
    expect(contextCommands(project, nodes, merged)).toEqual([['context.upsert', ctx]]);
  });

  it('an agent deletion arriving while an upsert of that artifact is in flight is sent once it lands', async () => {
    const inFlight = deferred<void>();
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(() => inFlight.promise);
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    // The user pins the artifact: its upsert goes and is not answered yet.
    act(() => result.current.change('ws-1', (project) => ({
      ...project, artifacts: project.artifacts!.map((artifact) => ({ ...artifact, pinnedAt: 5 })),
    })));
    await settle(2_000);
    expect(calls().map(([, , commands]) => commands.map((command) => [command.type, command.payload.id]))).toEqual([[['context.upsert', ctx]]]);
    // artifact_deleted: the backend removed it, and the window drops it (delete-context).
    act(() => result.current.change('ws-1', (project) => ({ ...project, artifacts: [] })));
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    await act(async () => { inFlight.resolve(); await vi.advanceTimersByTimeAsync(0); });
    await settle(2_000);
    // The upsert that landed after the deletion is undone, and nothing else follows.
    expect(calls().map(([, , commands]) => commands.map((command) => [command.type, command.payload.id]))).toEqual([
      [['context.upsert', ctx]],
      [['context.delete', ctx]],
    ]);
    await settle(10_000);
    expect(calls()).toHaveLength(2);
    expect(result.current.projects[0].artifacts).toEqual([]);
  });
});

describe('an artifact the backend answers gone (deleted where this window did not hear)', () => {
  const ctx = 'ws-1-ctx';
  const plan = { id: 'ws-1-plan', name: 'plan', filePath: 'plan.md', source: 'user' as const, createdAt: 1, updatedAt: 1 };
  const sent = () => calls().map(([, , commands]) => commands.map((command) => [command.type, command.payload.id]));
  const artifactIds = (projects: Project[]) => (projects[0].artifacts ?? []).map((artifact) => artifact.id);
  const pin = (project: Project): Project => ({
    ...project, artifacts: project.artifacts!.map((artifact) => (artifact.id === ctx ? { ...artifact, pinnedAt: 5 } : artifact)),
  });

  it('is dropped from the store, and neither a delete nor another upsert of it follows', async () => {
    const { project, nodes } = workspace('ws-1', 1);
    // A gone id the batch did not upsert (plan) is not this window's to drop.
    apiMocks.applyWorkspaceCommands.mockResolvedValueOnce({ goneContextIds: [ctx, plan.id] });
    const { result } = renderHook(() => useHarness({ project: { ...project, artifacts: [...project.artifacts!, plan] }, nodes }));
    await settle();
    act(() => result.current.change('ws-1', pin));
    await settle(2_000);
    expect(sent()).toEqual([[['context.upsert', ctx]]]);
    expect(artifactIds(result.current.projects)).toEqual([plan.id]);
    await settle(10_000);
    expect(calls()).toHaveLength(1);
    // Later edits go as usual.
    act(() => result.current.change('ws-1', (current) => ({
      ...current, artifacts: current.artifacts!.map((artifact) => ({ ...artifact, pinnedAt: 7 })),
    })));
    await settle(2_000);
    expect(sent()).toEqual([[['context.upsert', ctx]], [['context.upsert', plan.id]]]);
  });

  it('changed again while its upsert was in flight, it is still dropped and not sent again', async () => {
    const inFlight = deferred<{ goneContextIds: string[] }>();
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(() => inFlight.promise);
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    act(() => result.current.change('ws-1', pin));
    await settle(2_000);
    // Renamed here while the pin is unanswered: a newer upsert waits behind it.
    act(() => result.current.change('ws-1', (project) => ({
      ...project, artifacts: project.artifacts!.map((artifact) => ({ ...artifact, name: 'renamed', updatedAt: 9 })),
    })));
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    await act(async () => { inFlight.resolve({ goneContextIds: [ctx] }); await vi.advanceTimersByTimeAsync(0); });
    await settle(10_000);
    expect(sent()).toEqual([[['context.upsert', ctx]]]);
    expect(result.current.projects[0].artifacts).toEqual([]);
  });

  it('removed here while its upsert was in flight, the delete is not sent once that upsert answers gone', async () => {
    const inFlight = deferred<{ goneContextIds: string[] }>();
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(() => inFlight.promise);
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    act(() => result.current.change('ws-1', pin));
    await settle(2_000);
    // artifact_deleted arrives: the backend deleted it before the pin landed.
    act(() => result.current.change('ws-1', (project) => ({ ...project, artifacts: [] })));
    await settle(2_000);
    await act(async () => { inFlight.resolve({ goneContextIds: [ctx] }); await vi.advanceTimersByTimeAsync(0); });
    await settle(10_000);
    // An older backend applied the pin and needed the delete after it (see above); this one skipped it.
    expect(sent()).toEqual([[['context.upsert', ctx]]]);
    expect(result.current.projects[0].artifacts).toEqual([]);
  });

  /** Pins the artifact, then removes it here while that pin is in flight, and answers the pin gone before the next flush. */
  const removedBeforeGoneAnswer = async () => {
    const inFlight = deferred<{ goneContextIds: string[] }>();
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(() => inFlight.promise);
    const harness = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    act(() => harness.result.current.change('ws-1', pin));
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    // artifact_deleted arrives: the scan notes a delete, which no flush has taken yet.
    act(() => harness.result.current.change('ws-1', (project) => ({ ...project, artifacts: [] })));
    await act(async () => { inFlight.resolve({ goneContextIds: [ctx] }); await vi.advanceTimersByTimeAsync(0); });
    return harness;
  };

  it('removed here before its upsert was answered gone, the next flush sends no delete of it', async () => {
    const { result } = await removedBeforeGoneAnswer();
    await settle(10_000);
    expect(sent()).toEqual([[['context.upsert', ctx]]]);
    expect(result.current.projects[0].artifacts).toEqual([]);
  });

  it('removed here before its upsert was answered gone, a workspace mutation sends no delete of it', async () => {
    const { result } = await removedBeforeGoneAnswer();
    const mutation = vi.fn(async () => {});
    await act(async () => { await result.current.persistence.runWorkspaceMutation('ws-1', mutation); });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual([[['context.upsert', ctx]]]);
  });

  it("brought back by a replayed artifact_saved, it is answered gone again and dropped, never deleted", async () => {
    apiMocks.applyWorkspaceCommands
      .mockResolvedValueOnce({ goneContextIds: [ctx] })
      .mockResolvedValueOnce({ goneContextIds: [ctx] });
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    act(() => result.current.change('ws-1', pin));
    await settle(2_000);
    expect(result.current.projects[0].artifacts).toEqual([]);
    // What chatStore's onArtifactSaved does with a replay of the save that made it.
    act(() => result.current.change('ws-1', (project) => reduceProject(project, {
      type: 'upsert-context', projectId: 'ws-1',
      context: { id: ctx, name: 'notes', filePath: 'notes.md', size: 3, type: 'doc', kind: 'embedded', source: 'agent' },
    })));
    expect(artifactIds(result.current.projects)).toEqual([ctx]);
    await settle(2_000);
    await settle(10_000);
    expect(sent()).toEqual([[['context.upsert', ctx]], [['context.upsert', ctx]]]);
    expect(result.current.projects[0].artifacts).toEqual([]);
  });

  it('an older backend answers no gone ids: the artifact stays and is written as before', async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    act(() => result.current.change('ws-1', pin));
    await settle(2_000);
    act(() => result.current.change('ws-1', (project) => ({
      ...project, artifacts: project.artifacts!.map((artifact) => ({ ...artifact, pinnedAt: 6 })),
    })));
    await settle(2_000);
    await settle(10_000);
    expect(sent()).toEqual([[['context.upsert', ctx]], [['context.upsert', ctx]]]);
    expect(artifactIds(result.current.projects)).toEqual([ctx]);
  });
});

describe('a stale write the backend answers name-taken (another artifact holds the name there)', () => {
  const ctx = 'ws-1-ctx';
  const sent = () => calls().map(([, , commands]) => commands.map((command) => [command.type, command.payload.id, command.payload.name]));
  const pin = (project: Project): Project => ({
    ...project, artifacts: project.artifacts!.map((artifact) => (artifact.id === ctx ? { ...artifact, pinnedAt: 5 } : artifact)),
  });

  it('keeps the artifact, sends that write no more, and later writes go as usual', async () => {
    apiMocks.applyWorkspaceCommands.mockResolvedValueOnce({ goneContextIds: [], nameTakenContextIds: [ctx] });
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    act(() => result.current.change('ws-1', pin));
    await settle(2_000);
    await settle(10_000);
    expect(sent()).toEqual([[['context.upsert', ctx, 'notes']]]);
    // Alive: not dropped as a gone one is.
    expect(result.current.projects[0].artifacts).toEqual([expect.objectContaining({ id: ctx, name: 'notes', pinnedAt: 5 })]);
    act(() => result.current.change('ws-1', (project) => ({ ...project, name: 'Renamed' })));
    await settle(2_000);
    expect(sent()).toEqual([[['context.upsert', ctx, 'notes']], [['workspace.upsert', 'ws-1', 'Renamed']]]);
  });

  it('renamed again while that write was in flight, the rename still goes', async () => {
    const inFlight = deferred<{ goneContextIds: string[]; nameTakenContextIds: string[] }>();
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(() => inFlight.promise);
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    act(() => result.current.change('ws-1', pin));
    await settle(2_000);
    act(() => result.current.change('ws-1', (project) => ({
      ...project, artifacts: project.artifacts!.map((artifact) => ({ ...artifact, name: 'free', updatedAt: 9 })),
    })));
    await settle(2_000);
    await act(async () => { inFlight.resolve({ goneContextIds: [], nameTakenContextIds: [ctx] }); await vi.advanceTimersByTimeAsync(0); });
    await settle(2_000);
    await settle(10_000);
    expect(sent()).toEqual([[['context.upsert', ctx, 'notes']], [['context.upsert', ctx, 'free']]]);
    expect(result.current.projects[0].artifacts).toEqual([expect.objectContaining({ id: ctx, name: 'free' })]);
  });
});

describe("this window's own new artifact or rename answered name-taken (the name was taken where it did not hear)", () => {
  const ctx = 'ws-1-ctx';
  const sent = () => calls().map(([, , commands]) => commands
    .filter((command) => command.type === 'context.upsert')
    .map((command) => [command.payload.id, command.payload.name]));
  const nameTaken = (id: string) => ({ goneContextIds: [], nameTakenContextIds: [id] });
  /** What a backend answers a batch whose artifact writes all hit a name another artifact holds there. */
  const allNameTaken = async (_workspaceId: string, _operationId: string, commands: readonly WorkspaceCommand[]) => ({
    goneContextIds: [],
    nameTakenContextIds: commands.filter((command) => command.type === 'context.upsert').map((command) => String(command.payload.id)),
  });
  const artifactNames = (projects: Project[]) => (projects[0].artifacts ?? []).map((artifact) => artifact.name);

  it('a new one takes the next free name and is written again; once written, nothing more goes', async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(allNameTaken);
    act(() => result.current.contextActions.createContext('draft', 'draft.md'));
    const id = result.current.projects[0].artifacts!.find((artifact) => artifact.name === 'draft')!.id;
    await settle(2_000);
    await settle(2_000);
    await settle(10_000);
    expect(sent()).toEqual([[[id, 'draft']], [[id, 'draft-2']]]);
    expect(artifactNames(result.current.projects)).toEqual(['notes', 'draft-2']);
  });

  it('stops after three free names, leaving it as it is, and skips a name another artifact here holds', async () => {
    const { project, nodes } = workspace('ws-1', 1);
    const held = { id: 'ws-1-held', name: 'draft-3', filePath: 'held.md', source: 'user' as const, createdAt: 1, updatedAt: 1 };
    const { result } = renderHook(() => useHarness({ project: { ...project, artifacts: [...project.artifacts!, held] }, nodes }));
    await settle();
    apiMocks.applyWorkspaceCommands.mockImplementation(allNameTaken);
    act(() => result.current.contextActions.createContext('draft', 'draft.md'));
    const id = result.current.projects[0].artifacts!.find((artifact) => artifact.name === 'draft')!.id;
    for (let i = 0; i < 6; i += 1) await settle(2_000);
    await settle(30_000);
    expect(sent()).toEqual([[[id, 'draft']], [[id, 'draft-2']], [[id, 'draft-4']], [[id, 'draft-5']]]);
    expect(artifactNames(result.current.projects)).toEqual(['notes', 'draft-3', 'draft-5']);
  });

  it('a rename here takes the next free name after the one given', async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    apiMocks.applyWorkspaceCommands.mockResolvedValueOnce(nameTaken(ctx));
    act(() => result.current.contextActions.updateContext(ctx, { name: 'plan' }));
    await settle(2_000);
    await settle(2_000);
    await settle(10_000);
    expect(sent()).toEqual([[[ctx, 'plan']], [[ctx, 'plan-2']]]);
    expect(artifactNames(result.current.projects)).toEqual(['plan-2']);
  });

  it('a write of a name the backend already holds for it (a pin, or one after that name was written) is never renamed', async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    // Written under the name given here: confirmed.
    act(() => result.current.contextActions.updateContext(ctx, { name: 'plan' }));
    await settle(2_000);
    // Renamed elsewhere since and "plan" taken there: this window's pin is stale.
    apiMocks.applyWorkspaceCommands.mockResolvedValueOnce(nameTaken(ctx));
    act(() => result.current.contextActions.pinContext(ctx));
    await settle(2_000);
    await settle(10_000);
    expect(sent()).toEqual([[[ctx, 'plan']], [[ctx, 'plan']]]);
    expect(artifactNames(result.current.projects)).toEqual(['plan']);
  });
});

describe("an artifact a background read kept beside one of the backend's under the same name: the window asks the backend once", () => {
  const ctx = 'ws-1-ctx';
  const sent = () => calls().map(([, , commands]) => commands.map((command) => [command.type, command.payload.id]));
  const ids = (projects: Project[]) => (projects[0].artifacts ?? []).map((artifact) => artifact.id);
  const answers = () => apiMocks.fetchPersistenceCapabilities.mockResolvedValue({ ...V2_CAPABILITIES, artifactWriteAnswers: 'v1' });
  /** What chatStore does with a merge's artifactProbes, once the capability is known. */
  const probe = async (result: { current: ReturnType<typeof useHarness> }, contextIds: string[]) => {
    act(() => result.current.persistence.probeArtifacts('ws-1', contextIds));
    await settle();
  };

  it("answered name-taken, it is not the backend's: it leaves the store, and nothing is deleted, renamed or asked again", async () => {
    answers();
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    apiMocks.applyWorkspaceCommands.mockResolvedValueOnce({ goneContextIds: [], nameTakenContextIds: [ctx] });
    await probe(result, [ctx]);
    await settle(2_000);
    expect(sent()).toEqual([[['context.upsert', ctx]]]);
    expect(ids(result.current.projects)).toEqual([]);
    await settle(10_000);
    await probe(result, [ctx]);
    await settle(10_000);
    expect(calls()).toHaveLength(1);
  });

  it('answered gone, it leaves the store with no delete sent', async () => {
    answers();
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    apiMocks.applyWorkspaceCommands.mockResolvedValueOnce({ goneContextIds: [ctx], nameTakenContextIds: [] });
    await probe(result, [ctx]);
    await settle(2_000);
    await settle(10_000);
    expect(sent()).toEqual([[['context.upsert', ctx]]]);
    expect(ids(result.current.projects)).toEqual([]);
  });

  it('written, it was live: it stays and is never asked about again', async () => {
    answers();
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    await probe(result, [ctx]);
    await settle(2_000);
    await probe(result, [ctx]);
    await settle(10_000);
    expect(sent()).toEqual([[['context.upsert', ctx]]]);
    expect(ids(result.current.projects)).toEqual([ctx]);
  });

  it('one dropped as not the backend\'s that comes back is an artifact like any other again: its delete goes', async () => {
    answers();
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    const copy = result.current.projects[0].artifacts![0];
    apiMocks.applyWorkspaceCommands.mockResolvedValueOnce({ goneContextIds: [], nameTakenContextIds: [ctx] });
    await probe(result, [ctx]);
    await settle(2_000);
    expect(ids(result.current.projects)).toEqual([]);
    // A later read brings it back (it is the backend's after all), then the user deletes it.
    act(() => result.current.change('ws-1', (project) => ({ ...project, artifacts: [copy] })));
    await settle(2_000);
    act(() => result.current.contextActions.deleteContext(ctx));
    await settle(2_000);
    expect(sent()).toEqual([[['context.upsert', ctx]], [['context.upsert', ctx]], [['context.delete', ctx]]]);
  });

  it('never asked against a backend that does not advertise artifactWriteAnswers (its UNIQUE failure is a 500 retried forever)', async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    await probe(result, [ctx]);
    await settle(10_000);
    expect(calls()).toEqual([]);
    expect(apiMocks.fetchPersistenceCapabilities).toHaveBeenCalled();
  });

  it("never asked about this window's own unsaved write, which keeps its own handling (B: a free name; a pin: kept)", async () => {
    answers();
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    // A pin not sent yet, and a new artifact made here.
    act(() => result.current.contextActions.pinContext(ctx));
    act(() => result.current.contextActions.createContext('draft', 'draft.md'));
    const draft = result.current.projects[0].artifacts!.find((artifact) => artifact.name === 'draft')!.id;
    await probe(result, [ctx, draft]);
    apiMocks.applyWorkspaceCommands.mockResolvedValueOnce({ goneContextIds: [], nameTakenContextIds: [ctx, draft] });
    await settle(2_000);
    await settle(2_000);
    await settle(10_000);
    // Neither was dropped: the pin is kept as a stale write, the new one takes a free name.
    expect((result.current.projects[0].artifacts ?? []).map((artifact) => [artifact.id, artifact.name])).toEqual([[ctx, 'notes'], [draft, 'draft-2']]);
  });
});

describe('what a backend advertised, once another one may answer there (review 4, finding 3)', () => {
  const ctx = 'ws-1-ctx';
  const ANSWERS = { ...V2_CAPABILITIES, artifactWriteAnswers: 'v1' };
  const sent = () => calls().map(([, , commands]) => commands.map((command) => [command.type, command.payload.id]));
  const ids = (projects: Project[]) => (projects[0].artifacts ?? []).map((artifact) => artifact.id);
  const probe = async (probeArtifacts: (projectId: string, contextIds: string[]) => void, projectId: string, contextIds: string[]) => {
    act(() => probeArtifacts(projectId, contextIds));
    await settle();
  };

  it("back after a disconnect, this machine's backend is asked again whether it answers skipped writes, before the next probe", async () => {
    apiMocks.fetchPersistenceCapabilities.mockResolvedValue(ANSWERS);
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    // Replaced meanwhile by an older build (a dev backend of another checkout, a reverted install).
    apiMocks.fetchPersistenceCapabilities.mockResolvedValue(V2_CAPABILITIES);
    act(() => result.current.persistence.noteConnectionRecovered('local'));
    await probe(result.current.persistence.probeArtifacts, 'ws-1', [ctx]);
    await settle(10_000);
    // Its UNIQUE failure would be a 500 retried forever: nothing is sent.
    expect(calls()).toEqual([]);
    expect(apiMocks.fetchPersistenceCapabilities).toHaveBeenLastCalledWith('local', { configureTransport: false });
  });

  it('and its batch size with the next write, as a remote is asked (batchLimitFor)', async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    apiMocks.fetchPersistenceCapabilities.mockResolvedValue({ ...V2_CAPABILITIES, maxCommandsPerBatch: 1 });
    act(() => result.current.persistence.noteConnectionRecovered('local'));
    act(() => result.current.change('ws-1', (project) => ({ ...project, name: 'Renamed' })));
    await settle(2_000);
    const artifact = (id: string) => ({ id, name: id, filePath: `${id}.md`, source: 'user' as const, createdAt: 2, updatedAt: 2 });
    act(() => result.current.change('ws-1', (project) => ({ ...project, artifacts: [...(project.artifacts ?? []), artifact('a'), artifact('b')] })));
    await settle(2_000);
    expect(calls().map(([, , commands]) => commands.length)).toEqual([1, 1, 1]);
  });

  it('a connection edited while none of its workspaces is shown forgets what it advertised', async () => {
    const connection: BackendConnectionSummary = {
      id: 'remote-cap', name: 'Remote', transport: 'direct', apiUrl: 'https://remote-cap.example/api', hasToken: true, createdAt: 1, updatedAt: 1,
    };
    const localRow = { workspace: { id: 'ws-local', name: 'Local', created_at: 1 }, nodes: [{ id: 'n-local', created_at: 1 }], trees: [], edges: [], messages: [], artifacts: [] };
    const remoteRow = (workspaceId: string) => ({
      workspace: { id: workspaceId, name: 'Remote', created_at: 1, active_tree_id: `${workspaceId}-t` },
      trees: [{ id: `${workspaceId}-t`, root_node_id: `${workspaceId}-n`, created_at: 1, last_active_at: 1 }],
      nodes: [{ id: `${workspaceId}-n`, tree_id: `${workspaceId}-t`, created_at: 1, message_count: 0 }],
      edges: [],
      messages: [],
      contexts: [{ id: `${workspaceId}-ctx`, name: 'notes', file_path: 'notes.md', source: 'user', created_at: 1, updated_at: 1 }],
    });
    /** The real chatStore mount (only the hook flips hydrated), able to drop a workspace. */
    function useRemoteHarness() {
      const [projects, setProjects] = useState<Project[]>([]);
      const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
      const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({});
      const [hydrated, setHydrated] = useState(false);
      const [structureVersion, setStructureVersion] = useState(0);
      const nodesRef = useRef(nodes);
      nodesRef.current = nodes;
      const persistence = useWorkspacePersistence({
        projects, activeProjectId, nodes, structureVersion, hydrated, nodesRef,
        setProjects, setActiveProjectId, setNodes, setHydrated, windowId: 'window-a',
      });
      return {
        persistence,
        projects,
        drop(projectId: string) {
          setProjects((prev) => prev.filter((project) => project.id !== projectId));
          setStructureVersion((version) => version + 1);
        },
      };
    }
    let machine: 'new' | 'old' = 'new';
    let rows = [remoteRow('ws-r')];
    markBackendConnectionReady(connection.id);
    apiMocks.listBackendConnections.mockResolvedValue([connection]);
    apiMocks.fetchAllWorkspacesMeta.mockImplementation(async (id?: string) => (id === connection.id ? rows : [localRow]));
    apiMocks.fetchPersistenceCapabilities.mockImplementation(async (id?: string) => (id === connection.id && machine === 'new' ? ANSWERS : V2_CAPABILITIES));
    const { result } = renderHook(() => useRemoteHarness());
    await settle(10);
    const artifactOf = (projectId: string) => result.current.projects.find((project) => project.id === projectId)!.artifacts![0].id;
    const first = backendEntityId(connection.id, 'ws-r');
    await settle(2_000);
    // It answers skipped writes: a probe there is sent.
    await probe(result.current.persistence.probeArtifacts, first, [artifactOf(first)]);
    await settle(2_000);
    expect(callsFor(first)).toHaveLength(1);
    // Its workspace leaves this window, then the connection is pointed at an older machine.
    act(() => result.current.drop(first));
    await settle(10);
    machine = 'old';
    rows = [remoteRow('ws-r2')];
    const edited = { ...connection, updatedAt: 2 };
    apiMocks.listBackendConnections.mockResolvedValue([edited]);
    setKnownBackendConnections([edited]);
    await act(async () => { window.dispatchEvent(new Event('michi:backend-connections-changed')); });
    markBackendConnectionReady(connection.id);
    await settle(10);
    const second = backendEntityId(connection.id, 'ws-r2');
    expect(result.current.projects.map((project) => project.id)).toContain(second);
    await settle(2_000);
    await probe(result.current.persistence.probeArtifacts, second, [artifactOf(second)]);
    await settle(10_000);
    expect(callsFor(second)).toEqual([]);
  });

  describe('a probe whose chunk failed: it is only an optimisation, so it never holds up the workspace', () => {
    const rename = (result: { current: ReturnType<typeof useHarness> }) =>
      act(() => result.current.change('ws-1', (project) => ({ ...project, name: 'Renamed' })));
    const withProbe = [['workspace.upsert', 'ws-1'], ['context.upsert', ctx]];

    it('answered a server error twice (an older backend\'s UNIQUE failure), it is dropped and the writes beside it go', async () => {
      apiMocks.fetchPersistenceCapabilities.mockResolvedValue(ANSWERS);
      const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
      await settle();
      const unique = new WorkspaceCommandsError('UNIQUE constraint failed: contexts.workspace_id, contexts.name', 500);
      apiMocks.applyWorkspaceCommands.mockRejectedValueOnce(unique).mockRejectedValueOnce(unique);
      apiMocks.fetchPersistenceCapabilities.mockResolvedValue(V2_CAPABILITIES);
      await probe(result.current.persistence.probeArtifacts, 'ws-1', [ctx]);
      rename(result);
      await settle(2_000);
      await settle(10_000);
      // The first error is retried as any; after the second the rest goes at once, without it.
      expect(sent()).toEqual([withProbe, withProbe, [['workspace.upsert', 'ws-1']]]);
      expect(getWorkspaceSyncNotices()).toEqual([]);
      // Kept as this window holds it, asked no more; the backend's capabilities are read again.
      expect(ids(result.current.projects)).toEqual([ctx]);
      expect(apiMocks.fetchPersistenceCapabilities).toHaveBeenLastCalledWith('local', { configureTransport: false });
      await probe(result.current.persistence.probeArtifacts, 'ws-1', [ctx]);
      await settle(10_000);
      expect(calls()).toHaveLength(3);
    });

    it('refused (a 4xx), it is dropped at once and the rest goes, not a refusal of the workspace', async () => {
      apiMocks.fetchPersistenceCapabilities.mockResolvedValue(ANSWERS);
      const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
      await settle();
      apiMocks.applyWorkspaceCommands.mockRejectedValueOnce(new WorkspaceCommandsError('bad artifact', 400, 'invalid_command'));
      await probe(result.current.persistence.probeArtifacts, 'ws-1', [ctx]);
      rename(result);
      await settle(2_000);
      await settle(10_000);
      expect(sent()).toEqual([withProbe, [['workspace.upsert', 'ws-1']]]);
      expect(getWorkspaceSyncNotices()).toEqual([]);
      expect(ids(result.current.projects)).toEqual([ctx]);
    });

    it('a write of the user\'s riding with it (changed since it was asked about) is retried as any write, and so is a write with no probe', async () => {
      apiMocks.fetchPersistenceCapabilities.mockResolvedValue(ANSWERS);
      const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
      await settle();
      const boom = new WorkspaceCommandsError('boom', 500);
      apiMocks.applyWorkspaceCommands.mockRejectedValueOnce(boom).mockRejectedValueOnce(boom).mockRejectedValueOnce(boom);
      await probe(result.current.persistence.probeArtifacts, 'ws-1', [ctx]);
      // The user pins it before the flush: that pin is a write of its own.
      act(() => result.current.contextActions.pinContext(ctx));
      await settle(2_000);
      await settle(30_000);
      expect(sent()).toEqual([[['context.upsert', ctx]], [['context.upsert', ctx]], [['context.upsert', ctx]], [['context.upsert', ctx]]]);
      expect(result.current.projects[0].artifacts?.[0].pinnedAt).toBeTruthy();
      // No probe at all: retried with the same backoff, whatever the error.
      apiMocks.applyWorkspaceCommands.mockClear();
      apiMocks.applyWorkspaceCommands.mockRejectedValueOnce(boom).mockRejectedValueOnce(boom).mockRejectedValueOnce(boom);
      rename(result);
      await settle(2_000);
      await settle(30_000);
      expect(sent()).toEqual([[['workspace.upsert', 'ws-1']], [['workspace.upsert', 'ws-1']], [['workspace.upsert', 'ws-1']], [['workspace.upsert', 'ws-1']]]);
      // And a refused one still holds the workspace until the user acts.
      apiMocks.applyWorkspaceCommands.mockClear();
      apiMocks.applyWorkspaceCommands.mockRejectedValueOnce(new WorkspaceCommandsError('refused', 400, 'invalid_command'));
      act(() => result.current.change('ws-1', (project) => ({ ...project, name: 'Again' })));
      await settle(2_000);
      await settle(10_000);
      expect(calls()).toHaveLength(1);
      expect(getWorkspaceSyncNotices().map((notice) => notice.kind)).toEqual(['rejected']);
    });
  });
});

describe('an artifact a replay reports under the name of another one here', () => {
  const ctx = 'ws-1-ctx';

  it("a replayed artifact_saved of a deleted artifact under a live one's name sends nothing, least of all a delete of it", async () => {
    const { result } = renderHook(() => useHarness(workspace('ws-1', 1)));
    await settle();
    // What chatStore's onArtifactSaved does with a reconnect's replay of a save
    // of "notes" made before that artifact was deleted and this one took the name.
    act(() => result.current.change('ws-1', (project) => reduceProject(project, {
      type: 'upsert-context', projectId: 'ws-1',
      context: { id: 'ctx-deleted', name: 'notes', filePath: '.contexts/notes.md', size: 3, type: 'doc', kind: 'embedded', source: 'agent' },
    })));
    await settle(2_000);
    await settle(10_000);
    expect(calls()).toEqual([]);
    expect(result.current.projects[0].artifacts).toEqual([expect.objectContaining({ id: ctx, name: 'notes', filePath: 'notes.md' })]);
  });
});

describe('batches larger than the backend takes', () => {
  it('go in dependency-ordered chunks; a failed chunk leaves only the rest to send', async () => {
    apiMocks.applyWorkspaceCommands
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useHarness(null));
    await settle();
    const big = workspace('ws-big', 250);
    act(() => result.current.add(big));
    await settle(2_000);
    expect(calls()).toHaveLength(2);
    const [chunk1, chunk2] = calls().map(([, , commands]) => commands);
    expect(chunk1.length).toBeGreaterThan(490);
    expect(chunk1.length).toBeLessThanOrEqual(500);
    expect(chunk1[0].type).toBe('workspace.upsert');
    expect(chunk2.length).toBeLessThanOrEqual(500);
    expect(calls()[0][1]).not.toBe(calls()[1][1]);

    // The retry (2 s later) resends the chunk that failed, not the one that committed.
    await settle(2_000);
    expect(calls().length).toBeGreaterThanOrEqual(3);
    expect(calls()[2][2]).toEqual(chunk2);
    // Unanswered, it may have committed: the same chunk goes under the same operation id.
    expect(calls()[2][1]).toBe(calls()[1][1]);
    await settle(10_000);
    const committed = [calls()[0], ...calls().slice(2)].flatMap(([, , commands]) => commands);
    const ids = committed.map((command) => `${command.type}:${JSON.stringify(command.payload.id)}:${'viewed_at' in command.payload}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(committed.filter((command) => command.type === 'tree.upsert')).toHaveLength(250);
    expect(committed.filter((command) => command.type === 'node.upsert')).toHaveLength(big.project.chatIds.length);
    expect(committed.filter((command) => command.type === 'edge.upsert')).toHaveLength(big.project.edges.length);
    const sends = calls().length;
    await settle(10_000);
    expect(calls()).toHaveLength(sends);
  });

  it('split smaller when an older backend says the batch is too large, with no notice', async () => {
    apiMocks.applyWorkspaceCommands.mockImplementation(async (_id, _op, commands) => {
      if (commands.length > 100) throw new WorkspaceCommandsError('commands must be an array of at most 100 items', 400);
    });
    const { result } = renderHook(() => useHarness(null));
    await settle();
    const fresh = workspace('ws-old', 60);
    act(() => result.current.add(fresh));
    await settle(2_000);
    const [refused, ...rest] = calls().map(([, , commands]) => commands);
    expect(refused.length).toBeGreaterThan(100);
    expect(rest.length).toBeGreaterThan(1);
    expect(rest.every((commands) => commands.length <= 100)).toBe(true);
    expect(rest.flat()).toHaveLength(refused.length);
    expect(getWorkspaceSyncNotices()).toEqual([]);
  });

  it('split to the size a current backend names', async () => {
    apiMocks.applyWorkspaceCommands.mockImplementation(async (_id, _op, commands) => {
      if (commands.length > 50) throw new WorkspaceCommandsError('too many commands', 400, 'too_many_commands', { maxCommands: 50 });
    });
    const { result } = renderHook(() => useHarness(null));
    await settle();
    act(() => result.current.add(workspace('ws-new', 30)));
    await settle(2_000);
    const sent = calls().slice(1).map(([, , commands]) => commands);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((commands) => commands.length <= 50)).toBe(true);
    expect(getWorkspaceSyncNotices()).toEqual([]);
  });

  it('use the size the backend advertises', async () => {
    apiMocks.fetchPersistenceCapabilities.mockResolvedValue({ ...V2_CAPABILITIES, maxCommandsPerBatch: 120 });
    const { result } = renderHook(() => useHarness(null));
    await settle();
    act(() => result.current.add(workspace('ws-new', 60)));
    await settle(2_000);
    expect(calls().length).toBeGreaterThan(1);
    expect(calls().every(([, , commands]) => commands.length <= 120)).toBe(true);
  });
});

describe('failed writes', () => {
  const rename = (harness: { change: (id: string, update: (project: Project) => Project) => void }, name: string) =>
    act(() => harness.change('ws-1', (project) => ({ ...project, name })));

  it.each([
    ['a network error', () => new TypeError('Failed to fetch')],
    ['a 503', () => new WorkspaceCommandsError('Service unavailable', 503)],
    ['a 429', () => new WorkspaceCommandsError('Too many requests', 429)],
  ])('retry after %s with a backoff from 2 s doubling', async (_label, failure) => {
    apiMocks.applyWorkspaceCommands.mockImplementation(async () => { throw failure(); });
    const { result } = renderHook(() => useHarness(workspace('ws-1', 2)));
    await settle();
    rename(result.current, 'Unsaved');
    const counts: number[] = [];
    for (let second = 2; second <= 16; second += 2) {
      await settle(2_000);
      counts.push(calls().length);
    }
    // Tries at 2 s, 4 s, 8 s and 16 s.
    expect(counts).toEqual([1, 2, 2, 3, 3, 3, 3, 4]);
    expect(getWorkspaceSyncNotices()).toEqual([]);
  });

  it('hold a write queued behind a failed one to the same backoff', async () => {
    const first = deferred<void>();
    apiMocks.applyWorkspaceCommands.mockImplementationOnce(() => first.promise);
    const { result } = renderHook(() => useHarness(workspace('ws-1', 2)));
    await settle();
    rename(result.current, 'A');
    await settle(2_000);
    rename(result.current, 'B');
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    await act(async () => { first.reject(new TypeError('Failed to fetch')); await vi.advanceTimersByTimeAsync(0); });
    expect(calls()).toHaveLength(1);
    await settle(2_000);
    expect(calls()).toHaveLength(2);
    expect(calls()[1][2][0].payload.name).toBe('B');
  });

  it('rebase a conflict on a re-read, retry it, and show it only once it has lasted two minutes', async () => {
    apiMocks.applyWorkspaceCommands.mockRejectedValue(
      new WorkspaceCommandsError('node parent and child must belong to the same tree', 409, 'node_parent_tree_mismatch'));
    const reads: WorkspaceStructureReadRequest[] = [];
    const onRead = (event: Event) => reads.push((event as CustomEvent<WorkspaceStructureReadRequest>).detail);
    window.addEventListener(WORKSPACE_STRUCTURE_READ_EVENT, onRead);
    try {
      const { result } = renderHook(() => useHarness(workspace('ws-1', 2)));
      await settle();
      rename(result.current, 'Unsaved');
      await settle(2_000);
      expect(reads).toEqual([{ connectionId: 'local', changes: [{ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' }] }]);
      await settle(98_000);
      expect(calls().length).toBeGreaterThan(3);
      expect(getWorkspaceSyncNotices()).toEqual([]);
      await settle(26_000);
      expect(getWorkspaceSyncNotices()).toEqual([expect.objectContaining({
        workspaceId: 'ws-1', kind: 'conflict', message: 'node parent and child must belong to the same tree',
      })]);
      apiMocks.applyWorkspaceCommands.mockResolvedValue(undefined);
      await settle(62_000);
      expect(getWorkspaceSyncNotices()).toEqual([]);
      expect(calls().at(-1)![2][0].payload.name).toBe('Unsaved');
    } finally {
      window.removeEventListener(WORKSPACE_STRUCTURE_READ_EVENT, onRead);
    }
  });

  it('stop on any other refusal with one notice, until Retry', async () => {
    apiMocks.applyWorkspaceCommands.mockRejectedValue(
      new WorkspaceCommandsError('node.id must be a non-empty string <=160 chars', 400, 'invalid_entity_id'));
    const { result } = renderHook(() => useHarness(workspace('ws-1', 2)));
    await settle();
    rename(result.current, 'First');
    await settle(2_000);
    expect(calls()).toHaveLength(1);
    expect(getWorkspaceSyncNotices()).toEqual([expect.objectContaining({
      workspaceId: 'ws-1', workspaceName: 'First', kind: 'rejected', message: 'node.id must be a non-empty string <=160 chars',
    })]);
    rename(result.current, 'Second');
    await settle(20_000);
    expect(calls()).toHaveLength(1);
    expect(getWorkspaceSyncNotices()).toHaveLength(1);

    apiMocks.applyWorkspaceCommands.mockResolvedValue(undefined);
    act(() => getWorkspaceSyncNotices()[0].retry());
    expect(getWorkspaceSyncNotices()).toEqual([]);
    await settle(2_000);
    expect(calls()).toHaveLength(2);
    expect(calls()[1][2][0].payload.name).toBe('Second');
    await settle(10_000);
    expect(calls()).toHaveLength(2);
  });

  it('drop the unsaved changes on Discard and read the workspace again', async () => {
    apiMocks.applyWorkspaceCommands.mockRejectedValue(new WorkspaceCommandsError('node not found', 404, 'node_not_found'));
    const reads: WorkspaceStructureReadRequest[] = [];
    const onRead = (event: Event) => reads.push((event as CustomEvent<WorkspaceStructureReadRequest>).detail);
    window.addEventListener(WORKSPACE_STRUCTURE_READ_EVENT, onRead);
    try {
      const { result } = renderHook(() => useHarness(workspace('ws-1', 2)));
      await settle();
      // A thread made here that the backend never got, and a rename.
      act(() => result.current.change('ws-1', (project) => ({
        ...project, name: 'Unsaved',
        trees: [...project.trees, { id: 'ws-1-t-local', rootNodeId: 'ws-1-n0', createdAt: 3, lastActiveAt: 3 }],
      })));
      await settle(2_000);
      const project = result.current.projects[0];
      expect(result.current.persistence.structureGuards.workspaceFieldEdited(project, 'name', Date.now())).toBe(true);
      act(() => getWorkspaceSyncNotices()[0].discard());
      expect(getWorkspaceSyncNotices()).toEqual([]);
      expect(reads).toEqual([{
        connectionId: 'local',
        changes: [
          { entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' },
          { entity: 'tree', op: 'deleted', workspaceId: 'ws-1', treeId: 'ws-1-t-local' },
        ],
      }]);
      // A re-read may now take the backend's values back.
      expect(result.current.persistence.structureGuards.workspaceFieldEdited(project, 'name', Date.now())).toBe(false);
      await settle(20_000);
      expect(calls()).toHaveLength(1);
    } finally {
      window.removeEventListener(WORKSPACE_STRUCTURE_READ_EVENT, onRead);
    }
  });
});

describe('unload', () => {
  it('beacons what fits in dependency-ordered chunks, and nothing for a refused workspace', async () => {
    // jsdom's Blob cannot be read back: record what each beacon body was made from.
    const bodies: Array<{ operationId: string; commands: WorkspaceCommand[] }> = [];
    const RealBlob = window.Blob;
    vi.stubGlobal('Blob', class extends RealBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        if (options?.type === 'application/json') bodies.push(JSON.parse((parts ?? []).map(String).join('')));
      }
    });
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
    try {
      const { result } = renderHook(() => useHarness(null));
      await settle();
      act(() => result.current.add(workspace('ws-big', 250)));
      await settle();
      act(() => { window.dispatchEvent(new Event('beforeunload')); });
      expect(sendBeacon).toHaveBeenCalled();
      const sizes = sendBeacon.mock.calls.map(([, data]) => (data as Blob).size);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(60 * 1024);
      const sent = bodies.slice(0, sendBeacon.mock.calls.length);
      expect(sent[0].commands[0].type).toBe('workspace.upsert');
      expect(sent.every((body) => body.commands.length <= 100)).toBe(true);
      expect(new Set(sent.map((body) => body.operationId)).size).toBe(sent.length);
      // What did not fit is left for the backend's next read, not squeezed in.
      expect(sent.flatMap((body) => body.commands).length).toBeLessThan(1_000);

      // Refused outright: its writes are not beaconed either.
      sendBeacon.mockClear();
      apiMocks.applyWorkspaceCommands.mockRejectedValue(new WorkspaceCommandsError('workspace not found', 404));
      await settle(2_000);
      expect(getWorkspaceSyncNotices()).toHaveLength(1);
      act(() => { window.dispatchEvent(new Event('beforeunload')); });
      expect(sendBeacon).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
