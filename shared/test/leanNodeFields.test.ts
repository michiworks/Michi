import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { composerDraftHasPendingSpawnPrompt, LEAN_NODE_FIELD_COLUMNS, LEAN_NODE_FIELDS, parseLeanNodeFields } from '../src/index';

describe('lean node fields', () => {
  test('reads only the fields it knows, in their own order', () => {
    assert.deepEqual(parseLeanNodeFields(['composer_draft', 'nope', 'branch_overview', 7]), ['branch_overview', 'composer_draft']);
    for (const value of [undefined, null, 'branch_overview', {}, []]) assert.deepEqual(parseLeanNodeFields(value), []);
    // Each field names its own column first: a row defers it when that key is absent.
    for (const field of LEAN_NODE_FIELDS) assert.equal(LEAN_NODE_FIELD_COLUMNS[field][0], field);
  });

  test('finds the spawn outbox, alone or beside window drafts', () => {
    assert.equal(composerDraftHasPendingSpawnPrompt(JSON.stringify({ __michiPendingSpawnPrompt: 'Go' })), true);
    assert.equal(composerDraftHasPendingSpawnPrompt(JSON.stringify({ __michiPendingSpawnPrompt: 'Go', __michiWindowDrafts: { w: null } })), true);
    for (const raw of [JSON.stringify({ __michiPendingSpawnPrompt: '  ' }), JSON.stringify({ value: '__michiPendingSpawnPrompt' }),
      '{"__michiPendingSpawnPrompt":', null, undefined, 42]) {
      assert.equal(composerDraftHasPendingSpawnPrompt(raw), false, String(raw));
    }
  });
});
