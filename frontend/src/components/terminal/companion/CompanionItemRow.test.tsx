import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionItemDto } from 'michi-shared';
import { companionItem, companionSnapshot } from '../../../test/companionFixtures';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { companionSnoozeTimes } from '../../../state/companion/companionView';
import { companionTodayView, type CompanionTodayEntry } from '../../../state/companion/companionToday';
import { CompanionItemLine, CompanionItemRow, type CompanionRestored } from './CompanionItemRow';

const mocks = vi.hoisted(() => ({
  act: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('../../../state/companion/companionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/companion/companionStore')>()),
  actOnCompanionItem: mocks.act,
}));

const NOW = 10_000_000;

/** What Today would draw for these items, so a row is tested as the panel builds it. */
function entries(items: CompanionItemDto[]) {
  const snapshot = companionSnapshot({ items });
  return companionTodayView({ items: snapshot.items, settings: snapshot.settings, activity: [] }, NOW);
}

const cr = companionItem('cmi-1', {
  title: 'CR-1 needs attention', summary: '2 unresolved comments', changedAt: NOW - 5 * 60_000,
  facts: { cr: 'CR-1', threadsAwaitingYou: 2 },
});
const CR_ROW = 'CR-1 has 2 comments waiting for your reply';

function waitingEntry(items: CompanionItemDto[] = [cr]): CompanionTodayEntry {
  return entries(items).waiting.rows[0];
}

/** What the check-ins did to the first item, as Today hands it to a row. */
function restore(change: { action: 'restore' | 'snooze'; reason: string; standing: boolean }, id = 'cmi-1'): CompanionRestored {
  return new Map([[id, change]]);
}

/** The fold state Today owns, so a group's summary line really opens its members. */
function Host({ children }: { children(open: Set<string>, toggle: (key: string) => void): React.ReactNode }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  return <>{children(open, toggle)}</>;
}

function row(entry: CompanionTodayEntry, overrides: Partial<React.ComponentProps<typeof CompanionItemRow>> = {}) {
  const props = { entry, clock: NOW, onOpen: vi.fn(), onAsk: vi.fn(), ...overrides };
  render(<Host>{(open, toggle) => <CompanionItemRow {...props} open={props.open ?? open} onToggle={props.onToggle ?? toggle} />}</Host>);
  return props;
}

function line(entry: CompanionTodayEntry, overrides: Partial<React.ComponentProps<typeof CompanionItemLine>> = {}) {
  const props = { entry, clock: NOW, onOpen: vi.fn(), ...overrides };
  render(<Host>{(open, toggle) => <CompanionItemLine {...props} open={props.open ?? open} onToggle={props.onToggle ?? toggle} />}</Host>);
  return props;
}

beforeEach(() => {
  mocks.act.mockReset().mockImplementation(async (id: string) => ({ ...cr, id }));
  mocks.toast.mockReset();
  mocks.toast.error.mockReset();
});

