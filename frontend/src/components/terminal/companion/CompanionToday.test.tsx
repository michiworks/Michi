import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionCheckinChangeDto, CompanionReminderDto, CompanionRunDto } from 'michi-shared';
import { CompanionApiError } from '../../../services/api/companion';
import { getCompanionPanelState, openCompanionPanel, resetCompanionPanelForTests } from '../../../state/companion/companionPanel';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { companionItem, companionSnapshot } from '../../../test/companionFixtures';
import { CompanionToday } from './CompanionToday';

const mocks = vi.hoisted(() => ({
  seen: vi.fn(),
  act: vi.fn(),
  check: vi.fn(),
  addReminder: vi.fn(),
  setReminder: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('../../../state/companion/companionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/companion/companionStore')>()),
  markCompanionItemsSeen: mocks.seen,
  actOnCompanionItem: mocks.act,
}));
vi.mock('../../../services/api/companion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/companion')>()),
  checkCompanionNow: mocks.check,
  addCompanionReminder: mocks.addReminder,
  setCompanionReminderStatus: mocks.setReminder,
}));

/** Two things waiting on the user, and two Michi only read. */
const items = [
  companionItem('a', { title: 'CR-1 needs attention', summary: '2 comments · Add the retry', facts: { cr: 'CR-1', threadsAwaitingYou: 2 } }),
  companionItem('b', {
    title: 'Pipeline Checkout is blocked', source: 'pipeline', subtype: 'pipeline_blocked', status: 'seen',
    facts: { pipeline: 'Checkout', failing: true, failingProd: true },
  }),
  companionItem('c', {
    title: 'Email from Yuka', summary: 'Quarterly planning — 3 unread', source: 'email', subtype: 'email_unread',
    bucket: 'update', severity: 'digest',
  }),
  companionItem('d', { title: 'Standup in 10 minutes', source: 'calendar', subtype: 'meeting_soon', bucket: 'fyi', severity: 'digest' }),
];

const CR_ROW = 'CR-1 has 2 comments waiting for your reply';

function today(overrides: Parameters<typeof companionSnapshot>[0] = {}, props: Partial<React.ComponentProps<typeof CompanionToday>> = {}) {
  const handlers = { onOpenItem: vi.fn(), onAsk: vi.fn(), onOpenSettings: vi.fn() };
  const view = render(<CompanionToday snapshot={companionSnapshot({ items, ...overrides })} arrivals={{}} {...handlers} {...props} />);
  return { ...handlers, view };
}

/** A check-in that ran, as Activity keeps it. */
function run(overrides: Partial<CompanionRunDto> = {}): CompanionRunDto {
  return { id: 'cmr-1', kind: 'heartbeat', trigger: 'schedule', outcome: 'spoke', detail: null, startedAt: Date.now() - 600_000, finishedAt: Date.now() - 590_000, ...overrides };
}

let hasFocus: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetCompanionPanelForTests();
  hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  for (const mock of [mocks.seen, mocks.act, mocks.check, mocks.addReminder, mocks.setReminder, mocks.toast, mocks.toast.error]) mock.mockReset();
});
afterEach(() => hasFocus.mockRestore());

