import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backendApiBase } from '../../config/backendConnections';
import { markBackendConnectionReady } from '../../config/backendConnectionState';
import { markRemoteFirstPaint, resetRemoteFirstPaint } from '../../state/remoteFirstPaint';
import { fetchAgentStatus, fetchAgentStatusAfterFirstPaint, fetchRuntimeCatalog, invalidateAgentStatus, listAgentModels, saveAgentOptions } from './agentRuntime';

vi.mock('michi-shared', async (importActual) => ({
  ...(await importActual<typeof import('michi-shared')>()),
  normalizeAgentStatus: (value: unknown) => value,
  normalizeAgentModels: (value: unknown) => value,
  normalizeRuntimeCatalog: (value: unknown) => value,
}));

const connectionId = 'remote-boot-defer';
const status = { runtime: 'claude', capabilities: {}, providers: [], availableRuntimes: [] };

function stubFetch() {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
    String(url).includes('/agent/status') ? status : String(url).includes('runtime-catalog') ? { capabilities: {}, models: [], providers: [] } : { models: [] })));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const calls = (fetch: ReturnType<typeof stubFetch>, part: string) => fetch.mock.calls.filter(([url]) => String(url).includes(part)).length;

describe('agent runtime boot reads', () => {
  beforeEach(() => { markBackendConnectionReady(connectionId); invalidateAgentStatus(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetRemoteFirstPaint(); invalidateAgentStatus(); });

  it('shares one in-flight status read and reuses it briefly for a remote', async () => {
    const fetch = stubFetch();
    await Promise.all([fetchAgentStatus(connectionId), fetchAgentStatus(connectionId), fetchAgentStatus(connectionId)]);
    expect(calls(fetch, '/agent/status')).toBe(1);
    await fetchAgentStatus(connectionId);
    expect(calls(fetch, '/agent/status')).toBe(1);
    vi.advanceTimersByTime(2100);
    await fetchAgentStatus(connectionId);
    expect(calls(fetch, '/agent/status')).toBe(2);
  });

  it('does not reuse a settled local status', async () => {
    const fetch = stubFetch();
    await fetchAgentStatus('local');
    await fetchAgentStatus('local');
    expect(calls(fetch, '/agent/status')).toBe(2);
  });

  it('reads again after the status can have changed', async () => {
    const fetch = stubFetch();
    await fetchAgentStatus(connectionId);
    window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    await fetchAgentStatus(connectionId);
    expect(calls(fetch, '/agent/status')).toBe(2);
    await saveAgentOptions({} as never).catch(() => {});
    await fetchAgentStatus(connectionId);
    expect(calls(fetch, '/agent/status')).toBe(3);
  });

  it('lets one caller abort without cancelling the shared read', async () => {
    const fetch = stubFetch();
    const controller = new AbortController();
    const aborted = fetchAgentStatus(connectionId, controller.signal);
    const kept = fetchAgentStatus(connectionId);
    controller.abort();
    await expect(aborted).rejects.toBeDefined();
    await expect(kept).resolves.toMatchObject({ runtime: 'claude' });
    expect(calls(fetch, '/agent/status')).toBe(1);
  });

  it('holds the boot status read of a remote until it paints, then sends it', async () => {
    const fetch = stubFetch();
    const read = fetchAgentStatusAfterFirstPaint(connectionId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls(fetch, '/agent/status')).toBe(0);
    markRemoteFirstPaint(connectionId);
    await read;
    expect(calls(fetch, '/agent/status')).toBe(1);
  });

  it('never holds the boot read past the barrier bound', async () => {
    const fetch = stubFetch();
    const read = fetchAgentStatusAfterFirstPaint(connectionId);
    await vi.advanceTimersByTimeAsync(1600);
    await read;
    expect(calls(fetch, '/agent/status')).toBe(1);
  });

  it('does not hold local reads', async () => {
    const fetch = stubFetch();
    await fetchAgentStatusAfterFirstPaint('local');
    expect(calls(fetch, '/agent/status')).toBe(1);
  });

  it('holds model and catalog reads but not an explicit refresh', async () => {
    const fetch = stubFetch();
    const models = listAgentModels({ connectionId, runtime: 'claude' });
    const catalog = fetchRuntimeCatalog('claude', undefined, { connectionId });
    const refreshed = listAgentModels({ connectionId, runtime: 'kiro', refresh: true });
    await refreshed;
    expect(calls(fetch, '/agent/models')).toBe(1);
    expect(calls(fetch, 'runtime-catalog')).toBe(0);
    markRemoteFirstPaint(connectionId);
    await Promise.all([models, catalog]);
    expect(calls(fetch, '/agent/models')).toBe(2);
    expect(calls(fetch, 'runtime-catalog')).toBe(1);
    expect(backendApiBase(connectionId)).toContain(connectionId);
  });
});