describe('one row of Waiting on you', () => {
  it('says what waits, since when and where it is from, and opens it or asks about it', () => {
    const props = row(waitingEntry(), { showNew: true });
    expect(screen.getByText(CR_ROW)).toBeTruthy();
    expect(screen.getByText('2 unresolved comments')).toBeTruthy();
    expect(screen.getByText('5m ago')).toBeTruthy();
    expect(screen.getByLabelText('New')).toBeTruthy();
    expect(screen.getByLabelText('Code review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Open the CR: ${CR_ROW}` }));
    expect(props.onOpen).toHaveBeenCalledWith(cr);
    fireEvent.click(screen.getByRole('button', { name: `Ask about: ${CR_ROW}` }));
    expect(props.onAsk).toHaveBeenCalledWith(cr);
  });

  it('says how long ago the object itself moved, not when Michi first saw it', () => {
    // Michi saw it a minute ago; the CR was last touched two hours ago.
    row(waitingEntry([{ ...cr, changedAt: NOW - 60_000, facts: { ...cr.facts, lastTouchedAt: NOW - 2 * 3_600_000 } }]));
    expect(screen.getByText('2h ago')).toBeTruthy();
    expect(screen.queryByText('1m ago')).toBeNull();
  });

  it('offers the one step the kind of row allows: a reminder is finished here, not opened', async () => {
    row(waitingEntry([companionItem('rem', { source: 'system', subtype: 'reminder_due', title: 'Ask Casey about the launch', changedAt: NOW })]));
    fireEvent.click(screen.getByRole('button', { name: 'Done: Ask Casey about the launch' }));
    expect(mocks.act).toHaveBeenCalledWith('rem', { action: 'dismiss' });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Marked done', expect.anything()));
  });

  it('says a check-in brought it back, with its reason as plain text (DESIGN-v2 §2.7)', () => {
    row(waitingEntry(), { restored: restore({ action: 'restore', reason: 'a new comment\u202E came in', standing: true }) });
    const by = document.querySelector<HTMLElement>('.companion-row__by')!;
    expect(by.textContent).toBe('Brought back by Michi — a new comment⟨hidden character⟩ came in');
    expect(screen.getByTitle('Not shown on screen: U+202E')).toBeTruthy();
  });

  it('says nothing for another change a check-in made, or none', () => {
    row(waitingEntry(), { restored: restore({ action: 'snooze', reason: 'later', standing: true }) });
    expect(document.querySelector('.companion-row__by')).toBeNull();
  });

  it('says nothing for a restore that no longer stands: the item is back for another reason (W3-F3-review #1)', () => {
    row(waitingEntry(), { restored: restore({ action: 'restore', reason: 'a new comment came in', standing: false }) });
    expect(document.querySelector('.companion-row__by')).toBeNull();
  });

  it('has no step without somewhere to go, and still lets the user ask', () => {
    row(waitingEntry([{ ...cr, target: null }]));
    expect(screen.queryByRole('button', { name: /^Open the CR:/ })).toBeNull();
    expect(screen.getByRole('button', { name: `Ask about: ${CR_ROW}` })).toBeTruthy();
  });

  it('snoozes for an hour, says so, and Undo restores it', async () => {
    row(waitingEntry());
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${CR_ROW}` }));
    const before = Date.now();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Snooze for 1 hour' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    const [id, action] = mocks.act.mock.calls[0];
    expect(id).toBe('cmi-1');
    expect(action.action).toBe('snooze');
    expect(action.until).toBeGreaterThanOrEqual(before + 3_600_000 - 1_000);
    const [text, options] = mocks.toast.mock.calls[0];
    expect(text).toBe('Snoozed for an hour');
    options.action.onClick();
    expect(mocks.act).toHaveBeenLastCalledWith('cmi-1', { action: 'restore' });
  });

  it('marks it done, and says why when the backend refuses', async () => {
    mocks.act.mockRejectedValueOnce(new Error('Item not found'));
    row(waitingEntry());
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${CR_ROW}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Done' }));
    expect(mocks.act).toHaveBeenCalledWith('cmi-1', { action: 'dismiss' });
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(`Couldn’t update “${CR_ROW}”: Item not found`));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('marks it done on a swipe right and snoozes it until tomorrow on a swipe left', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect);
    try {
      row(waitingEntry());
      const target = screen.getByText(CR_ROW);
      const swipe = (xs: number[]) => {
        fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: xs[0], clientY: 100 }] });
        for (const x of xs.slice(1)) fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: x, clientY: 100 }] });
        fireEvent.touchEnd(target, { touches: [] });
      };
      swipe([100, 120, 250]);
      await waitFor(() => expect(mocks.act).toHaveBeenCalledWith('cmi-1', { action: 'dismiss' }));
      // Still listed here, so it slides back in before the next swipe.
      await waitFor(() => expect(target.closest<HTMLElement>('.companion-row')!.dataset.swipe).toBeUndefined());

      swipe([250, 230, 100]);
      await waitFor(() => expect(mocks.act).toHaveBeenCalledTimes(2));
      expect(mocks.act).toHaveBeenLastCalledWith('cmi-1', { action: 'snooze', until: companionSnoozeTimes(Date.now()).tomorrow });
      await waitFor(() => expect(mocks.toast).toHaveBeenLastCalledWith('Snoozed until tomorrow', expect.anything()));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('asks why it was not helpful, and can stop showing it', async () => {
    row(waitingEntry());
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${CR_ROW}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Not helpful…' }));
    const reasons = await screen.findByRole('menu', { name: 'Why wasn’t it helpful?' });
    expect(reasons.textContent).toContain('Already handled');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Too noisy' }));
    expect(mocks.act).toHaveBeenCalledWith('cmi-1', { action: 'feedback', feedback: 'down', reason: 'too_noisy' });
    await waitFor(() => expect(screen.getByRole('button', { name: `More actions for ${CR_ROW}` }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${CR_ROW}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Don’t show this again' }));
    expect(mocks.act).toHaveBeenLastCalledWith('cmi-1', { action: 'mute' });
  });

  it('names the agent, never “the Companion”: its own items’ source and the thanks for feedback (§1.5)', async () => {
    resetCompanionStoreForTests({ snapshot: companionSnapshot({ settings: { ...companionSnapshot().settings, displayName: 'Robin' } }) });
    try {
      row(waitingEntry([companionItem('sys-1', { source: 'system', subtype: 'reminder_due', title: 'Reminder: call Sam', changedAt: NOW })]));
      expect(screen.getByTitle('Robin')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Reminder: call Sam' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Not helpful…' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Too noisy' }));
      await waitFor(() => expect(mocks.toast.mock.calls.at(-1)?.[0]).toBe('Thanks — Robin will take that into account'));
    } finally {
      resetCompanionStoreForTests();
    }
  });
});

describe('several items of one kind in one row', () => {
  const reviews = [
    companionItem('r1', { subtype: 'cr_review_requested', title: 'Review requested: CR-1', changedAt: NOW - 30 * 60_000, facts: { cr: 'CR-1', idleWorkdays: 1 } }),
    companionItem('r2', { subtype: 'cr_review_stale', title: 'CR-2 has waited', changedAt: NOW - 90 * 60_000, facts: { cr: 'CR-2', idleWorkdays: 4 } }),
  ];
  const GROUP = '2 of other people’s CRs wait for your review';

  it('reads as one row whose summary line opens the items behind it', () => {
    row(waitingEntry(reviews));
    expect(screen.getByText(GROUP)).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'CR-2, CR-1', expanded: false });
    expect(screen.queryByText('CR-2 is waiting for your review')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('CR-2 is waiting for your review')).toBeTruthy();
    expect(screen.getByText('CR-1 is waiting for your review')).toBeTruthy();
  });

  it('starts with the oldest, and acts on every item at once', async () => {
    const props = row(waitingEntry(reviews));
    fireEvent.click(screen.getByRole('button', { name: `Start with the oldest: ${GROUP}` }));
    expect(props.onOpen).toHaveBeenCalledWith(reviews[1]);

    fireEvent.click(screen.getByRole('button', { name: `More actions for ${GROUP}` }));
    expect(screen.queryByRole('menuitem', { name: 'Snooze for 1 hour' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark all done (2)' }));
    expect(mocks.act).toHaveBeenCalledWith('r1', { action: 'dismiss' });
    expect(mocks.act).toHaveBeenCalledWith('r2', { action: 'dismiss' });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Marked 2 done', expect.anything()));
    const [, options] = mocks.toast.mock.calls[0];
    options.action.onClick();
    expect(mocks.act).toHaveBeenCalledWith('r1', { action: 'restore' });
    expect(mocks.act).toHaveBeenCalledWith('r2', { action: 'restore' });
  });

  it('says on the item’s own row that a check-in brought it back, not on the row that counts them', () => {
    row(waitingEntry(reviews), { restored: restore({ action: 'restore', reason: 'a new comment came in', standing: true }, 'r2') });
    expect(document.querySelector('.companion-row__by')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'CR-2, CR-1', expanded: false }));
    const member = document.querySelector<HTMLElement>('[data-item-id="r2"]')!;
    expect(member.textContent).toContain('Brought back by Michi — a new comment came in');
    expect(document.querySelector<HTMLElement>('[data-item-id="r1"]')!.textContent).not.toContain('Brought back');
  });

  it('never clears several on one flick: a swipe acts on a single item only', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect);
    try {
      row(waitingEntry(reviews));
      const target = screen.getByText(GROUP);
      fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
      fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: 250, clientY: 100 }] });
      fireEvent.touchEnd(target, { touches: [] });
      await waitFor(() => expect(mocks.act).not.toHaveBeenCalled());
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('a folded line of On your plate or Everything else', () => {
  it('shows what it is, when it last moved and the same step in less weight', () => {
    const approved = companionItem('a1', { subtype: 'cr_approved', bucket: 'update', title: 'CR-7 is approved', summary: 'approved by Yuka · Add the retry', changedAt: NOW - 3 * 3_600_000, facts: { cr: 'CR-7' } });
    const props = line(entries([approved]).mine.folds[0].entries[0]);
    expect(screen.getByText('CR-7')).toBeTruthy();
    expect(screen.getByText('Add the retry')).toBeTruthy();
    expect(screen.getByText('3h ago')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge it: CR-7' }));
    expect(props.onOpen).toHaveBeenCalledWith(approved);
  });

  it('shows when a meeting starts', () => {
    const start = new Date(NOW);
    start.setMinutes(start.getMinutes() + 10, 0, 0);
    const clock = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    const meeting = companionItem('m', { source: 'calendar', subtype: 'meeting_soon', bucket: 'update', title: 'Meeting in 10 min: Standup', changedAt: NOW - 60_000, facts: { start: start.getTime() } });
    line(entries([meeting]).aside.entries[0]);
    expect(screen.getByText(clock)).toBeTruthy();
  });

  it('opens a sender’s mail in place, and clears it all in one step', async () => {
    const mail = [
      companionItem('m1', { source: 'email', subtype: 'email_unread', bucket: 'update', title: 'Email from Yuka', summary: 'Launch date — 2 unread', changedAt: NOW - 20 * 60_000 }),
      companionItem('m2', { source: 'email', subtype: 'email_unread', bucket: 'update', title: 'Email from Yuka', summary: 'Rollback plan — 2 unread', changedAt: NOW - 40 * 60_000 }),
    ];
    line(entries(mail).aside.entries[0]);
    expect(screen.getByText('Yuka')).toBeTruthy();
    expect(screen.getByText('2 mails')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rollback plan, Launch date', expanded: false }));
    expect(screen.getByText('Launch date')).toBeTruthy();
    expect(screen.getByText('Rollback plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear them all: Yuka' }));
    await waitFor(() => expect(mocks.act).toHaveBeenCalledWith('m1', { action: 'dismiss' }));
    expect(mocks.act).toHaveBeenCalledWith('m2', { action: 'dismiss' });
  });
});
