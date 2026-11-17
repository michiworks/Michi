import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAction, ChatMessage, ChatNodeState, Project, ToolCallState } from './chatTypes';
import { reduceNodes } from './chatReducers';

const api = vi.hoisted(() => ({ fetchMessageToolCalls: vi.fn(), MAX_TOOL_CALL_MESSAGES: 50 }));
vi.mock('../services/api/persistence', () => api);
import { DeferredToolCalls } from './deferredToolCalls';

const project: Project = { id: 'ws', name: 'Remote', chatIds: ['n', 'o'], createdAt: 1, artifacts: [], edges: [],
  trees: [{ id: 'tree', rootNodeId: 'n', createdAt: 1, lastActiveAt: 1 }, { id: 'other', rootNodeId: 'o', createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: 'tree', backendConnectionId: 'remote-1' };
const stub = (id: string): ToolCallState => ({ id, title: 'Bash', status: 'completed', inputJson: '{"command":"ls"}', deferred: true, hasOutput: true });
const whole = (id: string) => ({ id, title: 'Bash', status: 'completed', inputJson: '{"command":"ls"}', output: `out ${id}` });
const answer = (id: string, toolCalls: ToolCallState[]): ChatMessage => ({ id, role: 'assistant', text: 'done', toolCalls, createdAt: 1 });
const node = (nodeId: string, messages: ChatMessage[]) => ({ nodeId, projectId: 'ws', kind: 'chat', chatId: nodeId, messages,
  followUps: [], status: 'idle' }) as unknown as ChatNodeState;

function fixture() {
  const nodes = {
    current: {
      n: node('n', [answer('a1', [stub('t1'), stub('t2')]), answer('a2', [stub('t3')]), answer('a3', [whole('t4') as ToolCallState])]),
      o: node('o', [answer('b1', [stub('u1')])]),
    } as Record<string, ChatNodeState>,
  };
  const dispatch = vi.fn((action: ChatAction) => { nodes.current = reduceNodes(nodes.current, action); });
  const loader = new DeferredToolCalls({ nodes: () => nodes.current, projects: () => [project], dispatch });
  return { nodes, dispatch, loader };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('deferred tool calls', () => {
  beforeEach(() => { api.fetchMessageToolCalls.mockReset(); });

  it('reads the messages asked for in one tick in one request per node, and replaces only the deferred calls', async () => {
    const f = fixture();
    api.fetchMessageToolCalls.mockImplementation(async (_ws, _tree, _connection, _node, ids: string[]) =>
      ids.map((id) => ({ id, tool_calls: JSON.stringify(id === 'a1' ? [whole('t1'), whole('t2')] : [whole('t3')]) })));
    const untouched = f.nodes.current.n.messages[2];
    f.loader.load('n', 'a1');
    f.loader.load('n', 'a2');
    f.loader.load('n', 'a1');
    expect(f.loader.status('n', 'a1')).toBe('loading');
    await flush();
    expect(api.fetchMessageToolCalls).toHaveBeenCalledExactlyOnceWith('ws', 'tree', 'remote-1', 'n', ['a1', 'a2'], expect.any(AbortSignal));
    const [a1, a2, a3] = f.nodes.current.n.messages;
    expect(a1.toolCalls.map((tool) => [tool.output, tool.deferred])).toEqual([['out t1', undefined], ['out t2', undefined]]);
    expect(a2.toolCalls[0].output).toBe('out t3');
    expect(a3).toBe(untouched);
    expect(f.loader.status('n', 'a1')).toBeUndefined();
    // Loaded, a message asks for nothing more.
    f.loader.load('n', 'a1');
    await flush();
    expect(api.fetchMessageToolCalls).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing when a message has no deferred call or is gone', async () => {
    const f = fixture();
    f.loader.load('n', 'a3');
    f.loader.load('n', 'missing');
    f.loader.load('gone', 'a1');
    await flush();
    expect(api.fetchMessageToolCalls).not.toHaveBeenCalled();
  });

  it('marks a failed read for a retry, and a call the server no longer has stays deferred', async () => {
    const f = fixture();
    api.fetchMessageToolCalls.mockRejectedValueOnce(new Error('offline'));
    const seen: Array<string | undefined> = [];
    f.loader.subscribe(() => seen.push(f.loader.status('n', 'a1')));
    f.loader.load('n', 'a1');
    await flush();
    expect(f.loader.status('n', 'a1')).toBe('failed');
    expect(seen).toEqual(['loading', 'failed']);
    api.fetchMessageToolCalls.mockResolvedValueOnce([{ id: 'a1', tool_calls: JSON.stringify([whole('t1')]) }]);
    f.loader.load('n', 'a1');
    await flush();
    expect(f.loader.status('n', 'a1')).toBeUndefined();
    expect(f.nodes.current.n.messages[0].toolCalls.map((tool) => !!tool.deferred)).toEqual([false, true]);
  });

  it('keeps two reads in flight at most and drops what comes after it stops', async () => {
    const f = fixture();
    const pending: Array<(rows: unknown[]) => void> = [];
    api.fetchMessageToolCalls.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    f.loader.load('n', 'a1');
    f.loader.load('o', 'b1');
    await flush();
    f.loader.load('n', 'a2');
    await flush();
    expect(api.fetchMessageToolCalls).toHaveBeenCalledTimes(2);
    pending[0]([]);
    await flush();
    expect(api.fetchMessageToolCalls).toHaveBeenCalledTimes(3);
    f.loader.stop();
    pending[1]([{ id: 'b1', tool_calls: JSON.stringify([whole('u1')]) }]);
    await flush();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.nodes.current.o.messages[0].toolCalls[0].deferred).toBe(true);
    expect(f.loader.status('n', 'a2')).toBeUndefined();
  });
});
