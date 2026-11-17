import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useShownFailuresSeen } from './useFailureSeen';
import { setDashboardUncovered } from './panePresenceVisibility';
import { reduceNodes } from './chatReducers';
import { nodeAttention } from './sidebarSelectors';
import type { ChatAction, ChatNodeState } from './chatTypes';

// A failure in a pane on screen counts as viewed while the window is in front,
// focused or not, so the sidebar's Failed mark clears.

const FAILED_AT = 1_000_000;

function node(nodeId: string, facts: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId, kind: 'chat', chatId: nodeId, projectId: 'w', messages: [], followUps: [], status: 'idle',
    ...facts,
  };
}
const failed = (nodeId: string, facts: Partial<ChatNodeState> = {}) =>
  node(nodeId, { status: 'error', errorKind: 'internal', errorCompletedAt: FAILED_AT, ...facts });

type Props = { panes: readonly string[]; nodes: Record<string, ChatNodeState> };

function box(left: number, width: number): DOMRect {
  return { left, right: left + width, width, top: 0, bottom: 100, height: 100, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

/** A Dashboard strip 1000px wide holding the given panes. */
function paintStrip(panes: Array<{ id: string; left: number; width?: number }>): void {
  const strip = document.createElement('div');
  strip.setAttribute('data-pane-strip', '');
  strip.getBoundingClientRect = () => box(0, 1000);
  for (const pane of panes) {
    const wrapper = document.createElement('div');
    wrapper.dataset.nodeId = pane.id;
    wrapper.getBoundingClientRect = () => box(pane.left, pane.width ?? 500);
    strip.appendChild(wrapper);
  }
  document.body.appendChild(strip);
}

describe('useShownFailuresSeen', () => {
  afterEach(() => {
    vi.useRealTimers();
    act(() => { setDashboardUncovered(false); });
    document.body.innerHTML = '';
  });

  it('views the unviewed failures of shown panes, and only those', () => {
    const dispatch = vi.fn();
    const nodes = {
      side: failed('side'),
      viewed: failed('viewed', { viewedAt: FAILED_AT + 1 }),
      idle: node('idle'),
      noTime: failed('noTime', { errorCompletedAt: undefined }),
      closed: failed('closed'),
    };
    const hook = renderHook(() => useShownFailuresSeen(
      ['side', 'viewed', 'idle', 'noTime', 'launcher:1'], nodes, dispatch, () => true, () => true));
    expect(dispatch.mock.calls).toEqual([[{ type: 'node-viewed', nodeId: 'side', viewedAt: expect.any(Number) }]]);
    const [[action]] = dispatch.mock.calls;
    expect(action, 'completions stay unseen: unread still needs focus').not.toHaveProperty('seen');
    hook.unmount();
  });

  it('waits for the window to come to the front', () => {
    const dispatch = vi.fn();
    let attentive = false;
    const hook = renderHook(() => useShownFailuresSeen(['a'], { a: failed('a') }, dispatch, () => attentive, () => true));
    expect(dispatch, 'the window is in the background').not.toHaveBeenCalled();
    attentive = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(dispatch, 'once, though focus follows visibilitychange before the next render').toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('looks again once the strip has laid the pane out', () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    let laidOut = false;
    const hook = renderHook(() => useShownFailuresSeen(['a'], { a: failed('a') }, dispatch, () => true, () => laidOut));
    expect(dispatch, 'the first frame: not measured yet').not.toHaveBeenCalled();
    laidOut = true;
    act(() => { vi.advanceTimersByTime(300); });
    expect(dispatch).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('waits for the pane to come on screen, after the strip settles', () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    let onScreen = false;
    const shown = vi.fn((paneId: string, panes: readonly string[]) => onScreen && panes.includes(paneId));
    const hook = renderHook(() => useShownFailuresSeen(['a', 'b'], { a: node('a'), b: failed('b') }, dispatch, () => true, shown));
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(dispatch, 'scrolled out of the strip').not.toHaveBeenCalled();
    expect(shown).toHaveBeenCalledWith('b', ['a', 'b']);

    onScreen = true;
    act(() => { window.dispatchEvent(new Event('michi:dashboard-scroll')); });
    act(() => { vi.advanceTimersByTime(299); });
    expect(dispatch, 'still scrolling').not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(dispatch.mock.calls.map(([action]) => action.nodeId)).toEqual(['b']);
    hook.unmount();
  });

  it('views a failure that lands while its pane is on screen at once, and clears the mark', () => {
    let nodes: Record<string, ChatNodeState> = { a: node('a', { status: 'streaming' }), b: node('b') };
    const dispatch = vi.fn((action: ChatAction) => { nodes = reduceNodes(nodes, action); });
    const hook = renderHook(({ panes, nodes: current }: Props) =>
      useShownFailuresSeen(panes, current, dispatch, () => true, () => true),
    { initialProps: { panes: ['a', 'b'], nodes } });
    expect(dispatch).not.toHaveBeenCalled();

    nodes = { ...nodes, a: failed('a') };
    expect(nodeAttention('a', nodes.a, 'b', FAILED_AT + 10), 'the failure is marked before a look').toBe('failed');
    hook.rerender({ panes: ['a', 'b'], nodes });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(nodeAttention('a', nodes.a, 'b', FAILED_AT + 10), 'b is focused, a beside it').toBe('none');

    dispatch.mockClear();
    hook.rerender({ panes: ['a', 'b'], nodes });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(dispatch, 'nothing left to view').not.toHaveBeenCalled();
    hook.unmount();
  });

  it('stamps at least the failure time, so a gateway clock ahead of this window cannot keep the mark', () => {
    const ahead = Date.now() + 60_000;
    let nodes: Record<string, ChatNodeState> = { a: failed('a', { errorCompletedAt: ahead }) };
    const dispatch = vi.fn((action: ChatAction) => { nodes = reduceNodes(nodes, action); });
    const hook = renderHook(({ current }: { current: Record<string, ChatNodeState> }) =>
      useShownFailuresSeen(['a'], current, dispatch, () => true, () => true),
    { initialProps: { current: nodes } });
    expect(nodes.a.viewedAt).toBe(ahead);
    expect(nodeAttention('a', nodes.a, null, ahead + 1)).toBe('none');
    hook.rerender({ current: nodes });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(dispatch).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('counts a pane the strip lays out on screen, and only while nothing covers the Dashboard', () => {
    paintStrip([{ id: 'on', left: 0 }, { id: 'beside', left: 500 }, { id: 'away', left: 1200 }, { id: 'unmeasured', left: 0, width: 0 }]);
    const open = ['on', 'beside', 'away', 'unmeasured', 'unpainted'];
    const nodes = Object.fromEntries(open.map((id) => [id, failed(id)]));
    const dispatch = vi.fn();
    const hook = renderHook(() => useShownFailuresSeen(open, nodes, dispatch, () => true));
    expect(dispatch, 'another page, a dialog, or the phone panel or drawer lies over it').not.toHaveBeenCalled();

    act(() => { setDashboardUncovered(true); });
    expect(dispatch.mock.calls.map(([action]) => action.nodeId), 'the cover lifts').toEqual(['on', 'beside']);

    dispatch.mockClear();
    act(() => { setDashboardUncovered(false); });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(dispatch, 'covered again').not.toHaveBeenCalled();
    hook.unmount();
  });

  it('stops looking once its pane closes', () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    let onScreen = false;
    const hook = renderHook(({ panes, nodes }: Props) =>
      useShownFailuresSeen(panes, nodes, dispatch, () => true, () => onScreen),
    { initialProps: { panes: ['a'], nodes: { a: failed('a') } } });
    hook.rerender({ panes: [], nodes: { a: failed('a') } });
    onScreen = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(2_000);
    });
    expect(dispatch, 'the pane closed').not.toHaveBeenCalled();
    hook.unmount();
  });
});
