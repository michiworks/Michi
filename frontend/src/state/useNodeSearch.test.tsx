import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  confirmBackendConnection, markBackendConnectionProvisional, markBackendConnectionReady, markBackendConnectionUnavailable,
} from '../config/backendConnectionState';
import { readNodeSearchAnswer, REMOTE_SEARCH_TIMEOUT_MS, useNodeSearch } from './useNodeSearch';

const api = vi.hoisted(() => ({ searchNodesGrouped: vi.fn() }));
vi.mock('../services/api', () => api);

const HIT = {
  nodeId: 'n1',
  nodeTitle: 'Schema naming',
  workspaceId: 'w1',
  workspaceName: 'agent-desk',
  treeId: 't1',
  lastMessageAt: 5,
  totalMatches: 2,
  breadcrumb: ['Root', 'Schema naming'],
  snippets: [{ messageId: 'm1', role: 'user', snippet: 'the <mark>schema</mark>' }],
};

beforeEach(() => {
  api.searchNodesGrouped.mockReset();
});

describe('readNodeSearchAnswer', () => {
  it('keeps a well-formed answer as it is', () => {
    expect(readNodeSearchAnswer({ results: [HIT], totalNodes: 1 })).toEqual({ results: [HIT], totalNodes: 1 });
  });

  it('reads anything without a results list as no results', () => {
    for (const raw of [undefined, null, 'oops', 42, [], {}, { results: 'x' }, { error: 'boom' }, { results: { n1: HIT } }]) {
      expect(readNodeSearchAnswer(raw)).toEqual({ results: [], totalNodes: 0 });
    }
  });

  it('drops hits it cannot show and fills what a hit left out', () => {
    const answer = readNodeSearchAnswer({
      results: [
        null,
        'n2',
        { nodeTitle: 'no id' },
        { nodeId: 'n3', workspaceId: 'w1' },
        { ...HIT, nodeId: 'n4', breadcrumb: ['ok', 7, null], snippets: [null, { snippet: 3 }, { role: 'assistant', snippet: 'kept' }] },
      ],
    });
    expect(answer.results.map((r) => r.nodeId)).toEqual(['n3', 'n4']);
    expect(answer.results[0]).toEqual({
      nodeId: 'n3', nodeTitle: null, workspaceId: 'w1', workspaceName: '', treeId: null,
      lastMessageAt: 0, totalMatches: 0, breadcrumb: [], snippets: [],
    });
    expect(answer.results[1].breadcrumb).toEqual(['ok']);
    expect(answer.results[1].snippets).toEqual([{ messageId: '', role: 'assistant', snippet: 'kept' }]);
    // Without a count, the hits kept are the count.
    expect(answer.totalNodes).toBe(2);
  });
});

describe('useNodeSearch', () => {
  it('shows no results, instead of crashing, when the answer has no results list', async () => {
    api.searchNodesGrouped.mockResolvedValue({ error: 'search index rebuilding' });
    const { result } = renderHook(() => useNodeSearch('schema'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toEqual({ nodes: [], totalNodes: 0, status: 'ready' });
  });

  it('reports a failed search as failed, not as no results', async () => {
    api.searchNodesGrouped.mockRejectedValue(new Error('backend unreachable'));
    const { result } = renderHook(() => useNodeSearch('schema'));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.nodes).toEqual([]);
  });

  it('shows the hits of a well-formed answer', async () => {
    api.searchNodesGrouped.mockResolvedValue({ results: [HIT], totalNodes: 1 });
    const { result } = renderHook(() => useNodeSearch('schema'));
    await waitFor(() => expect(result.current.nodes).toHaveLength(1));
    expect(result.current.totalNodes).toBe(1);
    expect(api.searchNodesGrouped).toHaveBeenCalledWith('schema', undefined, 30, { connectionId: 'local', signal: expect.any(AbortSignal) });
  });
});

describe('useNodeSearch across backends', () => {
  const REMOTE_HIT = { ...HIT, nodeId: 'remote:r1:n9', workspaceId: 'remote:r1:w9', lastMessageAt: 9 };
  const OLD_HIT = { ...HIT, nodeId: 'n0', lastMessageAt: 1 };
  const calledBackends = () => api.searchNodesGrouped.mock.calls.map((call) => call[3].connectionId);

  afterEach(() => { vi.useRealTimers(); });

  it('asks the local backend and each connected remote once, and merges their hits by recency', async () => {
    api.searchNodesGrouped.mockImplementation(async (_q: string, _w: unknown, _l: number, { connectionId }: { connectionId: string }) =>
      connectionId === 'r1' ? { results: [REMOTE_HIT], totalNodes: 4 } : { results: [HIT, OLD_HIT], totalNodes: 2 });
    const { result } = renderHook(() => useNodeSearch('schema', ['r1', 'local', 'r1']));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(calledBackends().sort()).toEqual(['local', 'r1']);
    expect(result.current.nodes.map((r) => r.nodeId)).toEqual(['remote:r1:n9', 'n1', 'n0']);
    expect(result.current.totalNodes).toBe(6);
  });

  it('never asks a remote that is not connected', async () => {
    markBackendConnectionUnavailable('r-down');
    markBackendConnectionProvisional('r-cached');
    try {
      api.searchNodesGrouped.mockResolvedValue({ results: [HIT], totalNodes: 1 });
      const { result } = renderHook(() => useNodeSearch('schema', ['r-down', 'r-cached']));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(calledBackends()).toEqual(['local']);
      expect(result.current.nodes.map((r) => r.nodeId)).toEqual(['n1']);
    } finally {
      markBackendConnectionReady('r-down');
      confirmBackendConnection('r-cached');
    }
  });

  it('shows the other hits, and no failure, when a remote fails', async () => {
    api.searchNodesGrouped.mockImplementation(async (_q: string, _w: unknown, _l: number, { connectionId }: { connectionId: string }) => {
      if (connectionId === 'r1') throw new Error('remote unreachable');
      return { results: [], totalNodes: 0 };
    });
    const { result } = renderHook(() => useNodeSearch('schema', ['r1']));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.nodes).toEqual([]);
  });

  it('shows a remote\'s hits when only the local search failed', async () => {
    api.searchNodesGrouped.mockImplementation(async (_q: string, _w: unknown, _l: number, { connectionId }: { connectionId: string }) => {
      if (connectionId === 'local') throw new Error('local search failed');
      return { results: [REMOTE_HIT], totalNodes: 1 };
    });
    const { result } = renderHook(() => useNodeSearch('schema', ['r1']));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.nodes.map((r) => r.nodeId)).toEqual(['remote:r1:n9']);
  });

  it('shows local hits while a remote is still answering, then leaves out a remote that never answers', async () => {
    vi.useFakeTimers();
    let remoteSignal: AbortSignal | undefined;
    api.searchNodesGrouped.mockImplementation((_q: string, _w: unknown, _l: number, { connectionId, signal }: { connectionId: string; signal: AbortSignal }) => {
      if (connectionId === 'local') return Promise.resolve({ results: [HIT], totalNodes: 1 });
      remoteSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const { result } = renderHook(() => useNodeSearch('schema', ['r1']));
    await act(async () => {});
    expect(result.current).toEqual({ nodes: [HIT], totalNodes: 1, status: 'loading' });
    await act(async () => { vi.advanceTimersByTime(REMOTE_SEARCH_TIMEOUT_MS); });
    expect(remoteSignal?.aborted).toBe(true);
    expect(result.current).toEqual({ nodes: [HIT], totalNodes: 1, status: 'ready' });
  });
});
