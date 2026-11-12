/**
 * Boot on a remote workspace (Cmd+R over an SSH tunnel): the visible thread is
 * read alongside the remote's metadata, a cached copy is shown read-only until
 * the remote answers, and the answer replaces the copy without writing it back.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatNodeState, Project } from './chatTypes';
import type { BackendConnectionSummary } from '../config/backendConnections';
import { backendEntityId } from '../config/backendIdentity';
import { backendConnectionProvisional, resetBackendConnectionProvisional } from '../config/backendConnectionState';

const apiMocks = vi.hoisted(() => ({
  fetchPersistenceCapabilities: vi.fn(),
  fetchAllWorkspacesMeta: vi.fn(),
  fetchTreeMessageSnapshot: vi.fn(async () => ({ messages: [] })),
  fetchTreeMessagePage: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchWorkspace: vi.fn(),
  applyWorkspaceCommands: vi.fn(async () => {}),
  listBackendConnections: vi.fn(async (): Promise<BackendConnectionSummary[]> => []),
}));
vi.mock('../services/api', () => apiMocks);

import { useWorkspacePersistence } from './workspacePersistence';
import { MemoryRemoteCacheStorage, RemoteSnapshotCache } from './remoteSnapshotCache';
import { markRemoteFirstPaint, remoteFirstPainted, resetRemoteFirstPaint } from './remoteFirstPaint';
import { REMOTE_FIRST_PAGE_LIMIT, TreeMessageRequests } from './treeMessageRequests';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const connection: BackendConnectionSummary = {
  id: 'remote-tunnel', name: 'Dev desktop', transport: 'ssh', sshHost: 'dev', remotePort: 3000,
  hasToken: true, createdAt: 1, updatedAt: 1,
};
const revisionOf = (summary: BackendConnectionSummary) => JSON.stringify([
  summary.transport, summary.apiUrl, summary.sshHost, summary.sshUser,
  summary.sshPort, summary.remotePort, summary.hasToken, summary.createdAt, summary.updatedAt,
]);
const remote = (id: string) => backendEntityId(connection.id, id);
const WS = remote('ws-r');
const TREE = remote('t-r');
const NODE = remote('n-r');

const localRow = {
  workspace: { id: 'ws-1', name: 'Local', created_at: 1 },
  nodes: [{ id: 'n1', created_at: 1 }], trees: [], edges: [], messages: [], artifacts: [],
};
function remoteRow({ name = 'Remote', title = 'Thread', count = 2, turn = 'turn-1' } = {}) {
  return {
    workspace: { id: 'ws-r', name, created_at: 2, active_tree_id: 't-r' },
    trees: [{ id: 't-r', workspace_id: 'ws-r', root_node_id: 'n-r', created_at: 2 }],
    nodes: [{ id: 'n-r', tree_id: 't-r', created_at: 2, message_count: count, title, last_applied_turn_id: turn, last_applied_seq: 9 }],
    edges: [], messages: [], artifacts: [],
  };
}
function page(count = 2, turn = 'turn-1') {
  return {
    messages: Array.from({ length: count }, (_, i) => ({
      id: `m${i}`, node_id: NODE, role: i % 2 ? 'assistant' : 'user', content: `message ${i}`, seq: i, created_at: i + 1,
    })),
    pages: [{ nodeId: NODE, total: count, before: null }],
    turns: [{ node_id: NODE, turn_id: turn, status: 'completed', last_seq: 9, error: null, completed_at: 3 }],
  };
}

function useHarness(options: {
  userId?: string;
  cache?: RemoteSnapshotCache | null;
  requests?: TreeMessageRequests;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(WS);
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({});
  const [hydrated, setHydrated] = useState(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const syncPausedRef = useRef(false);
  const dirtyDraftNodeIdsRef = useRef(new Set<string>());
  const persistence = useWorkspacePersistence({
    projects, activeProjectId, nodes, structureVersion: 0, hydrated, nodesRef,
    setProjects, setActiveProjectId, setNodes, setHydrated, userId: options.userId,
    syncPausedRef, dirtyDraftNodeIdsRef,
    remoteSnapshotCache: options.cache ?? null, treeMessageRequests: options.requests,
  });
  const typeDraft = (nodeId: string, value: string) => {
    setNodes((current) => {
      const next = { ...current, [nodeId]: { ...current[nodeId], composerDraft: { value, mentions: [] } } };
      nodesRef.current = next;
      return next;
    });
    dirtyDraftNodeIdsRef.current.add(nodeId);
  };
  return { hydrated, projects, activeProjectId, nodes, typeDraft, persistence };
}

function sentPayloads(): string {
  return JSON.stringify(apiMocks.applyWorkspaceCommands.mock.calls.map((call) => (call as unknown[])[2]));
}

async function cachedCopy(userId = 'u1', revision = revisionOf(connection), row = remoteRow({ name: 'Cached name', title: 'Cached title' })) {
  const cache = new RemoteSnapshotCache(new MemoryRemoteCacheStorage());
  await cache.writeSnapshot(userId, connection.id, revision, { workspaces: [row] });
  await cache.writePage(userId, connection.id, revision, WS, TREE, page());
  await cache.noteActiveTree(userId, connection.id, revision, WS, TREE);
  return cache;
}

describe('boot on a remote workspace', () => {
  let remoteMeta: ReturnType<typeof deferred<unknown[]>>;
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    resetRemoteFirstPaint();
    resetBackendConnectionProvisional();
    Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined });
    remoteMeta = deferred<unknown[]>();
    apiMocks.fetchPersistenceCapabilities.mockReset().mockResolvedValue({ protocolVersion: 2 });
    apiMocks.fetchAllWorkspacesMeta.mockReset().mockImplementation(async (id?: string) => (id === connection.id ? remoteMeta.promise : [localRow]));
    apiMocks.fetchTreeMessagePage.mockReset().mockResolvedValue(page());
    apiMocks.applyWorkspaceCommands.mockReset().mockResolvedValue(undefined);
    apiMocks.listBackendConnections.mockReset().mockResolvedValue([connection]);
  });
  afterEach(() => vi.useRealTimers());

  it('reads the visible thread alongside the metadata and installs it with it, once', async () => {
    // No copy yet: this window's pane slot names the thread.
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ [`${WS}::${TREE}`]: NODE }));
    const { result } = renderHook(() => useHarness({}));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    // Started before the remote's metadata answered.
    expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledExactlyOnceWith(WS, TREE, connection.id, expect.any(AbortSignal), { limit: REMOTE_FIRST_PAGE_LIMIT });
    expect(result.current.activeProjectId).toBe('ws-1');
    expect(remoteFirstPainted(connection.id)).toBe(false);

    await act(async () => { remoteMeta.resolve([remoteRow()]); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.activeProjectId).toBe(WS);
    expect(result.current.nodes[NODE]).toMatchObject({ messagesLoaded: true, messageCount: 2 });
    expect(result.current.nodes[NODE].messages.map((message) => message.id)).toEqual(['m0', 'm1']);
    expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    expect(remoteFirstPainted(connection.id)).toBe(true);
  });

  it('hands a read still on its way to the tree read pool instead of reading again', async () => {
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ [`${WS}::${TREE}`]: NODE }));
    const slow = deferred<ReturnType<typeof page>>();
    apiMocks.fetchTreeMessagePage.mockReset().mockReturnValue(slow.promise);
    const requests = new TreeMessageRequests();
    const { result } = renderHook(() => useHarness({ requests }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { remoteMeta.resolve([remoteRow()]); await vi.advanceTimersByTimeAsync(2_000); });
    // The metadata did not wait past the budget: placeholders now, the read still going.
    expect(result.current.activeProjectId).toBe(WS);
    expect(result.current.nodes[NODE].messagesLoaded).toBe(false);
    const project = result.current.projects.find((candidate) => candidate.id === WS)!;
    const entry = requests.acquire(project, TREE, result.current.nodes, new AbortController().signal);
    expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    slow.resolve(page());
    await expect(entry!.promise).resolves.toEqual(page());
    requests.clear();
  });

  it('drops a read the metadata outran, so the loader reads the thread fresh', async () => {
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ [`${WS}::${TREE}`]: NODE }));
    const slow = deferred<ReturnType<typeof page>>();
    apiMocks.fetchTreeMessagePage.mockReset().mockReturnValueOnce(slow.promise).mockResolvedValue(page(3, 'turn-2'));
    const requests = new TreeMessageRequests();
    const { result } = renderHook(() => useHarness({ requests }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { remoteMeta.resolve([remoteRow({ count: 3, turn: 'turn-2' })]); await vi.advanceTimersByTimeAsync(2_000); });
    const project = result.current.projects.find((candidate) => candidate.id === WS)!;
    const entry = requests.acquire(project, TREE, result.current.nodes, new AbortController().signal);
    slow.resolve(page(2, 'turn-1'));
    await expect(entry!.promise).rejects.toThrow('moved on');
    requests.clear();
  });

  it('opens on the cached copy read-only, holds its writes, and lets the answer replace it', async () => {
    const cache = await cachedCopy();
    apiMocks.fetchTreeMessagePage.mockReset().mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useHarness({ userId: 'u1', cache }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    // No local flash: the remote workspace is on screen from the copy.
    expect(result.current.hydrated).toBe(true);
    expect(result.current.activeProjectId).toBe(WS);
    expect(result.current.projects.find((project) => project.id === WS)?.name).toBe('Cached name');
    expect(result.current.nodes[NODE].messages.map((message) => message.id)).toEqual(['m0', 'm1']);
    expect(backendConnectionProvisional(connection.id)).toBe(true);
    expect(remoteFirstPainted(connection.id)).toBe(true);

    act(() => result.current.typeDraft(NODE, 'typed meanwhile'));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();

    // The remote moved on: renamed, retitled, one more message.
    await act(async () => {
      remoteMeta.resolve([remoteRow({ name: 'Fresh name', title: 'Fresh title', count: 3, turn: 'turn-2' })]);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(backendConnectionProvisional(connection.id)).toBe(false);
    expect(result.current.projects.find((project) => project.id === WS)?.name).toBe('Fresh name');
    // The cached node never wins over the answer...
    expect(result.current.nodes[NODE]).toMatchObject({ title: 'Fresh title', lastAppliedTurnId: 'turn-2', messageCount: 3 });
    // ...except for what this window did meanwhile.
    expect(result.current.nodes[NODE].composerDraft?.value).toBe('typed meanwhile');
    // The stale messages stay up while the loader reads the thread again.
    expect(result.current.nodes[NODE]).toMatchObject({ messagesLoaded: false, historyBefore: undefined });
    expect(result.current.nodes[NODE].messages).toHaveLength(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(apiMocks.applyWorkspaceCommands).toHaveBeenCalled();
    const sent = sentPayloads();
    expect(sent).toContain('typed meanwhile');
    expect(sent).not.toContain('Cached name');
    expect(sent).not.toContain('Cached title');
    expect(sent).not.toContain('Fresh name');
  });

  it('keeps the copy\'s messages and writes nothing when the remote answers what it showed', async () => {
    const cache = await cachedCopy('u1', revisionOf(connection), remoteRow());
    apiMocks.fetchTreeMessagePage.mockReset().mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useHarness({ userId: 'u1', cache }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { remoteMeta.resolve([remoteRow()]); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.nodes[NODE]).toMatchObject({ messagesLoaded: true, messageCount: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();
  });

  describe('a lean remote (its metadata leaves drafts, follow-ups and overviews to the thread page)', () => {
    const leanRow = () => ({ ...remoteRow(), leanNodeFields: ['branch_overview', 'follow_ups', 'composer_draft'] });
    const pageWithFields = (draft: string) => ({
      ...page(),
      pages: [{ nodeId: NODE, total: 2, before: null, node: {
        branch_overview: JSON.stringify([{ at: 1, text: 'Overview' }]), follow_ups: JSON.stringify(['Next?']),
        follow_ups_source_message_id: 'm1', composer_draft: JSON.stringify({ value: draft, mentions: [] }),
      } }],
    });
    async function boot() {
      const cache = new RemoteSnapshotCache(new MemoryRemoteCacheStorage());
      const revision = revisionOf(connection);
      await cache.writeSnapshot('u1', connection.id, revision, { workspaces: [leanRow()] });
      await cache.writePage('u1', connection.id, revision, WS, TREE, pageWithFields('cached draft'));
      await cache.noteActiveTree('u1', connection.id, revision, WS, TREE);
      const read = deferred<ReturnType<typeof pageWithFields>>();
      apiMocks.fetchTreeMessagePage.mockReset().mockReturnValue(read.promise);
      const harness = renderHook(() => useHarness({ userId: 'u1', cache }));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(harness.result.current.nodes[NODE].composerDraft?.value).toBe('cached draft');
      return { ...harness, read };
    }
    const answer = async (read: Awaited<ReturnType<typeof boot>>['read']) => {
      await act(async () => { read.resolve(pageWithFields('saved draft')); await vi.advanceTimersByTimeAsync(10); });
      await act(async () => { remoteMeta.resolve([leanRow()]); await vi.advanceTimersByTimeAsync(10); });
    };

    it('takes them from the thread read beside the metadata, over the copy, and writes nothing', async () => {
      const { result, read } = await boot();
      await answer(read);
      const node = result.current.nodes[NODE];
      expect(node).toMatchObject({ messagesLoaded: true, followUps: ['Next?'] });
      expect(node.composerDraft?.value).toBe('saved draft');
      expect(node.branchOverviewEntries?.map((entry) => entry.text)).toEqual(['Overview']);
      expect(node.deferredNodeFields).toBeUndefined();
      expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
      expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();
    });

    it('writes a draft typed over the copy, and fills the rest from the read', async () => {
      const { result, read } = await boot();
      act(() => result.current.typeDraft(NODE, 'typed meanwhile'));
      await answer(read);
      const node = result.current.nodes[NODE];
      expect(node.composerDraft?.value).toBe('typed meanwhile');
      expect(node.followUps).toEqual(['Next?']);
      expect(node.deferredNodeFields).toBeUndefined();
      await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
      const sent = sentPayloads();
      expect(sent).toContain('typed meanwhile');
      expect(sent).not.toContain('cached draft');
      expect(sent).not.toContain('saved draft');
    });
  });

  it('makes a workspace mutation wait for the answer rather than act on the copy', async () => {
    const cache = await cachedCopy();
    apiMocks.fetchTreeMessagePage.mockReset().mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useHarness({ userId: 'u1', cache }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const mutation = vi.fn(async () => {});
    let done: Promise<void> | undefined;
    act(() => { done = result.current.persistence.runWorkspaceMutation(WS, mutation); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mutation).not.toHaveBeenCalled();
    await act(async () => { remoteMeta.resolve([remoteRow()]); await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { await done; });
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it('keeps the remote shown read-only through an outage, and never sends what the copy holds', async () => {
    const cache = await cachedCopy();
    apiMocks.fetchTreeMessagePage.mockReset().mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useHarness({ userId: 'u1', cache }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => result.current.typeDraft(NODE, 'offline draft'));
    await act(async () => { remoteMeta.reject(new TypeError('tunnel down')); await vi.advanceTimersByTimeAsync(20_000); });
    expect(result.current.activeProjectId).toBe(WS);
    expect(backendConnectionProvisional(connection.id)).toBe(true);
    expect(apiMocks.applyWorkspaceCommands).not.toHaveBeenCalled();
    expect(result.current.nodes[NODE].composerDraft?.value).toBe('offline draft');
  });

  it('shows no copy kept for another user or another revision of the connection', async () => {
    const otherUser = await cachedCopy('someone-else');
    const first = renderHook(() => useHarness({ userId: 'u1', cache: otherUser }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(first.result.current.activeProjectId).toBe('ws-1');
    expect(backendConnectionProvisional(connection.id)).toBe(false);
    first.unmount();

    const edited = { ...connection, updatedAt: 2 };
    apiMocks.listBackendConnections.mockResolvedValue([edited]);
    const stale = await cachedCopy('u1', revisionOf(connection));
    const second = renderHook(() => useHarness({ userId: 'u1', cache: stale }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(second.result.current.activeProjectId).toBe('ws-1');
    expect(backendConnectionProvisional(connection.id)).toBe(false);
    // The copy for the old target is gone.
    expect(await stale.readConnection('u1', connection.id)).toBeNull();
    second.unmount();
  });

  it('keeps what the remote answered for the next boot, and forgets it when the connection goes', async () => {
    const cache = new RemoteSnapshotCache(new MemoryRemoteCacheStorage());
    const { result } = renderHook(() => useHarness({ userId: 'u1', cache }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { remoteMeta.resolve([remoteRow()]); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.activeProjectId).toBe(WS);
    await vi.waitFor(async () => {
      const kept = await cache.readConnection('u1', connection.id);
      expect(kept?.snapshot?.workspaces).toEqual([remoteRow()]);
      expect(kept?.activeTrees[WS]).toBe(TREE);
    });
    expect(await cache.readConnection('u2', connection.id)).toBeNull();
    // (The tree loader marks this once the thread's messages are in.)
    markRemoteFirstPaint(connection.id);

    apiMocks.listBackendConnections.mockResolvedValue([]);
    await act(async () => { window.dispatchEvent(new Event('michi:backend-connections-changed')); await vi.advanceTimersByTimeAsync(10); });
    await vi.waitFor(async () => expect(await cache.readConnection('u1', connection.id)).toBeNull());
    expect(remoteFirstPainted(connection.id)).toBe(false);
  });

  it('opens the barrier of a remote whose workspaces land while a local one is on screen', async () => {
    const { result } = renderHook(() => {
      const harness = useHarness({});
      return harness;
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.activeProjectId).toBe('ws-1');
    // The window wanted the remote one, so its barrier waits for that.
    expect(remoteFirstPainted(connection.id)).toBe(false);
    await act(async () => { remoteMeta.resolve([{ ...remoteRow(), workspace: { ...remoteRow().workspace, id: 'other' } }]); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.activeProjectId).toBe('ws-1');
    expect(remoteFirstPainted(connection.id)).toBe(true);
  });
});
