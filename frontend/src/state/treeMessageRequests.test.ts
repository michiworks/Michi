import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from './chatTypes';
const api = vi.hoisted(() => ({ fetchTreeMessageSnapshot: vi.fn(), fetchTreeMessagePage: vi.fn() }));
vi.mock('../services/api', () => api);
import {
  REMOTE_FIRST_PAGE_LIMIT, TREE_PREFETCH_CONCURRENCY, TREE_PREFETCH_LIMIT, TREE_PREFETCH_TTL_MS, TreeMessageRequests,
  sameTreeMessageAnchor,
} from './treeMessageRequests';

const projects: Project[] = Array.from({ length: 8 }, (_, i) => ({
  id: `ws-${i}`, name: 'Workspace', chatIds: [`n${i}`], edges: [], artifacts: [], createdAt: 1,
  trees: [{ id: `t${i}`, rootNodeId: `n${i}`, createdAt: 1, lastActiveAt: 1 }], activeTreeId: `t${i}`,
}));
function makeNodes(): Record<string, ChatNodeState> {
  return Object.fromEntries(projects.map((p, i) => [`n${i}`, {
    nodeId: `n${i}`, projectId: p.id, kind: 'chat', chatId: null, messages: [], messagesLoaded: false,
    messageCount: 1, followUps: [], status: 'idle',
  }]));
}

