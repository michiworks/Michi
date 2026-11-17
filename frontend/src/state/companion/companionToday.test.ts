import { describe, expect, it } from 'vitest';
import { companionRaiseUntil, type CompanionItemDto } from 'michi-shared';
import {
  COMPANION_TODAY_ROWS,
  companionTodayHeadline,
  companionTodayPlace,
  companionTodayView,
  type CompanionTodayInput,
} from './companionToday';
import { companionItem, companionSnapshot } from '../../test/companionFixtures';

const NOW = Date.UTC(2026, 10, 16, 10, 0, 0);
const minutes = (count: number) => count * 60_000;
/** A check-in's raise given at `at`, holding until the local midnight after it. */
const raise = (reason: string, at = NOW) => ({ reason, at, until: companionRaiseUntil(at) });

function view(items: CompanionItemDto[] = [], overrides: Partial<CompanionTodayInput> = {}) {
  const snapshot = companionSnapshot({ items });
  return companionTodayView({ items: snapshot.items, settings: snapshot.settings, activity: [], ...overrides }, NOW);
}

describe('where Today puts what Michi watches', () => {
  it('keeps a kind this window does not know out of sight, like a muted one', () => {
    // Every subtype it knows has a place: PLACE is a Record<CompanionItemSubtype, …>,
    // so a new one in shared/ fails the typecheck instead of vanishing silently here.
    expect(companionTodayPlace(companionItem('x', { subtype: 'something_newer' as never }), NOW)).toBeNull();
    const { waiting, mine, aside, health } = view([companionItem('x', { subtype: 'something_newer' as never })]);
    expect([waiting.count, mine.count, aside.count, health.length]).toEqual([0, 0, 0, 0]);
  });

  it('ranks what blocks someone first, whatever source it came from', () => {
    const { waiting } = view([
      companionItem('review', { subtype: 'cr_review_requested', bucket: 'needs_you', severity: 'digest', title: 'Review requested: CR-9', facts: { cr: 'CR-9', idleWorkdays: 2 } }),
      companionItem('clash', { source: 'calendar', subtype: 'calendar_conflict', bucket: 'needs_you', severity: 'now', title: 'Calendar conflict at 11:00' }),
      companionItem('prod', { source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', severity: 'now', title: 'Pipeline Checkout is blocked', facts: { pipeline: 'Checkout', failing: true, failingProd: true } }),
      companionItem('answer', { source: 'michi', subtype: 'michi_waiting', bucket: 'needs_you', severity: 'digest', title: 'Fix the flaky test', facts: { wait: 'question' } }),
    ]);
    expect(waiting.rows.map((row) => row.title)).toEqual([
      'Checkout failed in production',
      'Two meetings clash at 11:00',
      'Fix the flaky test',
    ]);
    // The fourth kind folds, as a row of its own.
    expect(waiting.spill.map((row) => row.title)).toEqual(['CR-9 is waiting for your review']);
    expect(waiting.count).toBe(4);
    expect(waiting.spillCount).toBe(1);
    expect(waiting.rows.length).toBe(COMPANION_TODAY_ROWS);
  });

  it('reads one row for several items of a kind, with its members behind it', () => {
    const { waiting } = view([
      companionItem('r1', { subtype: 'cr_review_requested', bucket: 'needs_you', title: 'Review requested: CR-1', changedAt: NOW - minutes(30), facts: { cr: 'CR-1', idleWorkdays: 1 } }),
      companionItem('r2', { subtype: 'cr_review_stale', bucket: 'stalled', title: 'CR-2 has waited 4 workdays for your review', changedAt: NOW - minutes(90), facts: { cr: 'CR-2', idleWorkdays: 4 } }),
    ]);
    const [row] = waiting.rows;
    expect(row.title).toBe('2 of other people’s CRs wait for your review');
    expect(row.summary).toBe('CR-2, CR-1');
    expect(row.meta).toBe('1–4 workdays');
    expect(row.action).toMatchObject({ kind: 'open', label: 'Start with the oldest' });
    // The oldest is first, so the step and the list agree.
    expect(row.action?.kind === 'open' && row.action.item.id).toBe('r2');
    expect(row.members?.map((member) => member.title)).toEqual(['CR-2 is waiting for your review', 'CR-1 is waiting for your review']);
  });

  it('marks a row that interrupts, and gives a reminder Done instead of somewhere to go', () => {
    const { waiting } = view([
      companionItem('rem', { source: 'system', subtype: 'reminder_due', bucket: 'needs_you', severity: 'now', title: 'Ask Casey about the launch', target: { kind: 'companion', tab: 'today' } }),
    ]);
    expect(waiting.rows[0].now).toBe(true);
    expect(waiting.rows[0].action).toEqual({ kind: 'done', label: 'Done' });
  });

  it('separates a pipeline that waits for an approval from one that failed, newest first at the same rank', () => {
    const { waiting } = view([
      companionItem('a', { source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', severity: 'digest', title: 'Pipeline Pay is waiting for manual approval', changedAt: NOW - minutes(60), facts: { pipeline: 'Pay', approvalsWaiting: true, failing: false } }),
      companionItem('b', { source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', severity: 'digest', title: 'Pipeline Ship is blocked', changedAt: NOW - minutes(5), facts: { pipeline: 'Ship', failing: true } }),
    ]);
    expect(waiting.rows.map((row) => [row.title, row.action?.label])).toEqual([
      ['Ship is stuck', 'See the failure'],
      ['Pay waits for a manual approval', 'Go approve'],
    ]);
  });

  it('calls a pipeline failure a production failure only when the facts say so', () => {
    const { waiting } = view([
      // The backend calls a disabled pipeline urgent as well: that is not a production failure.
      companionItem('off', { source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', severity: 'now', title: 'Pipeline Pay is blocked', changedAt: NOW - minutes(5), facts: { pipeline: 'Pay', disabled: true, failing: false } }),
      companionItem('prod', { source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', severity: 'now', title: 'Pipeline Ship is blocked', changedAt: NOW - minutes(60), facts: { pipeline: 'Ship', failing: true, failingProd: true } }),
    ]);
    expect(waiting.rows.map((row) => [row.title, row.action?.label, row.now])).toEqual([
      ['Pay is disabled', 'Open the pipeline', true],
      ['Ship failed in production', 'See the failure', true],
    ]);
  });

  it('puts the user’s own work on their plate, folded, each line with its own step', () => {
    const { mine, waiting } = view([
      companionItem('ap', { subtype: 'cr_approved', bucket: 'update', severity: 'now', title: 'CR-5 is approved', summary: 'Approved and not merged yet · Trim the planner', changedAt: NOW - minutes(120), facts: { cr: 'CR-5' } }),
      companionItem('st', { source: 'michi', subtype: 'michi_stalled', bucket: 'stalled', title: 'Old plan', summary: 'Waiting on you for 5 days · asked about the rate', facts: { waitingDays: 5 } }),
    ]);
    expect(waiting.count).toBe(0);
    expect(mine.count).toBe(2);
    expect(mine.folds.map((fold) => [fold.summary, fold.meta])).toEqual([
      ['1 of your CRs is approved and not merged', '2h ago'],
      ['1 conversation you haven’t answered', '5 days'],
    ]);
    expect(mine.folds[0].entries[0]).toMatchObject({ title: 'CR-5', summary: 'Trim the planner', action: { label: 'Merge it' } });
    expect(mine.folds[1].entries[0]).toMatchObject({ action: { label: 'Back to it' } });
  });

  it('groups mail by sender, leaves one-offs together, and keeps every row actionable', () => {
    const mail = (id: string, sender: string, topic: string) => companionItem(id, {
      source: 'email', subtype: 'email_unread', bucket: 'update', severity: 'digest',
      title: `Email from ${sender}`, summary: `${topic} — a line of preview`, changedAt: NOW - minutes(10),
      target: { kind: 'url', url: 'https://outlook.office.com' },
    });
    const { aside } = view([
      mail('m1', 'AWS Notifications', 'Fargate retirement'),
      mail('m2', 'AWS Notifications', 'ECS task retirement'),
      mail('m3', 'Morgan, Alex', 'Gentle reminder'),
      mail('m4', 'Lee, Casey', 'Launch check'),
    ]);
    expect(aside.count).toBe(4);
    expect(aside.entries.map((entry) => [entry.title, entry.meta, entry.action?.label])).toEqual([
      ['AWS Notifications', '2 mails', 'Clear them all'],
      ['2 mails, one from each sender', '2 mails', 'Clear them all'],
    ]);
    expect(aside.entries[0].members?.map((member) => member.title)).toEqual(['Fargate retirement', 'ECS task retirement']);
    expect(aside.entries[1].members?.every((member) => member.action?.label === 'Open the mail')).toBe(true);
  });

  const mail = (overrides: Partial<CompanionItemDto> = {}) => companionItem('m', {
    source: 'email', subtype: 'email_unread', bucket: 'update', severity: 'digest',
    title: 'Email from Morgan, Alex', summary: 'Gentle reminder — the deadline is today',
    target: { kind: 'url', url: 'https://outlook.office.com' }, ...overrides,
  });

  it('keeps mail out of what waits until a check-in raised it with a reason', () => {
    expect(view([mail()]).waiting.count).toBe(0);
    const raised = view([mail({ raised: raise('The deadline is today', NOW - minutes(5)) })]);
    expect(raised.waiting.rows.map((row) => [row.title, row.summary, row.action?.label])).toEqual([
      ['Gentle reminder', 'Michi raised this — The deadline is today', 'Open the mail'],
    ]);
    expect(raised.aside.count).toBe(0);
  });

  it('raises any kind, in its own words, and never pushes a blocked thing down', () => {
    const { waiting } = view([
      mail({ raised: raise('The deadline is today') }),
      companionItem('merged', {
        subtype: 'cr_merged', bucket: 'fyi', severity: 'silent', title: 'CR-7 merged', summary: 'Checkout · Fix the retry',
        facts: { cr: 'CR-7' }, raised: raise('It changed the file you are editing'),
      }),
      companionItem('prod', {
        source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', severity: 'now', title: 'Pipeline Checkout is blocked',
        facts: { pipeline: 'Checkout', failing: true, failingProd: true },
      }),
    ]);
    expect(waiting.rows.map((row) => row.title)).toEqual(['Checkout failed in production', '2 things Michi raised']);
    expect(waiting.rows[1].summary).toBe('Gentle reminder, CR-7');
    expect(waiting.rows[1].members?.map((member) => member.summary)).toEqual([
      'Michi raised this — The deadline is today',
      'Michi raised this — It changed the file you are editing',
    ]);
    expect(waiting.count).toBe(3);
  });

  it('keeps a raised item that already waits in its own row, and lets it climb with its reason', () => {
    const prod = (id: string, pipeline: string, overrides: Partial<CompanionItemDto> = {}) => companionItem(id, {
      source: 'pipeline', subtype: 'pipeline_blocked', bucket: 'needs_you', severity: 'now', title: `Pipeline ${pipeline} is blocked`,
      facts: { pipeline, failing: true, failingProd: true }, ...overrides,
    });
    const { waiting } = view([
      prod('checkout', 'Checkout'),
      prod('payments', 'Payments', { raised: raise('Your release train leaves at 15:00') }),
      companionItem('clash', { source: 'calendar', subtype: 'calendar_conflict', bucket: 'needs_you', severity: 'digest', title: 'Calendar conflict at 16:00' }),
      companionItem('review', {
        subtype: 'cr_review_requested', bucket: 'needs_you', severity: 'digest', title: 'Review requested: CR-9', facts: { cr: 'CR-9' },
        raised: raise('Alex is blocked on it before the freeze'),
      }),
    ]);
    // The raised production failure shares its kind's row; the raised review climbs over a later clash (8 to 5, over 7).
    expect(waiting.rows.map((row) => [row.kind, row.title])).toEqual([
      ['pipeline-prod', '2 pipelines failed in production'],
      ['cr-review', 'CR-9 is waiting for your review'],
      ['conflict', 'Two meetings clash at 16:00'],
    ]);
    expect(waiting.rows[0].members?.map((member) => member.summary)).toEqual([expect.not.stringContaining('raised this'), 'Michi raised this — Your release train leaves at 15:00']);
    expect(waiting.rows[1].summary).toBe('Michi raised this — Alex is blocked on it before the freeze');
  });

  it('lets a raise go at the local midnight after it: yesterday\u2019s reason is not today\u2019s', () => {
    const yesterday = NOW - 24 * minutes(60);
    const stale = mail({ raised: raise('The deadline is today', yesterday) });
    expect(companionTodayPlace(stale, NOW)?.place).toBe('aside');
    expect(companionTodayPlace(stale, yesterday)?.place).toBe('waiting');
    const { waiting, aside } = view([stale]);
    expect([waiting.count, aside.count]).toEqual([0, 1]);
  });

  it('never raises Michi\u2019s own trouble: a health line stays a health line', () => {
    const { health, waiting } = view([companionItem('mw', {
      source: 'system', subtype: 'system_auth', bucket: 'needs_you', severity: 'now', title: 'Auth session expired',
      target: { kind: 'settings' }, raised: raise('Nothing can be checked'),
    })]);
    expect(health.map((line) => line.key)).toEqual(['auth']);
    expect(waiting.count).toBe(0);
  });

  it('counts the header from the rows themselves, so the two cannot disagree', () => {
    expect(companionTodayHeadline(0)).toBe('Nothing is waiting on you');
    expect(companionTodayHeadline(1)).toBe('1 thing waiting on you');
    expect(companionTodayHeadline(4)).toBe('4 things waiting on you');
  });
});

describe('what Today says when Michi cannot see or cannot think', () => {
  const auth = companionItem('mw', { source: 'system', subtype: 'system_auth', bucket: 'needs_you', severity: 'now', title: 'Auth session expired', target: { kind: 'settings' } });
  const trouble = (id: string, source: string, title: string, summary: string, error = 'error') => companionItem(id, {
    source: 'system', subtype: 'system_source_error', bucket: 'fyi', severity: 'silent', title, summary, facts: { source, error },
  });
  const run = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, kind: 'heartbeat' as const, trigger: 'schedule', outcome: 'error' as const, detail: 'The check-in’s session could not open: Kiro is not signed in. Run kiro-cli login, then try again.',
    startedAt: NOW - minutes(20), finishedAt: NOW - minutes(19), ...overrides,
  });

  it('names every source Auth blocks, and offers the check that follows refreshing credentials', () => {
    const { health, waiting } = view([auth]);
    expect(waiting.count).toBe(0);
    expect(health).toEqual([{
      key: 'auth',
      text: 'Auth expired, so Michi can’t see your CRs, pipelines, mail and calendar. Refresh your credentials, then check again.',
      remedy: { kind: 'check', label: 'Check again' },
    }]);
  });

  it('leaves out a source the user turned off', () => {
    const snapshot = companionSnapshot({ items: [auth] });
    const settings = { ...snapshot.settings, sources: { ...snapshot.settings.sources, email: { enabled: false }, calendar: { enabled: false } } };
    const { health } = companionTodayView({ items: snapshot.items, settings, activity: [] }, NOW);
    expect(health[0].text).toContain('your CRs and pipelines.');
  });

  it('says since when Michi has not been able to think, and why, with its own line', () => {
    const { health } = view([], { activity: [run('r3'), run('r2', { startedAt: NOW - minutes(80), finishedAt: NOW - minutes(79) }), run('r1', { startedAt: NOW - minutes(140), finishedAt: NOW - minutes(139), outcome: 'quiet' })] });
    expect(health.map((line) => line.key)).toEqual(['cannot-think']);
    expect(health[0].text).toContain('2 check-ins failed');
    expect(health[0].text).toContain('Kiro is not signed in');
    expect(health[0].text).toContain('ranked by rule');
  });

  it('says nothing about thinking once a check-in got through, and reports when Michi last looked', () => {
    const activity = [run('ok', { outcome: 'quiet', detail: 'Quiet: nothing new' }), run('bad', { startedAt: NOW - minutes(90), finishedAt: NOW - minutes(89) })];
    const { health, lastLookAt } = view([], { activity });
    expect(health).toEqual([]);
    expect(lastLookAt).toBe(NOW - minutes(19));
  });

  it('is honest that it can only see its latest runs', () => {
    const { health } = view([], { activity: [run('a'), run('b', { startedAt: NOW - minutes(40), finishedAt: NOW - minutes(39) })] });
    expect(health[0].text).toContain('at least 2 check-ins failed');
  });

  it('offers one retry for one broken source and one for several', () => {
    const one = view([trouble('e1', 'cr', 'Couldn’t check your CRs', 'Outlook took too long', 'timeout')]);
    expect(one.health[0]).toMatchObject({ text: 'Michi can’t check your CRs right now: it took too long.', remedy: { kind: 'check', label: 'Try again', sources: ['cr'] } });
    const many = view([
      trouble('e1', 'cr', 'Couldn’t check your CRs', 'Outlook took too long', 'timeout'),
      trouble('e2', 'calendar', 'Couldn’t check your calendar', 'Outlook reported an error'),
    ]);
    expect(many.health[0].text).toBe('Michi can’t check 2 sources right now: CRs (it took too long), calendar (outlook reported an error).');
    expect(many.health[0].remedy).toMatchObject({ label: 'Try them all', sources: ['cr', 'calendar'] });
  });
});
