import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import { ChatNodeStoreContext } from './chatStore';
import { resetPendingSightingsForTest } from './backgroundWork';
import type { ChatNodeState, SubagentInfo } from './chatTypes';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, type WorkflowDomainApi } from './workflowDomain';
import { useHoldBackgroundSubagentFeeds, useRunningWorkNodeIds } from './runningWork';

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return { sessionName: '', agentName: '', initialQuery: '', status: 'working', group: '', dependsOn: [], ...patch };
}

/** An idle conversation whose last turn left `roster` behind. */
function chat(nodeId: string, roster: SubagentInfo[], projectId = 'ws', text = ''): ChatNodeState {
  return {
    nodeId, kind: 'chat', chatId: null, projectId, followUps: [], status: 'idle',
    messages: [{ id: `${nodeId}-a1`, role: 'assistant', text, toolCalls: [], subagents: roster }],
  } as ChatNodeState;
}

const inBackground = (sessionId: string) => subagent({ sessionId, status: 'terminated', background: true, startedAt: 1_000 });

function run(patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 {
  return {
    version: 1, id: 'wfr_1', runtime: 'kiro', nativeId: 'wf', workspaceId: 'ws', nodeId: 'n3', parentToolCallId: null,
    name: 'probe', status: 'running', nodes: [], log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
    ...patch,
  };
}

/** A nodes store the test drives directly, like ChatProvider's commits. */
function nodeStore(initial: Record<string, ChatNodeState>) {
  let nodes = initial;
  const listeners = new Set<() => void>();
  const value = {
    getNode: (id: string) => nodes[id],
    getNodes: () => nodes,
    subscribeNode: () => () => {},
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getStructureVersion: () => 0,
    subscribeStructure: () => () => {},
  };
  return {
    value,
    patch(next: Record<string, ChatNodeState>) { nodes = { ...nodes, ...next }; for (const listener of listeners) listener(); },
  };
}

function feedApi() {
  const handlers = new Map<string, Parameters<WorkflowDomainApi['subscribe']>[1]>();
  const unsubscribed: string[] = [];
  const api: WorkflowDomainApi = {
    get: vi.fn(), act: vi.fn(), answer: vi.fn(),
    subscribe: vi.fn((workspaceId: string, options) => {
      handlers.set(workspaceId, options);
      return () => { unsubscribed.push(workspaceId); };
    }),
  };
  return { api, handlers, unsubscribed };
}

beforeEach(() => {
  resetPendingSightingsForTest();
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
  resetPendingSightingsForTest();
});

describe('useRunningWorkNodeIds', () => {
  it('lists conversations whose background agents or workflow runs outlive their turn', () => {
    const store = nodeStore({ n1: chat('n1', [inBackground('bg1')]), n2: chat('n2', [inBackground('bg2')]), n3: chat('n3', []) });
    const { api, handlers } = feedApi();
    let ids: ReadonlySet<string> = new Set();
    let renders = 0;
    let domain: ReturnType<typeof useOptionalWorkflowDomain> = null;
    function Probe() {
      renders += 1;
      domain = useOptionalWorkflowDomain();
      ids = useRunningWorkNodeIds();
      return null;
    }
    render(
      <ChatNodeStoreContext.Provider value={store.value}>
        <WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>
      </ChatNodeStoreContext.Provider>,
    );
    // Liveness unknown: the rosters say both still run.
    expect([...ids].sort()).toEqual(['n1', 'n2']);

    // Unrelated commits (a reply streaming elsewhere) leave the set alone.
    const before = renders;
    const kept = ids;
    act(() => store.patch({ n3: chat('n3', [], 'ws', 'Hel') }));
    act(() => store.patch({ n3: chat('n3', [], 'ws', 'Hello') }));
    expect(renders).toBe(before);
    expect(ids).toBe(kept);

    act(() => { domain!.subscribeWorkspace('ws'); });
    // n1's agent ran in a process that ended; n2's still runs.
    act(() => handlers.get('ws')!.onBackgroundSubagents?.({ snapshot: true, nodes: { n2: ['bg2'] } }));
    expect([...ids]).toEqual(['n2']);

    act(() => handlers.get('ws')!.onRun(run()));
    expect([...ids].sort()).toEqual(['n2', 'n3']);

    // n2's outcome lands; n3's run completes.
    act(() => store.patch({ n2: chat('n2', [{ ...inBackground('bg2'), outcome: 'completed' }]) }));
    act(() => handlers.get('ws')!.onRun(run({ revision: 2, status: 'completed', actions: [] })));
    expect(ids.size).toBe(0);
  });

  it('leaves out deleted conversations', () => {
    const store = nodeStore({ n1: { ...chat('n1', [inBackground('bg1')]), deletedAt: 5 } as ChatNodeState });
    const { api } = feedApi();
    let ids: ReadonlySet<string> = new Set(['unset']);
    function Probe() {
      ids = useRunningWorkNodeIds();
      return null;
    }
    render(
      <ChatNodeStoreContext.Provider value={store.value}>
        <WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>
      </ChatNodeStoreContext.Provider>,
    );
    expect(ids.size).toBe(0);
  });
});

describe('useHoldBackgroundSubagentFeeds', () => {
  it('keeps the feed of each workspace with a pending background agent live until none is pending', () => {
    const store = nodeStore({
      n1: chat('n1', [inBackground('bg1')], 'ws-a'),
      n2: chat('n2', [subagent({ sessionId: 'fg', status: 'terminated', outcome: 'completed' })], 'ws-b'),
    });
    const { api, handlers, unsubscribed } = feedApi();
    function Probe() {
      useHoldBackgroundSubagentFeeds();
      return null;
    }
    const view = render(
      <ChatNodeStoreContext.Provider value={store.value}>
        <WorkflowDomainProvider api={api}><Probe /></WorkflowDomainProvider>
      </ChatNodeStoreContext.Provider>,
    );
    expect([...handlers.keys()]).toEqual(['ws-a']);

    // The feed says no process tracks it: still pending by its roster, so the
    // feed that said so stays live rather than dropping its answer.
    act(() => handlers.get('ws-a')!.onBackgroundSubagents?.({ snapshot: true, nodes: {} }));
    act(() => store.patch({ n3: chat('n3', [inBackground('bg3')], 'ws-b') }));
    expect([...handlers.keys()]).toEqual(['ws-a', 'ws-b']);
    expect(unsubscribed).toEqual([]);
    expect(api.subscribe).toHaveBeenCalledTimes(2);

    act(() => store.patch({ n1: chat('n1', [{ ...inBackground('bg1'), outcome: 'completed' }], 'ws-a') }));
    expect(unsubscribed).toEqual(['ws-a']);

    view.unmount();
    expect(unsubscribed).toEqual(['ws-a', 'ws-b']);
  });
});
