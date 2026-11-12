import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocateNodeIdsLocal } from './sessions';

afterEach(() => { vi.unstubAllGlobals(); });

describe('allocateNodeIdsLocal', () => {
  // Plain HTTP through a proxy host or a LAN address is not a secure context.
  it('allocates backend-shaped node ids where crypto.randomUUID is missing', () => {
    const webCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => webCrypto.getRandomValues(bytes) });
    const ids = allocateNodeIdsLocal(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^n-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
