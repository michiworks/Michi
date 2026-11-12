import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, PREFS_KEY, PrefsProvider, usePrefs, type Prefs } from './prefs';
import { BrowserSettingsPane } from '../components/terminal/pages/settings/BrowserSettingsPane';
import { useTerminalColors } from '../components/terminal/useTerminalColors';
const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn() }));
vi.mock('../services/api', () => api);
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); api.fetchPrefs.mockResolvedValue(null); api.savePrefs.mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('Browser preference', () => {
  it('hydrates remote preferences', async () => {
    api.fetchPrefs.mockResolvedValue({ linkOpenTarget: 'external' });
    await act(async () => { render(<PrefsProvider><BrowserSettingsPane /></PrefsProvider>); });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('external');
  });
  it('saves a Settings change locally and to the backend', async () => {
    vi.useFakeTimers();
    render(<PrefsProvider><BrowserSettingsPane /></PrefsProvider>);
    // Nothing is saved before GET /prefs answers (here: it fails).
    await act(async () => {});
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'external' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(JSON.parse(localStorage.getItem('michi:v1:prefs')!).linkOpenTarget).toBe('external');
    expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ linkOpenTarget: 'external' }));
  });
});

/** Uses the palette and accent the way the terminal shell does. */
function Shell({ onPrefs }: { onPrefs: (prefs: Prefs) => void }) {
  const { prefs } = usePrefs();
  useTerminalColors();
  onPrefs(prefs);
  return null;
}

describe('stored preferences from either copy', () => {
  // GET /prefs always carries the backend's permission settings.
  const PERMISSIONS = { globalPermissions: false, permissionMode: 'ask', permissionApproveForMe: false, bypassPermissions: false };
  // Hand edits, a downgrade, or another branch sharing the config: values this build does not offer.
  it.each([
    { terminalPalette: 'nord' },
    { terminalAccentOverrides: null },
    { uiFont: 'IBM Plex Mono' },
    { messageFont: 'Inter' },
    { sidebarDensity: 'cozy' },
    { terminalDensity: 'roomy' },
    { notifications: 'loud' },
    { messageFontSize: 40 },
    { codeBlockStyle: 'x' },
  ])('read %j as the default, whether this browser or the backend holds it', async (stored) => {
    let seen: Prefs | undefined;
    const mount = async () => {
      await act(async () => { render(<PrefsProvider><Shell onPrefs={(prefs) => { seen = prefs; }} /></PrefsProvider>); });
      return seen;
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...stored, ...PERMISSIONS }));
    api.fetchPrefs.mockResolvedValue(PERMISSIONS);
    const local = await mount();
    cleanup();
    localStorage.clear();
    api.fetchPrefs.mockResolvedValue({ ...stored, ...PERMISSIONS });
    const remote = await mount();
    expect(local).toEqual(DEFAULT_PREFS);
    expect(remote).toEqual(DEFAULT_PREFS);
  });
});
