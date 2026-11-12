import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';

const api = vi.hoisted(() => ({
  fetchTreeMessageSnapshot: vi.fn(),
  fetchTreeMessagePage: vi.fn(),
  fetchNodeWorkspace: vi.fn(),
}));
vi.mock('../services/api', () => api);

import { reduceNodes } from './chatReducers';
import { NodeMessagesSelfHeal } from './nodeMessagesSelfHeal';
import { TreeMessageRequests } from './treeMessageRequests';

const ID = 'remote:box:n2';
const WS = 'remote:box:ws';

// n2 hangs off n1 locally, so this window files it under tree-1; the server
// keeps it in tree-9.
const project: Project = {
  id: WS, name: 'Remote', chatIds: ['remote:box:n1', ID], artifacts: [], createdAt: 1, backendConnectionId: 'box',
  edges: [{ source: 'remote:box:n1', target: ID }],
  trees: [{ id: 'tree-1', rootNodeId: 'remote:box:n1', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 'tree-1',
};

function placeholder(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId: ID, projectId: WS, kind: 'chat', chatId: null, messages: [], messagesLoaded: false,
    messageCount: 3, followUps: [], status: 'idle', ...overrides };
}

const row = (content: string) => ({ id: `m-${content}`, node_id: ID, role: 'user', content, seq: 0, created_at: 1 });

describe('NodeMessagesSelfHeal', () => {
  let nodesRef: { current: Record<string, ChatNodeState> };
  let requests: TreeMessageRequests;
  let heal: NodeMessagesSelfHeal;
  let dispatch: ReturnType<typeof vi.fn<(action: ChatAction) => void>>;
  const reconnectStreamingRef = { current: vi.fn<(nodeId: string) => void>() };

  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(api)) fn.mockReset();
    reconnectStreamingRef.current.mockReset();
    nodesRef = { current: { [ID]: placeholder() } };
    dispatch = vi.fn((action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); });
    requests = new TreeMessageRequests();
    heal = new NodeMessagesSelfHeal({ nodesRef, dispatch, reconnectStreamingRef, requests, projects: () => [project] });
  });
  afterEach(() => { heal.clear(); requests.clear(); vi.useRealTimers(); });

  it('asks the server which thread holds a node the local tree does not, then loads it there', async () => {
    api.fetchTreeMessagePage.mockImplementation(async (_ws: string, treeId: string) => treeId === 'tree-1'
      ? { messages: [], pages: [], turns: [] }
      : { messages: [row('found')], pages: [{ nodeId: ID, total: 1, before: null }], turns: [] });
    api.fetchNodeWorkspace.mockResolvedValue({ workspaceId: WS, treeId: 'tree-9' });
    await expect(heal.ensure(ID)).resolves.toBe('loaded');
    expect(api.fetchTreeMessagePage.mock.calls.map((call) => [call[1], call[4]])).toEqual([
      ['tree-1', { nodeId: ID }], ['tree-9', { nodeId: ID }],
    ]);
    expect(nodesRef.current[ID]).toMatchObject({ messagesLoaded: true, messageCount: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('reattaches a streaming node once its checkpoint is installed', async () => {
    nodesRef.current = { [ID]: placeholder({ status: 'streaming' }) };
    api.fetchTreeMessagePage.mockResolvedValue({ messages: [row('partial')], pages: [{ nodeId: ID, total: 1, before: null }] });
    await expect(heal.ensure(ID)).resolves.toBe('loaded');
    expect(reconnectStreamingRef.current).toHaveBeenCalledWith(ID);
  });

  it('never installs an empty page for a node with history unless the server reports it empty', async () => {
    api.fetchNodeWorkspace.mockResolvedValue({ workspaceId: WS, treeId: 'tree-1' });
    api.fetchTreeMessagePage
      .mockResolvedValueOnce({ messages: [], pages: [{ nodeId: ID, total: 3, before: null }] })
      // An older gateway answers without page metadata.
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValue({ messages: [], pages: [{ nodeId: ID, total: 0, before: null }] });
    const result = heal.ensure(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe('loaded');
    expect(nodesRef.current[ID]).toMatchObject({ messagesLoaded: true, messages: [], messageCount: 0 });
  });

  it('waits on a read already covering the node instead of starting its own', async () => {
    let resolveTree!: (page: unknown) => void;
    api.fetchTreeMessagePage.mockReturnValueOnce(new Promise((resolve) => { resolveTree = resolve; }));
    const siblings = { ...project, edges: [], trees: [...project.trees, { id: 'tree-2', rootNodeId: ID, createdAt: 1, lastActiveAt: 1 }] };
    requests.prefetch(siblings, 'tree-2', nodesRef.current);
    const result = heal.ensure(ID);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    resolveTree({ messages: [row('shared')], pages: [{ nodeId: ID, total: 1, before: null }] });
    await expect(result).resolves.toBe('loaded');
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    expect(nodesRef.current[ID].messages).toHaveLength(1);
  });

  it('stops after bounded retries, and a Retry starts over at once', async () => {
    api.fetchTreeMessagePage.mockRejectedValue(new Error('fetchTreeMessagePage failed: 500'));
    const result = heal.ensure(ID);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBe('failed');
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(5);
    api.fetchTreeMessagePage.mockResolvedValue({ messages: [row('back')], pages: [{ nodeId: ID, total: 1, before: null }] });
    await expect(heal.ensure(ID, { immediate: true })).resolves.toBe('loaded');
  });

  it('a Retry cuts a back-off short', async () => {
    api.fetchTreeMessagePage.mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ messages: [row('now')], pages: [{ nodeId: ID, total: 1, before: null }] });
    const result = heal.ensure(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    void heal.ensure(ID, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe('loaded');
  });

  it('cancels its read once the last skeleton asking for it goes away', async () => {
    api.fetchTreeMessagePage.mockReturnValue(new Promise(() => {}));
    const a = new AbortController();
    const b = new AbortController();
    const result = heal.ensure(ID, { signal: a.signal });
    void heal.ensure(ID, { signal: b.signal });
    await vi.advanceTimersByTimeAsync(0);
    const signal = api.fetchTreeMessagePage.mock.calls[0][3] as AbortSignal;
    a.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(false);
    b.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    await expect(result).resolves.toBe('cancelled');
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
  });
});
