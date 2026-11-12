import { describe, it, expect } from 'vitest';
import { michiStateLabel, formatDateValue, formatDay, formatMichiAge, formatMichiAgo, formatDigestAge, formatMichiClock } from './michiFormat';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('michiStateLabel', () => {
  it('names every state in English', () => {
    expect(michiStateLabel('waiting')).toBe('Waiting on you');
    expect(michiStateLabel('doing')).toBe('In progress');
    expect(michiStateLabel('stalled')).toBe('Stalled');
    expect(michiStateLabel('done')).toBe('Done');
    expect(michiStateLabel('done', 'user')).toBe('Done');
    expect(michiStateLabel('done', 'agent')).toBe('Agent says done');
    expect(michiStateLabel('idea')).toBe('Chatted only');
  });
});

describe('formatMichiAge', () => {
  it('returns an empty string without a timestamp', () => {
    expect(formatMichiAge(null, NOW)).toBe('');
  });

  it('formats the unit boundaries', () => {
    expect(formatMichiAge(NOW - 59 * SEC, NOW)).toBe('now');
    expect(formatMichiAge(NOW - 61 * SEC, NOW)).toBe('1m');
    expect(formatMichiAge(NOW - 40 * MIN, NOW)).toBe('40m');
    expect(formatMichiAge(NOW - 3 * HOUR, NOW)).toBe('3h');
    expect(formatMichiAge(NOW - 2 * DAY, NOW)).toBe('2d');
    expect(formatMichiAge(NOW - 6 * DAY, NOW)).toBe('6d');
    expect(formatMichiAge(NOW - 15 * DAY, NOW)).toBe('2w');
  });

  it('treats a future timestamp as now', () => {
    expect(formatMichiAge(NOW + 5 * MIN, NOW)).toBe('now');
  });
});

describe('formatMichiAgo', () => {
  it('reads formatMichiAge as a time in the past, never "now ago"', () => {
    expect(formatMichiAgo(null, NOW)).toBe('');
    expect(formatMichiAgo(undefined, NOW)).toBe('');
    expect(formatMichiAgo(NOW - 45 * SEC, NOW)).toBe('just now');
    expect(formatMichiAgo(NOW - 40 * MIN, NOW)).toBe('40m ago');
    expect(formatMichiAgo(NOW - 15 * DAY, NOW)).toBe('2w ago');
  });
});

describe('formatDigestAge', () => {
  it('counts days past a day and reads a missing time as a dash', () => {
    expect(formatDigestAge(0, NOW)).toBe('—');
    expect(formatDigestAge(NOW - 45 * SEC, NOW)).toBe('just now');
    expect(formatDigestAge(NOW - 61 * SEC, NOW)).toBe('1m ago');
    expect(formatDigestAge(NOW - 23 * HOUR, NOW)).toBe('23h ago');
    expect(formatDigestAge(NOW - 15 * DAY, NOW)).toBe('15d ago');
    expect(formatDigestAge(NOW + 5 * MIN, NOW)).toBe('just now');
  });
});

describe('formatMichiClock', () => {
  it('formats a month, day and 24-hour time', () => {
    const at = new Date(2026, 9, 16, 21, 40).getTime();
    expect(formatMichiClock(at)).toBe('Oct 16, 21:40');
  });

  it('pads the hour past midnight', () => {
    const at = new Date(2026, 0, 3, 0, 5).getTime();
    expect(formatMichiClock(at)).toBe('Jan 3, 00:05');
  });
});

describe('dates', () => {
  it('writes days and ranges short', () => {
    const now = new Date(2026, 9, 21);
    expect(formatDateValue({ start: '2026-10-25', end: '2026-10-27' }, now)).toBe('Oct 25 → 27');
    expect(formatDateValue({ start: '2026-10-30', end: '2026-11-02' }, now)).toBe('Oct 30 → Nov 2');
    expect(formatDateValue({ start: '2025-01-03' }, now)).toBe('Jan 3, 2025');
  });
});

describe('formatDay', () => {
  it('shows a day that does not exist as written', () => {
    expect(formatDay('2026-04-31', new Date(2026, 3, 1))).toBe('2026-04-31');
    expect(formatDay('2026-04-30', new Date(2026, 3, 1))).toBe('Apr 30');
  });
});
