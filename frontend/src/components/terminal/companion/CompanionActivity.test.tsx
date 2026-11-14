import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionDelegationDto, CompanionRunDto } from 'michi-shared';
import { getCompanionState, resetCompanionStoreForTests, useCompanion } from '../../../state/companion/companionStore';
import { companionSnapshot } from '../../../test/companionFixtures';
import { CompanionActivity } from './CompanionActivity';

const mocks = vi.hoisted(() => ({ undoRun: vi.fn(), stopAutoSend: vi.fn(), openPanel: vi.fn(), refresh: vi.fn() }));
vi.mock('../../../services/api/companion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/companion')>()),
  undoCompanionRun: mocks.undoRun,
  stopCompanionDelegationAutoSend: mocks.stopAutoSend,
}));
vi.mock('../../../state/companion/companionPanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/companion/companionPanel')>()),
  openCompanionPanel: mocks.openPanel,
}));
vi.mock('../../../state/companion/companionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/companion/companionStore')>()),
  scheduleCompanionRefresh: mocks.refresh,
}));

function run(id: string, patch: Partial<CompanionRunDto> = {}): CompanionRunDto {
  return { id, kind: 'heartbeat', trigger: 'interval', outcome: 'spoke', detail: null, startedAt: Date.UTC(2026, 10, 5, 9, 12), finishedAt: null, ...patch };
}
function delegation(id: string, patch: Partial<CompanionDelegationDto> = {}): CompanionDelegationDto {
  return {
    id, workspaceId: 'ws-1', nodeId: `n-${id}`, title: `Worker ${id}`, state: 'following', origin: 'start_conversation', autoSend: false,
    createdAt: 1, lastSentAt: null, lastReportedAt: null, closedAt: null, closedReason: null, ...patch,
  };
}

/** The sheet as the panel shows it: on the store's snapshot. */
function Sheet() {
  const { snapshot } = useCompanion();
  return <CompanionActivity snapshot={snapshot} name="Robin" />;
}

beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); });
afterEach(() => resetCompanionStoreForTests());

