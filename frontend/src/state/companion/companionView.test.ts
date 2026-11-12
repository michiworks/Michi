import { describe, expect, it } from 'vitest';
import { companionItem, companionSnapshot } from '../../test/companionFixtures';
import {
  companionAgo,
  companionBriefPostId,
  companionBriefSchedule,
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

describe('when Today says the next brief comes', () => {
  const at = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
  const base = companionSnapshot();
  const schedule = (nextBriefAt: number | null, options: { firstBrief?: boolean; settings?: Partial<typeof base.settings>; now?: number } = {}) => companionBriefSchedule(
    companionSnapshot({ settings: { ...base.settings, ...options.settings }, status: { ...base.status, nextBriefAt } }),
    options.now ?? NOW,
    { firstBrief: options.firstBrief ?? false },
  );

  it('reads the time the backend reports, whatever the brief setting says', () => {
    expect(schedule(at(5, 16, 30), { now: at(5, 8) })).toEqual({ line: 'Your brief arrives at 16:30.', steerLabel: 'Today, focus on…', steerSaved: 'Noted for today’s brief' });
    expect(schedule(at(6, 9)).line).toBe('Next brief: tomorrow at 09:00.');
    expect(schedule(at(6, 9), { firstBrief: true }).line).toBe('Your first brief arrives tomorrow at 09:00.');
    expect(schedule(at(6, 9)).steerLabel).toBe('Tomorrow, focus on…');
    expect(schedule(at(6, 9)).steerSaved).toBe('Noted for tomorrow’s brief');
    // Thursday 14:30 → Monday: the weekday.
    expect(schedule(at(9, 9))).toEqual({ line: 'Next brief: Monday at 09:00.', steerLabel: 'Monday, focus on…', steerSaved: 'Noted for Monday’s brief' });
    expect(schedule(at(9, 9), { firstBrief: true }).line).toBe('Your first brief arrives Monday at 09:00.');
    // A week or more away: the date.
    expect(schedule(at(16, 9)).line).toBe('Next brief: Nov 16 at 09:00.');
  });

  it('never promises a time that has passed: a brief due today is on its way', () => {
    expect(schedule(at(5, 9)).line).toBe('Today’s brief is on its way.');
    expect(schedule(at(5, 9)).steerLabel).toBe('Today, focus on…');
  });

  it('promises nothing without a next brief, and says briefs resume when the agent, by its name, is off or paused', () => {
    expect(schedule(null).line).toBe('No brief is scheduled.');
    expect(schedule(null).steerLabel).toBe('Next brief, focus on…');
    expect(schedule(at(6, 9), { settings: { enabled: false } }).line).toBe('Briefs resume when Michi is on.');
    expect(schedule(null, { settings: { paused: true, displayName: 'Robin' } }).line).toBe('Briefs resume when Robin is resumed.');
    expect(schedule(null, { settings: { paused: true } }).steerSaved).toBe('Noted for the next brief');
  });
});

describe('the post a brief card’s action replies to (D9)', () => {
  const run = (id: string, startedAt: number, finishedAt: number | null, postedMessageId?: string | null) => ({ id, startedAt, finishedAt, postedMessageId });

  it('is the post of the run that was running when the brief was written', () => {
    const brief = { id: 'b1', createdAt: 150 };
    expect(companionBriefPostId(brief, [run('r0', 10, 20, 'cmp-post-r0'), run('r1', 100, 200, 'cmp-post-r1')])).toBe('cmp-post-r1');
    // The run posted nothing (yet): its post id all the same.
    expect(companionBriefPostId(brief, [run('r1', 100, null)])).toBe('cmp-post-r1');
    // No run spans it: the latest that started before it.
    expect(companionBriefPostId(brief, [run('r0', 10, 20), run('r2', 90, 120, 'cmp-post-r2')])).toBe('cmp-post-r2');
    // Nothing in the activity list: still a reply to a post, so the turn starts in Ask.
    expect(companionBriefPostId(brief, [])).toBe('cmp-post-b1');
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
    expect(companionStatusLine(withStatus({ turnsToday: base.settings.dailyTurnBudget }), NOW).text).toBe('Budget used — resumes tomorrow');
    expect(companionStatusLine(withStatus({ working: true }, { paused: true }), NOW).text).toBe('Paused');
    expect(companionStatusLine(withStatus({ working: true }, { enabled: false }), NOW).text).toBe('Off');
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
