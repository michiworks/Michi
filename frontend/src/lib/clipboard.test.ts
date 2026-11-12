import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => { vi.unstubAllGlobals(); });

describe('copyText', () => {
  it('is true once the write lands', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('is false without a clipboard API, as on a plain-http remote origin', async () => {
    vi.stubGlobal('navigator', {});
    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('is false when the write is refused or throws', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    await expect(copyText('hello')).resolves.toBe(false);
    vi.stubGlobal('navigator', { clipboard: { writeText: () => { throw new TypeError('no'); } } });
    await expect(copyText('hello')).resolves.toBe(false);
  });
});
