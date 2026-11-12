import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import type { MemoryChangeSubscription } from '../../services/api/memories';
import { MemoryApiError } from '../../services/api/memories';
import { SseHttpError } from '../../services/api/sseParser';
import {
  onMemoryChanged,
  resetMemoryNotifications,
  runSelfCreate,
  runSelfMutation,
  useMemoryNotice,
  useMemoryNotifications,
} from './memoryNotifications';

const api = vi.hoisted(() => ({
  subscriptions: [] as Array<{ options: MemoryChangeSubscription; stop: ReturnType<typeof vi.fn> }>,
  deleteMemory: vi.fn(),
  fetchMemorySettings: vi.fn(),
  markMemoryNoticeSeen: vi.fn(),
}));
const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() });
  return { toast };
});

vi.mock('sonner', () => ({ toast: toasts.toast }));
vi.mock('../../services/api/memories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/memories')>()),
  deleteMemory: api.deleteMemory,
  fetchMemorySettings: api.fetchMemorySettings,
  markMemoryNoticeSeen: api.markMemoryNoticeSeen,
  subscribeMemoryChanges: (options: MemoryChangeSubscription) => {
    const stop = vi.fn();
    api.subscriptions.push({ options, stop });
    return stop;
  },
}));

const event = (overrides: Partial<MemoryChangedEvent> = {}): MemoryChangedEvent => ({
  ownerUserId: 'local', workspaceId: null, memoryId: 'mem-1', action: 'created', status: 'active',
  body: 'Answer in Chinese', origin: 'explicit', supersedesId: null, ...overrides,
});

