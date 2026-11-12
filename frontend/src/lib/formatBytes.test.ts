import { describe, expect, it } from 'vitest';
import { formatBytes } from './formatBytes';

describe('formatBytes', () => {
  it('gives the empty text for a missing, zero or invalid size', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(undefined, { empty: '—' })).toBe('—');
    expect(formatBytes(0, { empty: '—' })).toBe('—');
  });

  it('shows one decimal under ten units and none above', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(524_288)).toBe('512 KB');
    expect(formatBytes(4_194_304)).toBe('4.0 MB');
    expect(formatBytes(5_242_880)).toBe('5.0 MB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
  });
});
