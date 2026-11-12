import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { closesFence, openingFence } from '../src/index';

describe('Markdown fences', () => {
  test('opens on three or more backticks or tildes, indented up to three spaces', () => {
    assert.deepEqual(openingFence('````md'), { char: '`', length: 4 });
    assert.deepEqual(openingFence('   ~~~'), { char: '~', length: 3 });
    assert.equal(openingFence('    ```'), null);
    assert.equal(openingFence('``'), null);
    assert.equal(openingFence('```a`b'), null);
    assert.deepEqual(openingFence('~~~a`b'), { char: '~', length: 3 });
  });

  test('closes on a bare run of the same character at least as long, at any indent', () => {
    const fence = { char: '`', length: 4 } as const;
    assert.equal(closesFence('```js', fence), false);
    assert.equal(closesFence('```', fence), false);
    assert.equal(closesFence('~~~~', fence), false);
    assert.equal(closesFence('````', fence), true);
    assert.equal(closesFence('  `````', fence), true);
  });
});
