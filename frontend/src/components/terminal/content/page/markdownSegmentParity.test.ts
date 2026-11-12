import { describe, expect, it } from 'vitest';
import { splitPageMarkdown } from 'michi-shared';
import { parseSegmentId, segmentId, splitMarkdown } from './vendor-blocks/shared/markdown-segments';

// Contents (the Desk outline) names Markdown headings with the vendored splitter, and Michi draws the
// `<block>~<n>` shells with the shared one. A Desk sync that changes either must keep them in step.
const CORPUS = [
  'intro\n\n```ts\nconst a=1;\n\n\nconst b=2;\n```\n\nafter',
  '~~~\na\n\n```\nb\n~~~~\nc',
  '```\na\n\nb',
  '```a`b\n\nc',
  '```\n# not a heading\n- not a list\n> not a quote\n```',
  '# Title\nbody line\n## Next\n\n###### Six\n####### seven',
  '#hashtag not a heading',
  '- one\n- two\n  more of two\n\n  still two after a blank line\n  - nested\n- three\n\n1. a\n2) b\n+ c\n* d',
  '- a\n\nplain\n-b\n-',
  '  - a\n  - b',
  '- run\n  ```\n  x\n\ny\n  ```\n- next',
  '1) first\n2) second\n   ~~~\n   code\n   ~~~\n3) third',
  '| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n> more\n\ntext\n| after |\n> q2',
  '> a\n\n> b\n\n| x |\n\n| y |',
  '# Goals\r\nShip it.\r\n\r\n## Risks\r\n- late\r\n\r\n## Timeline\r\nQ3',
  '',
  '\n\n\n',
];

describe('Markdown segment parity', () => {
  it.each(CORPUS)('splits the same way in shared and in the Desk mirror: %j', (text) => {
    expect(splitMarkdown(text)).toEqual(splitPageMarkdown(text));
  });

  it('spells and parses segment ids one way, and plain ids parse to null', () => {
    expect(segmentId('intro', 3)).toBe('intro~3');
    expect(parseSegmentId(segmentId('intro', 3))).toEqual({ blockId: 'intro', index: 3 });
    expect(parseSegmentId(segmentId('b-1.x_y', 0))).toEqual({ blockId: 'b-1.x_y', index: 0 });
    expect(parseSegmentId('a~b~12')).toEqual({ blockId: 'a~b', index: 12 });
    for (const id of ['intro', 'b0', 'a-2', '', '~3', 'a~', 'a~x', 'a~-1', 'a~1.5', 'a~01', 'a~1 ', 'a~99999999999999999999']) {
      expect(parseSegmentId(id), id).toBeNull();
    }
  });
});
