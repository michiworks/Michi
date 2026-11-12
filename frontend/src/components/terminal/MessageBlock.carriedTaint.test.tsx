import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';
import type { ChatMessage } from '../../state/chatTypes';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../state/metaChat/metaChatDecorations';

const noop = () => {};
const LINE = 'Tools ask before running this turn: this conversation read check-in material earlier.';

function show(message: Partial<ChatMessage>, decorations: MetaChatDecorations | null = null) {
  const block = (
    <MessageBlock
      m={{ id: 'u-1', role: 'user', text: 'And now run the deploy.', toolCalls: [], streaming: false, ...message }}
      index={0}
      isDark={false}
      onEdit={noop}
      copyText={() => ''}
      showThoughts={false}
      fontFamily="inherit"
      density="comfortable"
    />
  );
  return render(decorations ? <MetaChatDecorationsContext.Provider value={decorations}>{block}</MetaChatDecorationsContext.Provider> : block);
}

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

  it('leaves the line to the agent\'s conversation, which draws its route lines itself', () => {
    show({ companionTurn: { carriedTaint: 'checkin' } }, { afterMessage: () => <span data-testid="own-lines" /> });
    expect(screen.getByTestId('own-lines')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
