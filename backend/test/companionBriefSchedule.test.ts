/**
 * When the morning brief comes (briefSchedule.ts, B24): the engine's rule for
 * today (isCompanionBriefPending) and the next brief time the status shows
 * (nextCompanionBriefAt): off, paused or brief off has none; off days are
 * skipped; a day that has its brief, or whose welcome came at or after the
 * brief's time, has no other; a brief due but not written yet keeps today's
 * time; before the first welcome, the first brief is the first workday brief
 * time still ahead. Pure functions: no database.
 */

process.env.TZ = 'UTC';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMPANION_SETTINGS, type CompanionSettings } from 'michi-shared';
import { isCompanionBriefPending, nextCompanionBriefAt } from '../src/services/companion/briefSchedule';

/** 2026-11-05 is a Thursday. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const THURSDAY = 5;
const FRIDAY = 6;
const SATURDAY = 7;
const SUNDAY = 8;
const MONDAY = 9;

function settings(patch: (value: CompanionSettings) => void = () => {}): CompanionSettings {
  const value = structuredClone(DEFAULT_COMPANION_SETTINGS);
  patch(value);
  return value;
}

const next = (now: number, welcomeAt: number | null, briefToday = false, value: CompanionSettings = settings()) =>
  nextCompanionBriefAt({ settings: value, now, welcomeAt, briefToday });

describe('the next brief', () => {
  test('none while the Companion is off or paused, or the brief is off', () => {
    const welcomed = at(THURSDAY - 1, 10);
    assert.equal(next(at(THURSDAY, 8), welcomed, false, settings((value) => { value.enabled = false; })), null);
    assert.equal(next(at(THURSDAY, 8), welcomed, false, settings((value) => { value.paused = true; })), null);
    assert.equal(next(at(THURSDAY, 8), welcomed, false, settings((value) => { value.brief.enabled = false; })), null);
  });

  test('today\'s brief still to come keeps today\'s time, also once it has passed (due, not written yet)', () => {
    const welcomed = at(THURSDAY - 1, 10);
    assert.equal(next(at(THURSDAY, 8), welcomed), at(THURSDAY, 9));
    assert.equal(next(at(THURSDAY, 9), welcomed), at(THURSDAY, 9));
    assert.equal(next(at(THURSDAY, 12), welcomed), at(THURSDAY, 9), 'not tomorrow\'s: today\'s still comes');
    assert.equal(next(at(THURSDAY, 12), 0), at(THURSDAY, 9), 'a stored welcome that is no time counts as long done');
  });

  test('a day that has its brief: the next workday\'s, over the weekend', () => {
    const welcomed = at(THURSDAY - 1, 10);
    assert.equal(next(at(THURSDAY, 9, 5), welcomed, true), at(FRIDAY, 9));
    assert.equal(next(at(FRIDAY, 9, 5), welcomed, true), at(MONDAY, 9), 'not Saturday');
  });

  test('off days are skipped: no brief on the weekend, even before its time', () => {
    const welcomed = at(THURSDAY, 8);
    assert.equal(next(at(SATURDAY, 7), welcomed), at(MONDAY, 9));
    assert.equal(next(at(SATURDAY, 12), welcomed), at(MONDAY, 9));
    assert.equal(next(at(SUNDAY, 23, 59), welcomed), at(MONDAY, 9));
    const weekends = settings((value) => { value.workdays = [0, 6]; });
    assert.equal(next(at(THURSDAY, 8), welcomed, false, weekends), at(SATURDAY, 9), 'whatever the workdays are');
    assert.equal(next(at(SATURDAY, 12), welcomed, true, weekends), at(SUNDAY, 9));
  });

  test('the day the welcome came at or after the brief\'s time has no brief: the welcome was that day\'s look', () => {
    assert.equal(next(at(THURSDAY, 10, 31), at(THURSDAY, 10, 30)), at(FRIDAY, 9));
    assert.equal(next(at(THURSDAY, 9, 1), at(THURSDAY, 9)), at(FRIDAY, 9), 'at the brief\'s time exactly');
    assert.equal(next(at(FRIDAY, 14), at(FRIDAY, 13)), at(MONDAY, 9));
    assert.equal(next(at(THURSDAY, 8, 5), at(THURSDAY, 8)), at(THURSDAY, 9), 'a welcome before it: today\'s brief comes');
  });

  test('before the first welcome: the first workday brief time still ahead', () => {
    assert.equal(next(at(THURSDAY, 8), null), at(THURSDAY, 9), 'met now, before 09:00, today has a brief');
    assert.equal(next(at(THURSDAY, 9), null), at(FRIDAY, 9), 'met at 09:00 or later, today\'s look is the welcome');
    assert.equal(next(at(THURSDAY, 12), null), at(FRIDAY, 9));
    assert.equal(next(at(FRIDAY, 12), null), at(MONDAY, 9));
    assert.equal(next(at(SATURDAY, 8), null), at(MONDAY, 9));
    const late = settings((value) => { value.brief.time = '23:30'; });
    assert.equal(next(at(THURSDAY, 22), null, false, late), at(THURSDAY, 23, 30));
  });
});

describe('today\'s brief is pending (the engine\'s rule)', () => {
  const pending = (now: number, welcomeAt: number | null, briefToday = false, value: CompanionSettings = settings()) =>
    isCompanionBriefPending({ settings: value, now, welcomeAt, briefToday });

  test('on, a workday without a brief, and the welcome before today\'s brief time', () => {
    assert.equal(pending(at(THURSDAY, 8), at(THURSDAY - 1, 10)), true, 'before its time too: whether it has come is the caller\'s');
    assert.equal(pending(at(THURSDAY, 12), at(THURSDAY - 1, 10)), true);
    assert.equal(pending(at(THURSDAY, 12), at(THURSDAY - 1, 10), true), false, 'today has one');
    assert.equal(pending(at(THURSDAY, 12), null), false, 'no brief before the first welcome');
    assert.equal(pending(at(THURSDAY, 12), at(THURSDAY, 10)), false, 'met after its time');
    assert.equal(pending(at(SATURDAY, 12), at(THURSDAY, 10)), false, 'an off day');
    assert.equal(pending(at(THURSDAY, 12), at(THURSDAY - 1, 10), false, settings((value) => { value.brief.enabled = false; })), false);
  });

  test('after the welcome, the next brief is today\'s exactly when today\'s is pending', () => {
    const welcomes = [0, at(THURSDAY - 1, 10), at(THURSDAY, 8), at(THURSDAY, 9), at(THURSDAY, 11)];
    for (const hour of [6, 9, 12, 21]) {
      const now = at(THURSDAY, hour);
      for (const welcomeAt of welcomes.filter((time) => time <= now)) {
        for (const briefToday of [false, true]) {
          const what = JSON.stringify({ hour, welcomeAt, briefToday });
          assert.equal(next(now, welcomeAt, briefToday) === at(THURSDAY, 9), pending(now, welcomeAt, briefToday), what);
          if (!pending(now, welcomeAt, briefToday)) assert.equal(next(now, welcomeAt, briefToday), at(FRIDAY, 9), what);
        }
      }
    }
  });
});
