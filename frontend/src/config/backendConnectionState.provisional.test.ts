import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backendConnectionProvisional,
  confirmBackendConnection,
  markBackendConnectionProvisional,
  resetBackendConnectionProvisional,
  whenBackendConnectionConfirmed,
} from './backendConnectionState';
import { backendFetch } from '../services/api/backendRequest';
import { backendApiBase } from './backendConnections';

afterEach(() => {
  resetBackendConnectionProvisional();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a remote shown from the local cache', () => {
  it('lets waiters go when it confirms, or after the bound without failing them', async () => {
    vi.useFakeTimers();
    expect(await whenBackendConnectionConfirmed('r1', 10)).toBe(true);
    markBackendConnectionProvisional('r1');
    markBackendConnectionProvisional('local');
    expect(backendConnectionProvisional('r1')).toBe(true);
    expect(backendConnectionProvisional('local')).toBe(false);
    const confirmed = whenBackendConnectionConfirmed('r1', 5_000);
    const timedOut = whenBackendConnectionConfirmed('r1', 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await timedOut).toBe(false);
    confirmBackendConnection('r1');
    expect(await confirmed).toBe(true);
    expect(backendConnectionProvisional('r1')).toBe(false);
  });

  it('holds writes to it until it confirms, never reads', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    markBackendConnectionProvisional('r1');
    await backendFetch(`${backendApiBase('r1')}/workspaces/all?meta=1`);
    expect(fetch).toHaveBeenCalledTimes(1);
    const write = backendFetch(`${backendApiBase('r1')}/workspaces/ws/commands`, { method: 'POST', body: '{}' });
    const local = backendFetch(`${backendApiBase('local')}/workspaces/ws/commands`, { method: 'POST', body: '{}' });
    await local;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(2);
    confirmBackendConnection('r1');
    await write;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
