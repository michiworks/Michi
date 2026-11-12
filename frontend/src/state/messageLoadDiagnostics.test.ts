import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { markBackendConnectionReady, markBackendConnectionUnavailable } from '../config/backendConnectionState';
import {
  noteMessageRequest, noteMessageRetry, noteMessagesInstalled, noteSkeletonHidden, noteSkeletonShown,
  type SkeletonDiagnosticRow,
} from './messageLoadDiagnostics';

const ring = () => (globalThis as { __michiLoadDiagnostics?: SkeletonDiagnosticRow[] }).__michiLoadDiagnostics ?? [];
const rowFor = (nodeId: string) => ring().find((row) => row.nodeId === nodeId);

describe('skeleton episode diagnostics', () => {
  let info: MockInstance<typeof console.info>;
  beforeEach(() => {
    vi.useFakeTimers();
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
    vi.useRealTimers();
  });
  const lines = () => info.mock.calls.map((call) => JSON.parse(String(call[0])) as SkeletonDiagnosticRow);

  it('says nothing for a skeleton that loads within the threshold', () => {
    noteSkeletonShown('fast', 'local');
    const settle = noteMessageRequest(['fast'], 'tree');
    vi.advanceTimersByTime(800);
    settle();
    noteMessagesInstalled(['fast']);
    noteSkeletonHidden('fast');
    vi.advanceTimersByTime(5000);
    expect(info).not.toHaveBeenCalled();
    expect(rowFor('fast')).toBeUndefined();
  });

  it('reports a skeleton nothing was asked for, once, and records how it ended', () => {
    noteSkeletonShown('orphan', 'local');
    vi.advanceTimersByTime(2000);
    expect(lines()).toEqual([expect.objectContaining({
      type: 'message_load_slow', nodeId: 'orphan', reason: 'no_request_issued', elapsedMs: 2000, requests: 0,
      firstRequestMs: null, phases: { noRequestMs: 2000, awaitingResponseMs: 0, installingMs: 0, unavailableMs: 0 },
    })]);
    vi.advanceTimersByTime(1000);
    const settle = noteMessageRequest(['orphan'], 'node');
    vi.advanceTimersByTime(500);
    settle();
    noteMessagesInstalled(['orphan']);
    noteSkeletonHidden('orphan');
    expect(info).toHaveBeenCalledTimes(1);
    expect(rowFor('orphan')).toMatchObject({
      reason: 'no_request_issued', ended: 'installed', elapsedMs: 3500, requests: 1, sources: ['node'], firstRequestMs: 3000,
      phases: { noRequestMs: 3000, awaitingResponseMs: 500, installingMs: 0 },
    });
  });

  it('does not count a speculative answer nothing installs as installing', () => {
    noteSkeletonShown('hovered', 'local');
    noteMessageRequest(['hovered'], 'prefetch')(undefined, true);
    vi.advanceTimersByTime(2000);
    expect(lines().at(-1)).toMatchObject({ nodeId: 'hovered', reason: 'no_request_issued', lastOutcome: 'prefetched',
      phases: { noRequestMs: 2000, awaitingResponseMs: 0, installingMs: 0 } });
    noteSkeletonHidden('hovered');
  });

  it('separates a read still on its way from a failed one waiting to retry', () => {
    const settle = noteMessageRequest(['slow'], 'tree');
    noteSkeletonShown('slow', 'local');
    vi.advanceTimersByTime(2000);
    expect(lines().at(-1)).toMatchObject({ nodeId: 'slow', reason: 'waiting_for_response', requests: 1 });
    settle(new Error('fetchTreeMessagePage failed: 502'));
    noteMessageRetry(['slow']);
    expect(rowFor('slow')).toMatchObject({ waitingOn: 'retrying_after_error', failures: 1,
      lastOutcome: 'failed', lastError: 'fetchTreeMessagePage failed: 502' });
    noteSkeletonHidden('slow');
    expect(rowFor('slow')).toMatchObject({ ended: 'hidden', waitingOn: 'retrying_after_error' });
  });

  it('attributes the wait to an unavailable connection', () => {
    markBackendConnectionUnavailable('box');
    noteSkeletonShown('remote:box:n', 'box');
    noteMessageRequest(['remote:box:n'], 'tree');
    vi.advanceTimersByTime(2500);
    expect(lines().at(-1)).toMatchObject({ nodeId: 'remote:box:n', reason: 'connection_unavailable' });
    markBackendConnectionReady('box');
    noteSkeletonHidden('remote:box:n');
  });

  it('counts one episode for a node shown in two panes', () => {
    noteSkeletonShown('twice', 'local');
    noteSkeletonShown('twice', 'local');
    noteSkeletonHidden('twice');
    vi.advanceTimersByTime(2000);
    noteSkeletonHidden('twice');
    expect(lines().filter((line) => line.nodeId === 'twice')).toHaveLength(1);
    expect(rowFor('twice')).toMatchObject({ ended: 'hidden' });
  });
});
