import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundServiceStatus } from 'michi-shared';
import { resetCompanionStoreForTests } from '../../../../state/companion/companionStore';
import { companionSnapshot } from '../../../../test/companionFixtures';
import { BackgroundPane } from './BackgroundPane';
import { KEEP_RUNNING_LABEL } from './residencyCopy';
import { SettingsLayoutContext, SettingsOpenContext } from './settingsPhone';
const api = vi.hoisted(() => ({ save: vi.fn() }));
const lifetime = vi.hoisted(() => ({
  available: false,
  status: null as null | {
    supported: boolean;
    reason?: string;
    keepInBackground: boolean;
    openAtLogin: boolean;
    trayActive: boolean;
    canStartHidden: boolean;
  },
  busy: false,
  error: null as string | null,
  setKeepInBackground: vi.fn(),
  setOpenAtLogin: vi.fn(),
}));
vi.mock('../../../../services/api/scheduledJobs', () => ({
  getScheduledJobSettings: async () => ({ sessionMode: 'persistent', requireCreateApproval: false }),
  updateScheduledJobSettings: (...args: unknown[]) => api.save(...args),
}));

/** A desktop bridge with the background service, answering `status`. */
function desktopService(status: BackgroundServiceStatus) {
  const bridge = {
    chooseFolder: vi.fn(), saveMarkdown: vi.fn(),
    getBackgroundServiceStatus: vi.fn(async () => status),
    setBackgroundServiceEnabled: vi.fn(async () => status),
  };
  (window as unknown as { electron?: unknown }).electron = bridge;
  return bridge;
}
afterEach(() => { delete (window as unknown as { electron?: unknown }).electron; });
describe('scheduled job defaults', () => {
  it('loads and saves the default, retaining the saved value on failure', async () => {
    render(<BackgroundPane />);
    const ongoing = await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect((ongoing as HTMLInputElement).checked).toBe(true);
    api.save.mockResolvedValueOnce({ sessionMode: 'fresh', requireCreateApproval: false });
    fireEvent.click(screen.getByRole('radio', { name: 'New thread each run' }));
    await waitFor(() => expect((screen.getByRole('radio', { name: 'New thread each run' }) as HTMLInputElement).checked).toBe(true));
    expect(api.save).toHaveBeenCalledWith({ sessionMode: 'fresh' });
    api.save.mockRejectedValueOnce(new Error('Save failed'));
    fireEvent.click(ongoing);
    expect((await screen.findByRole('alert')).textContent).toContain('Save failed');
    expect((screen.getByRole('radio', { name: 'New thread each run' }) as HTMLInputElement).checked).toBe(true);
  });

  it('asks before agents create jobs only once turned on', async () => {
    render(<BackgroundPane />);
    const toggle = await screen.findByRole('switch', { name: 'Ask before agents create scheduled jobs' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/saves a new job right away/)).toBeTruthy();
    api.save.mockResolvedValueOnce({ sessionMode: 'persistent', requireCreateApproval: true });
    fireEvent.click(toggle);
    expect(api.save).toHaveBeenLastCalledWith({ requireCreateApproval: true });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText(/saves it only after you approve/)).toBeTruthy();
  });
});

describe('the background service, moved to Settings › Notifications', () => {
  it('on a phone, links to the scheduled jobs and leaves the desktop app’s service out', async () => {
    const onOpenScheduled = vi.fn();
    render(<SettingsLayoutContext.Provider value="phone"><BackgroundPane onOpenScheduled={onOpenScheduled} /></SettingsLayoutContext.Provider>);
    await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect(screen.queryByText(KEEP_RUNNING_LABEL)).toBeNull();
    expect(screen.queryByText(/Your Mac still pauses Michi/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenScheduled).toHaveBeenCalledOnce();
  });

  it('on a desktop, keeps a link row that opens the switch where it is now, and names the agent', async () => {
    desktopService({ supported: true, enabled: false, running: false, port: null });
    const snapshot = companionSnapshot();
    resetCompanionStoreForTests({ snapshot: { ...snapshot, settings: { ...snapshot.settings, displayName: 'Robin' } } });
    const open = vi.fn();
    try {
      render(<SettingsOpenContext.Provider value={open}><BackgroundPane onOpenScheduled={vi.fn()} /></SettingsOpenContext.Provider>);
      await screen.findByRole('radio', { name: 'One ongoing thread' });
      const row = (await screen.findByText(KEEP_RUNNING_LABEL)).closest('.settings-row') as HTMLElement;
      expect(row.textContent).toContain('Robin can still notify you');
      expect(row.textContent).toContain('Settings › Notifications › When Michi’s windows are closed');
      // The service's switch itself is not here any more; the job-creation approval switch is.
      expect(screen.queryByRole('switch', { name: KEEP_RUNNING_LABEL })).toBeNull();
      expect(screen.getByRole('switch', { name: 'Ask before agents create scheduled jobs' })).toBeTruthy();
      fireEvent.click(within(row).getByRole('button', { name: 'Open' }));
      expect(open).toHaveBeenCalledWith('notifications', KEEP_RUNNING_LABEL);
    } finally {
      resetCompanionStoreForTests();
    }
  });

  it('leaves the link out where Settings › Notifications doesn’t show the switch: a browser, or a desktop that isn’t a Mac and has no service', async () => {
    const view = render(<BackgroundPane onOpenScheduled={vi.fn()} />);
    await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect(screen.queryByText(KEEP_RUNNING_LABEL)).toBeNull();
    view.unmount();
    // jsdom is not a Mac: an install that says the service isn't supported has nothing to point at.
    const bridge = desktopService({ supported: false, enabled: false, running: false, port: null, reason: 'macOS only' });
    render(<BackgroundPane onOpenScheduled={vi.fn()} />);
    await screen.findByRole('radio', { name: 'One ongoing thread' });
    await waitFor(() => expect(bridge.getBackgroundServiceStatus).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(KEEP_RUNNING_LABEL)).toBeNull();
  });
});
