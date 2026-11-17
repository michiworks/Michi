import { describe, expect, it } from 'vitest';
import { mapMessageRow } from './chatHydration';
import { visibleMessageText } from './assistantBlocks';

const shown = {
  id: 'a-1-b-1', kind: 'blocks', title: 'Pick',
  blocks: [{ type: 'poll', id: 'cb-1', question: 'Which day?', options: ['Mon', 'Tue'] }],
  fallbackText: 'Pick\n\nWhich day?\n- Mon\n- Tue',
};
/** A finished reply as data.db holds it: the content is its answer, then the blocks' plain text. */
const row = (blocks: unknown[]) => ({
  id: 'a-1', node_id: 'n-1', role: 'assistant', seq: 1, created_at: 5,
  content: 'Here you go.\n\nPick\n\nWhich day?\n- Mon\n- Tue',
  blocks: JSON.stringify(blocks),
});

describe('a reply that showed blocks, after a reload', () => {
  it('keeps the blocks with their ids, in place among the reply\'s text', () => {
    const message = mapMessageRow(row([{ id: 'a-1-b-0', kind: 'answer', rawText: 'Here you go.' }, shown]));
    expect(message.blocks?.map((block) => block.kind)).toEqual(['answer', 'blocks']);
    expect(message.blocks?.[1]).toEqual(shown);
    expect(message.text).toBe('');
  });

  it('copies and exports as its answer followed by the blocks\' text', () => {
    const message = mapMessageRow(row([{ id: 'a-1-b-0', kind: 'answer', rawText: 'Here you go.' }, shown]));
    expect(visibleMessageText(message)).toBe('Here you go.\n\nPick\n\nWhich day?\n- Mon\n- Tue');
  });

  it('a window that does not know a block kind shows the stored content in its place', () => {
    // As a window built before `blocks` reads this row: an unknown kind fails the whole list, and the reply is drawn from its content.
    const message = mapMessageRow(row([{ id: 'a-1-b-0', kind: 'answer', rawText: 'Here you go.' }, { ...shown, kind: 'blocks-from-a-newer-backend' }]));
    expect(message.blocks?.map((block) => block.kind)).toEqual(['answer']);
    expect(visibleMessageText(message)).toBe('Here you go.\n\nPick\n\nWhich day?\n- Mon\n- Tue');
  });
});
