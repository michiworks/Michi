import { describe, expect, it } from 'vitest';
import { appendComposerLine, mergeComposerDraft, prependToDraft } from './composerDraft';
import type { ComposerDraft } from './chatTypes';

const mention = (start: number, end: number, label: string) => ({ start, end, kind: 'node' as const, refId: label, label });
const chips = (draft: ComposerDraft | null) => draft!.mentions.map((m) => draft!.value.slice(m.start, m.end));

describe('prependToDraft', () => {
  it('moves mention ranges along with the text', () => {
    const draft = prependToDraft('ctx\n\n', { value: '@a and @b', mentions: [mention(0, 2, 'a'), mention(7, 9, 'b')] });
    expect(draft.value).toBe('ctx\n\n@a and @b');
    expect(draft.mentions.map((m) => draft.value.slice(m.start, m.end))).toEqual(['@a', '@b']);
  });
});

describe('appendComposerLine', () => {
  it('adds the text on a new line after the draft, keeping its mentions and quote', () => {
    const draft = appendComposerLine({ value: 'ask @a  \n', mentions: [mention(4, 6, 'a')], quotedText: 'q' }, '  next step ');
    expect(draft).toEqual({ value: 'ask @a\nnext step', mentions: [mention(4, 6, 'a')], quotedText: 'q' });
  });

  it('is the text alone in an empty draft, and leaves the draft for empty text', () => {
    const empty = { value: ' ', mentions: [] };
    expect(appendComposerLine(empty, 'hello').value).toBe('hello');
    expect(appendComposerLine(empty, '  ')).toBe(empty);
  });
});

describe('mergeComposerDraft', () => {
  it('puts the restored text in front of the current text, keeping every mention on its chip', () => {
    const merged = mergeComposerDraft(
      { value: 'A @x', mentions: [mention(2, 4, 'x')] },
      { value: 'B @y', mentions: [mention(2, 4, 'y')] },
    );
    expect(merged!.value).toBe('A @x\n\nB @y');
    expect(chips(merged)).toEqual(['@x', '@y']);
  });

  it('joins two quotes from the same source and keeps that source', () => {
    const source = { type: 'artifact' as const, filePath: '/doc.md' };
    const merged = mergeComposerDraft(
      { value: 'A', mentions: [], quotedText: 'first', quoteSource: source },
      { value: 'B', mentions: [], quotedText: 'second', quoteSource: source },
    );
    expect(merged).toMatchObject({ value: 'A\n\nB', quotedText: 'first\n\nsecond', quoteSource: source });
  });

  it('frames a restored quote from another source into the text and keeps the current chip', () => {
    const current = { type: 'artifact' as const, filePath: '/now.md' };
    const merged = mergeComposerDraft(
      { value: '@x A', mentions: [mention(0, 2, 'x')], quotedText: 'older passage' },
      { value: '@y B', mentions: [mention(0, 2, 'y')], quotedText: 'current passage', quoteSource: current },
    );
    expect(merged!.value).toMatch(/^Context: The user selected the passage below from the previous assistant reply\./);
    expect(merged!.value).toContain('> older passage');
    expect(merged!.value.endsWith('@x A\n\n@y B')).toBe(true);
    expect(chips(merged)).toEqual(['@x', '@y']);
    expect(merged).toMatchObject({ quotedText: 'current passage', quoteSource: current });
  });

  it('keeps the current quote when the restored message has none', () => {
    const merged = mergeComposerDraft({ value: 'A', mentions: [] }, { value: '', mentions: [], quotedText: 'kept' });
    expect(merged).toMatchObject({ value: 'A', quotedText: 'kept' });
  });

  it('returns whichever side has anything when the other is empty', () => {
    const typed = { value: 'B', mentions: [] };
    expect(mergeComposerDraft({ value: '', mentions: [] }, typed)).toEqual({ value: 'B', mentions: [], quotedText: undefined });
    expect(mergeComposerDraft(typed, null)).toEqual({ value: 'B', mentions: [], quotedText: undefined });
    expect(mergeComposerDraft(null, undefined)).toBeNull();
  });
});
