import React from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadMessageSource } from 'michi-shared';
import type { ChatMessage } from '../../state/chatTypes';
import { MessageBlock } from './MessageBlock';
import type { MultiModelBranchControls } from './multiModelBranch';

vi.mock('./multiModel/MultiModelReceipt', () => ({
  MultiModelReceipt: ({ readOnly }: { readOnly?: boolean }) => <div data-testid="mm-receipt" data-read-only={String(!!readOnly)} />,
}));


function renderMessage(m: Partial<ChatMessage>, props: Partial<React.ComponentProps<typeof MessageBlock>> = {}) {
  return render(
    <MessageBlock
      m={{ id: 'm1', role: 'user', text: 'hello', toolCalls: [], streaming: false, ...m } as ChatMessage}
      index={0}
      isDark={false}
      copyText={() => ''}
      showThoughts={false}
      fontFamily="inherit"
      density="comfortable"
      {...props}
    />,
  );
}

const from = (plan: ThreadMessageSource['plan'], patch: Partial<ThreadMessageSource> = {}): ThreadMessageSource => ({
  fromNodeId: 'caller', fromTitle: 'Memory timing', hop: 1, plan, ...patch,
});

const REVIEW = 'Below is the answer from Pi · Gemini 4 Argon. Evaluate their arguments and revise your conclusion if needed.\n\n### Pi · Gemini 4 Argon (Fresh)\nBatch when idle.';

