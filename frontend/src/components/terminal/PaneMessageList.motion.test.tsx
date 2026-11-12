import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaneMessageList, isFreshMessage } from './PaneMessageList';
import type { ChatAction, ChatNodeState } from '../../state/chatTypes';
import { reduceNodes } from '../../state/chatReducers';
import { DEFAULT_PREFS } from '../../state/prefs';
import { FRESH_MS } from '../../motion/useFresh';

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

const hydrated: ChatNodeState = {
  nodeId: 'n1', kind: 'chat', chatId: 'n1', projectId: 'p1', status: 'idle', followUps: [],
  messages: [
    { id: 'u-old', role: 'user', text: 'earlier question', toolCalls: [], createdAt: 1 },
    { id: 'a-old', role: 'assistant', text: 'earlier answer', toolCalls: [], createdAt: 2 },
  ],
};
const noop = () => {};

function list(node: ChatNodeState, extra: Partial<React.ComponentProps<typeof PaneMessageList>> = {}) {
  return <PaneMessageList
    node={node} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={node.status === 'streaming'}
    onRetryTurn={noop} onEditUserMessage={noop}
    onContinueFollowUp={noop} onBranchFollowUp={noop} {...extra}
  />;
}

const frame = (container: HTMLElement, id: string) =>
  container.querySelector(`.terminal-message-frame[data-msg-id="${id}"]`) as HTMLElement;
// An entrance is motion's fade on the message root, written into its style;
// settled messages render a plain root with no opacity of their own.
const entered = (el: HTMLElement) => (el.firstElementChild as HTMLElement).style.opacity !== '';

function reduce(node: ChatNodeState, action: ChatAction): ChatNodeState {
  return reduceNodes({ [node.nodeId]: node }, action)[node.nodeId];
}

describe('isFreshMessage', () => {
  it('admits only messages created after the list mounted, within the fresh window', () => {
    expect(isFreshMessage(1_000, 1_000, 1_000)).toBe(true);
    expect(isFreshMessage(1_500, 1_000, 1_500 + FRESH_MS - 1)).toBe(true);
    expect(isFreshMessage(1_500, 1_000, 1_500 + FRESH_MS)).toBe(false);
    // Hydrated history predates the list, however recent.
    expect(isFreshMessage(999, 1_000, 1_000)).toBe(false);
    // Legacy rows have no timestamp; a clock ahead of ours is not "just now".
    expect(isFreshMessage(undefined, 1_000, 1_000)).toBe(false);
    expect(isFreshMessage(1_200, 1_000, 1_100)).toBe(false);
  });
});

