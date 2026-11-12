import { describe, expect, it } from 'vitest';
import {
  fractionForScroll,
  fractionForThumb,
  lastAtOrAbove,
  scrubLabelText,
  scrubberAvailable,
  thumbCenter,
} from './transcriptScrubber';
import { formatMessageTime } from './messageTime';

describe('scrubberAvailable', () => {
  it('needs four questions and three screens of content', () => {
    expect(scrubberAvailable(4, 3000, 1000)).toBe(true);
    expect(scrubberAvailable(3, 9000, 1000)).toBe(false);
    expect(scrubberAvailable(12, 2999, 1000)).toBe(false);
    expect(scrubberAvailable(12, 3000, 0)).toBe(false);
  });
});

describe('thumb geometry', () => {
  it('maps scroll position proportionally and clamps', () => {
    expect(fractionForScroll(0, 2000)).toBe(0);
    expect(fractionForScroll(500, 2000)).toBe(0.25);
    expect(fractionForScroll(2400, 2000)).toBe(1);
    expect(fractionForScroll(-10, 2000)).toBe(0);
    expect(fractionForScroll(100, 0)).toBe(0);
  });

  it('keeps the whole thumb inside the track', () => {
    expect(thumbCenter(0, 500, 40)).toBe(20);
    expect(thumbCenter(1, 500, 40)).toBe(480);
    expect(thumbCenter(0.5, 500, 40)).toBe(250);
  });

  it('inverts thumbCenter', () => {
    for (const f of [0, 0.1, 0.37, 0.5, 0.92, 1]) {
      expect(fractionForThumb(thumbCenter(f, 612, 42), 612, 42)).toBeCloseTo(f, 10);
    }
    expect(fractionForThumb(-50, 612, 42)).toBe(0);
    expect(fractionForThumb(9999, 612, 42)).toBe(1);
    expect(fractionForThumb(10, 30, 42)).toBe(0);
  });
});

describe('lastAtOrAbove', () => {
  const tops = [0, 120, 480, 900, 1500];
  const at = (i: number) => tops[i];

  it('names the last question at or above the line', () => {
    expect(lastAtOrAbove(tops.length, at, 0)).toBe(0);
    expect(lastAtOrAbove(tops.length, at, 119)).toBe(0);
    expect(lastAtOrAbove(tops.length, at, 120)).toBe(1);
    expect(lastAtOrAbove(tops.length, at, 899)).toBe(2);
    expect(lastAtOrAbove(tops.length, at, 1e9)).toBe(4);
  });

  it('falls back to the first question above all of them, and -1 for none', () => {
    expect(lastAtOrAbove(tops.length, (i) => tops[i] + 50, 10)).toBe(0);
    expect(lastAtOrAbove(0, at, 10)).toBe(-1);
  });

  it('reads only a logarithmic number of tops', () => {
    let reads = 0;
    const many = Array.from({ length: 1000 }, (_, i) => i * 100);
    expect(lastAtOrAbove(many.length, (i) => { reads++; return many[i]; }, 51_234)).toBe(512);
    expect(reads).toBeLessThanOrEqual(11);
  });
});

describe('scrubLabelText', () => {
  it('puts the user text on one line', () => {
    expect(scrubLabelText({ text: '  Why does the\n\nscroll   position jump?  ' })).toBe('Why does the scroll position jump?');
  });

  it('leaves out a flattened quote but keeps a quote-only message', () => {
    expect(scrubLabelText({ text: '> the second option\n> with turn ids\n\nOK, do that and add tests' })).toBe('OK, do that and add tests');
    expect(scrubLabelText({ text: '> only a quote' })).toBe('only a quote');
  });

  it('describes attachment-only and empty messages', () => {
    expect(scrubLabelText({ text: '', attachments: [{}] })).toBe('1 attachment');
    expect(scrubLabelText({ text: '', attachments: [{}, {}] })).toBe('2 attachments');
    expect(scrubLabelText({ text: '' })).toBe('Message');
  });
});

describe('formatMessageTime', () => {
  const now = new Date(2026, 10, 6, 15, 0);
  it('shows the clock today and the date before', () => {
    expect(formatMessageTime(new Date(2026, 10, 6, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatMessageTime(new Date(2026, 10, 5, 17, 35).getTime(), now)).toBe('11/5 17:35');
    expect(formatMessageTime(undefined, now)).toBe('');
  });
});
