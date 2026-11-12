import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTerminalStreamEvent } from '../src/terminals';

test('parses each terminal stream event and rejects malformed ones', () => {
  assert.deepEqual(parseTerminalStreamEvent('reset', '{"seq":3,"instance":"r1","data":"$ ","exited":true,"exitCode":2}'),
    { type: 'reset', seq: 3, instance: 'r1', data: '$ ', exited: true, exitCode: 2 });
  assert.deepEqual(parseTerminalStreamEvent('data', '{"seq":5,"data":"ls"}'), { type: 'data', seq: 5, data: 'ls' });
  assert.deepEqual(parseTerminalStreamEvent('exit', '{"seq":5,"exitCode":0}'), { type: 'exit', seq: 5, exitCode: 0 });
  assert.deepEqual(parseTerminalStreamEvent('restart', '{"seq":5}'), { type: 'restart', seq: 5 });
  assert.deepEqual(parseTerminalStreamEvent('peers', '{"phone":1,"desktop":0}'), { type: 'peers', phone: 1, desktop: 0 });
  assert.deepEqual(parseTerminalStreamEvent('closed', '{"reason":"phone-off"}'), { type: 'closed', reason: 'phone-off' });
  assert.deepEqual(parseTerminalStreamEvent('closed', '{"reason":"other"}'), { type: 'closed' });
  // A reset without its instance would let a client mix two runs' seq values.
  assert.equal(parseTerminalStreamEvent('reset', '{"seq":3,"data":""}'), null);
  assert.equal(parseTerminalStreamEvent('data', '{"seq":"5","data":"x"}'), null);
  assert.equal(parseTerminalStreamEvent('data', 'not json'), null);
  assert.equal(parseTerminalStreamEvent('message', '{}'), null);
});
