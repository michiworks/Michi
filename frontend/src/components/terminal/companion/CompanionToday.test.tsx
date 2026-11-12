import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionBriefDto, CompanionCheckinChangeDto, CompanionReminderDto } from 'michi-shared';
import { CompanionApiError } from '../../../services/api/companion';
import { getCompanionPanelState, openCompanionPanel, resetCompanionPanelForTests } from '../../../state/companion/companionPanel';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { companionItem, companionSnapshot } from '../../../test/companionFixtures';
import { CompanionToday } from './CompanionToday';

const mocks = vi.hoisted(() => ({
  seen: vi.fn(),
  act: vi.fn(),
  check: vi.fn(),
  curate: vi.fn(),
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
  curateCompanionBrief: mocks.curate,
  addCompanionReminder: mocks.addReminder,
  setCompanionReminderStatus: mocks.setReminder,
}));

const items = [
  companionItem('a', { title: 'CR-1 needs attention' }),
  companionItem('b', { title: 'Pipeline blocked', source: 'pipeline', subtype: 'pipeline_blocked', status: 'seen' }),
  companionItem('c', { title: 'Quarterly planning', source: 'email', subtype: 'email_unread', bucket: 'update', severity: 'digest' }),
  companionItem('d', { title: 'Standup in 10 minutes', source: 'calendar', subtype: 'meeting_soon', bucket: 'fyi', severity: 'digest' }),
];

function today(overrides: Parameters<typeof companionSnapshot>[0] = {}, props: Partial<React.ComponentProps<typeof CompanionToday>> = {}) {
  const handlers = { onOpenItem: vi.fn(), onAsk: vi.fn(), onAction: vi.fn(), onOpenSettings: vi.fn() };
  const view = render(<CompanionToday snapshot={companionSnapshot({ items, ...overrides })} catchUp={null} arrivals={{}} {...handlers} {...props} />);
  return { ...handlers, view };
}

let hasFocus: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetCompanionPanelForTests();
  hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  for (const mock of [mocks.seen, mocks.act, mocks.check, mocks.curate, mocks.addReminder, mocks.setReminder, mocks.toast, mocks.toast.error]) mock.mockReset();
});
afterEach(() => hasFocus.mockRestore());

