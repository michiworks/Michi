import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionClaimResultV1, AttentionNotificationV1 } from 'michi-shared';
import {
  isServerAttentionActive,
  noteServerAttentionCapabilities,
  subscribeServerAttention,
  type AttentionIntent,
  type ServerAttentionPresentation,
} from './serverAttention';
import {
  activeServerAttentionRecords,
  receiveServerAttentionFrame,
  resetServerAttentionStore,
} from './serverAttentionStore';

const NOW = 1_000_000;

function record(overrides: Partial<AttentionNotificationV1> = {}): AttentionNotificationV1 {
  return {
    id: 'attn-1', key: 'node:n1', kind: 'finished', reason: 'completed', title: 'Fix the build', body: 'Streaming finished',
    target: { type: 'node', nodeId: 'n1', workspaceId: 'ws-1' }, createdAt: NOW, claimedByWindowId: null, claimedAt: null,
    ...overrides,
  };
}

const live = (value: AttentionNotificationV1, connectionId = 'local') =>
  receiveServerAttentionFrame(connectionId, 'attention_notification', JSON.stringify(value));
const snapshot = (notifications: AttentionNotificationV1[], connectionId = 'local') =>
  receiveServerAttentionFrame(connectionId, 'attention_snapshot', JSON.stringify({ protocol: 'v1', notifications }));
const resolved = (value: AttentionNotificationV1, connectionId = 'local') =>
  receiveServerAttentionFrame(connectionId, 'attention_resolved', JSON.stringify({
    id: value.id, key: value.key, target: value.target, reason: 'seen', resolvedAt: NOW + 5,
  }));

function harness(options: { focused?: boolean; claimed?: boolean | 'error'; windowId?: string } = {}) {
  let focused = options.focused ?? false;
  const shown: Array<{ intent: AttentionIntent; presentation: ServerAttentionPresentation }> = [];
  const dismissed: string[] = [];
  const claim = vi.fn(async (_connection: string, id: string, windowId: string): Promise<AttentionClaimResultV1 | null> => {
    if (options.claimed === 'error') throw new Error('offline');
    return options.claimed === false
      ? { claimed: false, claimedByWindowId: 'other-window', status: 'active' }
      : { claimed: true, claimedByWindowId: windowId, status: 'active' };
  });
  const stop = subscribeServerAttention((intent, presentation) => {
    shown.push({ intent, presentation });
    return () => dismissed.push(intent.serverId);
  }, {
    windowId: options.windowId ?? 'this-window',
    windowFocused: () => focused,
    claim,
    now: () => NOW,
  });
  return { shown, dismissed, claim, stop, setFocused: (value: boolean) => { focused = value; } };
}

