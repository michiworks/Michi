import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { splitPageMarkdown } from '../src/index';

const texts = (t: string) => splitPageMarkdown(t).map((s) => s.text);
const kinds = (t: string) => splitPageMarkdown(t).map((s) => s.kind);
const noBlank = (t: string) => t.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim()).join('\n');

// Segment numbering names `<block>~<n>` in Contents links and citations.
describe('splitPageMarkdown', () => {
  test('keeps fenced code one segment, even with blank lines inside', () => {
    const t = 'intro\n\n```ts\nconst a=1;\n\n\nconst b=2;\n```\n\nafter';
    assert.deepEqual(texts(t), ['intro', '```ts\nconst a=1;\n\n\nconst b=2;\n```', 'after']);
    assert.deepEqual(kinds(t), ['paragraph', 'code', 'paragraph']);
    assert.deepEqual(texts('~~~\na\n\n```\nb\n~~~~\nc'), ['~~~\na\n\n```\nb\n~~~~', 'c']);
    assert.deepEqual(kinds('```\na\n\nb'), ['code']);
    assert.deepEqual(kinds('```a`b\n\nc'), ['paragraph', 'paragraph']);
    assert.deepEqual(texts('```\n# not a heading\n- not a list\n> not a quote\n```'),
      ['```\n# not a heading\n- not a list\n> not a quote\n```']);
  });

  test('makes each heading a segment, even without blank lines around it', () => {
    const t = '# Title\nbody line\n## Next\n\n###### Six\n####### seven';
    assert.deepEqual(texts(t), ['# Title', 'body line', '## Next', '###### Six', '####### seven']);
    assert.deepEqual(kinds(t), ['heading', 'paragraph', 'heading', 'heading', 'paragraph']);
    assert.deepEqual(kinds('#hashtag not a heading'), ['paragraph']);
  });

  test('splits lists per item and keeps an indented continuation with its item', () => {
    const t = '- one\n- two\n  more of two\n\n  still two after a blank line\n  - nested\n- three\n\n1. a\n2) b\n+ c\n* d';
    assert.deepEqual(texts(t), ['- one', '- two\n  more of two\n\n  still two after a blank line\n  - nested', '- three', '1. a', '2) b', '+ c', '* d']);
    assert.ok(kinds(t).every((k) => k === 'list-item'));
    assert.deepEqual(texts('- a\n\nplain\n-b\n-'), ['- a', 'plain\n-b\n-']);
    assert.deepEqual(kinds('- a\n\nplain'), ['list-item', 'paragraph']);
    assert.deepEqual(texts('  - a\n  - b'), ['  - a', '  - b']);
    assert.deepEqual(texts('- run\n  ```\n  x\n\ny\n  ```\n- next'), ['- run\n  ```\n  x\n\ny\n  ```', '- next']);
  });

  test('groups table rows and quote lines', () => {
    const t = '| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n> more\n\ntext\n| after |\n> q2';
    assert.deepEqual(texts(t), ['| a | b |\n|---|---|\n| 1 | 2 |', '> quoted\n> more', 'text', '| after |', '> q2']);
    assert.deepEqual(kinds(t), ['table', 'quote', 'paragraph', 'table', 'quote']);
    assert.deepEqual(texts('> a\n\n> b\n\n| x |\n\n| y |'), ['> a', '> b', '| x |', '| y |']);
  });

  test('numbers from zero and finds nothing in blank text', () => {
    assert.deepEqual(splitPageMarkdown('# a\n\nb\n\n- c').map((s) => s.index), [0, 1, 2]);
    for (const t of ['', '  ', '\n\n\n']) assert.deepEqual(splitPageMarkdown(t), []);
    assert.deepEqual(texts('a\r\nb\r\n\r\n\r\nc'), ['a\nb', 'c']);
  });

  test('round-trips through a blank-line join, blank lines aside', () => {
    const t = ['# Plan', 'intro line one', 'intro line two', '', '- a', '- b', '  detail', '', '  detail 2', '1. x', '2. y', '',
      '```js', 'let a;', '', 'let b;', '```', '| h |', '|---|', '| c |', '', '> q1', '> q2', '', 'end'].join('\n');
    assert.equal(noBlank(texts(t).join('\n\n')), noBlank(t));
    assert.deepEqual(texts(texts(t).join('\n\n')), texts(t));
  });
});
