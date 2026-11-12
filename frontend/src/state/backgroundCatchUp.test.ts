import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { behindDurable, createBackgroundCatchUp, type BackgroundCatchUpDeps } from './backgroundCatchUp';
import type { ChatNodeState } from './chatTypes';

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n-1',
    projectId: 'ws-1',
    kind: 'chat',
    chatId: 'n-1',
    messages: [],
    followUps: [],
    status: 'idle',
    lastAppliedTurnId: 'turn-1',
    lastAppliedSeq: 5,
    ...overrides,
  };
}

describe('behindDurable', () => {
  it('is behind when SQLite holds a later seq, another turn, or any turn the window never applied', () => {
    expect(behindDurable(node(), { turnId: 'turn-1', seq: 5 })).toBe(false);
    expect(behindDurable(node({ lastAppliedSeq: 8 }), { turnId: 'turn-1', seq: 5 })).toBe(false);
    expect(behindDurable(node(), { turnId: 'turn-1', seq: 6 })).toBe(true);
    expect(behindDurable(node(), { turnId: 'turn-2', seq: 0 })).toBe(true);
    expect(behindDurable(node({ lastAppliedTurnId: undefined, lastAppliedSeq: undefined }), { turnId: 'turn-1', seq: 0 })).toBe(true);
  });
});

describe('createBackgroundCatchUp', () => {
  let nodes: Record<string, ChatNodeState>;
  let foreground: Set<string>;
  let durable: Record<string, { turnId: string; seq: number; nodeId: string }>;
  let deps: BackgroundCatchUpDeps & { fetchCursors: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    nodes = {
      'n-1': node(),
      'n-2': node({ nodeId: 'n-2', chatId: null, lastAppliedTurnId: undefined, lastAppliedSeq: undefined }),
      'n-3': node({ nodeId: 'n-3', chatId: 'n-3', lastAppliedTurnId: 'turn-3', lastAppliedSeq: 1 }),
    };
    foreground = new Set();
    durable = {
      'n-1': { turnId: 'turn-1', seq: 5, nodeId: 'n-1' },
      'n-2': { turnId: 'turn-first', seq: 9, nodeId: 'n-2' },
      'n-3': { turnId: 'turn-4', seq: 0, nodeId: 'n-3' },
    };
    deps = {
      connectionIds: () => ['local'],
      nodesFor: () => Object.values(nodes),
      node: (nodeId) => nodes[nodeId],
      nodeConnection: (nodeId) => (nodes[nodeId] ? 'local' : undefined),
      foregroundActive: (nodeId) => foreground.has(nodeId),
      fetchCursors: vi.fn(async (chatIds: string[]) => Object.fromEntries(
        chatIds.filter((chatId) => durable[chatId]).map((chatId) => [chatId, durable[chatId]]),
      )),
      reconcile: vi.fn(async () => undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles exactly the chats SQLite is ahead on, keyed by node id when unbound', async () => {
    const catchUp = createBackgroundCatchUp(deps);
    catchUp.requestAll();
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.fetchCursors).toHaveBeenCalledTimes(1);
    expect(deps.fetchCursors.mock.calls[0][0]).toEqual(['n-1', 'n-2', 'n-3']);
    expect(deps.reconcile.mock.calls.map(([gap]) => gap)).toEqual([
      { chatId: 'n-2', nodeId: 'n-2', turnId: 'turn-first', seq: 9 },
      { chatId: 'n-3', nodeId: 'n-3', turnId: 'turn-4', seq: 0 },
    ]);
    catchUp.dispose();
  });

  it('coalesces requests, skips foreground-owned nodes and rechecks a node only after the interval', async () => {
    foreground.add('n-3');
    const catchUp = createBackgroundCatchUp(deps);
    catchUp.request(['n-2']);
    catchUp.request(['n-3']);
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.fetchCursors).toHaveBeenCalledTimes(1);
    expect(deps.fetchCursors.mock.calls[0][0]).toEqual(['n-2']);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);

    catchUp.request(['n-2']);
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.fetchCursors).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    catchUp.request(['n-2']);
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.fetchCursors).toHaveBeenCalledTimes(2);
    catchUp.dispose();
  });

  it('does nothing when the read fails or after dispose', async () => {
    deps.fetchCursors.mockResolvedValueOnce(null);
    const catchUp = createBackgroundCatchUp(deps);
    catchUp.requestAll();
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.reconcile).not.toHaveBeenCalled();

    catchUp.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    catchUp.requestAll();
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.fetchCursors).toHaveBeenCalledTimes(1);
  });

  it('checks an opened pane outside the workspace on screen', async () => {
    deps.nodesFor = () => [];
    const catchUp = createBackgroundCatchUp(deps);
    catchUp.request(['n-3']);
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.fetchCursors.mock.calls[0][0]).toEqual(['n-3']);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
    catchUp.dispose();
  });

  it('ignores an answer for a chat that now names another node', async () => {
    durable['n-3'] = { turnId: 'turn-4', seq: 0, nodeId: 'n-other' };
    const catchUp = createBackgroundCatchUp(deps);
    catchUp.request(['n-3']);
    await vi.advanceTimersByTimeAsync(250);
    expect(deps.reconcile).not.toHaveBeenCalled();
    catchUp.dispose();
  });
});
