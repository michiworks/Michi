import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCompanionPanelForTests } from '../../../state/companion/companionPanel';
import { loadCompanion, refreshCompanion, resetCompanionStoreForTests, useCompanion } from '../../../state/companion/companionStore';
import { companionItem, companionSnapshotDto, jsonResponse } from '../../../test/companionFixtures';
import { CompanionToday } from './CompanionToday';

/** Today as the panel shows it: from the real store, which marks what it shows seen. */
function Today() {
  const { snapshot, catchUp, arrivals } = useCompanion();
  return snapshot
    ? <CompanionToday snapshot={snapshot} catchUp={catchUp} arrivals={arrivals} onOpenItem={() => {}} onAsk={() => {}} onAction={() => {}} onOpenSettings={() => {}} />
    : null;
}

const calls: string[] = [];
let seenAnswers: 'down' | 'ok' = 'down';
const posts = () => calls.filter((call) => call === 'POST /companion/items/seen').length;
const gets = () => calls.filter((call) => call === 'GET /companion').length;
const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

beforeEach(async () => {
  calls.length = 0;
  seenAnswers = 'down';
  resetCompanionPanelForTests();
  resetCompanionStoreForTests();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname.replace(/^.*\/api/, '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/companion/items/seen') {
      // A loopback round trip to a backend that is restarting.
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (seenAnswers === 'down') throw new TypeError('Failed to fetch');
      return jsonResponse(null, 204);
    }
    return jsonResponse(companionSnapshotDto({ items: [companionItem('a', { title: 'CR-1 needs attention' })] }));
  }));
  await loadCompanion();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetCompanionStoreForTests();
});

describe('Today marking what it shows seen', () => {
  it('asks once while the backend is down, never in a loop, and marks the item again on a later good snapshot', async () => {
    render(<Today />);
    await waitFor(() => expect(posts()).toBe(1));
    await pause(300);
    // One POST and no extra reads: before the fix this ran ~170 POSTs and ~100 GETs in 300ms.
    expect(posts()).toBe(1);
    expect(gets()).toBe(1);
    // The backend is back and the wait after the failure is over: the next snapshot still says new, and is marked once.
    seenAnswers = 'ok';
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    await act(async () => { await refreshCompanion(); });
    await waitFor(() => expect(posts()).toBe(2));
    await pause(100);
    expect(posts()).toBe(2);
  });
});
