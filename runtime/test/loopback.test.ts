import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLoopbackAddress } from '../src/core/loopback';

test('isLoopbackAddress accepts only 127.0.0.0/8, ::1 and IPv4-mapped 127.x', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:127.9.9.9']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of [undefined, '', '10.0.0.1', '128.0.0.1', '::ffff:10.0.0.1', '::2', '0.0.0.0', '::', 'localhost', '127.0.0.256']) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});
