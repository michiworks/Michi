import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isRecord } from '../src/guards';

describe('isRecord', () => {
  test('accepts plain objects and rejects null, arrays and primitives', () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    for (const value of [null, undefined, [], [1], 'x', 1, true]) assert.equal(isRecord(value), false, String(value));
  });
});
