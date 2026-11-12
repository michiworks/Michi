import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortableDelay } from './sleep';

describe('abortableDelay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits, or stops waiting with the signal\'s reason when it aborts', async () => {
    const controller = new AbortController();
    let done = false;
    const wait = abortableDelay(500, controller.signal).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(done).toBe(true);
    const aborted = abortableDelay(500, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    await expect(abortableDelay(500, controller.signal)).rejects.toBe(controller.signal.reason);
  });

  it('waits without a signal and leaves no listener on one once the wait ends', async () => {
    const wait = abortableDelay(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(wait).resolves.toBeUndefined();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const ended = abortableDelay(100, controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    await ended;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
