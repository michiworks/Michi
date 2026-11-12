import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeTargetKey, rowLocation } from '../src/index';

const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('a row location is its position and the row before it; a missing row goes after the last', () => {
  assert.deepEqual(rowLocation({ rows }, 'a'), { position: 0, after: null });
  assert.deepEqual(rowLocation({ rows }, 'b'), { position: 1, after: 'a' });
  assert.deepEqual(rowLocation({ rows }, 'gone'), { position: 3, after: 'c' });
  assert.deepEqual(rowLocation({ rows: [] }, 'gone'), { position: 0, after: null });
});

test('a change target key names the kind and its ids', () => {
  assert.equal(changeTargetKey({ kind: 'block', pageId: 'pg', blockId: 'b1' }), 'block:pg:b1');
  assert.equal(changeTargetKey({ kind: 'row', databaseId: 'db', rowId: 'r1', columnIds: ['x'] }), 'row:db:r1');
  assert.equal(changeTargetKey({ kind: 'row', databaseId: 'db', rowId: 'r1' }), 'row:db:r1');
  assert.equal(changeTargetKey({ kind: 'database', databaseId: 'db' }), 'database:db');
});
