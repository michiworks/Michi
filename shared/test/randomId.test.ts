import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { randomUuid } from '../src/index';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function useCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

describe('randomUuid', () => {
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  });

  test('uses crypto.randomUUID where it exists', () => {
    useCrypto({ randomUUID: () => '11111111-2222-4333-8444-555555555555' });
    assert.equal(randomUuid(), '11111111-2222-4333-8444-555555555555');
  });

  // A page served over plain HTTP is not a secure context: no randomUUID.
  test('builds a v4 UUID from getRandomValues outside a secure context, whatever the bytes are', () => {
    useCrypto({ getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff) });
    assert.equal(randomUuid(), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
    useCrypto({ getRandomValues: (bytes: Uint8Array) => bytes.fill(0) });
    assert.equal(randomUuid(), '00000000-0000-4000-8000-000000000000');
  });

  test('still returns unique v4-shaped ids without Web Crypto', () => {
    useCrypto(undefined);
    const ids = new Set(Array.from({ length: 50 }, () => randomUuid()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, UUID_V4);
  });
});
