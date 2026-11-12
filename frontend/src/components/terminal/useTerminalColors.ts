import { useEffect, useMemo } from 'react';
import { usePrefs } from '../../state/prefs';
import { cssVarsFor, resolveAccent, DARK_PALETTES } from './tokens';
import { getElectron } from '../../lib/electronBridge';

/** Build the CSS-variable style object for the current terminal prefs. */
export function useTerminalColors(): Record<string, string> {
  const { prefs } = usePrefs();
  const accent = resolveAccent(prefs.terminalAccentOverrides, prefs.terminalPalette);
  const colors = useMemo(
    () => cssVarsFor(prefs.terminalPalette, accent),
    [prefs.terminalPalette, accent],
  );

  // Keep native chrome, macOS vibrancy, and Browser pane color-scheme media
  // queries in sync with the palette. No-op in web builds and older desktop
  // builds without the bridge method.
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);
  useEffect(() => {
    getElectron()?.setDarkMaterial?.(isDark, colors['--term-bg']);
  }, [colors, isDark]);

  // Window glass on/off. Runs before the material below, so turning glass back
  // on picks up the chosen material. No-op where the bridge lacks the method.
  useEffect(() => {
    getElectron()?.setWindowGlass?.(prefs.windowGlass);
  }, [prefs.windowGlass]);

  // Apply the chosen native sidebar vibrancy material. No-op in the browser and
  // on builds without the bridge method (older Electron / web / Win / Linux).
  useEffect(() => {
    getElectron()?.setVibrancy?.(prefs.sidebarVibrancy);
  }, [prefs.sidebarVibrancy]);

  return colors;
}
