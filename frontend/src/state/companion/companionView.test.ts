import { describe, expect, it } from 'vitest';
import { companionItem, companionSnapshot } from '../../test/companionFixtures';
import {
  companionAgo,
  companionItemTime,
  companionPipelineWatchLine,
  companionSnoozeTimes,
  companionStatusLine,
} from './companionView';

/** Thursday 5 November 2026, 14:30 local time. */
const NOW = new Date(2026, 10, 5, 14, 30).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('when a feed row says the object last moved', () => {
  // Michi first saw everything 10 minutes ago (a baseline): only the facts know how old the objects are.
  const seenAt = NOW - 10 * MINUTE;
  const row = (overrides: Parameters<typeof companionItem>[1]) => companionItemTime(companionItem('i', { changedAt: seenAt, ...overrides }), NOW);

  it('uses the source’s own activity time, not when Michi first saw the item', () => {
    expect(row({ source: 'cr', facts: { lastTouchedAt: NOW - 3 * HOUR } })).toBe('3h ago');
    expect(row({ source: 'email', subtype: 'email_unread', facts: { lastDeliveryAt: NOW - 2 * HOUR } })).toBe('2h ago');
    expect(row({ source: 'michi', subtype: 'michi_waiting', facts: { waitingSince: NOW - 5 * HOUR } })).toBe('5h ago');
    expect(row({ source: 'michi', subtype: 'michi_done', facts: { finishedAt: NOW - 4 * HOUR } })).toBe('4h ago');
  });

  it('shows when a meeting or a conflict starts, as a clock time', () => {
    expect(row({ source: 'calendar', subtype: 'meeting_soon', facts: { start: new Date(2026, 10, 5, 15, 0).getTime() } })).toBe('15:00');
    expect(row({ source: 'calendar', subtype: 'calendar_conflict', facts: { overlapStart: new Date(2026, 10, 5, 9, 5).getTime() } })).toBe('09:05');
    expect(row({ source: 'calendar', subtype: 'meeting_soon', facts: { start: new Date(2026, 10, 6, 0, 10).getTime() } })).toBe('Fri 00:10');
  });

  it('falls back to when the item changed when the source could not read a time', () => {
    expect(row({ source: 'cr', facts: { lastTouchedAt: null } })).toBe('10m ago');
    expect(row({ source: 'email', facts: { lastDeliveryAt: 'yesterday' } })).toBe('10m ago');
    expect(row({ source: 'calendar', subtype: 'meeting_soon', facts: {} })).toBe('10m ago');
    expect(row({ source: 'pipeline', subtype: 'pipeline_blocked', facts: { blockedSince: NOW - 3 * HOUR } })).toBe('10m ago');
    expect(row({ source: 'system', subtype: 'system_auth', facts: {} })).toBe('10m ago');
  });
});

describe('what Settings › Pipelines says is watched', () => {
  it('counts favorites as watched, so it never says "0 watched" while they are', () => {
    expect(companionPipelineWatchLine(true, 0)).toBe('Watching your favorite pipelines');
    expect(companionPipelineWatchLine(true, 2)).toBe('Watching your favorites and 2 pipelines listed here');
    expect(companionPipelineWatchLine(false, 1)).toBe('Watching the 1 pipeline listed here');
    expect(companionPipelineWatchLine(false, 0)).toBe('Not watching any pipelines: list some, or include your favorites');
    for (const named of [0, 1, 5]) expect(companionPipelineWatchLine(true, named)).not.toMatch(/\b0 watched\b/);
  });
});


describe('the Companion header line', () => {
  const base = companionSnapshot();
  const withStatus = (status: Partial<typeof base.status>, settings: Partial<typeof base.settings> = {}) => (
    companionSnapshot({ status: { ...base.status, ...status }, settings: { ...base.settings, ...settings } })
  );

  it('says what the Companion is doing, the strongest state first', () => {
    expect(companionStatusLine(withStatus({ lastCheckAt: NOW - 2 * 60_000 }), NOW)).toEqual({ text: 'Watching · checked 2m ago', tone: 'ok' });
    expect(companionStatusLine(withStatus({ lastCheckAt: NOW - 10_000 }), NOW).text).toBe('Watching · checked just now');
    expect(companionStatusLine(withStatus({ lastCheckAt: null }), NOW).text).toBe('Watching · not checked yet');
    expect(companionStatusLine(withStatus({ state: 'degraded', lastCheckAt: NOW - 60_000 }), NOW).tone).toBe('warn');
    expect(companionStatusLine(withStatus({ working: true }), NOW)).toEqual({ text: 'Working…', tone: 'working' });
    expect(companionStatusLine(withStatus({ state: 'quiet_hours' }), NOW).text).toBe(`Quiet hours until ${base.settings.quietHours.end}`);
    expect(companionStatusLine(withStatus({ auth: { valid: false, expiresAt: null, checkedAt: null } }), NOW).text).toBe('Auth expired — refresh your credentials');
    expect(companionStatusLine(withStatus({ turnsToday: 500, lastCheckAt: null }), NOW).text, 'no daily turn budget').toBe('Watching · not checked yet');
    expect(companionStatusLine(withStatus({ working: true }, { paused: true }), NOW).text).toBe('Off');
    expect(companionStatusLine(withStatus({ state: 'off' }), NOW).text).toBe('Off');
    expect(companionStatusLine(withStatus({}, { paused: true, pausedUntil: NOW + 3_600_000 }), NOW).text).toMatch(/^Paused until (tomorrow )?\d\d:\d\d$/);
  });

  it('words ages for people', () => {
    expect(companionAgo(NOW - 45_000, NOW)).toBe('just now');
    expect(companionAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(companionAgo(NOW - 30 * 3_600_000, NOW)).toBe('yesterday');
  });

  it('snoozes for an hour, or until 9:00 tomorrow in local time', () => {
    const { hour, tomorrow } = companionSnoozeTimes(NOW);
    expect(hour).toBe(NOW + 3_600_000);
    expect(new Date(tomorrow)).toEqual(new Date(2026, 10, 6, 9, 0));
  });
});
