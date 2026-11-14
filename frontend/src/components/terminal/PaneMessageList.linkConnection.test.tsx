import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

// Each answer says which backend its michi:// links resolve on.
vi.mock('../MarkdownContent', async () => {
  const { useContext } = await import('react');
  const { MichiLinkConnectionContext } = await import('./assistant/linkConnection');
  function MarkdownProbe({ text }: { text: string }) {
    return <span data-link-connection={useContext(MichiLinkConnectionContext)}>{text}</span>;
  }
  return { default: MarkdownProbe };
});

const noop = () => {};
const answer: ChatMessage = { id: 'a-1', role: 'assistant', text: 'See [the phone fix](michi://node/n-44d2).', toolCalls: [] };

function list(nodeId: string, projectId: string) {
  const node: ChatNodeState = {
    nodeId, kind: 'chat', chatId: null, projectId, status: 'idle', followUps: [], messagesLoaded: true, messages: [answer],
  };
  return <PaneMessageList
    node={node} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={false}
    onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
  />;
}

describe('PaneMessageList: michi:// links in a transcript', () => {
  it("resolve on a remote thread's own backend", () => {
    render(list('remote:build-box:n-1', 'remote:build-box:ws'));
    expect(screen.getByText(/the phone fix/).getAttribute('data-link-connection')).toBe('build-box');
  });

  it("resolve on this machine for this machine's threads", () => {
    render(list('n-1', 'ws'));
    expect(screen.getByText(/the phone fix/).getAttribute('data-link-connection')).toBe('local');
  });
});
