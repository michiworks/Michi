import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatNodeState } from '../../state/chatTypes';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

const noop = () => {};
const message = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, text, toolCalls: [], ...extra });

function list(node: ChatNodeState, decorations: MetaChatDecorations | null) {
  const pane = <PaneMessageList
    node={node} prefs={DEFAULT_PREFS} contentStyle={{}}
    streaming={node.status === 'streaming'}
    onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
  />;
  return decorations ? <MetaChatDecorationsContext.Provider value={decorations}>{pane}</MetaChatDecorationsContext.Provider> : pane;
}

const quiet: MetaChatDecorations = { hideMessage: (entry) => entry.id.startsWith('quiet-') };

describe('PaneMessageList hideMessage (the Companion’s quiet turns)', () => {
  const node: ChatNodeState = {
    nodeId: 'companion', kind: 'chat', chatId: null, projectId: 'ws', status: 'idle', followUps: [], messagesLoaded: true,
    messages: [
      message('u-1', 'user', 'Call me Sam.'),
      message('a-1', 'assistant', 'Got it, Sam.'),
      message('quiet-1', 'assistant', 'QUIET TURN TEXT'),
    ],
  };

  it('shows every message without a window that hides some', () => {
    render(list(node, null));
    expect(screen.getByText('QUIET TURN TEXT')).toBeTruthy();
  });

  it('leaves the messages the window hides out of the list', () => {
    const { container } = render(list(node, quiet));
    expect(screen.queryByText('QUIET TURN TEXT')).toBeNull();
    expect(container.querySelector('[data-msg-id="quiet-1"]')).toBeNull();
    expect(screen.getByText('Got it, Sam.')).toBeTruthy();
    expect(screen.getByText('Call me Sam.')).toBeTruthy();
  });

  it('takes a hidden running turn’s activity row along', () => {
    const running: ChatNodeState = {
      ...node, status: 'streaming', runtimeActivity: 'Reading your inbox',
      messages: [...node.messages, message('quiet-2', 'assistant', '', { streaming: true })],
    };
    const { rerender } = render(list(running, null));
    expect(screen.getByRole('status', { name: /Reading your inbox/ })).toBeTruthy();
    rerender(list(running, quiet));
    expect(screen.queryByRole('status', { name: /Reading your inbox/ })).toBeNull();
    expect(screen.queryByRole('status', { name: 'loading' })).toBeNull();
  });
});
