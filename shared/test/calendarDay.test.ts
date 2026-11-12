import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dayAt, dayIndex, isCalendarDay, localDayIndex } from '../src/calendarDay';

const ZONES = ['Pacific/Auckland', 'Pacific/Tongatapu', 'Pacific/Kiritimati', 'UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Etc/GMT+12'];

function inZone(tz: string, run: () => void): void {
  const was = process.env.TZ;
  process.env.TZ = tz;
  try { run(); } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
}

describe('calendar days', () => {
  for (const tz of ZONES) {
    test(`index and day round-trip the same way in ${tz}`, () => inZone(tz, () => {
      assert.equal(dayIndex('1970-01-01'), 0);
      assert.equal(dayIndex('2026-11-10'), 20_767);
      for (const day of ['2026-09-26', '2026-09-27', '2026-09-28', '2027-04-03', '2027-04-04', '2024-02-29', '0099-12-31']) {
        assert.equal(dayAt(dayIndex(day)!), day);
      }
      assert.equal(dayIndex('2026-09-28')! - dayIndex('2026-09-27')!, 1);
      assert.equal(localDayIndex(new Date(2026, 10, 9, 23, 59).getTime()), dayIndex('2026-11-09'));
      assert.equal(localDayIndex(new Date(2026, 10, 10, 0, 0).getTime()), dayIndex('2026-11-10'));
    }));
  }

  test('impossible or malformed days are no day', () => {
    for (const value of ['2026-04-31', '2026-02-29', '2026-13-01', '2026-00-10', '2026-1-01', '2026-01-01T00:00', '', null, 20_000]) {
      assert.equal(dayIndex(value), null, String(value));
      assert.equal(isCalendarDay(value), false, String(value));
    }
    assert.equal(isCalendarDay('2024-02-29'), true);
  });
});
