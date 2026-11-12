import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beginSse, createSseObserver, SLOW_CONSUMER_LIMITS, writeSseFrame } from '../src/services/httpSse';

const OVER_HARD = SLOW_CONSUMER_LIMITS.hardBytes + 1;

class Response extends EventEmitter {
  writableEnded = false; destroyed = false; writableLength = 0; writes: string[] = []; destroys = 0;
  write(frame: string): void { this.writes.push(frame); }
  destroy(): void { this.destroyed = true; this.destroys++; }
}

test('writer guards closed, throwing and post-write overflowing responses', () => {
  const closed = new Response(); closed.destroyed = true; assert.equal(writeSseFrame(closed, 'frame'), false); assert.deepEqual(closed.writes, []);
  const throwing = new Response(); throwing.write = () => { throw new Error('broken peer'); }; assert.doesNotThrow(() => assert.equal(writeSseFrame(throwing, 'frame'), false)); assert.equal(throwing.destroyed, true);
  const growing = new Response(); growing.write = () => { growing.writableLength = OVER_HARD; }; assert.equal(writeSseFrame(growing, 'frame'), false); assert.equal(growing.destroyed, true);
  const normal = new Response(); assert.equal(writeSseFrame(normal, 'frame'), true); assert.deepEqual(normal.writes, ['frame']);
});

test('every stream opens with the same status and headers, flushed before its first frame', () => {
  const response = Object.assign(new Response(), {
    statusCode: 0, headers: {} as Record<string, string>, flushed: 0,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    flushHeaders() { this.flushed++; },
  });
  const observer = beginSse(response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  assert.equal(response.flushed, 1);
  assert.equal(observer.write('frame'), true);
  response.emit('close');
  assert.equal(observer.closed, true);
});

test('observer disconnect/error/overflow releases subscriptions and heartbeat exactly once', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const mode of ['close', 'error', 'overflow']) {
    const response = new Response(); const observer = createSseObserver(response); let detaches = 0;
    observer.addCleanup(() => { detaches++; }); observer.heartbeat(': heartbeat\n\n', 10);
    t.mock.timers.tick(10); assert.equal(response.writes.length, 1);
    if (mode === 'overflow') { response.writableLength = OVER_HARD; observer.write('frame'); }
    else response.emit(mode);
    observer.close(); observer.addCleanup(() => { detaches++; });
    t.mock.timers.tick(50); assert.equal(response.writes.length, 1); assert.equal(detaches, 2); assert.equal(observer.closed, true);
  }
});
