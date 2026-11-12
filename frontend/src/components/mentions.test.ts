import { describe, expect, it } from 'vitest';
import { expandMentions, type MentionRecord } from './mentions';

describe('expandMentions', () => {
  it('handles two mentions in order', () => {
    const a: MentionRecord = {
      start: 0, end: 4, kind: 'context', refId: 'c-1', label: 'foo',
    };
    const b: MentionRecord = {
      start: 5, end: 5 + 1 + 3, kind: 'node', refId: 'n-1', label: 'Bar',
    };
    expect(expandMentions('@foo @Bar tail', [a, b]))
      .toBe('@foo @node:n-1 tail');
  });

  it('encodes remote identity only in the expanded text, leaving the draft reference intact', () => {
    const mention: MentionRecord = {
      start: 0, end: 7, kind: 'node', refId: 'remote:ssh%3Aa:n-1', label: 'Remote',
    };
    expect(expandMentions('@Remote.', [mention])).toBe('@node:remote%3Assh%253Aa%3An-1.');
    expect(mention.refId).toBe('remote:ssh%3Aa:n-1');
  });
});