describe('the Today tab', () => {
  it('lists what needs the user, with the other groups behind View all', () => {
    today();
    const needsYou = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needsYou).getByText('CR-1 needs attention')).toBeTruthy();
    expect(within(needsYou).getByText('Pipeline blocked')).toBeTruthy();
    expect(screen.queryByText('Quarterly planning')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View all (2)' }));
    expect(within(screen.getByRole('region', { name: 'Updates' })).getByText('Quarterly planning')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'FYI' })).getByText('Standup in 10 minutes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText('Quarterly planning')).toBeNull();
  });

  it('says when nothing needs the user', () => {
    today({ items: [] });
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /View all/ })).toBeNull();
  });

  it('marks the new items on screen seen while the window has focus, and they keep their New dot', () => {
    const { view } = today();
    expect(mocks.seen).toHaveBeenCalledTimes(1);
    expect(mocks.seen).toHaveBeenCalledWith(['a']);
    // Marked seen: the dot stays for this visit.
    view.rerender(<CompanionToday snapshot={companionSnapshot({ items: items.map((entry) => ({ ...entry, status: 'seen' as const })) })}
      catchUp={null} arrivals={{}} onOpenItem={vi.fn()} onAsk={vi.fn()} onAction={vi.fn()} onOpenSettings={vi.fn()} />);
    const row = document.querySelector('[data-item-id="a"]')!;
    expect(within(row as HTMLElement).getByLabelText('New')).toBeTruthy();
    expect(document.querySelector('[data-item-id="b"] [aria-label="New"]')).toBeNull();
  });

  it('leaves new items new while the window is in the background', () => {
    hasFocus.mockReturnValue(false);
    today();
    expect(mocks.seen).not.toHaveBeenCalled();
  });

  it('brings the item a notice is about into view, past View all, and highlights it briefly', async () => {
    vi.useFakeTimers();
    // jsdom has no scrollIntoView: record which rows were brought into view.
    const scrolled: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push((this as HTMLElement).dataset.itemId ?? '');
    };
    try {
      today();
      act(() => openCompanionPanel({ tab: 'today', focusItem: 'c' }));
      const row = document.querySelector('[data-item-id="c"]')!;
      expect(row).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
      expect(row.hasAttribute('data-focused')).toBe(true);
      expect(scrolled).toEqual(['c']);
      // Taken once: coming back to Today later does not jump to it again.
      expect(getCompanionPanelState().focusItem).toBeNull();
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(document.querySelector('[data-item-id="c"]')!.hasAttribute('data-focused')).toBe(false);
      // Asked again: highlighted again.
      act(() => openCompanionPanel({ tab: 'today', focusItem: 'c' }));
      expect(document.querySelector('[data-item-id="c"]')!.hasAttribute('data-focused')).toBe(true);
      expect(scrolled).toEqual(['c', 'c']);
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor);
      else delete (Element.prototype as Partial<Element>).scrollIntoView;
      vi.useRealTimers();
    }
  });

  it('opens just Today for an item that is no longer open', () => {
    today();
    act(() => openCompanionPanel({ tab: 'today', focusItem: 'gone' }));
    expect(screen.getByRole('button', { name: 'View all (2)' }).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-focused]')).toBeNull();
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today', focusItem: null });
  });

  it('shows Since you left and the activity line; Check now names another window that does the checking', async () => {
    mocks.check.mockRejectedValueOnce(new CompanionApiError(409, 'not the owner', { code: 'not_owner' }));
    const { onOpenSettings } = today({}, { catchUp: { awaySince: 1, returnedAt: 2, changedItemIds: ['a'], line: '3 updates, 1 needs you.' } });
    expect(screen.getByText(/3 updates, 1 needs you\./).textContent).toContain('Since you left');
    const activity = screen.getByLabelText('Activity');
    expect(activity.textContent).toContain('Not checked yet');
    expect(activity.textContent).toContain('0 of 30 turns today');
    fireEvent.click(within(activity).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Another Michi window is doing the checking'));
    fireEvent.click(within(activity).getByRole('button', { name: 'Activity & settings' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});

describe('the brief on Today', () => {
  const brief: CompanionBriefDto = {
    id: 'brf-1', date: '2026-11-05', headline: 'Two things need you before lunch', origin: 'llm', createdAt: 1, cardFeedback: {},
    closing: 'That’s all for today.',
    cards: [
      { title: 'Answer the review comments', body: 'Two comments on revision 3.', itemIds: ['a'], action: { label: 'Draft replies', prompt: 'Draft replies to the CR-1 comments.' } },
      { title: 'Planning mail', body: 'Can wait until tomorrow.', itemIds: [], action: null },
    ],
  };

  it('shows its cards with the items they are about, and a card’s follow-up goes to the chat', () => {
    const { onOpenItem, onAction } = today({ brief });
    const section = screen.getByRole('region', { name: 'Today’s brief' });
    expect(within(section).getByText('Two things need you before lunch')).toBeTruthy();
    expect(within(section).getByText('That’s all for today.')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'CR-1 needs attention' }));
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Draft replies' }));
    expect(onAction).toHaveBeenCalledWith('Draft replies to the CR-1 comments.');
    expect(within(section).getByRole('button', { name: 'Helpful: Planning mail' })).toBeTruthy();
  });

  /** The status as the backend reports it, with the next brief at `nextBriefAt`. */
  const status = (nextBriefAt: number | null) => ({ ...companionSnapshot().status, nextBriefAt });
  const tomorrowAt = (hours: number) => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(hours, 0, 0, 0);
    return date.getTime();
  };

  it('notes what to focus on tomorrow', async () => {
    mocks.curate.mockResolvedValueOnce(undefined);
    today({ brief, status: status(tomorrowAt(9)) });
    fireEvent.change(screen.getByRole('textbox', { name: 'Tomorrow, focus on' }), { target: { value: 'the launch review' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Today’s brief' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Noted for tomorrow’s brief'));
    expect(mocks.curate).toHaveBeenCalledWith('the launch review');
  });

  describe('before there is one', () => {
    // The store remembers whether a brief ever reached this machine.
    beforeEach(() => resetCompanionStoreForTests());
    afterEach(() => {
      localStorage.removeItem('michi:companion:brief-seen');
      resetCompanionStoreForTests();
    });

    it('says when the next one arrives, as the backend reports it, and the user can steer it already', async () => {
      mocks.curate.mockResolvedValueOnce(undefined);
      today({ status: status(tomorrowAt(9)) });
      const section = screen.getByRole('region', { name: 'Today’s brief' });
      // Never had a brief on this machine: the first one.
      expect(within(section).getByText('Your first brief arrives tomorrow at 09:00.')).toBeTruthy();
      expect(within(section).queryByText(/arrives at/)).toBeNull();
      fireEvent.change(within(section).getByRole('textbox', { name: 'Tomorrow, focus on' }), { target: { value: 'the launch' } });
      fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(mocks.curate).toHaveBeenCalledWith('the launch'));
    });

    it('calls it the next brief once a brief has reached this machine', () => {
      localStorage.setItem('michi:companion:brief-seen', '1');
      today({ status: status(tomorrowAt(9)) });
      expect(screen.getByText('Next brief: tomorrow at 09:00.')).toBeTruthy();
    });

    it('promises no brief while the Companion is paused or no brief is scheduled', () => {
      const base = companionSnapshot().settings;
      const { view } = today({ settings: { ...base, displayName: 'Robin', paused: true }, status: { ...status(null), state: 'paused' } });
      // Under the agent's name (§1.5).
      expect(screen.getByText('Briefs resume when Robin is resumed.')).toBeTruthy();
      expect(screen.queryByText(/arrives/)).toBeNull();
      view.unmount();
      today({ status: status(null) });
      expect(screen.getByText('No brief is scheduled.')).toBeTruthy();
      expect(screen.getByRole('textbox', { name: 'Next brief, focus on' })).toBeTruthy();
    });

    it('shows nothing when the user turned briefs off', () => {
      const base = companionSnapshot().settings;
      today({ settings: { ...base, brief: { ...base.brief, enabled: false } }, status: status(tomorrowAt(9)) });
      expect(screen.queryByRole('region', { name: 'Today’s brief' })).toBeNull();
    });
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
