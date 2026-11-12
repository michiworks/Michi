import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markBackendConnectionReady } from '../config/backendConnectionState';
import { backendApiBase } from '../config/backendConnections';
import { markRemoteFirstPaint, resetRemoteFirstPaint } from '../state/remoteFirstPaint';
import { loadPermissionPreferences, permissionSnapshot, saveScopedPermissionPreferences, subscribePermissionPreferences } from './permissionPreferences';

const connectionId = 'remote-permissions';
const base = backendApiBase(connectionId);
const settings = { mode: 'ask', approveForMe: false, global: false };
const claimed = vi.hoisted(() => ({ ok: true }));
vi.mock('michi-shared', async (importActual) => ({
  ...(await importActual<typeof import('michi-shared')>()),
  isChatPermissionSettings: () => claimed.ok,
}));

describe('remote permission settings reads', () => {
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    markBackendConnectionReady(connectionId);
    fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(settings), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetRemoteFirstPaint(); });
  const reads = () => fetch.mock.calls.filter(([url, init]) => String(url).includes('/permissions/settings') && (init as RequestInit | undefined)?.method !== 'PUT').length;

  it('holds a remote mount read until it paints, and shares concurrent reads', async () => {
    const off = subscribePermissionPreferences('k-hold', () => {});
    const first = loadPermissionPreferences('k-hold', base);
    const second = loadPermissionPreferences('k-hold', base);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads()).toBe(0);
    markRemoteFirstPaint(connectionId);
    await Promise.all([first, second]);
    expect(reads()).toBe(1);
    expect(permissionSnapshot('k-hold').settings).toEqual(settings);
    off();
  });

  it('reuses a fresh answer on remount but reads again when asked to be fresh or after a save', async () => {
    markRemoteFirstPaint(connectionId);
    const off = subscribePermissionPreferences('k-reuse', () => {});
    await loadPermissionPreferences('k-reuse', base);
    await loadPermissionPreferences('k-reuse', base);
    expect(reads()).toBe(1);
    await loadPermissionPreferences('k-reuse', base, { fresh: true });
    expect(reads()).toBe(2);
    await saveScopedPermissionPreferences('k-reuse', base, settings as never);
    await loadPermissionPreferences('k-reuse', base);
    expect(reads()).toBe(3);
    vi.advanceTimersByTime(6000);
    await loadPermissionPreferences('k-reuse', base);
    expect(reads()).toBe(4);
    off();
  });

  it('keeps a just-settled answer across an unmount and remount', async () => {
    markRemoteFirstPaint(connectionId);
    const off = subscribePermissionPreferences('k-remount', () => {});
    await loadPermissionPreferences('k-remount', base);
    off();
    const again = subscribePermissionPreferences('k-remount', () => {});
    await loadPermissionPreferences('k-remount', base);
    expect(reads()).toBe(1);
    again();
  });
});
