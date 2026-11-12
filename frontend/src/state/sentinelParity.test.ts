import { describe, expect, it } from 'vitest';
import { stripTurnMetadataSentinels } from 'michi-shared';
import sharedSource from '../../../shared/src/turnProjection.ts?raw';
import runnerSource from './chatStreamRunner.ts?raw';
import { stripSentinelsStreamingSafe } from './assistantParsing';

// chatStreamRunner's side-effect dispatcher keeps its own copy of shared's
// sentinel prefixes (STR-03). Until it uses shared's, both copies must list
// the same prefixes.
const PREFIXES = ['[TITLE:', '[BRANCH-OVERVIEW:', '[FOLLOW-UP'];
const DECLARATION_RE = /\bSENTINEL_PREFIXES\s*=\s*\[([\s\S]*?)\]\s*(?:as const)?\s*;/g;

function prefixLists(source: string): string[][] {
  return [...source.matchAll(DECLARATION_RE)].map((match) =>
    [...match[1].matchAll(/(['"])(.*?)\1/g)].map((literal) => literal[2]));
}

describe('metadata sentinel prefix parity', () => {
  it('shared and chatStreamRunner list the same prefixes', () => {
    expect(prefixLists(sharedSource)).toEqual([PREFIXES]);
    expect(prefixLists(runnerSource)).toEqual([PREFIXES]);
  });

  for (const prefix of PREFIXES) {
    it(`holds every partial ${prefix} at the end of the buffer and cuts the closed sentinel`, () => {
      for (let length = 1; length <= prefix.length; length++) {
        const partial = prefix.slice(0, length);
        const projection = stripSentinelsStreamingSafe(`body ${partial}`);
        expect(projection.visibleText, partial).toBe('body ');
        expect(projection.pendingRawTail, partial).toBe(partial);
        expect(stripTurnMetadataSentinels(`body ${partial}`), partial).toBe('body ');
      }
      // An overview ends at its line's last `]`, so text after one waits for the line to end.
      const closed = prefix === '[BRANCH-OVERVIEW:' ? `a ${prefix} x] b\n` : `a ${prefix} x] b`;
      const visible = prefix === '[BRANCH-OVERVIEW:' ? 'a b\n' : 'a b';
      expect(stripSentinelsStreamingSafe(closed).visibleText).toBe(visible);
      expect(stripTurnMetadataSentinels(closed)).toBe(visible);
    });
  }
});
