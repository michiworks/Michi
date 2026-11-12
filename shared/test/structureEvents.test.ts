import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isWindowId, isWorkspaceStructureChangedEvent, isWorkspaceStructureCursor } from '../src/index';

describe('workspace structure frames', () => {
  test('accept the frame shapes the backend sends', () => {
    assert.equal(isWorkspaceStructureChangedEvent({ epoch: 'e', seq: 0, changes: [] }), true);
    assert.equal(isWorkspaceStructureChangedEvent({ epoch: 'e', seq: 4, changes: [], resync: true }), true);
    assert.equal(isWorkspaceStructureChangedEvent({
      epoch: 'e', seq: 5,
      changes: [
        { entity: 'tree', op: 'moved', workspaceId: 'ws-2', fromWorkspaceId: 'ws-1', treeId: 't', originWindowId: 'w-1' },
        { entity: 'node', op: 'purged', workspaceId: 'ws-2', nodeId: 'n' },
      ],
    }), true);
  });

  test('reject what a window cannot act on', () => {
    for (const value of [
      null,
      { epoch: '', seq: 0, changes: [] },
      { epoch: 'e', seq: -1, changes: [] },
      { epoch: 'e', seq: 1.5, changes: [] },
      { epoch: 'e', seq: 1 },
      { epoch: 'e', seq: 1, changes: [], resync: false },
      { epoch: 'e', seq: 1, changes: [{ entity: 'page', op: 'created', workspaceId: 'ws' }] },
      { epoch: 'e', seq: 1, changes: [{ entity: 'tree', op: 'exploded', workspaceId: 'ws' }] },
      { epoch: 'e', seq: 1, changes: [{ entity: 'tree', op: 'created', workspaceId: '' }] },
      { epoch: 'e', seq: 1, changes: [{ entity: 'tree', op: 'created', workspaceId: 'ws', treeId: 7 }] },
      { epoch: 'e', seq: 1, changes: [{ entity: 'tree', op: 'created', workspaceId: 'ws', originWindowId: 'has space' }] },
    ]) {
      assert.equal(isWorkspaceStructureChangedEvent(value), false, JSON.stringify(value));
    }
    assert.equal(isWorkspaceStructureCursor({ epoch: 'e', seq: 3 }), true);
    assert.equal(isWorkspaceStructureCursor({ epoch: 'e' }), false);
  });

  test('window ids are what renderers mint and nothing else', () => {
    assert.equal(isWindowId('1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'), true);
    assert.equal(isWindowId('w-1730000000000-abc123'), true);
    assert.equal(isWindowId(''), false);
    assert.equal(isWindowId('a'.repeat(161)), false);
    assert.equal(isWindowId('id\nwith-newline'), false);
    assert.equal(isWindowId(42), false);
  });
});
