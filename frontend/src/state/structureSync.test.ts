import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceStructureChange, WorkspaceStructureChangedEvent } from 'michi-shared';
import { StructureFeedTracker, StructureRefreshScheduler, planStructureRead } from './structureSync';

const frame = (seq: number, changes: WorkspaceStructureChange[] = [], epoch = 'e1', extra: Partial<WorkspaceStructureChangedEvent> = {}) =>
  ({ epoch, seq, changes, ...extra });
const renamed = (workspaceId: string, originWindowId?: string): WorkspaceStructureChange => ({
  entity: 'workspace', op: 'renamed', workspaceId, ...(originWindowId ? { originWindowId } : {}),
});

describe('StructureFeedTracker', () => {
  it('trusts an opening cursor its hydration read was taken at, and re-reads otherwise', () => {
    const hydration = new Map([['local', { epoch: 'e1', seq: 4 }]]);
    const tracker = new StructureFeedTracker({
      windowId: 'me',
      takeHydrationCursor: (connectionId) => {
        const cursor = hydration.get(connectionId);
        hydration.delete(connectionId);
        return cursor;
      },
    });
    expect(tracker.accept('local', frame(4))).toEqual({ kind: 'none' });
    // A reconnect that missed frames, a restarted backend, a first contact with no load.
    expect(tracker.accept('local', frame(7))).toEqual({ kind: 'full' });
    expect(tracker.accept('local', frame(0, [], 'e2'))).toEqual({ kind: 'full' });
    expect(tracker.accept('remote-a', frame(3))).toEqual({ kind: 'full' });
    // Reconnecting exactly where it left off reads nothing.
    expect(tracker.accept('local', frame(0, [], 'e2'))).toEqual({ kind: 'none' });
  });

  it('passes on other windows\' changes in sequence and skips its own', () => {
    const tracker = new StructureFeedTracker({ windowId: 'me' });
    tracker.accept('local', frame(0));
    expect(tracker.accept('local', frame(1, [renamed('ws-1', 'other'), renamed('ws-2', 'me'), renamed('ws-3')])))
      .toEqual({ kind: 'changes', changes: [renamed('ws-1', 'other'), renamed('ws-3')] });
    expect(tracker.accept('local', frame(2, [renamed('ws-2', 'me')]))).toEqual({ kind: 'none' });
    // A replayed or stale frame changes nothing.
    expect(tracker.accept('local', frame(2, [renamed('ws-9')]))).toEqual({ kind: 'none' });
  });

  it('turns a gap, a new epoch or a resync frame into a full re-read', () => {
    const tracker = new StructureFeedTracker({ windowId: 'me' });
    tracker.accept('local', frame(0));
    expect(tracker.accept('local', frame(2, [renamed('ws-1')]))).toEqual({ kind: 'full' });
    expect(tracker.accept('local', frame(3, [renamed('ws-1')]))).toEqual({ kind: 'changes', changes: [renamed('ws-1')] });
    expect(tracker.accept('local', frame(1, [renamed('ws-1')], 'e2'))).toEqual({ kind: 'full' });
    expect(tracker.accept('local', frame(2, [], 'e2', { resync: true }))).toEqual({ kind: 'full' });
    // Even this window's own changes cannot cover a gap.
    expect(tracker.accept('local', frame(4, [renamed('ws-1', 'me')], 'e2'))).toEqual({ kind: 'full' });
  });

  it('keeps every connection\'s sequence apart', () => {
    const tracker = new StructureFeedTracker({ windowId: null });
    tracker.accept('local', frame(0));
    tracker.accept('remote-a', frame(10, [], 'r1'));
    expect(tracker.accept('remote-a', frame(11, [renamed('remote:remote-a:ws')], 'r1')).kind).toBe('changes');
    expect(tracker.accept('local', frame(1, [renamed('ws-1', 'me')])))
      .toEqual({ kind: 'changes', changes: [renamed('ws-1', 'me')] });
  });
});

describe('StructureRefreshScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst into one re-read and serializes the next', async () => {
    let release!: () => void;
    const run = vi.fn((_connectionId: string, _request: unknown) => new Promise<void>((resolve) => { release = resolve; }));
    const scheduler = new StructureRefreshScheduler({ debounceMs: 100, run });
    scheduler.request('local', { kind: 'changes', changes: [renamed('ws-1')] });
    await vi.advanceTimersByTimeAsync(60);
    scheduler.request('local', { kind: 'changes', changes: [renamed('ws-2')] });
    await vi.advanceTimersByTimeAsync(60);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual(['local', { full: false, changes: [renamed('ws-1'), renamed('ws-2')] }]);

    // Requests during a re-read wait for it, then run together.
    scheduler.request('local', { kind: 'changes', changes: [renamed('ws-3')] });
    scheduler.request('local', { kind: 'full' });
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(150);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]).toEqual(['local', { full: true, changes: [] }]);
    release();
    scheduler.stop();
  });

  it('re-reads at least every maxWait under a steady stream', async () => {
    const run = vi.fn(async () => {});
    const scheduler = new StructureRefreshScheduler({ debounceMs: 100, maxWaitMs: 250, run });
    for (let i = 0; i < 6; i += 1) {
      scheduler.request('local', { kind: 'changes', changes: [renamed(`ws-${i}`)] });
      await vi.advanceTimersByTimeAsync(60);
    }
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('retries a failed re-read with backoff and nothing lost', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const scheduler = new StructureRefreshScheduler({ debounceMs: 10, retryDelayMs: 1_000, run });
    scheduler.request('local', { kind: 'changes', changes: [renamed('ws-1')] });
    await vi.advanceTimersByTimeAsync(20); // failed at t=10; the retry waits until t=1010
    expect(run).toHaveBeenCalledTimes(1);
    // A frame during the backoff joins the retry instead of cutting it short.
    scheduler.request('local', { kind: 'changes', changes: [renamed('ws-2')] });
    await vi.advanceTimersByTimeAsync(989);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).toEqual({ full: false, changes: [renamed('ws-1'), renamed('ws-2')] });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it('ignores decisions with nothing to read and stops cleanly', async () => {
    const run = vi.fn(async () => {});
    const scheduler = new StructureRefreshScheduler({ debounceMs: 10, run });
    scheduler.request('local', { kind: 'none' });
    scheduler.request('local', { kind: 'full' });
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('planStructureRead', () => {
  it('reads both ends of a move and collects explicit removals only', () => {
    const plan = planStructureRead([
      { entity: 'tree', op: 'moved', workspaceId: 'ws-2', fromWorkspaceId: 'ws-1', treeId: 't1' },
      { entity: 'node', op: 'purged', workspaceId: 'ws-3', nodeId: 'n9' },
      { entity: 'node', op: 'deleted', workspaceId: 'ws-3', nodeId: 'n8' },
      { entity: 'tree', op: 'deleted', workspaceId: 'ws-3', treeId: 't7' },
      { entity: 'workspace', op: 'purged', workspaceId: 'ws-4' },
    ]);
    expect([...plan.workspaceIds].sort()).toEqual(['ws-1', 'ws-2', 'ws-3', 'ws-4']);
    expect([...plan.removals.nodeIds]).toEqual(['n9']);
    expect([...plan.removals.treeIds]).toEqual(['t7']);
    expect([...plan.removals.workspaceIds]).toEqual(['ws-4']);
  });
});
