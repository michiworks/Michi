import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackCodexTitle, parseGeneratedCodexTitle } from '../src/adapters/codex/codexTitleGenerator';
import { cleanGeneratedTitle } from '../src/core/titles';

describe('Codex sidecar titles', () => {
  it('clean a model reply the way every runtime does', () => {
    for (const raw of ['Title: "Fixing flaky tests"', '**Fixing flaky tests**', '「Fixing flaky tests」', 'Fixing flaky tests\nSecond line',
      'Sure. [TITLE: Fixing flaky tests]']) {
      assert.equal(parseGeneratedCodexTitle(raw, 'fix the tests'), cleanGeneratedTitle(raw), raw);
    }
    assert.equal(parseGeneratedCodexTitle('{"title": "Title: Fixing flaky tests"}', 'fix the tests'), 'Fixing flaky tests');
  });

  it('fall back to the first sentence of the request, else a fixed name', () => {
    assert.equal(fallbackCodexTitle('/btw How do I fix this? And also that.'), 'How do I fix this');
    assert.equal(parseGeneratedCodexTitle('   ', '   '), 'New Codex Request');
  });
});
