/**
 * The header of a finished activity block leads with what the block did and
 * puts the block's duration at the right: the activity window
 * (agentBlockTiming), from the first reasoning to where the answer begins.
 * A window that words its own tools (MetaChatDecorations.workLine, the
 * Companion only) swaps in its words; the header is otherwise the pane's,
 * duration included.
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import type { ChatMessage } from '../../state/chatTypes';

// The Companion's welcome in the smoke run, timestamps as stored (backend clock).
const T0 = 1_793_830_624_648;
const welcome: ChatMessage = {
  id: 'self-n-1-cmp-1',
  role: 'assistant',
  text: 'What would you like to call me?',
  streaming: false,
  toolCalls: [{ id: 't1', title: '@michi/companion_items', status: 'completed', inputJson: '{"limit":20}', startedAt: T0 + 6_587, endedAt: T0 + 6_614 }],
  blocks: [
    { id: 'b1', kind: 'thinking', rawText: 'Looking at what is open', streaming: false, startedAt: T0, endedAt: T0 + 6_587 },
    { id: 'b2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 23 },
    { id: 'b3', kind: 'answer', rawText: 'What would you like to call me?', streaming: false, startedAt: T0 + 11_268, endedAt: T0 + 11_472 },
  ],
};

function renderTurn(decorations: MetaChatDecorations | null, m: ChatMessage = welcome) {
  return render(
    <MetaChatDecorationsContext.Provider value={decorations}>
      <MessageBlock m={m} index={0} isDark={false} copyText={() => ''} showThoughts density="comfortable" />
    </MetaChatDecorationsContext.Provider>,
  );
}

// A turn with two runs of work and a note between them: the line chrome folds it above the answer.
const checked: ChatMessage = {
  ...welcome,
  id: 'self-n-1-cmp-2',
  text: 'Nothing new since this morning.',
  toolCalls: [
    welcome.toolCalls[0],
    { id: 't2', title: '@michi/companion_check_now', status: 'completed', inputJson: '{}', startedAt: T0 + 12_000, endedAt: T0 + 14_000 },
  ],
  blocks: [
    ...welcome.blocks!.slice(0, 2),
    { id: 'b3', kind: 'answer', rawText: 'Checking your sources too.', streaming: false, startedAt: T0 + 11_268, endedAt: T0 + 11_472 },
    { id: 'b4', kind: 'tool', toolCallId: 't2', section: 'answer', rawOffset: 26 },
    { id: 'b5', kind: 'answer', rawText: 'Nothing new since this morning.', streaming: false, startedAt: T0 + 14_100, endedAt: T0 + 14_300 },
  ],
};

const OWN: Record<string, string> = { t1: 'Looked at Today’s items', t2: 'Checked sources' };
const companionWords: MetaChatDecorations = {
  toolLine: (tool) => OWN[tool.id] ?? null,
  workLine: (tools) => (tools.length === 1 ? OWN[tools[0].id] ?? null : 'Looked at Today’s items and checked sources'),
};
/** The header line of each run, outermost first. */
const lineHeaders = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('button.agent-line')];

describe('the line chrome', () => {
  it('names the run and its time generically in every other pane, as before', () => {
    const view = renderTurn(null);
    const [run] = lineHeaders(view.container);
    expect(run.textContent).toContain('companion_items');
    expect(run.textContent).toContain('11s');
    view.unmount();
    const folded = renderTurn(null, checked);
    expect(lineHeaders(folded.container)[0].textContent).toMatch(/^Worked for /);
  });

  it('says the Companion’s own words for the run and its step, with the same span', () => {
    const view = renderTurn(companionWords);
    const [run] = lineHeaders(view.container);
    expect(run.textContent).toContain('Looked at Today’s items');
    expect(run.textContent).not.toContain('companion_items');
    expect(run.textContent).toContain('11s');
    fireEvent.click(run);
    const step = lineHeaders(view.container)[1];
    expect(step.textContent).toContain('Looked at Today’s items');
    expect(step.textContent).not.toContain('companion_items');
  });

  it('folds a finished turn under the Companion’s own words, with the same duration', () => {
    const view = renderTurn(companionWords, checked);
    const fold = lineHeaders(view.container)[0];
    expect(fold.textContent).toContain('looked at Today’s items and checked sources');
    expect(fold.textContent).toMatch(/^Worked for /);
    expect(fold.textContent).not.toContain('companion_');
  });
});
