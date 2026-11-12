import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';

const apiMocks = vi.hoisted(() => ({
  fetchTreeMessageSnapshot: vi.fn(),
  fetchTreeMessagePage: vi.fn(),
  fetchNodeWorkspace: vi.fn(),
}));

vi.mock('../services/api', () => apiMocks);

import { reduceNodes } from './chatReducers';
import { useLazyTreeMessages } from './useLazyTreeMessages';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function project(lastActiveAt: number): Project {
  return {
    id: 'ws-1', name: 'Workspace', chatIds: ['n1'], edges: [], artifacts: [], createdAt: 1,
    trees: [{ id: 'tree-1', rootNodeId: 'n1', createdAt: 1, lastActiveAt }],
    activeTreeId: 'tree-1',
  };
}

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1', projectId: 'ws-1', kind: 'chat', chatId: 'chat-1',
    messages: [], messagesLoaded: false, messageCount: 2,
    followUps: [], status: 'idle', ...overrides,
  };
}

describe('useLazyTreeMessages live-turn races', () => {
  afterEach(() => vi.useRealTimers());

  it('prefetches without dispatching or navigating, then reuses the read on activation', async () => {
    const pending = deferred<{ messages: unknown[] }>();
    apiMocks.fetchTreeMessageSnapshot.mockReset().mockReturnValue(pending.promise);
    const otherNode = node({ nodeId: 'n2' });
    const nodesRef = { current: { n1: node({ messagesLoaded: true }), n2: otherNode } };
    const initialProject: Project = {
      ...project(1), chatIds: ['n1', 'n2'], trees: [
        ...project(1).trees, { id: 'tree-2', rootNodeId: 'n2', createdAt: 1, lastActiveAt: 1 },
      ],
    };
    const dispatch = vi.fn();
    const { result, rerender } = renderHook(({ activeProject }) => useLazyTreeMessages({
      hydrated: true, activeProjectId: 'ws-1', projects: [activeProject], nodesRef, dispatch,
    }), { initialProps: { activeProject: initialProject } });
    act(() => result.current.prefetchNode('n2'));
    expect(dispatch).not.toHaveBeenCalled();
    expect(initialProject.activeTreeId).toBe('tree-1');
    nodesRef.current.n2 = { ...otherNode, viewedAt: 100 };
    rerender({ activeProject: { ...initialProject, activeTreeId: 'tree-2' } });
    await act(async () => pending.resolve({ messages: [
      { id: 'fresh', node_id: 'n2', role: 'user', content: 'prefetched', seq: 0, created_at: 1 },
      { id: 'unexpected', node_id: 'n1', role: 'user', content: 'must not replace', seq: 0, created_at: 1 },
    ] }));
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'messages-loaded', nodeIds: ['n2'] }));
    expect(dispatch.mock.calls[0][0].messagesByNode.n1).toBeUndefined();
  });

  it('does not prefetch before hydration and disposes speculative reads on unmount', () => {
    apiMocks.fetchTreeMessageSnapshot.mockReset().mockReturnValue(new Promise(() => {}));
    const nodesRef = { current: { n1: node() } };
    const projects = [project(1)];
    const dispatch = vi.fn();
    const { result, rerender, unmount } = renderHook(({ hydrated }) => useLazyTreeMessages({
      hydrated, activeProjectId: null, projects, nodesRef, dispatch,
    }), { initialProps: { hydrated: false } });
    result.current.prefetchNode('n1');
    expect(apiMocks.fetchTreeMessageSnapshot).not.toHaveBeenCalled();
    rerender({ hydrated: true });
    result.current.prefetchNode('n1');
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
    unmount();
    expect(apiMocks.fetchTreeMessageSnapshot.mock.calls[0][3].aborted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not duplicate an in-flight read after the deferred retry and aborts it on unmount', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ messages: unknown[] }>();
    apiMocks.fetchTreeMessageSnapshot.mockReset().mockReturnValue(pending.promise);
    const nodesRef = { current: { n1: node() } };
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useLazyTreeMessages({
      hydrated: true, activeProjectId: 'ws-1', projects: [project(1)], nodesRef, dispatch,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
    const signal = apiMocks.fetchTreeMessageSnapshot.mock.calls[0][3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    pending.resolve({ messages: [] });
    await pending.promise;
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('retries a read that fails after the initial retry timer without requiring navigation', async () => {
    vi.useFakeTimers();
    let rejectRead!: (error: Error) => void;
    apiMocks.fetchTreeMessageSnapshot.mockReset()
      .mockReturnValueOnce(new Promise((_, reject) => { rejectRead = reject; }))
      .mockResolvedValueOnce({ messages: [{ id: 'fresh', node_id: 'n1', role: 'user', content: 'Recovered history', seq: 0, created_at: 1 }] });
    const nodesRef = { current: { n1: node() } };
    const projects = [project(1)];
    const dispatch = vi.fn();
    renderHook(() => useLazyTreeMessages({ hydrated: true, activeProjectId: 'ws-1', projects, nodesRef, dispatch }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { rejectRead(new TypeError('Failed to fetch')); });
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'messages-loaded', nodeIds: ['n1'] }));
  });

  it('backs off failed reads and stops retrying after leaving the tree', async () => {
    vi.useFakeTimers();
    apiMocks.fetchTreeMessageSnapshot.mockReset().mockRejectedValue(new TypeError('Backend restarting'));
    const nodesRef = { current: { n1: node() } };
    const projects = [project(1)];
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useLazyTreeMessages({ hydrated: true, activeProjectId: 'ws-1', projects, nodesRef, dispatch }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(3);
    expect(dispatch).not.toHaveBeenCalled();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(3);
  });

  it('does not install an old snapshot over a live turn and retries after cancellation', async () => {
    const first = deferred<{ messages: unknown[] }>();
    const second = deferred<{ messages: unknown[] }>();
    apiMocks.fetchTreeMessageSnapshot.mockReset();
    apiMocks.fetchTreeMessageSnapshot
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const nodesRef = { current: { n1: node() } } as MutableRefObject<Record<string, ChatNodeState>>;
    const dispatch = vi.fn<(action: ChatAction) => void>();

    const { rerender } = renderHook(
      ({ activeProject }: { activeProject: Project }) => useLazyTreeMessages({
        hydrated: true,
        activeProjectId: activeProject.id,
        projects: [activeProject],
        nodesRef,
        dispatch,
      }),
      { initialProps: { activeProject: project(1) } },
    );
    await vi.waitFor(() => expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1));

    // A real live foreground turn carries its user + assistant messages (from
    // user-send), so it must be protected from a stale snapshot. An empty
    // streaming node, by contrast, is a reconnect target that SHOULD load.
    nodesRef.current = { n1: node({ status: 'streaming', messages: [
      { id: 'live', role: 'assistant', text: 'live', toolCalls: [], createdAt: 1 },
    ] }) };
    rerender({ activeProject: project(2) });
    first.resolve({ messages: [{ id: 'old', node_id: 'n1', role: 'assistant', content: 'stale', seq: 0, created_at: 1 }] });
    await first.promise;
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();

    nodesRef.current = { n1: node({ status: 'idle' }) };
    rerender({ activeProject: project(3) });
    await vi.waitFor(() => expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(2));
    second.resolve({ messages: [{ id: 'fresh', node_id: 'n1', role: 'assistant', content: 'fresh', seq: 0, created_at: 2 }] });
    await second.promise;
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'messages-loaded', nodeIds: ['n1'],
    })));
  });

  it('loads the checkpoint body for a streaming placeholder reconnect target and asks to reattach', async () => {
    // A node hydrated as `streaming` with EMPTY messages is not a live turn —
    // it's a reconnect target the backend marked streaming at turn-start. Its
    // checkpoint body must load so the pane shows progress and recover() can
    // reattach the SSE. (The prior behavior skipped all streaming nodes, so a
    // non-active-tree streaming node stayed a skeleton forever.)
    apiMocks.fetchTreeMessageSnapshot.mockReset();
    apiMocks.fetchTreeMessageSnapshot.mockResolvedValue({ messages: [
      { id: 'u', node_id: 'n1', role: 'user', content: 'q', seq: 0, created_at: 1 },
      { id: 'a', node_id: 'n1', role: 'assistant', content: 'partial', seq: 1, created_at: 2 },
    ] });
    const nodesRef = {
      current: { n1: node({ status: 'streaming', messages: [] }) },
    } as MutableRefObject<Record<string, ChatNodeState>>;
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const reconnectStreamingRef = { current: vi.fn<(nodeId: string) => void>() };

    renderHook(() => useLazyTreeMessages({
      hydrated: true,
      activeProjectId: 'ws-1',
      projects: [project(1)],
      nodesRef,
      dispatch,
      reconnectStreamingRef,
    }));

    await vi.waitFor(() => expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'messages-loaded', nodeIds: ['n1'],
    })));
    await vi.waitFor(() => expect(reconnectStreamingRef.current).toHaveBeenCalledWith('n1'));
  });

  it('does not reattach a streaming placeholder whose turn ended before its body loaded', async () => {
    // Replaying from the cursor read at hydration would append the turn's
    // output to the finished body a second time.
    apiMocks.fetchTreeMessageSnapshot.mockReset().mockResolvedValue({
      messages: [
        { id: 'u', node_id: 'n1', role: 'user', content: 'q', seq: 0, created_at: 1 },
        { id: 'a', node_id: 'n1', role: 'assistant', content: 'final answer', seq: 1, created_at: 2 },
      ],
      turns: [{ node_id: 'n1', turn_id: 'turn-1', status: 'completed', last_seq: 629, error: null, completed_at: 3 }],
    });
    const nodesRef = {
      current: { n1: node({ status: 'streaming', activeTurnId: 'turn-1', lastAppliedTurnId: 'turn-1', lastAppliedSeq: 120 }) },
    } as MutableRefObject<Record<string, ChatNodeState>>;
    const dispatch = (action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); };
    const reconnectStreamingRef = { current: vi.fn<(nodeId: string) => void>() };

    renderHook(() => useLazyTreeMessages({
      hydrated: true, activeProjectId: 'ws-1', projects: [project(1)], nodesRef, dispatch, reconnectStreamingRef,
    }));

    await vi.waitFor(() => expect(nodesRef.current.n1.messagesLoaded).toBe(true));
    expect(nodesRef.current.n1).toMatchObject({ status: 'idle', lastAppliedTurnId: 'turn-1', lastAppliedSeq: 629 });
    expect(nodesRef.current.n1.messages.map((message) => message.streaming)).toEqual([false, false]);
    expect(reconnectStreamingRef.current).not.toHaveBeenCalled();
  });
});

