import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatNodeStoreContext, useChatNode, type ChatNodeState } from './chatStore';
import { createPaneShownStore, PaneShownContext } from '../hooks/paneShown';

type NodeStore = NonNullable<React.ContextType<typeof ChatNodeStoreContext>>;

function fakeNodeStore() {
  let node = { nodeId: 'n1', status: 'streaming', messages: [] } as unknown as ChatNodeState;
  const listeners = new Set<() => void>();
  const store = {
    getNode: () => node,
    subscribeNode: (_id: string, listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as unknown as NodeStore;
  const update = (patch: Partial<ChatNodeState>) => {
    node = { ...node, ...patch };
    for (const listener of [...listeners]) listener();
  };
  return { store, update };
}

describe('useChatNode in a pane off the strip (MO-25)', () => {
  it('holds the last node and renders nothing while frozen, then catches up in one render', () => {
    const { store, update } = fakeNodeStore();
    const shown = createPaneShownStore();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useChatNode('n1');
    }, {
      wrapper: ({ children }) => (
        <ChatNodeStoreContext.Provider value={store}>
          <PaneShownContext.Provider value={shown}>{children}</PaneShownContext.Provider>
        </ChatNodeStoreContext.Provider>
      ),
    });
    const first = result.current;

    act(() => shown.setFrozen(true));
    act(() => update({ title: 'chunk 1' }));
    act(() => update({ title: 'chunk 2', status: 'idle' }));
    expect(result.current).toBe(first);
    const frozenRenders = renders;

    act(() => shown.setFrozen(false));
    expect(result.current?.title).toBe('chunk 2');
    expect(result.current?.status).toBe('idle');
    expect(renders).toBe(frozenRenders + 1);

    // Live again: each change renders as before.
    act(() => update({ title: 'chunk 3' }));
    expect(result.current?.title).toBe('chunk 3');
    expect(renders).toBe(frozenRenders + 2);
  });

  it('renders nothing on a thaw when nothing changed while frozen', () => {
    const { store } = fakeNodeStore();
    const shown = createPaneShownStore();
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useChatNode('n1');
    }, {
      wrapper: ({ children }) => (
        <ChatNodeStoreContext.Provider value={store}>
          <PaneShownContext.Provider value={shown}>{children}</PaneShownContext.Provider>
        </ChatNodeStoreContext.Provider>
      ),
    });
    const before = renders;
    act(() => shown.setFrozen(true));
    act(() => shown.setFrozen(false));
    expect(renders).toBe(before);
  });
});
