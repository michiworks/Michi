import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribePageChanges } from './pageEvents';
import { batchOutcomeNotice, revertPageBatches } from './pageUndo';

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
