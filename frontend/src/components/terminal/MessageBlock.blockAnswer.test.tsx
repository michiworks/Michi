import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../state/chatTypes';
import { MessageBlock } from './MessageBlock';

afterEach(cleanup);

function renderMessage(m: Partial<ChatMessage>) {
  return render(
    <MessageBlock
      m={{ id: 'u-2', role: 'user', text: 'Plan the trip\n\n{"city":"Kyoto"}', toolCalls: [], streaming: false, ...m } as ChatMessage}
      index={0}
      isDark={false}
      copyText={() => ''}
      showThoughts={false}
      density="comfortable"
    />,
  );
}

describe('MessageBlock: an answer to a reply\'s block', () => {
  it('is one line naming the block, and its sent text opens on demand', () => {
    const { container } = renderMessage({ blockAnswer: { messageId: 'a-1', blockId: 'cb-form', title: 'Trip details' } });
    expect(screen.getByText('Answered “Trip details”')).toBeTruthy();
    expect(container.querySelector('.terminal-message-user')).toBeNull();
    expect(screen.queryByText(/"city":"Kyoto"/)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(container.querySelector('.terminal-message-user')?.textContent).toContain('"city":"Kyoto"');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(container.querySelector('.terminal-message-user')).toBeNull();
  });

  it('says it answered a block when the block had no title', () => {
    renderMessage({ blockAnswer: { messageId: 'a-1', blockId: 'cb-actions', title: '' } });
    expect(screen.getByText('Answered a block')).toBeTruthy();
  });

  it('leaves an ordinary message a bubble', () => {
    const { container } = renderMessage({});
    expect(container.querySelector('.terminal-message-user')).toBeTruthy();
    expect(screen.queryByText(/^Answered/)).toBeNull();
  });
});
