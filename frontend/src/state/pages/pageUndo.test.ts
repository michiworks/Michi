import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribePageChanges } from './pageEvents';
import { batchOutcomeNotice, pageEditLabel, revertPageBatches, undoPageBatches, writtenBatchIds } from './pageUndo';

const api = vi.hoisted(() => ({ revertPageBatch: vi.fn() }));
vi.mock('../../services/api/pages', () => api);

afterEach(() => vi.clearAllMocks());

describe('revertPageBatches', () => {
  it('undoes the batches newest first, adds up the outcome and tells the views each batch changed', async () => {
    api.revertPageBatch
      .mockResolvedValueOnce({ reverted: ['c3'], conflicts: [{ changeId: 'c4', message: 'stale' }] })
      .mockResolvedValueOnce({ reverted: ['c1', 'c2'], conflicts: [] });
    const heard = vi.fn();
    const stop = subscribePageChanges({ backendConnectionId: 'local', databaseId: 'db-2' }, heard);
    try {
      const outcome = await revertPageBatches('local', [
        { batchId: 'b1', workspaceId: 'ws', changed: [{ backendConnectionId: 'local', workspaceId: 'ws', databaseId: 'db-1' }] },
        { batchId: 'b2', workspaceId: 'ws', changed: [{ backendConnectionId: 'local', workspaceId: 'ws', databaseId: 'db-2' }] },
      ]);
      expect(outcome).toEqual({ done: 3, conflicts: 1 });
      expect(api.revertPageBatch.mock.calls.map(([batchId]) => batchId)).toEqual(['b2', 'b1']);
      expect(api.revertPageBatch).toHaveBeenCalledWith('b2', { backendConnectionId: 'local', workspaceId: 'ws' });
      expect(heard).toHaveBeenCalledTimes(1);
    } finally { stop(); }
  });
});

describe('batchOutcomeNotice', () => {
  it('says nothing when all of it was undone, and tells partial from none', () => {
    expect(batchOutcomeNotice({ done: 2, conflicts: 0 }, 'undone')).toBeNull();
    expect(batchOutcomeNotice({ done: 1, conflicts: 1 }, 'undone')).toBe('Not all of it was undone: some of it changed again since.');
    expect(batchOutcomeNotice({ done: 0, conflicts: 2 }, 'undone')).toBe('Not undone: it changed again since.');
    expect(batchOutcomeNotice({ done: 0, conflicts: 1 }, 'undone', 'Move it back yourself.'))
      .toBe('Not undone: it changed again since. Move it back yourself.');
    expect(batchOutcomeNotice({ done: 1, conflicts: 1 }, 'restored')).toBe('Not all of it was restored: some of it changed again since.');
  });
});

describe('the undo of a user write', () => {
  it('names what a page edit did', () => {
    expect(pageEditLabel([{ op: 'delete', id: 'b1' }], ' Plan ')).toBe('Deleted a block in “Plan”');
    expect(pageEditLabel([{ op: 'move', id: 'b1', after: null }])).toBe('Moved a block');
    expect(pageEditLabel([{ op: 'delete', id: 'b1' }, { op: 'delete', id: 'b2' }], 'Plan')).toBe('Changed blocks in “Plan”');
  });

  it('takes each batch a write made once', () => {
    expect(writtenBatchIds({ applied: [{ batchId: 'b1' }, { batchId: 'b1' }, { batchId: null }, { batchId: 'b2' }] })).toEqual(['b1', 'b2']);
    expect(writtenBatchIds(undefined)).toEqual([]);
  });

  it('reverts the batches, and says what stayed when it changed again since', async () => {
    const batches = [{ batchId: 'b1', workspaceId: 'ws', changed: [] }];
    api.revertPageBatch.mockResolvedValueOnce({ reverted: ['c1'], conflicts: [] });
    await expect(undoPageBatches('local', batches)()).resolves.toBe(true);
    api.revertPageBatch.mockResolvedValueOnce({ reverted: [], conflicts: [{ changeId: 'c1', message: 'stale' }] });
    await expect(undoPageBatches('local', batches, 'Change it back yourself.')()).resolves.toBe('Not undone: it changed again since. Change it back yourself.');
  });
});