describe('MessageBlock: messages a multi-model plan relayed', () => {
  it('captions a branch prompt with the caller\'s runtime, the step and its context', () => {
    const onMentionClick = vi.fn();
    const { container, getByRole } = renderMessage(
      { text: 'Assess it.', threadMessage: from({ runId: 'wfr_1', step: 'answer', context: 'fork', fromLabel: 'Claude Code' }) },
      { onMentionClick },
    );
    const caption = container.querySelector('.terminal-message-thread-source')!;
    expect(caption.textContent).toBe('From Claude Code · Plan step 1 · Fork');
    expect(caption.getAttribute('title')).toBe('Sent by the multi-model plan you started');
    fireEvent.click(getByRole('button', { name: 'Claude Code' }));
    expect(onMentionClick).toHaveBeenCalledWith('Memory timing', 'node', 'caller');
  });

  it('falls back to the sending thread\'s title, and numbers a review round as the card does', () => {
    const fresh = renderMessage({ text: 'Assess it.', threadMessage: from({ runId: 'wfr_1', step: 'answer', context: 'fresh' }) });
    expect(fresh.container.querySelector('.terminal-message-thread-source')?.textContent).toBe('From Memory timing · Plan step 1 · Fresh');
    fresh.unmount();
    const once = renderMessage({ text: REVIEW, threadMessage: from({ runId: 'wfr_1', step: 'review', round: 1, rounds: 1, fromLabel: 'Claude Code' }) });
    expect(once.container.querySelector('.terminal-message-thread-source')?.textContent).toBe('From Claude Code · Plan step 2 · Review');
    once.unmount();
    // The answer is step 1 and review round r step r + 1 (MultiModelRunCard).
    const first = renderMessage({ text: REVIEW, threadMessage: from({ runId: 'wfr_1', step: 'review', round: 1, rounds: 2, fromLabel: 'Claude Code' }) });
    expect(first.container.querySelector('.terminal-message-thread-source')?.textContent).toBe('From Claude Code · Plan step 2 · Review 1/2');
    first.unmount();
    const twice = renderMessage({ text: REVIEW, threadMessage: from({ runId: 'wfr_1', step: 'review', round: 2, rounds: 2, fromLabel: 'Claude Code' }) });
    expect(twice.container.querySelector('.terminal-message-thread-source')?.textContent).toBe('From Claude Code · Plan step 3 · Review 2/2');
  });

  it('says Fresh for a fork branch that got no history', () => {
    const { container } = renderMessage(
      { text: 'Assess it.', threadMessage: from({ runId: 'wfr_1', step: 'answer', context: 'fork', fromLabel: 'Claude Code' }) },
      { freshContext: true },
    );
    expect(container.querySelector('.terminal-message-thread-source')?.textContent).toBe('From Claude Code · Plan step 1 · Fresh');
  });

  it('shows a review prompt\'s instruction, and the peers\' answers behind Show all', () => {
    const { container, getByRole } = renderMessage({ text: REVIEW, threadMessage: from({ runId: 'wfr_1', step: 'review', round: 1, rounds: 1 }) });
    const bubble = container.querySelector('.terminal-message-user')!;
    expect(bubble.textContent).toContain('Evaluate their arguments');
    expect(bubble.textContent).not.toContain('Batch when idle.');
    fireEvent.click(getByRole('button', { name: 'Show all' }));
    expect(bubble.textContent).toContain('Batch when idle.');
    fireEvent.click(getByRole('button', { name: 'Show less' }));
    expect(bubble.textContent).not.toContain('Batch when idle.');
  });

  it.each([
    [{ runId: 'wfr_1', step: 'synthesis', branches: 3 } as const, 'Results from 3 branches'],
    [{ runId: 'wfr_1', step: 'addendum', branches: 1 } as const, 'Late result from 1 branch'],
    [{ runId: 'wfr_1', step: 'addendum', branches: 2 } as const, 'Late results from 2 branches'],
  ])('shows a %s wake as one line that opens its body', (plan, caption) => {
    const { container, getByRole } = renderMessage({ text: '### Codex · GPT-6.1 Sol (Fork)\nEnqueue each turn.', threadMessage: from(plan, { hop: 2 }) });
    const row = container.querySelector('.mm-plan-result')!;
    expect(row.getAttribute('title')).toBe('Sent by the multi-model plan you started');
    expect(row.textContent).toBe(`${caption}Show`);
    expect(container.querySelector('.terminal-message-thread-source')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Show' }));
    expect(within(row as HTMLElement).getByText('Enqueue each turn.')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Hide' }));
    expect(row.textContent).toBe(`${caption}Show`);
  });

  it('keeps an ordinary relayed message as it was', () => {
    const { container } = renderMessage({ text: 'Please review', threadMessage: { fromNodeId: 'n-a', fromTitle: 'Research notes' } });
    const caption = container.querySelector('.terminal-message-thread-source')!;
    expect(caption.textContent).toBe('From Research notes');
    expect(caption.getAttribute('title')).toBe('Written by the agent in another thread and delivered with your approval');
  });

  it('passes read-only to the plan receipt under a reply, also when only read-only changes', () => {
    const reply = { id: 'm1', role: 'assistant', text: 'Proposed.', toolCalls: [], streaming: false } as ChatMessage;
    const block = (readOnly: boolean) => (
      <MessageBlock m={reply} index={0} isDark={false} copyText={() => ''} showThoughts={false} fontFamily="inherit" density="comfortable" readOnly={readOnly} />
    );
    const { getByTestId, rerender } = render(block(true));
    expect(getByTestId('mm-receipt').getAttribute('data-read-only')).toBe('true');
    rerender(block(false));
    expect(getByTestId('mm-receipt').getAttribute('data-read-only')).toBe('false');
  });
});

describe('MessageBlock: a failed plan step\'s error tail', () => {
  const reply = { id: 'a1', role: 'assistant' as const, text: '', toolCalls: [], streaming: false };
  const controls = (patch: Partial<MultiModelBranchControls> = {}): MultiModelBranchControls => ({
    openPlan: vi.fn(), retrying: false, busy: false, ...patch,
  });

  it('retries through the run, never the pane\'s own retry', () => {
    const onRetry = vi.fn();
    const planStep = controls({ retry: vi.fn() });
    const { getByTestId } = renderMessage(reply, { isErrorTail: true, errorMessage: 'Codex exited', onRetry, planStep });
    fireEvent.click(getByTestId('error-tail-retry'));
    expect(planStep.retry).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('waits while a command runs, says when the step runs again, and why a Retry was refused', () => {
    const busy = renderMessage(reply, { isErrorTail: true, planStep: controls({ retry: vi.fn(), busy: true, error: 'The run is settling' }) });
    expect((busy.getByTestId('error-tail-retry') as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getByRole('status').textContent).toBe('Retry failed: The run is settling');
    busy.unmount();
    const retrying = renderMessage(reply, { isErrorTail: true, planStep: controls({ retrying: true }) });
    const button = retrying.getByTestId('error-tail-retry') as HTMLButtonElement;
    expect(button.textContent).toBe('Retrying…');
    expect(button.disabled).toBe(true);
  });

  it('points to the plan when the run cannot retry it here', () => {
    const planStep = controls();
    const { getByTestId, queryByTestId } = renderMessage(reply, { isErrorTail: true, errorKind: 'backend_restarted', onRetry: vi.fn(), planStep });
    expect(queryByTestId('error-tail-retry')).toBeNull();
    fireEvent.click(getByTestId('error-tail-open-plan'));
    expect(planStep.openPlan).toHaveBeenCalledTimes(1);
  });

  it('shows an empty failed reply as its error tail alone, without a label over nothing', () => {
    const { container, getByText } = renderMessage(reply, { isErrorTail: true, errorMessage: 'Codex exited', planStep: controls({ retry: vi.fn() }) });
    expect(container.textContent).not.toContain('> michi');
    expect(container.querySelector('.terminal-message-assistant')).toBeNull();
    expect(getByText('Codex exited')).toBeTruthy();
    const written = renderMessage({ ...reply, text: 'Partial answer' }, { isErrorTail: true, errorMessage: 'Codex exited' });
    expect(written.container.querySelector('.terminal-message-assistant')).not.toBeNull();
  });
});
