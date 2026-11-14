import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractTurnMetadata, finalizeTurnContent, stripTurnMetadataSentinels } from '../src/turnProjection';

const END_BLOCK = '[FOLLOW-UP 1/3: q?]\n[FOLLOW-UP 2/3: r?]\n[FOLLOW-UP 3/3: s?]\n[BRANCH-OVERVIEW: o]';

/** The visible text after each four-character chunk; it must never shrink. */
function streamVisible(raw: string): string {
  let streamed = '';
  let shown = '';
  for (const chunk of raw.match(/[\s\S]{1,4}/g) ?? []) {
    streamed += chunk;
    const visible = stripTurnMetadataSentinels(streamed);
    assert.ok(visible.startsWith(shown), `visible text shrank at ${streamed.length}: ${JSON.stringify(raw)}`);
    shown = visible;
  }
  return shown;
}

test('a follow-up marker with text before it on its line stays in the answer, live and persisted', () => {
  for (const answer of [
    'The parser groups a line like [FOLLOW-UP 1/3: foo] inline, see below.',
    'Write the first one as [FOLLOW-UP 1/3: How does X work?]\nand the UI shows it as a chip.',
    'Two in prose: [FOLLOW-UP 1/3: a] and [FOLLOW-UP 2/3: b] stay.',
    'A question may quote [FOLLOW-UP 1/3: 用 [TITLE:] 吗？] here.',
    'Quoted: `[FOLLOW-UP 1/3: q?]` stays.',
  ]) {
    const raw = `[TITLE: T]\n${answer}\n\n${END_BLOCK}`;
    assert.equal(finalizeTurnContent(raw), answer);
    assert.deepEqual(extractTurnMetadata(raw), { title: 'T', followUps: ['q?', 'r?', 's?'], branchOverview: 'o' });
    assert.equal(streamVisible(raw), `${answer}\n\n`);
  }
});

test('follow-up lines, and Kiro\'s first one after the last sentence, are still metadata', () => {
  const answer = 'Body.';
  const raw = `${answer}\n\n${END_BLOCK}`;
  assert.equal(finalizeTurnContent(raw), answer);
  assert.deepEqual(extractTurnMetadata(raw), { followUps: ['q?', 'r?', 's?'], branchOverview: 'o' });
  assert.equal(streamVisible(raw), `${answer}\n\n`);
  // A follow-up on its own line, indented or not, is metadata wherever it is.
  assert.equal(stripTurnMetadataSentinels('Body.\n[FOLLOW-UP 1/3: a?]\nMore.'), 'Body.\nMore.');
  assert.equal(stripTurnMetadataSentinels('Body.\n  [FOLLOW-UP 1/3: a?]\nMore.'), 'Body.\n  More.');

  const kiro = '就可以一起删掉。[FOLLOW-UP 1/3: a?]\n[FOLLOW-UP 2/3: b?]\n[FOLLOW-UP 3/3: c?]';
  assert.equal(finalizeTurnContent(kiro), '就可以一起删掉。');
  assert.deepEqual(extractTurnMetadata(kiro).followUps, ['a?', 'b?', 'c?']);
  assert.equal(streamVisible(kiro), '就可以一起删掉。');
  assert.equal(streamVisible('就可以一起删掉。[FOLLOW-UP 1/3: a?]\n[BRANCH-OVERVIEW: o]'), '就可以一起删掉。');
});
