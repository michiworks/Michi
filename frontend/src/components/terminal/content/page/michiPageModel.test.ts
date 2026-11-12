import { describe, expect, it } from 'vitest';
import type { MichiPageBlock } from 'michi-shared';
import { blockFullText, blockLabel, httpsUrl, looseTitle, timelineWhen } from './michiPageModel';

describe('looseTitle', () => {
  it('prefers title, question, label and name, then any other words', () => {
    expect(looseTitle({ type: 'x', title: '  Plan  ', label: 'L' })).toBe('Plan');
    expect(looseTitle({ type: 'x', question: 'Which route?' })).toBe('Which route?');
    expect(looseTitle({ type: 'x', id: 'abc', url: 'https://a.b', summary: 'Words' })).toBe('Words');
    expect(looseTitle({ type: 'divider', id: 'b1' })).toBe('');
    expect(looseTitle({ type: 'component', componentId: 'c', visibility: 'detail', interaction: { label: 'More' } })).toBe('');
  });
});

describe('blockLabel', () => {
  it('names a block by its heading, title or first markdown heading', () => {
    expect(blockLabel({ type: 'heading', text: 'Progress' })).toBe('Progress');
    expect(blockLabel({ type: 'plan-actual', title: 'Plan vs actual', items: [] })).toBe('Plan vs actual');
    expect(blockLabel({ type: 'markdown', text: 'Intro line\n\n## Goals\nMore' })).toBe('Goals');
    expect(blockLabel({ type: 'markdown', text: 'Just some prose about the plan that runs long' })).toBe('Just some prose about…');
    expect(blockLabel({ type: 'divider' })).toBe('Divider');
    expect(blockLabel({ type: 'mystery-widget' })).toBe('mystery-widget');
  });

  it('tolerates malformed fields', () => {
    expect(blockLabel({ type: 'heading', text: 42 as unknown as string })).toBe('42');
    expect(blockLabel({ type: 'callout', title: null, text: undefined })).toBe('Callout');
  });
});

describe('blockFullText', () => {
  it('renders a compact plain-text version with the label first', () => {
    const block: MichiPageBlock = {
      type: 'plan-actual',
      title: 'Plan vs actual',
      items: [{ label: 'Schema', planned: 2, actual: 3, unit: 'd' }, { label: 'Tests', planned: 3, actual: 0, unit: 'd' }],
    };
    expect(blockFullText(block)).toBe('Plan vs actual\nSchema: actual 3d / planned 2d\nTests: actual — / planned 3d');
  });

  it('summarises lists, tables and threads', () => {
    expect(blockFullText({ type: 'checklist', title: 'Before', items: [{ text: 'Book', done: true }, { text: 'Pack', done: false }] }))
      .toBe('Before\n[x] Book\n[ ] Pack');
    expect(blockFullText({ type: 'table', columns: ['Day', 'Plan'], rows: [['Mon', 'Kyoto']] }))
      .toBe('Table\nDay | Plan\nMon | Kyoto');
  });

  it('never throws on junk', () => {
    expect(() => blockFullText({ type: 'metrics', items: 'nope' })).not.toThrow();
    expect(() => blockFullText({ type: 'columns', columns: [[null, { type: 'markdown', text: 'A' }], 'x'] })).not.toThrow();
    expect(blockFullText({ type: 'columns', columns: [[{ type: 'markdown', text: 'Left' }], [{ type: 'heading', text: 'Right' }]] }))
      .toContain('Left');
  });

  it('summarises native metrics notes, next steps and timeline details', () => {
    expect(blockFullText({ type: 'metrics', items: [{ label: 'Ahead', value: '22', note: 'Not merged' }] })).toBe('Ahead\nAhead: 22 (Not merged)');
    expect(blockFullText({ type: 'next-steps', title: 'Next', items: [{ who: 'user', text: 'Confirm', unblocks: 'Notes' }, { who: 'agent', text: 'Test' }] }))
      .toBe('Next\nYou: Confirm (unblocks Notes)\nAgent: Test');
    expect(blockFullText({ type: 'timeline', title: 'Progress', items: [{ title: 'Kickoff', at: 'Oct 2', detail: 'Planned' }] }))
      .toBe('Progress\nOct 2 — Kickoff: Planned');
  });
});

describe('timelineWhen', () => {
  const now = new Date(2026, 9, 23, 12, 0);
  it('shows month, day and local time this year, the year otherwise, and free text as it is', () => {
    expect(timelineWhen(new Date(2026, 9, 22, 15, 21).getTime(), now)).toEqual({ text: '10-22 15:21', dateTime: new Date(2026, 9, 22, 15, 21).toISOString() });
    expect(timelineWhen('2026-10-22T05:35', now).text).toBe('10-22 05:35');
    expect(timelineWhen('2025-12-31T23:05', now).text).toBe('2025-12-31 23:05');
    expect(timelineWhen('2026-10-22', now)).toEqual({ text: '10-22', dateTime: '2026-10-22' });
    expect(timelineWhen('2025-01-02', now).text).toBe('2025-01-02');
    expect(timelineWhen('Oct 2', now)).toEqual({ text: 'Oct 2' });
    expect(timelineWhen(undefined, now)).toEqual({ text: '' });
  });
});

describe('httpsUrl', () => {
  it('accepts only https urls', () => {
    expect(httpsUrl(' https://example.com/a ')).toBe('https://example.com/a');
    expect(httpsUrl('http://example.com')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
    expect(httpsUrl(42)).toBeNull();
  });
});

describe('plain words from Markdown', () => {
  it('keeps underscores inside words and drops emphasis around them', () => {
    expect(blockLabel({ type: 'markdown', text: 'Go **snake_case** _now_' })).toBe('Go snake_case now');
    expect(blockLabel({ type: 'markdown', text: '__Bold__ start' })).toBe('Bold start');
  });
});
