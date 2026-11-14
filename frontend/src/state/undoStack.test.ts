import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { collectUndo, newestUndoAt, recordUndo, recordUndoGroup, resetUndoStackForTests, undoEntry, undoLatest } from './undoStack';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn((_message: string, options?: { id?: string }) => options?.id), { error: vi.fn(), dismiss: vi.fn() }) }));

beforeEach(() => {
  resetUndoStackForTests();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.dismiss).mockClear();
});

describe('undo history', () => {
  it('undoes the newest action first and says so', async () => {
    const order: string[] = [];
    recordUndo({ label: 'Archived “A”', undo: () => { order.push('A'); } });
    recordUndo({ label: 'Renamed “B”', undo: () => { order.push('B'); } });
    expect(await undoLatest()).toBe('undone');
    expect(await undoLatest()).toBe('undone');
    expect(await undoLatest()).toBe('empty');
    expect(order).toEqual(['B', 'A']);
    expect(toast).toHaveBeenLastCalledWith('Undone', { description: 'Archived “A”' });
    expect(newestUndoAt()).toBeNull();
  });

  it('offers Undo in a toast for the same entry, and dismisses that toast when ⌘Z uses it', async () => {
    const undo = vi.fn();
    const id = recordUndo({ label: 'Moved “A” to Trash', undo, toast: true });
    expect(toast).toHaveBeenCalledWith('Moved “A” to Trash', { id, action: { label: 'Undo', onClick: expect.any(Function) } });
    const { action } = vi.mocked(toast).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
    action.onClick();
    expect(undo).toHaveBeenCalledTimes(1);
    // Used once: ⌘Z then finds nothing left.
    expect(await undoLatest()).toBe('empty');

    recordUndo({ label: 'Archived “B”', undo: vi.fn(), toast: true });
    await undoLatest();
    expect(toast.dismiss).toHaveBeenCalledTimes(2);
  });

  it('records nothing for what an undo itself does, even after it awaits', async () => {
    recordUndo({
      label: 'Moved “A” to Work',
      undo: async () => {
        await Promise.resolve();
        recordUndo({ label: 'Moved “A” to Home', undo: vi.fn() });
      },
    });
    await undoLatest();
    expect(newestUndoAt()).toBeNull();
  });

  it('tells apart an entry that can no longer be undone, one undone in part, and a failure', async () => {
    recordUndo({ label: 'gone', undo: () => false });
    expect(await undoLatest()).toBe('stale');
    expect(toast).toHaveBeenLastCalledWith('Can’t undo that anymore.', { description: 'gone' });

    recordUndo({ label: 'part', undo: async () => 'Not all of it was undone.' });
    expect(await undoLatest()).toBe('partial');
    expect(toast.error).toHaveBeenLastCalledWith('Not all of it was undone.', { description: 'part' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordUndo({ label: 'broken', undo: () => { throw new Error('offline'); } });
    expect(await undoLatest()).toBe('failed');
    expect(toast.error).toHaveBeenLastCalledWith('Couldn’t undo that.', { description: 'broken' });
    // A failed undo leaves nothing to retry under ⌘Z; the next one goes further back.
    expect(newestUndoAt()).toBeNull();
  });

  it('keeps one entry for a bulk action, undone newest first', async () => {
    const order: string[] = [];
    recordUndoGroup(() => {
      recordUndo({ label: 'Archived “A”', undo: () => { order.push('A'); } });
      recordUndo({ label: 'Archived “B”', undo: () => { order.push('B'); } });
    }, (n) => `Archived ${n} threads`, { toast: true });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Archived 2 threads', expect.anything());
    expect(await undoLatest()).toBe('undone');
    expect(order).toEqual(['B', 'A']);
    expect(await undoLatest()).toBe('empty');
  });

  it('keeps a lone collected entry as it was, and collects nothing outside its call', () => {
    recordUndoGroup(() => { recordUndo({ label: 'Archived “A”', undo: vi.fn() }); }, (n) => `Archived ${n} threads`);
    const { entries } = collectUndo(() => 1);
    expect(entries).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    expect(newestUndoAt()).not.toBeNull();
  });

  it('undoes one entry by id, leaving the others in place', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const first = recordUndo({ label: 'A', undo: a })!;
    recordUndo({ label: 'B', undo: b });
    await undoEntry(first);
    expect(a).toHaveBeenCalled();
    await undoLatest();
    expect(b).toHaveBeenCalled();
  });

  it('keeps the newest 50 actions', async () => {
    const first = vi.fn();
    recordUndo({ label: 'first', undo: first });
    for (let i = 0; i < 50; i++) recordUndo({ label: `${i}`, undo: vi.fn() });
    for (let i = 0; i < 50; i++) await undoLatest();
    expect(await undoLatest()).toBe('empty');
    expect(first).not.toHaveBeenCalled();
  });
});
