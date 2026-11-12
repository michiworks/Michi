import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFocusedNodeSeen, useShownNodesSeen } from './useCompletionSeen';
import { resetCompanionPanelForTests, setCompanionPanelTab, useCompanionPanelShownNodeIds } from './companion/companionPanel';
import { resetCompanionStoreForTests } from './companion/companionStore';
import type { AssistantInfo } from '../services/api/assistant';
import type { ChatNodeState } from './chatTypes';

// Herdr's seen rule in the renderer: the focused node's completions are seen
// only while this window is focused and visible.

describe('useFocusedNodeSeen', () => {
  it('records unseen completions only while the window is in front', () => {
    const dispatch = vi.fn();
    let attentive = false;
    const hook = renderHook(
      ({ nodeId, seq, seen }: { nodeId: string | null; seq?: number; seen?: number }) =>
        useFocusedNodeSeen(nodeId, seq, seen, dispatch, () => attentive),
      { initialProps: { nodeId: 'n1', seq: 2, seen: 1 } as { nodeId: string | null; seq?: number; seen?: number } },
    );
    expect(dispatch, 'focused node, but the window is in the background').not.toHaveBeenCalled();

    attentive = true;
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(dispatch.mock.calls).toEqual([[{ type: 'node-viewed', nodeId: 'n1', viewedAt: expect.any(Number), seen: true }]]);

    dispatch.mockClear();
    hook.rerender({ nodeId: 'n1', seq: 2, seen: 2 });
    act(() => { window.dispatchEvent(new Event('focus')); });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(dispatch, 'nothing new to see').not.toHaveBeenCalled();

    hook.rerender({ nodeId: 'n1', seq: 3, seen: 2 });
    expect(dispatch, 'a completion that lands while the user looks is seen at once').toHaveBeenCalledTimes(1);

    dispatch.mockClear();
    hook.rerender({ nodeId: 'n2', seq: undefined, seen: undefined });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(dispatch, 'a node without server facts').not.toHaveBeenCalled();

    hook.rerender({ nodeId: null, seq: 5, seen: 0 });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(dispatch, 'no focused node').not.toHaveBeenCalled();
    hook.unmount();
  });
});

describe('the ⌘J panel sees its conversation like a focused pane', () => {
  afterEach(() => {
    act(() => {
      resetCompanionPanelForTests();
      resetCompanionStoreForTests();
    });
  });

  const node = (nodeId: string, completionSeq?: number, seenCompletionSeq?: number): ChatNodeState => ({
    nodeId, kind: 'chat', chatId: nodeId, projectId: 'system', messages: [], followUps: [], status: 'idle',
    ...(completionSeq !== undefined ? { completionSeq, seenCompletionSeq } : {}),
  });
  const info: AssistantInfo = {
    nodeId: 'assistant', workspaceId: 'system', treeId: 't',
    settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'],
  };

  it('records the shown conversation seen only while it is shown and the window is in front', () => {
    const dispatch = vi.fn();
    let attentive = true;
    const hook = renderHook(({ nodes }: { nodes: Record<string, ChatNodeState> }) =>
      useShownNodesSeen(useCompanionPanelShownNodeIds(), nodes, dispatch, () => attentive),
    { initialProps: { nodes: { assistant: node('assistant', 3, 1) } } });
    expect(dispatch, 'the panel is closed').not.toHaveBeenCalled();

    act(() => {
      resetCompanionStoreForTests({ assistant: { status: 'ready', info, error: null } });
      resetCompanionPanelForTests({ open: true, tab: 'chat' });
    });
    expect(dispatch.mock.calls).toEqual([[{ type: 'node-viewed', nodeId: 'assistant', viewedAt: expect.any(Number), seen: true }]]);

    dispatch.mockClear();
    attentive = false;
    hook.rerender({ nodes: { assistant: node('assistant', 4, 3) } });
    expect(dispatch, 'a reply lands while the window is in the background').not.toHaveBeenCalled();
    attentive = true;
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(dispatch).toHaveBeenCalledTimes(1);

    dispatch.mockClear();
    act(() => { resetCompanionPanelForTests({ open: false }); });
    hook.rerender({ nodes: { assistant: node('assistant', 5, 4) } });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(dispatch, 'closed again').not.toHaveBeenCalled();
    hook.unmount();
  });

  it('on Today the panel shows none, and back on Chat it shows the conversation again', () => {
    const dispatch = vi.fn();
    const nodes = { assistant: node('assistant', 2, 0), other: node('other', 2, 0) };
    act(() => {
      resetCompanionStoreForTests({ assistant: { status: 'ready', info, error: null } });
      resetCompanionPanelForTests({ open: true, tab: 'today' });
    });
    const hook = renderHook(() => useShownNodesSeen(useCompanionPanelShownNodeIds(), nodes, dispatch, () => true));
    expect(dispatch, 'the panel is open on Today').not.toHaveBeenCalled();
    act(() => { setCompanionPanelTab('chat'); });
    expect(dispatch.mock.calls.map(([action]) => action.nodeId)).toEqual(['assistant']);
    hook.unmount();
  });
});
