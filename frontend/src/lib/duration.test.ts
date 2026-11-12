import { describe, expect, it } from 'vitest';
import { formatDuration, spokenDuration } from './duration';

describe('formatDuration', () => {
  it.each([
    [300, '0.3s'],
    [9_960, '10s'],
    [59_600, '1m'],
    [72_000, '1m 12s'],
    [119_600, '2m'],
    [3_600_000, '1h'],
    [3_900_000, '1h 5m'],
  ])('says a finished %d ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it.each([
    [900, '0s'],
    [12_900, '12s'],
    [60_000, '1m'],
    [119_600, '1m 59s'],
    [3_900_000, '1h 5m'],
    [-50, '0s'],
  ])('says a running %d ms as %s', (ms, text) => {
    expect(formatDuration(ms, { live: true })).toBe(text);
  });
});

describe('spokenDuration', () => {
  it('says what formatDuration shows', () => {
    expect(spokenDuration(300)).toBe('0.3 seconds');
    expect(spokenDuration(59_600)).toBe('1 minute');
    expect(spokenDuration(119_600)).toBe('2 minutes');
    expect(spokenDuration(131_000)).toBe('2 minutes 11 seconds');
    expect(spokenDuration(3_900_000)).toBe('1 hour 5 minutes');
    expect(spokenDuration(119_600, { live: true })).toBe('1 minute 59 seconds');
  });
});
