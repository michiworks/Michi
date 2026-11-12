import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { ChatNodeStoreContext } from './chatStore';
import type { ChatNodeState } from './chatTypes';
import { useStreamingNodeIds } from './nodeActivity';

function chat(nodeId: string, status: ChatNodeState['status'] = 'idle'): ChatNodeState {
  return { nodeId, kind: 'chat', chatId: null, projectId: 'ws', followUps: [], status, messages: [] } as ChatNodeState;
}

/** A nodes store the test drives directly; every patch is a structural change. */
function nodeStore(initial: Record<string, ChatNodeState>) {
  let nodes = initial;
  let version = 0;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  return {
    value: {
      getNode: (id: string) => nodes[id],
      getNodes: () => nodes,
      subscribeNode: () => () => {},
      subscribe,
      getStructureVersion: () => version,
      subscribeStructure: subscribe,
    },
    patch(next: Record<string, ChatNodeState>) {
      nodes = { ...nodes, ...next };
      version += 1;
      for (const listener of listeners) listener();
    },
  };
}

describe('useStreamingNodeIds', () => {
  it('keeps one set across renders until the streaming nodes change', () => {
    const store = nodeStore({ a: chat('a'), b: chat('b', 'streaming') });
    const seen: ReadonlySet<string>[] = [];
    function Probe({ tick }: { tick: number }) {
      seen.push(useStreamingNodeIds());
      return <span>{tick}</span>;
    }
    const view = render(<ChatNodeStoreContext.Provider value={store.value as never}><Probe tick={0} /></ChatNodeStoreContext.Provider>);
    view.rerender(<ChatNodeStoreContext.Provider value={store.value as never}><Probe tick={1} /></ChatNodeStoreContext.Provider>);
    expect(seen.at(-1)).toBe(seen[0]);
    expect([...seen[0]]).toEqual(['b']);

    // A change that leaves the same nodes streaming keeps the set.
    act(() => store.patch({ a: { ...chat('a'), title: 'renamed' } }));
    expect(seen.at(-1)).toBe(seen[0]);

    act(() => store.patch({ a: chat('a', 'streaming') }));
    expect([...seen.at(-1)!].sort()).toEqual(['a', 'b']);
  });
});
