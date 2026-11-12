/**
 * A multi-model branch whose plan step failed: every Retry of that turn goes
 * through the run's row (the orchestrator collects only its own turns), or
 * the tail points to the plan; the pane never resends the prompt itself.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';
import type { MultiModelBranchControls } from './multiModelBranch';

vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

const branch: ChatNodeState = {
  nodeId: 'branch', kind: 'chat', chatId: 'branch', projectId: 'workspace', status: 'error', followUps: [],
  error: 'Codex exited', multiModelRunId: 'wfr_1', freshContext: true, parentNodeId: 'caller',
  messages: [
    {
      id: 'u1', role: 'user', text: 'Assess it.', toolCalls: [],
      threadMessage: { fromNodeId: 'caller', fromTitle: 'Memory timing', plan: { runId: 'wfr_1', step: 'answer', context: 'fork', fromLabel: 'Claude Code' } },
    },
    { id: 'a1', role: 'assistant', text: '', toolCalls: [] },
  ],
};

function list(node: ChatNodeState, planStep: MultiModelBranchControls | undefined, onRetryTurn = vi.fn(), readOnly = false) {
  return <PaneMessageList node={node} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={false}
    onRetryTurn={onRetryTurn} onRunAgain={vi.fn()} planStep={planStep} readOnly={readOnly}
    onEditUserMessage={vi.fn()} onContinueFollowUp={vi.fn()} onBranchFollowUp={vi.fn()} />;
}

const controls = (patch: Partial<MultiModelBranchControls> = {}): MultiModelBranchControls => ({
  openPlan: vi.fn(), retrying: false, busy: false, ...patch,
});

describe('PaneMessageList: a failed plan step', () => {
  it('retries the step through the run from the tail and from either message', () => {
    const onRetryTurn = vi.fn();
    const planStep = controls({ retry: vi.fn() });
    render(list(branch, planStep, onRetryTurn));
    fireEvent.click(screen.getByTestId('error-tail-retry'));
    for (const button of screen.getAllByRole('button', { name: 'retry this turn' })) fireEvent.click(button);
    expect(planStep.retry).toHaveBeenCalledTimes(3);
    expect(onRetryTurn).not.toHaveBeenCalled();
  });

  it('points to the plan, with no pane retry, when the run cannot retry the step', () => {
    const onRetryTurn = vi.fn();
    const planStep = controls();
    render(list(branch, planStep, onRetryTurn));
    expect(screen.queryByRole('button', { name: 'retry this turn' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    expect(planStep.openPlan).toHaveBeenCalledTimes(1);
    expect(onRetryTurn).not.toHaveBeenCalled();
  });

  it('keeps the error, without an empty reply, and captions the prompt with the branch\'s real context', () => {
    const { container } = render(list(branch, controls({ retry: vi.fn() })));
    expect(screen.getByText('Codex exited')).toBeTruthy();
    expect(container.querySelector('.terminal-message-assistant')).toBeNull();
    expect(container.querySelector('.terminal-message-thread-source')?.textContent).toBe('From Claude Code · Plan step 1 · Fresh');
  });

  it('offers nothing in an archived branch', () => {
    render(list(branch, controls({ retry: vi.fn() }), vi.fn(), true));
    expect(screen.queryByTestId('error-tail-retry')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open plan' })).toBeNull();
  });
});
