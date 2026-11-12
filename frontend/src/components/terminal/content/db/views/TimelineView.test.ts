import { describe, expect, it, vi } from 'vitest';
import { axisLabels, placeSpan, spanOf, timelineAxis } from './TimelineView';
import { localDay } from '../dbModel';

// This year, so the month labels read without a year (`Sep 22`).
const YEAR = new Date().getFullYear();
const NOW = new Date(YEAR, 9, 11, 12).getTime();

describe('axisLabels', () => {
  // Sep 23 → Oct 11, as the QA axis drew it.
  const axis = timelineAxis([{ start: `${YEAR}-09-23`, end: `${YEAR}-10-10` }], NOW);
  const texts = (dayPx: number) => axisLabels(axis.labels, dayPx).map((l) => l?.text ?? null);

  it('gives a month’s first day the room it needs, leaving the next day unlabelled at the narrowest zoom', () => {
    const at22 = texts(22);
    expect(at22.slice(0, 4)).toEqual(['Sep 22', null, '24', '25']);
    const oct1 = axis.labels.findIndex((l) => l.day === `${YEAR}-10-01`);
    expect(at22.slice(oct1 - 1, oct1 + 3)).toEqual(['30', 'Oct 1', null, '3']);
  });

  it('never lets an earlier label take a month start’s room', () => {
    // Drawn from Sep 30: the first day reads as its number so Oct 1 keeps its label.
    const fromSep30 = timelineAxis([{ start: `${YEAR}-10-01`, end: `${YEAR}-10-20` }], NOW);
    expect(fromSep30.labels[0].day).toBe(`${YEAR}-09-30`);
    expect(axisLabels(fromSep30.labels, 22).slice(0, 4).map((l) => l?.text ?? null)).toEqual(['30', 'Oct 1', null, '3']);
    // Narrow days: a day number that would run into Oct 1 goes instead.
    const at8 = axisLabels(axis.labels, 8);
    const oct1 = axis.labels.findIndex((l) => l.day === `${YEAR}-10-01`);
    expect(at8[oct1]?.text).toBe('Oct 1');
  });

  it('labels every day once a day is wide enough', () => {
    expect(texts(48).every((t) => t !== null)).toBe(true);
  });

  it('thins day numbers too when days get narrower than a number', () => {
    const at8 = texts(8);
    // A day number needs ~19px: one label every third day.
    expect(at8.filter(Boolean).length).toBeLessThan(at8.length / 2);
    const shown = axisLabels(axis.labels, 8);
    let free = 0;
    shown.forEach((label, i) => {
      if (!label) return;
      expect(i).toBeGreaterThanOrEqual(free);
      free = i + label.span;
    });
  });
});

describe('timelineAxis in every time zone', () => {
  const zone = (tz: string, run: () => void) => {
    vi.stubEnv('TZ', tz);
    try { run(); } finally { vi.unstubAllEnvs(); }
  };
  const ZONES = ['Pacific/Auckland', 'Pacific/Tongatapu', 'Pacific/Kiritimati', 'UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Etc/GMT+12'];

  it.each(ZONES)('labels the column a day is drawn in with that day (%s)', (tz) => zone(tz, () => {
    const now = new Date(2026, 10, 9, 12).getTime();
    const axis = timelineAxis([{ start: '2026-11-10', end: '2026-11-10' }], now);
    const at = Math.round((placeSpan(axis, { start: '2026-11-10', end: '2026-11-10' })!.left / 100) * axis.days);
    expect(axis.labels[at].day).toBe('2026-11-10');
    expect(axis.labels[axis.today - axis.first].day).toBe(localDay(new Date(now)));
    expect(axis.labels[axis.today - axis.first].day).toBe('2026-11-09');
  }));

  it.each(ZONES)('gives each day of a daylight-saving change its own column (%s)', (tz) => zone(tz, () => {
    const now = new Date(2026, 8, 27, 12).getTime();
    const axis = timelineAxis([{ start: '2026-09-27', end: '2026-09-28' }], now);
    const place = placeSpan(axis, { start: '2026-09-27', end: '2026-09-28' })!;
    expect(Math.round((place.width / 100) * axis.days)).toBe(2);
    expect(new Set(axis.labels.map((l) => l.day)).size).toBe(axis.days);
  }));
});

describe('spanOf', () => {
  it('places no bar for a day that does not exist', () => {
    expect(spanOf('2026-04-31')).toBeNull();
    expect(spanOf({ start: '2026-04-31' })).toBeNull();
    expect(spanOf({ start: '2026-04-29', end: '2026-04-31' })).toBeNull();
    expect(spanOf({ start: '2026-04-29', end: '2026-04-30' })).toEqual({ start: '2026-04-29', end: '2026-04-30' });
  });
});