describe('the Today tab', () => {
  it('counts what waits on the user and is those rows: the header can never disagree with them', () => {
    today();
    expect(screen.getByRole('heading', { name: '2 things waiting on you' })).toBeTruthy();
    const waiting = screen.getByRole('region', { name: 'Waiting on you' });
    expect(within(waiting).getByText('Checkout failed in production')).toBeTruthy();
    expect(within(waiting).getByText(CR_ROW)).toBeTruthy();
    // Nothing is waiting behind a fold here: the two rows are the two things.
    expect(within(waiting).queryByRole('button', { name: /more waiting on you/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Today’s brief' })).toBeNull();
  });

  it('says it plainly when nothing waits', () => {
    today({ items: [] });
    expect(screen.getByRole('heading', { name: 'Nothing is waiting on you' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Waiting on you' })).toBeNull();
  });

  it('folds the user’s own work and the rest away, and every folded row keeps its step', () => {
    const { onOpenItem } = today({
      items: [...items, companionItem('e', { subtype: 'cr_approved', bucket: 'update', title: 'CR-7 is approved', summary: 'approved by Yuka · Add the retry', facts: { cr: 'CR-7' } })],
    });
    const mine = screen.getByRole('region', { name: 'On your plate' });
    const fold = within(mine).getByRole('button', { name: /approved and not merged/ });
    expect(fold.textContent).toContain('1 of your CRs is approved and not merged');
    expect(within(mine).queryByRole('button', { name: /^Merge it/ })).toBeNull();
    fireEvent.click(fold);
    fireEvent.click(within(mine).getByRole('button', { name: 'Merge it: CR-7' }));
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'e' }));

    const aside = screen.getByRole('region', { name: 'Everything else' });
    expect(screen.queryByText('Standup in 10 minutes')).toBeNull();
    fireEvent.click(within(aside).getByRole('button', { name: /Tucked away/ }));
    expect(within(aside).getByText('Standup in 10 minutes')).toBeTruthy();
    expect(within(aside).getByText('Yuka')).toBeTruthy();
    fireEvent.click(within(aside).getByRole('button', { name: /Tucked away/ }));
    expect(screen.queryByText('Standup in 10 minutes')).toBeNull();
  });

  it('keeps only three rows open and folds the rest as the same rows', () => {
    today({
      items: [
        ...items,
        companionItem('w', { source: 'michi', subtype: 'michi_waiting', title: 'Fix the flaky test', facts: { wait: 'question' } }),
        companionItem('r', { subtype: 'cr_review_requested', title: 'Review requested: CR-9', severity: 'digest', facts: { cr: 'CR-9', idleWorkdays: 2 } }),
      ],
    });
    const waiting = screen.getByRole('region', { name: 'Waiting on you' });
    expect(screen.getByRole('heading', { name: '4 things waiting on you' })).toBeTruthy();
    expect(within(waiting).queryByText('CR-9 is waiting for your review')).toBeNull();
    const spill = within(waiting).getByRole('button', { name: /more waiting on you/ });
    expect(spill.textContent).toContain('1 more waiting on you');
    expect(spill.textContent).toContain('1 row');
    fireEvent.click(spill);
    // The folded row is the same row, with the same step.
    expect(within(waiting).getByText('CR-9 is waiting for your review')).toBeTruthy();
    expect(within(waiting).getByRole('button', { name: 'Review it: CR-9 is waiting for your review' })).toBeTruthy();
  });

  it('marks seen the new items it has on screen, not the ones still folded away', () => {
    const { view } = today();
    expect(mocks.seen).toHaveBeenCalledTimes(1);
    expect(mocks.seen).toHaveBeenCalledWith(['a']);
    fireEvent.click(screen.getByRole('button', { name: /Tucked away/ }));
    expect(mocks.seen).toHaveBeenLastCalledWith(['a', 'c', 'd']);
    // Marked seen: the dot stays for this visit.
    view.rerender(<CompanionToday snapshot={companionSnapshot({ items: items.map((entry) => ({ ...entry, status: 'seen' as const })) })}
      arrivals={{}} onOpenItem={vi.fn()} onAsk={vi.fn()} onOpenSettings={vi.fn()} />);
    const row = document.querySelector('[data-item-id="a"]')!;
    expect(within(row as HTMLElement).getByLabelText('New')).toBeTruthy();
    expect(document.querySelector('[data-item-id="b"] [aria-label="New"]')).toBeNull();
  });

  it('leaves new items new while the window is in the background', () => {
    hasFocus.mockReturnValue(false);
    today();
    expect(mocks.seen).not.toHaveBeenCalled();
  });

  it('brings the item a notice is about into view, opening the fold it sits in, and highlights it briefly', async () => {
    vi.useFakeTimers();
    // jsdom has no scrollIntoView: record which rows were brought into view.
    const scrolled: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push((this as HTMLElement).dataset.itemId ?? '');
    };
    try {
      today();
      act(() => openCompanionPanel({ tab: 'today', focusItem: 'd' }));
      const row = document.querySelector('[data-item-id="d"]')!;
      expect(row).toBeTruthy();
      expect(screen.getByRole('button', { name: /Tucked away/ }).getAttribute('aria-expanded')).toBe('true');
      expect(row.hasAttribute('data-focused')).toBe(true);
      expect(scrolled).toEqual(['d']);
      // Taken once: coming back to Today later does not jump to it again.
      expect(getCompanionPanelState().focusItem).toBeNull();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(document.querySelector('[data-item-id="d"]')!.hasAttribute('data-focused')).toBe(false);
      // Asked again: highlighted again.
      act(() => openCompanionPanel({ tab: 'today', focusItem: 'd' }));
      expect(document.querySelector('[data-item-id="d"]')!.hasAttribute('data-focused')).toBe(true);
      expect(scrolled).toEqual(['d', 'd']);
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor);
      else delete (Element.prototype as Partial<Element>).scrollIntoView;
      vi.useRealTimers();
    }
  });

  it('opens just Today for an item that is no longer open', () => {
    today();
    act(() => openCompanionPanel({ tab: 'today', focusItem: 'gone' }));
    expect(screen.getByRole('button', { name: /Tucked away/ }).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-focused]')).toBeNull();
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today', focusItem: null });
  });

  it('says how fresh the rows are: the last check, and when a check-in last really looked', async () => {
    mocks.check.mockRejectedValueOnce(new CompanionApiError(409, 'not the owner', { code: 'not_owner' }));
    const looked = new Date();
    looked.setHours(9, 5, 0, 0);
    const { onOpenSettings } = today({ activity: [run({ finishedAt: looked.getTime() })] });
    const activity = screen.getByLabelText('Activity');
    expect(activity.textContent).toContain('Not checked yet');
    expect(activity.textContent).toContain('Michi looked at 09:05');
    expect(activity.textContent).not.toContain('turns today');
    fireEvent.click(within(activity).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Another Michi window is doing the checking'));
    fireEvent.click(within(activity).getByRole('button', { name: 'Activity & settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('says nothing about looking when no check-in has looked yet', () => {
    today({ activity: [run({ outcome: 'error', detail: null, finishedAt: null })] });
    expect(screen.getByLabelText('Activity').textContent).not.toContain('looked at');
  });
});

describe('what Michi can’t do, above everything else', () => {
  const auth = companionItem('mw', { source: 'system', subtype: 'system_auth', bucket: 'needs_you', title: 'Auth session expired', target: null });

  it('says which sources a dead Auth hides, and checks again once the user refreshed credentials', async () => {
    mocks.check.mockResolvedValueOnce(undefined);
    today({ items: [...items, auth] });
    const health = screen.getByLabelText('What Michi can’t do');
    expect(health.textContent).toContain('Auth expired, so Michi can’t see your CRs, pipelines, mail and calendar. Refresh your credentials, then check again.');
    fireEvent.click(within(health).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Checking now'));
    expect(mocks.check).toHaveBeenCalledWith(undefined);
  });

  it('names only the sources the user kept on', () => {
    const base = companionSnapshot().settings;
    today({ items: [auth], settings: { ...base, sources: { ...base.sources, email: { ...base.sources.email, enabled: false }, calendar: { ...base.sources.calendar, enabled: false } } } });
    expect(screen.getByLabelText('What Michi can’t do').textContent).toContain('can’t see your CRs and pipelines');
  });

  it('retries the one source that failed', async () => {
    mocks.check.mockResolvedValueOnce(undefined);
    today({ items: [companionItem('se', { source: 'system', subtype: 'system_source_error', title: 'Couldn’t check your CRs', summary: 'The request timed out.', facts: { source: 'cr', error: 'timeout', failures: 2 }, target: null })] });
    const health = screen.getByLabelText('What Michi can’t do');
    expect(health.textContent).toContain('Michi can’t check your CRs right now: it took too long.');
    fireEvent.click(within(health).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledWith(['cr']));
  });

  it('says when it could not think, so the rows below are not read as its judgement', () => {
    const started = new Date();
    started.setHours(8, 30, 0, 0);
    const { onOpenSettings } = today({
      items,
      activity: [
        run({ id: 'cmr-2', outcome: 'error', detail: 'Claude needs a login. Run claude login.', startedAt: started.getTime() + 3_600_000, finishedAt: started.getTime() + 3_601_000 }),
        run({ id: 'cmr-1', outcome: 'error', detail: 'Claude needs a login.', startedAt: started.getTime(), finishedAt: started.getTime() + 1_000 }),
      ],
    });
    const health = screen.getByLabelText('What Michi can’t do');
    expect(health.textContent).toContain('Michi hasn’t been able to think since 08:30 — at least 2 check-ins failed: Claude needs a login. What follows is ranked by rule, not chosen by Michi.');
    fireEvent.click(within(health).getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('says nothing when Michi can see and think', () => {
    today({ activity: [run()] });
    expect(screen.queryByLabelText('What Michi can’t do')).toBeNull();
  });
});

describe('what a check-in did on Today (DESIGN-v2 §2.7)', () => {
  const change = (overrides: Partial<CompanionCheckinChangeDto>): CompanionCheckinChangeDto => ({
    id: 'crc-1', runId: 'cmr-1', targetKind: 'item', targetId: 'gone', action: 'dismiss', reason: 'merged yesterday',
    title: 'CR-9 needs attention', at: Date.now() - 3_600_000, undoneAt: null, standing: true, snoozedUntil: null, ...overrides,
  });
  const snooze = (overrides: Partial<CompanionCheckinChangeDto>) => change({
    id: 'crc-2', targetId: 'later', action: 'snooze', reason: 'after the meeting', title: 'Pipeline alarm', snoozedUntil: Date.now() + 3_600_000, ...overrides,
  });

  it('lists what it took off Today, by the agent’s name with its reason, and Undo puts it back', async () => {
    mocks.act.mockResolvedValueOnce(companionItem('gone', { title: 'CR-9 needs attention', status: 'seen' }));
    today({ checkinChanges: [change({}), snooze({})] });
    const moved = screen.getByRole('region', { name: 'Moved by Michi' });
    const dismissed = moved.querySelector<HTMLElement>('[data-moved-item-id="gone"]')!;
    expect(dismissed.textContent).toContain('CR-9 needs attention');
    expect(dismissed.textContent).toContain('Dismissed by Michi — merged yesterday · Undo');
    expect(moved.querySelector('[data-moved-item-id="later"]')!.textContent).toContain('Snoozed by Michi — after the meeting');
    fireEvent.click(within(dismissed).getByRole('button', { name: 'Undo: CR-9 needs attention' }));
    await waitFor(() => expect(mocks.act).toHaveBeenCalledWith('gone', { action: 'restore' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Put “CR-9 needs attention” back on Today'));
  });

  it('says so when Undo fails', async () => {
    mocks.act.mockRejectedValueOnce(new Error('Item not found'));
    today({ checkinChanges: [change({})] });
    fireEvent.click(screen.getByRole('button', { name: 'Undo: CR-9 needs attention' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Couldn’t put it back: Item not found'));
  });

  it('leaves out what was undone, what is back on Today, what a later change replaced, and what is older than a day', () => {
    today({
      checkinChanges: [
        // Newest first: the restore replaced the earlier dismissal of the same item.
        change({ id: 'crc-new', targetId: 'twice', action: 'restore', at: Date.now() - 60_000 }),
        change({ id: 'crc-old', targetId: 'twice', action: 'dismiss', at: Date.now() - 120_000 }),
        change({ id: 'crc-undone', targetId: 'undone', undoneAt: Date.now() - 1_000 }),
        change({ id: 'crc-back', targetId: 'a', title: 'CR-1 needs attention' }),
        change({ id: 'crc-stale', targetId: 'stale', at: Date.now() - 25 * 3_600_000 }),
        change({ id: 'crc-goal', targetKind: 'goal', targetId: 'g1', action: 'remove' }),
      ],
    });
    expect(screen.queryByRole('region', { name: 'Moved by Michi' })).toBeNull();
  });

  it('says which item on Today it brought back, and why', () => {
    today({ checkinChanges: [change({ targetId: 'a', action: 'restore', reason: 'a new comment came in', title: 'CR-1 needs attention' })] });
    const row = document.querySelector<HTMLElement>('[data-item-id="a"]')!;
    expect(row.textContent).toContain('Brought back by Michi — a new comment came in');
    expect(document.querySelector('[data-item-id="b"]')!.textContent).not.toContain('Brought back');
  });

  describe('credits it only with what still stands (W3-F3-review #1)', () => {
    it('leaves out a snooze that ran out before the user dismissed the item, and a dismissal its source resolved since', () => {
      today({
        checkinChanges: [
          // The backend's Undo-all check: the item is no longer as the change left it.
          snooze({ id: 'crc-woke', targetId: 'woke', standing: false, snoozedUntil: Date.now() - 60_000 }),
          change({ id: 'crc-resolved', targetId: 'resolved', standing: false }),
        ],
      });
      expect(screen.queryByRole('region', { name: 'Moved by Michi' })).toBeNull();
    });

    it('says nothing on an item that is back because the user’s own snooze ran out', () => {
      today({ checkinChanges: [change({ targetId: 'a', action: 'restore', reason: 'a new comment came in', standing: false })] });
      expect(document.querySelector('[data-item-id="a"]')!.textContent).not.toContain('Brought back');
    });

    it('keeps a snooze listed until it ends, past a day, and not after', () => {
      const longAgo = Date.now() - 3 * 24 * 3_600_000;
      today({
        checkinChanges: [
          snooze({ id: 'crc-week', targetId: 'week', title: 'Quarterly review', at: longAgo, snoozedUntil: Date.now() + 4 * 24 * 3_600_000 }),
          snooze({ id: 'crc-over', targetId: 'over', title: 'Old alarm', at: longAgo, snoozedUntil: Date.now() - 60_000 }),
        ],
      });
      const moved = screen.getByRole('region', { name: 'Moved by Michi' });
      expect(moved.querySelector('[data-moved-item-id="week"]')!.textContent).toContain('Snoozed by Michi — after the meeting');
      expect(moved.querySelector('[data-moved-item-id="over"]')).toBeNull();
    });

    it('does not say an Undo worked when the item could not come back: it resolved meanwhile', async () => {
      mocks.act.mockResolvedValueOnce(companionItem('gone', { title: 'CR-9 needs attention', status: 'resolved', resolvedAt: Date.now() }));
      today({ checkinChanges: [change({})] });
      fireEvent.click(screen.getByRole('button', { name: 'Undo: CR-9 needs attention' }));
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('“CR-9 needs attention” is no longer open, so it can’t go back on Today'));
      expect(mocks.toast).not.toHaveBeenCalledWith('Put “CR-9 needs attention” back on Today');
    });

    it('does not say an Undo put it on Today when its source is off', async () => {
      mocks.act.mockResolvedValueOnce(companionItem('gone', { title: 'CR-9 needs attention', status: 'seen' }));
      const base = companionSnapshot().settings;
      today({ checkinChanges: [change({})], settings: { ...base, sources: { ...base.sources, cr: { ...base.sources.cr, enabled: false } } } });
      fireEvent.click(screen.getByRole('button', { name: 'Undo: CR-9 needs attention' }));
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Put “CR-9 needs attention” back, but its source is off in Settings, so Today doesn’t show it'));
      expect(mocks.toast).not.toHaveBeenCalledWith('Put “CR-9 needs attention” back on Today');
    });
  });

  it('uses the name the user gave it', () => {
    resetCompanionStoreForTests({ snapshot: companionSnapshot({ settings: { ...companionSnapshot().settings, displayName: 'Robin' } }) });
    try {
      today({ checkinChanges: [change({})] });
      const moved = screen.getByRole('region', { name: 'Moved by Robin' });
      expect(moved.textContent).toContain('Dismissed by Robin — merged yesterday');
    } finally {
      resetCompanionStoreForTests();
    }
  });
});

describe('reminders on Today', () => {
  const reminder: CompanionReminderDto = {
    id: 'rem-1', kind: 'time', text: 'Send the status mail', at: null, dailyAt: '16:00', itemId: null, until: null,
    status: 'active', createdAt: 1, firedAt: null,
  };

  it('pauses a reminder and adds one for tomorrow morning', async () => {
    mocks.setReminder.mockResolvedValueOnce({ ...reminder, status: 'paused' });
    mocks.addReminder.mockResolvedValueOnce({ ...reminder, id: 'rem-2', text: 'Ping Alex', dailyAt: null, at: 5 });
    today({ reminders: [reminder] });
    const section = screen.getByRole('region', { name: 'Reminders and watches' });
    expect(within(section).getByText('Workdays at 16:00')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Pause: Send the status mail' }));
    await waitFor(() => expect(mocks.setReminder).toHaveBeenCalledWith('rem-1', 'paused'));
    fireEvent.change(within(section).getByRole('textbox', { name: 'Reminder' }), { target: { value: 'Ping Alex' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocks.addReminder).toHaveBeenCalled());
    const [input] = mocks.addReminder.mock.calls[0];
    expect(input.text).toBe('Ping Alex');
    expect(new Date(input.at).getHours()).toBe(9);
  });
});