const record = (id: string): MemoryRecord => ({
  id, ownerUserId: 'local', scope: { kind: 'user' }, kind: 'preference', body: 'from Settings', source: null,
  status: 'active', origin: 'explicit', version: 1, supersedesId: null, sourceRisk: null, createdAt: 1, updatedAt: 1,
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

function mount(onReview = vi.fn()) {
  const view = renderHook(() => useMemoryNotifications(onReview));
  return { ...view, onReview, feed: () => api.subscriptions[api.subscriptions.length - 1] };
}

/** The toast message and options of every plain toast() call. */
const shown = () => toasts.toast.mock.calls.map(([message, options]) => ({ message, options }));

beforeEach(() => {
  resetMemoryNotifications();
  api.subscriptions = [];
  api.deleteMemory.mockReset().mockResolvedValue(undefined);
  api.fetchMemorySettings.mockReset().mockResolvedValue({ mode: 'auto', migratedFromExplicit: false, noticeSeen: false });
  api.markMemoryNoticeSeen.mockReset().mockResolvedValue({ mode: 'auto', noticeSeen: true });
  toasts.toast.mockReset();
  toasts.toast.success.mockReset();
  toasts.toast.error.mockReset();
  toasts.toast.dismiss.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetMemoryNotifications();
});

describe('memory change toasts', () => {
  it('shows “Remembered” with Undo for a memory an agent saved, and Undo deletes it', async () => {
    const { feed } = mount();
    await flush();
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent', body: '  Use   pnpm,\nnot npm  ' })));
    expect(shown()).toHaveLength(1);
    const [{ message, options }] = shown();
    expect(message).toBe('Remembered: Use pnpm, not npm');
    expect(options.id).toBe('memory:mem-agent');
    expect(options.action.label).toBe('Undo');
    await act(async () => { options.action.onClick(); });
    await flush();
    expect(api.deleteMemory).toHaveBeenCalledExactlyOnceWith('mem-agent');
    expect(toasts.toast.success).toHaveBeenCalledWith('Memory removed');
    // The deletion Undo caused shows nothing more and closes the toast.
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent', action: 'deleted' })));
    expect(shown()).toHaveLength(1);
    expect(toasts.toast.dismiss).toHaveBeenCalledWith('memory:mem-agent');
  });

  it('says so when Undo finds the memory already gone, and reports other failures', async () => {
    const { feed } = mount();
    await flush();
    act(() => feed().options.onEvent(event({ memoryId: 'gone' })));
    act(() => feed().options.onEvent(event({ memoryId: 'broken' })));
    api.deleteMemory.mockRejectedValueOnce(new MemoryApiError(404, 'Memory not found', { code: 'not_found' }));
    await act(async () => { shown()[0].options.action.onClick(); });
    await flush();
    expect(toasts.toast).toHaveBeenLastCalledWith('That memory was already removed');
    api.deleteMemory.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { shown()[1].options.action.onClick(); });
    await flush();
    expect(toasts.toast.error).toHaveBeenCalledWith('Couldn’t remove the memory: offline');
  });

  it('stays quiet for what automatic memory saves or corrects, and for a pending memory an older backend wrote', async () => {
    const { feed } = mount();
    await flush();
    act(() => feed().options.onEvent(event({ memoryId: 'auto', origin: 'extracted', body: 'Deploys go out on Fridays' })));
    act(() => feed().options.onEvent(event({ memoryId: 'auto-fix', origin: 'extracted', supersedesId: 'auto' })));
    act(() => feed().options.onEvent(event({ memoryId: 'legacy', status: 'pending' })));
    expect(shown()).toHaveLength(0);
    act(() => feed().options.onEvent(event({ memoryId: 'asked' })));
    expect(shown().map(({ message }) => message)).toEqual(['Remembered: Answer in Chinese']);
  });

  it('offers Review rather than Undo for a correction, since deleting it would not restore the old memory', async () => {
    const { feed, onReview } = mount();
    await flush();
    act(() => feed().options.onEvent(event({ memoryId: 'new', supersedesId: 'old', body: 'Use 4 spaces' })));
    act(() => feed().options.onEvent(event({ memoryId: 'old', action: 'superseded', status: 'superseded' })));
    expect(shown()).toHaveLength(1);
    expect(shown()[0].message).toBe('Memory updated: Use 4 spaces');
    expect(shown()[0].options.action.label).toBe('Review');
    shown()[0].options.action.onClick();
    expect(onReview).toHaveBeenCalledOnce();
  });

  it('shows nothing for updates, approvals and deletions, or twice for one memory', async () => {
    const { feed } = mount();
    await flush();
    for (const action of ['updated', 'approved', 'deleted', 'rejected', 'superseded'] as const) {
      act(() => feed().options.onEvent(event({ memoryId: `m-${action}`, action })));
    }
    expect(shown()).toHaveLength(0);
    act(() => feed().options.onEvent(event({ memoryId: 'twice' })));
    act(() => feed().options.onEvent(event({ memoryId: 'twice' })));
    expect(shown()).toHaveLength(1);
  });
});

describe('what consolidation does', () => {
  it('a note put away (superseded) or brought back (updated) by Michi shows nothing, and is passed on to the views that list memories', async () => {
    const { feed } = mount();
    await flush();
    const listener = vi.fn();
    const stop = onMemoryChanged(listener);
    act(() => feed().options.onEvent(event({ memoryId: 'dup', action: 'superseded', status: 'superseded', origin: 'extracted' })));
    act(() => feed().options.onEvent(event({ memoryId: 'back', action: 'updated', status: 'active', origin: 'extracted' })));
    expect(shown()).toHaveLength(0);
    expect(toasts.toast.success).not.toHaveBeenCalled();
    expect(listener.mock.calls.map(([change]) => [change.memoryId, change.action])).toEqual([['dup', 'superseded'], ['back', 'updated']]);
    stop();
  });
});

describe('changes Settings makes itself', () => {
  it('stays quiet for a memory Settings is changing, and for a while after', async () => {
    const { feed } = mount();
    await flush();
    let finish!: () => void;
    const done = runSelfMutation('mem-self', () => new Promise<void>((resolve) => { finish = resolve; }));
    act(() => feed().options.onEvent(event({ memoryId: 'mem-self' })));
    finish();
    await act(async () => { await done; });
    act(() => feed().options.onEvent(event({ memoryId: 'mem-self' })));
    expect(shown()).toHaveLength(0);
    // Another memory meanwhile still shows.
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent' })));
    expect(shown().map(({ message }) => message)).toEqual(['Remembered: Answer in Chinese']);
  });

  it('holds new memories while Settings adds one, then shows only the ones Settings did not add', async () => {
    const { feed } = mount();
    await flush();
    let answer!: (record: MemoryRecord) => void;
    const adding = runSelfCreate(() => new Promise<MemoryRecord>((resolve) => { answer = resolve; }));
    // The feed announces the addition before its HTTP answer arrives.
    act(() => feed().options.onEvent(event({ memoryId: 'mem-added', body: 'from Settings' })));
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent', body: 'from an agent' })));
    expect(shown()).toHaveLength(0);
    answer(record('mem-added'));
    await act(async () => { await adding; });
    expect(shown().map(({ message }) => message)).toEqual(['Remembered: from an agent']);
  });

  it('shows held memories when the addition fails', async () => {
    const { feed } = mount();
    await flush();
    const adding = runSelfCreate(() => Promise.reject(new Error('memory_disabled')));
    act(() => feed().options.onEvent(event({ memoryId: 'mem-agent' })));
    await act(async () => { await adding.catch(() => {}); });
    expect(shown()).toHaveLength(1);
  });
});

describe('the feed', () => {
  it('opens one feed for every listener and closes it with the last', async () => {
    const first = mount();
    const second = mount();
    await flush();
    expect(api.subscriptions).toHaveLength(1);
    first.unmount();
    expect(api.subscriptions[0].stop).not.toHaveBeenCalled();
    second.unmount();
    expect(api.subscriptions[0].stop).toHaveBeenCalledOnce();
  });

  it('reconnects with a growing delay, and stops on a backend without the feed', async () => {
    vi.useFakeTimers();
    // No jitter: the delays below are the base ones.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    onTestFinished(() => random.mockRestore());
    const { feed } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => feed().options.onDisconnect?.(new Error('network')));
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(api.subscriptions).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.subscriptions).toHaveLength(2);
    act(() => feed().options.onDisconnect?.(new Error('network')));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(api.subscriptions).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.subscriptions).toHaveLength(3);
    act(() => feed().options.onDisconnect?.(new SseHttpError(404)));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.subscriptions).toHaveLength(3);
  });

  it('reconnects at once when the window comes back online, but not once the backend has no feed', async () => {
    vi.useFakeTimers();
    const { feed } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => feed().options.onDisconnect?.(new Error('network')));
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(api.subscriptions).toHaveLength(2);
    act(() => feed().options.onDisconnect?.(new SseHttpError(404)));
    act(() => { window.dispatchEvent(new Event('online')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.subscriptions).toHaveLength(2);
  });

  it('never moves focus or navigates when a change arrives', async () => {
    const { feed, onReview } = mount();
    await flush();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    act(() => {
      feed().options.onEvent(event({ memoryId: 'a' }));
      feed().options.onEvent(event({ memoryId: 'b', supersedesId: 'old' }));
    });
    expect(document.activeElement).toBe(button);
    expect(onReview).not.toHaveBeenCalled();
    button.remove();
  });
});

