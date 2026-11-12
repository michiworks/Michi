import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clampText, ellipsize, joinAnd, oneLine, plural } from '../src/index';

test('ellipsize keeps text within the budget, ellipsis included', () => {
  assert.equal(ellipsize('abcde', 5), 'abcde');
  assert.equal(ellipsize('abcdef', 5), 'abcd…');
  assert.equal(ellipsize('长一点的中文句子', 4), '长一点…');
  assert.equal(ellipsize('abc', 1), '…');
  assert.equal(ellipsize('abc', 0), '…');
});

test('ellipsize never leaves half an emoji before the ellipsis', () => {
  assert.equal(ellipsize('a😀b', 3), 'a…');
  assert.equal(ellipsize('a😀bc', 4), 'a😀…');
  assert.equal(ellipsize('😀😀', 2), '…');
});

test('oneLine collapses whitespace before it cuts, and clampText drops blank values', () => {
  assert.equal(oneLine('  Run   npm test\nin\tbackend  ', 200), 'Run npm test in backend');
  assert.equal(oneLine('one two three', 8), 'one two…');
  assert.equal(clampText('  kept  ', 10), 'kept');
  assert.equal(clampText('   ', 10), undefined);
  assert.equal(clampText(42, 10), undefined);
  for (const sample of ['a😀bc', 'x'.repeat(30), '  padded  ']) {
    assert.equal(clampText(clampText(sample, 4), 4), clampText(sample, 4), 'cutting again changes nothing');
  }
});

describe('plural', () => {
  test('puts the count before the noun, adding s unless told the plural', () => {
    assert.equal(plural(0, 'thread'), '0 threads');
    assert.equal(plural(1, 'thread'), '1 thread');
    assert.equal(plural(2, 'thread'), '2 threads');
    assert.equal(plural(1, 'branch', 'branches'), '1 branch');
    assert.equal(plural(2, 'branch', 'branches'), '2 branches');
  });
});

describe('joinAnd', () => {
  test('joins names as prose, with no Oxford comma', () => {
    assert.equal(joinAnd([]), '');
    assert.equal(joinAnd(['A']), 'A');
    assert.equal(joinAnd(['A', 'B']), 'A and B');
    assert.equal(joinAnd(['A', 'B', 'C']), 'A, B and C');
  });
});