const settle = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  resetServerAttentionStore();
  noteServerAttentionCapabilities('local', null);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('presenting server attention', () => {
  it('a focused window claims at once and shows the intent', async () => {
    const { shown, claim, stop } = harness({ focused: true });
    live(record());
    await settle();
    expect(claim).toHaveBeenCalledWith('local', 'attn-1', 'this-window');
    expect(shown).toEqual([{
      intent: {
        key: 'server:local:node:n1', kind: 'finished', title: 'Fix the build', body: 'Streaming finished', serverId: 'attn-1',
        target: { type: 'node', nodeId: 'n1', workspaceId: 'ws-1', backendConnectionId: 'local' },
      },
      presentation: { claimed: true, windowFocused: true, replay: false },
    }]);
    stop();
  });

  it('an unfocused window waits, then shows only a claim it won', async () => {
    const winner = harness();
    live(record());
    await settle(399);
    expect(winner.claim).not.toHaveBeenCalled();
    await settle(1);
    expect(winner.shown.map((item) => item.presentation)).toEqual([{ claimed: true, windowFocused: false, replay: false }]);
    winner.stop();

    resetServerAttentionStore();
    const loser = harness({ claimed: false });
    live(record({ id: 'attn-2' }));
    await settle(400);
    expect(loser.claim).toHaveBeenCalledTimes(1);
    expect(loser.shown, 'another window rings; an unfocused window shows nothing').toEqual([]);
    loser.stop();
  });

  it('a focused window that lost the claim still shows its in-app toast', async () => {
    const { shown, stop } = harness({ focused: true, claimed: false });
    live(record());
    await settle();
    expect(shown.map((item) => item.presentation)).toEqual([{ claimed: false, windowFocused: true, replay: false }]);
    stop();
  });

  it('a resolution dismisses what was shown, and one before the claim shows nothing', async () => {
    const { shown, dismissed, claim, stop } = harness();
    live(record());
    await settle(400);
    resolved(record());
    expect(dismissed).toEqual(['attn-1']);
    live(record({ id: 'attn-2', key: 'node:n2', target: { type: 'node', nodeId: 'n2', workspaceId: 'ws-1' } }));
    await settle(100);
    resolved(record({ id: 'attn-2', key: 'node:n2', target: { type: 'node', nodeId: 'n2', workspaceId: 'ws-1' } }));
    await settle(400);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(shown).toHaveLength(1);
    stop();
  });

  it('a reconnect snapshot shows only recent unclaimed records, and drops what resolved meanwhile', async () => {
    const { shown, dismissed, stop } = harness({ focused: true });
    snapshot([
      record({ id: 'recent' }),
      record({ id: 'claimed-elsewhere', key: 'node:n2', claimedByWindowId: 'other-window', claimedAt: NOW }),
      record({ id: 'claimed-here', key: 'node:n3', claimedByWindowId: 'this-window', claimedAt: NOW }),
      record({ id: 'old', key: 'node:n4', createdAt: NOW - 2 * 60_000 - 1 }),
    ]);
    await settle();
    expect(shown.map((item) => [item.intent.serverId, item.presentation.replay])).toEqual([['recent', true]]);
    snapshot([record({ id: 'old', key: 'node:n4', createdAt: NOW - 2 * 60_000 - 1 })]);
    await settle();
    expect(dismissed).toEqual(['recent']);
    expect(shown, 'an already handled record is not shown again').toHaveLength(1);
    stop();
  });

  it('a target already in view in a focused window is claimed but not shown', async () => {
    const claim = vi.fn(async () => ({ claimed: true, claimedByWindowId: 'w', status: 'active' as const }));
    const shown: AttentionIntent[] = [];
    const stop = subscribeServerAttention((intent) => { shown.push(intent); }, {
      windowId: 'w', windowFocused: () => true, claim, isTargetInView: (intent) => intent.target.type === 'node',
    });
    live(record());
    await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([]);
    stop();
  });

  it('a claim the backend could not answer still alerts rather than miss it', async () => {
    const { shown, stop } = harness({ claimed: 'error' });
    live(record());
    await settle(400);
    expect(shown.map((item) => item.presentation)).toEqual([{ claimed: true, windowFocused: false, replay: false }]);
    stop();
  });

  it('retries a failed claim in the background until the backend answers, while the record is active', async () => {
    let answers = 0;
    const claim = vi.fn(async (_connection: string, _id: string, windowId: string): Promise<AttentionClaimResultV1 | null> => {
      if (claim.mock.calls.length <= 2) throw new Error('offline');
      answers += 1;
      return { claimed: true, claimedByWindowId: windowId, status: 'active' };
    });
    const shown: AttentionIntent[] = [];
    const stop = subscribeServerAttention((intent) => { shown.push(intent); }, {
      windowId: 'this-window', windowFocused: () => true, claim, now: () => NOW, claimRetryDelaysMs: [1_000, 5_000, 20_000],
    });
    live(record());
    await settle();
    expect([claim.mock.calls.length, shown.length]).toEqual([1, 1]);
    await settle(1_000);
    expect(claim, 'the first retry fails too').toHaveBeenCalledTimes(2);
    await settle(5_000);
    expect([claim.mock.calls.length, answers]).toEqual([3, 1]);
    await settle(60_000);
    expect(claim, 'answered: no more retries').toHaveBeenCalledTimes(3);
    expect(shown, 'presented once').toHaveLength(1);

    // A record that resolves meanwhile is not claimed again.
    claim.mockClear();
    claim.mockRejectedValue(new Error('offline'));
    const other = record({ id: 'attn-2', key: 'node:n2', target: { type: 'node', nodeId: 'n2', workspaceId: 'ws-1' } });
    live(other);
    await settle();
    resolved(other);
    await settle(60_000);
    expect(claim).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not present again after a reload what this window showed while its claim failed', async () => {
    const first = harness({ claimed: 'error', focused: true });
    live(record());
    await settle();
    expect(first.shown).toHaveLength(1);
    first.stop();

    // The reload: a new subscription in the same window session, and the feed's snapshot,
    // where the record is still unclaimed and recent.
    const reloaded = harness({ focused: true });
    snapshot([record(), record({ id: 'attn-other', key: 'node:n2', target: { type: 'node', nodeId: 'n2', workspaceId: 'ws-1' } })]);
    await settle();
    expect(reloaded.shown.map((item) => item.intent.serverId)).toEqual(['attn-other']);
    reloaded.stop();
  });

  it('keeps one active record per key and ignores malformed frames', () => {
    live(record());
    live(record({ id: 'attn-newer' }));
    receiveServerAttentionFrame('local', 'attention_notification', '{not json');
    receiveServerAttentionFrame('local', 'attention_notification', JSON.stringify({ id: 'x' }));
    expect(activeServerAttentionRecords('local').map((item) => item.id)).toEqual(['attn-newer']);
  });
});

describe('isServerAttentionActive', () => {
  it('holds per connection once the capability or a snapshot says the backend decides', () => {
    expect(isServerAttentionActive()).toBe(false);
    snapshot([], 'remote-a');
    expect([isServerAttentionActive('remote-a'), isServerAttentionActive()]).toEqual([true, false]);
    noteServerAttentionCapabilities('local', { attention: 'v1' });
    expect(isServerAttentionActive()).toBe(true);
    noteServerAttentionCapabilities('local', { attention: 'v2' });
    expect(isServerAttentionActive()).toBe(false);
    receiveServerAttentionFrame('local', 'attention_snapshot', JSON.stringify({ protocol: 'v2', notifications: [] }));
    expect(isServerAttentionActive(), 'another protocol version is not this one').toBe(false);
  });
});