function twoNodeProject(overrides: Partial<Project> = {}): Project {
  return {
    ...project(1), chatIds: ['n1', 'n2'], edges: [{ source: 'n1', target: 'n2' }], ...overrides,
  } as Project;
}

describe('useLazyTreeMessages read lifetime', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps one read through new project objects with the same placeholders', async () => {
    const pending = deferred<{ messages: unknown[] }>();
    apiMocks.fetchTreeMessageSnapshot.mockReset().mockReturnValue(pending.promise);
    const nodesRef = { current: { n1: node() } };
    const dispatch = vi.fn();
    const { rerender } = renderHook(({ activeProject }) => useLazyTreeMessages({
      hydrated: true, activeProjectId: 'ws-1', projects: [activeProject], nodesRef, dispatch,
    }), { initialProps: { activeProject: project(1) } });
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
    const signal = apiMocks.fetchTreeMessageSnapshot.mock.calls[0][3] as AbortSignal;
    // touch-tree, a structure re-read: new objects, nothing new to load.
    rerender({ activeProject: project(2) });
    await act(async () => { await Promise.resolve(); });
    rerender({ activeProject: { ...project(3), name: 'Renamed' } });
    await act(async () => { await Promise.resolve(); });
    expect(signal.aborted).toBe(false);
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ messages: [
      { id: 'm', node_id: 'n1', role: 'user', content: 'kept', seq: 0, created_at: 1 },
    ] }));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'messages-loaded', nodeIds: ['n1'] }));
  });

  it('keeps the read when a placeholder loads elsewhere, and reads again for a new placeholder', async () => {
    apiMocks.fetchTreeMessageSnapshot.mockReset().mockReturnValue(new Promise(() => {}));
    const nodesRef = { current: { n1: node(), n2: node({ nodeId: 'n2' }) } as Record<string, ChatNodeState> };
    const dispatch = vi.fn();
    const { rerender } = renderHook(({ activeProject }) => useLazyTreeMessages({
      hydrated: true, activeProjectId: 'ws-1', projects: [activeProject], nodesRef, dispatch,
    }), { initialProps: { activeProject: twoNodeProject() } });
    const first = apiMocks.fetchTreeMessageSnapshot.mock.calls[0][3] as AbortSignal;
    nodesRef.current = { ...nodesRef.current, n2: node({ nodeId: 'n2', messagesLoaded: true }) };
    rerender({ activeProject: twoNodeProject() });
    await act(async () => { await Promise.resolve(); });
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
    expect(first.aborted).toBe(false);

    nodesRef.current = { ...nodesRef.current, n3: node({ nodeId: 'n3' }) };
    rerender({ activeProject: twoNodeProject({ chatIds: ['n1', 'n2', 'n3'],
      edges: [{ source: 'n1', target: 'n2' }, { source: 'n1', target: 'n3' }] }) });
    await act(async () => { await Promise.resolve(); });
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(2);
    expect(first.aborted).toBe(true);
  });

  it('keeps a foreground read through watch-feed updates and installs it once it lands', async () => {
    const pending = deferred<{ messages: unknown[]; pages: unknown[] }>();
    apiMocks.fetchTreeMessagePage.mockReset().mockReturnValue(pending.promise);
    const nodesRef = { current: { n1: node({ messageCount: 1 }), n2: node({ nodeId: 'n2' }) } as Record<string, ChatNodeState> };
    const dispatch = vi.fn((action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); });
    const { rerender } = renderHook(({ activeProject }) => useLazyTreeMessages({
      hydrated: true, activeProjectId: 'ws-1', projects: [activeProject], nodesRef, dispatch,
    }), { initialProps: { activeProject: twoNodeProject({ backendConnectionId: 'remote-a' }) } });
    const signal = apiMocks.fetchTreeMessagePage.mock.calls[0][3] as AbortSignal;
    // The watch feed: n1 gets a title, a status and a larger count; n2 loads
    // elsewhere (its pane's self-heal), which re-keys the loader's effect.
    nodesRef.current = {
      n1: node({ title: 'Named meanwhile', status: 'error', messageCount: 2, followUps: [] }),
      n2: node({ nodeId: 'n2', messagesLoaded: true }),
    };
    rerender({ activeProject: twoNodeProject({ backendConnectionId: 'remote-a' }) });
    await act(async () => { await Promise.resolve(); });
    expect(signal.aborted).toBe(false);
    expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({
      messages: [
        { id: 'u', node_id: 'n1', role: 'user', content: 'q', seq: 0, created_at: 1 },
        { id: 'a', node_id: 'n1', role: 'assistant', content: 'answer', seq: 1, created_at: 2 },
      ],
      pages: [{ nodeId: 'n1', total: 2, before: null }, { nodeId: 'n2', total: 2, before: null }],
    }));
    expect(nodesRef.current.n1).toMatchObject({ messagesLoaded: true, title: 'Named meanwhile' });
    expect(nodesRef.current.n1.messages.map((message) => message.id)).toEqual(['u', 'a']);
    expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
  });

  it('reads a node again when its count grew past what the in-flight read found', async () => {
    vi.useFakeTimers();
    const first = deferred<{ messages: unknown[]; pages: unknown[] }>();
    apiMocks.fetchTreeMessagePage.mockReset().mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      messages: [
        { id: 'u', node_id: 'n1', role: 'user', content: 'q', seq: 0, created_at: 1 },
        { id: 'a', node_id: 'n1', role: 'assistant', content: 'a', seq: 1, created_at: 2 },
        { id: 'u2', node_id: 'n1', role: 'user', content: 'q2', seq: 2, created_at: 3 },
      ],
      pages: [{ nodeId: 'n1', total: 3, before: null }],
    });
    const nodesRef = { current: { n1: node() } as Record<string, ChatNodeState> };
    const dispatch = vi.fn((action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); });
    renderHook(() => useLazyTreeMessages({
      hydrated: true, activeProjectId: 'ws-1', projects: [{ ...project(1), backendConnectionId: 'remote-a' }], nodesRef, dispatch,
    }));
    nodesRef.current = { n1: node({ messageCount: 3 }) };
    await act(async () => first.resolve({
      messages: [
        { id: 'u', node_id: 'n1', role: 'user', content: 'q', seq: 0, created_at: 1 },
        { id: 'a', node_id: 'n1', role: 'assistant', content: 'a', seq: 1, created_at: 2 },
      ],
      pages: [{ nodeId: 'n1', total: 2, before: null }],
    }));
    expect(nodesRef.current.n1.messagesLoaded).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledTimes(2);
    expect(nodesRef.current.n1.messages.map((message) => message.id)).toEqual(['u', 'a', 'u2']);
  });

  it('leaves a node the tree read does not include as a placeholder without rereading the tree', async () => {
    vi.useFakeTimers();
    apiMocks.fetchTreeMessagePage.mockReset().mockResolvedValue({
      messages: [{ id: 'm', node_id: 'n1', role: 'user', content: 'present', seq: 0, created_at: 1 }],
      pages: [{ nodeId: 'n1', total: 1, before: null }],
    });
    const nodesRef = { current: { n1: node(), n2: node({ nodeId: 'n2' }) } as Record<string, ChatNodeState> };
    const dispatch = (action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); };
    const projects = [twoNodeProject({ backendConnectionId: 'remote-a' })];
    renderHook(() => useLazyTreeMessages({ hydrated: true, activeProjectId: 'ws-1', projects, nodesRef, dispatch }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(nodesRef.current.n1.messagesLoaded).toBe(true);
    // Never an empty thread for a node with history the server did not report.
    expect(nodesRef.current.n2).toMatchObject({ messagesLoaded: false, messages: [], messageCount: 2 });
    expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
  });
});

