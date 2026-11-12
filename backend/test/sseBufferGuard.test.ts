import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlowConsumerGuard, SLOW_CONSUMER_LIMITS, writeSseFrame } from '../src/services/httpSse';

const { softBytes, softMs, hardBytes } = SLOW_CONSUMER_LIMITS;

class FakeSseResponse {
  writableEnded = false;
  destroyed = false;
  writableLength = 0;
  writes: string[] = [];
  destroyError: Error | undefined;

  write(frame: string): void {
    this.writes.push(frame);
  }

  destroy(error?: Error): void {
    this.destroyed = true;
    this.destroyError = error;
  }
}

describe('writeSseFrame', () => {
  test('disconnects a response above the hard limit without throwing to the central turn', () => {
    const response = new FakeSseResponse();
    response.writableLength = hardBytes + 1;

    assert.doesNotThrow(() => {
      assert.equal(writeSseFrame(response, 'event: chunk\\n\\n'), false);
    });
    assert.equal(response.destroyed, true);
    assert.match(response.destroyError?.message ?? '', /buffer limit/i);
  });

  // 2026-11-09: a subscription's synchronous replay (every live session's
  // state) queued over 1 MiB in one tick, the old limit destroyed it, and every
  // reconnect replayed the same burst: the feed never stayed open.
  test('keeps a burst well past the old 1 MiB limit that the client drains', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const response = new FakeSseResponse();
    response.write = (frame: string) => { response.writes.push(frame); response.writableLength += 52_000; };
    for (let i = 0; i < 100; i += 1) assert.equal(writeSseFrame(response, `frame ${i}`), true);
    assert.ok(response.writableLength > softBytes, 'the burst is above the soft level');
    response.writableLength = 0; // the socket drained
    t.mock.timers.tick(softMs + 1);
    assert.equal(response.destroyed, false);
    assert.equal(writeSseFrame(response, 'after'), true);
    assert.equal(response.writes.length, 101);
  });

  test('disconnects a client that stays above the soft level, even with no further writes', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const response = new FakeSseResponse();
    response.write = () => { response.writableLength = softBytes + 1; };
    assert.equal(writeSseFrame(response, 'frame'), true);
    t.mock.timers.tick(softMs - 1);
    assert.equal(response.destroyed, false);
    t.mock.timers.tick(1);
    assert.equal(response.destroyed, true);
    assert.match(response.destroyError?.message ?? '', /buffer limit/i);
  });

  test('a write that finds the buffer drained starts the soft window over', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const response = new FakeSseResponse();
    response.writableLength = softBytes + 1;
    assert.equal(writeSseFrame(response, 'one'), true);
    t.mock.timers.tick(softMs - 10);
    response.writableLength = 0;
    response.write = () => { response.writableLength = softBytes + 1; };
    assert.equal(writeSseFrame(response, 'two'), true, 'sampled drained before the write');
    t.mock.timers.tick(20);
    assert.equal(response.destroyed, false, 'the earlier pressure ended when the buffer drained');
    t.mock.timers.tick(softMs);
    assert.equal(response.destroyed, true);
  });

  test('a closed response is never judged by a pending soft check', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const response = new FakeSseResponse();
    response.writableLength = softBytes + 1;
    assert.equal(writeSseFrame(response, 'frame'), true);
    response.writableEnded = true;
    t.mock.timers.tick(softMs);
    assert.equal(response.destroyed, false);
  });
});

describe('createSlowConsumerGuard', () => {
  test('reports once, with the reason and the buffered bytes', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let buffered = 0;
    const reports: Array<[string, number]> = [];
    const guard = createSlowConsumerGuard({ bufferedBytes: () => buffered, onSlow: (reason, bytes) => reports.push([reason, bytes]) });
    buffered = hardBytes + 5;
    assert.equal(guard.check(), false);
    assert.equal(guard.check(), false);
    assert.deepEqual(reports, [['hard', hardBytes + 5]]);

    const soft = createSlowConsumerGuard({ bufferedBytes: () => buffered, onSlow: (reason, bytes) => reports.push([reason, bytes]) });
    buffered = softBytes + 7;
    assert.equal(soft.check(), true);
    t.mock.timers.tick(softMs);
    assert.deepEqual(reports.at(-1), ['soft', softBytes + 7]);
  });

  test('dispose cancels a pending soft check', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let slow = 0;
    const guard = createSlowConsumerGuard({ bufferedBytes: () => softBytes + 1, onSlow: () => { slow += 1; } });
    assert.equal(guard.check(), true);
    guard.dispose();
    t.mock.timers.tick(softMs * 2);
    assert.equal(slow, 0);
  });
});
