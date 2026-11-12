import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { estimateTokens } from '../src/index';

describe('estimateTokens', () => {
  test('counts four characters a token outside CJK', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
  });

  test('counts each CJK, Hangul or full-width character as a token', () => {
    assert.equal(estimateTokens('中文测试'), 4);
    assert.equal(estimateTokens('日本語'), 3);
    assert.equal(estimateTokens('한국어'), 3);
    assert.equal(estimateTokens('ＡＢ'), 2);
  });

  test('adds both kinds in mixed text', () => {
    assert.equal(estimateTokens('合并 three threads'), 2 + Math.ceil(' three threads'.length / 4));
  });
});