describe('useLazyTreeMessages placeholder self-heal', () => {
  afterEach(() => vi.useRealTimers());

  it('loads a node the active tree does not cover through its own thread', async () => {
    const twoTrees: Project = {
      ...project(1), chatIds: ['n1', 'n2'], backendConnectionId: 'remote-a',
      trees: [...project(1).trees, { id: 'tree-2', rootNodeId: 'n2', createdAt: 1, lastActiveAt: 1 }],
    };
    apiMocks.fetchTreeMessagePage.mockReset().mockImplementation(async (_ws, treeId: string) => (treeId === 'tree-1'
      ? { messages: [], pages: [] }
      : { messages: [{ id: 'm', node_id: 'n2', role: 'user', content: 'other tree', seq: 0, created_at: 1 }],
        pages: [{ nodeId: 'n2', total: 1, before: null }] }));
    const nodesRef = { current: { n1: node({ messagesLoaded: true, messageCount: 0 }), n2: node({ nodeId: 'n2' }) } as Record<string, ChatNodeState> };
    const dispatch = vi.fn((action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); });
    const projects = [twoTrees];
    const { result } = renderHook(() => useLazyTreeMessages({ hydrated: true, activeProjectId: 'ws-1', projects, nodesRef, dispatch }));
    expect(apiMocks.fetchTreeMessagePage).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.ensureNodeMessages('n2')).toBe('loaded'); });
    expect(apiMocks.fetchTreeMessagePage).toHaveBeenCalledExactlyOnceWith('ws-1', 'tree-2', 'remote-a', expect.any(AbortSignal), { nodeId: 'n2' });
    expect(nodesRef.current.n2.messages.map((message) => message.text)).toEqual(['other tree']);
  });

  it('joins the loader read already covering the node instead of reading it again', async () => {
    const pending = deferred<{ messages: unknown[] }>();
    apiMocks.fetchTreeMessageSnapshot.mockReset().mockReturnValue(pending.promise);
    apiMocks.fetchTreeMessagePage.mockReset();
    const nodesRef = { current: { n1: node() } as Record<string, ChatNodeState> };
    const dispatch = vi.fn((action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); });
    const projects = [project(1)];
    const { result } = renderHook(() => useLazyTreeMessages({ hydrated: true, activeProjectId: 'ws-1', projects, nodesRef, dispatch }));
    let healed: Promise<string> | undefined;
    act(() => { healed = result.current.ensureNodeMessages('n1'); });
    await act(async () => pending.resolve({ messages: [
      { id: 'm', node_id: 'n1', role: 'user', content: 'once', seq: 0, created_at: 1 },
    ] }));
    await act(async () => { expect(await healed).toBe('loaded'); });
    expect(apiMocks.fetchTreeMessageSnapshot).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchTreeMessagePage).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
