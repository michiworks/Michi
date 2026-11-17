import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

function nodeWith(messages: ChatMessage[], over: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId: 'node', kind: 'chat', chatId: 'chat', projectId: 'workspace', status: 'idle', followUps: [], messages, ...over };
}

function list(value: ChatNodeState, onContinueTurn = vi.fn(), readOnly = false) {
  return <PaneMessageList node={value} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={value.status === 'streaming'}
    onRetryTurn={vi.fn()} onContinueTurn={onContinueTurn} readOnly={readOnly}
    onEditUserMessage={vi.fn()} onContinueFollowUp={vi.fn()} onBranchFollowUp={vi.fn()} />;
}

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, toolCalls: [] });
const answer = (id: string, text: string, turnEnd?: ChatMessage['turnEnd']): ChatMessage => ({
  id, role: 'assistant', text, toolCalls: [], ...(turnEnd ? { turnEnd } : {}),
});

describe('the line under an answer that did not finish', () => {
  it('says why it ended early, and the latest offers Continue', () => {
    const onContinue = vi.fn();
    render(list(nodeWith([user('u1', 'Fix the build'), answer('a1', 'Half done.', 'max_turn_requests')]), onContinue));
    const note = screen.getByTestId('turn-end-note');
    expect(note.textContent).toContain('Stopped early: it reached its step limit');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('says "Stopped" for a Stop the server confirmed', () => {
    render(list(nodeWith([user('u1', 'Fix the build'), answer('a1', 'Started.', 'stopped')])));
    expect(screen.getByTestId('turn-end-note').textContent).toMatch(/^Stopped/);
  });

  it('shows the line on earlier answers without Continue', () => {
    render(list(nodeWith([
      user('u1', 'First'), answer('a1', 'Cut off.', 'max_tokens'),
      user('u2', 'Second'), answer('a2', 'All done.'),
    ])));
    expect(screen.getByTestId('turn-end-note').textContent).toContain('Stopped early: it reached its output limit');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('a finished answer has no line, and a read-only transcript offers no Continue', () => {
    const view = render(list(nodeWith([user('u1', 'Hi'), answer('a1', 'Hello.')])));
    expect(screen.queryByTestId('turn-end-note')).toBeNull();
    view.rerender(list(nodeWith([user('u1', 'Hi'), answer('a1', 'Half.', 'refusal')]), vi.fn(), true));
    expect(screen.getByTestId('turn-end-note').textContent).toContain('Stopped: the agent declined to continue');
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });
});
