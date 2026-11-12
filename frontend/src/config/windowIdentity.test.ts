import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWindowId } from 'michi-shared';
import { ORIGIN_WINDOW_ID, WINDOW_ID, resolveWindowIdentity } from './windowIdentity';

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

/** One page load in a tab: its sessionStorage, and the profile's shared localStorage. */
function load(session: Storage, local: Storage, extra: { wasDiscarded?: boolean; electronWindowId?: string; navigation?: string } = {}) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const refreshers: Array<() => void> = [];
  const win = {
    sessionStorage: session,
    localStorage: local,
    performance: { getEntriesByType: () => [{ type: extra.navigation ?? 'navigate' }] },
    document: { visibilityState: 'visible', wasDiscarded: extra.wasDiscarded, addEventListener: () => {} },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    setInterval: (refresh: () => void) => { refreshers.push(refresh); return refreshers.length; },
    ...(extra.electronWindowId ? { electron: { michiWindowId: extra.electronWindowId } } : {}),
  };
  const identity = resolveWindowIdentity(win as unknown as Window);
  return {
    ...identity,
    refresh: () => refreshers.forEach((refresh) => refresh()),
    unload: () => listeners.get('pagehide')?.forEach((listener) => listener({ persisted: false })),
  };
}

const claimOf = (local: Storage, windowId: string) => JSON.parse(local.getItem(`michi:windowClaim:${windowId}`) ?? 'null');

describe('window identity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps a tab\'s id across a reload, with a new origin id for each load', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    const first = load(session, local);
    expect(claimOf(local, first.windowId)).toEqual({ page: first.originWindowId, at: 1_000_000 });
    first.unload();
    expect(claimOf(local, first.windowId)).toBeNull();

    const reloaded = load(session, local);
    expect(reloaded.windowId).toBe(first.windowId);
    expect(reloaded.originWindowId).not.toBe(first.originWindowId);
    expect(reloaded.originWindowId).not.toBe(reloaded.windowId);
  });

  it('keeps the id on a reload whose old page has not released it yet', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    const first = load(session, local);
    expect(load(session, local, { navigation: 'reload' }).windowId).toBe(first.windowId);
  });

  it('gives a duplicated tab its own id while its source lives', () => {
    const local = memoryStorage();
    const source = load(memoryStorage(), local);
    // Duplicating a tab copies its sessionStorage (and restores its history).
    const copied = memoryStorage({ 'michi:windowId': source.windowId });
    const duplicate = load(copied, local, { navigation: 'back_forward' });
    expect(duplicate.windowId).not.toBe(source.windowId);
    expect(copied.getItem('michi:windowId')).toBe(duplicate.windowId);
    // Each holds its own; the source keeps its drafts, claims and focus slot.
    expect(claimOf(local, source.windowId).page).toBe(source.originWindowId);
    expect(claimOf(local, duplicate.windowId).page).toBe(duplicate.originWindowId);
    // The duplicate's reload keeps the id it was given.
    duplicate.unload();
    expect(load(copied, local).windowId).toBe(duplicate.windowId);
  });

  it('takes back the id of a page that died without unloading once its claim is stale', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    const crashed = load(session, local);
    // Still refreshed while it runs: a copy made now is a duplicate.
    vi.setSystemTime(1_000_000 + 2 * 60_000);
    crashed.refresh();
    expect(load(memoryStorage({ 'michi:windowId': crashed.windowId }), local).windowId).not.toBe(crashed.windowId);
    // No unload, no refresh for longer than a throttled tab's timers allow: restored, not duplicated.
    vi.setSystemTime(1_000_000 + 6 * 60_000);
    expect(load(session, local).windowId).toBe(crashed.windowId);
  });

  it('keeps the id of a tab the browser discarded and reloads', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    const before = load(session, local);
    expect(load(session, local, { wasDiscarded: true }).windowId).toBe(before.windowId);
  });

  it('takes the id Electron gives each window', () => {
    const local = memoryStorage();
    const window = load(memoryStorage(), local, { electronWindowId: 'win-0' });
    expect(window.windowId).toBe('win-0');
    expect(window.originWindowId).not.toBe('win-0');
    expect(local.length).toBe(0);
  });

  it('sweeps claims left a day ago', () => {
    const local = memoryStorage({ 'michi:windowClaim:old': JSON.stringify({ page: 'p', at: 1_000_000 - 25 * 60 * 60_000 }) });
    load(memoryStorage(), local);
    expect(local.getItem('michi:windowClaim:old')).toBeNull();
  });

  it('names this page with ids a request header carries', () => {
    expect(isWindowId(WINDOW_ID)).toBe(true);
    expect(isWindowId(ORIGIN_WINDOW_ID)).toBe(true);
    expect(ORIGIN_WINDOW_ID).not.toBe(WINDOW_ID);
  });
});
