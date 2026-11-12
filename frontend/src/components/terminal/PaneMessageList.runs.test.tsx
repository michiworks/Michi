import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaneMessageList } from './PaneMessageList';
import type { ChatMessage, ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';

const noop = () => {};
const usage = (tokens: number, ms: number) => ({
  source: 'native', totalTokens: tokens, inputTokens: tokens, outputTokens: 0, turnDurationMs: ms,
}) as unknown as ChatMessage['usageSummary'];
const message = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role, text, toolCalls: [], ...extra,
});

function list(messages: ChatMessage[]) {
  const node: ChatNodeState = {
    nodeId: 'n', kind: 'chat', chatId: null, projectId: 'project',
    status: 'idle', followUps: [], messagesLoaded: true, messages,
  };
  return <PaneMessageList
    node={node} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={false}
    onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
  />;
}

describe('PaneMessageList reply runs', () => {
  it('shows replies with no user message between them as one message', () => {
    const { container } = render(list([
      message('u1', 'user', 'Run the suite'),
      message('a1', 'assistant', 'Started four subagents.', { usageSummary: usage(10_000, 2_000) }),
      message('a2', 'assistant', 'The pane group came back.', { usageSummary: usage(5_000, 1_000) }),
      message('u2', 'user', 'Reproduce the bug'),
      message('a3', 'assistant', 'On it.', { usageSummary: usage(1_000, 500) }),
    ]));
    // One meta line per run, not per reply, with the run's usage.
    expect(screen.queryByText('> michi')).toBeNull();
    expect(container.querySelectorAll('.t-answer-meta')).toHaveLength(2);
    const usageLines = screen.getAllByTestId('turn-usage').map((el) => el.textContent);
    expect(usageLines).toEqual(['15k tokens', '1k tokens']);
    const part = container.querySelector('[data-msg-id="a1"]')!;
    expect(part.getAttribute('data-run-part')).toBe('true');
    expect(part.querySelector('[aria-label="copy message"]')).toBeNull();
    expect(container.querySelector('[data-msg-id="a2"]')!.getAttribute('data-run-end')).toBe('true');
    expect(container.querySelector('[data-msg-id="a3"]')!.hasAttribute('data-run-end')).toBe(false);
  });

  it('copies the whole run from its last part', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(list([
      message('u1', 'user', 'Go'),
      message('a1', 'assistant', 'First part.'),
      message('a2', 'assistant', 'Second part.'),
    ]));
    fireEvent.click(container.querySelector('[data-msg-id="a2"] [aria-label="copy message"]')!);
    expect(writeText).toHaveBeenCalledWith('First part.\n\nSecond part.');
  });
});

describe('PaneMessageList answer meta lines', () => {
  const actionsOf = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-msg-id="${id}"] .t-answer-meta .t-msg-actions`) as HTMLElement | null;
  const thread = [
    message('u1', 'user', 'First'),
    message('a1', 'assistant', 'Earlier answer.'),
    message('u2', 'user', 'Second'),
    message('a2', 'assistant', 'Latest answer.'),
  ];

  function at(status: ChatNodeState['status'], messages = thread) {
    const node: ChatNodeState = {
      nodeId: 'n', kind: 'chat', chatId: null, projectId: 'project',
      status, followUps: [], messagesLoaded: true, messages,
    };
    return <PaneMessageList
      node={node} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={status === 'streaming'}
      onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
    />;
  }

  it('keeps the latest answer\'s line shown and earlier ones for hover', () => {
    const { container } = render(at('idle'));
    expect(actionsOf(container, 'a2')!.style.opacity).toBe('1');
    expect(actionsOf(container, 'a1')!.style.opacity).toBe('0');
  });

  it('shows none under an answer still streaming, and leaves the earlier one to hover', () => {
    const { container } = render(at('streaming'));
    expect(actionsOf(container, 'a2')).toBeNull();
    expect(actionsOf(container, 'a1')!.style.opacity).toBe('0');
  });

  it('does not pin a failed answer: its error row has the actions', () => {
    const { container } = render(at('error'));
    expect(actionsOf(container, 'a2')!.style.opacity).toBe('0');
  });

  it('pins nothing while the latest message is the user\'s', () => {
    const { container } = render(at('idle', [...thread, message('u3', 'user', 'Third')]));
    expect(actionsOf(container, 'a2')!.style.opacity).toBe('0');
  });
});
