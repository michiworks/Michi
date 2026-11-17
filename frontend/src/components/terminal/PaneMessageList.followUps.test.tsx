import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneMessageList } from './PaneMessageList';
import type { ChatAction, ChatNodeState } from '../../state/chatTypes';
import { reduceNodes } from '../../state/chatReducers';
import { DEFAULT_PREFS } from '../../state/prefs';

const node: ChatNodeState = {
  nodeId: 'followups-node', kind: 'chat', chatId: null, projectId: 'project',
  status: 'idle', messages: [], followUps: ['Trace the tool result', 'Check parsing', 'Review trust boundaries'],
};
const prefs = { ...DEFAULT_PREFS, enableFollowUps: true };
const noop = () => {};

function list(overrides: Partial<ChatNodeState> = {}, disabled = false, enableFollowUps = true) {
  return <PaneMessageList
    node={{ ...node, ...overrides }} prefs={{ ...prefs, enableFollowUps }} contentStyle={{}}
    streaming={overrides.status === 'streaming'}
    onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
    followUpsDisabled={disabled}
  />;
}

describe('PaneMessageList follow-ups presentation', () => {
  it('renders an unnumbered section and collapses without removing its suggestions', () => {
    render(list());
    const section = screen.getByRole('region', { name: 'Suggested follow-ups' });
    expect(within(section).getByRole('heading', { name: 'Explore further' })).toBeTruthy();
    expect(section.querySelectorAll('.t-followup-row')).toHaveLength(3);
    expect(section.querySelector('.t-followup-num, .t-followup-text svg')).toBeNull();
    // The whole heading line is the toggle.
    const toggle = within(section).getByRole('button', { name: 'Explore further' });
    expect(toggle.closest('h3')).toBe(within(section).getByRole('heading', { name: 'Explore further' }));
    const content = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(content.hidden).toBe(true);
    expect(within(section).queryByRole('button', { name: /Continue follow-up/ })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(content.hidden).toBe(false);
    expect(within(section).getAllByRole('button', { name: /Continue follow-up/ })).toHaveLength(3);
  });

  it('keeps loading free of numbered or actionable suggestions', () => {
    render(list({ status: 'streaming', followUps: [], followUpsGenerating: true }));
    const section = screen.getByRole('region', { name: 'Suggested follow-ups' });
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(within(section).getByRole('status').textContent).toBe('Preparing next steps…');
    expect(section.querySelectorAll('.t-followup-skeleton')).toHaveLength(3);
    expect(section.querySelector('.t-followup-row, .t-followup-num')).toBeNull();
  });

  it('shows no follow-ups after a failed turn', () => {
    render(list({ status: 'error', error: 'Claude authentication failed.' }));
    expect(screen.queryByRole('region', { name: 'Suggested follow-ups' })).toBeNull();
  });

  it('keeps send and branch callbacks independent through the real section', () => {
    const onContinue = vi.fn();
    const onBranch = vi.fn();
    render(React.cloneElement(list(), { onContinueFollowUp: onContinue, onBranchFollowUp: onBranch }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Continue follow-up/ })[0]);
    expect(onContinue).toHaveBeenCalledWith(node.followUps[0]);
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /^Branch follow-up/ })[1]);
    expect(onBranch).toHaveBeenCalledWith(node.followUps[1]);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('PaneMessageList follow-ups arrival', () => {
  const answer = { id: 'answer', role: 'assistant' as const, text: 'Done.', toolCalls: [] };
  const rows = () => [...screen.getByRole('region', { name: 'Suggested follow-ups' }).querySelectorAll<HTMLElement>('.t-followup-row')];
  const arriving = () => rows().map((row) => row.hasAttribute('data-arriving'));

  it('renders restored follow-ups settled', () => {
    render(list({ messages: [answer] }));
    expect(arriving()).toEqual([false, false, false]);
  });

  it('pops in the follow-ups of a turn that ended on screen, once', () => {
    const { rerender } = render(list({ status: 'streaming', followUps: [], messages: [answer] }));
    rerender(list({ messages: [answer] }));
    expect(arriving()).toEqual([true, true, true]);
    // The last row's pop has ended: the next render leaves them settled.
    fireEvent.animationEnd(rows()[2]);
    rerender(list({ messages: [answer] }));
    expect(arriving()).toEqual([false, false, false]);
  });

  it('never replays the pop when the follow-ups are collapsed and expanded again', () => {
    const { rerender } = render(list({ status: 'streaming', followUps: [], messages: [answer] }));
    rerender(list({ messages: [answer] }));
    fireEvent.click(screen.getByRole('button', { name: 'Explore further' }));
    fireEvent.click(screen.getByRole('button', { name: 'Explore further' }));
    expect(arriving()).toEqual([false, false, false]);
  });
});

describe('PaneMessageList follow-ups after a short streamed answer', () => {
  let now = 0;
  let frameId = 0;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    now = 0;
    frameId = 0;
    frames = new Map();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['before', 'after'] as const)('waits for displayed text when done arrives %s smoothing finishes', (doneTiming) => {
    let currentNode: ChatNodeState = {
      ...node,
      status: 'streaming',
      followUps: [],
      messages: [{
        id: 'answer', role: 'assistant', text: '', toolCalls: [], streaming: true,
        blocks: [{ id: 'answer-b-0', kind: 'answer', rawText: '好', streaming: true }],
      }],
    };
    const { container, rerender } = render(list(currentNode));
    const metaLine = () => container.querySelector('.t-answer-meta');
    const dispatch = (action: ChatAction) => {
      currentNode = reduceNodes({ [node.nodeId]: currentNode }, action)[node.nodeId];
    };
    const finish = () => {
      dispatch({ type: 'done', nodeId: node.nodeId, assistantId: 'answer' });
      rerender(list(currentNode));
    };

    // The answer and its metadata fit in one burst. Receiving all three
    // sentinels releases the foreground turn while its text is still draining.
    dispatch({
      type: 'chunk', nodeId: node.nodeId, assistantId: 'answer',
      text: '的。\n\n' + node.followUps.map((question, i) => `[FOLLOW-UP ${i + 1}/3: ${question}]`).join('\n'),
    });
    dispatch({ type: 'set-follow-ups', nodeId: node.nodeId, followUps: node.followUps });
    dispatch({ type: 'visible-response-complete', nodeId: node.nodeId, assistantId: 'answer' });
    rerender(list(currentNode));

    expect(screen.queryByText('好的。')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Suggested follow-ups' })).toBeNull();

    if (doneTiming === 'before') {
      finish();
      expect(screen.queryByRole('region', { name: 'Suggested follow-ups' })).toBeNull();
      // The meta line waits for the typewriter too.
      expect(metaLine()).toBeNull();
    }

    for (let i = 0; i < 20 && frames.size > 0; i++) {
      now += 100;
      const pending = [...frames.values()];
      frames.clear();
      act(() => pending.forEach(callback => callback(now)));
    }

    expect(screen.getByText('好的。')).toBeTruthy();
    const section = screen.getByRole('region', { name: 'Suggested follow-ups' });
    expect(section.querySelectorAll('.t-followup-row')).toHaveLength(3);
    if (doneTiming === 'after') {
      finish();
      // Final metadata extraction must preserve the section and its entry animation.
      expect(screen.getByRole('region', { name: 'Suggested follow-ups' })).toBe(section);
    }
    expect(metaLine()).not.toBeNull();
  });
});
