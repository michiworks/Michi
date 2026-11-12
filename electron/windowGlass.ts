import * as fs from 'fs';

/**
 * Window glass: the native macOS vibrancy behind Michi's see-through sidebar,
 * on unless the user turns it off in Settings → Appearance.
 *
 * Under vibrancy macOS sometimes shows a frame without the layers drawn over
 * the page: drawers, ⌘K, Settings and their scrim vanish for one frame while
 * agents run. Measured on a 360 Hz display with the Background work drawer
 * open (Electron 41, OpenGL backend, 54 fps capture): about 2 such frames per
 * second with vibrancy, none seen with an opaque window.
 *
 * Main keeps its own copy of the choice so the next launch opens the window in
 * that mode before the renderer's prefs load.
 */
export function readWindowGlass(file: string): boolean {
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object' && (saved as { enabled?: unknown }).enabled === false) return false;
  } catch {
    /* Missing or unreadable: glass stays on. */
  }
  return true;
}

export function writeWindowGlass(file: string, enabled: boolean): void {
  fs.writeFileSync(file, `${JSON.stringify({ enabled })}\n`);
}
