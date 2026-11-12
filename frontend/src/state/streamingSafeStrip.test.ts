import { describe, it, expect } from 'vitest';
import { stripSentinelsStreamingSafe } from './assistantParsing';

describe('stripSentinelsStreamingSafe — remapOffset', () => {
  it('clamps offsets inside an unresolved tail-hold to that tail start', () => {
    const raw = 'body[TITLE: a';
    const { visibleText, remapOffset } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe('body');
    // Anywhere inside the tail-hold maps to visible end (== "body".length).
    for (let i = 4; i <= raw.length; i++) expect(remapOffset(i)).toBe(4);
  });
});

describe('stripSentinelsStreamingSafe — quoted prefixes', () => {
  it('holds a quoted prefix only until its line ends', () => {
    const raw = 'missing [BRANCH-OVERVIEW:\n- next item\n\n[BRANCH-OVERVIEW: done]';
    expect(stripSentinelsStreamingSafe('missing [BRANCH-OVERVIEW:').visibleText).toBe('missing ');
    expect(stripSentinelsStreamingSafe(raw).visibleText).toBe('missing [BRANCH-OVERVIEW:\n- next item\n\n');
  });

  it('keeps inline code visible and never shrinks while streaming', () => {
    const raw = 'quote `[TITLE:` and `]` here\n[TITLE: real]\nbody';
    let previous = '';
    for (let end = 1; end <= raw.length; end++) {
      const { visibleText } = stripSentinelsStreamingSafe(raw.slice(0, end));
      expect(visibleText.startsWith(previous)).toBe(true);
      previous = visibleText;
    }
    expect(previous).toBe('quote `[TITLE:` and `]` here\nbody');
  });

  it('never shrinks while a bare quoted prefix is held and then released at its newline', () => {
    const raw = 'a\n- x 少了 [BRANCH-OVERVIEW:\n- next\n\n'
      + '[FOLLOW-UP 1/3: q?]\n[FOLLOW-UP 2/3: r?]\n[FOLLOW-UP 3/3: s?]\n[BRANCH-OVERVIEW: o]';
    let previous = '';
    for (let end = 1; end <= raw.length; end++) {
      const { visibleText } = stripSentinelsStreamingSafe(raw.slice(0, end));
      expect(visibleText.startsWith(previous)).toBe(true);
      previous = visibleText;
    }
    expect(previous).toBe('a\n- x 少了 [BRANCH-OVERVIEW:\n- next\n\n');
  });

  it('holds text after a prefix at the end of the buffer until its line ends', () => {
    const held = stripSentinelsStreamingSafe('body\n- x [BRANCH-OVERVIEW: y');
    expect(held.visibleText).toBe('body\n- x ');
    expect(held.pendingRawTail).toBe('[BRANCH-OVERVIEW: y');
    const released = stripSentinelsStreamingSafe('body\n- x [BRANCH-OVERVIEW: y\n');
    expect(released.visibleText).toBe('body\n- x [BRANCH-OVERVIEW: y\n');
    expect(released.pendingRawTail).toBeUndefined();
  });
});
