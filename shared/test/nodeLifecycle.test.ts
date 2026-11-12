import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isArchiveGroupId, nodeLifecycleState } from '../src/nodeLifecycle';

test('a node is purged, in Trash, archived or live, in that order', () => {
  const cases: Array<[string, Parameters<typeof nodeLifecycleState>[0], ReturnType<typeof nodeLifecycleState>]> = [
    ['nothing set', {}, 'live'],
    ['purged', { purgedAt: 1, deletedAt: 1, deletionGroupId: 'arch-1' }, 'purged'],
    ['Trash', { deletedAt: 1, deletionGroupId: 'trim-1' }, 'trashed'],
    ['deleted without a group', { deletedAt: 1 }, 'trashed'],
    ['workspace in Trash', { workspaceDeletedAt: 1, deletedAt: 1, deletionGroupId: 'arch-1' }, 'trashed'],
    ['thread in Trash while archived', { deletedAt: 1, deletionGroupId: 'tree-1', treeArchivedAt: 1 }, 'trashed'],
    ['archive lane', { deletedAt: 1, deletionGroupId: 'arch-1' }, 'archived'],
    ['older archived status', { status: 'archived' }, 'archived'],
    ['archived thread', { treeArchivedAt: 1 }, 'archived'],
    ['archived workspace', { workspaceArchivedAt: 1 }, 'archived'],
    ['archive group id without deletion', { deletionGroupId: 'arch-1' }, 'live'],
  ];
  for (const [name, facts, state] of cases) assert.equal(nodeLifecycleState(facts), state, name);
  assert.deepEqual([isArchiveGroupId('arch-1'), isArchiveGroupId('trim-arch-1'), isArchiveGroupId(null)], [true, false, false]);
});
