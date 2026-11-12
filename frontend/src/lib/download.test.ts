import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, downloadText } from './download';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stubObjectUrls() {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return { create, revoke };
}

describe('downloadBlob', () => {
  it('clicks a named anchor while it is in the page, then removes it', () => {
    stubObjectUrls();
    const seen: Array<{ connected: boolean; download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      seen.push({ connected: this.isConnected, download: this.download, href: this.getAttribute('href') ?? '' });
    });
    expect(downloadBlob(new Blob(['x']), 'notes.md')).toBe(true);
    expect(seen).toEqual([{ connected: true, download: 'notes.md', href: 'blob:file' }]);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('revokes the URL a minute later, not at the click', () => {
    vi.useFakeTimers();
    const { revoke } = stubObjectUrls();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadText('table.md', '| a |', 'text/markdown;charset=utf-8');
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:file');
  });

  it('is false without object URLs', () => {
    const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')!;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: undefined });
    try {
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
      expect(downloadBlob(new Blob(['x']), 'notes.md')).toBe(false);
      expect(click).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(URL, 'createObjectURL', original);
    }
  });
});