describe('provider-scoped tree reads', () => {
  let requests: TreeMessageRequests;
  let nodes: Record<string, ChatNodeState>;
  beforeEach(() => {
    vi.useFakeTimers();
    api.fetchTreeMessageSnapshot.mockReset().mockResolvedValue({ messages: [] });
    api.fetchTreeMessagePage.mockReset().mockImplementation(() => new Promise(() => {}));
    requests = new TreeMessageRequests();
    nodes = makeNodes();
  });
  afterEach(() => { requests.clear(); vi.useRealTimers(); });
  const signal = () => new AbortController().signal;

  it('caps speculative concurrency but never blocks a foreground read', async () => {
    api.fetchTreeMessageSnapshot.mockImplementation(() => new Promise(() => {}));
    projects.forEach((p, i) => requests.prefetch(p, `t${i}`, nodes));
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(TREE_PREFETCH_CONCURRENCY);
    requests.acquire(projects[7], 't7', nodes, signal());
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(TREE_PREFETCH_CONCURRENCY + 1);
  });

  it('evicts old speculative entries at the cache limit', async () => {
    for (let i = 0; i <= TREE_PREFETCH_LIMIT; i++) {
      requests.prefetch(projects[i], `t${i}`, nodes);
      await Promise.resolve();
    }
    requests.acquire(projects[0], 't0', nodes, signal());
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(TREE_PREFETCH_LIMIT + 2);
  });

  it('expires speculative results and invalidates changed message state', async () => {
    requests.prefetch(projects[0], 't0', nodes);
    await vi.advanceTimersByTimeAsync(TREE_PREFETCH_TTL_MS + 1);
    requests.prefetch(projects[0], 't0', nodes);
    await Promise.resolve();
    nodes.n0 = { ...nodes.n0, lastAppliedBackgroundSeq: 9 };
    requests.acquire(projects[0], 't0', nodes, signal());
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(3);
  });

  it('skips loaded, deleted, unknown and streaming speculative targets', () => {
    nodes.n0 = { ...nodes.n0, messagesLoaded: true };
    nodes.n1 = { ...nodes.n1, deletedAt: 1 };
    nodes.n2 = { ...nodes.n2, status: 'streaming' };
    requests.prefetch(projects[0], 't0', nodes);
    requests.prefetch(projects[1], 't1', nodes);
    requests.prefetch(projects[2], 't2', nodes);
    requests.prefetch(projects[3], 'missing', nodes);
    expect(api.fetchTreeMessageSnapshot).not.toHaveBeenCalled();
    requests.acquire(projects[2], 't2', nodes, signal());
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps a foreground read for a caller that restarts in the same task, and cancels it after the last leaves', async () => {
    api.fetchTreeMessageSnapshot.mockImplementation(() => new Promise(() => {}));
    const first = new AbortController();
    const entry = requests.acquire(projects[0], 't0', nodes, first.signal);
    const fetchSignal = api.fetchTreeMessageSnapshot.mock.calls[0][3] as AbortSignal;
    // An effect re-run: the old run's cleanup, then the new run, synchronously.
    first.abort();
    const second = new AbortController();
    expect(requests.acquire(projects[0], 't0', nodes, second.signal)).toBe(entry);
    await Promise.resolve();
    expect(fetchSignal.aborted).toBe(false);
    second.abort();
    await Promise.resolve();
    expect(fetchSignal.aborted).toBe(true);
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reuses a read for a subset of its nodes and finds it for one node', () => {
    api.fetchTreeMessageSnapshot.mockImplementation(() => new Promise(() => {}));
    const pair: Project = { ...projects[0], chatIds: ['n0', 'n1'], edges: [{ source: 'n0', target: 'n1' }] };
    const two: Record<string, ChatNodeState> = { ...nodes, n1: { ...nodes.n1, projectId: pair.id } };
    const entry = requests.acquire(pair, 't0', two, signal());
    const fewer: Record<string, ChatNodeState> = { ...two, n1: { ...two.n1, messagesLoaded: true } };
    expect(requests.acquire(pair, 't0', fewer, signal())).toBe(entry);
    expect(requests.pendingFor('n0', fewer.n0)).toBe(entry);
    expect(requests.pendingFor('n0', { ...fewer.n0, lastAppliedBackgroundSeq: 4 })).toBeNull();
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight foreground read when the watch feed changes status, title or count meanwhile', async () => {
    api.fetchTreeMessageSnapshot.mockImplementation(() => new Promise(() => {}));
    const first = new AbortController();
    const entry = requests.acquire(projects[0], 't0', nodes, first.signal);
    const fetchSignal = api.fetchTreeMessageSnapshot.mock.calls[0][3] as AbortSignal;
    // What a structure re-read or the attention feed brings while the bytes come in.
    const watched = { ...nodes, n0: { ...nodes.n0, status: 'error' as const, title: 'Renamed', messageCount: 7, followUps: [] } };
    // The loader's effect re-runs (its signature moved): cleanup, then a new acquire.
    first.abort();
    expect(requests.acquire(projects[0], 't0', watched, signal())).toBe(entry);
    expect(requests.pendingFor('n0', watched.n0)).toBe(entry);
    await Promise.resolve();
    expect(fetchSignal.aborted).toBe(false);
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
  });

  it('still starts over when a node\'s messages or cursors moved on during a foreground read', async () => {
    api.fetchTreeMessageSnapshot.mockImplementation(() => new Promise(() => {}));
    const first = new AbortController();
    requests.acquire(projects[0], 't0', nodes, first.signal);
    const fetchSignal = api.fetchTreeMessageSnapshot.mock.calls[0][3] as AbortSignal;
    first.abort();
    requests.acquire(projects[0], 't0', { ...nodes, n0: { ...nodes.n0, lastAppliedBackgroundSeq: 3 } }, signal());
    await Promise.resolve();
    expect(fetchSignal.aborted).toBe(true);
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(2);
  });

  it('never lets a speculative read cancel a foreground one, whatever changed', async () => {
    api.fetchTreeMessageSnapshot.mockImplementation(() => new Promise(() => {}));
    requests.acquire(projects[0], 't0', nodes, signal());
    const fetchSignal = api.fetchTreeMessageSnapshot.mock.calls[0][3] as AbortSignal;
    requests.prefetch(projects[0], 't0', { ...nodes, n0: { ...nodes.n0, lastAppliedSeq: 9 } });
    await Promise.resolve();
    expect(fetchSignal.aborted).toBe(false);
    expect(api.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
  });

  it('asks a remote tree for a short first page, and reports it', async () => {
    const page = { messages: [], pages: [{ nodeId: 'n0', total: 40, before: { seq: 25, id: 'm25' } }] };
    api.fetchTreeMessagePage.mockReset().mockResolvedValue(page);
    const onRemotePage = vi.fn();
    const pool = new TreeMessageRequests({ onRemotePage });
    const remote = { ...projects[0], backendConnectionId: 'remote-a' };
    const entry = pool.acquire(remote, 't0', nodes, signal());
    await expect(entry!.promise).resolves.toBe(page);
    expect(api.fetchTreeMessagePage).toHaveBeenCalledExactlyOnceWith('ws-0', 't0', 'remote-a', expect.any(AbortSignal), { limit: REMOTE_FIRST_PAGE_LIMIT });
    expect(REMOTE_FIRST_PAGE_LIMIT).toBeLessThan(50);
    expect(onRemotePage).toHaveBeenCalledExactlyOnceWith(remote, 't0', page);
    expect(api.fetchTreeMessageSnapshot).not.toHaveBeenCalled();
    pool.clear();
  });

  it('hands a read started before its nodes existed to the first caller for that tree', async () => {
    let resolve!: (page: { messages: unknown[] }) => void;
    const boot = new Promise<{ messages: unknown[] }>((done) => { resolve = done; });
    const remote = { ...projects[0], backendConnectionId: 'remote-a' };
    requests.seed('remote-a', 'ws-0', 't0', boot);
    // Another connection's identical ids are another read.
    expect(requests.acquire({ ...remote, backendConnectionId: 'remote-b' }, 't0', nodes, signal())?.promise).not.toBe(boot);
    const entry = requests.acquire(remote, 't0', nodes, signal());
    expect(entry?.promise).toBe(boot);
    expect(entry?.nodes.get('n0')).toBe(nodes.n0);
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    resolve({ messages: [] });
    await boot;
  });

  it('lets an unclaimed handed-over read expire', async () => {
    const controller = new AbortController();
    requests.seed('remote-a', 'ws-0', 't0', new Promise(() => {}), controller);
    await vi.advanceTimersByTimeAsync(TREE_PREFETCH_TTL_MS + 1);
    requests.prefetch(projects[1], 't1', nodes);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('sameTreeMessageAnchor', () => {
  const base = makeNodes().n0;
  it('ignores what a read does not answer for, and catches what it does', () => {
    expect(sameTreeMessageAnchor(base, { ...base, status: 'streaming', title: 'x', messageCount: 9, followUps: [] })).toBe(true);
    expect(sameTreeMessageAnchor(base, { ...base, messages: [] })).toBe(true);
    expect(sameTreeMessageAnchor(base, { ...base, messages: [{ id: 'u', role: 'user', text: 'hi', toolCalls: [], createdAt: 1 }] })).toBe(false);
    expect(sameTreeMessageAnchor(base, { ...base, lastAppliedTurnId: 'turn-2' })).toBe(false);
    expect(sameTreeMessageAnchor(base, { ...base, messagesLoaded: true })).toBe(false);
    expect(sameTreeMessageAnchor(base, undefined)).toBe(false);
  });
});
