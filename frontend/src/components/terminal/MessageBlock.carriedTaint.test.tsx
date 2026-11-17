import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';
import type { ChatMessage } from '../../state/chatTypes';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../state/metaChat/metaChatDecorations';

const noop = () => {};
const LINE = 'Anything that would leave this machine asks first: this conversation read check-in material earlier.';

function view(message: Partial<ChatMessage>, decorations: MetaChatDecorations | null = null, fresh = false) {
  const block = (
    <MessageBlock
      m={{ id: 'u-1', role: 'user', text: 'And now run the deploy.', toolCalls: [], streaming: false, ...message }}
      index={0}
      isDark={false}
      onEdit={noop}
      copyText={() => ''}
      showThoughts={false}
      density="comfortable"
      fresh={fresh}
    />
  );
  return decorations ? <MetaChatDecorationsContext.Provider value={decorations}>{block}</MetaChatDecorationsContext.Provider> : block;
}

const show = (message: Partial<ChatMessage>, decorations: MetaChatDecorations | null = null) => render(view(message, decorations));

afterEach(cleanup);

describe('an ordinary chat that read check-in material on an earlier turn (TR cross-owner #3, w3-fix D17)', () => {
  it('says under the user message why its tools ask', () => {
    show({ companionTurn: { carriedTaint: 'checkin' } });
    expect(screen.getByRole('note').textContent).toBe(LINE);
  });

  it('says nothing for a plain message, an assistant reply, or a message that started with the material itself', () => {
    show({});
    show({ role: 'assistant', companionTurn: { carriedTaint: 'collector' } });
    show({ companionTurn: { startTaint: 'checkin', carriedTaint: 'checkin' } });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it.each([
    ['grows the line in when the route comes after a send made on screen', true, '0px'],
    ['shows the line settled under a message that came with history', false, 'auto'],
  ] as const)('%s', (_name, fresh, height) => {
    const { rerender } = render(view({}, null, fresh));
    rerender(view({ companionTurn: { carriedTaint: 'checkin' } }, null, fresh));
    // A growing box starts at 0px, a settled one at its own height.
    expect(screen.getByRole('note').parentElement!.style.height).toBe(height);
  });

  it('leaves the line to the agent\'s conversation, which draws its route lines itself', () => {
    show({ companionTurn: { carriedTaint: 'checkin' } }, { afterMessage: () => <span data-testid="own-lines" /> });
    expect(screen.getByTestId('own-lines')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
