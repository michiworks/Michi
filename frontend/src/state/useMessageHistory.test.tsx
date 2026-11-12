import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAction, ChatNodeState, Project } from './chatTypes';
import { reduceNodes } from './chatReducers';
import { visibleMessageText } from './assistantBlocks';
import { markBackendConnectionReady, markBackendConnectionUnavailable } from '../config/backendConnectionState';

const api = vi.hoisted(() => ({ fetchTreeMessagePage: vi.fn() }));
vi.mock('../services/api/persistence', () => api);
import { useMessageHistory } from './useMessageHistory';

const project: Project = { id: 'ws', name: 'Remote', chatIds: ['n'], createdAt: 1, artifacts: [], edges: [],
  trees: [{ id: 'tree', rootNodeId: 'n', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 'tree', backendConnectionId: 'remote-1' };
const row = (seq: number, content = `text ${seq}`) => ({ id: `m${seq}`, node_id: 'n', seq, role: 'assistant', content, created_at: 1 });
function fixture() {
  const nodesRef = { current: { n: { nodeId: 'n', projectId: 'ws', kind: 'chat', chatId: 'n',
    messages: [{ id: 'm50', role: 'assistant', text: 'live', toolCalls: [], createdAt: 1 }],
    messagesLoaded: false, historyBefore: { id: 'm50', seq: 50 }, messageCount: 51,
    followUps: [], status: 'idle', lastAppliedTurnId: 'turn', lastAppliedSeq: 8,
  } } as Record<string, ChatNodeState> };
  const projectsRef = { current: [project] };
  const dispatch = vi.fn((action: ChatAction) => { nodesRef.current = reduceNodes(nodesRef.current, action); });
  return { nodesRef, projectsRef, dispatch };
}

describe('paged history transitions', () => {
  beforeEach(() => { api.fetchTreeMessagePage.mockReset(); });

  it('shares concurrent older reads and keeps live chunks received during the request', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    api.fetchTreeMessagePage.mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    const first = result.current.loadOlderMessages('n');
    const second = result.current.loadOlderMessages('n');
    f.nodesRef.current.n = { ...f.nodesRef.current.n, messages: [{ ...f.nodesRef.current.n.messages[0], text: 'advanced' }], lastAppliedSeq: 9 };
    await act(async () => { resolve({ messages: [row(49), row(50, 'stale')], pages: [{ nodeId: 'n', total: 51, before: { seq: 49, id: 'm49' } }] }); await Promise.all([first, second]); });
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    expect(f.nodesRef.current.n.messages.map(visibleMessageText)).toEqual(['text 49', 'advanced']);
    expect(f.nodesRef.current.n.lastAppliedSeq).toBe(9);
  });

  it('fills older context page by page below the loaded tail and preserves that tail', async () => {
    const f = fixture();
    api.fetchTreeMessagePage
      .mockResolvedValueOnce({ messages: [row(49)], pages: [{ nodeId: 'n', total: 51, before: { seq: 49, id: 'm49' } }] })
      .mockResolvedValueOnce({ messages: [row(0)], pages: [{ nodeId: 'n', total: 51, before: null }] });
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    const complete = await result.current.ensureCompleteHistory(['n']);
    expect(complete.n.messages.map(visibleMessageText)).toEqual(['text 0', 'text 49', 'live']);
    expect(complete.n.messagesLoaded).toBe(true);
    expect(complete.n.historyBefore).toBeUndefined();
    expect(complete.n.messageCount).toBe(51);
    // Only this node's history, never its thread's whole snapshot.
    expect(api.fetchTreeMessagePage.mock.calls.map(call => call.slice(0, 3).concat(call[4]))).toEqual([
      ['ws', 'tree', 'remote-1', { nodeId: 'n', limit: 200, before: { id: 'm50', seq: 50 } }],
      ['ws', 'tree', 'remote-1', { nodeId: 'n', limit: 200, before: { seq: 49, id: 'm49' } }],
    ]);
  });

  it('loads a placeholder from its latest page down, with the turn row read with those bodies', async () => {
    const f = fixture();
    f.nodesRef.current.n = { ...f.nodesRef.current.n, messages: [], historyBefore: undefined, status: 'streaming',
      lastAppliedBackgroundTurnId: 'turn', lastAppliedBackgroundSeq: 2 };
    api.fetchTreeMessagePage
      .mockResolvedValueOnce({ messages: [row(1), row(2, 'checkpoint')], pages: [{ nodeId: 'n', total: 3, before: { seq: 1, id: 'm1' } }],
        turns: [{ node_id: 'n', turn_id: 'turn', status: 'active', last_seq: 30, error: null, completed_at: null }] })
      .mockResolvedValueOnce({ messages: [row(0)], pages: [{ nodeId: 'n', total: 3, before: null }], turns: [] });
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    const complete = await result.current.ensureCompleteHistory(['n']);
    expect(complete.n.messages.map(visibleMessageText)).toEqual(['text 0', 'text 1', 'checkpoint']);
    expect(complete.n.messagesLoaded).toBe(true);
    expect(complete.n).toMatchObject({ status: 'streaming', activeTurnId: 'turn',
      lastAppliedBackgroundTurnId: 'turn', lastAppliedBackgroundSeq: 30 });
    expect(api.fetchTreeMessagePage.mock.calls[0][4]).toEqual({ nodeId: 'n', limit: 200 });
  });

  it('takes a gateway without pages at its one whole-thread answer', async () => {
    const f = fixture();
    const other = { ...row(7), id: 'other-7', node_id: 'sibling' };
    api.fetchTreeMessagePage.mockResolvedValueOnce({ messages: [row(0), row(49), other, row(50, 'stale')] });
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    const complete = await result.current.ensureCompleteHistory(['n']);
    expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    expect(complete.n.messages.map(visibleMessageText)).toEqual(['text 0', 'text 49', 'live']);
    expect(complete.n.messagesLoaded).toBe(true);
  });

  describe('a placeholder that changes while its history is read', () => {
    const placeholder = (f: ReturnType<typeof fixture>, overrides: Partial<ChatNodeState> = {}) => {
      f.nodesRef.current.n = { ...f.nodesRef.current.n, messages: [], historyBefore: undefined, messageCount: 1, ...overrides };
    };
    const fullPage = (text = 'answer') => ({ messages: [row(0, 'question'), row(1, text)], pages: [{ nodeId: 'n', total: 2, before: null }] });

    it('installs it when only its title, status, count or follow-ups changed, keeping the new values', async () => {
      const f = fixture();
      placeholder(f);
      let resolve!: (value: unknown) => void;
      api.fetchTreeMessagePage.mockReturnValueOnce(new Promise(done => { resolve = done; }));
      const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
      const complete = result.current.ensureCompleteHistory(['n']);
      // The watch feed and structure re-reads update these while the page is on its way.
      f.nodesRef.current.n = { ...f.nodesRef.current.n, title: 'Named meanwhile', status: 'error', messageCount: 2, followUps: ['Next?'] };
      resolve(fullPage());
      const nodes = await complete;
      expect(nodes.n).toMatchObject({ messagesLoaded: true, title: 'Named meanwhile', status: 'error', followUps: ['Next?'] });
      expect(nodes.n.messages.map(visibleMessageText)).toEqual(['question', 'answer']);
      expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(1);
    });

    it('reads it again when its turn cursor moved, and gives up after the second read', async () => {
      const f = fixture();
      placeholder(f);
      api.fetchTreeMessagePage.mockImplementationOnce(async () => {
        f.nodesRef.current.n = { ...f.nodesRef.current.n, lastAppliedSeq: 9 };
        return fullPage('stale');
      }).mockResolvedValueOnce(fullPage('fresh'));
      const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
      const nodes = await result.current.ensureCompleteHistory(['n']);
      expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(2);
      expect(nodes.n.messages.map(visibleMessageText)).toEqual(['question', 'fresh']);

      const g = fixture();
      placeholder(g);
      api.fetchTreeMessagePage.mockReset().mockImplementation(async () => {
        g.nodesRef.current.n = { ...g.nodesRef.current.n, activeTurnId: `turn-${api.fetchTreeMessagePage.mock.calls.length}` };
        return fullPage('stale');
      });
      const again = renderHook(() => useMessageHistory(g.nodesRef, g.projectsRef, g.dispatch));
      await expect(again.result.current.ensureCompleteHistory(['n'])).rejects.toThrow('Conversation changed while loading history');
      expect(api.fetchTreeMessagePage).toHaveBeenCalledTimes(2);
      expect(g.dispatch).not.toHaveBeenCalled();
    });

    it('never installs an empty history for a node that has messages', async () => {
      const f = fixture();
      placeholder(f, { messageCount: 2 });
      api.fetchTreeMessagePage.mockResolvedValueOnce({ messages: [], pages: [{ nodeId: 'n', total: 2, before: null }] });
      const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
      await expect(result.current.ensureCompleteHistory(['n'])).rejects.toThrow('Conversation changed while loading history');
      expect(f.dispatch).not.toHaveBeenCalled();
    });

    it('reattaches the live stream of a running turn it installs', async () => {
      const f = fixture();
      placeholder(f, { status: 'streaming' });
      api.fetchTreeMessagePage.mockResolvedValueOnce({ ...fullPage('checkpoint'),
        turns: [{ node_id: 'n', turn_id: 'turn', status: 'active', last_seq: 30, error: null, completed_at: null }] });
      const reconnect = { current: vi.fn() };
      const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch, reconnect));
      await result.current.ensureCompleteHistory(['n']);
      expect(reconnect.current).toHaveBeenCalledWith('n');
    });
  });

  it('reports a node its thread no longer lists instead of installing nothing as its history', async () => {
    const f = fixture();
    api.fetchTreeMessagePage.mockResolvedValueOnce({ messages: [], pages: [] });
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    await expect(result.current.ensureCompleteHistory(['n'])).rejects.toThrow('Conversation changed while loading history');
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('a failed read never installs an empty history and unmount cancels in-flight reads', async () => {
    const f = fixture();
    api.fetchTreeMessagePage.mockRejectedValueOnce(new TypeError('offline'));
    const { result, unmount } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    await expect(result.current.loadOlderMessages('n')).rejects.toThrow('offline');
    expect(f.dispatch).not.toHaveBeenCalled();
    api.fetchTreeMessagePage.mockImplementation((_ws, _tree, _connection, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = result.current.loadOlderMessages('n');
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    unmount(); await cancelled;
    expect(f.nodesRef.current.n.messages[0].text).toBe('live');
  });

  it('drops an older page when the saved connection changes, even with identical message IDs', async () => {
    const f = fixture();
    markBackendConnectionReady('remote-1');
    let resolve!: (value: unknown) => void;
    api.fetchTreeMessagePage.mockReturnValue(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useMessageHistory(f.nodesRef, f.projectsRef, f.dispatch));
    const pending = result.current.loadOlderMessages('n');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    markBackendConnectionUnavailable('remote-1', true);
    await act(async () => { resolve({ messages: [row(49)], pages: [{ nodeId: 'n', total: 51, before: null }] }); await rejected; });
    expect(f.dispatch).not.toHaveBeenCalled();
    markBackendConnectionReady('remote-1');
  });
});