describe('PaneMessageList message motion', () => {
  it('renders hydrated history settled and plays the entrance only for a send made while it is open', () => {
    const { container, rerender } = render(list(hydrated));
    expect(entered(frame(container, 'u-old'))).toBe(false);
    expect(entered(frame(container, 'a-old'))).toBe(false);

    const sent = reduce(hydrated, { type: 'user-send', nodeId: 'n1', assistantId: 'a-local', userText: 'next question' });
    rerender(list(sent));
    expect(entered(frame(container, 'u-a-local'))).toBe(true);
    expect(entered(frame(container, 'u-old'))).toBe(false);
  });

  it('remounted, a list renders even a moments-old send settled', () => {
    const sent = reduce(hydrated, { type: 'user-send', nodeId: 'n1', assistantId: 'a-local', userText: 'next question' });
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1);
    try {
      const { container } = render(list(sent));
      expect(entered(frame(container, 'u-a-local'))).toBe(false);
    } finally {
      later.mockRestore();
    }
  });

  it('keeps both rows mounted when the server realigns the optimistic ids', () => {
    const sent = reduce(hydrated, { type: 'user-send', nodeId: 'n1', assistantId: 'a-local', userText: 'next question' });
    const { container, rerender } = render(list(sent));
    const user = frame(container, 'u-a-local');
    const assistant = frame(container, 'a-local');
    const userBlock = user.firstElementChild;

    rerender(list(reduce(sent, { type: 'realign-assistant-id', nodeId: 'n1', fromId: 'a-local', toId: 'a-server' })));
    expect(frame(container, 'u-a-server')).toBe(user);
    expect(frame(container, 'a-server')).toBe(assistant);
    expect(user.firstElementChild).toBe(userBlock);
    expect(frame(container, 'u-a-local')).toBeNull();
  });

  it('fades the downstream messages both into and out of the edit dim', () => {
    const { container, rerender } = render(list(hydrated, { editingMessageId: 'u-old' }));
    const answer = frame(container, 'a-old');
    expect(answer.style.opacity).toBe('0.38');
    expect(answer.style.transition).toContain('opacity');

    rerender(list(hydrated, { editingMessageId: null }));
    expect(answer.style.opacity).toBe('');
    expect(answer.style.transition).toContain('opacity');
  });

  it('fades a steered bubble in where it lands, whatever the server clock says', () => {
    const running: ChatNodeState = {
      ...hydrated, status: 'streaming',
      messages: [...hydrated.messages,
        { id: 'u-run', role: 'user', text: 'run it', toolCalls: [], createdAt: 3 },
        { id: 'a-run', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true, createdAt: 4 }],
    };
    const { container, rerender } = render(list(running));
    // The server stamped it seconds ago by our clock (skew plus the round trip).
    const steered = reduce(running, { type: 'steer-accepted', nodeId: 'n1', data: {
      messageId: 'u-steer', assistantId: 'a-run', turnId: 't', seq: 2, createdAt: Date.now() - 5_000, text: 'use cobalt', pending: true,
    } });
    rerender(list(steered));
    expect(entered(frame(container, 'u-steer'))).toBe(true);
  });

  describe('follow-ups', () => {
    const withFollowUps: ChatNodeState = { ...hydrated, followUps: ['Dig into the cache', 'Compare with v1'] };
    const followUpPrefs = { ...DEFAULT_PREFS, enableFollowUps: true };

    it('a picked follow-up fades the section away and its bubble in', async () => {
      const onContinueFollowUp = vi.fn();
      const { container, rerender } = render(list(withFollowUps, { prefs: followUpPrefs, onContinueFollowUp }));
      const section = screen.getByRole('region', { name: 'Suggested follow-ups' });

      fireEvent.click(screen.getByRole('button', { name: /Continue follow-up in current pane: Dig into the cache/ }));
      expect(onContinueFollowUp).toHaveBeenCalledWith('Dig into the cache');
      const sent = reduce(withFollowUps, { type: 'user-send', nodeId: 'n1', assistantId: 'a-local', userText: 'Dig into the cache' });
      rerender(list(sent, { prefs: followUpPrefs, onContinueFollowUp }));

      expect(entered(frame(container, 'u-a-local'))).toBe(true);
      // The leaving section is out of reach while it fades, all of it at once.
      expect(section.getAttribute('aria-hidden')).toBe('true');
      expect(section.hasAttribute('inert')).toBe(true);
      await waitFor(() => expect(section.isConnected).toBe(false));
    });

    it('a loading section replaced mid-stream goes at once, not over the typing answer', () => {
      const loading: ChatNodeState = { ...hydrated, status: 'streaming', followUpsGenerating: true };
      const { rerender } = render(list(loading, { prefs: followUpPrefs }));
      expect(screen.getByRole('region', { name: 'Suggested follow-ups' })).not.toBeNull();
      // The questions arrived; the answer is still typing, so none show yet.
      rerender(list({ ...loading, followUps: ['Dig into the cache'] }, { prefs: followUpPrefs }));
      expect(screen.queryByRole('region', { name: 'Suggested follow-ups' })).toBeNull();
      expect(document.querySelector('.t-followups')).toBeNull();
    });

    it('goes at once when the loading ends with no follow-ups, or a turn starts without a new message', () => {
      const loading: ChatNodeState = { ...hydrated, status: 'streaming', followUpsGenerating: true };
      const first = render(list(loading, { prefs: followUpPrefs }));
      first.rerender(list({ ...loading, followUpsGenerating: false }, { prefs: followUpPrefs }));
      expect(document.querySelector('.t-followups')).toBeNull();
      first.unmount();

      const { rerender } = render(list(withFollowUps, { prefs: followUpPrefs }));
      rerender(list({ ...withFollowUps, status: 'streaming', followUps: [] }, { prefs: followUpPrefs }));
      expect(document.querySelector('.t-followups')).toBeNull();
    });
  });

  describe('the turn’s diff receipt', () => {
    const edit = { id: 't1', title: 'write', status: 'completed' as const, inputJson: JSON.stringify({ path: 'src/a.ts', content: 'x' }) };
    const withEdit = (node: ChatNodeState): ChatNodeState => ({
      ...node,
      messages: node.messages.map((m, i) => (i === node.messages.length - 1 ? { ...m, toolCalls: [edit] } : m)),
    });
    const receiptGrows = (container: HTMLElement) =>
      (container.querySelector('[data-testid="diff-receipt"]')?.parentElement as HTMLElement | null)?.style.display === 'flow-root';

    it('grows in when the turn ends on screen', () => {
      const running = withEdit({ ...hydrated, status: 'streaming' });
      const { container, rerender } = render(list(running));
      expect(container.querySelector('[data-testid="diff-receipt"]')).toBeNull();
      rerender(list({ ...running, status: 'idle' }));
      expect(receiptGrows(container)).toBe(true);
    });

    it('comes settled with history that loads while the list is open', () => {
      const { container, rerender } = render(list({ ...hydrated, messages: [], messagesLoaded: false, messageCount: 2 }));
      rerender(list(withEdit(hydrated)));
      expect(container.querySelector('[data-testid="diff-receipt"]')).not.toBeNull();
      expect(receiptGrows(container)).toBe(false);
    });

    it('grows only for the reply it watched: a receipt that mounts later for another reply settles', () => {
      const running = withEdit({ ...hydrated, status: 'streaming' });
      const { container, rerender } = render(list(running));
      rerender(list({ ...running, status: 'idle' }));
      expect(receiptGrows(container)).toBe(true);
      // The full history replaces the transcript (an edit while it loads): its last reply was never watched.
      const history = withEdit({
        ...hydrated,
        messages: [...hydrated.messages, { id: 'u-h', role: 'user', text: 'later', toolCalls: [], createdAt: 3 },
          { id: 'a-h', role: 'assistant', text: 'later answer', toolCalls: [], createdAt: 4 }],
      });
      rerender(list(history));
      expect(container.querySelector('[data-testid="diff-receipt"]')).not.toBeNull();
      expect(receiptGrows(container)).toBe(false);
    });
  });

  it('keeps "Explore further" collapsed across turns', () => {
    const prefs = { ...DEFAULT_PREFS, enableFollowUps: true };
    const before: ChatNodeState = { ...hydrated, followUps: ['Dig into the cache'] };
    const { rerender } = render(list(before, { prefs }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse follow-ups' }));
    const sent = reduce(before, { type: 'user-send', nodeId: 'n1', assistantId: 'a-local', userText: 'next' });
    rerender(list(sent, { prefs }));
    rerender(list({ ...sent, status: 'idle', followUps: ['And then?'] }, { prefs }));
    expect(screen.getByRole('button', { name: 'Expand follow-ups' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('spins the follow-ups loader (motion-safe only)', () => {
    render(list({ ...hydrated, status: 'streaming', followUpsGenerating: true }, {
      prefs: { ...DEFAULT_PREFS, enableFollowUps: true },
    }));
    expect(screen.getByText('Preparing next steps...')).not.toBeNull();
    const loader = document.querySelector('.t-followups-loading svg');
    expect(loader?.getAttribute('class')).toContain('motion-safe:animate-spin');
  });
});
