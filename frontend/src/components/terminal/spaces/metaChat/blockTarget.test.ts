import { describe, expect, it } from 'vitest';
import type { PageBlock } from 'michi-shared';
import { pageBlockTarget } from './blockTarget';

const block = (content: Record<string, unknown>) => ({ id: 'b', rev: 1, ...content }) as unknown as PageBlock;

describe('pageBlockTarget', () => {
  it('names a block by its heading, title or first words, and sends its text', () => {
    expect(pageBlockTarget(block({ type: 'markdown', text: 'Plain notes' }))).toEqual({ title: 'Plain notes', content: 'Plain notes' });
    expect(pageBlockTarget(block({ type: 'markdown', text: '### Goal\n\nShip the preview.' })).title).toBe('Goal');
    expect(pageBlockTarget(block({ type: 'heading', level: 2, text: 'Risks' }))).toEqual({ title: 'Risks', content: 'Risks' });
    expect(pageBlockTarget(block({ type: 'next-steps', title: 'Next steps', items: [{ who: 'agent', text: 'Run tests', unblocks: 'Merge' }] })))
      .toEqual({ title: 'Next steps', content: 'Next steps\nAgent: Run tests (unblocks Merge)' });
    expect(pageBlockTarget(block({ type: 'checklist', items: [{ id: 'i', text: 'Ship it', done: true }] })))
      .toEqual({ title: 'Checklist', content: 'Checklist\n[x] Ship it' });
  });

  it('never names a reference block by the id it points at', () => {
    expect(pageBlockTarget(block({ type: 'database-ref', databaseId: 'database-1' })).title).toBe('Database');
    expect(pageBlockTarget(block({ type: 'page-link', pageId: 'page-2' })).title).toBe('Linked page');
    expect(pageBlockTarget(block({ type: 'component', componentId: 'component-1', props: {} })).title).toBe('Component');
  });
});
