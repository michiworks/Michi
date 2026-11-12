import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { companionItem, companionSnapshot } from '../../../test/companionFixtures';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { CompanionItemRow } from './CompanionItemRow';

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
const item = companionItem('cmi-1', { title: 'CR-1 needs attention', summary: '2 unresolved comments', changedAt: NOW - 5 * 60_000 });

function row(overrides: Partial<React.ComponentProps<typeof CompanionItemRow>> = {}) {
  const props = { item, clock: NOW, onOpen: vi.fn(), onAsk: vi.fn(), ...overrides };
  render(<CompanionItemRow {...props} />);
  return props;
}

beforeEach(() => {
  mocks.act.mockReset().mockImplementation(async (id: string) => ({ ...item, id }));
  mocks.toast.mockReset();
  mocks.toast.error.mockReset();
});

describe('a Companion feed item', () => {
  it('says what it is, how old and what changed, and opens it or asks about it', () => {
    const props = row({ showNew: true });
    expect(screen.getByText('CR-1 needs attention')).toBeTruthy();
    expect(screen.getByText('2 unresolved comments')).toBeTruthy();
    expect(screen.getByText('5m ago')).toBeTruthy();
    expect(screen.getByLabelText('New')).toBeTruthy();
    expect(screen.getByLabelText('Code review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open: CR-1 needs attention' }));
    expect(props.onOpen).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole('button', { name: 'Ask about: CR-1 needs attention' }));
    expect(props.onAsk).toHaveBeenCalledWith(item);
  });

  it('says how long ago the object itself moved, not when Michi first saw it', () => {
    // A baseline item: Michi saw it a minute ago; the CR was last touched two hours ago.
    row({ item: { ...item, changedAt: NOW - 60_000, facts: { lastTouchedAt: NOW - 2 * 3_600_000 } } });
    expect(screen.getByText('2h ago')).toBeTruthy();
    expect(screen.queryByText('1m ago')).toBeNull();
  });

  it('shows when a meeting starts', () => {
    const start = new Date(NOW);
    start.setMinutes(start.getMinutes() + 10, 0, 0);
    const clock = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    row({ item: companionItem('m', { source: 'calendar', subtype: 'meeting_soon', title: 'Meeting in 10 min: Standup', changedAt: NOW - 60_000, facts: { start: start.getTime() } }) });
    expect(screen.getByText(clock)).toBeTruthy();
  });

  it('says a check-in brought it back, with its reason as plain text (DESIGN-v2 §2.7)', () => {
    row({ checkinChange: { action: 'restore', reason: 'a new comment\u202E came in', standing: true } });
    const line = document.querySelector<HTMLElement>('.companion-row__by')!;
    expect(line.textContent).toBe('Brought back by Michi — a new comment⟨hidden character⟩ came in');
    expect(screen.getByTitle('Not shown on screen: U+202E')).toBeTruthy();
  });

  it('says nothing for another change a check-in made, or none', () => {
    row({ checkinChange: { action: 'snooze', reason: 'later', standing: true } });
    expect(document.querySelector('.companion-row__by')).toBeNull();
  });

  it('says nothing for a restore that no longer stands: the item is back for another reason (W3-F3-review #1)', () => {
    row({ checkinChange: { action: 'restore', reason: 'a new comment came in', standing: false } });
    expect(document.querySelector('.companion-row__by')).toBeNull();
  });

  it('has no Open without somewhere to go', () => {
    row({ item: { ...item, target: null } });
    expect(screen.queryByRole('button', { name: /^Open:/ })).toBeNull();
  });

  it('snoozes for an hour, says so, and Undo restores it', async () => {
    row();
    fireEvent.click(screen.getByRole('button', { name: 'Snooze: CR-1 needs attention' }));
    const before = Date.now();
    fireEvent.click(screen.getByRole('menuitem', { name: 'For 1 hour' }));
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
    row();
    fireEvent.click(screen.getByRole('button', { name: 'Done: CR-1 needs attention' }));
    expect(mocks.act).toHaveBeenCalledWith('cmi-1', { action: 'dismiss' });
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Couldn’t update “CR-1 needs attention”: Item not found'));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('asks why it was not helpful, and can stop showing it', async () => {
    row();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for CR-1 needs attention' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Not helpful…' }));
    const reasons = await screen.findByRole('menu', { name: 'Why wasn’t it helpful?' });
    expect(reasons.textContent).toContain('Already handled');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Too noisy' }));
    expect(mocks.act).toHaveBeenCalledWith('cmi-1', { action: 'feedback', feedback: 'down', reason: 'too_noisy' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'More actions for CR-1 needs attention' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'More actions for CR-1 needs attention' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Don’t show this again' }));
    expect(mocks.act).toHaveBeenLastCalledWith('cmi-1', { action: 'mute' });
  });

  it('names the agent, never “the Companion”: its own items’ source and the thanks for feedback (§1.5)', async () => {
    resetCompanionStoreForTests({ snapshot: companionSnapshot({ settings: { ...companionSnapshot().settings, displayName: 'Robin' } }) });
    try {
      row({ item: companionItem('sys-1', { source: 'system', subtype: 'reminder_due', title: 'Reminder: call Sam', changedAt: NOW }) });
      expect(screen.getByLabelText('Robin')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Reminder: call Sam' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Not helpful…' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Too noisy' }));
      await waitFor(() => expect(mocks.toast.mock.calls.at(-1)?.[0]).toBe('Thanks — Robin will take that into account'));
    } finally {
      resetCompanionStoreForTests();
    }
  });
});
