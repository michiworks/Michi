import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import {
  CHECKPOINT_BYTES_PER_SECOND,
  checkpointIntervalMs,
  MAINTENANCE_CHECKPOINT_PACING,
  TURN_CHECKPOINT_PACING,
  TurnCheckpointScheduler,
  type CheckpointWrite,
} from '../src/agents/turnCheckpoints';

const MIB = 1024 * 1024;

/** One real event-loop turn: the scheduler's next-tick writes run in it (setImmediate is not mocked). */
async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A scheduler on mocked setTimeout and Date, its turn begun at 0; `writes` holds each write's time. */
function scheduler(t: TestContext, write?: CheckpointWrite, pacing = TURN_CHECKPOINT_PACING) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const writes: number[] = [];
  const checkpoints = new TurnCheckpointScheduler(() => {
    writes.push(Date.now());
    return write ? write() : null;
  }, pacing, 0);
  return { checkpoints, writes, tick: (ms: number) => t.mock.timers.tick(ms) };
}

describe('checkpointIntervalMs', () => {
  test('grows with the last write at 256 KB/s between 1.5 s and 5 s', () => {
    assert.equal(CHECKPOINT_BYTES_PER_SECOND, 256 * 1024);
    assert.equal(checkpointIntervalMs(null, TURN_CHECKPOINT_PACING), 1_500);
    assert.equal(checkpointIntervalMs(256 * 1024, TURN_CHECKPOINT_PACING), 1_500);
    assert.equal(checkpointIntervalMs(MIB, TURN_CHECKPOINT_PACING), 4_000);
    assert.equal(checkpointIntervalMs(20 * MIB, TURN_CHECKPOINT_PACING), 5_000);
  });

  test('a maintenance turn waits 5 s to 10 s', () => {
    assert.equal(checkpointIntervalMs(null, MAINTENANCE_CHECKPOINT_PACING), 5_000);
    assert.equal(checkpointIntervalMs(2 * MIB, MAINTENANCE_CHECKPOINT_PACING), 8_000);
    assert.equal(checkpointIntervalMs(20 * MIB, MAINTENANCE_CHECKPOINT_PACING), 10_000);
  });
});

describe('TurnCheckpointScheduler', () => {
  test('text that stops streaming is written by the trailing timer, once', (t) => {
    const { checkpoints, writes, tick } = scheduler(t);
    tick(200);
    checkpoints.markDirty();
    tick(1_299);
    assert.deepEqual(writes, [], 'not before the interval since the turn began');
    tick(1);
    assert.deepEqual(writes, [1_500]);
    tick(60_000);
    assert.deepEqual(writes, [1_500], 'nothing new, nothing written');
  });

  test('a turn that keeps streaming is written once per interval', (t) => {
    const { checkpoints, writes, tick } = scheduler(t);
    for (let at = 0; at < 6_000; at += 100) {
      checkpoints.markDirty();
      tick(100);
    }
    assert.deepEqual(writes, [1_500, 3_000, 4_500, 6_000]);
  });

  test('the interval follows the bytes the last write reported', (t) => {
    const { checkpoints, writes, tick } = scheduler(t, () => MIB);
    checkpoints.markDirty();
    tick(1_500);
    assert.deepEqual(writes, [1_500]);
    checkpoints.markDirty();
    tick(3_999);
    assert.deepEqual(writes, [1_500], 'a 1 MiB row waits 4 s');
    tick(1);
    assert.deepEqual(writes, [1_500, 5_500]);
  });

  test('a maintenance turn is first written after 5 s', (t) => {
    const { checkpoints, writes, tick } = scheduler(t, undefined, MAINTENANCE_CHECKPOINT_PACING);
    checkpoints.markDirty();
    tick(4_999);
    assert.deepEqual(writes, []);
    tick(1);
    assert.deepEqual(writes, [5_000]);
  });

  test('events that ask for a write soon share one write on the next tick', async (t) => {
    const { checkpoints, writes } = scheduler(t);
    checkpoints.markDirty();
    checkpoints.markDirty(true);
    checkpoints.markDirty(true);
    checkpoints.markDirty();
    assert.deepEqual(writes, [], 'not inside the tick that applied the events');
    await nextTick();
    assert.deepEqual(writes, [0]);
  });

  test('a write in flight holds the next until it settles, or until the max dirty age', async (t) => {
    const pending: Array<(bytes: number | null) => void> = [];
    const { checkpoints, writes, tick } = scheduler(t, () => new Promise<number | null>((resolve) => { pending.push(resolve); }));
    checkpoints.markDirty(true);
    await nextTick();
    assert.deepEqual(writes, [0]);

    checkpoints.markDirty(true);
    await nextTick();
    tick(4_999);
    assert.deepEqual(writes, [0], 'one write in flight per turn');
    tick(1);
    assert.deepEqual(writes, [0, 5_000], 'an event waits no longer than the max dirty age');

    checkpoints.markDirty(true);
    await nextTick();
    assert.deepEqual(writes, [0, 5_000]);
    pending.shift()!(null);
    pending.shift()!(null);
    await nextTick();
    assert.deepEqual(writes, [0, 5_000, 5_000], 'written once the store answers');
  });

  test('cancel drops a pending write and every later event', async (t) => {
    const { checkpoints, writes, tick } = scheduler(t);
    checkpoints.markDirty();
    checkpoints.markDirty(true);
    checkpoints.cancel();
    await nextTick();
    tick(60_000);
    checkpoints.markDirty(true);
    await nextTick();
    tick(60_000);
    assert.deepEqual(writes, []);
  });

  test('a failed write is not retried until another event', async (t) => {
    const { checkpoints, writes, tick } = scheduler(t, () => { throw new Error('database busy'); });
    checkpoints.markDirty(true);
    await nextTick();
    tick(60_000);
    assert.deepEqual(writes, [0]);
    checkpoints.markDirty();
    await nextTick();
    assert.deepEqual(writes, [0, 60_000], 'the next event, already past its interval, is written on the next tick');
  });
});
