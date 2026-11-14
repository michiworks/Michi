import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionEventsSubscription } from '../../services/api/companion';
import { SseHttpError } from '../../services/api/sseParser';
import { companionSnapshot, jsonResponse } from '../../test/companionFixtures';
import { resetCompanionFeedForTests, startCompanionFeed } from './companionFeed';
import { loadCompanion, resetCompanionStoreForTests } from './companionStore';

const feed = vi.hoisted(() => ({
  subscriptions: [] as Array<CompanionEventsSubscription & { stop: ReturnType<typeof vi.fn> }>,
}));
vi.mock('../../services/api/companion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/companion')>()),
  subscribeCompanionEvents: (options: CompanionEventsSubscription) => {
    const stop = vi.fn();
    feed.subscriptions.push({ ...options, stop });
    return stop;
  },
}));

const prefs = vi.hoisted(() => ({ noteNotificationLevelChanged: vi.fn() }));
vi.mock('../prefs', () => prefs);

const latest = () => feed.subscriptions[feed.subscriptions.length - 1];

beforeEach(() => {
  feed.subscriptions.length = 0;
  prefs.noteNotificationLevelChanged.mockReset();
  resetCompanionFeedForTests();
  resetCompanionStoreForTests({ snapshot: companionSnapshot() });
});

afterEach(() => {
  resetCompanionFeedForTests();
  resetCompanionStoreForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Companion change feed', () => {
  it('is open once while anything uses it, and closes when the last user leaves', () => {
    const first = startCompanionFeed();
    const second = startCompanionFeed();
    expect(feed.subscriptions).toHaveLength(1);
    first();
    first();
    expect(latest().stop).not.toHaveBeenCalled();
    second();
    expect(latest().stop).toHaveBeenCalledTimes(1);
  });

  it('reconnects after 1s, doubling, and back to 1s once a connection held', () => {
    vi.useFakeTimers();
    const release = startCompanionFeed();
    latest().onDisconnect?.(new Error('network'));
    vi.advanceTimersByTime(999);
    expect(feed.subscriptions).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(feed.subscriptions).toHaveLength(2);
    latest().onDisconnect?.(new Error('network'));
    vi.advanceTimersByTime(1_999);
    expect(feed.subscriptions).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(feed.subscriptions).toHaveLength(3);
    // This one held for 30s: the next drop starts over at 1s.
    latest().onOpen?.();
    vi.advanceTimersByTime(30_000);
    latest().onDisconnect?.(new Error('network'));
    vi.advanceTimersByTime(1_000);
    expect(feed.subscriptions).toHaveLength(4);
    release();
  });

  it('takes 401, 403 and 404 as "no feed here" and does not retry', () => {
    vi.useFakeTimers();
    const release = startCompanionFeed();
    latest().onDisconnect?.(new SseHttpError(404));
    vi.advanceTimersByTime(60_000);
    expect(feed.subscriptions).toHaveLength(1);
    release();
  });

  it('opens at once, whether or not GET /companion answered: the backend counts the window by it (D20)', async () => {
    resetCompanionStoreForTests();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const release = startCompanionFeed();
    expect(feed.subscriptions).toHaveLength(1);
    await loadCompanion();
    expect(feed.subscriptions).toHaveLength(1);
    expect(latest().stop).not.toHaveBeenCalled();
    release();
  });

  it('a backend without a Companion answers the feed 404, and it stops there', async () => {
    resetCompanionStoreForTests();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ __unmocked: '/companion' })));
    const release = startCompanionFeed();
    latest().onDisconnect?.(new SseHttpError(404));
    vi.advanceTimersByTime(60_000);
    expect(feed.subscriptions).toHaveLength(1);
    release();
  });

  it('retries the first connection within a few seconds, not 30; once connected, a later drop backs off as before (D20)', () => {
    vi.useFakeTimers();
    const release = startCompanionFeed();
    for (const wait of [1_000, 2_000, 3_000, 3_000, 3_000]) {
      latest().onDisconnect?.(new Error('backend not up yet'));
      vi.advanceTimersByTime(wait - 1);
      const before = feed.subscriptions.length;
      vi.advanceTimersByTime(1);
      expect(feed.subscriptions.length, `after ${wait} ms`).toBe(before + 1);
    }
    // It connects, then drops before holding 30s: the backoff goes on doubling past three seconds.
    latest().onOpen?.();
    latest().onDisconnect?.(new Error('network'));
    vi.advanceTimersByTime(30_000);
    const count = feed.subscriptions.length;
    latest().onDisconnect?.(new Error('network'));
    vi.advanceTimersByTime(3_000);
    expect(feed.subscriptions).toHaveLength(count);
    release();
  });

  it('opens before the first snapshot is in, and only once', async () => {
    resetCompanionStoreForTests();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(companionSnapshot())));
    const release = startCompanionFeed();
    expect(feed.subscriptions).toHaveLength(1);
    await loadCompanion();
    expect(feed.subscriptions).toHaveLength(1);
    release();
  });

  it('has the prefs read the notification level again when Michi changed it, and only then', () => {
    const release = startCompanionFeed();
    latest().onEvent({ type: 'companion_changed', revision: 2, reason: 'settings' });
    expect(prefs.noteNotificationLevelChanged).not.toHaveBeenCalled();
    latest().onEvent({ type: 'companion_changed', revision: 3, reason: 'notifications' });
    expect(prefs.noteNotificationLevelChanged).toHaveBeenCalledTimes(1);
    release();
  });
});
