import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalColors } from './useTerminalColors';

const H = vi.hoisted(() => ({
  prefs: {
    terminalPalette: 'monokai' as 'monokai' | 'bone',
    terminalAccentOverrides: {},
    windowGlass: true,
  },
  setDarkMaterial: vi.fn(),
  setWindowGlass: vi.fn(),
}));

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: H.prefs }),
}));

vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => ({
    setDarkMaterial: H.setDarkMaterial,
    setWindowGlass: H.setWindowGlass,
  }),
}));

describe('useTerminalColors browser theme sync', () => {
  beforeEach(() => {
    H.prefs.terminalPalette = 'monokai';
    H.prefs.windowGlass = true;
    H.setDarkMaterial.mockReset();
    H.setWindowGlass.mockReset();
  });

  it('updates Electron when Michi switches to a light palette', () => {
    const { rerender } = renderHook(() => useTerminalColors());
    act(() => {
      H.prefs.terminalPalette = 'bone';
      rerender();
    });
    expect(H.setDarkMaterial).toHaveBeenLastCalledWith(false, '#fdfdfc');
  });

  it('applies window glass, and again when it changes', () => {
    const { rerender } = renderHook(() => useTerminalColors());
    expect(H.setWindowGlass).toHaveBeenCalledWith(true);
    act(() => {
      H.prefs.windowGlass = false;
      rerender();
    });
    expect(H.setWindowGlass).toHaveBeenLastCalledWith(false);
    expect(H.setWindowGlass).toHaveBeenCalledTimes(2);
  });
});
