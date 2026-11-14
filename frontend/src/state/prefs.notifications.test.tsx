import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn(async () => true) }));
vi.mock('../services/api', () => api);
vi.mock('../services/attention/policy', () => ({ setAttentionPreferences: vi.fn() }));

import { setAttentionPreferences } from '../services/attention/policy';
import { NotificationsPane } from '../components/terminal/pages/settings/NotificationsPane';
import { PREFS_KEY, PrefsProvider } from './prefs';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  api.fetchPrefs.mockResolvedValue(null);
});

describe('notification preferences', () => {
  it('keep the attention policy in step with the level and the sounds toggle', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ notifications: 'approval-only', notificationSounds: 'loud' }));
    await act(async () => { render(<PrefsProvider><NotificationsPane /></PrefsProvider>); });
    // A malformed stored value falls back to the default: on.
    expect(setAttentionPreferences).toHaveBeenLastCalledWith({ level: 'approval-only', sounds: true });

    const sounds = screen.getByRole('switch', { name: 'Notification sounds' }) as HTMLButtonElement;
    fireEvent.click(sounds);
    expect(setAttentionPreferences).toHaveBeenLastCalledWith({ level: 'approval-only', sounds: false });

    fireEvent.change(screen.getByRole('combobox', { name: 'Notify me' }), { target: { value: 'off' } });
    expect(setAttentionPreferences).toHaveBeenLastCalledWith({ level: 'off', sounds: false });
    // Nothing to sound with notifications off.
    expect(sounds.disabled).toBe(true);
  });
});
