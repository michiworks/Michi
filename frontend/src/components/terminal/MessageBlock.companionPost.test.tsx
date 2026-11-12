/**
 * A message's own speaker line and link policy (DESIGN-v2 §2.8, §3.3): the
 * agent's panel labels a posted check-in "<name> · check-in" and gives it the
 * agent's link allow-list, while a reply to the user keeps the surrounding
 * renderer. Every other pane renders as before.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';
import { MarkdownLinkRendererContext, type MarkdownLinkRenderer } from '../markdownLinkRenderer';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import type { ChatMessage } from '../../state/chatTypes';

const post: ChatMessage = {
  id: 'cmp-post-r1', role: 'assistant', text: 'See [the CR](https://reviews.example.com/reviews/CR-1).', toolCalls: [],
  blocks: [{ id: 'b1', kind: 'answer', rawText: 'See [the CR](https://reviews.example.com/reviews/CR-1).', streaming: false }],
  companionPost: { runId: 'r1', kind: 'heartbeat', changes: [] },
};
const reply: ChatMessage = { ...post, id: 'a-1', companionPost: undefined };

const marking = (mark: string): MarkdownLinkRenderer => ({
  protocols: [],
  matches: () => true,
  render: (_href, children) => <span data-renderer={mark}>{children}</span>,
});

function renderMessage(message: ChatMessage, decorations: MetaChatDecorations | null) {
  return render(
    <MarkdownLinkRendererContext.Provider value={marking('surrounding')}>
      <MetaChatDecorationsContext.Provider value={decorations}>
        <MessageBlock m={message} index={0} isDark={false} copyText={() => ''} showThoughts fontFamily="inherit" density="comfortable" />
      </MetaChatDecorationsContext.Provider>
    </MarkdownLinkRendererContext.Provider>,
  );
}

describe('a message’s own label and links', () => {
  const decorations: MetaChatDecorations = {
    assistantLabel: 'Robin',
    assistantLabelFor: (message) => (message.companionPost ? 'Robin · check-in' : undefined),
    linkRendererFor: (message) => (message.companionPost ? marking('post') : undefined),
  };

  it('labels a post by its kind and renders its links with its own policy', () => {
    const view = renderMessage(post, decorations);
    expect(view.getByText('Robin · check-in')).toBeTruthy();
    expect(view.container.querySelector('[data-renderer]')?.getAttribute('data-renderer')).toBe('post');
  });

  it('keeps the shared label and the surrounding renderer for a reply', () => {
    const view = renderMessage(reply, decorations);
    expect(view.getByText('Robin')).toBeTruthy();
    expect(view.container.querySelector('[data-renderer]')?.getAttribute('data-renderer')).toBe('surrounding');
  });

  it('renders as before without decorations: no speaker label, the surrounding renderer', () => {
    const view = renderMessage(post, null);
    expect(view.queryByText('Robin · check-in')).toBeNull();
    expect(view.container.querySelector('[data-renderer]')?.getAttribute('data-renderer')).toBe('surrounding');
  });
});
