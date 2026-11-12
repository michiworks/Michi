import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { abortable, withDeadline } from '../src/core/runtimeLifecycle';

test('abortable rejects at once on a cancelled signal and still observes the work', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const controller = new AbortController();
    const reason = new Error('cancelled first');
    controller.abort(reason);
    const work = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lookup failed later')), 5));
    await assert.rejects(abortable(work, controller.signal), (error) => error === reason);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('abortable removes its abort listener once the work settles', async () => {
  const { signal } = new AbortController();
  const settled = abortable(Promise.resolve('done'), signal);
  assert.equal(getEventListeners(signal, 'abort').length, 1);
  assert.equal(await settled, 'done');
  await Promise.resolve();
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('withDeadline rejects with the given message and clears its timer', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers: NodeJS.Timeout[] = [];
  const cleared: unknown[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = realSetTimeout(...args);
    timers.push(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: NodeJS.Timeout) => {
    cleared.push(timer);
    realClearTimeout(timer);
  }) as typeof clearTimeout;
  try {
    await assert.rejects(withDeadline(new Promise(() => {}), 5, 'probe timed out'), { message: 'probe timed out' });
    assert.equal(await withDeadline(Promise.resolve(7), 60_000, 'unused'), 7);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  assert.equal(timers.length, 2);
  assert.deepEqual(cleared, timers);
});