describe('the one-time notice', () => {
  function notice(ready: boolean, onReview = vi.fn()) {
    const view = renderHook(({ on }) => useMemoryNotice(on, onReview), { initialProps: { on: ready } });
    return { ...view, onReview };
  }

  it('waits until setup is done, then tells a new user once, and counts as seen when it closes', async () => {
    const { rerender, unmount } = notice(false);
    await flush();
    expect(api.fetchMemorySettings).not.toHaveBeenCalled();
    rerender({ on: true });
    await flush();
    expect(shown().map(({ message }) => message)).toEqual(['Michi remembers what matters']);
    const { options } = shown()[0];
    expect(options.description).toContain('Review it or turn it off in Settings › Memory.');
    expect(options.duration).toBe(20_000);
    expect(api.markMemoryNoticeSeen).not.toHaveBeenCalled();
    options.onAutoClose();
    options.onDismiss();
    expect(api.markMemoryNoticeSeen).toHaveBeenCalledOnce();
    unmount();
    // Another mount in this window does not ask again.
    notice(true);
    await flush();
    expect(api.fetchMemorySettings).toHaveBeenCalledOnce();
  });

  it('tells someone whose explicit-only memory became on, and Review opens Settings', async () => {
    api.fetchMemorySettings.mockResolvedValue({ mode: 'auto', migratedFromExplicit: true, noticeSeen: false });
    const { onReview } = notice(true);
    await flush();
    const [{ message, options }] = shown();
    expect(message).toBe('Memory now learns from your conversations');
    expect(options.description).toContain('It used to save only what you asked it to remember.');
    options.action.onClick();
    expect(onReview).toHaveBeenCalledOnce();
    expect(api.markMemoryNoticeSeen).toHaveBeenCalledOnce();
  });

  it.each([
    ['once seen', { mode: 'auto', noticeSeen: true }],
    ['with memory off', { mode: 'off', noticeSeen: false }],
    ['on a backend without the notice', { mode: 'auto' }],
  ])('shows nothing %s', async (_case, settings) => {
    api.fetchMemorySettings.mockResolvedValue(settings);
    notice(true);
    await flush();
    expect(shown()).toEqual([]);
  });

  it('asks again on a later mount when the settings could not be read', async () => {
    api.fetchMemorySettings.mockRejectedValueOnce(new Error('offline'));
    const first = notice(true);
    await flush();
    first.unmount();
    notice(true);
    await flush();
    expect(shown().map(({ message }) => message)).toEqual(['Michi remembers what matters']);
  });
});
