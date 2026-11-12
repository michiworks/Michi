import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundServiceStatus, DesktopResidency, DesktopResidencyPatch } from 'michi-shared';
import { resetCompanionStoreForTests } from '../../../../state/companion/companionStore';
import { companionSnapshot } from '../../../../test/companionFixtures';
import { NotificationsPane } from './NotificationsPane';
import { HIDE_DOCK_LABEL, KEEP_RUNNING_LABEL, OPEN_AT_LOGIN_LABEL, TRAY_LABEL, WINDOWS_CLOSED_TITLE } from './residencyCopy';
import { SettingsLayoutContext, SettingsOpenContext } from './settingsPhone';

const mocks = vi.hoisted(() => ({ setPref: vi.fn(), confirm: vi.fn() }));
vi.mock('../../../../state/prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../state/prefs')>();
  return { ...actual, usePrefs: () => ({ prefs: { ...actual.DEFAULT_PREFS, notifications: 'approval-only' as const }, setPref: mocks.setPref }) };
});
vi.mock('../../../ui/ConfirmDialog', () => ({ confirmDialog: mocks.confirm }));

const setting = (supported: boolean, enabled: boolean) => ({ supported, enabled });

/** A desktop bridge with the residency calls and the background service, as Electron main answers them. */
function desktop(residency: DesktopResidency, service: BackgroundServiceStatus | null) {
  let current = residency;
  let status = service;
  const bridge = {
    chooseFolder: vi.fn(), saveMarkdown: vi.fn(),
    getResidency: vi.fn(async () => current),
    setResidency: vi.fn(async (patch: DesktopResidencyPatch) => {
      current = {
        ...current,
        tray: patch.tray === undefined ? current.tray : { ...current.tray, enabled: patch.tray },
        hideDock: patch.hideDock === undefined ? current.hideDock : { ...current.hideDock, enabled: patch.hideDock },
        openAtLogin: patch.openAtLogin === undefined ? current.openAtLogin : { ...current.openAtLogin, enabled: patch.openAtLogin },
      };
      return current;
    }),
    ...(status ? {
      getBackgroundServiceStatus: vi.fn(async () => status!),
      setBackgroundServiceEnabled: vi.fn(async (enabled: boolean) => { status = { ...status!, enabled, running: enabled }; return status; }),
    } : {}),
  };
  (window as unknown as { electron?: unknown }).electron = bridge;
  return bridge;
}

const MAC: DesktopResidency = { tray: setting(true, true), hideDock: setting(true, false), openAtLogin: setting(false, false) };
const SERVICE: BackgroundServiceStatus = { supported: true, enabled: false, running: false, port: null };
const section = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  mocks.setPref.mockReset();
  mocks.confirm.mockReset();
  const snapshot = companionSnapshot();
  resetCompanionStoreForTests({ snapshot: { ...snapshot, settings: { ...snapshot.settings, displayName: 'Robin' } } });
});
afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  resetCompanionStoreForTests();
});

describe('Settings › Notifications', () => {
  it('sets the chat level for every conversation, the agent’s included, and links to the agent’s own notifications', () => {
    const open = vi.fn();
    render(<SettingsOpenContext.Provider value={open}><NotificationsPane /></SettingsOpenContext.Provider>);
    const chat = section('Notifications');
    expect(chat.textContent).toContain('your conversation with Robin included, whether Michi’s windows are open or closed');
    expect(chat.textContent).toContain('Quiet hours don’t apply');
    expect((within(chat).getByRole('radio', { name: /Approval only/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(chat).getByRole('radio', { name: /^All/ }));
    expect(mocks.setPref).toHaveBeenCalledWith('notifications', 'all');
    fireEvent.click(within(chat).getByRole('button', { name: 'Settings › Robin › Notifications' }));
    expect(open).toHaveBeenCalledWith('companion', 'Notifications');
  });

  it('says the section is the desktop app’s outside it, and leaves it out on a phone', () => {
    const view = render(<NotificationsPane />);
    expect(within(section(WINDOWS_CLOSED_TITLE)).getByText('Available in the Michi desktop app.')).toBeTruthy();
    view.unmount();
    render(<SettingsLayoutContext.Provider value="phone"><NotificationsPane /></SettingsLayoutContext.Provider>);
    expect(screen.queryByRole('region', { name: WINDOWS_CLOSED_TITLE })).toBeNull();
  });

  it('keeps Michi in the menu bar, hides the Dock only while it does, and keeps the backend running after Quit once confirmed', async () => {
    const bridge = desktop(MAC, SERVICE);
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<NotificationsPane />);
    const closed = section(WINDOWS_CLOSED_TITLE);
    const tray = await within(closed).findByRole('switch', { name: TRAY_LABEL });
    expect(tray.getAttribute('aria-checked')).toBe('true');
    const dock = within(closed).getByRole('switch', { name: HIDE_DOCK_LABEL });
    expect(dock.getAttribute('aria-checked')).toBe('false');
    expect(dock).toHaveProperty('disabled', false);
    // Open at login is a Windows setting.
    expect(within(closed).queryByText(OPEN_AT_LOGIN_LABEL)).toBeNull();

    fireEvent.click(tray);
    await waitFor(() => expect(bridge.setResidency).toHaveBeenCalledWith({ tray: false }));
    await waitFor(() => expect(within(closed).getByRole('switch', { name: HIDE_DOCK_LABEL })).toHaveProperty('disabled', true));
    expect(closed.textContent).toContain(`Needs “${TRAY_LABEL}”.`);

    const keep = within(closed).getByRole('switch', { name: KEEP_RUNNING_LABEL });
    expect(keep.closest('.settings-row')!.textContent).toContain('Scheduled jobs and Robin’s check-ins run only while Michi is open.');
    fireEvent.click(keep);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(bridge.setBackgroundServiceEnabled).not.toHaveBeenCalled();
    fireEvent.click(keep);
    await waitFor(() => expect(bridge.setBackgroundServiceEnabled).toHaveBeenCalledWith(true));
    expect(mocks.confirm.mock.calls[1]![0].message).toContain('Robin can still notify you');
    await waitFor(() => expect(within(closed).getByRole('switch', { name: KEEP_RUNNING_LABEL }).getAttribute('aria-checked')).toBe('true'));
    expect(closed.textContent).toContain('Your Mac still pauses Michi while it sleeps.');
  });

  it('offers Open at login where the install can, says why the icon can’t stay, and shows a failed change', async () => {
    const bridge = desktop({
      tray: setting(false, false), hideDock: setting(false, false), openAtLogin: setting(true, false), reason: 'Not available in a development build.',
    }, { supported: false, enabled: false, running: false, port: null, reason: 'macOS only' });
    bridge.setResidency.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:setResidency': Error: Login items are managed by policy"));
    render(<NotificationsPane />);
    const closed = section(WINDOWS_CLOSED_TITLE);
    const login = await within(closed).findByRole('switch', { name: OPEN_AT_LOGIN_LABEL });
    expect(closed.textContent).toContain('Not available in a development build.');
    expect(within(closed).queryByRole('switch', { name: TRAY_LABEL })).toBeNull();
    expect(within(closed).queryByText(HIDE_DOCK_LABEL)).toBeNull();
    // The background service is the Mac's; a Windows install has nothing to offer there.
    expect(within(closed).queryByText(KEEP_RUNNING_LABEL)).toBeNull();
    await act(async () => { fireEvent.click(login); });
    expect(bridge.setResidency).toHaveBeenCalledWith({ openAtLogin: true });
    expect((await within(closed).findByRole('alert')).textContent).toBe('Login items are managed by policy');
  });
});
