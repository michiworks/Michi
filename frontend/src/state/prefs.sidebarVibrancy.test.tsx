import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIBRANCY_MATERIALS } from 'michi-shared';
import { PREFS_KEY, PrefsProvider, usePrefs } from './prefs';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn() }));
vi.mock('../services/api', () => api);

function Probe() {
  return <output data-testid="vibrancy">{usePrefs().prefs.sidebarVibrancy}</output>;
}

function storedVibrancy(value: unknown): string {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ sidebarVibrancy: value }));
  render(<PrefsProvider><Probe /></PrefsProvider>);
  const shown = screen.getByTestId('vibrancy').textContent ?? '';
  cleanup();
  return shown;
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  api.fetchPrefs.mockResolvedValue(null); api.savePrefs.mockResolvedValue(true);
});
afterEach(() => { cleanup(); });

describe('sidebar vibrancy preference', () => {
  it('keeps every material the desktop app accepts and drops any other value', () => {
    for (const material of VIBRANCY_MATERIALS) expect(storedVibrancy(material)).toBe(material);
    expect(storedVibrancy('glass')).toBe('under-window');
    expect(storedVibrancy(3)).toBe('under-window');
  });
});