describe('the panel’s Activity (Q31)', () => {
  it('lists what each check-in did and changed, with Undo all, and links a post to the chat', async () => {
    resetCompanionStoreForTests({ snapshot: companionSnapshot({ activity: [
      run('r1', { postedMessageId: 'cmp-post-r1', changes: [
        { kind: 'page', id: 'p1', title: 'Tasks', applied: 3, proposed: 0 },
        { kind: 'item', id: 'i1', applied: 1, proposed: 0, action: 'snooze', reason: 'Later' },
        { kind: 'goal', id: 'g1', applied: 1, proposed: 0, action: 'reword' },
      ] }),
      run('r2', { changes: [{ kind: 'database', id: 'd1', applied: 2, proposed: 1 }], undoneAt: 5 }),
      run('r3', { outcome: 'superseded', detail: '412 characters' }),
      run('r4', { outcome: 'quiet' }),
      // D21: follow-ups it sent itself, which Undo all cannot take back.
      run('r5', { kind: 'worker_report', changes: [
        { kind: 'send', id: 'n-w1', title: 'Fix CI', applied: 1, proposed: 0 },
        { kind: 'send', id: 'n-w1', title: 'Fix CI', applied: 1, proposed: 0 },
        { kind: 'send', id: 'n-w2', applied: 1, proposed: 0 },
      ] }),
      run('r6', { changes: [
        { kind: 'goal', id: 'g2', applied: 1, proposed: 0, action: 'add' },
        { kind: 'send', id: 'n-w1', title: 'Fix CI', applied: 1, proposed: 0 },
      ] }),
    ] }) });
    mocks.undoRun.mockResolvedValueOnce({ reverted: ['c1', 'c2'], conflicts: [{ changeId: 'c3', message: 'Someone edited “Risks” since.' }] });
    render(<Sheet />);
    const rows = within(screen.getByRole('list', { name: 'Recent activity' })).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Check-in · posted · Changed 3 blocks on “Tasks”, snoozed 1 item and reworded 1 goal');
    expect(rows[1]!.textContent).toContain('Changed 2 rows on a database and suggested 1 change on a database · Undone');
    expect(within(rows[1]!).queryByRole('button', { name: 'Undo all' })).toBeNull();
    expect(rows[2]!.textContent).toContain('Check-in · not posted: you wrote first · 412 characters');
    expect(rows[3]!.textContent).toContain('Check-in · nothing to say');
    expect(within(rows[3]!).queryByRole('button')).toBeNull();
    expect(rows[4]!.textContent).toContain('Sent 2 follow-ups to “Fix CI” and sent 1 follow-up to a conversation');
    expect(within(rows[4]!).queryByRole('button', { name: 'Undo all' })).toBeNull();
    expect(rows[5]!.textContent).toContain('Added 1 goal and sent 1 follow-up to “Fix CI”');
    expect(within(rows[5]!).getByRole('button', { name: 'Undo all' })).toBeTruthy();

    // §2.7: View in chat goes to the post itself.
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'View in chat' }));
    expect(mocks.openPanel).toHaveBeenCalledWith({ focusMessageId: 'cmp-post-r1' });
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Undo all' }));
    expect(mocks.undoRun).toHaveBeenCalledWith('r1');
    expect((await within(rows[0]!).findByRole('status')).textContent).toContain('Undid 2 changes; 1 change changed since: Someone edited “Risks” since.');
  });

  it('says so when nothing ran yet, or when the agent’s state is not available', () => {
    resetCompanionStoreForTests({ snapshot: companionSnapshot({ activity: [] }) });
    const view = render(<Sheet />);
    expect(screen.getByText('Nothing yet.')).toBeTruthy();
    view.unmount();
    resetCompanionStoreForTests();
    render(<Sheet />);
    expect(screen.getByRole('status').textContent).toBe('Activity isn’t available right now.');
  });

  it('lists the conversations it follows; Ask before sending can only be turned back on', async () => {
    resetCompanionStoreForTests({ snapshot: companionSnapshot({ delegations: [
      delegation('a', { autoSend: true }), delegation('b'), delegation('c', { state: 'closed', closedReason: 'took_over' }),
    ] }) });
    mocks.stopAutoSend.mockResolvedValueOnce(delegation('a', { autoSend: false }));
    render(<Sheet />);
    const follows = screen.getByRole('region', { name: 'Conversations Robin follows' });
    expect(within(follows).queryByText('Worker c')).toBeNull();
    // The switch is about the user's own follow-ups; check-ins may still send to a conversation that runs in Ask (Q1).
    // Its explanation is behind the heading's "?", not a paragraph.
    const why = 'Check-ins only suggest one, or send it directly to a conversation that runs in Ask, where whatever would leave this machine still asks you first.';
    expect(follows.textContent).not.toContain(why);
    fireEvent.click(within(follows).getByRole('button', { name: 'More about these conversations' }));
    expect(follows.textContent).toContain(why);
    const asked = within(follows).getByRole('switch', { name: 'Ask before sending to Worker b' });
    expect(asked.getAttribute('aria-checked')).toBe('true');
    expect(asked).toHaveProperty('disabled', true);
    const unasked = within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' });
    expect(unasked.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(unasked);
    expect(mocks.stopAutoSend).toHaveBeenCalledWith('a');
    await waitFor(() => expect(within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' }).getAttribute('aria-checked')).toBe('true'));
    expect(within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' })).toHaveProperty('disabled', true);
    expect(getCompanionState().snapshot?.delegations?.find((entry) => entry.id === 'a')?.autoSend).toBe(false);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('shows what the server answered when Ask before sending did not take, and reads again', async () => {
    resetCompanionStoreForTests({ snapshot: companionSnapshot({ delegations: [delegation('a', { autoSend: true })] }) });
    mocks.stopAutoSend.mockResolvedValueOnce(delegation('a', { autoSend: true }));
    render(<Sheet />);
    const follows = screen.getByRole('region', { name: 'Conversations Robin follows' });
    fireEvent.click(within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' }));
    expect((await within(follows).findByRole('alert')).textContent).toBe('Robin still sends here without asking. Try again.');
    const row = within(follows).getByRole('switch', { name: 'Ask before sending to Worker a' });
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(row).toHaveProperty('disabled', false);
    expect(getCompanionState().snapshot?.delegations?.[0]?.autoSend).toBe(true);
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
