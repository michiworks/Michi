import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LEAN_NODE_FIELD_COLUMNS, LEAN_NODE_FIELDS, parseLeanNodeFields } from '../src/index';

describe('lean node fields', () => {
  test('reads only the fields it knows, in their own order', () => {
    assert.deepEqual(parseLeanNodeFields(['composer_draft', 'nope', 'branch_overview', 7]), ['branch_overview', 'composer_draft']);
    for (const value of [undefined, null, 'branch_overview', {}, []]) assert.deepEqual(parseLeanNodeFields(value), []);
    // Each field names its own column first: a row defers it when that key is absent.
    for (const field of LEAN_NODE_FIELDS) assert.equal(LEAN_NODE_FIELD_COLUMNS[field][0], field);
  });
});
