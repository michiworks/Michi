import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_COMPANION_SETTINGS, type CompanionGetStartedDto, type CompanionSettings, type SpacesFirstRunStatus } from 'michi-shared';
import { companionSnapshot } from '../../../test/companionFixtures';
import { CompanionGetStarted, workdaysLabel } from './CompanionGetStarted';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  later: vi.fn(),
  memory: vi.fn(),
  adopt: vi.fn(),
  refresh: vi.fn(),
  nav: vi.fn(),
  toastError: vi.fn(),
  firstRun: null as SpacesFirstRunStatus | null,
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: mocks.toastError }) }));
vi.mock('../../../services/api/companion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/companion')>()),
  startCompanionGetStarted: mocks.start,
  postponeCompanionGetStarted: mocks.later,
}));
vi.mock('../../../services/api/memories', () => ({ fetchMemoryExtractionStatus: mocks.memory }));
vi.mock('../../../state/companion/companionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/companion/companionStore')>()),
  adoptCompanionSnapshot: mocks.adopt,
}));
vi.mock('../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/metaAgent/spacesFirstRun')>()),
  refreshSpacesFirstRun: mocks.refresh,
  useSpacesFirstRun: () => ({ data: mocks.firstRun }),
}));
vi.mock('../../../state/appEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/appEvents')>()),
  navPageEvent: { dispatch: mocks.nav },
}));

const OFFER: CompanionGetStartedDto = { state: 'offer', at: null, nodeId: 'companion-node', homes: null, watch: null, homesOn: true, firstRunDays: 30 };

/** A new user's settings: the outside sources off (D17). */
function newUserSettings(): CompanionSettings {
  const settings = structuredClone(DEFAULT_COMPANION_SETTINGS);
  for (const kind of ['michi'] as const) settings.sources[kind].enabled = false;
  return settings;
}

function home(state: 'reading' | 'done', readCount: number) {
  return { workspaceId: 'ws-1', workspaceName: 'Work', homePageId: 'pg-1', hiddenAt: null,
    firstRun: { workspaceId: 'ws-1', state, total: 40, readCount, startSeq: 0, startedAt: 1, updatedAt: 2, error: null } };
}

function status(workspaces: ReturnType<typeof home>[], closed: boolean): SpacesFirstRunStatus {
  return { requestedAt: 1, workspaces, summary: { state: closed ? 'done' : 'waiting', summarizedAt: closed ? 3 : null }, haltedReason: null, closed } as SpacesFirstRunStatus;
}

beforeEach(() => {
  for (const mock of [mocks.start, mocks.later, mocks.memory, mocks.adopt, mocks.refresh, mocks.nav, mocks.toastError]) mock.mockReset();
  // Automatic memory as a new install has it: off until Settings › Memory turns it on.
  mocks.memory.mockResolvedValue({ enabled: true, paused: true, lastRunAt: null, lastError: null, todayTokens: 0, dailyTokenLimit: null });
  mocks.start.mockResolvedValue(companionSnapshot());
  mocks.later.mockResolvedValue(companionSnapshot());
  mocks.firstRun = null;
});

describe('CompanionGetStarted', () => {
  it('offers the card with the outside sources unticked; Start sends what it shows, and nothing runs before it', async () => {
    render(<CompanionGetStarted getStarted={OFFER} settings={newUserSettings()} name="Michi" />);
    expect(screen.getByText(/I’m Michi\./)).toBeTruthy();
    const homes = screen.getByRole('checkbox', { name: /Keep workspace homes up to date \(reads the last 30 days\)/ }) as HTMLInputElement;
    const watch = screen.getByRole('checkbox', { name: 'Watch: Michi conversations' }) as HTMLInputElement;
    expect([homes.checked, watch.checked]).toEqual([true, false]);
    expect(screen.getByText('Morning brief: Weekdays 09:00')).toBeTruthy();
    expect(await screen.findByText(/Learn from conversations: Off/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /memory/i })).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.adopt).toHaveBeenCalled());
    // Watch left unticked leaves the sources as they are.
    expect(mocks.start).toHaveBeenCalledWith({ homes: true });
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('ticked Watch turns the sources on, unticked from all on turns them off; Not now puts it off', async () => {
    const view = render(<CompanionGetStarted getStarted={OFFER} settings={newUserSettings()} name="Michi" />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Watch:/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep workspace homes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ homes: false, watch: true }));
    view.unmount();

    render(<CompanionGetStarted getStarted={OFFER} settings={structuredClone(DEFAULT_COMPANION_SETTINGS)} name="Michi" />);
    const watch = screen.getByRole('checkbox', { name: /Watch:/ }) as HTMLInputElement;
    expect(watch.checked).toBe(true);
    fireEvent.click(watch);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.start).toHaveBeenLastCalledWith({ homes: true, watch: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(mocks.later).toHaveBeenCalledTimes(1));
  });

  it('put off: one line that opens the card again', () => {
    render(<CompanionGetStarted getStarted={{ ...OFFER, state: 'later', at: 5 }} settings={newUserSettings()} name="Michi" />);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(mocks.later).not.toHaveBeenCalled();
  });

  it('after Start the same card shows the first run, then "Workspace homes are ready · Open Pages"', () => {
    const started: CompanionGetStartedDto = { ...OFFER, state: 'started', at: 5, homes: true, watch: null };
    mocks.firstRun = status([home('reading', 12)], false);
    const view = render(<CompanionGetStarted getStarted={started} settings={newUserSettings()} name="Michi" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Reading Work: 12 of 40 conversations');

    mocks.firstRun = status([home('done', 40)], true);
    view.rerender(<CompanionGetStarted getStarted={started} settings={newUserSettings()} name="Michi" />);
    expect(screen.getByRole('status').textContent).toBe('Workspace homes are ready · Open Pages');
    fireEvent.click(screen.getByRole('button', { name: 'Open Pages' }));
    expect(mocks.nav).toHaveBeenCalledTimes(1);
  });

  it('says why Start failed', async () => {
    mocks.start.mockRejectedValue(new Error('Workspace homes need scheduled jobs, which are off in this Michi'));
    render(<CompanionGetStarted getStarted={OFFER} settings={newUserSettings()} name="Michi" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Couldn’t start: Workspace homes need scheduled jobs, which are off in this Michi'));
  });

  it('names the brief days', () => {
    expect([workdaysLabel([5, 1, 2, 3, 4]), workdaysLabel([0, 1, 2, 3, 4, 5, 6]), workdaysLabel([6, 0]), workdaysLabel([1, 3])])
      .toEqual(['Weekdays', 'Every day', 'Weekends', 'Mon, Wed']);
  });
});
